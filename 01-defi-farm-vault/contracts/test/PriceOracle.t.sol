// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAggregatorV3, PriceOracle} from "../src/PriceOracle.sol";
import {MockAggregator, MockERC20, RevertingAggregator} from "./utils/Mocks.sol";

contract PriceOracleTest is Test {
    PriceOracle internal oracle;
    MockAggregator internal bnbFeed;
    MockERC20 internal wbnb;

    address internal owner = makeAddr("owner");

    /// @dev The BNB/USD feed on BSC has an 8 decimal answer and a 60 second heartbeat.
    uint8 internal constant FEED_DECIMALS = 8;
    uint32 internal constant HEARTBEAT = 60;
    int256 internal constant BNB_PRICE = 600e8; // $600

    function setUp() public {
        vm.warp(1_800_000_000);

        oracle = new PriceOracle(owner);
        wbnb = new MockERC20("Wrapped BNB", "WBNB", 18);
        bnbFeed = new MockAggregator(FEED_DECIMALS, BNB_PRICE, "BNB / USD");

        vm.prank(owner);
        oracle.setFeed(address(wbnb), IAggregatorV3(address(bnbFeed)), HEARTBEAT);
    }

    /*//////////////////////////////////////////////////////////////
                              HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    /// @dev An 8 decimal feed answer must come back at 18 decimals. A fixed assumption about feed
    ///      decimals breaks the moment a second feed with different precision is added.
    function test_getPrice_normalisesTo18Decimals() public view {
        assertEq(oracle.getPrice(address(wbnb)), 600e18);
    }

    function test_getValue() public view {
        // 2.5 BNB at $600 is $1,500.
        assertEq(oracle.getValue(address(wbnb), 2.5e18, 18), 1_500e18);
    }

    function test_getValue_handlesNonEighteenDecimalTokens() public {
        MockERC20 usdc = new MockERC20("USDC", "USDC", 6);
        MockAggregator usdcFeed = new MockAggregator(8, 1e8, "USDC / USD");

        vm.prank(owner);
        oracle.setFeed(address(usdc), IAggregatorV3(address(usdcFeed)), HEARTBEAT);

        // 1,000 USDC at 6 decimals is $1,000.
        assertEq(oracle.getValue(address(usdc), 1_000e6, 6), 1_000e18);
    }

    function test_tryGetPrice_succeeds() public view {
        (bool ok, uint256 price) = oracle.tryGetPrice(address(wbnb));
        assertTrue(ok);
        assertEq(price, 600e18);
    }

    /*//////////////////////////////////////////////////////////////
                            STALENESS
    //////////////////////////////////////////////////////////////*/

    /// @dev The core reason this contract exists. A Chainlink feed that stops updating keeps
    ///      returning its last answer forever with no error, and a protocol that trusts it will
    ///      price assets at yesterday's number.
    function test_getPrice_revertsWhenStale() public {
        uint256 lastUpdate = block.timestamp;

        // Past the heartbeat plus the grace period.
        vm.warp(block.timestamp + HEARTBEAT + oracle.gracePeriod() + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                PriceOracle.StalePrice.selector,
                address(wbnb),
                lastUpdate,
                uint256(HEARTBEAT) + oracle.gracePeriod()
            )
        );
        oracle.getPrice(address(wbnb));
    }

    /// @dev Chainlink heartbeats are targets, not guarantees. Without a grace period the oracle
    ///      would reject perfectly good prices during ordinary congestion.
    function test_gracePeriodAllowsSmallDelays() public {
        vm.warp(block.timestamp + HEARTBEAT + 10 minutes);

        // Inside the 30 minute grace period, so still accepted.
        assertEq(oracle.getPrice(address(wbnb)), 600e18);
    }

    function test_tryGetPrice_reportsStalenessInsteadOfReverting() public {
        vm.warp(block.timestamp + HEARTBEAT + oracle.gracePeriod() + 1);

        (bool ok, uint256 price) = oracle.tryGetPrice(address(wbnb));
        assertFalse(ok, "reports failure");
        assertEq(price, 0);
    }

    function test_priceAge() public {
        assertEq(oracle.priceAge(address(wbnb)), 0);

        vm.warp(block.timestamp + 45);
        assertEq(oracle.priceAge(address(wbnb)), 45);
    }

    /*//////////////////////////////////////////////////////////////
                            BAD ROUND DATA
    //////////////////////////////////////////////////////////////*/

    function test_getPrice_revertsOnZeroAnswer() public {
        bnbFeed.setAnswer(0);

        vm.expectRevert(abi.encodeWithSelector(PriceOracle.InvalidPrice.selector, address(wbnb), int256(0)));
        oracle.getPrice(address(wbnb));
    }

    function test_getPrice_revertsOnNegativeAnswer() public {
        bnbFeed.setAnswer(-1);

        vm.expectRevert(abi.encodeWithSelector(PriceOracle.InvalidPrice.selector, address(wbnb), int256(-1)));
        oracle.getPrice(address(wbnb));
    }

    /// @dev `updatedAt == 0` marks a round that never completed.
    function test_getPrice_revertsOnIncompleteRound() public {
        bnbFeed.setIncompleteRound();

        vm.expectRevert(abi.encodeWithSelector(PriceOracle.IncompleteRound.selector, address(wbnb)));
        oracle.getPrice(address(wbnb));
    }

    /// @dev `answeredInRound < roundId` means the answer was carried over from an earlier round
    ///      rather than freshly computed for this one.
    function test_getPrice_revertsOnCarriedOverAnswer() public {
        bnbFeed.setStaleRound();

        vm.expectRevert(abi.encodeWithSelector(PriceOracle.IncompleteRound.selector, address(wbnb)));
        oracle.getPrice(address(wbnb));
    }

    /// @dev A feed whose call reverts must not take the caller down with it when using tryGetPrice.
    function test_tryGetPrice_survivesARevertingFeed() public {
        MockERC20 token = new MockERC20("X", "X", 18);
        RevertingAggregator broken = new RevertingAggregator();

        vm.prank(owner);
        oracle.setFeed(address(token), IAggregatorV3(address(broken)), HEARTBEAT);

        (bool ok, uint256 price) = oracle.tryGetPrice(address(token));
        assertFalse(ok);
        assertEq(price, 0);
    }

    /*//////////////////////////////////////////////////////////////
                            CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    function test_getPrice_revertsWhenUnconfigured() public {
        MockERC20 unknown = new MockERC20("Unknown", "UNK", 18);

        vm.expectRevert(abi.encodeWithSelector(PriceOracle.FeedNotConfigured.selector, address(unknown)));
        oracle.getPrice(address(unknown));
    }

    function test_setFeed_onlyOwner() public {
        vm.prank(makeAddr("mallory"));
        vm.expectRevert();
        oracle.setFeed(address(wbnb), IAggregatorV3(address(bnbFeed)), HEARTBEAT);
    }

    /// @dev A feed allowed to be a week stale is not an oracle.
    function test_setFeed_capsHeartbeat() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.HeartbeatTooLong.selector, uint32(3 days)));
        oracle.setFeed(address(wbnb), IAggregatorV3(address(bnbFeed)), 3 days);
    }

    function test_setFeed_rejectsZeroHeartbeat() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.HeartbeatTooLong.selector, uint32(0)));
        oracle.setFeed(address(wbnb), IAggregatorV3(address(bnbFeed)), 0);
    }

    function test_removeFeed() public {
        vm.prank(owner);
        oracle.removeFeed(address(wbnb));

        vm.expectRevert(abi.encodeWithSelector(PriceOracle.FeedNotConfigured.selector, address(wbnb)));
        oracle.getPrice(address(wbnb));
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev Normalisation is exact for any positive answer a feed can report.
    function testFuzz_normalisationIsExact(uint128 rawAnswer) public {
        int256 answer = int256(uint256(bound(rawAnswer, 1, type(uint128).max)));
        bnbFeed.setAnswer(answer);

        // 8 decimals in, 18 out, so exactly 1e10 larger.
        assertEq(oracle.getPrice(address(wbnb)), uint256(answer) * 1e10);
    }

    /// @dev Any read older than the heartbeat plus grace is rejected; anything newer is accepted.
    function testFuzz_stalenessBoundaryIsExact(uint32 age) public {
        uint256 maxAge = uint256(HEARTBEAT) + oracle.gracePeriod();
        uint256 elapsed = bound(age, 0, maxAge * 3);

        vm.warp(block.timestamp + elapsed);

        (bool ok,) = oracle.tryGetPrice(address(wbnb));
        assertEq(ok, elapsed <= maxAge, "accepted exactly when within the window");
    }
}
