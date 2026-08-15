// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAggregatorV3} from "../../src/PriceOracle.sol";

/// @notice Plain ERC-20 with open minting.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice ERC-20 that burns a percentage of every transfer.
/// @dev BNB Chain is full of these. The farm must credit what actually arrived rather than what was
///      requested, otherwise the pool promises more than it holds and the last withdrawer is short.
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("Taxed", "TAX") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);

        if (fee > 0) {
            super._update(from, address(0xdead), fee);
        }
    }
}

/// @notice Minimal constant-product pair, enough for the vault to treat it as an LP token.
contract MockPancakePair is ERC20 {
    address public immutable token0;
    address public immutable token1;

    uint112 private _reserve0;
    uint112 private _reserve1;

    constructor(address token0_, address token1_) ERC20("Mock LP", "MLP") {
        // Uniswap-style pairs order their tokens, and code that reads token0/token1 relies on it.
        (token0, token1) = token0_ < token1_ ? (token0_, token1_) : (token1_, token0_);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_reserve0, _reserve1, uint32(block.timestamp));
    }

    function setReserves(uint112 reserve0_, uint112 reserve1_) external {
        _reserve0 = reserve0_;
        _reserve1 = reserve1_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @notice Constant-product router good enough to exercise the auto-compounding path.
///
/// @dev Not a faithful PancakeSwap clone. It implements exactly the four functions the vault calls,
///      with real constant-product pricing and a 0.25% fee, so slippage bounds and swap accounting
///      are genuinely tested rather than mocked away. The fork test in `ForkPancake.t.sol` covers
///      behaviour against the real router.
contract MockPancakeRouter {
    using SafeERC20 for IERC20;

    /// @dev Reserves per (tokenIn, tokenOut) direction, set by the test harness.
    mapping(address => mapping(address => uint256)) public reserves;

    MockPancakePair public immutable pair;

    /// @dev LP minted per unit of token0 added, so tests can assert on a predictable amount.
    uint256 public constant LP_PER_TOKEN0 = 1;

    /// @notice Output reduction applied at execution time only, never to `getAmountsOut`.
    ///
    /// @dev Models a sandwich: the victim quotes a price, an attacker moves the pool in between,
    ///      and the victim's trade executes worse than quoted. Without this the mock's quote and
    ///      execution agree exactly, and a slippage test would pass no matter what the contract did.
    uint256 public sandwichBps;

    constructor(MockPancakePair pair_) {
        pair = pair_;
    }

    function setReserves(address tokenA, address tokenB, uint256 reserveA, uint256 reserveB) external {
        reserves[tokenA][tokenB] = reserveA;
        reserves[tokenB][tokenA] = reserveB;
    }

    /// @notice Make every subsequent swap execute this many basis points worse than quoted.
    function setSandwichBps(uint256 bps) external {
        sandwichBps = bps;
    }

    /// @dev Constant product with a 0.25% fee, matching PancakeSwap V2.
    function _quote(uint256 amountIn, address tokenIn, address tokenOut) internal view returns (uint256) {
        uint256 reserveIn = reserves[tokenIn][tokenOut];
        uint256 reserveOut = reserves[tokenOut][tokenIn];
        if (reserveIn == 0 || reserveOut == 0) return 0;

        uint256 amountInWithFee = amountIn * 9_975;
        return (amountInWithFee * reserveOut) / (reserveIn * 10_000 + amountInWithFee);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        for (uint256 i; i + 1 < path.length; ++i) {
            amounts[i + 1] = _quote(amounts[i], path[i], path[i + 1]);
        }
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        require(block.timestamp <= deadline, "EXPIRED");

        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 amountOut = _quote(amountIn, tokenIn, tokenOut);
        // The victim's trade lands after the attacker moved the pool, so it fills worse than quoted.
        amountOut = (amountOut * (10_000 - sandwichBps)) / 10_000;
        require(amountOut >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");

        // Move reserves so a second swap in the same transaction is priced against the new state.
        reserves[tokenIn][tokenOut] += amountIn;
        reserves[tokenOut][tokenIn] -= amountOut;

        MockERC20(tokenOut).mint(to, amountOut);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "EXPIRED");

        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 amountOut = _quote(amountIn, tokenIn, tokenOut);
        amountOut = (amountOut * (10_000 - sandwichBps)) / 10_000;
        require(amountOut >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");

        reserves[tokenIn][tokenOut] += amountIn;
        reserves[tokenOut][tokenIn] -= amountOut;

        MockERC20(tokenOut).mint(to, amountOut);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        require(block.timestamp <= deadline, "EXPIRED");

        amountA = amountADesired;
        amountB = amountBDesired;
        require(amountA >= amountAMin && amountB >= amountBMin, "INSUFFICIENT_AMOUNT");

        IERC20(tokenA).safeTransferFrom(msg.sender, address(this), amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, address(this), amountB);

        liquidity = amountA * LP_PER_TOKEN0;
        pair.mint(to, liquidity);
    }

    function factory() external view returns (address) {
        return address(this);
    }

    function WETH() external view returns (address) {
        return address(this);
    }
}

/// @notice Chainlink aggregator whose answer, timestamp and round data the test drives directly.
contract MockAggregator is IAggregatorV3 {
    uint8 private immutable _decimals;
    string private _description;

    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;

    constructor(uint8 decimals_, int256 answer_, string memory description_) {
        _decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
        _description = description_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
        roundId += 1;
        answeredInRound = roundId;
    }

    /// @dev Freezes the feed without changing the answer, which is what a real outage looks like.
    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    /// @dev Simulates an answer carried over from a previous round.
    function setStaleRound() external {
        roundId += 1;
        // answeredInRound deliberately left behind roundId.
    }

    function setIncompleteRound() external {
        updatedAt = 0;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @notice Aggregator whose latestRoundData always reverts, modelling a broken feed.
contract RevertingAggregator is IAggregatorV3 {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "reverting";
    }

    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert("feed down");
    }
}
