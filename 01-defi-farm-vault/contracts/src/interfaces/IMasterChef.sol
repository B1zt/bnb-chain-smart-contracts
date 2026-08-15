// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of {MasterChef} the auto-compounding vault needs.
/// @dev Declared as an interface so the vault can farm any MasterChef-shaped contract, including
///      PancakeSwap's own, not only the one in this repository.
interface IMasterChef {
    function deposit(uint256 pid, uint256 amount) external;
    function withdraw(uint256 pid, uint256 amount) external;
    function emergencyWithdraw(uint256 pid) external;
    function pendingReward(uint256 pid, address account) external view returns (uint256);
    function userInfo(uint256 pid, address account)
        external
        view
        returns (uint256 amount, uint256 rewardDebt, uint256 nextHarvestAt);
}
