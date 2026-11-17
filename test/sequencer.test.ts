/**
 * sequencer.test.ts - unit tests for the pure batch math in src/lib/rollup.ts.
 * No chain involved: encoding determinism, commitments, state transitions,
 * and digest formulas pinned against independently recomputed values.
 *
 * Run: npx hardhat test test/sequencer.test.ts test/watchtower.test.ts test/kem.test.ts
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import { concat, encodePacked, keccak256, stringToHex, toHex, type Address } from "viem";
import {
  GENESIS_STATE_ROOT,
  applyTxs,
  batchDigest,
  encodeTx,
  receiptHash,
  txDataCommitment,
  type RollupTx,
} from "../src/lib/rollup";
import { buildStateTree, verifyProof } from "../src/lib/merkle";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const CAROL = "0x3333333333333333333333333333333333333333" as Address;
const CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;

const tx = (from: Address, to: Address, amount: bigint, nonce: number): RollupTx => ({
  from,
  to,
  amount,
  nonce,
});

describe("encodeTx", () => {
  it("is deterministic and equals abi.encodePacked(from, to, amount, nonce)", () => {
    const t = tx(ALICE, BOB, 12345n, 7);
    const expected = concat([
      ALICE,
      BOB,
      toHex(12345n, { size: 32 }),
      toHex(7n, { size: 32 }),
    ]);
    expect(encodeTx(t)).to.equal(expected);
    expect(encodeTx(t)).to.equal(encodeTx(tx(ALICE, BOB, 12345n, 7)));
  });

  it("changes when any field changes", () => {
    const base = encodeTx(tx(ALICE, BOB, 100n, 0));
    expect(encodeTx(tx(BOB, BOB, 100n, 0))).to.not.equal(base);
    expect(encodeTx(tx(ALICE, CAROL, 100n, 0))).to.not.equal(base);
    expect(encodeTx(tx(ALICE, BOB, 101n, 0))).to.not.equal(base);
    expect(encodeTx(tx(ALICE, BOB, 100n, 1))).to.not.equal(base);
  });
});

describe("txDataCommitment", () => {
  it("is deterministic and order-sensitive", () => {
    const txs = [tx(ALICE, BOB, 10n, 0), tx(BOB, CAROL, 5n, 0)];
    expect(txDataCommitment(txs)).to.equal(txDataCommitment(txs));
    expect(txDataCommitment([txs[1], txs[0]])).to.not.equal(txDataCommitment(txs));
    expect(txDataCommitment(txs)).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("changes when any tx changes", () => {
    const base = txDataCommitment([tx(ALICE, BOB, 10n, 0)]);
    expect(txDataCommitment([tx(ALICE, BOB, 11n, 0)])).to.not.equal(base);
    expect(txDataCommitment([tx(ALICE, BOB, 10n, 0), tx(BOB, CAROL, 1n, 0)])).to.not.equal(base);
  });

  it("throws on an empty list", () => {
    expect(() => txDataCommitment([])).to.throw("empty transaction list");
  });
});

describe("GENESIS_STATE_ROOT", () => {
  it("is keccak256 of the utf8 genesis tag", () => {
    expect(GENESIS_STATE_ROOT).to.equal(keccak256(stringToHex("QoreRollup.genesis")));
    expect(GENESIS_STATE_ROOT).to.match(/^0x[0-9a-f]{64}$/);
  });
});

describe("applyTxs", () => {
  const funded = new Map<Address, bigint>([
    [ALICE, 1000n],
    [BOB, 50n],
  ]);

  it("moves balances, bumps the nonce, and changes the root", () => {
    const { newStateRoot, newBalances, newNonces } = applyTxs(
      GENESIS_STATE_ROOT,
      funded,
      [tx(ALICE, BOB, 100n, 0)],
    );
    expect(newBalances.get(ALICE.toLowerCase() as Address)).to.equal(900n);
    expect(newBalances.get(BOB.toLowerCase() as Address)).to.equal(150n);
    expect(newNonces.get(ALICE.toLowerCase() as Address)).to.equal(1);
    expect(newStateRoot).to.not.equal(GENESIS_STATE_ROOT);
    expect(newStateRoot).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    const a = applyTxs(GENESIS_STATE_ROOT, funded, [tx(ALICE, BOB, 100n, 0)]);
    const b = applyTxs(GENESIS_STATE_ROOT, funded, [tx(ALICE, BOB, 100n, 0)]);
    expect(a.newStateRoot).to.equal(b.newStateRoot);
  });

  it("chains: the second batch builds on the first batch's root", () => {
    const first = applyTxs(GENESIS_STATE_ROOT, funded, [tx(ALICE, BOB, 100n, 0)]);
    const second = applyTxs(first.newStateRoot, first.newBalances, [tx(ALICE, CAROL, 50n, 1)], first.newNonces);
    expect(second.newBalances.get(CAROL.toLowerCase() as Address)).to.equal(50n);
    expect(second.newStateRoot).to.not.equal(first.newStateRoot);
  });

  it("commits to the sorted balance set, not the tx order", () => {
    // Two different orderings that reach the same final balances.
    const a = applyTxs(GENESIS_STATE_ROOT, funded, [
      tx(ALICE, BOB, 10n, 0),
      tx(ALICE, CAROL, 5n, 1),
    ]);
    const b = applyTxs(GENESIS_STATE_ROOT, funded, [
      tx(ALICE, CAROL, 5n, 0),
      tx(ALICE, BOB, 10n, 1),
    ]);
    expect(a.newStateRoot).to.equal(b.newStateRoot);
  });

  it("drops a drained account from the commitment", () => {
    const drained = applyTxs(GENESIS_STATE_ROOT, funded, [tx(BOB, ALICE, 50n, 0)]);
    expect(drained.newBalances.has(BOB.toLowerCase() as Address)).to.equal(false);
    // The root is the Merkle root over the remaining leaves only: BOB
    // has no leaf once drained.
    expect(drained.leaves.map((l) => l.account)).to.deep.equal([
      ALICE.toLowerCase(),
    ]);
    const { root } = buildStateTree(drained.newBalances, drained.newNonces);
    expect(drained.newStateRoot).to.equal(root);
    // ... but it is NOT the same root as a batch that reaches the same
    // balances without BOB ever holding funds: the nonce is part of the
    // leaf, so ALICE's nonce differs (0 here, 1 there) and the roots
    // differ. A drained account leaves no leaf, but its history still
    // shows in the nonces.
    const withoutBob = applyTxs(
      GENESIS_STATE_ROOT,
      new Map([[ALICE, 1050n]]),
      [tx(ALICE, ALICE, 1n, 0)],
    );
    expect(drained.newStateRoot).to.not.equal(withoutBob.newStateRoot);
  });

  it("returns leaves and proofs that verify against the new root", () => {
    const { newStateRoot, leaves, proofs } = applyTxs(
      GENESIS_STATE_ROOT,
      funded,
      [tx(ALICE, BOB, 100n, 0), tx(ALICE, CAROL, 50n, 1)],
    );
    expect(leaves.map((l) => l.account)).to.deep.equal([
      ALICE.toLowerCase(),
      BOB.toLowerCase(),
      CAROL.toLowerCase(),
    ]);
    for (const leaf of leaves) {
      const proof = proofs[leaf.account.toLowerCase()] as `0x${string}`[];
      expect(verifyProof(leaf.leaf, proof, newStateRoot)).to.equal(true);
    }
    expect(Object.keys(proofs).sort()).to.deep.equal(
      leaves.map((l) => l.account.toLowerCase()).sort(),
    );
  });

  it("the root is the Merkle root over the post-state leaves", () => {
    const applied = applyTxs(GENESIS_STATE_ROOT, funded, [tx(ALICE, BOB, 100n, 0)]);
    const { root } = buildStateTree(applied.newBalances, applied.newNonces);
    expect(applied.newStateRoot).to.equal(root);
  });

  it("the root changes when a balance changes", () => {
    const a = applyTxs(GENESIS_STATE_ROOT, funded, [tx(ALICE, BOB, 100n, 0)]);
    const b = applyTxs(GENESIS_STATE_ROOT, funded, [tx(ALICE, BOB, 101n, 0)]);
    expect(a.newStateRoot).to.not.equal(b.newStateRoot);
  });

  it("reverts on insufficient balance", () => {
    expect(() => applyTxs(GENESIS_STATE_ROOT, funded, [tx(ALICE, BOB, 1001n, 0)])).to.throw(
      "insufficient balance",
    );
    expect(() => applyTxs(GENESIS_STATE_ROOT, funded, [tx(CAROL, BOB, 1n, 0)])).to.throw(
      "insufficient balance",
    );
  });

  it("reverts on a wrong nonce (replay or gap)", () => {
    expect(() => applyTxs(GENESIS_STATE_ROOT, funded, [tx(ALICE, BOB, 10n, 1)])).to.throw(
      "wrong nonce",
    );
    expect(() =>
      applyTxs(GENESIS_STATE_ROOT, funded, [tx(ALICE, BOB, 10n, 0), tx(ALICE, BOB, 10n, 0)]),
    ).to.throw("wrong nonce");
  });

  it("reverts on a non-positive amount", () => {
    expect(() => applyTxs(GENESIS_STATE_ROOT, funded, [tx(ALICE, BOB, 0n, 0)])).to.throw(
      "must be positive",
    );
  });

  it("reverts on an empty list", () => {
    expect(() => applyTxs(GENESIS_STATE_ROOT, funded, [])).to.throw("empty transaction list");
  });

  it("treats checksummed and lowercase spellings as one account", () => {
    const checksummed = "0x1111111111111111111111111111111111111111" as Address;
    const { newBalances } = applyTxs(GENESIS_STATE_ROOT, funded, [
      tx(checksummed, BOB, 10n, 0),
    ]);
    expect(newBalances.get(ALICE.toLowerCase() as Address)).to.equal(990n);
  });
});

describe("batchDigest", () => {
  it("matches the documented formula exactly", () => {
    const stateRoot = keccak256(stringToHex("root"));
    const commitment = keccak256(stringToHex("commit"));
    const encHash = keccak256(stringToHex("enc"));
    const expected = keccak256(
      encodePacked(
        ["string", "uint256", "address", "uint256", "bytes32", "bytes32", "bytes32"],
        ["QoreRollup.batch", 9800n, CONTRACT, 3n, stateRoot, commitment, encHash],
      ),
    );
    expect(batchDigest(9800, CONTRACT, 3, stateRoot, commitment, encHash)).to.equal(expected);
  });

  it("binds every field: changing any input changes the digest", () => {
    const root = keccak256(stringToHex("root"));
    const commit = keccak256(stringToHex("commit"));
    const enc = keccak256(stringToHex("enc"));
    const base = batchDigest(9800, CONTRACT, 0, root, commit, enc);
    expect(batchDigest(9801, CONTRACT, 0, root, commit, enc)).to.not.equal(base);
    expect(batchDigest(9800, BOB, 0, root, commit, enc)).to.not.equal(base);
    expect(batchDigest(9800, CONTRACT, 1, root, commit, enc)).to.not.equal(base);
    expect(batchDigest(9800, CONTRACT, 0, commit, commit, enc)).to.not.equal(base);
    expect(batchDigest(9800, CONTRACT, 0, root, enc, enc)).to.not.equal(base);
    expect(batchDigest(9800, CONTRACT, 0, root, commit, root)).to.not.equal(base);
  });
});

describe("receiptHash", () => {
  it("matches the documented formula exactly and differs from batchDigest", () => {
    const root = keccak256(stringToHex("root"));
    const commit = keccak256(stringToHex("commit"));
    const expected = keccak256(
      encodePacked(
        ["string", "uint256", "address", "uint256", "bytes32", "bytes32"],
        ["QoreRollup.receipt", 9800n, CONTRACT, 2n, root, commit],
      ),
    );
    expect(receiptHash(9800, CONTRACT, 2, root, commit)).to.equal(expected);
    expect(receiptHash(9800, CONTRACT, 2, root, commit)).to.not.equal(
      batchDigest(9800, CONTRACT, 2, root, commit, commit),
    );
  });

  it("binds every field", () => {
    const root = keccak256(stringToHex("root"));
    const commit = keccak256(stringToHex("commit"));
    const base = receiptHash(9800, CONTRACT, 0, root, commit);
    expect(receiptHash(9801, CONTRACT, 0, root, commit)).to.not.equal(base);
    expect(receiptHash(9800, CONTRACT, 1, root, commit)).to.not.equal(base);
    expect(receiptHash(9800, CONTRACT, 0, commit, commit)).to.not.equal(base);
    expect(receiptHash(9800, CONTRACT, 0, root, root)).to.not.equal(base);
  });
});
