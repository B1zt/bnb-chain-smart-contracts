// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Presale} from "./Presale.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

/// @title PresaleFactory
/// @notice Deploys presales as minimal proxies and funds them in the same transaction.
///
/// @dev **Why clones.** A full `Presale` deployment costs a few million gas. An EIP-1167 minimal
///      proxy costs about 45,000. A launchpad expecting to host dozens of sales pays that
///      difference every time, and on BNB Chain the whole pitch is that things are cheap.
///
///      **Why funding happens here.** The factory pulls the sale's entire token allocation from the
///      creator during `createPresale`. A presale that exists but holds no tokens is the classic
///      launchpad failure: it takes contributions and then cannot honour a single claim. Doing it
///      atomically means a listed sale is always backed.
contract PresaleFactory is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error CreationFeeNotPaid(uint256 sent, uint256 required);
    error FeeTooHigh(uint16 bps);
    error UnderfundedSale(uint256 received, uint256 required);
    error PresaleNotFound(address presale);
    error TransferFailed();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event PresaleCreated(
        address indexed presale,
        address indexed creator,
        address indexed token,
        uint256 tokensFunded,
        uint256 index
    );
    event CreationFeeUpdated(uint256 fee);
    event ProtocolFeeUpdated(uint16 bps, address indexed recipient);
    event ImplementationUpdated(address indexed implementation);
    event PresaleVerified(address indexed presale, bool verified);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Hard ceiling on the launchpad's cut of a raise. Five percent.
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 500;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Template every presale clones.
    address public implementation;

    /// @notice Flat fee in native BNB to list a sale. Spam deterrent, not a revenue model.
    uint256 public creationFee;

    /// @notice Launchpad cut of a successful raise, in basis points.
    uint16 public protocolFeeBps;

    address public feeRecipient;

    /// @notice Every presale ever created, in creation order.
    address[] public presales;

    /// @notice Presales created by a given address.
    mapping(address creator => address[] presales) private _presalesByCreator;

    mapping(address presale => bool exists) public isPresale;

    /// @notice Launchpad review status.
    /// @dev Purely informational and clearly labelled as such in the UI. It is a curation signal,
    ///      not a safety guarantee, and pretending otherwise is how launchpad users get hurt.
    mapping(address presale => bool verified) public isVerified;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address owner_, address feeRecipient_, uint256 creationFee_, uint16 protocolFeeBps_)
        Ownable(owner_)
    {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh(protocolFeeBps_);

        // Deployed once here and cloned from then on.
        implementation = address(new Presale());
        feeRecipient = feeRecipient_;
        creationFee = creationFee_;
        protocolFeeBps = protocolFeeBps_;

        emit ImplementationUpdated(implementation);
        emit CreationFeeUpdated(creationFee_);
        emit ProtocolFeeUpdated(protocolFeeBps_, feeRecipient_);
    }

    /*//////////////////////////////////////////////////////////////
                                CREATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy and fund a presale.
    /// @dev The creator must have approved this factory for the full token allocation first.
    /// @param config Sale parameters, immutable once set.
    /// @param stablecoins Accepted contribution currencies besides native BNB.
    /// @param priceFeed USD pricing source for contributions.
    /// @return presale Address of the new sale.
    function createPresale(
        Presale.SaleConfig calldata config,
        address[] calldata stablecoins,
        IPriceFeed priceFeed
    ) external payable nonReentrant returns (address presale) {
        if (msg.value < creationFee) revert CreationFeeNotPaid(msg.value, creationFee);

        presale = Clones.clone(implementation);

        Presale(payable(presale)).initialize(msg.sender, priceFeed, config, stablecoins);

        // Fund the sale in the same transaction. A listed sale that cannot honour its own claims is
        // the failure mode this prevents.
        uint256 required = (config.hardCapUsd * config.tokensPerUsd) / 1e18;

        uint256 balanceBefore = IERC20(config.token).balanceOf(presale);
        IERC20(config.token).safeTransferFrom(msg.sender, presale, required);
        uint256 received = IERC20(config.token).balanceOf(presale) - balanceBefore;

        // A fee-on-transfer token delivers less than was sent, which would leave the sale short at
        // exactly the hard cap. Rejecting is better than discovering it during claims.
        if (received < required) revert UnderfundedSale(received, required);

        presales.push(presale);
        _presalesByCreator[msg.sender].push(presale);
        isPresale[presale] = true;

        if (msg.value > 0) {
            (bool ok,) = feeRecipient.call{value: msg.value}("");
            if (!ok) revert TransferFailed();
        }

        emit PresaleCreated(presale, msg.sender, config.token, received, presales.length - 1);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function setCreationFee(uint256 fee) external onlyOwner {
        creationFee = fee;
        emit CreationFeeUpdated(fee);
    }

    function setProtocolFee(uint16 bps, address recipient) external onlyOwner {
        if (bps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh(bps);
        if (recipient == address(0)) revert ZeroAddress();

        protocolFeeBps = bps;
        feeRecipient = recipient;

        emit ProtocolFeeUpdated(bps, recipient);
    }

    /// @notice Point future clones at a new template.
    /// @dev Existing presales are untouched, because a minimal proxy hardcodes its implementation
    ///      at deployment. That is a feature here: a contributor's sale cannot be swapped out from
    ///      under them after they have paid.
    function setImplementation(address implementation_) external onlyOwner {
        if (implementation_ == address(0)) revert ZeroAddress();

        implementation = implementation_;
        emit ImplementationUpdated(implementation_);
    }

    /// @notice Mark a sale as reviewed by the launchpad.
    function setVerified(address presale, bool verified) external onlyOwner {
        if (!isPresale[presale]) revert PresaleNotFound(presale);

        isVerified[presale] = verified;
        emit PresaleVerified(presale, verified);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function presaleCount() external view returns (uint256) {
        return presales.length;
    }

    function presalesByCreator(address creator) external view returns (address[] memory) {
        return _presalesByCreator[creator];
    }

    /// @notice A page of presales, newest first.
    function listPresales(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = presales.length;
        if (offset >= total) return new address[](0);

        uint256 remaining = total - offset;
        uint256 size = remaining < limit ? remaining : limit;

        page = new address[](size);
        for (uint256 i; i < size; ++i) {
            page[i] = presales[total - 1 - offset - i];
        }
    }

    /// @notice Tokens a creator must approve for a given configuration.
    /// @dev Exposed so a frontend can request the exact approval instead of an unlimited one.
    function requiredFunding(uint256 hardCapUsd, uint256 tokensPerUsd) external pure returns (uint256) {
        return (hardCapUsd * tokensPerUsd) / 1e18;
    }
}
