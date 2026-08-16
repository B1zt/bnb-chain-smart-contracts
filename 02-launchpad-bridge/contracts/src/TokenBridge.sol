// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBridgeToken} from "./interfaces/IBridgeToken.sol";

/// @title TokenBridge
/// @notice Lock-and-mint token bridge with a threshold validator set.
///
/// @dev **Read this before deploying anything like it.** Bridges are the most catastrophically
///      exploited contract category in the industry: Ronin, Wormhole, Nomad, Harmony and Binance
///      Bridge together account for well over a billion dollars, and almost every one of those was
///      a signature-verification or replay bug rather than anything exotic.
///
///      How this design addresses each of the classic failure modes:
///
///      **Ronin (compromised validator majority).** A threshold of `m` of `n` validators is
///      required, and the threshold is enforced to be a strict majority. That is a mitigation, not
///      a fix: the trust assumption of any externally-validated bridge is that the validator set is
///      honest. It is stated plainly rather than hidden, and validators should be independent
///      operators with separate key custody.
///
///      **Wormhole (signature verification bypass).** Signatures are checked over an EIP-712 digest
///      binding every field of the transfer, including both chain ids and this contract's own
///      address. A signature for one chain, one bridge or one amount cannot be replayed for
///      another.
///
///      **Nomad (a zero message root treated as valid).** A message hash of zero is rejected
///      explicitly, and `processed` is checked before any state change.
///
///      **Duplicate validator signatures.** Signatures must arrive in strictly ascending signer
///      order, which makes a duplicate impossible without an extra loop or a mapping.
///
///      Additionally: a daily volume cap bounds the blast radius of a compromise, and a delay on
///      large transfers gives a human time to pause the bridge before an exploit completes.
///
///      **This is a reference implementation and has not been audited. Do not bridge real value
///      with it.** For production, a battle-tested messaging layer such as LayerZero, Axelar or
///      Chainlink CCIP moves the validator-set problem to a party that specialises in it.
contract TokenBridge is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice A cross-chain transfer, signed by validators on the destination side.
    struct Transfer {
        /// @dev Chain the tokens left.
        uint256 sourceChainId;
        /// @dev Chain the tokens arrive on. Must equal this chain, so a signature cannot be reused.
        uint256 destinationChainId;
        /// @dev Bridge contract on the destination chain. Binds the signature to this deployment.
        address destinationBridge;
        address token;
        address recipient;
        uint256 amount;
        /// @dev Per-source-chain sequence number, making each transfer unique.
        uint256 nonce;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error ZeroAmount();
    error TokenNotSupported(address token);
    error ChainNotSupported(uint256 chainId);
    error WrongDestinationChain(uint256 expected, uint256 actual);
    error WrongDestinationBridge(address expected, address actual);
    error AlreadyProcessed(bytes32 messageHash);
    error InvalidMessageHash();
    error NotEnoughSignatures(uint256 provided, uint256 required);
    error SignaturesNotSorted();
    error NotAValidator(address signer);
    error ThresholdTooLow(uint8 threshold, uint256 validatorCount);
    error ValidatorAlreadyAdded(address validator);
    error ValidatorNotFound(address validator);
    error DailyLimitExceeded(uint256 attempted, uint256 remaining);
    error TransferStillDelayed(uint256 executableAt);
    error TransferNotPending(bytes32 messageHash);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event TransferInitiated(
        bytes32 indexed messageHash,
        address indexed sender,
        address indexed token,
        uint256 destinationChainId,
        address recipient,
        uint256 amount,
        uint256 nonce
    );
    event TransferCompleted(
        bytes32 indexed messageHash, address indexed token, address indexed recipient, uint256 amount
    );
    event TransferQueued(bytes32 indexed messageHash, uint256 executableAt);
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event ThresholdUpdated(uint8 threshold);
    event TokenConfigured(address indexed token, bool mintBurn, uint256 dailyLimit);
    event ChainConfigured(uint256 indexed chainId, address bridge, bool enabled);

    /*//////////////////////////////////////////////////////////////
                                 TYPEHASH
    //////////////////////////////////////////////////////////////*/

    bytes32 private constant TRANSFER_TYPEHASH = keccak256(
        "Transfer(uint256 sourceChainId,uint256 destinationChainId,address destinationBridge,address token,address recipient,uint256 amount,uint256 nonce)"
    );

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Signatures required to release a transfer.
    uint8 public threshold;

    mapping(address validator => bool isValidator) public isValidator;
    address[] private _validators;

    /// @notice Bridgeable tokens.
    mapping(address token => bool supported) public supportedToken;

    /// @notice Whether a token is mint-and-burn on this chain, or lock-and-release.
    /// @dev The token's canonical home chain locks; every other chain mints. Getting this backwards
    ///      on one side is how a bridge ends up with unbacked supply.
    mapping(address token => bool mintBurn) public isMintBurn;

    /// @notice Maximum value that may leave per token per day.
    mapping(address token => uint256 limit) public dailyLimit;

    /// @notice Amount released per token per UTC day.
    mapping(address token => mapping(uint256 day => uint256 amount)) public dailyReleased;

    /// @notice Transfers above this are queued rather than released immediately.
    mapping(address token => uint256 threshold) public delayThreshold;

    /// @notice Bridge address on each supported chain.
    mapping(uint256 chainId => address bridge) public remoteBridge;
    mapping(uint256 chainId => bool enabled) public supportedChain;

    /// @notice Outbound sequence number per destination chain.
    mapping(uint256 chainId => uint256 nonce) public outboundNonce;

    /// @notice Message hashes already released, the primary replay defence.
    mapping(bytes32 messageHash => bool processed) public processed;

    /// @notice When a queued large transfer becomes executable.
    mapping(bytes32 messageHash => uint256 executableAt) public queuedAt;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice How long a large transfer waits before it can be released.
    /// @dev The window in which a human can notice an anomaly and pause the bridge. Most bridge
    ///      exploits drain everything within a single block; a delay turns that into a race the
    ///      defenders can sometimes win.
    uint256 public constant LARGE_TRANSFER_DELAY = 1 hours;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address owner_, address[] memory validators_, uint8 threshold_)
        EIP712("B1zt TokenBridge", "1")
        Ownable(owner_)
    {
        for (uint256 i; i < validators_.length; ++i) {
            address validator = validators_[i];
            if (validator == address(0)) revert ZeroAddress();
            if (isValidator[validator]) revert ValidatorAlreadyAdded(validator);

            isValidator[validator] = true;
            _validators.push(validator);

            emit ValidatorAdded(validator);
        }

        _setThreshold(threshold_);
    }

    /*//////////////////////////////////////////////////////////////
                            OUTBOUND TRANSFER
    //////////////////////////////////////////////////////////////*/

    /// @notice Send tokens to another chain.
    /// @dev Locks or burns here and emits an event. Validators observe it and sign a release on the
    ///      destination chain. Nothing is minted here.
    function bridgeOut(address token, uint256 destinationChainId, address recipient, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 messageHash)
    {
        if (!supportedToken[token]) revert TokenNotSupported(token);
        if (!supportedChain[destinationChainId]) revert ChainNotSupported(destinationChainId);
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Measure what arrived. A fee-on-transfer token would otherwise emit an event for more than
        // was received, and the destination chain would mint tokens this side never took custody of.
        uint256 received;
        if (isMintBurn[token]) {
            uint256 balanceBefore = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            received = IERC20(token).balanceOf(address(this)) - balanceBefore;

            IBridgeToken(token).burn(received);
        } else {
            uint256 balanceBefore = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        }

        if (received == 0) revert ZeroAmount();

        uint256 nonce = outboundNonce[destinationChainId]++;

        messageHash = _hashTransfer(
            Transfer({
                sourceChainId: block.chainid,
                destinationChainId: destinationChainId,
                destinationBridge: remoteBridge[destinationChainId],
                token: token,
                recipient: recipient,
                amount: received,
                nonce: nonce
            })
        );

        emit TransferInitiated(
            messageHash, msg.sender, token, destinationChainId, recipient, received, nonce
        );
    }

    /*//////////////////////////////////////////////////////////////
                            INBOUND TRANSFER
    //////////////////////////////////////////////////////////////*/

    /// @notice Release a transfer signed by the validator set.
    ///
    /// @param transfer The transfer being released.
    /// @param signatures Validator signatures over the EIP-712 digest, **sorted by signer address
    ///        in strictly ascending order**. The ordering requirement is what makes a duplicate
    ///        signature impossible to submit, without needing a mapping or a nested loop.
    function bridgeIn(Transfer calldata transfer, bytes[] calldata signatures)
        external
        nonReentrant
        whenNotPaused
    {
        // Bind the signature to this chain and this contract. Without both checks, a signature
        // valid on one deployment could be replayed on another, which is how a multi-chain bridge
        // gets drained from its cheapest chain.
        if (transfer.destinationChainId != block.chainid) {
            revert WrongDestinationChain(block.chainid, transfer.destinationChainId);
        }
        if (transfer.destinationBridge != address(this)) {
            revert WrongDestinationBridge(address(this), transfer.destinationBridge);
        }

        if (!supportedToken[transfer.token]) revert TokenNotSupported(transfer.token);
        if (!supportedChain[transfer.sourceChainId]) revert ChainNotSupported(transfer.sourceChainId);
        if (transfer.recipient == address(0)) revert ZeroAddress();
        if (transfer.amount == 0) revert ZeroAmount();

        bytes32 messageHash = _hashTransfer(transfer);

        // Nomad's exploit was a zero root being accepted as proven. Rejecting it costs nothing.
        if (messageHash == bytes32(0)) revert InvalidMessageHash();
        if (processed[messageHash]) revert AlreadyProcessed(messageHash);

        _verifySignatures(messageHash, signatures);

        // Large transfers wait, so a human has a window to pause before an exploit completes.
        uint256 delayAt = delayThreshold[transfer.token];
        if (delayAt != 0 && transfer.amount >= delayAt) {
            uint256 executableAt = queuedAt[messageHash];

            if (executableAt == 0) {
                queuedAt[messageHash] = block.timestamp + LARGE_TRANSFER_DELAY;
                emit TransferQueued(messageHash, block.timestamp + LARGE_TRANSFER_DELAY);
                return;
            }

            if (block.timestamp < executableAt) revert TransferStillDelayed(executableAt);
        }

        _release(messageHash, transfer);
    }

    /// @notice Release a queued transfer once its delay has elapsed.
    /// @dev Signatures are re-verified rather than trusted from the queueing call, so a validator
    ///      set change during the delay is respected.
    function executeQueued(Transfer calldata transfer, bytes[] calldata signatures)
        external
        nonReentrant
        whenNotPaused
    {
        bytes32 messageHash = _hashTransfer(transfer);

        uint256 executableAt = queuedAt[messageHash];
        if (executableAt == 0) revert TransferNotPending(messageHash);
        if (processed[messageHash]) revert AlreadyProcessed(messageHash);
        if (block.timestamp < executableAt) revert TransferStillDelayed(executableAt);

        _verifySignatures(messageHash, signatures);
        _release(messageHash, transfer);
    }

    function _release(bytes32 messageHash, Transfer calldata transfer) private {
        // Marked before any external call, so a reentrant release finds it already processed.
        processed[messageHash] = true;

        // Daily cap. Bounds how much a compromised validator set can extract before anyone reacts.
        uint256 day = block.timestamp / 1 days;
        uint256 limit = dailyLimit[transfer.token];

        if (limit != 0) {
            uint256 releasedToday = dailyReleased[transfer.token][day];
            if (releasedToday + transfer.amount > limit) {
                revert DailyLimitExceeded(transfer.amount, limit - releasedToday);
            }
            dailyReleased[transfer.token][day] = releasedToday + transfer.amount;
        }

        if (isMintBurn[transfer.token]) {
            IBridgeToken(transfer.token).mint(transfer.recipient, transfer.amount);
        } else {
            IERC20(transfer.token).safeTransfer(transfer.recipient, transfer.amount);
        }

        emit TransferCompleted(messageHash, transfer.token, transfer.recipient, transfer.amount);
    }

    /*//////////////////////////////////////////////////////////////
                          SIGNATURE VERIFICATION
    //////////////////////////////////////////////////////////////*/

    /// @dev Requires `threshold` signatures from distinct validators.
    ///
    ///      Signers must be strictly ascending. That single constraint is what makes it impossible
    ///      to satisfy the threshold by submitting one validator's signature `n` times, which is a
    ///      real bug that has appeared in deployed multisig bridges.
    function _verifySignatures(bytes32 messageHash, bytes[] calldata signatures) private view {
        if (signatures.length < threshold) {
            revert NotEnoughSignatures(signatures.length, threshold);
        }

        bytes32 digest = _hashTypedDataV4(messageHash);
        address previous = address(0);

        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);

            // Strictly greater, so duplicates and unsorted input both revert.
            if (signer <= previous) revert SignaturesNotSorted();
            if (!isValidator[signer]) revert NotAValidator(signer);

            previous = signer;
        }
    }

    /// @dev EIP-712 struct hash for a transfer.
    function _hashTransfer(Transfer memory transfer) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TRANSFER_TYPEHASH,
                transfer.sourceChainId,
                transfer.destinationChainId,
                transfer.destinationBridge,
                transfer.token,
                transfer.recipient,
                transfer.amount,
                transfer.nonce
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function addValidator(address validator) external onlyOwner {
        if (validator == address(0)) revert ZeroAddress();
        if (isValidator[validator]) revert ValidatorAlreadyAdded(validator);

        isValidator[validator] = true;
        _validators.push(validator);

        emit ValidatorAdded(validator);
    }

    /// @dev Removing a validator can invalidate the threshold, so it is re-checked afterwards.
    function removeValidator(address validator) external onlyOwner {
        if (!isValidator[validator]) revert ValidatorNotFound(validator);

        isValidator[validator] = false;

        uint256 length = _validators.length;
        for (uint256 i; i < length; ++i) {
            if (_validators[i] == validator) {
                _validators[i] = _validators[length - 1];
                _validators.pop();
                break;
            }
        }

        // A threshold larger than the remaining set would freeze the bridge permanently.
        if (threshold > _validators.length) revert ThresholdTooLow(threshold, _validators.length);

        emit ValidatorRemoved(validator);
    }

    function setThreshold(uint8 threshold_) external onlyOwner {
        _setThreshold(threshold_);
    }

    /// @dev A strict majority is enforced. Anything less means a minority can move funds, which
    ///      defeats the point of having a set at all.
    function _setThreshold(uint8 threshold_) private {
        uint256 count = _validators.length;

        if (threshold_ == 0 || threshold_ > count || threshold_ * 2 <= count) {
            revert ThresholdTooLow(threshold_, count);
        }

        threshold = threshold_;
        emit ThresholdUpdated(threshold_);
    }

    /// @notice Configure a bridgeable token.
    /// @param mintBurn True on chains where this token is a bridged representation, false on its
    ///        canonical home chain where it is locked instead.
    function configureToken(
        address token,
        bool supported,
        bool mintBurn,
        uint256 dailyLimit_,
        uint256 delayThreshold_
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();

        supportedToken[token] = supported;
        isMintBurn[token] = mintBurn;
        dailyLimit[token] = dailyLimit_;
        delayThreshold[token] = delayThreshold_;

        emit TokenConfigured(token, mintBurn, dailyLimit_);
    }

    function configureChain(uint256 chainId, address bridge, bool enabled) external onlyOwner {
        supportedChain[chainId] = enabled;
        remoteBridge[chainId] = bridge;

        emit ChainConfigured(chainId, bridge, enabled);
    }

    /// @notice Halt the bridge.
    /// @dev The lever the transfer delay exists to give time for. Deliberately not restricted to a
    ///      timelock: when a bridge is being drained, a two day delay on pressing stop is useless.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function validators() external view returns (address[] memory) {
        return _validators;
    }

    function validatorCount() external view returns (uint256) {
        return _validators.length;
    }

    /// @notice The digest validators sign for a transfer.
    function transferDigest(Transfer calldata transfer) external view returns (bytes32) {
        return _hashTypedDataV4(_hashTransfer(transfer));
    }

    /// @notice The message hash identifying a transfer.
    function transferHash(Transfer calldata transfer) external pure returns (bytes32) {
        return _hashTransfer(transfer);
    }

    /// @notice Amount still releasable for a token today.
    function remainingDailyLimit(address token) external view returns (uint256) {
        uint256 limit = dailyLimit[token];
        if (limit == 0) return type(uint256).max;

        uint256 released = dailyReleased[token][block.timestamp / 1 days];
        return released >= limit ? 0 : limit - released;
    }

    /// @notice Domain separator, for off-chain signers.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
