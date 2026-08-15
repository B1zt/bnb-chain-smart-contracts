// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AutoCompoundVault} from "../src/AutoCompoundVault.sol";
import {MasterChef} from "../src/MasterChef.sol";
import {IAggregatorV3, PriceOracle} from "../src/PriceOracle.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {IMasterChef} from "../src/interfaces/IMasterChef.sol";
import {IPancakeRouter} from "../src/interfaces/IPancakeRouter.sol";
import {IRewardToken} from "../src/interfaces/IRewardToken.sol";

/// @notice Deploys the farm, oracle and auto-compounding vault to BNB Smart Chain.
///
/// @dev Chain-aware: it picks the right PancakeSwap router and Chainlink feed for mainnet, testnet
///      or opBNB rather than requiring the operator to remember six addresses. Getting one of these
///      wrong is the most common BSC deployment mistake, and the fork tests in
///      `test/ForkPancake.t.sol` verify the mainnet constants against the live chain.
///
///      Usage:
///
///        PRIVATE_KEY=0x... forge script script/Deploy.s.sol:Deploy \
///          --rpc-url $BSC_TESTNET_RPC_URL --broadcast --verify
contract Deploy is Script {
    uint256 internal constant CAP = 100_000_000e18;
    uint256 internal constant INITIAL_SUPPLY = 0;

    /// @dev One token per second, roughly 2.6M per month.
    uint256 internal constant REWARD_PER_SECOND = 1e18;

    /*//////////////////////////////////////////////////////////////
                          CHAIN CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant BSC_MAINNET = 56;
    uint256 internal constant BSC_TESTNET = 97;
    uint256 internal constant OPBNB_MAINNET = 204;

    struct ChainConfig {
        address router;
        address wrappedNative;
        address nativeUsdFeed;
        uint32 feedHeartbeat;
        string name;
    }

    function _chainConfig() internal view returns (ChainConfig memory config) {
        if (block.chainid == BSC_MAINNET) {
            return ChainConfig({
                router: 0x10ED43C718714eb63d5aA57B78B54704E256024E,
                wrappedNative: 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c,
                nativeUsdFeed: 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE,
                feedHeartbeat: 60,
                name: "BSC mainnet"
            });
        }

        if (block.chainid == BSC_TESTNET) {
            return ChainConfig({
                router: 0xD99D1c33F9fC3444f8101754aBC46c52416550D1,
                wrappedNative: 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd,
                nativeUsdFeed: 0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526,
                feedHeartbeat: 180,
                name: "BSC testnet"
            });
        }

        if (block.chainid == OPBNB_MAINNET) {
            return ChainConfig({
                router: address(0),
                wrappedNative: 0x4200000000000000000000000000000000000006,
                // opBNB has no Chainlink BNB/USD feed at the time of writing, so the oracle is
                // deployed without one and the vault runs without USD pricing.
                nativeUsdFeed: address(0),
                feedHeartbeat: 0,
                name: "opBNB"
            });
        }

        // Anvil or an unknown chain. Addresses come from the environment so the script still runs.
        return ChainConfig({
            router: vm.envOr("PANCAKE_ROUTER", address(0)),
            wrappedNative: vm.envOr("WRAPPED_NATIVE", address(0)),
            nativeUsdFeed: vm.envOr("NATIVE_USD_FEED", address(0)),
            feedHeartbeat: uint32(vm.envOr("FEED_HEARTBEAT", uint256(3_600))),
            name: "local"
        });
    }

    /*//////////////////////////////////////////////////////////////
                                 RUN
    //////////////////////////////////////////////////////////////*/

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envOr("OWNER", deployer);
        address treasury = vm.envOr("TREASURY", deployer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", treasury);

        ChainConfig memory config = _chainConfig();

        // The LP token to farm. On a real deployment this is an existing PancakeSwap pair.
        address lpToken = vm.envOr("LP_TOKEN", address(0));

        vm.startBroadcast(deployerKey);

        RewardToken reward =
            new RewardToken("Farm Token", "FARM", CAP, INITIAL_SUPPLY, treasury, deployer);

        MasterChef chef = new MasterChef(
            IRewardToken(address(reward)), REWARD_PER_SECOND, block.timestamp, feeRecipient, owner
        );

        // The farm must be able to mint emissions.
        reward.grantRole(reward.MINTER_ROLE(), address(chef));

        PriceOracle oracle = new PriceOracle(deployer);
        if (config.nativeUsdFeed != address(0)) {
            oracle.setFeed(
                config.wrappedNative, IAggregatorV3(config.nativeUsdFeed), config.feedHeartbeat
            );
        }

        address vault;
        if (lpToken != address(0) && config.router != address(0)) {
            uint256 pid = chef.add(IERC20(lpToken), 1_000, 0, 0);

            vault = address(
                new AutoCompoundVault(
                    IERC20(lpToken),
                    IMasterChef(address(chef)),
                    pid,
                    IPancakeRouter(config.router),
                    IERC20(address(reward)),
                    feeRecipient,
                    owner
                )
            );
        }

        // Hand over the token and oracle, then step back. Leaving the deployer as minter would let
        // an EOA inflate the reward token without limit, which is exactly the shape of a rug.
        if (owner != deployer) {
            reward.grantRole(reward.DEFAULT_ADMIN_ROLE(), owner);
            reward.renounceRole(reward.DEFAULT_ADMIN_ROLE(), deployer);

            oracle.transferOwnership(owner);
        }

        vm.stopBroadcast();

        _report(config, address(reward), address(chef), address(oracle), vault, deployer, owner);
    }

    function _report(
        ChainConfig memory config,
        address reward,
        address chef,
        address oracle,
        address vault,
        address deployer,
        address owner
    ) internal view {
        console.log("");
        console.log("=== Deployed to %s (chainId %s) ===", config.name, vm.toString(block.chainid));
        console.log("RewardToken       ", reward);
        console.log("MasterChef        ", chef);
        console.log("PriceOracle       ", oracle);
        console.log("AutoCompoundVault ", vault);
        console.log("PancakeSwap router", config.router);
        console.log("deployBlock       ", block.number);

        console.log("");
        console.log("--- backend/.env ---");
        console.log("CHAIN_ID=%s", vm.toString(block.chainid));
        console.log("REWARD_TOKEN_ADDRESS=%s", vm.toString(reward));
        console.log("MASTERCHEF_ADDRESS=%s", vm.toString(chef));
        console.log("ORACLE_ADDRESS=%s", vm.toString(oracle));
        console.log("VAULT_ADDRESS=%s", vm.toString(vault));
        console.log("ROUTER_ADDRESS=%s", vm.toString(config.router));
        console.log("DEPLOY_BLOCK=%s", vm.toString(block.number));

        if (vault == address(0)) {
            console.log("");
            console.log("No vault deployed: set LP_TOKEN to a PancakeSwap pair and re-run.");
        }

        if (owner == deployer) {
            console.log("");
            console.log("WARNING: owner is the deployer EOA.");
            console.log("Set OWNER to a multisig before any mainnet deployment.");
        }
    }
}
