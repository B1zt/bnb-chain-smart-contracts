// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal Merkle tree builder for tests.
/// @dev Matches OpenZeppelin's {MerkleProof}, which hashes sibling pairs in sorted order so the
///      proof does not need to encode left/right position. Odd nodes at a level are promoted
///      unchanged to the next level, which is also what the JS implementations do.
///
///      This lives in `test/` on purpose. Trees are built off-chain in production; the on-chain
///      contract only ever verifies a proof.
library MerkleLib {
    /// @notice Compute the Merkle root of `leaves`.
    function getRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "MerkleLib: empty");
        if (leaves.length == 1) return leaves[0];

        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = _nextLevel(level);
        }
        return level[0];
    }

    /// @notice Build the proof for the leaf at `index`.
    function getProof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory proof) {
        require(index < leaves.length, "MerkleLib: index out of range");

        // Depth is bounded by log2(n) + 1; allocate generously and trim at the end.
        bytes32[] memory scratch = new bytes32[](256);
        uint256 count;

        bytes32[] memory level = leaves;
        uint256 position = index;

        while (level.length > 1) {
            // A promoted odd node has no sibling at this level, so it contributes nothing.
            if (position ^ 1 < level.length) {
                scratch[count++] = level[position ^ 1];
            }
            position /= 2;
            level = _nextLevel(level);
        }

        proof = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            proof[i] = scratch[i];
        }
    }

    function _nextLevel(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        uint256 length = (level.length + 1) / 2;
        next = new bytes32[](length);

        for (uint256 i; i < length; ++i) {
            uint256 left = i * 2;
            uint256 right = left + 1;
            next[i] = right < level.length ? _hashPair(level[left], level[right]) : level[left];
        }
    }

    /// @dev Commutative hash, matching OZ's `Hashes.commutativeKeccak256`.
    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }
}
