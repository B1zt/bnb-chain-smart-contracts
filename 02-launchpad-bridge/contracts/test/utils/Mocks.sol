// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPriceFeed} from "../../src/interfaces/IPriceFeed.sol";

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
/// @dev BNB Chain is full of these, and a presale that trusts the requested amount rather than the
///      received one ends up unable to refund its last contributor.
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

        if (fee > 0) super._update(from, address(0xdead), fee);
    }
}

/// @notice Price feed whose answers the test drives directly.
contract MockPriceFeed is IPriceFeed {
    uint256 public nativePrice;
    mapping(address => uint256) public tokenPrice;

    /// @dev Lets a test simulate an oracle outage, which must stop contributions rather than
    ///      silently price them at zero.
    bool public reverting;

    function setNativePrice(uint256 price) external {
        nativePrice = price;
    }

    function setTokenPrice(address token, uint256 price) external {
        tokenPrice[token] = price;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function nativeToUsd(uint256 amount) external view returns (uint256) {
        require(!reverting, "feed down");
        return (amount * nativePrice) / 1e18;
    }

    function tokenToUsd(address token, uint256 amount) external view returns (uint256) {
        require(!reverting, "feed down");
        return (amount * tokenPrice[token]) / 1e18;
    }
}

/// @notice Address that refuses every incoming native transfer.
contract RejectingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}
