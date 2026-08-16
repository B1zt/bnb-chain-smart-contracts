// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {BridgedToken} from "../src/BridgedToken.sol";
import {TokenBridge} from "../src/TokenBridge.sol";
import {MockERC20} from "./utils/Mocks.sol";

/// @notice Bridge tests, organised around the exploit classes that have actually drained bridges.
contract TokenBridgeTest is Test {
    TokenBridge internal bridge;
    MockERC20 internal token;
    BridgedToken internal wrapped;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal recipient = makeAddr("recipient");

    /// @dev Five validators, threshold of three. Sorted ascending by address, which the bridge
    ///      requires of every signature set.
    uint256[] internal validatorKeys;
    address[] internal validatorAddresses;

    uint256 internal constant HOME_CHAIN = 56; // BSC
    uint256 internal constant REMOTE_CHAIN = 1; // Ethereum
    uint8 internal constant THRESHOLD = 3;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.chainId(HOME_CHAIN);

        // Generate keys, then sort by derived address so signatures can be produced in order.
        uint256[] memory keys = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            keys[i] = 0x1000 + i;
        }
        _sortKeysByAddress(keys);

        for (uint256 i; i < keys.length; ++i) {
            validatorKeys.push(keys[i]);
            validatorAddresses.push(vm.addr(keys[i]));
        }

        bridge = new TokenBridge(owner, validatorAddresses, THRESHOLD);

        token = new MockERC20("Project", "PRJ", 18);
        wrapped = new BridgedToken("Wrapped Project", "wPRJ", HOME_CHAIN, address(token), address(bridge), owner);

        vm.startPrank(owner);
        // On this chain the token is canonical, so the bridge locks rather than mints.
        bridge.configureToken(address(token), true, false, 1_000_000e18, 100_000e18);
        bridge.configureChain(REMOTE_CHAIN, makeAddr("remoteBridge"), true);
        vm.stopPrank();

        token.mint(alice, 1_000_000e18);
        token.mint(address(bridge), 1_000_000e18); // liquidity for inbound releases

        vm.prank(alice);
        token.approve(address(bridge), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _sortKeysByAddress(uint256[] memory keys) internal pure {
        for (uint256 i = 1; i < keys.length; ++i) {
            uint256 key = keys[i];
            address addr = vm.addr(key);
            uint256 j = i;
            while (j > 0 && vm.addr(keys[j - 1]) > addr) {
                keys[j] = keys[j - 1];
                --j;
            }
            keys[j] = key;
        }
    }

    function _transfer(uint256 amount, uint256 nonce)
        internal
        view
        returns (TokenBridge.Transfer memory)
    {
        return TokenBridge.Transfer({
            sourceChainId: REMOTE_CHAIN,
            destinationChainId: HOME_CHAIN,
            destinationBridge: address(bridge),
            token: address(token),
            recipient: recipient,
            amount: amount,
            nonce: nonce
        });
    }

    /// @dev Signatures from the first `count` validators, already in ascending signer order.
    function _sign(TokenBridge.Transfer memory transfer, uint256 count)
        internal
        view
        returns (bytes[] memory signatures)
    {
        bytes32 digest = bridge.transferDigest(transfer);
        signatures = new bytes[](count);

        for (uint256 i; i < count; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(validatorKeys[i], digest);
            signatures[i] = abi.encodePacked(r, s, v);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               OUTBOUND
    //////////////////////////////////////////////////////////////*/

    function test_bridgeOut_locksTokens() public {
        uint256 balanceBefore = token.balanceOf(address(bridge));

        vm.prank(alice);
        bridge.bridgeOut(address(token), REMOTE_CHAIN, recipient, 1_000e18);

        assertEq(token.balanceOf(address(bridge)) - balanceBefore, 1_000e18, "locked, not burned");
        assertEq(bridge.outboundNonce(REMOTE_CHAIN), 1, "nonce advanced");
    }

    function test_bridgeOut_rejectsUnsupportedChain() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenBridge.ChainNotSupported.selector, uint256(999)));
        bridge.bridgeOut(address(token), 999, recipient, 1_000e18);
    }

    function test_bridgeOut_rejectsUnsupportedToken() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenBridge.TokenNotSupported.selector, address(other)));
        bridge.bridgeOut(address(other), REMOTE_CHAIN, recipient, 1_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                                INBOUND
    //////////////////////////////////////////////////////////////*/

    function test_bridgeIn_releasesWithThresholdSignatures() public {
        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        bytes[] memory signatures = _sign(transfer, THRESHOLD);

        uint256 before = token.balanceOf(recipient);

        bridge.bridgeIn(transfer, signatures);

        assertEq(token.balanceOf(recipient) - before, 1_000e18);
        assertTrue(bridge.processed(bridge.transferHash(transfer)));
    }

    function test_bridgeIn_rejectsBelowThreshold() public {
        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        bytes[] memory signatures = _sign(transfer, THRESHOLD - 1);

        vm.expectRevert(
            abi.encodeWithSelector(TokenBridge.NotEnoughSignatures.selector, THRESHOLD - 1, THRESHOLD)
        );
        bridge.bridgeIn(transfer, signatures);
    }

    /*//////////////////////////////////////////////////////////////
                        REPLAY: THE NOMAD CLASS
    //////////////////////////////////////////////////////////////*/

    /// @dev Nomad was drained by replaying one proven message thousands of times. `processed` must
    ///      be checked before any state change, and set before any transfer.
    function test_replay_sameTransferCannotBeReleasedTwice() public {
        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        bytes[] memory signatures = _sign(transfer, THRESHOLD);

        bridge.bridgeIn(transfer, signatures);

        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridge.AlreadyProcessed.selector, bridge.transferHash(transfer)
            )
        );
        bridge.bridgeIn(transfer, signatures);
    }

    /// @dev A different nonce is a different transfer, so it must be releasable independently.
    ///      Otherwise a nonce collision would silently block legitimate transfers.
    function test_replay_differentNoncesAreIndependent() public {
        TokenBridge.Transfer memory first = _transfer(1_000e18, 0);
        TokenBridge.Transfer memory second = _transfer(1_000e18, 1);

        bridge.bridgeIn(first, _sign(first, THRESHOLD));
        bridge.bridgeIn(second, _sign(second, THRESHOLD));

        assertEq(token.balanceOf(recipient), 2_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                     CROSS-CHAIN REPLAY: THE WORMHOLE CLASS
    //////////////////////////////////////////////////////////////*/

    /// @dev A signature must be bound to the destination chain. Without the check, a validator
    ///      signature intended for Ethereum could be replayed on BSC, and a multi-chain bridge is
    ///      drained from whichever chain is cheapest to attack.
    function test_crossChainReplay_wrongDestinationChainRejected() public {
        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        transfer.destinationChainId = REMOTE_CHAIN; // not this chain

        bytes[] memory signatures = _sign(transfer, THRESHOLD);

        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridge.WrongDestinationChain.selector, HOME_CHAIN, REMOTE_CHAIN
            )
        );
        bridge.bridgeIn(transfer, signatures);
    }

    /// @dev And bound to this specific deployment, so a signature for one bridge on this chain
    ///      cannot be replayed against another.
    function test_crossChainReplay_wrongBridgeAddressRejected() public {
        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        transfer.destinationBridge = makeAddr("someOtherBridge");

        bytes[] memory signatures = _sign(transfer, THRESHOLD);

        vm.expectRevert();
        bridge.bridgeIn(transfer, signatures);
    }

    /// @dev Mutating any signed field must invalidate the signature. This is the check that stops
    ///      a relayer inflating the amount on a genuinely signed transfer.
    function test_mutatedAmountInvalidatesSignatures() public {
        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        bytes[] memory signatures = _sign(transfer, THRESHOLD);

        transfer.amount = 1_000_000e18;

        // The recovered signers are now different addresses, which are not validators.
        vm.expectRevert();
        bridge.bridgeIn(transfer, signatures);
    }

    function test_mutatedRecipientInvalidatesSignatures() public {
        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        bytes[] memory signatures = _sign(transfer, THRESHOLD);

        transfer.recipient = makeAddr("attacker");

        vm.expectRevert();
        bridge.bridgeIn(transfer, signatures);
    }

    /*//////////////////////////////////////////////////////////////
                   DUPLICATE SIGNERS: THE RONIN-ADJACENT CLASS
    //////////////////////////////////////////////////////////////*/

    /// @dev The bug that has appeared in deployed multisig bridges: submitting one validator's
    ///      signature `threshold` times to satisfy the count. Requiring strictly ascending signers
    ///      makes it impossible without a mapping or a nested loop.
    function test_duplicateSignaturesRejected() public {
        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        bytes32 digest = bridge.transferDigest(transfer);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(validatorKeys[0], digest);

        bytes[] memory signatures = new bytes[](THRESHOLD);
        for (uint256 i; i < THRESHOLD; ++i) {
            signatures[i] = abi.encodePacked(r, s, v);
        }

        vm.expectRevert(TokenBridge.SignaturesNotSorted.selector);
        bridge.bridgeIn(transfer, signatures);
    }

    /// @dev Unsorted but otherwise valid signatures are rejected too. The relayer is expected to
    ///      sort; accepting either order would mean giving up the duplicate defence.
    function test_unsortedSignaturesRejected() public {
        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        bytes32 digest = bridge.transferDigest(transfer);

        bytes[] memory signatures = new bytes[](THRESHOLD);
        for (uint256 i; i < THRESHOLD; ++i) {
            // Reverse order.
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(validatorKeys[THRESHOLD - 1 - i], digest);
            signatures[i] = abi.encodePacked(r, s, v);
        }

        vm.expectRevert(TokenBridge.SignaturesNotSorted.selector);
        bridge.bridgeIn(transfer, signatures);
    }

    /// @dev A signature from a non-validator must not count towards the threshold.
    function test_nonValidatorSignatureRejected() public {
        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        bytes32 digest = bridge.transferDigest(transfer);

        // Two real validators plus an impostor whose address sorts last.
        uint256 impostorKey = 0xBADBEEF;
        vm.assume(vm.addr(impostorKey) > validatorAddresses[1]);

        bytes[] memory signatures = new bytes[](3);
        for (uint256 i; i < 2; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(validatorKeys[i], digest);
            signatures[i] = abi.encodePacked(r, s, v);
        }
        (uint8 iv, bytes32 ir, bytes32 is_) = vm.sign(impostorKey, digest);
        signatures[2] = abi.encodePacked(ir, is_, iv);

        vm.expectRevert();
        bridge.bridgeIn(transfer, signatures);
    }

    /*//////////////////////////////////////////////////////////////
                            LIMITS AND DELAYS
    //////////////////////////////////////////////////////////////*/

    /// @dev A daily cap bounds how much a compromised validator set can extract before anyone
    ///      reacts. It does not prevent a compromise; it buys time.
    function test_dailyLimitBoundsReleases() public {
        vm.prank(owner);
        bridge.configureToken(address(token), true, false, 5_000e18, 0);

        TokenBridge.Transfer memory first = _transfer(4_000e18, 0);
        bridge.bridgeIn(first, _sign(first, THRESHOLD));

        TokenBridge.Transfer memory second = _transfer(2_000e18, 1);
        // Signatures are built before `expectRevert`. `_sign` calls `transferDigest`, an external
        // view, which would otherwise consume the expectation and leave the real call unchecked.
        bytes[] memory secondSignatures = _sign(second, THRESHOLD);

        vm.expectRevert(
            abi.encodeWithSelector(TokenBridge.DailyLimitExceeded.selector, 2_000e18, 1_000e18)
        );
        bridge.bridgeIn(second, secondSignatures);

        // The cap resets with the UTC day.
        vm.warp(block.timestamp + 1 days);
        bridge.bridgeIn(second, secondSignatures);

        assertEq(token.balanceOf(recipient), 6_000e18);
    }

    /// @dev A large transfer is queued rather than released, giving a human time to notice and
    ///      pause. Most bridge exploits complete inside one block; a delay turns that into a race
    ///      the defenders can sometimes win.
    function test_largeTransferIsDelayed() public {
        TokenBridge.Transfer memory transfer = _transfer(200_000e18, 0);
        bytes[] memory signatures = _sign(transfer, THRESHOLD);

        // First call queues rather than releases.
        bridge.bridgeIn(transfer, signatures);

        assertEq(token.balanceOf(recipient), 0, "not released yet");
        assertGt(bridge.queuedAt(bridge.transferHash(transfer)), 0, "queued");

        // Too early.
        vm.expectRevert();
        bridge.executeQueued(transfer, signatures);

        vm.warp(block.timestamp + bridge.LARGE_TRANSFER_DELAY());
        bridge.executeQueued(transfer, signatures);

        assertEq(token.balanceOf(recipient), 200_000e18);
    }

    /// @dev The whole point of the delay: it creates a window in which pausing actually helps.
    function test_pauseStopsAQueuedTransfer() public {
        TokenBridge.Transfer memory transfer = _transfer(200_000e18, 0);
        bytes[] memory signatures = _sign(transfer, THRESHOLD);

        bridge.bridgeIn(transfer, signatures);

        vm.prank(owner);
        bridge.pause();

        vm.warp(block.timestamp + bridge.LARGE_TRANSFER_DELAY());

        vm.expectRevert(Pausable.EnforcedPause.selector);
        bridge.executeQueued(transfer, signatures);

        assertEq(token.balanceOf(recipient), 0, "attack stopped");
    }

    /*//////////////////////////////////////////////////////////////
                             VALIDATOR SET
    //////////////////////////////////////////////////////////////*/

    /// @dev A threshold that is not a strict majority means a minority can move funds, which
    ///      defeats the point of a validator set.
    function test_thresholdMustBeStrictMajority() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TokenBridge.ThresholdTooLow.selector, uint8(2), uint256(5)));
        bridge.setThreshold(2);

        vm.prank(owner);
        bridge.setThreshold(4);
        assertEq(bridge.threshold(), 4);
    }

    /// @dev A threshold larger than the remaining validator set would freeze the bridge forever.
    function test_removingValidatorCannotStrandTheThreshold() public {
        vm.startPrank(owner);
        bridge.setThreshold(3);

        bridge.removeValidator(validatorAddresses[4]);
        bridge.removeValidator(validatorAddresses[3]);

        // Down to three validators with a threshold of three. Removing another would strand it.
        vm.expectRevert(abi.encodeWithSelector(TokenBridge.ThresholdTooLow.selector, uint8(3), uint256(2)));
        bridge.removeValidator(validatorAddresses[2]);
        vm.stopPrank();
    }

    /// @dev A removed validator's signature must stop counting immediately.
    function test_removedValidatorSignatureNoLongerCounts() public {
        vm.startPrank(owner);
        bridge.setThreshold(3);
        bridge.removeValidator(validatorAddresses[0]);
        vm.stopPrank();

        TokenBridge.Transfer memory transfer = _transfer(1_000e18, 0);
        bytes[] memory signatures = _sign(transfer, THRESHOLD);

        vm.expectRevert(
            abi.encodeWithSelector(TokenBridge.NotAValidator.selector, validatorAddresses[0])
        );
        bridge.bridgeIn(transfer, signatures);
    }

    function test_onlyOwnerCanChangeValidators() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        bridge.addValidator(alice);
    }

    /*//////////////////////////////////////////////////////////////
                             BRIDGED TOKEN
    //////////////////////////////////////////////////////////////*/

    /// @dev Every unit of a bridged token must correspond to a locked unit on the home chain, so
    ///      the bridge is the only address that may mint.
    function test_bridgedToken_onlyBridgeCanMint() public {
        vm.prank(alice);
        vm.expectRevert();
        wrapped.mint(alice, 1_000e18);

        vm.prank(owner);
        vm.expectRevert();
        wrapped.mint(owner, 1_000e18);
    }

    function test_bridgedToken_hasNoInitialSupply() public view {
        assertEq(wrapped.totalSupply(), 0, "supply is entirely bridge-minted");
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev No amount, nonce or recipient combination allows a second release of the same transfer.
    function testFuzz_noTransferIsEverReleasedTwice(uint96 rawAmount, uint16 nonce) public {
        // Below the delay threshold, so it releases in one call.
        uint256 amount = bound(uint256(rawAmount), 1, 50_000e18);

        TokenBridge.Transfer memory transfer = _transfer(amount, nonce);
        bytes[] memory signatures = _sign(transfer, THRESHOLD);

        bridge.bridgeIn(transfer, signatures);
        uint256 afterFirst = token.balanceOf(recipient);

        vm.expectRevert();
        bridge.bridgeIn(transfer, signatures);

        assertEq(token.balanceOf(recipient), afterFirst, "no second release");
    }

    /// @dev Any signature count below the threshold is rejected, whatever the transfer looks like.
    function testFuzz_belowThresholdAlwaysRejected(uint8 count, uint96 rawAmount) public {
        uint256 signatureCount = bound(count, 0, THRESHOLD - 1);
        uint256 amount = bound(uint256(rawAmount), 1, 50_000e18);

        TokenBridge.Transfer memory transfer = _transfer(amount, 0);
        bytes[] memory signatures = _sign(transfer, signatureCount);

        vm.expectRevert();
        bridge.bridgeIn(transfer, signatures);
    }
}
