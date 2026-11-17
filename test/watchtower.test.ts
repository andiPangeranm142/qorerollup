/**
 * watchtower.test.ts - unit tests for the pure batch verification in
 * src/lib/rollup.ts (verifyBatch), driven directly with fixtures — not
 * through the CLI. Fixtures are built with REAL crypto: a genuine
 * ML-DSA-87 keypair signs the digest and a genuine ML-KEM-1024 keypair
 * seals the payload, so a passing fixture is a batch the real sequencer
 * could have produced.
 *
 * Run: npx hardhat test test/sequencer.test.ts test/watchtower.test.ts test/kem.test.ts
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import { generatePqcKeypair, pqcSign } from "@qorechain/sdk";
import { concat, hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import {
  GENESIS_STATE_ROOT,
  applyTxs,
  batchDigest,
  receiptHash,
  rollupTxToJson,
  txDataCommitment,
  verifyBatch,
  type BatchFile,
  type OnChainBatch,
  type RollupTx,
} from "../src/lib/rollup";
import { merkleLeafToJson } from "../src/lib/merkle";
import { generateKemKeypair, sealBatchPayload } from "../src/lib/kem";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const CHAIN_ID = 9800;

interface Fixture {
  batch: BatchFile;
  onChain: OnChainBatch;
  sequencerPublicKey: Uint8Array;
  kemSecretKey: Uint8Array;
  prevBalances: Map<Address, bigint>;
  prevNonces: Map<Address, number>;
}

/** Build a fully valid batch-0 fixture, exactly as the sequencer would. */
function makeValidFixture(): Fixture {
  const dsa = generatePqcKeypair();
  const kem = generateKemKeypair();
  const prevBalances = new Map<Address, bigint>([[ALICE, 1000n]]);
  const prevNonces = new Map<Address, number>();
  const txs: RollupTx[] = [{ from: ALICE, to: BOB, amount: 100n, nonce: 0 }];
  const { newStateRoot, newBalances, newNonces, leaves, proofs } = applyTxs(
    GENESIS_STATE_ROOT,
    prevBalances,
    txs,
    prevNonces,
  );
  const commitment = txDataCommitment(txs);
  const payload = JSON.stringify({
    batchId: 0,
    prevStateRoot: GENESIS_STATE_ROOT,
    txs: txs.map(rollupTxToJson),
    newStateRoot,
  });
  const { kemCiphertext, sealedBlob } = sealBatchPayload(kem.publicKey, payload);
  const encryptedDataHash = keccak256(concat([toHex(kemCiphertext), toHex(sealedBlob)]));
  const digest = batchDigest(CHAIN_ID, CONTRACT, 0, newStateRoot, commitment, encryptedDataHash);
  const signature = toHex(pqcSign(dsa.secretKey, hexToBytes(digest)));
  const receipt = receiptHash(CHAIN_ID, CONTRACT, 0, newStateRoot, commitment);
  const batch: BatchFile = {
    batchId: 0,
    txs: txs.map(rollupTxToJson),
    prevStateRoot: GENESIS_STATE_ROOT,
    stateRoot: newStateRoot,
    txDataCommitment: commitment,
    encryptedDataHash,
    kemCiphertext: toHex(kemCiphertext),
    sealedBlob: toHex(sealedBlob),
    signature,
    digest,
    submitTx: ("0x" + "11".repeat(32)) as Hex,
    cosmosTx: "AA".repeat(32),
    block: 12345,
    receiptHash: receipt,
    balances: Object.fromEntries(
      [...newBalances.entries()].map(([addr, bal]) => [addr, bal.toString()]),
    ),
    nonces: Object.fromEntries(newNonces.entries()),
    leaves: leaves.map(merkleLeafToJson),
    proofs,
  };
  const onChain: OnChainBatch = {
    stateRoot: newStateRoot,
    txDataCommitment: commitment,
    encryptedDataHash,
    timestamp: 1700000000n,
    receiptHash: receipt,
  };
  return {
    batch,
    onChain,
    sequencerPublicKey: dsa.publicKey,
    kemSecretKey: kem.secretKey,
    prevBalances,
    prevNonces,
  };
}

function verify(f: Fixture, kemSecretKey?: Uint8Array) {
  return verifyBatch(f.batch, f.onChain, {
    chainId: CHAIN_ID,
    contract: CONTRACT,
    batchId: 0,
    sequencerPublicKey: f.sequencerPublicKey,
    prevStateRoot: GENESIS_STATE_ROOT,
    prevBalances: f.prevBalances,
    prevNonces: f.prevNonces,
    kemSecretKey: kemSecretKey === undefined ? f.kemSecretKey : kemSecretKey,
  });
}

describe("verifyBatch", () => {
  it("accepts a fully valid batch (all checks, decrypt included)", () => {
    const f = makeValidFixture();
    const result = verify(f);
    expect(result.ok).to.equal(true);
    expect(result.failures).to.deep.equal([]);
    expect(result.decryptSkipped).to.equal(false);
  });

  it("flags a tampered state root in the batch file", () => {
    const f = makeValidFixture();
    f.batch.stateRoot = keccak256("0xdeadbeef");
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/stateRoot|state root/);
  });

  it("flags a tampered state root in the on-chain record", () => {
    const f = makeValidFixture();
    f.onChain.stateRoot = keccak256("0xdeadbeef");
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/stateRoot|state root|signature/);
  });

  it("flags a bad signature (flipped byte)", () => {
    const f = makeValidFixture();
    const sig = hexToBytes(f.batch.signature);
    sig[100] ^= 0x01;
    f.batch.signature = toHex(sig);
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/signature/);
  });

  it("flags a signature from a different key", () => {
    const f = makeValidFixture();
    const other = generatePqcKeypair();
    f.batch.signature = toHex(pqcSign(other.secretKey, hexToBytes(f.batch.digest)));
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/signature/);
  });

  it("flags a tampered transaction amount in the batch file", () => {
    const f = makeValidFixture();
    f.batch.txs[0].amount = "101";
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/txDataCommitment|state root/);
  });

  it("flags a tampered encrypted-data hash", () => {
    const f = makeValidFixture();
    f.batch.encryptedDataHash = keccak256("0xdeadbeef");
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/encryptedDataHash/);
  });

  it("flags a wrong on-chain receipt hash", () => {
    const f = makeValidFixture();
    f.onChain.receiptHash = keccak256("0xdeadbeef");
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/receiptHash/);
  });

  it("flags a tampered sealed blob (decrypt check)", () => {
    const f = makeValidFixture();
    const blob = hexToBytes(f.batch.sealedBlob);
    blob[blob.length - 1] ^= 0xff;
    f.batch.sealedBlob = toHex(blob);
    const result = verify(f);
    expect(result.ok).to.equal(false);
    // The encrypted-data hash changes too; either failure proves detection.
    expect(result.failures.join(" ")).to.match(/decrypt|encryptedDataHash/);
  });

  it("flags a wrong previous state root", () => {
    const f = makeValidFixture();
    f.batch.prevStateRoot = keccak256("0xdeadbeef");
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/prevStateRoot/);
  });

  it("skips the decrypt check when no KEM key is given, and still passes a valid batch", () => {
    const f = makeValidFixture();
    const result = verifyBatch(f.batch, f.onChain, {
      chainId: CHAIN_ID,
      contract: CONTRACT,
      batchId: 0,
      sequencerPublicKey: f.sequencerPublicKey,
      prevStateRoot: GENESIS_STATE_ROOT,
      prevBalances: f.prevBalances,
      prevNonces: f.prevNonces,
    });
    expect(result.ok).to.equal(true);
    expect(result.decryptSkipped).to.equal(true);
  });

  it("flags a batch id that does not match its position", () => {
    const f = makeValidFixture();
    f.batch.batchId = 7;
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/batch id/);
  });

  it("flags a state transition that cannot replay (insufficient balance)", () => {
    const f = makeValidFixture();
    // The pre-batch state the watchtower chains from has too little funding.
    const result = verifyBatch(f.batch, f.onChain, {
      chainId: CHAIN_ID,
      contract: CONTRACT,
      batchId: 0,
      sequencerPublicKey: f.sequencerPublicKey,
      prevStateRoot: GENESIS_STATE_ROOT,
      prevBalances: new Map([[ALICE, 50n]]),
      prevNonces: new Map(),
      kemSecretKey: f.kemSecretKey,
    });
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/replay|insufficient/);
  });

  it("flags a tampered leaf balance in the batch file", () => {
    const f = makeValidFixture();
    // Inflate BOB's leaf balance without touching the leaf hash: the leaf
    // hash no longer matches its (account, balance, nonce).
    const bobLeaf = f.batch.leaves.find(
      (l) => l.account.toLowerCase() === BOB.toLowerCase(),
    ) as { balance: string };
    bobLeaf.balance = "999999";
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/leaf/);
  });

  it("flags a tampered leaf hash in the batch file", () => {
    const f = makeValidFixture();
    f.batch.leaves[0] = {
      ...f.batch.leaves[0],
      leaf: keccak256("0xdeadbeef"),
    } as (typeof f.batch.leaves)[number];
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/leaf|Merkle|stateRoot/);
  });

  it("flags a tampered Merkle proof in the batch file", () => {
    const f = makeValidFixture();
    const aliceProof = f.batch.proofs[ALICE.toLowerCase()] as Hex[];
    aliceProof[0] = keccak256("0xdeadbeef");
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/proof/);
  });

  it("flags a missing Merkle proof in the batch file", () => {
    const f = makeValidFixture();
    delete f.batch.proofs[BOB.toLowerCase()];
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/proof/);
  });

  it("flags a batch file with no Merkle leaves at all (pre-v2 file)", () => {
    const f = makeValidFixture();
    delete (f.batch as Partial<BatchFile>).leaves;
    delete (f.batch as Partial<BatchFile>).proofs;
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/Merkle leaves/);
  });
});
