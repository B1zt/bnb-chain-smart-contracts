// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMasterChef} from "./interfaces/IMasterChef.sol";
import {IPancakePair, IPancakeRouter} from "./interfaces/IPancakeRouter.sol";

/// @title AutoCompoundVault
/// @notice ERC-4626 vault that farms an LP position and reinvests its rewards automatically.
///
/// @dev The loop: users deposit LP, the vault stakes it in the MasterChef, and anyone can call
///      `compound` to harvest rewards, swap them into the pair's two tokens, add liquidity, and
///      stake the new LP. Every share is then worth more, so no per-user reward accounting exists.
///
///      **The part that gets exploited in real deployments is the swap.** Harvest is a public
///      function moving a known amount through a public AMM, which is a sandwich attack served on a
///      plate. Three defences, all necessary:
///
///      1. **Slippage is bounded against a quote taken in the same transaction**
///         (`getAmountsOut`), not against a stored price. A stored price is itself manipulable.
///      2. **`maxSlippageBps` is owner-set but hard-capped**, so admin error cannot widen it to the
///         point of being meaningless.
///      3. **A caller bounty is paid from the harvest**, so compounding happens often. Rewards that
///         sit unharvested for days are a larger loss than any realistic sandwich.
///
///      The vault also inherits the ERC-4626 inflation-attack defence: OpenZeppelin's virtual
///      shares plus a raised `_decimalsOffset`.
contract AutoCompoundVault is ERC4626, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error ZeroAmount();
    error SlippageTooHigh(uint16 bps);
    error FeeTooHigh(uint16 bps);
    error NothingToCompound();
    error InsufficientOutput(uint256 received, uint256 minimum);
    error PairMismatch();
    error DeadlinePassed();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Compounded(
        address indexed caller,
        uint256 rewardHarvested,
        uint256 lpAdded,
        uint256 callerBounty,
        uint256 performanceFee
    );
    event SlippageUpdated(uint16 bps);
    event FeesUpdated(uint16 performanceFeeBps, uint16 callerBountyBps, address recipient);
    event EmergencyUnstaked(uint256 amount);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard ceiling on slippage tolerance. Three percent, and the owner cannot exceed it.
    uint16 public constant MAX_SLIPPAGE_BPS = 300;

    /// @notice Hard ceiling on the performance fee.
    uint16 public constant MAX_PERFORMANCE_FEE_BPS = 2_000;

    /// @notice Hard ceiling on the caller bounty.
    uint16 public constant MAX_CALLER_BOUNTY_BPS = 100;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    IMasterChef public immutable masterChef;
    IPancakeRouter public immutable router;
    IERC20 public immutable rewardToken;

    /// @notice Pool id this vault farms in the MasterChef.
    uint256 public immutable pid;

    /// @notice The two sides of the LP pair being farmed.
    address public immutable token0;
    address public immutable token1;

    /// @notice Slippage tolerance for compound swaps, in basis points.
    uint16 public maxSlippageBps = 100;

    /// @notice Cut of each harvest taken as a protocol fee.
    uint16 public performanceFeeBps = 500;

    /// @notice Cut of each harvest paid to whoever calls `compound`.
    uint16 public callerBountyBps = 25;

    address public feeRecipient;

    /// @notice Timestamp of the last successful compound.
    uint256 public lastCompoundAt;

    /// @notice Total LP ever added by compounding, for reporting realised yield.
    uint256 public totalCompounded;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        IERC20 lpToken,
        IMasterChef masterChef_,
        uint256 pid_,
        IPancakeRouter router_,
        IERC20 rewardToken_,
        address feeRecipient_,
        address owner_
    ) ERC4626(lpToken) ERC20("Auto-Compounding LP", "acLP") Ownable(owner_) {
        if (
            address(masterChef_) == address(0) || address(router_) == address(0)
                || address(rewardToken_) == address(0) || feeRecipient_ == address(0)
        ) {
            revert ZeroAddress();
        }

        masterChef = masterChef_;
        pid = pid_;
        router = router_;
        rewardToken = rewardToken_;
        feeRecipient = feeRecipient_;
        lastCompoundAt = block.timestamp;

        // Read the pair's sides once at deployment. Reading them per compound would be an extra
        // external call on the hot path, and they can never change.
        IPancakePair pair = IPancakePair(address(lpToken));
        token0 = pair.token0();
        token1 = pair.token1();

        // The vault only ever moves LP into the chef and reward out of it, so infinite approvals
        // here are bounded by the contracts themselves rather than by an allowance.
        IERC20(address(lpToken)).forceApprove(address(masterChef_), type(uint256).max);
        rewardToken_.forceApprove(address(router_), type(uint256).max);
        IERC20(token0).forceApprove(address(router_), type(uint256).max);
        IERC20(token1).forceApprove(address(router_), type(uint256).max);

        emit FeesUpdated(performanceFeeBps, callerBountyBps, feeRecipient_);
    }

    /*//////////////////////////////////////////////////////////////
                            ERC-4626 CORE
    //////////////////////////////////////////////////////////////*/

    /// @notice LP under management: idle here plus staked in the MasterChef.
    /// @dev Both terms are needed. Almost all of it is staked at any moment, but a compound leaves
    ///      dust behind and a deposit is briefly idle before being staked.
    function totalAssets() public view override returns (uint256) {
        (uint256 staked,,) = masterChef.userInfo(pid, address(this));
        return staked + IERC20(asset()).balanceOf(address(this));
    }

    /// @dev Raises the cost of the ERC-4626 first-depositor inflation attack far above any profit.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
    {
        super._deposit(caller, receiver, assets, shares);

        // Stake immediately. Idle LP earns nothing.
        masterChef.deposit(pid, assets);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 idle = IERC20(asset()).balanceOf(address(this));

        // Unstake only the shortfall, so a withdrawal covered by idle LP costs no chef interaction.
        if (assets > idle) {
            masterChef.withdraw(pid, assets - idle);
        }

        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    /// @dev Deposits are pausable; withdrawals deliberately are not. A pause must never trap funds.
    function _checkDepositAllowed() private view {
        _requireNotPaused();
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        _checkDepositAllowed();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        _checkDepositAllowed();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner_);
    }

    /*//////////////////////////////////////////////////////////////
                              COMPOUNDING
    //////////////////////////////////////////////////////////////*/

    /// @notice Harvest rewards, convert them to LP, and stake the result.
    ///
    /// @dev Permissionless and bounty-paying on purpose. A vault that only the owner can compound
    ///      stops compounding the moment the owner's keeper breaks, and unharvested rewards are a
    ///      far larger and more certain loss than sandwich risk on any single compound.
    ///
    /// @param deadline Unix timestamp after which the call reverts, so a transaction stuck in the
    ///        mempool cannot execute later at a price nobody agreed to.
    /// @return lpAdded LP tokens added to the position.
    function compound(uint256 deadline) external nonReentrant whenNotPaused returns (uint256 lpAdded) {
        if (block.timestamp > deadline) revert DeadlinePassed();

        // Harvesting is a zero-amount deposit, which is how MasterChef exposes it.
        masterChef.deposit(pid, 0);

        uint256 harvested = rewardToken.balanceOf(address(this));
        if (harvested == 0) revert NothingToCompound();

        // Fees come off the top, so the amounts swapped are what actually gets reinvested.
        uint256 bounty = (harvested * callerBountyBps) / BPS_DENOMINATOR;
        uint256 performanceFee = (harvested * performanceFeeBps) / BPS_DENOMINATOR;
        uint256 toReinvest = harvested - bounty - performanceFee;

        if (bounty > 0) rewardToken.safeTransfer(msg.sender, bounty);
        if (performanceFee > 0) rewardToken.safeTransfer(feeRecipient, performanceFee);

        if (toReinvest == 0) revert NothingToCompound();

        // Half into each side of the pair. Splitting evenly leaves some dust because the swap moves
        // the price, and that dust simply stays in the vault for the next compound.
        uint256 half = toReinvest / 2;
        uint256 otherHalf = toReinvest - half;

        uint256 amount0 = _swapReward(token0, half, deadline);
        uint256 amount1 = _swapReward(token1, otherHalf, deadline);

        lpAdded = _addLiquidity(amount0, amount1, deadline);

        if (lpAdded > 0) {
            masterChef.deposit(pid, lpAdded);
            totalCompounded += lpAdded;
        }

        lastCompoundAt = block.timestamp;

        emit Compounded(msg.sender, harvested, lpAdded, bounty, performanceFee);
    }

    /// @dev Swaps reward into `target`, bounded by a quote taken in this same transaction.
    ///
    ///      Quoting against `getAmountsOut` rather than a stored price matters: a stored price is
    ///      itself manipulable, and a stale one produces a minimum so loose it protects nothing.
    ///      This bounds the loss to `maxSlippageBps` of what the pool would pay right now.
    function _swapReward(address target, uint256 amountIn, uint256 deadline)
        private
        returns (uint256 amountOut)
    {
        if (amountIn == 0) return 0;

        // Reward token is already one side of the pair: no swap needed.
        if (target == address(rewardToken)) return amountIn;

        address[] memory path = new address[](2);
        path[0] = address(rewardToken);
        path[1] = target;

        uint256[] memory quote = router.getAmountsOut(amountIn, path);
        uint256 expected = quote[quote.length - 1];
        uint256 minimumOut = (expected * (BPS_DENOMINATOR - maxSlippageBps)) / BPS_DENOMINATOR;

        uint256 balanceBefore = IERC20(target).balanceOf(address(this));

        // The fee-on-transfer variant is used because BNB Chain is full of tax tokens, and the
        // plain `swapExactTokensForTokens` reverts against them rather than degrading.
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn, minimumOut, path, address(this), deadline
        );

        amountOut = IERC20(target).balanceOf(address(this)) - balanceBefore;

        // The router's own check can be bypassed by a fee-on-transfer token that takes its cut
        // after the router measures, so the received amount is re-checked here.
        if (amountOut < minimumOut) revert InsufficientOutput(amountOut, minimumOut);
    }

    function _addLiquidity(uint256 amount0, uint256 amount1, uint256 deadline)
        private
        returns (uint256 liquidity)
    {
        if (amount0 == 0 || amount1 == 0) return 0;

        uint256 min0 = (amount0 * (BPS_DENOMINATOR - maxSlippageBps)) / BPS_DENOMINATOR;
        uint256 min1 = (amount1 * (BPS_DENOMINATOR - maxSlippageBps)) / BPS_DENOMINATOR;

        (,, liquidity) =
            router.addLiquidity(token0, token1, amount0, amount1, min0, min1, address(this), deadline);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function setMaxSlippage(uint16 bps) external onlyOwner {
        if (bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(bps);

        maxSlippageBps = bps;
        emit SlippageUpdated(bps);
    }

    function setFees(uint16 performanceFeeBps_, uint16 callerBountyBps_, address recipient)
        external
        onlyOwner
    {
        if (performanceFeeBps_ > MAX_PERFORMANCE_FEE_BPS) revert FeeTooHigh(performanceFeeBps_);
        if (callerBountyBps_ > MAX_CALLER_BOUNTY_BPS) revert FeeTooHigh(callerBountyBps_);
        if (recipient == address(0)) revert ZeroAddress();

        performanceFeeBps = performanceFeeBps_;
        callerBountyBps = callerBountyBps_;
        feeRecipient = recipient;

        emit FeesUpdated(performanceFeeBps_, callerBountyBps_, recipient);
    }

    /// @notice Halt deposits and compounding. Withdrawals stay open by design.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Pull the whole position out of the MasterChef, forfeiting pending rewards.
    ///
    /// @dev The escape hatch for when the farm itself is compromised. It calls
    ///      `emergencyWithdraw`, which touches no reward accounting, so it still works when the
    ///      normal path does not. Assets land in this vault and remain fully withdrawable by
    ///      shareholders, because `totalAssets` counts idle LP as well as staked.
    function emergencyUnstake() external onlyOwner {
        (uint256 staked,,) = masterChef.userInfo(pid, address(this));
        if (staked == 0) revert ZeroAmount();

        masterChef.emergencyWithdraw(pid);
        _pause();

        emit EmergencyUnstaked(staked);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Assets one full share is currently worth.
    function pricePerShare() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    /// @notice Rewards waiting to be compounded.
    function pendingRewards() external view returns (uint256) {
        return masterChef.pendingReward(pid, address(this)) + rewardToken.balanceOf(address(this));
    }

    /// @notice Reward a caller would earn for compounding right now.
    /// @dev Lets a keeper decide whether the bounty covers gas before sending a transaction.
    function callerBounty() external view returns (uint256) {
        uint256 pending =
            masterChef.pendingReward(pid, address(this)) + rewardToken.balanceOf(address(this));
        return (pending * callerBountyBps) / BPS_DENOMINATOR;
    }

    /// @notice Seconds since the last successful compound.
    function timeSinceCompound() external view returns (uint256) {
        return block.timestamp - lastCompoundAt;
    }
}
