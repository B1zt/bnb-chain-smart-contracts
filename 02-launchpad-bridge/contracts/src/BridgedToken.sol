// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title BridgedToken
/// @notice The representation of a token on a chain that is not its home.
///
/// @dev Its entire supply is backed by tokens locked in the bridge on the canonical chain, so the
///      only address allowed to mint is the bridge itself. There is no owner mint, no treasury
///      allocation and no initial supply: every unit in existence corresponds to a locked unit
///      elsewhere, and any other minting path would break that one-to-one backing.
contract BridgedToken is ERC20, ERC20Burnable, ERC20Permit, AccessControl {
    error ZeroAddress();

    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");

    /// @notice Chain id where the canonical token lives, for explorers and UIs.
    uint256 public immutable homeChainId;

    /// @notice Address of the canonical token on its home chain.
    address public immutable homeToken;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 homeChainId_,
        address homeToken_,
        address bridge,
        address admin
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (bridge == address(0) || admin == address(0) || homeToken_ == address(0)) {
            revert ZeroAddress();
        }

        homeChainId = homeChainId_;
        homeToken = homeToken_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(BRIDGE_ROLE, bridge);
    }

    /// @notice Mint on release. Only the bridge may call this.
    function mint(address to, uint256 amount) external onlyRole(BRIDGE_ROLE) {
        _mint(to, amount);
    }
}
