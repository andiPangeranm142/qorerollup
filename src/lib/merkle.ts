/**
 * merkle.ts - binary Merkle tree for QoreRollup state roots (v2).
 *
 * The state root of a batch is the Merkle root over the post-batch state:
 * one leaf per account with a non-zero balance, sorted ascending by
 * address for determinism.
 *
 * Leaf: keccak256(abi.encodePacked(account, balance, nonce))
 *   - account: the rollup address (20 bytes)
 *   - balance: the account's rollup balance in uqor (uint256)
 *   - nonce:   the account's rollup nonce at that batch (uint256)
 *
 * Tree: binary Merkle tree with SORTED pairs (the OpenZeppelin MerkleProof
 * convention): each internal node is keccak256(min(left, right) ||
 * max(left, right)); an odd node at a level is promoted unchanged to the
 * next level. A single-leaf tree has root == the leaf and an empty proof;
 * an empty set has root bytes32(0).
 *
 * The TypeScript implementation here MUST agree byte-for-byte with the
 * inline verifier in contracts/QoreRollup.sol (withdraw): the Hardhat
 * contract tests prove a TS-computed proof against the contract, and the
 * watchtower re-verifies every leaf's proof off-chain. If you change the
 * leaf encoding or the pairing rule here, change the contract too — and
 * both test suites will catch a mismatch.
 */
import { concat, encodePacked, keccak256, type Address, type Hex } from "viem";

/** The Merkle root of an empty leaf set. */
export const EMPTY_MERKLE_ROOT: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** One state leaf: an account's (balance, nonce) at a batch. */
export interface MerkleLeaf {
  account: Address;
  balance: bigint;
  nonce: number;
  leaf: Hex;
}

/** A state leaf as stored in JSON files (bigint is not JSON-safe). */
export interface MerkleLeafJson {
  account: Address;
  /** Balance in uqor, as a decimal string. */
  balance: string;
  nonce: number;
  leaf: Hex;
}

export function merkleLeafToJson(leaf: MerkleLeaf): MerkleLeafJson {
  return {
    account: leaf.account,
    balance: leaf.balance.toString(),
    nonce: leaf.nonce,
    leaf: leaf.leaf,
  };
}

export function merkleLeafFromJson(json: MerkleLeafJson): MerkleLeaf {
  return {
    account: json.account,
    balance: BigInt(json.balance),
    nonce: json.nonce,
    leaf: json.leaf,
  };
}

/**
 * The leaf hash for one account: keccak256(abi.encodePacked(account,
 * balance, nonce)). Uses viem encodePacked so the encoding matches
 * Solidity's abi.encodePacked byte-for-byte.
 */
export function leafHash(
  account: Address,
  balance: bigint,
  nonce: number | bigint,
): Hex {
  return keccak256(
    encodePacked(
      ["address", "uint256", "uint256"],
      [account, balance, BigInt(nonce)],
    ),
  );
}

/**
 * Hash two tree nodes with the sorted-pair rule (OpenZeppelin
 * MerkleProof convention): the smaller hash goes first. Comparing the
 * 0x-prefixed hex strings lexicographically is a byte comparison because
 * both are fixed-length lowercase hex.
 */
export function hashPair(a: Hex, b: Hex): Hex {
  const [first, second] =
    a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([first, second]));
}

export interface MerkleTree {
  root: Hex;
  /** layers[0] is the leaves; layers[layers.length - 1] is [root]. */
  layers: Hex[][];
}

/**
 * Build a binary Merkle tree with sorted pairs over the given leaves, in
 * order. The caller is responsible for leaf order (state leaves are
 * sorted ascending by address — see stateLeaves). An odd node at a level
 * is promoted unchanged. Empty input gives root bytes32(0).
 */
export function buildMerkleTree(leaves: Hex[]): MerkleTree {
  if (leaves.length === 0) {
    return { root: EMPTY_MERKLE_ROOT, layers: [[]] };
  }
  const layers: Hex[][] = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1] as Hex[];
    const next: Hex[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i] as Hex;
      const right = current[i + 1];
      // Odd node: promoted unchanged (no pairing, no duplication).
      next.push(right === undefined ? left : hashPair(left, right));
    }
    layers.push(next);
  }
  return { root: (layers[layers.length - 1] as Hex[])[0] as Hex, layers };
}

/**
 * The Merkle proof for the leaf at `index`: the sibling hashes needed to
 * recompute the root, bottom-up. A promoted odd node contributes no
 * element at its level. Single-leaf tree: proof is [].
 */
export function getProof(leaves: Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) {
    throw new Error(
      `leaf index ${index} out of range for a tree of ${leaves.length} leaves`,
    );
  }
  const { layers } = buildMerkleTree(leaves);
  const proof: Hex[] = [];
  let idx = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level] as Hex[];
    const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (siblingIndex < layer.length) {
      proof.push(layer[siblingIndex] as Hex);
    }
    // Promoted odd node: no sibling at this level, nothing to push.
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Verify a proof against a root with the sorted-pair rule — the same
 * fold the contract performs in withdraw(). Returns false for a bad
 * proof instead of throwing.
 */
export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let computed = leaf;
  for (const element of proof) {
    computed = hashPair(computed, element);
  }
  return computed.toLowerCase() === root.toLowerCase();
}

/**
 * Build the state leaves for a balance set: one leaf per NON-ZERO
 * balance, sorted ascending by (lowercase) address. The nonce comes from
 * the nonce map (default 0). Zero-balance accounts have no leaf — there
 * is nothing to prove for them, and a drained account leaves no trace in
 * the tree.
 */
export function stateLeaves(
  balances: Map<Address, bigint>,
  nonces: Map<Address, number>,
): MerkleLeaf[] {
  const entries = [...balances.entries()]
    .filter(([, bal]) => bal !== 0n)
    .map(([addr]) => addr.toLowerCase() as Address)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map((account) => {
    const balance = balances.get(account) as bigint;
    const nonce = nonces.get(account) ?? 0;
    return { account, balance, nonce, leaf: leafHash(account, balance, nonce) };
  });
}

/**
 * Build the full state tree for a balance set: the leaves, the root, and
 * a proof per account (keyed by lowercase address). This is what the
 * sequencer stores in the batch file so any account can withdraw with
 * its proof and no sequencer help.
 */
export function buildStateTree(
  balances: Map<Address, bigint>,
  nonces: Map<Address, number>,
): { root: Hex; leaves: MerkleLeaf[]; proofs: Record<string, Hex[]> } {
  const leaves = stateLeaves(balances, nonces);
  const leafHashes = leaves.map((l) => l.leaf);
  const { root } = buildMerkleTree(leafHashes);
  const proofs: Record<string, Hex[]> = {};
  leaves.forEach((leaf, i) => {
    proofs[leaf.account.toLowerCase()] = getProof(leafHashes, i);
  });
  return { root, leaves, proofs };
}
