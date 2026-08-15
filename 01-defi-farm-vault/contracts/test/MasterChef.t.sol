// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MasterChef} from "../src/MasterChef.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {IRewardToken} from "../src/interfaces/IRewardToken.sol";
import {FeeOnTransferToken, MockERC20} from "./utils/Mocks.sol";

contract MasterChefTest is Test {
    RewardToken internal reward;
    MasterChef internal chef;
    MockERC20 internal lpA;
    MockERC20 internal lpB;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant REWARD_PER_SECOND = 1e18;
    uint256 internal constant CAP = 100_000_000e18;

    function setUp() public {
        vm.warp(1_800_000_000);

        reward = new RewardToken("Farm", "FARM", CAP, 0, treasury, owner);
        chef = new MasterChef(
            IRewardToken(address(reward)), REWARD_PER_SECOND, block.timestamp, feeRecipient, owner
        );

        // Read the role id before pranking. `vm.prank` applies to the next external call, and a
        // nested `reward.MINTER_ROLE()` in the argument list would consume it, leaving `grantRole`
        // to run as the test contract.
        bytes32 minterRole = reward.MINTER_ROLE();

        vm.prank(owner);
        reward.grantRole(minterRole, address(chef));

        lpA = new MockERC20("LP A", "LPA", 18);
        lpB = new MockERC20("LP B", "LPB", 18);

        lpA.mint(alice, 1_000e18);
        lpA.mint(bob, 1_000e18);
        lpB.mint(alice, 1_000e18);

        vm.startPrank(alice);
        lpA.approve(address(chef), type(uint256).max);
        lpB.approve(address(chef), type(uint256).max);
        vm.stopPrank();

        vm.prank(bob);
        lpA.approve(address(chef), type(uint256).max);
    }

    function _addPool(MockERC20 lp, uint256 allocPoint, uint16 depositFee, uint32 lockup)
        internal
        returns (uint256)
    {
        vm.prank(owner);
        return chef.add(IERC20(address(lp)), allocPoint, depositFee, lockup);
    }

    /*//////////////////////////////////////////////////////////////
                            POOL MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    function test_addPool() public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        assertEq(pid, 0);
        assertEq(chef.poolLength(), 1);
        assertEq(chef.totalAllocPoint(), 100);
        assertTrue(chef.isPoolToken(address(lpA)));
    }

    function test_addPool_rejectsDuplicate() public {
        _addPool(lpA, 100, 0, 0);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MasterChef.DuplicatePool.selector, address(lpA)));
        chef.add(IERC20(address(lpA)), 100, 0, 0);
    }

    /// @dev Farming the reward token would make `lpSupply` and the reward accounting reference the
    ///      same asset, so the pool could mint into its own staked balance.
    function test_addPool_rejectsRewardToken() public {
        vm.prank(owner);
        vm.expectRevert(MasterChef.RewardTokenNotFarmable.selector);
        chef.add(IERC20(address(reward)), 100, 0, 0);
    }

    function test_addPool_capsDepositFee() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MasterChef.DepositFeeTooHigh.selector, uint16(500)));
        chef.add(IERC20(address(lpA)), 100, 500, 0);
    }

    function test_addPool_capsHarvestLockup() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(MasterChef.HarvestLockupTooLong.selector, uint32(15 days))
        );
        chef.add(IERC20(address(lpA)), 100, 0, 15 days);
    }

    function test_addPool_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        chef.add(IERC20(address(lpA)), 100, 0, 0);
    }

    /// @dev The classic MasterChef bug: adding a pool without settling the others first rewrites
    ///      how much they earned over the whole preceding period. `add` must call massUpdatePools.
    function test_addingPoolDoesNotRetroactivelyChangeEarnings() public {
        uint256 pidA = _addPool(lpA, 100, 0, 0);

        vm.prank(alice);
        chef.deposit(pidA, 100e18);

        vm.warp(block.timestamp + 100);

        // Alice is the only staker in the only pool, so she has earned the full emission.
        uint256 pendingBefore = chef.pendingReward(pidA, alice);
        assertApproxEqRel(pendingBefore, 100 * REWARD_PER_SECOND, 0.001e18);

        // A second pool with equal weight is added, halving pool A's share from now on.
        _addPool(lpB, 100, 0, 0);

        // Her already-earned rewards must be untouched by the change.
        assertApproxEqRel(
            chef.pendingReward(pidA, alice), pendingBefore, 0.001e18, "past earnings preserved"
        );

        // And from here she earns half the rate.
        vm.warp(block.timestamp + 100);
        uint256 delta = chef.pendingReward(pidA, alice) - pendingBefore;
        assertApproxEqRel(delta, (100 * REWARD_PER_SECOND) / 2, 0.001e18, "new rate applies forward");
    }

    /*//////////////////////////////////////////////////////////////
                          DEPOSIT AND WITHDRAW
    //////////////////////////////////////////////////////////////*/

    function test_deposit() public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        vm.prank(alice);
        chef.deposit(pid, 100e18);

        (uint256 amount,,) = chef.userInfo(pid, alice);
        assertEq(amount, 100e18);
        assertEq(lpA.balanceOf(address(chef)), 100e18);
    }

    function test_deposit_takesFee() public {
        uint256 pid = _addPool(lpA, 100, 400, 0); // 4%

        vm.prank(alice);
        chef.deposit(pid, 100e18);

        (uint256 amount,,) = chef.userInfo(pid, alice);
        assertEq(amount, 96e18, "credited net of fee");
        assertEq(lpA.balanceOf(feeRecipient), 4e18, "fee forwarded");
    }

    /// @dev A fee-on-transfer LP token must be credited by what actually arrived. Trusting the
    ///      requested amount would let the pool promise more than it holds.
    function test_deposit_measuresFeeOnTransferTokens() public {
        FeeOnTransferToken taxed = new FeeOnTransferToken(500); // 5%
        taxed.mint(alice, 1_000e18);

        vm.prank(alice);
        taxed.approve(address(chef), type(uint256).max);

        vm.prank(owner);
        uint256 pid = chef.add(IERC20(address(taxed)), 100, 0, 0);

        vm.prank(alice);
        chef.deposit(pid, 100e18);

        (uint256 amount,,) = chef.userInfo(pid, alice);
        assertEq(amount, 95e18, "credited what arrived, not what was sent");
        assertEq(taxed.balanceOf(address(chef)), 95e18, "accounting matches the real balance");

        // And she can withdraw all of it, which is the property that actually matters.
        vm.prank(alice);
        chef.withdraw(pid, 95e18);

        (uint256 remaining,,) = chef.userInfo(pid, alice);
        assertEq(remaining, 0);
    }

    function test_withdraw() public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        vm.startPrank(alice);
        chef.deposit(pid, 100e18);
        vm.warp(block.timestamp + 100);
        chef.withdraw(pid, 40e18);
        vm.stopPrank();

        (uint256 amount,,) = chef.userInfo(pid, alice);
        assertEq(amount, 60e18);
        assertGt(reward.balanceOf(alice), 0, "pending harvested on withdraw");
    }

    function test_withdraw_revertsOnOverdraw() public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        vm.startPrank(alice);
        chef.deposit(pid, 100e18);

        vm.expectRevert(abi.encodeWithSelector(MasterChef.InsufficientBalance.selector, 200e18, 100e18));
        chef.withdraw(pid, 200e18);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                             REWARD MATHS
    //////////////////////////////////////////////////////////////*/

    function test_rewardsSplitByStake() public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        vm.prank(alice);
        chef.deposit(pid, 100e18);
        vm.prank(bob);
        chef.deposit(pid, 300e18);

        vm.warp(block.timestamp + 100);

        uint256 alicePending = chef.pendingReward(pid, alice);
        uint256 bobPending = chef.pendingReward(pid, bob);

        assertApproxEqRel(alicePending, 25e18, 0.001e18, "alice: 1/4");
        assertApproxEqRel(bobPending, 75e18, 0.001e18, "bob: 3/4");
        assertApproxEqRel(alicePending + bobPending, 100e18, 0.001e18, "total matches emissions");
    }

    function test_rewardsSplitByAllocPoint() public {
        uint256 pidA = _addPool(lpA, 300, 0, 0);
        uint256 pidB = _addPool(lpB, 100, 0, 0);

        vm.startPrank(alice);
        chef.deposit(pidA, 100e18);
        chef.deposit(pidB, 100e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 100);

        assertApproxEqRel(chef.pendingReward(pidA, alice), 75e18, 0.001e18, "pool A: 3/4 weight");
        assertApproxEqRel(chef.pendingReward(pidB, alice), 25e18, 0.001e18, "pool B: 1/4 weight");
    }

    /// @dev A pool with nothing staked must not accrue rewards that later materialise for whoever
    ///      deposits first.
    function test_emptyPoolAccruesNothing() public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        vm.warp(block.timestamp + 1_000);

        vm.prank(alice);
        chef.deposit(pid, 100e18);

        assertEq(chef.pendingReward(pid, alice), 0, "no back-pay for an empty period");
    }

    function test_harvest() public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        vm.prank(alice);
        chef.deposit(pid, 100e18);

        vm.warp(block.timestamp + 100);

        vm.prank(alice);
        chef.harvest(pid);

        assertApproxEqRel(reward.balanceOf(alice), 100e18, 0.001e18);
        assertEq(chef.pendingReward(pid, alice), 0, "reset after harvest");
    }

    /*//////////////////////////////////////////////////////////////
                            HARVEST LOCKUP
    //////////////////////////////////////////////////////////////*/

    function test_harvestLockupBlocksEarlyClaim() public {
        uint256 pid = _addPool(lpA, 100, 0, 12 hours);

        vm.prank(alice);
        chef.deposit(pid, 100e18);

        vm.warp(block.timestamp + 1 hours);

        uint256 unlockAt = block.timestamp + 11 hours;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MasterChef.StillLocked.selector, unlockAt));
        chef.harvest(pid);
    }

    /// @dev Locked rewards must not be lost. They stay claimable once the lockup elapses.
    function test_lockedRewardsAreNotForfeited() public {
        uint256 pid = _addPool(lpA, 100, 0, 12 hours);

        vm.prank(alice);
        chef.deposit(pid, 100e18);

        vm.warp(block.timestamp + 12 hours + 1);

        uint256 pending = chef.pendingReward(pid, alice);
        assertGt(pending, 0);

        vm.prank(alice);
        chef.harvest(pid);

        assertApproxEqRel(reward.balanceOf(alice), pending, 0.001e18, "everything accrued was paid");
    }

    function test_harvestMany_skipsLockedPools() public {
        uint256 pidA = _addPool(lpA, 100, 0, 0);
        uint256 pidB = _addPool(lpB, 100, 0, 12 hours);

        vm.startPrank(alice);
        chef.deposit(pidA, 100e18);
        chef.deposit(pidB, 100e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 hours);

        uint256[] memory pids = new uint256[](2);
        pids[0] = pidA;
        pids[1] = pidB;

        // A locked pool must not make the whole batch revert.
        vm.prank(alice);
        chef.harvestMany(pids);

        assertGt(reward.balanceOf(alice), 0, "unlocked pool paid out");
        assertGt(chef.pendingReward(pidB, alice), 0, "locked pool still owed");
    }

    /*//////////////////////////////////////////////////////////////
                          EMERGENCY WITHDRAW
    //////////////////////////////////////////////////////////////*/

    function test_emergencyWithdraw_returnsPrincipalAndForfeitsRewards() public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        vm.prank(alice);
        chef.deposit(pid, 100e18);

        vm.warp(block.timestamp + 100);
        assertGt(chef.pendingReward(pid, alice), 0);

        uint256 balanceBefore = lpA.balanceOf(alice);

        vm.prank(alice);
        chef.emergencyWithdraw(pid);

        assertEq(lpA.balanceOf(alice) - balanceBefore, 100e18, "principal returned in full");
        assertEq(reward.balanceOf(alice), 0, "rewards forfeited");

        (uint256 amount, uint256 debt,) = chef.userInfo(pid, alice);
        assertEq(amount, 0);
        assertEq(debt, 0);
    }

    /// @dev The whole point of emergencyWithdraw: it must still work when the reward path is broken.
    ///      Here minting is permanently disabled, which makes the normal harvest path unable to top
    ///      the chef up. Principal must still come out.
    function test_emergencyWithdraw_worksWhenRewardTokenIsBroken() public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        vm.prank(alice);
        chef.deposit(pid, 100e18);

        vm.warp(block.timestamp + 100);

        vm.prank(owner);
        reward.finishMinting();

        uint256 balanceBefore = lpA.balanceOf(alice);

        vm.prank(alice);
        chef.emergencyWithdraw(pid);

        assertEq(lpA.balanceOf(alice) - balanceBefore, 100e18, "principal still retrievable");
    }

    /*//////////////////////////////////////////////////////////////
                              CAP BEHAVIOUR
    //////////////////////////////////////////////////////////////*/

    /// @dev Once emissions exhaust the cap, minting fails. The farm must wind down gracefully
    ///      rather than bricking every deposit and withdrawal.
    function test_farmKeepsWorkingAfterCapIsReached() public {
        RewardToken small = new RewardToken("Small", "SML", 1_000e18, 0, treasury, owner);
        MasterChef smallChef = new MasterChef(
            IRewardToken(address(small)), REWARD_PER_SECOND, block.timestamp, feeRecipient, owner
        );

        bytes32 smallMinter = small.MINTER_ROLE();

        vm.prank(owner);
        small.grantRole(smallMinter, address(smallChef));

        vm.prank(owner);
        uint256 pid = smallChef.add(IERC20(address(lpA)), 100, 0, 0);

        vm.startPrank(alice);
        lpA.approve(address(smallChef), type(uint256).max);
        smallChef.deposit(pid, 100e18);
        vm.stopPrank();

        // Far past the point where the cap is exhausted.
        vm.warp(block.timestamp + 10_000);

        // Deposits and withdrawals must still work.
        vm.prank(alice);
        smallChef.withdraw(pid, 100e18);

        assertEq(small.balanceOf(alice), 1_000e18, "paid out exactly the cap");
        (uint256 amount,,) = smallChef.userInfo(pid, alice);
        assertEq(amount, 0, "principal returned");
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function test_setRewardPerSecond_isNotRetroactive() public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        vm.prank(alice);
        chef.deposit(pid, 100e18);

        vm.warp(block.timestamp + 100);
        uint256 earnedAtOldRate = chef.pendingReward(pid, alice);

        vm.prank(owner);
        chef.setRewardPerSecond(REWARD_PER_SECOND / 2);

        assertApproxEqRel(
            chef.pendingReward(pid, alice), earnedAtOldRate, 0.001e18, "past earnings unchanged"
        );

        vm.warp(block.timestamp + 100);
        uint256 delta = chef.pendingReward(pid, alice) - earnedAtOldRate;
        assertApproxEqRel(delta, 50e18, 0.001e18, "new rate applies forward only");
    }

    function test_setRewardPerSecond_isCapped() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(MasterChef.EmissionRateTooHigh.selector, uint256(1_001e18))
        );
        chef.setRewardPerSecond(1_001e18);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev Total rewards paid across all users never exceeds what the emission schedule allows.
    function testFuzz_emissionsAreBounded(uint32 elapsed, uint96 stakeA, uint96 stakeB) public {
        uint256 pid = _addPool(lpA, 100, 0, 0);

        uint256 amountA = bound(uint256(stakeA), 1e18, 1_000e18);
        uint256 amountB = bound(uint256(stakeB), 1e18, 1_000e18);
        uint256 duration = bound(uint256(elapsed), 1, 365 days);

        vm.prank(alice);
        chef.deposit(pid, amountA);
        vm.prank(bob);
        chef.deposit(pid, amountB);

        vm.warp(block.timestamp + duration);

        uint256 totalPending = chef.pendingReward(pid, alice) + chef.pendingReward(pid, bob);
        uint256 maxEmitted = duration * REWARD_PER_SECOND;

        assertLe(totalPending, maxEmitted + 1, "cannot exceed the emission schedule");
    }

    /// @dev Whatever happens, a user can always retrieve their principal.
    function testFuzz_principalIsAlwaysRecoverable(uint96 stake, uint32 elapsed) public {
        uint256 pid = _addPool(lpA, 100, 0, 0);
        uint256 amount = bound(uint256(stake), 1e18, 1_000e18);

        vm.prank(alice);
        chef.deposit(pid, amount);

        vm.warp(block.timestamp + bound(uint256(elapsed), 0, 365 days));

        uint256 before = lpA.balanceOf(alice);

        vm.prank(alice);
        chef.emergencyWithdraw(pid);

        assertEq(lpA.balanceOf(alice) - before, amount, "principal always recoverable");
    }
}
