// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title RewardToken
/// @notice BEP-20 farm reward token with a hard cap and role-gated minting.
///
/// @dev BEP-20 is ERC-20. There is no separate interface to implement and no extra function to add;
///      the name is a BNB Chain convention rather than a different standard. The only practical
///      differences are ecosystem ones: wallets expect 18 decimals, and PancakeSwap's router is the
///      default liquidity venue.
///
///      Two decisions matter more here than on Ethereum, because farm tokens are where inflation
///      abuse is most common:
///
///      - **The cap is immutable.** A farm token whose owner can mint without limit is the standard
///        shape of a rug. Emissions are bounded at deployment and no admin action can raise it.
///
///      - **Minting is a role, not ownership.** The role goes to the MasterChef so it can pay
///        emissions, without also handing it every other admin power. `finishMinting` closes it for
///        good once emissions end, which is stronger than revoking a role that could be re-granted.
contract RewardToken is ERC20, ERC20Burnable, ERC20Permit, AccessControl {
    error CapExceeded(uint256 requested, uint256 remaining);
    error ZeroCap();
    error ZeroAddress();
    error MintingAlreadyFinished();

    event MintingFinished();

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Hard supply cap. Immutable, so no admin action can raise it.
    uint256 public immutable cap;

    /// @notice Once true, no token can ever be minted again, whatever roles exist.
    bool public mintingFinished;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 cap_,
        uint256 initialSupply,
        address treasury,
        address admin
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (cap_ == 0) revert ZeroCap();
        if (treasury == address(0) || admin == address(0)) revert ZeroAddress();
        if (initialSupply > cap_) revert CapExceeded(initialSupply, cap_);

        cap = cap_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        if (initialSupply > 0) {
            _mint(treasury, initialSupply);
        }
    }

    /// @notice Mint emissions. Bounded by the cap.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (mintingFinished) revert MintingAlreadyFinished();

        uint256 supply = totalSupply();
        if (supply + amount > cap) revert CapExceeded(amount, cap - supply);

        _mint(to, amount);
    }

    /// @notice Permanently disable minting. One-way.
    function finishMinting() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (mintingFinished) revert MintingAlreadyFinished();

        mintingFinished = true;
        emit MintingFinished();
    }

    /// @notice Tokens that may still be minted.
    function remainingMintable() external view returns (uint256) {
        if (mintingFinished) return 0;
        return cap - totalSupply();
    }
}
