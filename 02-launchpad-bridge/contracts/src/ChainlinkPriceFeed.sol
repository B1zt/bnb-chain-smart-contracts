// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title ChainlinkPriceFeed
/// @notice USD pricing for presale contributions, backed by Chainlink with staleness checks.
///
/// @dev A presale prices contributions in USD so that BNB and a stablecoin count identically
///      against the caps. That makes the price feed a load-bearing component: a wrong price does
///      not produce a wrong chart, it produces a wrong allocation and a wrong raise total.
///
///      Every read is rejected unless the round is positive, complete, freshly answered and inside
///      its heartbeat. A Chainlink feed that stops updating keeps returning its last answer forever
///      with no error, so "it returned a number" is not evidence the number is current.
///
///      Unlike a dashboard oracle, this one has **no `tryGetPrice` variant**. There is no sensible
///      way to degrade here: if the price cannot be trusted, the contribution must not be accepted.
contract ChainlinkPriceFeed is IPriceFeed, Ownable2Step {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Feed {
        IAggregatorV3 aggregator;
        uint32 heartbeat;
        uint8 feedDecimals;
        uint8 tokenDecimals;
        bool exists;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error FeedNotConfigured(address token);
    error StalePrice(address token, uint256 updatedAt, uint256 maxAge);
    error InvalidPrice(address token, int256 answer);
    error IncompleteRound(address token);
    error ZeroAddress();
    error HeartbeatTooLong(uint32 heartbeat);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event FeedSet(address indexed token, address indexed aggregator, uint32 heartbeat);
    event NativeFeedSet(address indexed aggregator, uint32 heartbeat);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Key used for the chain's native token in the feed mapping.
    address private constant NATIVE = address(0);

    uint8 public constant USD_DECIMALS = 18;

    /// @notice Upper bound on a configurable heartbeat.
    uint32 public constant MAX_HEARTBEAT = 1 days;

    /// @notice Slack added to each heartbeat before a price is called stale.
    /// @dev Chainlink heartbeats are targets, not guarantees. Without this the feed would reject
    ///      good prices during ordinary congestion, which on a presale means rejecting money.
    uint32 public constant GRACE_PERIOD = 30 minutes;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    mapping(address token => Feed) private _feeds;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address owner_) Ownable(owner_) {}

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Configure the feed for the chain's native token, e.g. BNB/USD.
    function setNativeFeed(IAggregatorV3 aggregator, uint32 heartbeat) external onlyOwner {
        if (address(aggregator) == address(0)) revert ZeroAddress();
        if (heartbeat == 0 || heartbeat > MAX_HEARTBEAT) revert HeartbeatTooLong(heartbeat);

        _feeds[NATIVE] = Feed({
            aggregator: aggregator,
            heartbeat: heartbeat,
            // Probed at configuration time so a wrong address fails now, not during a live sale.
            feedDecimals: aggregator.decimals(),
            tokenDecimals: 18,
            exists: true
        });

        emit NativeFeedSet(address(aggregator), heartbeat);
    }

    /// @notice Configure the feed for an ERC-20 contribution currency.
    function setTokenFeed(address token, IAggregatorV3 aggregator, uint32 heartbeat)
        external
        onlyOwner
    {
        if (token == address(0) || address(aggregator) == address(0)) revert ZeroAddress();
        if (heartbeat == 0 || heartbeat > MAX_HEARTBEAT) revert HeartbeatTooLong(heartbeat);

        _feeds[token] = Feed({
            aggregator: aggregator,
            heartbeat: heartbeat,
            feedDecimals: aggregator.decimals(),
            // Read once. USDC is 6 decimals on most chains but 18 on BNB Chain, and assuming either
            // is how a raise ends up out by a factor of a trillion.
            tokenDecimals: IERC20Metadata(token).decimals(),
            exists: true
        });

        emit FeedSet(token, address(aggregator), heartbeat);
    }

    /*//////////////////////////////////////////////////////////////
                                PRICING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPriceFeed
    function nativeToUsd(uint256 amount) external view returns (uint256) {
        return _valueOf(NATIVE, amount);
    }

    /// @inheritdoc IPriceFeed
    function tokenToUsd(address token, uint256 amount) external view returns (uint256) {
        return _valueOf(token, amount);
    }

    function _valueOf(address token, uint256 amount) private view returns (uint256) {
        Feed memory feed = _feeds[token];
        if (!feed.exists) revert FeedNotConfigured(token);

        uint256 price = _readPrice(token, feed);

        // Normalise the amount to 18 decimals, then apply an 18 decimal price.
        uint256 scaledAmount = feed.tokenDecimals == 18
            ? amount
            : feed.tokenDecimals < 18
                ? amount * (10 ** (18 - feed.tokenDecimals))
                : amount / (10 ** (feed.tokenDecimals - 18));

        return (scaledAmount * price) / 1e18;
    }

    /// @dev A validated, 18 decimal price. Reverts rather than returning anything questionable.
    function _readPrice(address token, Feed memory feed) private view returns (uint256) {
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) =
            feed.aggregator.latestRoundData();

        if (answer <= 0) revert InvalidPrice(token, answer);

        // updatedAt of zero marks an incomplete round; answeredInRound behind roundId means the
        // answer was carried over from a previous round rather than freshly computed.
        if (updatedAt == 0 || answeredInRound < roundId) revert IncompleteRound(token);

        uint256 maxAge = uint256(feed.heartbeat) + GRACE_PERIOD;
        if (block.timestamp > updatedAt + maxAge) revert StalePrice(token, updatedAt, maxAge);

        // `answer` is positive by the check above, so the cast cannot wrap.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 price = uint256(answer);

        if (feed.feedDecimals == USD_DECIMALS) return price;
        if (feed.feedDecimals < USD_DECIMALS) return price * (10 ** (USD_DECIMALS - feed.feedDecimals));

        return price / (10 ** (feed.feedDecimals - USD_DECIMALS));
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice USD price of one whole unit of a token, at 18 decimals.
    function priceOf(address token) external view returns (uint256) {
        Feed memory feed = _feeds[token];
        if (!feed.exists) revert FeedNotConfigured(token);

        return _readPrice(token, feed);
    }

    function feeds(address token) external view returns (Feed memory) {
        if (!_feeds[token].exists) revert FeedNotConfigured(token);
        return _feeds[token];
    }

    /// @notice Whether a currency can currently be priced, for a frontend to disable an input.
    function isPriceable(address token) external view returns (bool) {
        Feed memory feed = _feeds[token];
        if (!feed.exists) return false;

        try feed.aggregator.latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) return false;
            return block.timestamp <= updatedAt + uint256(feed.heartbeat) + GRACE_PERIOD;
        } catch {
            return false;
        }
    }
}
