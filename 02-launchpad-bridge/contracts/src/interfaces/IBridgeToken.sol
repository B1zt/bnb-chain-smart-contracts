// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice A token the bridge can mint and burn on non-canonical chains.
///
/// @dev Only needed where the token is a bridged representation. On its home chain the bridge locks
///      the canonical token instead and never calls either of these, which is why they are behind a
///      separate interface rather than assumed of every bridged asset.
interface IBridgeToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
}
