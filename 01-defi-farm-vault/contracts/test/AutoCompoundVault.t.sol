// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AutoCompoundVault} from "../src/AutoCompoundVault.sol";
import {MasterChef} from "../src/MasterChef.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {IMasterChef} from "../src/interfaces/IMasterChef.sol";
import {IPancakeRouter} from "../src/interfaces/IPancakeRouter.sol";
import {IRewardToken} from "../src/interfaces/IRewardToken.sol";
import {MockERC20, MockPancakePair, MockPancakeRouter} from "./utils/Mocks.sol";

contract AutoCompoundVaultTest is Test {
    RewardToken internal reward;
    MasterChef internal chef;
    MockPancakePair internal lp;
    MockPancakeRouter internal router;
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;
    AutoCompoundVault internal vault;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant REWARD_PER_SECOND = 1e18;
    uint256 internal pid;

    function setUp() public {
        vm.warp(1_800_000_000);

        reward = new RewardToken("Farm", "FARM", 100_000_000e18, 0, treasury, owner);

        tokenA = new MockERC20("Token A", "TKA", 18);
        tokenB = new MockERC20("Token B", "TKB", 18);
        lp = new MockPancakePair(address(tokenA), address(tokenB));
        router = new MockPancakeRouter(lp);

        chef = new MasterChef(
            IRewardToken(address(reward)), REWARD_PER_SECOND, block.timestamp, feeRecipient, owner
        );

        bytes32 minterRole = reward.MINTER_ROLE();
        vm.prank(owner);
        reward.grantRole(minterRole, address(chef));

        vm.prank(owner);
        pid = chef.add(IERC20(address(lp)), 100, 0, 0);

        vault = new AutoCompoundVault(
            IERC20(address(lp)),
            IMasterChef(address(chef)),
            pid,
            IPancakeRouter(address(router)),
            IERC20(address(reward)),
            feeRecipient,
            owner
        );

        // Deep reserves in both directions so a compound swap has somewhere to go.
        router.setReserves(address(reward), address(tokenA), 1_000_000e18, 1_000_000e18);
        router.setReserves(address(reward), address(tokenB), 1_000_000e18, 1_000_000e18);

        lp.mint(alice, 10_000e18);
        lp.mint(bob, 10_000e18);

        vm.prank(alice);
        lp.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        lp.approve(address(vault), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                            DEPOSIT AND STAKE
    //////////////////////////////////////////////////////////////*/

    /// @dev Idle LP earns nothing, so a deposit must reach the farm in the same transaction.
    function test_depositStakesImmediately() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        (uint256 staked,,) = chef.userInfo(pid, address(vault));
        assertEq(staked, 1_000e18, "forwarded to the farm");
        assertEq(lp.balanceOf(address(vault)), 0, "nothing left idle");
        assertEq(vault.totalAssets(), 1_000e18);
    }

    function test_withdrawUnstakesOnlyWhatIsNeeded() public {
        vm.startPrank(alice);
        vault.deposit(1_000e18, alice);
        vault.withdraw(400e18, alice, alice);
        vm.stopPrank();

        (uint256 staked,,) = chef.userInfo(pid, address(vault));
        assertEq(staked, 600e18);
        assertEq(lp.balanceOf(alice), 10_000e18 - 600e18);
    }

    function test_redeemAll() public {
        vm.startPrank(alice);
        uint256 shares = vault.deposit(1_000e18, alice);
        uint256 assets = vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertEq(assets, 1_000e18);
        assertEq(vault.totalAssets(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                             COMPOUNDING
    //////////////////////////////////////////////////////////////*/

    /// @dev The core loop: harvest, swap, add liquidity, restake. Every share is then worth more.
    function test_compoundIncreasesSharePrice() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        uint256 priceBefore = vault.pricePerShare();

        vm.warp(block.timestamp + 1 days);

        vm.prank(keeper);
        uint256 lpAdded = vault.compound(block.timestamp + 60);

        assertGt(lpAdded, 0, "liquidity was added");
        assertGt(vault.pricePerShare(), priceBefore, "share price rose");
        assertGt(vault.totalAssets(), 1_000e18, "position grew");
        assertEq(vault.totalCompounded(), lpAdded);
    }

    /// @dev A vault only the owner can compound stops compounding when the owner's keeper breaks,
    ///      and unharvested rewards are a far larger loss than any realistic sandwich.
    function test_compoundIsPermissionlessAndPaysABounty() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        vm.warp(block.timestamp + 1 days);

        uint256 expectedBounty = vault.callerBounty();
        assertGt(expectedBounty, 0);

        vm.prank(keeper);
        vault.compound(block.timestamp + 60);

        assertApproxEqRel(
            reward.balanceOf(keeper), expectedBounty, 0.01e18, "caller paid roughly the quoted bounty"
        );
    }

    function test_compoundTakesPerformanceFee() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        vm.warp(block.timestamp + 1 days);

        uint256 pending = vault.pendingRewards();

        vm.prank(keeper);
        vault.compound(block.timestamp + 60);

        uint256 expectedFee = (pending * vault.performanceFeeBps()) / 10_000;
        assertApproxEqRel(reward.balanceOf(feeRecipient), expectedFee, 0.01e18);
    }

    function test_compound_revertsWithNothingToHarvest() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        // Same block as the deposit, so nothing has accrued.
        vm.prank(keeper);
        vm.expectRevert(AutoCompoundVault.NothingToCompound.selector);
        vault.compound(block.timestamp + 60);
    }

    /// @dev A transaction stuck in the mempool must not execute later at a price nobody agreed to.
    function test_compound_respectsDeadline() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        vm.warp(block.timestamp + 1 days);

        vm.prank(keeper);
        vm.expectRevert(AutoCompoundVault.DeadlinePassed.selector);
        vault.compound(block.timestamp - 1);
    }

    /// @dev The attack the slippage bound exists to stop. The vault quotes a price, an attacker
    ///      moves the pool in between, and the trade fills worse than quoted. The swap must revert
    ///      rather than accept whatever it gets.
    function test_compound_revertsWhenSandwichedBeyondTolerance() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        vm.warp(block.timestamp + 1 days);

        // Default tolerance is 1%. A 5% sandwich must be rejected.
        router.setSandwichBps(500);

        vm.prank(keeper);
        vm.expectRevert();
        vault.compound(block.timestamp + 60);
    }

    /// @dev The mirror of the test above: movement inside the tolerance is accepted, so the bound
    ///      is not simply rejecting everything.
    function test_compound_toleratesMovementWithinSlippageBound() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        vm.warp(block.timestamp + 1 days);

        // 0.5% against a 1% tolerance.
        router.setSandwichBps(50);

        vm.prank(keeper);
        uint256 lpAdded = vault.compound(block.timestamp + 60);
        assertGt(lpAdded, 0, "small movement is still compounded");
    }

    /// @dev Tightening the tolerance must actually tighten it.
    function test_setMaxSlippage_tightensTheBound() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        vm.warp(block.timestamp + 1 days);

        vm.prank(owner);
        vault.setMaxSlippage(10); // 0.1%

        router.setSandwichBps(50); // 0.5%, now outside tolerance

        vm.prank(keeper);
        vm.expectRevert();
        vault.compound(block.timestamp + 60);
    }

    /// @dev Compounding must benefit every depositor in proportion to their shares, and must not
    ///      let a late depositor capture yield generated before they arrived.
    function test_compoundBenefitsExistingDepositorsOnly() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        vm.warp(block.timestamp + 1 days);

        vm.prank(keeper);
        vault.compound(block.timestamp + 60);

        uint256 aliceAssets = vault.convertToAssets(vault.balanceOf(alice));
        assertGt(aliceAssets, 1_000e18, "alice earned the yield");

        // Bob arrives after the compound and gets exactly what he paid for.
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_000e18, bob);

        assertApproxEqRel(
            vault.convertToAssets(bobShares), 1_000e18, 0.001e18, "no free ride on past yield"
        );
    }

    /*//////////////////////////////////////////////////////////////
                           INFLATION ATTACK
    //////////////////////////////////////////////////////////////*/

    /// @dev The ERC-4626 first-depositor attack: mint 1 wei of shares, donate to inflate the share
    ///      price, and hope the next depositor rounds to zero.
    function test_inflationAttackFails() public {
        address attacker = makeAddr("attacker");
        lp.mint(attacker, 10_000e18);

        vm.startPrank(attacker);
        lp.approve(address(vault), type(uint256).max);
        vault.deposit(1, attacker);
        lp.transfer(address(vault), 1_000e18);
        vm.stopPrank();

        vm.prank(alice);
        uint256 victimShares = vault.deposit(1_000e18, alice);

        assertGt(victimShares, 0, "victim receives non-zero shares");
        assertApproxEqRel(
            vault.convertToAssets(victimShares), 1_000e18, 0.01e18, "victim keeps their deposit"
        );
    }

    /*//////////////////////////////////////////////////////////////
                              EMERGENCY
    //////////////////////////////////////////////////////////////*/

    /// @dev The escape hatch. Assets land in the vault and stay fully withdrawable, because
    ///      totalAssets counts idle LP as well as staked.
    function test_emergencyUnstakeKeepsFundsWithdrawable() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        vm.warp(block.timestamp + 1 days);

        vm.prank(owner);
        vault.emergencyUnstake();

        (uint256 staked,,) = chef.userInfo(pid, address(vault));
        assertEq(staked, 0, "pulled out of the farm");
        assertEq(lp.balanceOf(address(vault)), 1_000e18, "held by the vault");
        assertEq(vault.totalAssets(), 1_000e18, "still counted");
        assertTrue(vault.paused(), "deposits halted");

        // Withdrawals are deliberately not pausable. Read the share balance before pranking: a
        // nested `vault.balanceOf(alice)` in the argument list would consume the prank and leave
        // `redeem` running as the test contract.
        uint256 aliceShares = vault.balanceOf(alice);

        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);

        assertEq(lp.balanceOf(alice), 10_000e18, "alice got everything back");
    }

    /// @dev A pause must stop new deposits without ever trapping existing ones.
    function test_pauseBlocksDepositsButNotWithdrawals() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);

        vm.prank(owner);
        vault.pause();

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1_000e18, bob);

        uint256 aliceShares = vault.balanceOf(alice);

        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertEq(lp.balanceOf(alice), 10_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @dev Admin error must not be able to widen slippage to the point of meaninglessness.
    function test_setMaxSlippage_isCapped() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AutoCompoundVault.SlippageTooHigh.selector, uint16(500)));
        vault.setMaxSlippage(500);
    }

    function test_setFees_areCapped() public {
        vm.startPrank(owner);

        vm.expectRevert(abi.encodeWithSelector(AutoCompoundVault.FeeTooHigh.selector, uint16(2_500)));
        vault.setFees(2_500, 25, feeRecipient);

        vm.expectRevert(abi.encodeWithSelector(AutoCompoundVault.FeeTooHigh.selector, uint16(200)));
        vault.setFees(500, 200, feeRecipient);

        vm.stopPrank();
    }

    function test_setFees_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setFees(100, 10, alice);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev A deposit followed immediately by a redemption can never return more than went in.
    function testFuzz_roundTripNeverProfits(uint96 amount) public {
        uint256 assets = bound(uint256(amount), 1e6, 5_000e18);

        vm.startPrank(alice);
        uint256 shares = vault.deposit(assets, alice);
        uint256 returned = vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertLe(returned, assets, "round trip cannot profit");
    }

    /// @dev Shares outstanding must always be redeemable from assets actually under management.
    function testFuzz_vaultStaysSolvent(uint96 depositA, uint96 depositB, uint32 elapsed) public {
        uint256 a = bound(uint256(depositA), 1e6, 5_000e18);
        uint256 b = bound(uint256(depositB), 1e6, 5_000e18);

        vm.prank(alice);
        vault.deposit(a, alice);
        vm.prank(bob);
        vault.deposit(b, bob);

        vm.warp(block.timestamp + bound(uint256(elapsed), 1 hours, 30 days));

        vm.prank(keeper);
        try vault.compound(block.timestamp + 60) {} catch {}

        uint256 owed = vault.convertToAssets(vault.totalSupply());
        assertLe(owed, vault.totalAssets(), "vault can honour every share");
    }
}
