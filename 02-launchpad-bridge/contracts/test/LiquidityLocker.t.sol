// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";
import {FeeOnTransferToken, MockERC20} from "./utils/Mocks.sol";

contract LiquidityLockerTest is Test {
    LiquidityLocker internal locker;
    MockERC20 internal lp;

    address internal project = makeAddr("project");
    address internal treasury = makeAddr("treasury");
    address internal outsider = makeAddr("outsider");

    uint64 internal unlockAt;

    function setUp() public {
        vm.warp(1_800_000_000);
        unlockAt = uint64(block.timestamp + 365 days);

        locker = new LiquidityLocker();
        lp = new MockERC20("LP", "LP", 18);

        lp.mint(project, 1_000_000e18);

        vm.prank(project);
        lp.approve(address(locker), type(uint256).max);
    }

    function _lock(uint256 amount) internal returns (uint256) {
        vm.prank(project);
        return locker.lock(address(lp), amount, unlockAt, "Presale liquidity, 12 months");
    }

    /*//////////////////////////////////////////////////////////////
                                LOCKING
    //////////////////////////////////////////////////////////////*/

    function test_lock_holdsTokens() public {
        uint256 lockId = _lock(100_000e18);

        assertEq(lp.balanceOf(address(locker)), 100_000e18);
        assertEq(locker.totalLocked(address(lp)), 100_000e18);

        LiquidityLocker.Lock memory entry = locker.locks(lockId);
        assertEq(entry.owner, project);
        assertEq(entry.amount, 100_000e18);
        assertEq(entry.unlockAt, unlockAt);
        assertFalse(entry.withdrawn);
    }

    function test_lock_rejectsPastUnlock() public {
        vm.prank(project);
        vm.expectRevert(LiquidityLocker.UnlockInPast.selector);
        locker.lock(address(lp), 100e18, uint64(block.timestamp - 1), "");
    }

    /// @dev A hundred year lock is indistinguishable from a burn, and burning is what a project
    ///      wanting permanence should do. Bounding it keeps the intent honest.
    function test_lock_rejectsAbsurdDuration() public {
        vm.prank(project);
        vm.expectRevert(LiquidityLocker.LockTooLong.selector);
        locker.lock(address(lp), 100e18, uint64(block.timestamp + 11 * 365 days), "");
    }

    /// @dev A locker that reports more than it holds is worse than no locker at all.
    function test_lock_recordsWhatActuallyArrived() public {
        FeeOnTransferToken taxed = new FeeOnTransferToken(500); // 5%
        taxed.mint(project, 1_000e18);

        vm.startPrank(project);
        taxed.approve(address(locker), type(uint256).max);
        uint256 lockId = locker.lock(address(taxed), 1_000e18, unlockAt, "taxed");
        vm.stopPrank();

        LiquidityLocker.Lock memory entry = locker.locks(lockId);
        assertEq(entry.amount, 950e18, "records the received amount");
        assertEq(taxed.balanceOf(address(locker)), 950e18, "and it matches the real balance");
    }

    /*//////////////////////////////////////////////////////////////
                          THE CORE GUARANTEE
    //////////////////////////////////////////////////////////////*/

    /// @dev The property the whole contract exists for. No early withdrawal, for anyone, ever.
    ///      A locker with an escape hatch provides no assurance, because the escape hatch is what
    ///      gets used during a rug.
    function test_noEarlyWithdrawal() public {
        uint256 lockId = _lock(100_000e18);

        vm.warp(unlockAt - 1);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(LiquidityLocker.StillLocked.selector, unlockAt));
        locker.withdraw(lockId);

        vm.warp(unlockAt);
        vm.prank(project);
        locker.withdraw(lockId);

        assertEq(lp.balanceOf(project), 1_000_000e18, "returned in full, on time");
    }

    /// @dev There is no owner, no admin and no privileged role on this contract at all, so there is
    ///      nobody who could shorten a lock. A third party cannot even touch it.
    function test_outsiderCannotWithdraw() public {
        uint256 lockId = _lock(100_000e18);
        vm.warp(unlockAt);

        vm.prank(outsider);
        vm.expectRevert(LiquidityLocker.NotLockOwner.selector);
        locker.withdraw(lockId);
    }

    function test_cannotWithdrawTwice() public {
        uint256 lockId = _lock(100_000e18);
        vm.warp(unlockAt);

        vm.startPrank(project);
        locker.withdraw(lockId);

        vm.expectRevert(LiquidityLocker.AlreadyWithdrawn.selector);
        locker.withdraw(lockId);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                          EXTEND, TRANSFER, SPLIT
    //////////////////////////////////////////////////////////////*/

    function test_extend_movesUnlockOut() public {
        uint256 lockId = _lock(100_000e18);
        uint64 later = unlockAt + 180 days;

        vm.prank(project);
        locker.extend(lockId, later);

        assertEq(locker.locks(lockId).unlockAt, later);
    }

    /// @dev Longer is always allowed, shorter never is. Otherwise "extend" becomes the escape hatch.
    function test_extend_cannotShorten() public {
        uint256 lockId = _lock(100_000e18);

        vm.prank(project);
        vm.expectRevert(
            abi.encodeWithSelector(
                LiquidityLocker.CannotShortenLock.selector, unlockAt, unlockAt - 1 days
            )
        );
        locker.extend(lockId, unlockAt - 1 days);
    }

    /// @dev Lets a project move locks to a new treasury or multisig without breaking the lock.
    function test_transferLock_keepsTermsIntact() public {
        uint256 lockId = _lock(100_000e18);

        vm.prank(project);
        locker.transferLock(lockId, treasury);

        LiquidityLocker.Lock memory entry = locker.locks(lockId);
        assertEq(entry.owner, treasury, "ownership moved");
        assertEq(entry.unlockAt, unlockAt, "unlock time unchanged");

        // The old owner can no longer act on it.
        vm.warp(unlockAt);
        vm.prank(project);
        vm.expectRevert(LiquidityLocker.NotLockOwner.selector);
        locker.withdraw(lockId);

        vm.prank(treasury);
        locker.withdraw(lockId);
        assertEq(lp.balanceOf(treasury), 100_000e18);
    }

    /// @dev Splitting enables tranched releases, which is usually what a community actually wants.
    function test_split_inheritsTheSameUnlockTime() public {
        uint256 lockId = _lock(100_000e18);

        vm.prank(project);
        uint256 newLockId = locker.split(lockId, 40_000e18);

        assertEq(locker.locks(lockId).amount, 60_000e18);
        assertEq(locker.locks(newLockId).amount, 40_000e18);

        // The split cannot release anything early: both halves keep the original unlock.
        assertEq(locker.locks(newLockId).unlockAt, unlockAt);
    }

    function test_split_cannotExceedTheLock() public {
        uint256 lockId = _lock(100_000e18);

        vm.prank(project);
        vm.expectRevert(
            abi.encodeWithSelector(
                LiquidityLocker.AmountExceedsLock.selector, 100_000e18, 100_000e18
            )
        );
        locker.split(lockId, 100_000e18);
    }

    /// @dev Split then extend one half: a real tranched release.
    function test_splitThenExtendCreatesTranches() public {
        uint256 lockId = _lock(100_000e18);

        vm.startPrank(project);
        uint256 secondTranche = locker.split(lockId, 50_000e18);
        locker.extend(secondTranche, unlockAt + 180 days);
        vm.stopPrank();

        vm.warp(unlockAt);

        vm.prank(project);
        locker.withdraw(lockId);
        assertEq(lp.balanceOf(project), 900_000e18 + 50_000e18, "first tranche out");

        vm.prank(project);
        vm.expectRevert();
        locker.withdraw(secondTranche);

        vm.warp(unlockAt + 180 days);
        vm.prank(project);
        locker.withdraw(secondTranche);
        assertEq(lp.balanceOf(project), 1_000_000e18, "second tranche out later");
    }

    /*//////////////////////////////////////////////////////////////
                              VERIFIABILITY
    //////////////////////////////////////////////////////////////*/

    /// @dev The number a buyer actually cares about. "5% locked" and "95% locked" are very
    ///      different situations, and a raw amount does not distinguish them.
    function test_lockedSupplyBps() public {
        _lock(250_000e18);

        // 250,000 of 1,000,000 total supply is 25%.
        assertEq(locker.lockedSupplyBps(address(lp)), 2_500);
    }

    function test_locksByTokenLetsAnyoneVerify() public {
        _lock(100_000e18);
        _lock(50_000e18);

        uint256[] memory locks = locker.locksByToken(address(lp));
        assertEq(locks.length, 2, "all locks for the token are enumerable");
        assertEq(locker.totalLocked(address(lp)), 150_000e18);
    }

    function test_timeUntilUnlock() public {
        uint256 lockId = _lock(100_000e18);

        assertEq(locker.timeUntilUnlock(lockId), 365 days);

        vm.warp(unlockAt);
        assertEq(locker.timeUntilUnlock(lockId), 0);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev No amount, duration or elapsed time allows a withdrawal before the unlock.
    function testFuzz_neverWithdrawableEarly(uint96 rawAmount, uint32 rawDuration, uint32 elapsed)
        public
    {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000e18);
        uint64 duration = uint64(bound(uint256(rawDuration), 1 hours, 3_650 days));
        uint64 unlock = uint64(block.timestamp) + duration;

        vm.prank(project);
        uint256 lockId = locker.lock(address(lp), amount, unlock, "");

        uint256 warpTo = block.timestamp + bound(uint256(elapsed), 0, duration - 1);
        vm.warp(warpTo);

        vm.prank(project);
        vm.expectRevert(abi.encodeWithSelector(LiquidityLocker.StillLocked.selector, unlock));
        locker.withdraw(lockId);
    }

    /// @dev Splitting conserves the total, however it is divided.
    function testFuzz_splitConservesTotal(uint96 rawAmount, uint96 rawSplit) public {
        uint256 amount = bound(uint256(rawAmount), 2, 1_000_000e18);
        uint256 splitAmount = bound(uint256(rawSplit), 1, amount - 1);

        vm.prank(project);
        uint256 lockId = locker.lock(address(lp), amount, unlockAt, "");

        vm.prank(project);
        uint256 newLockId = locker.split(lockId, splitAmount);

        assertEq(
            locker.locks(lockId).amount + locker.locks(newLockId).amount,
            amount,
            "nothing created or destroyed"
        );
    }
}
