// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The slice of {RewardToken} the farm needs.
/// @dev Depending on an interface rather than the concrete contract keeps the farm deployable
///      against any capped, mintable BEP-20, which matters when a project already has a token.
interface IRewardToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function cap() external view returns (uint256);
    function remainingMintable() external view returns (uint256);
    function mintingFinished() external view returns (bool);
}
