// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAggregatorV3, PriceOracle} from "../src/PriceOracle.sol";
import {IPancakePair, IPancakeRouter} from "../src/interfaces/IPancakeRouter.sol";

/// @notice Tests against real BNB Smart Chain state, forked at the current block.
///
/// @dev Mocks prove the logic is self-consistent. They cannot prove the integration is right,
///      because a mock is written to the same assumptions as the contract it tests. These run
///      against the actual PancakeSwap router and the actual Chainlink feeds, which is where
///      wrong-address, wrong-decimals and wrong-interface bugs surface.
///
///      Skipped automatically when `BSC_RPC_URL` is not set, so `forge test` stays green offline.
///      Run them with:
///
///        BSC_RPC_URL=https://bsc-dataseed.binance.org forge test --match-contract ForkPancakeTest
contract ForkPancakeTest is Test {
    /// PancakeSwap V2 router, BNB Smart Chain mainnet.
    address internal constant PANCAKE_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;

    /// PancakeSwap V2 factory, BNB Smart Chain mainnet.
    address internal constant PANCAKE_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;

    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address internal constant CAKE = 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82;

    /// The canonical WBNB/BUSD pair.
    address internal constant WBNB_BUSD_PAIR = 0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16;

    /// Chainlink BNB/USD on BSC mainnet. Eight decimals, sixty second heartbeat.
    address internal constant CHAINLINK_BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    uint32 internal constant BNB_USD_HEARTBEAT = 60;

    address internal owner = makeAddr("owner");

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;
    }

    /// @dev Every test starts with this. Foundry has no native skip, so an early return keeps the
    ///      suite green offline while still running for real when an RPC is configured.
    modifier onlyForked() {
        if (!forked) {
            emit log("BSC_RPC_URL not set, skipping fork test");
            return;
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              PANCAKESWAP
    //////////////////////////////////////////////////////////////*/

    /// @dev Confirms the router address is right and its interface matches what the vault calls.
    ///      A wrong constant here is the single most common BSC integration bug.
    function test_routerIsReachable() public onlyForked {
        IPancakeRouter router = IPancakeRouter(PANCAKE_ROUTER);

        assertEq(router.WETH(), WBNB, "router's WETH is WBNB on BSC");
        assertEq(router.factory(), PANCAKE_FACTORY, "factory matches");
    }

    /// @dev Quotes a real swap through real liquidity. The mock router prices with the same formula,
    ///      but only this proves the formula matches PancakeSwap's actual fee.
    function test_getAmountsOutAgainstRealLiquidity() public onlyForked {
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = BUSD;

        uint256[] memory amounts = IPancakeRouter(PANCAKE_ROUTER).getAmountsOut(1e18, path);

        assertEq(amounts[0], 1e18);
        // One BNB is worth a few hundred dollars. A wide band keeps this from breaking on price
        // moves while still catching a decimals or path error, which would be orders of magnitude out.
        assertGt(amounts[1], 50e18, "BNB is worth more than $50");
        assertLt(amounts[1], 10_000e18, "BNB is worth less than $10,000");
    }

    /// @dev Reads a real pair. The vault caches token0 and token1 at deployment, so their ordering
    ///      has to be what the pair actually reports.
    function test_pairOrderingMatchesTheVaultAssumption() public onlyForked {
        IPancakePair pair = IPancakePair(WBNB_BUSD_PAIR);

        address token0 = pair.token0();
        address token1 = pair.token1();

        assertTrue(
            (token0 == WBNB && token1 == BUSD) || (token0 == BUSD && token1 == WBNB),
            "pair holds the expected two tokens"
        );
        // Uniswap-style pairs sort their tokens by address, and code that reads token0/token1 relies
        // on that ordering being stable. Cast to uint256 because forge-std has no address overload.
        assertLt(uint256(uint160(token0)), uint256(uint160(token1)), "tokens are address-sorted");

        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertGt(uint256(reserve0), 0, "pair has liquidity");
        assertGt(uint256(reserve1), 0, "pair has liquidity");
    }

    /*//////////////////////////////////////////////////////////////
                               CHAINLINK
    //////////////////////////////////////////////////////////////*/

    /// @dev The real feed, through the real oracle. Proves the address, the decimals handling and
    ///      the staleness window are all correct against production data rather than a mock that
    ///      was written to agree with the contract.
    function test_chainlinkBnbUsdFeed() public onlyForked {
        PriceOracle oracle = new PriceOracle(owner);

        vm.prank(owner);
        oracle.setFeed(WBNB, IAggregatorV3(CHAINLINK_BNB_USD), BNB_USD_HEARTBEAT);

        uint256 price = oracle.getPrice(WBNB);

        // Normalised to 18 decimals from the feed's 8.
        assertGt(price, 50e18, "BNB above $50");
        assertLt(price, 10_000e18, "BNB below $10,000");

        // A live feed should be well inside its heartbeat.
        assertLt(oracle.priceAge(WBNB), BNB_USD_HEARTBEAT + oracle.gracePeriod(), "feed is fresh");
    }

    /// @dev The oracle's decimal normalisation must match what the real aggregator reports, not what
    ///      the mock was told to report.
    function test_chainlinkFeedDecimals() public onlyForked {
        assertEq(
            uint256(IAggregatorV3(CHAINLINK_BNB_USD).decimals()), uint256(8), "BNB/USD is an 8 decimal feed"
        );
    }

    /// @dev Cross-checks the oracle against the AMM. They are independent sources, so agreement
    ///      within a wide band means neither is badly wrong. A large divergence would mean a wrong
    ///      feed address, a wrong pair, or a decimals bug.
    function test_oracleAndAmmAgreeOnBnbPrice() public onlyForked {
        PriceOracle oracle = new PriceOracle(owner);

        vm.prank(owner);
        oracle.setFeed(WBNB, IAggregatorV3(CHAINLINK_BNB_USD), BNB_USD_HEARTBEAT);

        uint256 oraclePrice = oracle.getPrice(WBNB);

        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = BUSD;
        uint256 ammPrice = IPancakeRouter(PANCAKE_ROUTER).getAmountsOut(1e18, path)[1];

        // Ten percent band. BUSD is not exactly a dollar, the AMM quote includes a fee and some
        // price impact, and the feed updates on its own schedule.
        assertApproxEqRel(ammPrice, oraclePrice, 0.10e18, "oracle and AMM broadly agree");
    }

    /*//////////////////////////////////////////////////////////////
                            TOKEN BEHAVIOUR
    //////////////////////////////////////////////////////////////*/

    /// @dev CAKE is the reward token in most real BSC farms, so the vault's assumptions about it
    ///      are worth checking against the deployed contract.
    function test_cakeIsAStandardEighteenDecimalToken() public onlyForked {
        assertEq(uint256(IERC20Metadata(CAKE).decimals()), uint256(18));
        assertGt(IERC20(CAKE).totalSupply(), 0);
    }
}

/// @dev Local declaration so the fork test does not need an extra import for one function.
interface IERC20Metadata {
    function decimals() external view returns (uint8);
}
