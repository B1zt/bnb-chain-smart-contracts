// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

/// @title Presale
/// @notice A token sale with a soft cap, a hard cap, tiered allocations and automatic refunds.
///
/// @dev Presales are the most abused contract type on BNB Chain, so the design here is built around
///      what a buyer needs to be able to verify **before** sending money:
///
///      **Refunds are unconditional and permissionless.** If the soft cap is not met by the end
///      time, every contributor can withdraw their full contribution. No owner action is needed and
///      no owner action can prevent it. `finalize` is the only way funds reach the project, and it
///      cannot succeed below the soft cap.
///
///      **The owner cannot touch contributions before finalisation.** There is no `emergencyWithdraw`,
///      no `rescueTokens` covering the raise currency, and no admin path to the escrowed funds. That
///      absence is the point: those functions are how most presale rugs are actually executed.
///
///      **Sale parameters are immutable once contributions start.** Caps, prices and timing are set
///      at initialisation. A presale whose price the owner can change after you have paid is not a
///      presale.
///
///      **Contributions are priced in USD via Chainlink**, so a BNB contribution and a stablecoin
///      contribution count identically against the caps. Pricing a BNB raise in BNB means the real
///      cap moves with the market between opening and closing.
contract Presale is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    enum Status {
        Pending,
        Live,
        /// @dev Ended at or above the soft cap. Contributors claim, the project finalises.
        Succeeded,
        /// @dev Ended below the soft cap. Contributors refund.
        Failed,
        /// @dev Finalised: proceeds delivered, claims open.
        Finalised
    }

    struct SaleConfig {
        /// @dev Token being sold.
        address token;
        /// @dev Tokens per 1 USD of contribution, at the token's own decimals.
        uint256 tokensPerUsd;
        /// @dev Minimum USD raise for the sale to succeed, 18 decimals.
        uint256 softCapUsd;
        /// @dev Maximum USD raise, 18 decimals.
        uint256 hardCapUsd;
        /// @dev Minimum contribution per transaction, in USD.
        uint256 minContributionUsd;
        /// @dev Default per-wallet cap in USD. A Merkle tier can raise it.
        uint256 maxContributionUsd;
        uint64 startTime;
        uint64 endTime;
        /// @dev Root over (address, maxContributionUsd) leaves. Zero means the sale is open.
        bytes32 tierRoot;
        /// @dev Seconds a wallet must wait between contributions. Blunts scripted bot sniping.
        uint32 contributionCooldown;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotOwner();
    error SaleNotLive();
    error SaleNotEnded();
    error SaleAlreadyFinalised();
    error SoftCapNotMet(uint256 raised, uint256 softCap);
    error SoftCapMet();
    error HardCapExceeded(uint256 attempted, uint256 remaining);
    error BelowMinimum(uint256 attempted, uint256 minimum);
    error ExceedsWalletCap(uint256 attempted, uint256 remaining);
    error CoolingDown(uint256 nextAllowedAt);
    error NothingToClaim();
    error NothingToRefund();
    error AlreadyClaimed();
    error CurrencyNotAccepted(address currency);
    error InvalidProof();
    error InvalidConfig();
    error ZeroAddress();
    error TransferFailed();
    error NotFinalised();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Contributed(
        address indexed contributor, address indexed currency, uint256 amount, uint256 usdValue
    );
    event Claimed(address indexed contributor, uint256 tokenAmount);
    event Refunded(address indexed contributor, address indexed currency, uint256 amount);
    event Finalised(uint256 raisedUsd, uint256 tokensSold);
    event Cancelled();

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Sentinel for native BNB in the currency mappings.
    address public constant NATIVE = address(0);

    uint256 private constant USD_DECIMALS = 18;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    address public owner;
    IPriceFeed public priceFeed;
    SaleConfig public config;

    /// @notice Accepted contribution currencies. Native BNB is always accepted.
    mapping(address currency => bool accepted) public acceptedCurrency;

    /// @notice USD contributed per wallet, 18 decimals.
    mapping(address contributor => uint256 usd) public contributedUsd;

    /// @notice Raw amount contributed per wallet per currency, for exact refunds.
    mapping(address contributor => mapping(address currency => uint256 amount)) public contributions;

    /// @notice Currencies a wallet used, so a refund can return every one of them.
    mapping(address contributor => address[] currencies) private _usedCurrencies;

    mapping(address contributor => uint256 timestamp) public lastContributionAt;
    mapping(address contributor => bool claimed) public hasClaimed;

    /// @notice Total raised in USD, 18 decimals.
    uint256 public totalRaisedUsd;

    /// @notice Total raised per currency, so finalisation can forward each one.
    mapping(address currency => uint256 amount) public raisedPerCurrency;

    uint256 public contributorCount;
    bool public finalised;
    bool public cancelled;

    /*//////////////////////////////////////////////////////////////
                             INITIALISATION
    //////////////////////////////////////////////////////////////*/

    constructor() {
        // Clones are initialised, not constructed. Locking the implementation stops anyone taking
        // ownership of the template itself, which would otherwise be an unowned live contract.
        _disableInitializers();
    }

    function initialize(
        address owner_,
        IPriceFeed priceFeed_,
        SaleConfig calldata config_,
        address[] calldata stablecoins
    ) external initializer {
        if (owner_ == address(0) || address(priceFeed_) == address(0)) revert ZeroAddress();
        if (config_.token == address(0)) revert ZeroAddress();
        if (config_.startTime >= config_.endTime) revert InvalidConfig();
        if (config_.softCapUsd == 0 || config_.softCapUsd > config_.hardCapUsd) revert InvalidConfig();
        if (config_.tokensPerUsd == 0) revert InvalidConfig();
        if (config_.maxContributionUsd < config_.minContributionUsd) revert InvalidConfig();

        owner = owner_;
        priceFeed = priceFeed_;
        config = config_;

        for (uint256 i; i < stablecoins.length; ++i) {
            acceptedCurrency[stablecoins[i]] = true;
        }
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              CONTRIBUTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Contribute native BNB.
    /// @param tierAllowanceUsd Per-wallet cap from the Merkle tier. Ignored on an open sale.
    /// @param proof Merkle proof for `(msg.sender, tierAllowanceUsd)`. Empty on an open sale.
    function contribute(uint256 tierAllowanceUsd, bytes32[] calldata proof)
        external
        payable
        nonReentrant
    {
        if (msg.value == 0) revert BelowMinimum(0, config.minContributionUsd);

        uint256 usdValue = priceFeed.nativeToUsd(msg.value);
        _recordContribution(NATIVE, msg.value, usdValue, tierAllowanceUsd, proof);
    }

    /// @notice Contribute an accepted stablecoin.
    function contributeToken(
        address currency,
        uint256 amount,
        uint256 tierAllowanceUsd,
        bytes32[] calldata proof
    ) external nonReentrant {
        if (!acceptedCurrency[currency]) revert CurrencyNotAccepted(currency);
        if (amount == 0) revert BelowMinimum(0, config.minContributionUsd);

        // Measure what actually arrived. A fee-on-transfer stablecoin would otherwise credit the
        // contributor more than the sale received, leaving the last refund short.
        uint256 balanceBefore = IERC20(currency).balanceOf(address(this));
        IERC20(currency).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(currency).balanceOf(address(this)) - balanceBefore;

        uint256 usdValue = priceFeed.tokenToUsd(currency, received);
        _recordContribution(currency, received, usdValue, tierAllowanceUsd, proof);
    }

    function _recordContribution(
        address currency,
        uint256 amount,
        uint256 usdValue,
        uint256 tierAllowanceUsd,
        bytes32[] calldata proof
    ) private {
        if (status() != Status.Live) revert SaleNotLive();
        if (usdValue < config.minContributionUsd) {
            revert BelowMinimum(usdValue, config.minContributionUsd);
        }

        // Cooldown. Not a real bot defence on its own, but it makes naive scripted sniping
        // meaningfully more expensive without inconveniencing a human.
        uint256 cooldown = config.contributionCooldown;
        if (cooldown > 0) {
            uint256 nextAllowed = lastContributionAt[msg.sender] + cooldown;
            if (lastContributionAt[msg.sender] != 0 && block.timestamp < nextAllowed) {
                revert CoolingDown(nextAllowed);
            }
        }

        uint256 walletCap = _walletCap(tierAllowanceUsd, proof);
        uint256 alreadyContributed = contributedUsd[msg.sender];

        if (alreadyContributed + usdValue > walletCap) {
            revert ExceedsWalletCap(usdValue, walletCap - alreadyContributed);
        }

        uint256 raised = totalRaisedUsd;
        if (raised + usdValue > config.hardCapUsd) {
            revert HardCapExceeded(usdValue, config.hardCapUsd - raised);
        }

        if (alreadyContributed == 0) {
            unchecked {
                ++contributorCount;
            }
        }

        if (contributions[msg.sender][currency] == 0) {
            _usedCurrencies[msg.sender].push(currency);
        }

        contributions[msg.sender][currency] += amount;
        contributedUsd[msg.sender] = alreadyContributed + usdValue;
        lastContributionAt[msg.sender] = block.timestamp;

        totalRaisedUsd = raised + usdValue;
        raisedPerCurrency[currency] += amount;

        emit Contributed(msg.sender, currency, amount, usdValue);
    }

    /// @dev Resolves a wallet's USD cap, verifying a Merkle tier when the sale is gated.
    function _walletCap(uint256 tierAllowanceUsd, bytes32[] calldata proof)
        private
        view
        returns (uint256)
    {
        if (config.tierRoot == bytes32(0)) {
            // Open sale. Rejecting a stray proof rather than ignoring it surfaces frontend bugs.
            if (proof.length != 0) revert InvalidProof();
            return config.maxContributionUsd;
        }

        // Double hashed, so a 64-byte internal node cannot be replayed as a leaf.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, tierAllowanceUsd))));
        if (!MerkleProof.verifyCalldata(proof, config.tierRoot, leaf)) revert InvalidProof();

        return tierAllowanceUsd;
    }

    /*//////////////////////////////////////////////////////////////
                            CLAIM AND REFUND
    //////////////////////////////////////////////////////////////*/

    /// @notice Claim purchased tokens after a successful, finalised sale.
    function claim() external nonReentrant {
        if (!finalised) revert NotFinalised();
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        uint256 usd = contributedUsd[msg.sender];
        if (usd == 0) revert NothingToClaim();

        hasClaimed[msg.sender] = true;

        uint256 tokenAmount = tokensFor(msg.sender);
        IERC20(config.token).safeTransfer(msg.sender, tokenAmount);

        emit Claimed(msg.sender, tokenAmount);
    }

    /// @notice Withdraw a full contribution when the sale failed or was cancelled.
    ///
    /// @dev The guarantee that makes this presale safe to enter. It needs no owner action and no
    ///      owner action can block it: `status()` is derived purely from the raise, the clock and
    ///      the cancellation flag, none of which the owner can rewrite after the fact.
    function refund() external nonReentrant {
        Status current = status();
        if (current != Status.Failed) revert SoftCapMet();

        uint256 usd = contributedUsd[msg.sender];
        if (usd == 0) revert NothingToRefund();

        // Zeroed before any transfer, so a reentrant call finds nothing left.
        contributedUsd[msg.sender] = 0;

        address[] memory currencies = _usedCurrencies[msg.sender];

        for (uint256 i; i < currencies.length; ++i) {
            address currency = currencies[i];
            uint256 amount = contributions[msg.sender][currency];
            if (amount == 0) continue;

            contributions[msg.sender][currency] = 0;
            raisedPerCurrency[currency] -= amount;

            if (currency == NATIVE) {
                (bool ok,) = msg.sender.call{value: amount}("");
                if (!ok) revert TransferFailed();
            } else {
                IERC20(currency).safeTransfer(msg.sender, amount);
            }

            emit Refunded(msg.sender, currency, amount);
        }
    }

    /*//////////////////////////////////////////////////////////////
                              FINALISATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deliver proceeds to the owner and open claims.
    ///
    /// @dev The only path from escrow to the project, and it is gated on the soft cap being met.
    ///      The sale must also hold enough tokens to honour every claim before proceeds move, so a
    ///      project cannot take the money and leave buyers unable to claim.
    function finalize() external onlyOwner nonReentrant {
        if (finalised) revert SaleAlreadyFinalised();

        Status current = status();
        if (current == Status.Live || current == Status.Pending) revert SaleNotEnded();
        if (current == Status.Failed) revert SoftCapNotMet(totalRaisedUsd, config.softCapUsd);

        uint256 owed = totalTokensSold();
        uint256 held = IERC20(config.token).balanceOf(address(this));
        if (held < owed) revert NothingToClaim();

        finalised = true;

        // Forward every currency the sale accepted.
        uint256 nativeRaised = raisedPerCurrency[NATIVE];
        if (nativeRaised > 0) {
            (bool ok,) = owner.call{value: nativeRaised}("");
            if (!ok) revert TransferFailed();
        }

        emit Finalised(totalRaisedUsd, owed);
    }

    /// @notice Forward a stablecoin balance to the owner after finalisation.
    /// @dev Separate from `finalize` so an unbounded currency list cannot make finalisation run out
    ///      of gas, which would strand the whole sale.
    function withdrawCurrency(address currency) external onlyOwner nonReentrant {
        if (!finalised) revert NotFinalised();
        if (currency == NATIVE) revert CurrencyNotAccepted(currency);

        uint256 amount = raisedPerCurrency[currency];
        if (amount == 0) revert NothingToClaim();

        raisedPerCurrency[currency] = 0;
        IERC20(currency).safeTransfer(owner, amount);
    }

    /// @notice Cancel the sale, making every contribution refundable.
    /// @dev Only before finalisation. This is an escape hatch for the project, not a way out of
    ///      obligations: cancelling refunds everyone rather than releasing funds.
    function cancel() external onlyOwner {
        if (finalised) revert SaleAlreadyFinalised();

        cancelled = true;
        emit Cancelled();
    }

    /// @notice Recover unsold tokens after finalisation.
    /// @dev Bounded by what claimants are owed, so it can never take tokens buyers have coming.
    function recoverUnsoldTokens() external onlyOwner nonReentrant {
        if (!finalised) revert NotFinalised();

        uint256 owed = totalTokensSold();
        uint256 held = IERC20(config.token).balanceOf(address(this));
        if (held <= owed) revert NothingToClaim();

        IERC20(config.token).safeTransfer(owner, held - owed);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Current sale status, derived from the clock and the raise.
    /// @dev Deliberately a pure function of immutable config plus the raise total. Nothing here is
    ///      an owner-settable flag, so nobody can flip a failed sale into a successful one.
    function status() public view returns (Status) {
        if (finalised) return Status.Finalised;
        if (cancelled) return Status.Failed;

        if (block.timestamp < config.startTime) return Status.Pending;

        if (block.timestamp < config.endTime) {
            // The hard cap ends the sale early, and only at or above the soft cap can it succeed.
            if (totalRaisedUsd >= config.hardCapUsd) return Status.Succeeded;
            return Status.Live;
        }

        return totalRaisedUsd >= config.softCapUsd ? Status.Succeeded : Status.Failed;
    }

    /// @notice Tokens a contributor will receive.
    function tokensFor(address contributor) public view returns (uint256) {
        return (contributedUsd[contributor] * config.tokensPerUsd) / (10 ** USD_DECIMALS);
    }

    /// @notice Total tokens owed across every contributor.
    function totalTokensSold() public view returns (uint256) {
        return (totalRaisedUsd * config.tokensPerUsd) / (10 ** USD_DECIMALS);
    }

    /// @notice USD still contributable before the hard cap.
    function remainingUsd() external view returns (uint256) {
        if (totalRaisedUsd >= config.hardCapUsd) return 0;
        return config.hardCapUsd - totalRaisedUsd;
    }

    /// @notice Progress towards the hard cap, in basis points.
    function progressBps() external view returns (uint256) {
        if (config.hardCapUsd == 0) return 0;
        return (totalRaisedUsd * 10_000) / config.hardCapUsd;
    }

    /// @notice Currencies a contributor used, for building a refund preview.
    function usedCurrencies(address contributor) external view returns (address[] memory) {
        return _usedCurrencies[contributor];
    }

    /// @notice Token decimals, so a frontend can format without a second call.
    function tokenDecimals() external view returns (uint8) {
        return IERC20Metadata(config.token).decimals();
    }

    /// @dev Native contributions arrive through `contribute`, which is payable. A bare transfer has
    ///      no contributor attached and would be unrefundable, so it is rejected.
    receive() external payable {
        revert SaleNotLive();
    }
}
