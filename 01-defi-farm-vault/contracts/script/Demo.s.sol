// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AutoCompoundVault} from "../src/AutoCompoundVault.sol";
import {MasterChef} from "../src/MasterChef.sol";
import {IAggregatorV3, PriceOracle} from "../src/PriceOracle.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {IMasterChef} from "../src/interfaces/IMasterChef.sol";
import {IPancakeRouter} from "../src/interfaces/IPancakeRouter.sol";
import {IRewardToken} from "../src/interfaces/IRewardToken.sol";
import {MockAggregator, MockERC20, MockPancakePair, MockPancakeRouter} from "../test/utils/Mocks.sol";

/// @title Demo
/// @notice Stands the whole stack up on a bare local chain and puts real state on it.
///
/// @dev The interesting parts of this project talk to PancakeSwap and Chainlink, and neither exists
///      on an empty anvil. Rather than require an archive node to fork BSC, this deploys the same
///      stand-ins the test suite uses: a constant-product router with PancakeSwap's 0.25% fee, an
///      LP pair, and an aggregator. The behaviour under test is the same; only the counterparty is
///      local. `test/ForkPancake.t.sol` is what covers the real router.
///
///      Local chains only. It mints tokens to accounts whose keys are the public Anvil mnemonic.
contract Demo is Script {
    address constant ALICE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant BOB = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address constant CAROL = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;

    // Anvil's default keys, in the same order. Public mnemonic, so these are worthless anywhere real.
    uint256 constant ALICE_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant BOB_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant CAROL_KEY = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    uint256 constant REWARD_PER_SECOND = 0.05 ether;

    struct Deployed {
        MockERC20 wbnb;
        MockERC20 busd;
        MockPancakePair lp;
        MockPancakePair lp2;
        MockPancakeRouter router;
        MockAggregator feed;
        RewardToken reward;
        MasterChef chef;
        PriceOracle oracle;
        AutoCompoundVault vault;
        address deployer;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        Deployed memory d;
        d.deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. The DeFi furniture this project integrates with.
        d.wbnb = new MockERC20("Wrapped BNB", "WBNB", 18);
        d.busd = new MockERC20("BUSD", "BUSD", 18);
        d.lp = new MockPancakePair(address(d.wbnb), address(d.busd));
        d.lp2 = new MockPancakePair(address(d.busd), address(d.wbnb));
        d.router = new MockPancakeRouter(d.lp);
        // 600 USD per BNB, eight decimals, which is what Chainlink feeds use.
        d.feed = new MockAggregator(8, 600e8, "BNB / USD");

        // 2. The project's own contracts.
        d.reward = new RewardToken("Farm Token", "FARM", 100_000_000 ether, 1_000_000 ether, d.deployer, d.deployer);
        d.chef = new MasterChef(
            IRewardToken(address(d.reward)), REWARD_PER_SECOND, block.timestamp - 7 days, d.deployer, d.deployer
        );
        d.reward.grantRole(d.reward.MINTER_ROLE(), address(d.chef));

        d.oracle = new PriceOracle(d.deployer);
        d.oracle.setFeed(address(d.wbnb), IAggregatorV3(address(d.feed)), 3_600);

        // 3. Two farms, so the pool list is a list. The second charges a deposit fee, which is the
        //    difference worth showing rather than two identical rows.
        uint256 pid = d.chef.add(IERC20(address(d.lp)), 4_000, 0, 0);
        d.chef.add(IERC20(address(d.lp2)), 1_000, 200, 12 hours);

        d.vault = new AutoCompoundVault(
            IERC20(address(d.lp)),
            IMasterChef(address(d.chef)),
            pid,
            IPancakeRouter(address(d.router)),
            IERC20(address(d.reward)),
            d.deployer,
            d.deployer
        );

        // 4. Liquidity for the router, so a compound has something to swap into.
        d.router.setReserves(address(d.reward), address(d.wbnb), 4_000_000 ether, 8_000 ether);
        d.router.setReserves(address(d.wbnb), address(d.busd), 8_000 ether, 4_800_000 ether);
        d.lp.setReserves(8_000 ether, 4_800_000 ether);

        _stake(d);

        vm.stopBroadcast();

        // Each farmer stakes under their own key. Doing it all from the deployer would leave every
        // position owned by one address, and a portfolio page has nothing to show for the wallet a
        // reviewer actually connects with.
        _stakeAs(d, ALICE_KEY, ALICE, 1_400 ether, 700 ether);
        _stakeAs(d, BOB_KEY, BOB, 820 ether, 0);
        _stakeAs(d, CAROL_KEY, CAROL, 310 ether, 0);

        _report(d);
    }

    /// Mint LP to everyone, and stake the deployer's own share.
    function _stake(Deployed memory d) internal {
        d.lp.mint(ALICE, 2_500 ether);
        d.lp.mint(BOB, 1_000 ether);
        d.lp.mint(CAROL, 500 ether);
        d.lp.mint(d.deployer, 2_600 ether);

        d.lp.approve(address(d.chef), type(uint256).max);
        d.chef.deposit(0, 1_800 ether);

        d.lp.approve(address(d.vault), type(uint256).max);
        d.vault.deposit(800 ether, d.deployer);
    }

    /// Stake into the farm, and optionally into the auto-compound vault, as `who`.
    function _stakeAs(Deployed memory d, uint256 key, address who, uint256 farmAmount, uint256 vaultAmount)
        internal
    {
        vm.startBroadcast(key);

        d.lp.approve(address(d.chef), type(uint256).max);
        d.chef.deposit(0, farmAmount);

        if (vaultAmount > 0) {
            d.lp.approve(address(d.vault), type(uint256).max);
            d.vault.deposit(vaultAmount, who);
        }

        vm.stopBroadcast();
    }

    function _report(Deployed memory d) internal view {
        console2.log("");
        console2.log("=== demo state ===");
        console2.log("RewardToken       ", address(d.reward));
        console2.log("MasterChef        ", address(d.chef));
        console2.log("PriceOracle       ", address(d.oracle));
        console2.log("AutoCompoundVault ", address(d.vault));
        console2.log("PancakeRouter     ", address(d.router));
        console2.log("LP token          ", address(d.lp));
        console2.log("LP token 2        ", address(d.lp2));
        console2.log("WBNB              ", address(d.wbnb));
        console2.log("deployBlock       ", block.number);
        console2.log("");
        console2.log("pools             ", d.chef.poolLength());
        console2.log("vault totalAssets ", d.vault.totalAssets());
        console2.log("bnb price (8dp)   ", d.oracle.getPrice(address(d.wbnb)));
    }
}
