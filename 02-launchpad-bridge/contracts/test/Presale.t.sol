// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Presale} from "../src/Presale.sol";
import {PresaleFactory} from "../src/PresaleFactory.sol";
import {IPriceFeed} from "../src/interfaces/IPriceFeed.sol";
import {MerkleLib} from "./utils/MerkleLib.sol";
import {MockERC20, MockPriceFeed} from "./utils/Mocks.sol";

contract PresaleTest is Test {
    PresaleFactory internal factory;
    Presale internal presale;
    MockERC20 internal token;
    MockERC20 internal usdt;
    MockPriceFeed internal priceFeed;

    address internal platformOwner = makeAddr("platformOwner");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    /// @dev BNB at $600, so 1 BNB is 600 USD of contribution.
    uint256 internal constant BNB_PRICE = 600e18;

    uint256 internal constant TOKENS_PER_USD = 100e18; // 100 tokens per dollar
    uint256 internal constant SOFT_CAP = 10_000e18; // $10,000
    uint256 internal constant HARD_CAP = 50_000e18; // $50,000
    uint256 internal constant MIN_CONTRIBUTION = 100e18; // $100
    uint256 internal constant MAX_CONTRIBUTION = 5_000e18; // $5,000

    uint64 internal start;
    uint64 internal end;

    function setUp() public {
        vm.warp(1_800_000_000);
        start = uint64(block.timestamp + 1 hours);
        end = uint64(block.timestamp + 7 days);

        token = new MockERC20("Project", "PRJ", 18);
        usdt = new MockERC20("Tether", "USDT", 18);
        priceFeed = new MockPriceFeed();

        priceFeed.setNativePrice(BNB_PRICE);
        priceFeed.setTokenPrice(address(usdt), 1e18);

        factory = new PresaleFactory(platformOwner, feeRecipient, 0.1 ether, 200);

        presale = Presale(payable(_createPresale(bytes32(0), 0)));

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);

        usdt.mint(alice, 100_000e18);
        vm.prank(alice);
        usdt.approve(address(presale), type(uint256).max);
    }

    function _config(bytes32 tierRoot, uint32 cooldown)
        internal
        view
        returns (Presale.SaleConfig memory)
    {
        return Presale.SaleConfig({
            token: address(token),
            tokensPerUsd: TOKENS_PER_USD,
            softCapUsd: SOFT_CAP,
            hardCapUsd: HARD_CAP,
            minContributionUsd: MIN_CONTRIBUTION,
            maxContributionUsd: MAX_CONTRIBUTION,
            startTime: start,
            endTime: end,
            tierRoot: tierRoot,
            contributionCooldown: cooldown
        });
    }

    function _createPresale(bytes32 tierRoot, uint32 cooldown) internal returns (address) {
        Presale.SaleConfig memory config = _config(tierRoot, cooldown);

        uint256 required = (HARD_CAP * TOKENS_PER_USD) / 1e18;
        token.mint(creator, required);

        address[] memory stablecoins = new address[](1);
        stablecoins[0] = address(usdt);

        vm.deal(creator, 1 ether);
        vm.startPrank(creator);
        token.approve(address(factory), required);
        address created =
            factory.createPresale{value: 0.1 ether}(config, stablecoins, IPriceFeed(address(priceFeed)));
        vm.stopPrank();

        return created;
    }

    /// @dev BNB that buys approximately `usd` of contribution, rounded down.
    ///
    ///      Rounding down means the realised USD lands a few wei under the target. That is a
    ///      helper artefact rather than contract behaviour, so tests stay off exact boundaries
    ///      instead of the helper trying to hit them precisely: rounding up would instead overshoot
    ///      a wallet cap by the same few wei.
    function _bnbFor(uint256 usd) internal pure returns (uint256) {
        return (usd * 1e18) / BNB_PRICE;
    }

    /*//////////////////////////////////////////////////////////////
                                FACTORY
    //////////////////////////////////////////////////////////////*/

    /// @dev A presale that exists but holds no tokens cannot honour a single claim. Funding must be
    ///      atomic with creation.
    function test_factory_fundsSaleAtCreation() public view {
        uint256 required = (HARD_CAP * TOKENS_PER_USD) / 1e18;
        assertEq(token.balanceOf(address(presale)), required, "sale fully funded");
    }

    function test_factory_recordsPresale() public view {
        assertEq(factory.presaleCount(), 1);
        assertTrue(factory.isPresale(address(presale)));
        assertEq(factory.presalesByCreator(creator).length, 1);
    }

    function test_factory_requiresCreationFee() public {
        Presale.SaleConfig memory config = _config(bytes32(0), 0);
        address[] memory stablecoins = new address[](0);

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(PresaleFactory.CreationFeeNotPaid.selector, 0, 0.1 ether)
        );
        factory.createPresale(config, stablecoins, IPriceFeed(address(priceFeed)));
    }

    /// @dev The implementation must not be initialisable, otherwise it is a live unowned contract.
    function test_factory_implementationIsLocked() public {
        Presale implementation = Presale(payable(factory.implementation()));
        address[] memory stablecoins = new address[](0);

        vm.expectRevert();
        implementation.initialize(
            alice, IPriceFeed(address(priceFeed)), _config(bytes32(0), 0), stablecoins
        );
    }

    /*//////////////////////////////////////////////////////////////
                              CONTRIBUTING
    //////////////////////////////////////////////////////////////*/

    function test_contribute_native() public {
        vm.warp(start);

        uint256 amount = _bnbFor(1_000e18);

        vm.prank(alice);
        presale.contribute{value: amount}(0, new bytes32[](0));

        assertApproxEqRel(presale.contributedUsd(alice), 1_000e18, 0.001e18, "priced in USD");
        assertApproxEqRel(presale.totalRaisedUsd(), 1_000e18, 0.001e18);
        assertEq(presale.contributorCount(), 1);
    }

    /// @dev A BNB contribution and a stablecoin contribution must count identically against the
    ///      caps. Pricing a raise in BNB means the real cap moves with the market.
    function test_contribute_stablecoinAndNativeAreEquivalent() public {
        vm.warp(start);

        vm.prank(alice);
        presale.contribute{value: _bnbFor(1_000e18)}(0, new bytes32[](0));

        vm.prank(alice);
        presale.contributeToken(address(usdt), 1_000e18, 0, new bytes32[](0));

        assertApproxEqRel(presale.contributedUsd(alice), 2_000e18, 0.001e18, "both count as USD");
    }

    function test_contribute_revertsBeforeStart() public {
        vm.prank(alice);
        vm.expectRevert(Presale.SaleNotLive.selector);
        presale.contribute{value: _bnbFor(1_000e18)}(0, new bytes32[](0));
    }

    function test_contribute_revertsAfterEnd() public {
        vm.warp(end);

        vm.prank(alice);
        vm.expectRevert(Presale.SaleNotLive.selector);
        presale.contribute{value: _bnbFor(1_000e18)}(0, new bytes32[](0));
    }

    function test_contribute_enforcesMinimum() public {
        vm.warp(start);

        vm.prank(alice);
        vm.expectRevert();
        presale.contribute{value: _bnbFor(50e18)}(0, new bytes32[](0));
    }

    function test_contribute_enforcesWalletCap() public {
        vm.warp(start);

        vm.prank(alice);
        presale.contribute{value: _bnbFor(MAX_CONTRIBUTION)}(0, new bytes32[](0));

        vm.prank(alice);
        vm.expectRevert();
        presale.contribute{value: _bnbFor(100e18)}(0, new bytes32[](0));
    }

    function test_contribute_enforcesHardCap() public {
        vm.warp(start);

        // Ten wallets at the $5,000 cap fills the $50,000 hard cap exactly.
        for (uint256 i; i < 10; ++i) {
            address contributor = address(uint160(0x2000 + i));
            vm.deal(contributor, 1_000 ether);

            vm.prank(contributor);
            presale.contribute{value: _bnbFor(MAX_CONTRIBUTION)}(0, new bytes32[](0));
        }

        assertApproxEqRel(presale.totalRaisedUsd(), HARD_CAP, 0.001e18);

        address late = makeAddr("late");
        vm.deal(late, 100 ether);

        vm.prank(late);
        vm.expectRevert();
        presale.contribute{value: _bnbFor(100e18)}(0, new bytes32[](0));
    }

    /// @dev Blunts naive scripted sniping without inconveniencing a human.
    function test_contribute_enforcesCooldown() public {
        Presale gated = Presale(payable(_createPresale(bytes32(0), 60)));
        vm.warp(start);

        vm.prank(alice);
        gated.contribute{value: _bnbFor(500e18)}(0, new bytes32[](0));

        vm.prank(alice);
        vm.expectRevert();
        gated.contribute{value: _bnbFor(500e18)}(0, new bytes32[](0));

        vm.warp(block.timestamp + 61);
        vm.prank(alice);
        gated.contribute{value: _bnbFor(500e18)}(0, new bytes32[](0));

        assertApproxEqRel(gated.contributedUsd(alice), 1_000e18, 0.001e18);
    }

    /*//////////////////////////////////////////////////////////////
                                 TIERS
    //////////////////////////////////////////////////////////////*/

    function test_tieredSale_allowsHigherAllocation() public {
        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(20_000e18)))));
        leaves[1] = keccak256(bytes.concat(keccak256(abi.encode(bob, uint256(2_000e18)))));
        leaves[2] = keccak256(bytes.concat(keccak256(abi.encode(carol, uint256(1_000e18)))));

        _sort(leaves);

        Presale tiered = Presale(payable(_createPresale(MerkleLib.getRoot(leaves), 0)));
        vm.warp(start);

        uint256 aliceIndex = _indexOf(leaves, keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(20_000e18))))));
        bytes32[] memory proof = MerkleLib.getProof(leaves, aliceIndex);

        // Alice's tier allows $20,000, well above the $5,000 default.
        vm.prank(alice);
        tiered.contribute{value: _bnbFor(15_000e18)}(20_000e18, proof);

        assertApproxEqRel(tiered.contributedUsd(alice), 15_000e18, 0.001e18);
    }

    function test_tieredSale_rejectsInflatedAllowance() public {
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(20_000e18)))));
        leaves[1] = keccak256(bytes.concat(keccak256(abi.encode(bob, uint256(2_000e18)))));
        _sort(leaves);

        Presale tiered = Presale(payable(_createPresale(MerkleLib.getRoot(leaves), 0)));
        vm.warp(start);

        uint256 bobIndex = _indexOf(leaves, keccak256(bytes.concat(keccak256(abi.encode(bob, uint256(2_000e18))))));
        bytes32[] memory proof = MerkleLib.getProof(leaves, bobIndex);

        // Bob presents his real proof but claims Alice's allowance. The leaf no longer matches.
        vm.prank(bob);
        vm.expectRevert(Presale.InvalidProof.selector);
        tiered.contribute{value: _bnbFor(1_000e18)}(20_000e18, proof);
    }

    function test_tieredSale_rejectsNonMember() public {
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(20_000e18)))));
        leaves[1] = keccak256(bytes.concat(keccak256(abi.encode(bob, uint256(2_000e18)))));
        _sort(leaves);

        Presale tiered = Presale(payable(_createPresale(MerkleLib.getRoot(leaves), 0)));
        vm.warp(start);

        uint256 aliceIndex = _indexOf(leaves, keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(20_000e18))))));
        bytes32[] memory proof = MerkleLib.getProof(leaves, aliceIndex);

        address mallory = makeAddr("mallory");
        vm.deal(mallory, 100 ether);

        vm.prank(mallory);
        vm.expectRevert(Presale.InvalidProof.selector);
        tiered.contribute{value: _bnbFor(1_000e18)}(20_000e18, proof);
    }

    /*//////////////////////////////////////////////////////////////
                          REFUNDS AND FINALISATION
    //////////////////////////////////////////////////////////////*/

    /// @dev The property that makes this presale safe to enter: below the soft cap, everyone gets
    ///      their money back without needing the owner to do anything.
    function test_refund_belowSoftCapIsUnconditional() public {
        vm.warp(start);

        uint256 contribution = _bnbFor(1_000e18);
        uint256 balanceBefore = alice.balance;

        vm.prank(alice);
        presale.contribute{value: contribution}(0, new bytes32[](0));

        vm.warp(end);
        assertEq(uint256(presale.status()), uint256(Presale.Status.Failed));

        vm.prank(alice);
        presale.refund();

        assertEq(alice.balance, balanceBefore, "refunded in full");
        assertEq(presale.contributedUsd(alice), 0);
    }

    function test_refund_returnsEveryCurrencyUsed() public {
        vm.warp(start);

        uint256 bnbAmount = _bnbFor(1_000e18);
        uint256 bnbBefore = alice.balance;
        uint256 usdtBefore = usdt.balanceOf(alice);

        vm.startPrank(alice);
        presale.contribute{value: bnbAmount}(0, new bytes32[](0));
        presale.contributeToken(address(usdt), 1_000e18, 0, new bytes32[](0));
        vm.stopPrank();

        vm.warp(end);

        vm.prank(alice);
        presale.refund();

        assertEq(alice.balance, bnbBefore, "BNB returned");
        assertEq(usdt.balanceOf(alice), usdtBefore, "USDT returned");
    }

    function test_refund_revertsWhenSoftCapMet() public {
        _raiseAboveSoftCap();
        vm.warp(end);

        vm.prank(alice);
        vm.expectRevert(Presale.SoftCapMet.selector);
        presale.refund();
    }

    /// @dev The only path from escrow to the project, and it cannot succeed below the soft cap.
    function test_finalize_revertsBelowSoftCap() public {
        vm.warp(start);

        vm.prank(alice);
        presale.contribute{value: _bnbFor(1_000e18)}(0, new bytes32[](0));

        vm.warp(end);

        vm.prank(creator);
        vm.expectRevert();
        presale.finalize();
    }

    function test_finalize_deliversProceedsAndOpensClaims() public {
        _raiseAboveSoftCap();
        vm.warp(end);

        uint256 creatorBefore = creator.balance;

        vm.prank(creator);
        presale.finalize();

        assertTrue(presale.finalised());
        assertGt(creator.balance, creatorBefore, "proceeds delivered");

        vm.prank(alice);
        presale.claim();

        assertGt(token.balanceOf(alice), 0, "tokens claimable");
    }

    function test_claim_revertsBeforeFinalisation() public {
        _raiseAboveSoftCap();
        vm.warp(end);

        vm.prank(alice);
        vm.expectRevert(Presale.NotFinalised.selector);
        presale.claim();
    }

    function test_claim_onlyOnce() public {
        _raiseAboveSoftCap();
        vm.warp(end);

        vm.prank(creator);
        presale.finalize();

        vm.startPrank(alice);
        presale.claim();

        vm.expectRevert(Presale.AlreadyClaimed.selector);
        presale.claim();
        vm.stopPrank();
    }

    function test_claim_amountMatchesContribution() public {
        vm.warp(start);

        vm.prank(alice);
        presale.contribute{value: _bnbFor(5_000e18)}(0, new bytes32[](0));
        vm.prank(bob);
        presale.contribute{value: _bnbFor(5_000e18)}(0, new bytes32[](0));
        // A third contributor keeps the raise clear of the soft cap rather than exactly on it.
        vm.prank(carol);
        presale.contribute{value: _bnbFor(1_000e18)}(0, new bytes32[](0));

        vm.warp(end);
        vm.prank(creator);
        presale.finalize();

        vm.prank(alice);
        presale.claim();

        // $5,000 at 100 tokens per dollar.
        assertApproxEqRel(token.balanceOf(alice), 500_000e18, 0.001e18);
    }

    /// @dev Cancelling refunds everyone rather than releasing funds. It is an escape hatch for the
    ///      project, not a way out of its obligations.
    function test_cancel_makesEveryoneRefundable() public {
        _raiseAboveSoftCap();

        vm.prank(creator);
        presale.cancel();

        assertEq(uint256(presale.status()), uint256(Presale.Status.Failed));

        uint256 before = alice.balance;
        vm.prank(alice);
        presale.refund();

        assertGt(alice.balance, before);
    }

    /// @dev There must be no owner path to contributions before finalisation. This asserts the
    ///      absence: a bare transfer is rejected, and no admin withdrawal function exists.
    function test_ownerCannotTouchFundsBeforeFinalisation() public {
        _raiseAboveSoftCap();

        // A direct send has no contributor attached and would be unrefundable, so it reverts.
        vm.prank(creator);
        (bool ok,) = address(presale).call{value: 1 ether}("");
        assertFalse(ok, "bare transfers rejected");

        // Withdrawing a currency before finalisation is not possible.
        vm.prank(creator);
        vm.expectRevert(Presale.NotFinalised.selector);
        presale.withdrawCurrency(address(usdt));
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev However contributions are split, a failed sale returns every wei it took.
    function testFuzz_failedSaleRefundsEverything(uint96 rawA, uint96 rawB) public {
        vm.warp(start);

        // Bounded a dollar above the minimum so the helper's rounding cannot land under it.
        uint256 usdA = bound(uint256(rawA), MIN_CONTRIBUTION + 1e18, MAX_CONTRIBUTION);
        uint256 usdB = bound(uint256(rawB), MIN_CONTRIBUTION + 1e18, MAX_CONTRIBUTION);

        // Keep the total below the soft cap so the sale fails.
        vm.assume(usdA + usdB < SOFT_CAP);

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;

        vm.prank(alice);
        presale.contribute{value: _bnbFor(usdA)}(0, new bytes32[](0));
        vm.prank(bob);
        presale.contribute{value: _bnbFor(usdB)}(0, new bytes32[](0));

        vm.warp(end);

        vm.prank(alice);
        presale.refund();
        vm.prank(bob);
        presale.refund();

        assertEq(alice.balance, aliceBefore, "alice made whole");
        assertEq(bob.balance, bobBefore, "bob made whole");
        assertEq(address(presale).balance, 0, "nothing stranded");
    }

    /// @dev The raise can never exceed the hard cap, however contributions arrive.
    function testFuzz_hardCapIsNeverExceeded(uint96[8] calldata amounts) public {
        vm.warp(start);

        for (uint256 i; i < amounts.length; ++i) {
            uint256 usd = bound(uint256(amounts[i]), MIN_CONTRIBUTION + 1e18, MAX_CONTRIBUTION);
            address contributor = address(uint160(0x3000 + i));
            vm.deal(contributor, 1_000 ether);

            vm.prank(contributor);
            try presale.contribute{value: _bnbFor(usd)}(0, new bytes32[](0)) {} catch {}

            assertLe(presale.totalRaisedUsd(), HARD_CAP, "hard cap holds");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _raiseAboveSoftCap() internal {
        vm.warp(start);

        // Three wallets at $5,000 clears the $10,000 soft cap.
        vm.prank(alice);
        presale.contribute{value: _bnbFor(5_000e18)}(0, new bytes32[](0));
        vm.prank(bob);
        presale.contribute{value: _bnbFor(5_000e18)}(0, new bytes32[](0));
        vm.prank(carol);
        presale.contribute{value: _bnbFor(1_000e18)}(0, new bytes32[](0));
    }

    function _sort(bytes32[] memory values) internal pure {
        for (uint256 i = 1; i < values.length; ++i) {
            bytes32 key = values[i];
            uint256 j = i;
            while (j > 0 && values[j - 1] > key) {
                values[j] = values[j - 1];
                --j;
            }
            values[j] = key;
        }
    }

    function _indexOf(bytes32[] memory values, bytes32 target) internal pure returns (uint256) {
        for (uint256 i; i < values.length; ++i) {
            if (values[i] == target) return i;
        }
        revert("not found");
    }
}
