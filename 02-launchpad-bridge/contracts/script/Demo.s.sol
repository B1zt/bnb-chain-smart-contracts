// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";
import {Presale} from "../src/Presale.sol";
import {PresaleFactory} from "../src/PresaleFactory.sol";
import {TokenBridge} from "../src/TokenBridge.sol";
import {IPriceFeed} from "../src/interfaces/IPriceFeed.sol";
import {MockERC20, MockPriceFeed} from "../test/utils/Mocks.sol";

/// @title Demo
/// @notice Stands the whole launchpad up on a bare local chain and puts real state on it.
///
/// @dev A launchpad with no sales, a locker with no locks and a bridge with no transfers all render
///      as empty pages, which tells a reviewer nothing. This deploys the stack, creates three sales
///      in different states, locks liquidity and leaves the bridge configured with five validators.
///
///      Local chains only: it uses the public Anvil mnemonic for every account.
contract Demo is Script {
    address constant ALICE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant BOB = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    uint256 constant ALICE_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant BOB_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    /// Anvil accounts 5 through 9, used as the bridge validator set.
    address constant V1 = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;
    address constant V2 = 0x976EA74026E726554dB657fA54763abd0C3a0aa9;
    address constant V3 = 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955;
    address constant V4 = 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f;
    address constant V5 = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;

    uint256 constant USD = 1e18;

    struct Deployed {
        MockERC20 saleToken;
        MockERC20 usdt;
        MockERC20 lpToken;
        MockPriceFeed priceFeed;
        PresaleFactory factory;
        LiquidityLocker locker;
        TokenBridge bridge;
        address live;
        address upcoming;
        address failed;
        address deployer;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        Deployed memory d;
        d.deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        d.saleToken = new MockERC20("Demo Project", "DEMO", 18);
        d.usdt = new MockERC20("Tether USD", "USDT", 6);
        d.lpToken = new MockERC20("DEMO-BNB LP", "DEMO-LP", 18);

        // The same price feed stand-in the test suite uses: 600 USD per BNB, a stablecoin at a
        // dollar. ChainlinkPriceFeed is what runs in production and its staleness and decimal
        // handling are covered by its own unit tests; wiring real aggregators here would need a
        // fork, and this script exists so the stack runs offline.
        d.priceFeed = new MockPriceFeed();
        d.priceFeed.setNativePrice(600 ether);
        d.priceFeed.setTokenPrice(address(d.usdt), 1e30);

        d.factory = new PresaleFactory(d.deployer, d.deployer, 0.1 ether, 200);
        d.locker = new LiquidityLocker();

        address[] memory validators = new address[](5);
        (validators[0], validators[1], validators[2], validators[3], validators[4]) =
            (V1, V2, V3, V4, V5);
        d.bridge = new TokenBridge(d.deployer, validators, 3);

        _createSales(d);
        _lockLiquidity(d);

        vm.stopBroadcast();

        _contribute(d);
        _report(d);
    }

    function _createSales(Deployed memory d) internal {
        address[] memory stablecoins = new address[](1);
        stablecoins[0] = address(d.usdt);

        // Enough supply to fund all three hard caps, plus spare for the locker.
        // Enough to fund every hard cap: 300M + 320M + 150M, with room to spare.
        d.saleToken.mint(d.deployer, 1_000_000_000 ether);
        d.saleToken.approve(address(d.factory), type(uint256).max);

        uint64 nowTs = uint64(block.timestamp);

        // Live: open now, half way to its hard cap once the contributions below land.
        d.live = d.factory.createPresale{value: 0.1 ether}(
            Presale.SaleConfig({
                token: address(d.saleToken),
                tokensPerUsd: 2_500 ether,
                softCapUsd: 40_000 * USD,
                hardCapUsd: 120_000 * USD,
                minContributionUsd: 50 * USD,
                maxContributionUsd: 5_000 * USD,
                startTime: nowTs - 2 days,
                endTime: nowTs + 5 days,
                tierRoot: bytes32(0),
                contributionCooldown: 0
            }),
            stablecoins,
            IPriceFeed(address(d.priceFeed))
        );

        // Upcoming, and gated by a tier root, so the UI has a sale that is not open to everyone.
        d.upcoming = d.factory.createPresale{value: 0.1 ether}(
            Presale.SaleConfig({
                token: address(d.saleToken),
                tokensPerUsd: 4_000 ether,
                softCapUsd: 25_000 * USD,
                hardCapUsd: 80_000 * USD,
                minContributionUsd: 100 * USD,
                maxContributionUsd: 2_500 * USD,
                startTime: nowTs + 3 days,
                endTime: nowTs + 10 days,
                tierRoot: keccak256("demo-tier-root"),
                contributionCooldown: 60
            }),
            stablecoins,
            IPriceFeed(address(d.priceFeed))
        );

        // A sale that will close under its soft cap. It has to still be open here so a contribution
        // can land in it; the caller advances the chain past `endTime` afterwards, which is what
        // makes it FAILED. That is the case worth showing, because refunds are unconditional and
        // there is no admin path to the escrowed funds.
        d.failed = d.factory.createPresale{value: 0.1 ether}(
            Presale.SaleConfig({
                token: address(d.saleToken),
                tokensPerUsd: 1_000 ether,
                softCapUsd: 90_000 * USD,
                hardCapUsd: 150_000 * USD,
                minContributionUsd: 50 * USD,
                maxContributionUsd: 10_000 * USD,
                startTime: nowTs - 21 days,
                endTime: nowTs + 5 minutes,
                tierRoot: bytes32(0),
                contributionCooldown: 0
            }),
            stablecoins,
            IPriceFeed(address(d.priceFeed))
        );
    }

    function _lockLiquidity(Deployed memory d) internal {
        d.lpToken.mint(d.deployer, 100_000 ether);
        d.lpToken.approve(address(d.locker), type(uint256).max);

        d.locker.lock(address(d.lpToken), 40_000 ether, uint64(block.timestamp + 365 days), "Launch liquidity, 12 months");
        d.locker.lock(address(d.lpToken), 15_000 ether, uint64(block.timestamp + 90 days), "Market making, 3 months");
        d.locker.lock(address(d.lpToken), 5_000 ether, uint64(block.timestamp + 7 days), "Short term, 1 week");
    }

    /// Contributions come from their own accounts, so the sale has more than one participant.
    function _contribute(Deployed memory d) internal {
        // 20 BNB at 600 USD is 12,000 USD, comfortably inside the 5,000 per-wallet cap once split.
        _contributeAs(d.live, ALICE_KEY, 6 ether);
        _contributeAs(d.live, BOB_KEY, 4 ether);
        _contributeAs(d.failed, ALICE_KEY, 2 ether);
    }

    function _contributeAs(address sale, uint256 key, uint256 value) internal {
        vm.startBroadcast(key);
        Presale(payable(sale)).contribute{value: value}(0, new bytes32[](0));
        vm.stopBroadcast();
    }

    function _report(Deployed memory d) internal view {
        console2.log("");
        console2.log("=== demo state ===");
        console2.log("PresaleFactory    ", address(d.factory));
        console2.log("LiquidityLocker   ", address(d.locker));
        console2.log("TokenBridge       ", address(d.bridge));
        console2.log("PriceFeed         ", address(d.priceFeed));
        console2.log("sale token        ", address(d.saleToken));
        console2.log("USDT              ", address(d.usdt));
        console2.log("LP token          ", address(d.lpToken));
        console2.log("");
        console2.log("presale live      ", d.live);
        console2.log("presale upcoming  ", d.upcoming);
        console2.log("presale failed    ", d.failed);
        console2.log("deployBlock       ", block.number);
    }
}
