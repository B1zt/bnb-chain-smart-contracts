// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title LiquidityLocker
/// @notice Time-locks LP tokens so liquidity cannot be pulled before a published date.
///
/// @dev The single most important property: **there is no early withdrawal, for anyone.** No owner
///      override, no emergency function, no admin role that can shorten a lock. A locker with an
///      escape hatch provides no assurance at all, because the escape hatch is exactly what gets
///      used during a rug.
///
///      What the owner of a lock *can* do:
///
///      - **Extend** it. Longer is always allowed, shorter never is.
///      - **Transfer** it to another address, so a project can hand locks to a new treasury or a
///        multisig without breaking the lock.
///      - **Withdraw** once, after the unlock time.
///
///      The lock is also splittable, so a project can release liquidity in tranches rather than all
///      at once, which is usually what a community actually wants.
contract LiquidityLocker is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Lock {
        address token;
        address owner;
        uint256 amount;
        uint64 lockedAt;
        uint64 unlockAt;
        bool withdrawn;
        /// @dev Free-form label, e.g. "Presale liquidity, 12 months".
        string description;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error LockNotFound(uint256 lockId);
    error NotLockOwner();
    error StillLocked(uint64 unlockAt);
    error AlreadyWithdrawn();
    error UnlockInPast();
    error CannotShortenLock(uint64 current, uint64 requested);
    error ZeroAmount();
    error ZeroAddress();
    error AmountExceedsLock(uint256 requested, uint256 available);
    error LockTooLong();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event LockCreated(
        uint256 indexed lockId,
        address indexed token,
        address indexed owner,
        uint256 amount,
        uint64 unlockAt
    );
    event LockExtended(uint256 indexed lockId, uint64 previousUnlock, uint64 newUnlock);
    event LockTransferred(uint256 indexed lockId, address indexed from, address indexed to);
    event LockSplit(uint256 indexed lockId, uint256 indexed newLockId, uint256 amount);
    event Withdrawn(uint256 indexed lockId, address indexed to, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Upper bound on a lock duration.
    /// @dev A hundred year lock is indistinguishable from a burn, and burning is what a project
    ///      that wants permanence should actually do. Bounding it keeps the intent honest.
    uint64 public constant MAX_LOCK_DURATION = 10 * 365 days;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    uint256 public lockCount;

    mapping(uint256 lockId => Lock) private _locks;

    /// @notice Lock ids per owner, so a UI can enumerate without scanning events.
    mapping(address owner => uint256[] lockIds) private _locksByOwner;

    /// @notice Lock ids per token, for verifying a project's claimed locks.
    mapping(address token => uint256[] lockIds) private _locksByToken;

    /// @notice Total currently locked per token, across all unwithdrawn locks.
    mapping(address token => uint256 amount) public totalLocked;

    /*//////////////////////////////////////////////////////////////
                                LOCKING
    //////////////////////////////////////////////////////////////*/

    /// @notice Lock tokens until `unlockAt`.
    /// @dev The caller must have approved this contract first.
    function lock(address token, uint256 amount, uint64 unlockAt, string calldata description)
        external
        nonReentrant
        returns (uint256 lockId)
    {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (unlockAt <= block.timestamp) revert UnlockInPast();
        if (unlockAt > block.timestamp + MAX_LOCK_DURATION) revert LockTooLong();

        // Measure what arrived rather than trusting the requested amount. A fee-on-transfer token
        // would otherwise report a larger lock than the contract actually holds, which is precisely
        // the lie a locker exists to prevent.
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;

        if (received == 0) revert ZeroAmount();

        lockId = lockCount++;

        _locks[lockId] = Lock({
            token: token,
            owner: msg.sender,
            amount: received,
            lockedAt: uint64(block.timestamp),
            unlockAt: unlockAt,
            withdrawn: false,
            description: description
        });

        _locksByOwner[msg.sender].push(lockId);
        _locksByToken[token].push(lockId);
        totalLocked[token] += received;

        emit LockCreated(lockId, token, msg.sender, received, unlockAt);
    }

    /// @notice Push a lock's unlock time further out. Never closer.
    function extend(uint256 lockId, uint64 newUnlockAt) external {
        Lock storage entry = _requireOwned(lockId);

        if (newUnlockAt <= entry.unlockAt) revert CannotShortenLock(entry.unlockAt, newUnlockAt);
        if (newUnlockAt > block.timestamp + MAX_LOCK_DURATION) revert LockTooLong();

        uint64 previous = entry.unlockAt;
        entry.unlockAt = newUnlockAt;

        emit LockExtended(lockId, previous, newUnlockAt);
    }

    /// @notice Hand a lock to another address without changing its terms.
    /// @dev Lets a project move locks to a new treasury or a multisig. The unlock time is untouched,
    ///      so this cannot be used to escape the lock.
    function transferLock(uint256 lockId, address to) external {
        if (to == address(0)) revert ZeroAddress();

        Lock storage entry = _requireOwned(lockId);

        entry.owner = to;
        _locksByOwner[to].push(lockId);

        emit LockTransferred(lockId, msg.sender, to);
    }

    /// @notice Split part of a lock into a new one with the same unlock time.
    /// @dev Enables tranched releases: split into several locks, then extend some of them.
    function split(uint256 lockId, uint256 amount) external returns (uint256 newLockId) {
        Lock storage entry = _requireOwned(lockId);

        if (amount == 0) revert ZeroAmount();
        if (amount >= entry.amount) revert AmountExceedsLock(amount, entry.amount);

        entry.amount -= amount;

        newLockId = lockCount++;
        _locks[newLockId] = Lock({
            token: entry.token,
            owner: entry.owner,
            amount: amount,
            lockedAt: entry.lockedAt,
            // Inherits the same unlock time, so splitting cannot release anything early.
            unlockAt: entry.unlockAt,
            withdrawn: false,
            description: entry.description
        });

        _locksByOwner[entry.owner].push(newLockId);
        _locksByToken[entry.token].push(newLockId);

        emit LockSplit(lockId, newLockId, amount);
    }

    /// @notice Withdraw a lock once its unlock time has passed.
    function withdraw(uint256 lockId) external nonReentrant {
        Lock storage entry = _requireOwned(lockId);

        if (entry.withdrawn) revert AlreadyWithdrawn();
        if (block.timestamp < entry.unlockAt) revert StillLocked(entry.unlockAt);

        uint256 amount = entry.amount;

        entry.withdrawn = true;
        entry.amount = 0;
        totalLocked[entry.token] -= amount;

        IERC20(entry.token).safeTransfer(entry.owner, amount);

        emit Withdrawn(lockId, entry.owner, amount);
    }

    function _requireOwned(uint256 lockId) private view returns (Lock storage entry) {
        entry = _locks[lockId];
        if (entry.token == address(0)) revert LockNotFound(lockId);
        if (entry.owner != msg.sender) revert NotLockOwner();
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function locks(uint256 lockId) external view returns (Lock memory) {
        Lock memory entry = _locks[lockId];
        if (entry.token == address(0)) revert LockNotFound(lockId);
        return entry;
    }

    function locksByOwner(address owner) external view returns (uint256[] memory) {
        return _locksByOwner[owner];
    }

    /// @notice Every lock for a token, so anyone can verify a project's claims independently.
    function locksByToken(address token) external view returns (uint256[] memory) {
        return _locksByToken[token];
    }

    /// @notice Seconds until a lock unlocks, or zero if it already has.
    function timeUntilUnlock(uint256 lockId) external view returns (uint256) {
        Lock memory entry = _locks[lockId];
        if (entry.token == address(0)) revert LockNotFound(lockId);
        if (block.timestamp >= entry.unlockAt) return 0;

        return entry.unlockAt - block.timestamp;
    }

    /// @notice Fraction of a token's total supply currently locked here, in basis points.
    /// @dev The number a buyer actually cares about: "5% locked" and "95% locked" are very
    ///      different situations, and a raw amount does not distinguish them.
    function lockedSupplyBps(address token) external view returns (uint256) {
        uint256 supply = IERC20Metadata(token).totalSupply();
        if (supply == 0) return 0;

        return (totalLocked[token] * 10_000) / supply;
    }
}
