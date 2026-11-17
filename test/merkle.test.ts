/**
 * merkle.test.ts - unit tests for the Merkle tree in src/lib/merkle.ts.
 * No chain involved: leaf encoding, sorted-pair tree building, proofs
 * for odd leaf counts, and the empty/single-leaf edge cases.
 *
 * The cross-check against the SOLIDITY verifier lives in
 * test/QoreRollup.test.ts (withdraw with a TS-computed proof).
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import { concat, encodePacked, keccak256, toHex, type Address, type Hex } from "viem";
import {
  EMPTY_MERKLE_ROOT,
  buildMerkleTree,
  buildStateTree,
  getProof,
  hashPair,
  leafHash,
  stateLeaves,
  verifyProof,
} from "../src/lib/merkle";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const CAROL = "0x3333333333333333333333333333333333333333" as Address;
const DAVE = "0x4444444444444444444444444444444444444444" as Address;
const ERIN = "0x5555555555555555555555555555555555555555" as Address;

function leaf(account: Address, balance: bigint, nonce: number): Hex {
  return leafHash(account, balance, nonce);
}

describe("leafHash", () => {
  it("equals keccak256(abi.encodePacked(account, balance, nonce))", () => {
    const expected = keccak256(
      concat([
        ALICE,
        toHex(12345n, { size: 32 }),
        toHex(7n, { size: 32 }),
      ]),
    );
    expect(leaf(ALICE, 12345n, 7)).to.equal(expected);
    // Same encoding via encodePacked (the viem spelling the contract must match).
    expect(
      keccak256(
        encodePacked(
          ["address", "uint256", "uint256"],
          [ALICE, 12345n, 7n],
        ),
      ),
    ).to.equal(expected);
  });

  it("changes when any field changes", () => {
    const base = leaf(ALICE, 100n, 0);
    expect(leaf(BOB, 100n, 0)).to.not.equal(base);
    expect(leaf(ALICE, 101n, 0)).to.not.equal(base);
    expect(leaf(ALICE, 100n, 1)).to.not.equal(base);
  });
});

describe("hashPair", () => {
  it("sorts the pair: hashPair(a, b) == hashPair(b, a)", () => {
    const a = keccak256("0x01");
    const b = keccak256("0x02");
    expect(hashPair(a, b)).to.equal(hashPair(b, a));
    const [first, second] = a < b ? [a, b] : [b, a];
    expect(hashPair(a, b)).to.equal(keccak256(concat([first, second])));
  });
});

describe("buildMerkleTree", () => {
  it("empty set: root is bytes32(0)", () => {
    const { root, layers } = buildMerkleTree([]);
    expect(root).to.equal(EMPTY_MERKLE_ROOT);
    expect(layers).to.deep.equal([[]]);
  });

  it("single leaf: root is the leaf, proof is empty", () => {
    const l = leaf(ALICE, 100n, 0);
    const { root, layers } = buildMerkleTree([l]);
    expect(root).to.equal(l);
    expect(layers).to.deep.equal([[l]]);
    expect(getProof([l], 0)).to.deep.equal([]);
    expect(verifyProof(l, [], root)).to.equal(true);
  });

  it("two leaves: root is the sorted-pair hash", () => {
    const a = leaf(ALICE, 100n, 0);
    const b = leaf(BOB, 200n, 0);
    const { root } = buildMerkleTree([a, b]);
    expect(root).to.equal(hashPair(a, b));
    expect(verifyProof(a, getProof([a, b], 0), root)).to.equal(true);
    expect(verifyProof(b, getProof([a, b], 1), root)).to.equal(true);
  });

  it("three leaves: the odd leaf is promoted unchanged", () => {
    const a = leaf(ALICE, 100n, 0);
    const b = leaf(BOB, 200n, 0);
    const c = leaf(CAROL, 300n, 0);
    const { root, layers } = buildMerkleTree([a, b, c]);
    // Level 1: [hash(a,b), c] — c promoted, not duplicated or re-hashed.
    expect(layers[1]).to.deep.equal([hashPair(a, b), c]);
    expect(root).to.equal(hashPair(hashPair(a, b), c));
    for (let i = 0; i < 3; i++) {
      expect(verifyProof([a, b, c][i] as Hex, getProof([a, b, c], i), root)).to.equal(true);
    }
    // The promoted leaf's proof has one element (the level-1 pair hash).
    expect(getProof([a, b, c], 2)).to.deep.equal([hashPair(a, b)]);
  });

  it("five leaves: every proof verifies", () => {
    const leaves = [
      leaf(ALICE, 100n, 0),
      leaf(BOB, 200n, 1),
      leaf(CAROL, 300n, 0),
      leaf(DAVE, 400n, 2),
      leaf(ERIN, 500n, 0),
    ];
    const { root } = buildMerkleTree(leaves);
    leaves.forEach((l, i) => {
      expect(verifyProof(l, getProof(leaves, i), root)).to.equal(true);
    });
  });

  it("is deterministic and order-sensitive at the leaf level", () => {
    const a = leaf(ALICE, 100n, 0);
    const b = leaf(BOB, 200n, 0);
    const c = leaf(CAROL, 300n, 0);
    expect(buildMerkleTree([a, b, c]).root).to.equal(buildMerkleTree([a, b, c]).root);
    // Sorted pairs make the 2-leaf root order-insensitive, but with 3+
    // leaves the pairing structure depends on leaf order.
    expect(buildMerkleTree([a, b, c]).root).to.not.equal(buildMerkleTree([c, b, a]).root);
  });
});

describe("getProof / verifyProof", () => {
  it("rejects a tampered proof element", () => {
    const leaves = [leaf(ALICE, 100n, 0), leaf(BOB, 200n, 0), leaf(CAROL, 300n, 0)];
    const { root } = buildMerkleTree(leaves);
    const proof = getProof(leaves, 0);
    const tampered = [...proof];
    tampered[0] = keccak256("0xdeadbeef");
    expect(verifyProof(leaves[0] as Hex, tampered, root)).to.equal(false);
  });

  it("rejects a proof for the wrong leaf (swapped accounts)", () => {
    const leaves = [leaf(ALICE, 100n, 0), leaf(BOB, 200n, 0)];
    const { root } = buildMerkleTree(leaves);
    // Alice's proof does not prove Bob's leaf, and vice versa.
    expect(verifyProof(leaves[1] as Hex, getProof(leaves, 0), root)).to.equal(false);
    expect(verifyProof(leaves[0] as Hex, getProof(leaves, 1), root)).to.equal(false);
  });

  it("rejects a proof against the wrong root", () => {
    const leaves = [leaf(ALICE, 100n, 0), leaf(BOB, 200n, 0)];
    const otherRoot = buildMerkleTree([leaf(ALICE, 101n, 0), leaf(BOB, 200n, 0)]).root;
    expect(verifyProof(leaves[0] as Hex, getProof(leaves, 0), otherRoot)).to.equal(false);
  });

  it("throws on an out-of-range index", () => {
    const leaves = [leaf(ALICE, 100n, 0)];
    expect(() => getProof(leaves, 1)).to.throw("out of range");
    expect(() => getProof(leaves, -1)).to.throw("out of range");
  });
});

describe("stateLeaves / buildStateTree", () => {
  it("sorts leaves ascending by address and omits zero balances", () => {
    const balances = new Map<Address, bigint>([
      [CAROL, 300n],
      [ALICE, 100n],
      [BOB, 0n],
    ]);
    const nonces = new Map<Address, number>([[CAROL, 2]]);
    const leaves = stateLeaves(balances, nonces);
    expect(leaves.map((l) => l.account)).to.deep.equal([
      ALICE.toLowerCase(),
      CAROL.toLowerCase(),
    ]);
    expect(leaves[0]?.leaf).to.equal(leaf(ALICE, 100n, 0));
    expect(leaves[1]?.leaf).to.equal(leaf(CAROL, 300n, 2));
    expect(leaves[1]?.nonce).to.equal(2);
  });

  it("buildStateTree returns a root and a verifying proof per account", () => {
    const balances = new Map<Address, bigint>([
      [ALICE, 100n],
      [BOB, 200n],
      [CAROL, 300n],
    ]);
    const nonces = new Map<Address, number>([[BOB, 1]]);
    const { root, leaves, proofs } = buildStateTree(balances, nonces);
    expect(root).to.equal(buildMerkleTree(leaves.map((l) => l.leaf)).root);
    for (const l of leaves) {
      const proof = proofs[l.account.toLowerCase()] as Hex[];
      expect(verifyProof(l.leaf, proof, root)).to.equal(true);
    }
    expect(Object.keys(proofs).sort()).to.deep.equal(
      [ALICE, BOB, CAROL].map((a) => a.toLowerCase()).sort(),
    );
  });
});
