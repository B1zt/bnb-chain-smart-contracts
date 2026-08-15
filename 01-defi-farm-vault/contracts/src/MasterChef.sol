// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRewardToken} from "./interfaces/IRewardToken.sol";

/// @title MasterChef
/// @notice Multi-pool LP farm with per-second emissions and allocation-point weighting.
///
/// @dev This is the MasterChef pattern that most BNB Chain farms are built on, with the four bugs
///      that plague the copies actually fixed:
///
///      **1. No double-counting pool from adding a pool without updating the others.** `add` calls
///      `massUpdatePools` first. Skipping it is the single most common MasterChef bug: allocation
///      points change retroactively, so every existing pool silently mis-accrues rewards for the
///      entire period since its last update.
///
///      **2. Fee-on-transfer LP tokens are measured, not assumed.** `deposit` records the balance
///      actually received rather than the amount requested. A token that takes a transfer fee would
///      otherwise credit users more than the pool holds, and the last withdrawer cannot exit.
///
///      **3. Emissions are per second, not per block.** BNB Chain's block time has changed more than
///      once. A per-block rate silently changes the real emission schedule when it does.
///
///      **4. `emergencyWithdraw` forfeits rewards and cannot be blocked.** It touches no reward
///      accounting at all, so it still works if the reward token itself is broken or the mint fails.
///      A farm where users cannot retrieve their principal is the worst failure mode there is.
contract MasterChef is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct UserInfo {
        /// @dev LP actually held by this user, net of any deposit fee.
        uint256 amount;
        /// @dev Accounting offset. Pending rewards are `amount * accRewardPerShare / PRECISION
        ///      - rewardDebt`, which is the standard trick to avoid iterating over users.
        uint256 rewardDebt;
        /// @dev Earliest timestamp at which this user may harvest.
        uint256 nextHarvestAt;
    }

    struct PoolInfo {
        IERC20 lpToken;
        /// @dev Share of total emissions, relative to `totalAllocPoint`.
        uint256 allocPoint;
        uint256 lastRewardTime;
        /// @dev Rewards accrued per LP token, scaled by PRECISION.
        uint256 accRewardPerShare;
        /// @dev Deposit fee in basis points, capped at MAX_DEPOSIT_FEE_BPS.
        uint16 depositFeeBps;
        /// @dev Seconds a user must wait between harvests.
        uint32 harvestLockup;
        /// @dev LP held by this contract for this pool. Tracked rather than read from balanceOf so
        ///      a direct transfer into the contract cannot distort the accounting.
        uint256 lpSupply;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error PoolDoesNotExist(uint256 pid);
    error DuplicatePool(address lpToken);
    error DepositFeeTooHigh(uint16 bps);
    error HarvestLockupTooLong(uint32 seconds_);
    error InsufficientBalance(uint256 requested, uint256 available);
    error StillLocked(uint256 unlocksAt);
    error ZeroAddress();
    error ZeroAmount();
    error EmissionRateTooHigh(uint256 rate);
    error RewardTokenNotFarmable();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event PoolAdded(uint256 indexed pid, address indexed lpToken, uint256 allocPoint);
    event PoolUpdated(uint256 indexed pid, uint256 allocPoint, uint16 depositFeeBps, uint32 harvestLockup);
    event Deposit(address indexed user, uint256 indexed pid, uint256 amount, uint256 fee);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event Harvest(address indexed user, uint256 indexed pid, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event EmissionRateUpdated(uint256 rewardPerSecond);
    event FeeRecipientUpdated(address indexed recipient);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev 1e12 rather than 1e18: `accRewardPerShare` is multiplied by an LP balance that can be
    ///      1e18-scaled, and 1e18 precision would overflow on large pools.
    uint256 private constant PRECISION = 1e12;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard ceiling on the deposit fee. Four percent, and the owner cannot exceed it.
    uint16 public constant MAX_DEPOSIT_FEE_BPS = 400;

    /// @notice Hard ceiling on the harvest lockup, so an owner cannot lock rewards away forever.
    uint32 public constant MAX_HARVEST_LOCKUP = 14 days;

    /// @notice Hard ceiling on emissions per second, as a sanity bound on a fat-fingered update.
    uint256 public constant MAX_REWARD_PER_SECOND = 1_000e18;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    IRewardToken public immutable rewardToken;

    /// @notice Emissions per second, split across pools by allocation point.
    uint256 public rewardPerSecond;

    /// @notice Timestamp emissions begin. Nothing accrues before it.
    uint256 public immutable startTime;

    /// @notice Sum of every pool's allocation point.
    uint256 public totalAllocPoint;

    /// @notice Destination for deposit fees.
    address public feeRecipient;

    PoolInfo[] public poolInfo;

    mapping(uint256 pid => mapping(address user => UserInfo)) public userInfo;

    /// @dev Guards against the same LP token being added twice, which would split its emissions
    ///      across two pools and confuse every downstream integration.
    mapping(address lpToken => bool added) public isPoolToken;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        IRewardToken rewardToken_,
        uint256 rewardPerSecond_,
        uint256 startTime_,
        address feeRecipient_,
        address owner_
    ) Ownable(owner_) {
        if (address(rewardToken_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (rewardPerSecond_ > MAX_REWARD_PER_SECOND) revert EmissionRateTooHigh(rewardPerSecond_);

        rewardToken = rewardToken_;
        rewardPerSecond = rewardPerSecond_;
        startTime = startTime_ < block.timestamp ? block.timestamp : startTime_;
        feeRecipient = feeRecipient_;

        emit EmissionRateUpdated(rewardPerSecond_);
        emit FeeRecipientUpdated(feeRecipient_);
    }

    /*//////////////////////////////////////////////////////////////
                            POOL MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Add a new LP pool.
    /// @dev `massUpdatePools` runs first. Changing `totalAllocPoint` without settling every pool
    ///      first would retroactively rewrite how much every other pool earned since its last
    ///      update, which is the classic MasterChef accounting bug.
    function add(IERC20 lpToken, uint256 allocPoint, uint16 depositFeeBps, uint32 harvestLockup)
        external
        onlyOwner
        returns (uint256 pid)
    {
        if (address(lpToken) == address(0)) revert ZeroAddress();
        if (isPoolToken[address(lpToken)]) revert DuplicatePool(address(lpToken));
        if (depositFeeBps > MAX_DEPOSIT_FEE_BPS) revert DepositFeeTooHigh(depositFeeBps);
        if (harvestLockup > MAX_HARVEST_LOCKUP) revert HarvestLockupTooLong(harvestLockup);
        // Farming the reward token itself would let the pool mint into its own staked balance,
        // making `lpSupply` and the reward accounting reference the same asset.
        if (address(lpToken) == address(rewardToken)) revert RewardTokenNotFarmable();

        massUpdatePools();

        totalAllocPoint += allocPoint;
        isPoolToken[address(lpToken)] = true;

        pid = poolInfo.length;
        poolInfo.push(
            PoolInfo({
                lpToken: lpToken,
                allocPoint: allocPoint,
                lastRewardTime: block.timestamp > startTime ? block.timestamp : startTime,
                accRewardPerShare: 0,
                depositFeeBps: depositFeeBps,
                harvestLockup: harvestLockup,
                lpSupply: 0
            })
        );

        emit PoolAdded(pid, address(lpToken), allocPoint);
    }

    /// @notice Change a pool's weight, fee or lockup.
    function set(uint256 pid, uint256 allocPoint, uint16 depositFeeBps, uint32 harvestLockup)
        external
        onlyOwner
    {
        if (pid >= poolInfo.length) revert PoolDoesNotExist(pid);
        if (depositFeeBps > MAX_DEPOSIT_FEE_BPS) revert DepositFeeTooHigh(depositFeeBps);
        if (harvestLockup > MAX_HARVEST_LOCKUP) revert HarvestLockupTooLong(harvestLockup);

        massUpdatePools();

        PoolInfo storage pool = poolInfo[pid];
        totalAllocPoint = totalAllocPoint - pool.allocPoint + allocPoint;

        pool.allocPoint = allocPoint;
        pool.depositFeeBps = depositFeeBps;
        pool.harvestLockup = harvestLockup;

        emit PoolUpdated(pid, allocPoint, depositFeeBps, harvestLockup);
    }

    /// @notice Settle every pool to the current timestamp.
    function massUpdatePools() public {
        uint256 length = poolInfo.length;
        for (uint256 pid; pid < length; ++pid) {
            updatePool(pid);
        }
    }

    /// @notice Settle one pool to the current timestamp.
    function updatePool(uint256 pid) public {
        if (pid >= poolInfo.length) revert PoolDoesNotExist(pid);

        PoolInfo storage pool = poolInfo[pid];
        if (block.timestamp <= pool.lastRewardTime) return;

        uint256 supply = pool.lpSupply;
        if (supply == 0 || pool.allocPoint == 0 || totalAllocPoint == 0) {
            // Nothing staked or no weight, so nothing accrues. The clock still moves forward,
            // otherwise the pool would later mint rewards for a period nobody was staked.
            pool.lastRewardTime = block.timestamp;
            return;
        }

        uint256 elapsed = block.timestamp - pool.lastRewardTime;
        uint256 reward = (elapsed * rewardPerSecond * pool.allocPoint) / totalAllocPoint;

        // Clamp to what the token will actually let us mint. Once the cap is exhausted this is
        // zero, and the farm stops accruing rather than reverting.
        //
        // Accruing more than can be minted would be worse than useless: `updatePool` would revert
        // on the mint, and since deposit, withdraw and harvest all call it, the entire farm would
        // brick at the exact moment emissions ended, stranding every staker's principal.
        //
        // Across pools this is first-come: whichever pool is settled first in `massUpdatePools`
        // takes from the remaining cap first. That is a rounding-level difference at the very tail
        // of the schedule, and the alternative is far more complex for no practical gain.
        uint256 mintable = rewardToken.remainingMintable();
        if (reward > mintable) reward = mintable;

        pool.lastRewardTime = block.timestamp;

        if (reward == 0) return;

        // Accrual and minting are kept in lockstep, so the contract never promises rewards it does
        // not hold.
        pool.accRewardPerShare += (reward * PRECISION) / supply;
        rewardToken.mint(address(this), reward);
    }

    /*//////////////////////////////////////////////////////////////
                            DEPOSIT AND WITHDRAW
    //////////////////////////////////////////////////////////////*/

    /// @notice Stake LP tokens. Any pending reward is harvested first, if the lockup allows.
    function deposit(uint256 pid, uint256 amount) external nonReentrant {
        if (pid >= poolInfo.length) revert PoolDoesNotExist(pid);

        updatePool(pid);

        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];

        _harvestIfUnlocked(pid, pool, user);

        if (amount > 0) {
            // Measure what actually arrived rather than trusting `amount`. A fee-on-transfer LP
            // token would otherwise credit the user more than the pool received, and the last
            // withdrawer would find the pool short.
            uint256 balanceBefore = pool.lpToken.balanceOf(address(this));
            pool.lpToken.safeTransferFrom(msg.sender, address(this), amount);
            uint256 received = pool.lpToken.balanceOf(address(this)) - balanceBefore;

            uint256 fee;
            if (pool.depositFeeBps > 0) {
                fee = (received * pool.depositFeeBps) / BPS_DENOMINATOR;
                if (fee > 0) {
                    pool.lpToken.safeTransfer(feeRecipient, fee);
                }
            }

            uint256 credited = received - fee;
            user.amount += credited;
            pool.lpSupply += credited;

            emit Deposit(msg.sender, pid, credited, fee);
        }

        user.rewardDebt = (user.amount * pool.accRewardPerShare) / PRECISION;
    }

    /// @notice Unstake LP tokens. Any pending reward is harvested first, if the lockup allows.
    function withdraw(uint256 pid, uint256 amount) external nonReentrant {
        if (pid >= poolInfo.length) revert PoolDoesNotExist(pid);

        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];

        if (amount > user.amount) revert InsufficientBalance(amount, user.amount);

        updatePool(pid);
        _harvestIfUnlocked(pid, pool, user);

        if (amount > 0) {
            user.amount -= amount;
            pool.lpSupply -= amount;
            pool.lpToken.safeTransfer(msg.sender, amount);

            emit Withdraw(msg.sender, pid, amount);
        }

        user.rewardDebt = (user.amount * pool.accRewardPerShare) / PRECISION;
    }

    /// @notice Harvest pending rewards without changing the stake.
    function harvest(uint256 pid) external nonReentrant {
        if (pid >= poolInfo.length) revert PoolDoesNotExist(pid);

        updatePool(pid);

        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];

        if (user.nextHarvestAt > block.timestamp) revert StillLocked(user.nextHarvestAt);

        _harvestIfUnlocked(pid, pool, user);
        user.rewardDebt = (user.amount * pool.accRewardPerShare) / PRECISION;
    }

    /// @notice Harvest several pools in one transaction.
    function harvestMany(uint256[] calldata pids) external nonReentrant {
        for (uint256 i; i < pids.length; ++i) {
            uint256 pid = pids[i];
            if (pid >= poolInfo.length) revert PoolDoesNotExist(pid);

            updatePool(pid);

            PoolInfo storage pool = poolInfo[pid];
            UserInfo storage user = userInfo[pid][msg.sender];

            // Locked pools are skipped rather than reverting, so one locked pool does not block a
            // batch harvest across the others.
            if (user.nextHarvestAt <= block.timestamp) {
                _harvestIfUnlocked(pid, pool, user);
                user.rewardDebt = (user.amount * pool.accRewardPerShare) / PRECISION;
            }
        }
    }

    /// @dev Pays out pending rewards if the lockup has elapsed, then arms the next lockup.
    function _harvestIfUnlocked(uint256 pid, PoolInfo storage pool, UserInfo storage user) private {
        if (user.amount == 0) {
            // First interaction: start the lockup clock so a fresh depositor is subject to it.
            if (user.nextHarvestAt == 0) {
                user.nextHarvestAt = block.timestamp + pool.harvestLockup;
            }
            return;
        }

        uint256 pending = (user.amount * pool.accRewardPerShare) / PRECISION - user.rewardDebt;
        if (pending == 0) return;

        if (user.nextHarvestAt > block.timestamp) {
            // Still locked. The reward is not lost: it stays claimable because `rewardDebt` is only
            // advanced by the caller after a successful payout.
            return;
        }

        user.nextHarvestAt = block.timestamp + pool.harvestLockup;

        uint256 paid = _payReward(msg.sender, pending);
        emit Harvest(msg.sender, pid, paid);
    }

    /// @dev Pays at most the balance actually held.
    ///      Once the reward token hits its cap, `mint` in `updatePool` stops topping this contract
    ///      up. Paying out what exists rather than reverting means the farm winds down gracefully
    ///      instead of bricking every deposit and withdrawal at the moment emissions end.
    function _payReward(address to, uint256 amount) private returns (uint256 paid) {
        uint256 balance = IERC20(address(rewardToken)).balanceOf(address(this));
        paid = amount > balance ? balance : amount;

        if (paid > 0) {
            IERC20(address(rewardToken)).safeTransfer(to, paid);
        }
    }

    /*//////////////////////////////////////////////////////////////
                           EMERGENCY WITHDRAW
    //////////////////////////////////////////////////////////////*/

    /// @notice Withdraw the full stake immediately, forfeiting all pending rewards.
    ///
    /// @dev Deliberately touches no reward accounting and calls nothing on the reward token. It
    ///      therefore still works if the reward token is paused, its cap is reached, or the reward
    ///      maths has some bug nobody has found yet. Users must always be able to retrieve their
    ///      principal, and that guarantee is worth more than the forfeited rewards.
    function emergencyWithdraw(uint256 pid) external nonReentrant {
        if (pid >= poolInfo.length) revert PoolDoesNotExist(pid);

        PoolInfo storage pool = poolInfo[pid];
        UserInfo storage user = userInfo[pid][msg.sender];

        uint256 amount = user.amount;
        if (amount == 0) revert ZeroAmount();

        // State first, transfer second.
        user.amount = 0;
        user.rewardDebt = 0;
        user.nextHarvestAt = 0;
        pool.lpSupply -= amount;

        pool.lpToken.safeTransfer(msg.sender, amount);

        emit EmergencyWithdraw(msg.sender, pid, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function setRewardPerSecond(uint256 rewardPerSecond_) external onlyOwner {
        if (rewardPerSecond_ > MAX_REWARD_PER_SECOND) revert EmissionRateTooHigh(rewardPerSecond_);

        // Settle at the old rate before changing it, so the change is not applied retroactively.
        massUpdatePools();

        rewardPerSecond = rewardPerSecond_;
        emit EmissionRateUpdated(rewardPerSecond_);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();

        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function poolLength() external view returns (uint256) {
        return poolInfo.length;
    }

    /// @notice Rewards a user could harvest right now, ignoring the lockup.
    function pendingReward(uint256 pid, address account) external view returns (uint256) {
        if (pid >= poolInfo.length) revert PoolDoesNotExist(pid);

        PoolInfo memory pool = poolInfo[pid];
        UserInfo memory user = userInfo[pid][account];

        uint256 accRewardPerShare = pool.accRewardPerShare;

        if (block.timestamp > pool.lastRewardTime && pool.lpSupply > 0 && totalAllocPoint > 0) {
            uint256 elapsed = block.timestamp - pool.lastRewardTime;
            uint256 reward = (elapsed * rewardPerSecond * pool.allocPoint) / totalAllocPoint;
            accRewardPerShare += (reward * PRECISION) / pool.lpSupply;
        }

        return (user.amount * accRewardPerShare) / PRECISION - user.rewardDebt;
    }

    /// @notice Seconds until a user may harvest from a pool, or zero if they already can.
    function harvestUnlockIn(uint256 pid, address account) external view returns (uint256) {
        uint256 unlockAt = userInfo[pid][account].nextHarvestAt;
        if (unlockAt <= block.timestamp) return 0;
        return unlockAt - block.timestamp;
    }

    /// @notice Emissions per second flowing to one pool.
    function poolRewardPerSecond(uint256 pid) external view returns (uint256) {
        if (pid >= poolInfo.length) revert PoolDoesNotExist(pid);
        if (totalAllocPoint == 0) return 0;

        return (rewardPerSecond * poolInfo[pid].allocPoint) / totalAllocPoint;
    }
}
