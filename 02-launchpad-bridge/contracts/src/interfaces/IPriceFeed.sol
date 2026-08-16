// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice USD pricing for the presale, at 18 decimals.
///
/// @dev Pulled behind an interface so the presale can be tested without Chainlink and deployed on a
///      chain whose feeds differ. The production implementation is {ChainlinkPriceFeed}, which
///      rejects stale and malformed rounds rather than trusting whatever the aggregator last said.
interface IPriceFeed {
    /// @notice USD value of `amount` wei of the chain's native token, at 18 decimals.
    function nativeToUsd(uint256 amount) external view returns (uint256);

    /// @notice USD value of `amount` units of `token`, at 18 decimals.
    function tokenToUsd(address token, uint256 amount) external view returns (uint256);
}
