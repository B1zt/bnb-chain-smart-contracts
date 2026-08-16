// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ChainlinkPriceFeed, IAggregatorV3} from "../src/ChainlinkPriceFeed.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";
import {PresaleFactory} from "../src/PresaleFactory.sol";
import {TokenBridge} from "../src/TokenBridge.sol";

/// @notice Deploys the launchpad, liquidity locker and bridge.
///
/// @dev Chain-aware, so the correct Chainlink feed is wired automatically. Deploy the bridge on
///      **both** chains, then call `configureChain` on each pointing at the other. That step cannot
///      be scripted from one side, because neither address exists until the other side is deployed.
contract Deploy is Script {
    uint256 internal constant BSC_MAINNET = 56;
    uint256 internal constant BSC_TESTNET = 97;
    uint256 internal constant ETH_MAINNET = 1;

    /// @dev Launchpad listing fee, in native BNB. A spam deterrent, not a revenue model.
    uint256 internal constant CREATION_FEE = 0.1 ether;

    /// @dev Launchpad cut of a successful raise: 2%.
    uint16 internal constant PROTOCOL_FEE_BPS = 200;

    struct ChainConfig {
        address nativeUsdFeed;
        uint32 nativeHeartbeat;
        address stablecoin;
        address stablecoinUsdFeed;
        uint32 stablecoinHeartbeat;
        string name;
    }

    function _chainConfig() internal view returns (ChainConfig memory) {
        if (block.chainid == BSC_MAINNET) {
            return ChainConfig({
                nativeUsdFeed: 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE, // BNB/USD
                nativeHeartbeat: 60,
                stablecoin: 0x55d398326f99059fF775485246999027B3197955, // USDT on BSC, 18 decimals
                stablecoinUsdFeed: 0xB97Ad0E74fa7d920791E90258A6E2085088b4320, // USDT/USD
                stablecoinHeartbeat: 86_400,
                name: "BSC mainnet"
            });
        }

        if (block.chainid == BSC_TESTNET) {
            return ChainConfig({
                nativeUsdFeed: 0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526, // BNB/USD
                nativeHeartbeat: 180,
                stablecoin: address(0),
                stablecoinUsdFeed: address(0),
                stablecoinHeartbeat: 0,
                name: "BSC testnet"
            });
        }

        if (block.chainid == ETH_MAINNET) {
            return ChainConfig({
                nativeUsdFeed: 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419, // ETH/USD
                nativeHeartbeat: 3_600,
                stablecoin: 0xdAC17F958D2ee523a2206206994597C13D831ec7, // USDT, 6 decimals
                stablecoinUsdFeed: 0x3E7d1eAB13ad0104d2750B8863b489D65364e32D, // USDT/USD
                stablecoinHeartbeat: 86_400,
                name: "Ethereum mainnet"
            });
        }

        // Local or unknown. Feeds come from the environment so the script still runs.
        return ChainConfig({
            nativeUsdFeed: vm.envOr("NATIVE_USD_FEED", address(0)),
            nativeHeartbeat: uint32(vm.envOr("NATIVE_HEARTBEAT", uint256(3_600))),
            stablecoin: vm.envOr("STABLECOIN", address(0)),
            stablecoinUsdFeed: vm.envOr("STABLECOIN_USD_FEED", address(0)),
            stablecoinHeartbeat: uint32(vm.envOr("STABLECOIN_HEARTBEAT", uint256(86_400))),
            name: "local"
        });
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envOr("OWNER", deployer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);

        ChainConfig memory config = _chainConfig();

        // Bridge validators, comma separated. Empty means the bridge is skipped, which is the right
        // default: a bridge with one validator is not a bridge, it is a custodian.
        address[] memory validators = vm.envOr("BRIDGE_VALIDATORS", ",", new address[](0));

        vm.startBroadcast(deployerKey);

        ChainlinkPriceFeed priceFeed = new ChainlinkPriceFeed(deployer);

        if (config.nativeUsdFeed != address(0)) {
            priceFeed.setNativeFeed(IAggregatorV3(config.nativeUsdFeed), config.nativeHeartbeat);
        }
        if (config.stablecoin != address(0) && config.stablecoinUsdFeed != address(0)) {
            priceFeed.setTokenFeed(
                config.stablecoin,
                IAggregatorV3(config.stablecoinUsdFeed),
                config.stablecoinHeartbeat
            );
        }

        PresaleFactory factory =
            new PresaleFactory(owner, feeRecipient, CREATION_FEE, PROTOCOL_FEE_BPS);

        LiquidityLocker locker = new LiquidityLocker();

        address bridge;
        if (validators.length >= 3) {
            // Strict majority: three of five, two of three, and so on.
            uint8 threshold = uint8(validators.length / 2 + 1);
            bridge = address(new TokenBridge(owner, validators, threshold));
        }

        if (owner != deployer) {
            priceFeed.transferOwnership(owner);
        }

        vm.stopBroadcast();

        _report(config, address(priceFeed), address(factory), address(locker), bridge, validators.length);
    }

    function _report(
        ChainConfig memory config,
        address priceFeed,
        address factory,
        address locker,
        address bridge,
        uint256 validatorCount
    ) internal view {
        console.log("");
        console.log("=== Deployed to %s (chainId %s) ===", config.name, vm.toString(block.chainid));
        console.log("ChainlinkPriceFeed", priceFeed);
        console.log("PresaleFactory    ", factory);
        console.log("LiquidityLocker   ", locker);
        console.log("TokenBridge       ", bridge);
        console.log("deployBlock       ", block.number);

        console.log("");
        console.log("--- backend/.env ---");
        console.log("CHAIN_ID=%s", vm.toString(block.chainid));
        console.log("PRICE_FEED_ADDRESS=%s", vm.toString(priceFeed));
        console.log("FACTORY_ADDRESS=%s", vm.toString(factory));
        console.log("LOCKER_ADDRESS=%s", vm.toString(locker));
        console.log("BRIDGE_ADDRESS=%s", vm.toString(bridge));
        console.log("DEPLOY_BLOCK=%s", vm.toString(block.number));

        if (bridge == address(0)) {
            console.log("");
            console.log("Bridge skipped: BRIDGE_VALIDATORS needs at least 3 addresses.");
            console.log("A bridge with one validator is a custodian, not a bridge.");
        } else {
            console.log("");
            console.log("Bridge deployed with %s validators.", vm.toString(validatorCount));
            console.log("Next: deploy on the other chain, then call configureChain on BOTH sides");
            console.log("      pointing at each other. Neither address exists until both are live.");
        }
    }
}
