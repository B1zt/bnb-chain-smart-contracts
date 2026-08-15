// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Minimal Chainlink aggregator interface.
/// @dev Declared locally rather than importing `@chainlink/contracts`, which drags in a large
///      dependency tree for four function signatures.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title PriceOracle
/// @notice Chainlink price feeds with staleness and sanity checks.
///
/// @dev **Reading `latestRoundData` and using `answer` directly is the mistake this contract
///      exists to avoid.** A Chainlink feed can go stale during an outage or a chain halt, and it
///      keeps returning its last answer indefinitely with no error. A protocol that trusts it
///      blindly will happily price an asset at yesterday's number, which is exactly the window an
///      attacker wants.
///
///      Every read here is rejected unless it passes four checks:
///
///      1. `answer > 0`. A zero or negative price is never valid for an asset feed.
///      2. `updatedAt` is within the feed's configured heartbeat plus a grace period.
///      3. `updatedAt != 0`, which marks an incomplete round.
///      4. `answeredInRound >= roundId`, catching a carried-over answer from a previous round.
///
///      Callers choose between `getPrice`, which reverts on a bad read, and `tryGetPrice`, which
///      reports failure. A liquidation must revert; a dashboard should degrade.
contract PriceOracle is Ownable2Step {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Feed {
        IAggregatorV3 aggregator;
        /// @dev Maximum expected gap between updates, from the feed's published heartbeat.
        uint32 heartbeat;
        uint8 decimals;
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
    event FeedRemoved(address indexed token);
    event GracePeriodUpdated(uint32 gracePeriod);

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Prices are always normalised to 18 decimals, whatever the feed reports.
    uint8 public constant PRICE_DECIMALS = 18;

    /// @notice Upper bound on a configurable heartbeat. A feed allowed to be a week stale is not
    ///         an oracle, so the owner cannot set one.
    uint32 public constant MAX_HEARTBEAT = 2 days;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    mapping(address token => Feed) private _feeds;

    /// @notice Slack added to each feed's heartbeat before a price is called stale.
    /// @dev Chainlink heartbeats are targets, not guarantees, and a small delay is normal. Without
    ///      a grace period the oracle would reject perfectly good prices during ordinary congestion.
    uint32 public gracePeriod = 30 minutes;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address owner_) Ownable(owner_) {}

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Configure a feed for a token.
    /// @param token Asset being priced.
    /// @param aggregator Chainlink aggregator address on this chain.
    /// @param heartbeat The feed's published heartbeat, in seconds.
    function setFeed(address token, IAggregatorV3 aggregator, uint32 heartbeat) external onlyOwner {
        if (token == address(0) || address(aggregator) == address(0)) revert ZeroAddress();
        if (heartbeat == 0 || heartbeat > MAX_HEARTBEAT) revert HeartbeatTooLong(heartbeat);

        // Probing decimals at configuration time catches a wrong address immediately, rather than
        // at the first price read during a live liquidation.
        uint8 feedDecimals = aggregator.decimals();

        _feeds[token] = Feed({
            aggregator: aggregator,
            heartbeat: heartbeat,
            decimals: feedDecimals,
            exists: true
        });

        emit FeedSet(token, address(aggregator), heartbeat);
    }

    function removeFeed(address token) external onlyOwner {
        if (!_feeds[token].exists) revert FeedNotConfigured(token);

        delete _feeds[token];
        emit FeedRemoved(token);
    }

    function setGracePeriod(uint32 gracePeriod_) external onlyOwner {
        if (gracePeriod_ > MAX_HEARTBEAT) revert HeartbeatTooLong(gracePeriod_);

        gracePeriod = gracePeriod_;
        emit GracePeriodUpdated(gracePeriod_);
    }

    /*//////////////////////////////////////////////////////////////
                                READING
    //////////////////////////////////////////////////////////////*/

    /// @notice Price of `token` in USD, normalised to 18 decimals. Reverts on a bad read.
    /// @dev Use this anywhere a wrong price is worse than no price at all.
    function getPrice(address token) public view returns (uint256) {
        Feed memory feed = _feeds[token];
        if (!feed.exists) revert FeedNotConfigured(token);

        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) =
            feed.aggregator.latestRoundData();

        // A zero or negative answer is never a valid asset price.
        if (answer <= 0) revert InvalidPrice(token, answer);

        // updatedAt of zero marks an incomplete round; answeredInRound behind roundId means the
        // answer was carried over from an earlier round rather than freshly computed.
        if (updatedAt == 0 || answeredInRound < roundId) revert IncompleteRound(token);

        uint256 maxAge = uint256(feed.heartbeat) + gracePeriod;
        if (block.timestamp > updatedAt + maxAge) {
            revert StalePrice(token, updatedAt, maxAge);
        }

        // `answer` is guaranteed positive by the check above, so the cast cannot wrap.
        // forge-lint: disable-next-line(unsafe-typecast)
        return _normalise(uint256(answer), feed.decimals);
    }

    /// @notice Same as {getPrice} but reports failure instead of reverting.
    /// @dev For dashboards and other read paths that should degrade rather than break.
    function tryGetPrice(address token) external view returns (bool ok, uint256 price) {
        Feed memory feed = _feeds[token];
        if (!feed.exists) return (false, 0);

        try feed.aggregator.latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0) return (false, 0);
            if (updatedAt == 0 || answeredInRound < roundId) return (false, 0);

            uint256 maxAge = uint256(feed.heartbeat) + gracePeriod;
            if (block.timestamp > updatedAt + maxAge) return (false, 0);

            // Positive by the check above.
            // forge-lint: disable-next-line(unsafe-typecast)
            return (true, _normalise(uint256(answer), feed.decimals));
        } catch {
            return (false, 0);
        }
    }

    /// @notice USD value of `amount` of `token`, at 18 decimals.
    /// @param tokenDecimals Decimals of the token itself, which is not always 18.
    function getValue(address token, uint256 amount, uint8 tokenDecimals)
        external
        view
        returns (uint256)
    {
        uint256 price = getPrice(token);
        return (amount * price) / (10 ** tokenDecimals);
    }

    /// @notice Seconds since a feed last updated, for surfacing feed health.
    function priceAge(address token) external view returns (uint256) {
        Feed memory feed = _feeds[token];
        if (!feed.exists) revert FeedNotConfigured(token);

        (, , , uint256 updatedAt, ) = feed.aggregator.latestRoundData();
        if (updatedAt == 0 || block.timestamp < updatedAt) return 0;

        return block.timestamp - updatedAt;
    }

    function feeds(address token) external view returns (Feed memory) {
        if (!_feeds[token].exists) revert FeedNotConfigured(token);
        return _feeds[token];
    }

    /// @dev Chainlink feeds are usually 8 decimals for USD pairs and 18 for ETH pairs, so a fixed
    ///      assumption breaks the moment a second feed is added.
    function _normalise(uint256 value, uint8 fromDecimals) private pure returns (uint256) {
        if (fromDecimals == PRICE_DECIMALS) return value;
        if (fromDecimals < PRICE_DECIMALS) return value * (10 ** (PRICE_DECIMALS - fromDecimals));
        return value / (10 ** (fromDecimals - PRICE_DECIMALS));
    }
}
