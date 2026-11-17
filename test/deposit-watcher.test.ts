/**
 * deposit-watcher.test.ts - unit tests for the deposit-ingestion logic
 * (src/lib/deposits.ts), the deposit-aware state transition
 * (applyDeposits in src/lib/rollup.ts), and batch verification with
 * deposits (verifyBatch). No chain involved: logs are fixtures, and the
 * verifyBatch fixtures use REAL crypto (a genuine ML-DSA-87 keypair
 * signs the digest, a genuine ML-KEM-1024 keypair seals the payload),
 * exactly like test/watchtower.test.ts.
 *
 * Run: npx hardhat test test/deposit-watcher.test.ts
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import { generatePqcKeypair, pqcSign } from "@qorechain/sdk";
import { concat, hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import {
  depositKey,
  markDepositsSettled,
  mergeDeposits,
  parseDepositedLog,
  pendingDeposits,
  recordSkippedDeposits,
  totalCreditedUqor,
  weiToUqor,
  type DepositRecord,
  type DepositsFile,
  type ParsedDeposit,
} from "../src/lib/deposits";
import {
  GENESIS_STATE_ROOT,
  applyDeposits,
  applyTxs,
  batchDigest,
  receiptHash,
  rollupTxToJson,
  txDataCommitment,
  verifyBatch,
  type BatchDepositJson,
  type BatchFile,
  type OnChainBatch,
  type RollupTx,
} from "../src/lib/rollup";
import { merkleLeafToJson } from "../src/lib/merkle";
import { generateKemKeypair, sealBatchPayload } from "../src/lib/kem";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const CAROL = "0x3333333333333333333333333333333333333333" as Address;
const CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const CHAIN_ID = 9800;

const TX1 = ("0x" + "aa".repeat(32)) as Hex;
const TX2 = ("0x" + "bb".repeat(32)) as Hex;
const NOW = "2026-11-17T12:00:00.000Z";

function log(overrides: Partial<{
  depositor: string;
  amount: bigint;
  transactionHash: string;
  blockNumber: bigint;
  logIndex: number;
}> = {}) {
  return {
    args: {
      depositor: overrides.depositor ?? ALICE,
      amount: overrides.amount ?? 300000n * 10n ** 12n,
    },
    transactionHash: overrides.transactionHash ?? TX1,
    blockNumber: overrides.blockNumber ?? 10250139n,
    logIndex: overrides.logIndex ?? 0,
  };
}

function record(overrides: Partial<DepositRecord> = {}): DepositRecord {
  return {
    depositor: ALICE,
    amountUqor: "300000",
    amountWei: (300000n * 10n ** 12n).toString(),
    tx: TX1,
    block: 10250139,
    logIndex: 0,
    status: "pending",
    creditedInBatch: null,
    recordedAt: NOW,
    ...overrides,
  };
}

function file(deposits: DepositRecord[] = []): DepositsFile {
  return {
    network: "qorechain-diana",
    chainId: CHAIN_ID,
    contract: CONTRACT,
    lastProcessedBlock: 10250139,
    deposits,
  };
}

describe("weiToUqor", () => {
  it("converts exact multiples of 10^12 wei", () => {
    expect(weiToUqor(300000n * 10n ** 12n)).to.equal(300000n);
    expect(weiToUqor(10n ** 12n)).to.equal(1n);
    expect(weiToUqor(0n)).to.equal(0n);
  });

  it("returns null for non-whole-uqor amounts", () => {
    expect(weiToUqor(1n)).to.equal(null);
    expect(weiToUqor(1500000000000n)).to.equal(null); // 1.5 uqor
    expect(weiToUqor(10n ** 12n + 1n)).to.equal(null);
  });
});

describe("parseDepositedLog", () => {
  it("parses a valid Deposited log", () => {
    const parsed = parseDepositedLog(log());
    expect(parsed.ok).to.equal(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.deposit.depositor).to.equal(ALICE);
    expect(parsed.deposit.amountUqor).to.equal(300000n);
    expect(parsed.deposit.amountWei).to.equal(300000n * 10n ** 12n);
    expect(parsed.deposit.tx).to.equal(TX1);
    expect(parsed.deposit.block).to.equal(10250139);
    expect(parsed.deposit.logIndex).to.equal(0);
  });

  it("rejects a zero amount", () => {
    const parsed = parseDepositedLog(log({ amount: 0n }));
    expect(parsed.ok).to.equal(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).to.match(/not positive/);
  });

  it("rejects a non-whole-uqor amount instead of rounding it", () => {
    const parsed = parseDepositedLog(log({ amount: 1n }));
    expect(parsed.ok).to.equal(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).to.match(/not a whole number of uqor/);
  });

  it("rejects an invalid depositor address", () => {
    const parsed = parseDepositedLog(log({ depositor: "not-an-address" }));
    expect(parsed.ok).to.equal(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).to.match(/not a valid address/);
  });
});

describe("depositKey", () => {
  it("identifies a deposit by (tx, logIndex), case-insensitively", () => {
    expect(depositKey(TX1, 0)).to.equal(depositKey(TX1.toUpperCase(), 0));
    expect(depositKey(TX1, 0)).to.not.equal(depositKey(TX1, 1));
    expect(depositKey(TX1, 0)).to.not.equal(depositKey(TX2, 0));
  });
});

describe("mergeDeposits", () => {
  const fresh = (tx: Hex, logIndex: number, amountUqor = 100000n): ParsedDeposit => ({
    depositor: ALICE,
    amountUqor,
    amountWei: amountUqor * 10n ** 12n,
    tx,
    block: 10250200,
    logIndex,
  });

  it("adds new deposits as pending, in chain order", () => {
    const { merged, added, alreadyKnown } = mergeDeposits([], [fresh(TX1, 0), fresh(TX2, 0)], NOW);
    expect(added).to.have.length(2);
    expect(alreadyKnown).to.equal(0);
    expect(merged.map((d) => d.status)).to.deep.equal(["pending", "pending"]);
    expect(merged.map((d) => d.tx)).to.deep.equal([TX1, TX2]);
  });

  it("is idempotent: re-merging the same deposits adds nothing", () => {
    const first = mergeDeposits([], [fresh(TX1, 0)], NOW);
    const second = mergeDeposits(first.merged, [fresh(TX1, 0)], NOW);
    expect(second.added).to.have.length(0);
    expect(second.alreadyKnown).to.equal(1);
    expect(second.merged).to.have.length(1);
    // And a third merge is still a no-op: no double-credit, ever.
    const third = mergeDeposits(second.merged, [fresh(TX1, 0)], NOW);
    expect(third.added).to.have.length(0);
    expect(third.merged).to.have.length(1);
  });

  it("never re-adds an already settled or genesis deposit", () => {
    const existing = [
      record({ status: "settled", creditedInBatch: 3 }),
      record({ tx: TX2, status: "genesis", creditedInBatch: null }),
    ];
    const { added, alreadyKnown } = mergeDeposits(
      existing,
      [fresh(TX1, 0), fresh(TX2, 0)],
      NOW,
    );
    expect(added).to.have.length(0);
    expect(alreadyKnown).to.equal(2);
  });

  it("treats the same tx with a different logIndex as a different deposit", () => {
    const first = mergeDeposits([], [fresh(TX1, 0)], NOW);
    const second = mergeDeposits(first.merged, [fresh(TX1, 1)], NOW);
    expect(second.added).to.have.length(1);
    expect(second.merged).to.have.length(2);
  });

  it("keeps the file sorted by (block, logIndex) even when logs arrive out of order", () => {
    const late = { ...fresh(TX2, 0), block: 10250300 };
    const early = { ...fresh(TX1, 0), block: 10250200 };
    const { merged } = mergeDeposits([], [late, early], NOW);
    expect(merged.map((d) => d.tx)).to.deep.equal([TX1, TX2]);
  });
});

describe("recordSkippedDeposits", () => {
  it("records uncreditable deposits as skipped, with the reason", () => {
    const { merged, added } = recordSkippedDeposits(
      [],
      [{ depositor: ALICE, amountWei: "1", tx: TX1, block: 10250200, logIndex: 0, reason: "not whole uqor" }],
      NOW,
    );
    expect(added).to.have.length(1);
    expect(merged[0].status).to.equal("skipped");
    expect(merged[0].skipReason).to.equal("not whole uqor");
    expect(merged[0].amountUqor).to.equal("0");
  });

  it("records the same skip only once", () => {
    const input = [{ depositor: ALICE, amountWei: "1", tx: TX1, block: 10250200, logIndex: 0, reason: "x" }];
    const first = recordSkippedDeposits([], input, NOW);
    const second = recordSkippedDeposits(first.merged, input, NOW);
    expect(second.added).to.have.length(0);
    expect(second.merged).to.have.length(1);
  });
});

describe("pendingDeposits / markDepositsSettled / totalCreditedUqor", () => {
  it("pendingDeposits returns only pending deposits, in chain order", () => {
    const f = file([
      record({ tx: TX2, block: 10250300, status: "pending" }),
      record({ tx: TX1, block: 10250200, status: "settled", creditedInBatch: 1 }),
      record({ tx: ("0x" + "cc".repeat(32)) as Hex, block: 10250100, status: "pending" }),
    ]);
    const pending = pendingDeposits(f);
    expect(pending).to.have.length(2);
    expect(pending.map((d) => d.block)).to.deep.equal([10250100, 10250300]);
  });

  it("markDepositsSettled flips only the named pending deposits", () => {
    const f = file([
      record({ tx: TX1, status: "pending" }),
      record({ tx: TX2, status: "pending" }),
      record({ tx: ("0x" + "cc".repeat(32)) as Hex, status: "settled", creditedInBatch: 1 }),
      record({ tx: ("0x" + "dd".repeat(32)) as Hex, status: "genesis" }),
    ]);
    const settled = markDepositsSettled(f, new Set([depositKey(TX1, 0)]), 3, NOW);
    const byTx = new Map(settled.deposits.map((d) => [d.tx, d]));
    expect(byTx.get(TX1)?.status).to.equal("settled");
    expect(byTx.get(TX1)?.creditedInBatch).to.equal(3);
    expect(byTx.get(TX1)?.creditedAt).to.equal(NOW);
    expect(byTx.get(TX2)?.status).to.equal("pending");
    expect(byTx.get(("0x" + "cc".repeat(32)) as Hex)?.creditedInBatch).to.equal(1);
    expect(byTx.get(("0x" + "dd".repeat(32)) as Hex)?.status).to.equal("genesis");
    // Double-marking is a no-op: the already-settled deposit keeps batch 3.
    const again = markDepositsSettled(settled, new Set([depositKey(TX1, 0)]), 4, NOW);
    expect(again.deposits.find((d) => d.tx === TX1)?.creditedInBatch).to.equal(3);
  });

  it("totalCreditedUqor sums only the requested statuses", () => {
    const f = file([
      record({ tx: TX1, amountUqor: "300000", status: "genesis" }),
      record({ tx: TX2, amountUqor: "100000", status: "pending" }),
      record({ tx: ("0x" + "cc".repeat(32)) as Hex, amountUqor: "50000", status: "settled", creditedInBatch: 3 }),
      record({ tx: ("0x" + "dd".repeat(32)) as Hex, amountUqor: "0", status: "skipped" }),
    ]);
    expect(totalCreditedUqor(f, ["pending", "settled", "genesis"])).to.equal(450000n);
    expect(totalCreditedUqor(f, ["settled"])).to.equal(50000n);
    expect(totalCreditedUqor(f, ["pending"])).to.equal(100000n);
  });
});

describe("applyDeposits", () => {
  const balances = () =>
    new Map<Address, bigint>([[ALICE.toLowerCase() as Address, 1000n]]);

  it("credits a new account and adds to an existing balance", () => {
    const out = applyDeposits(balances(), [
      { depositor: ALICE, amountUqor: "500", tx: TX1, block: 1 },
      { depositor: CAROL, amountUqor: "700", tx: TX2, block: 2 },
    ]);
    expect(out.get(ALICE.toLowerCase() as Address)).to.equal(1500n);
    expect(out.get(CAROL.toLowerCase() as Address)).to.equal(700n);
  });

  it("accumulates multiple deposits for the same account", () => {
    const out = applyDeposits(new Map(), [
      { depositor: BOB, amountUqor: "100", tx: TX1, block: 1 },
      { depositor: BOB, amountUqor: "200", tx: TX2, block: 2 },
    ]);
    expect(out.get(BOB.toLowerCase() as Address)).to.equal(300n);
  });

  it("does not mutate the input map", () => {
    const before = balances();
    applyDeposits(before, [{ depositor: ALICE, amountUqor: "500", tx: TX1, block: 1 }]);
    expect(before.get(ALICE.toLowerCase() as Address)).to.equal(1000n);
  });

  it("throws on an invalid address, a non-positive amount, or a non-numeric amount", () => {
    expect(() =>
      applyDeposits(new Map(), [{ depositor: "nope" as Address, amountUqor: "1", tx: TX1, block: 1 }]),
    ).to.throw(/invalid depositor/);
    expect(() =>
      applyDeposits(new Map(), [{ depositor: ALICE, amountUqor: "0", tx: TX1, block: 1 }]),
    ).to.throw(/non-positive/);
    expect(() =>
      applyDeposits(new Map(), [{ depositor: ALICE, amountUqor: "-5", tx: TX1, block: 1 }]),
    ).to.throw(/non-positive/);
    expect(() =>
      applyDeposits(new Map(), [{ depositor: ALICE, amountUqor: "abc", tx: TX1, block: 1 }]),
    ).to.throw(/invalid amount/);
  });

  it("is empty-safe: no deposits leaves the balances unchanged", () => {
    const out = applyDeposits(balances(), []);
    expect(out).to.deep.equal(balances());
  });
});

describe("verifyBatch with deposits", () => {
  interface Fixture {
    batch: BatchFile;
    onChain: OnChainBatch;
    sequencerPublicKey: Uint8Array;
    kemSecretKey: Uint8Array;
    prevBalances: Map<Address, bigint>;
    prevNonces: Map<Address, number>;
  }

  /** Build a fully valid batch-0 fixture WITH a deposit, exactly as the sequencer would. */
  function makeDepositFixture(deposits: BatchDepositJson[]): Fixture {
    const dsa = generatePqcKeypair();
    const kem = generateKemKeypair();
    const prevBalances = new Map<Address, bigint>([[ALICE, 1000n]]);
    const prevNonces = new Map<Address, number>();
    const txs: RollupTx[] = [{ from: ALICE, to: BOB, amount: 100n, nonce: 0 }];
    const fundedBalances = applyDeposits(prevBalances, deposits);
    const { newStateRoot, newBalances, newNonces, leaves, proofs } = applyTxs(
      GENESIS_STATE_ROOT,
      fundedBalances,
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
      deposits,
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
      prevBalances: Object.fromEntries(
        [...prevBalances.entries()].map(([addr, bal]) => [addr, bal.toString()]),
      ),
      prevNonces: Object.fromEntries(prevNonces.entries()),
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

  function verify(f: Fixture) {
    return verifyBatch(f.batch, f.onChain, {
      chainId: CHAIN_ID,
      contract: CONTRACT,
      batchId: 0,
      sequencerPublicKey: f.sequencerPublicKey,
      prevStateRoot: GENESIS_STATE_ROOT,
      prevBalances: f.prevBalances,
      prevNonces: f.prevNonces,
      kemSecretKey: f.kemSecretKey,
    });
  }

  it("accepts a batch whose deposit credits the sender before its tx", () => {
    const f = makeDepositFixture([
      { depositor: ALICE, amountUqor: "500", tx: TX1, block: 100 },
    ]);
    // Post-state: ALICE 1000 + 500 − 100 = 1400, BOB 100.
    expect(f.batch.balances[ALICE.toLowerCase()]).to.equal("1400");
    expect(f.batch.balances[BOB.toLowerCase()]).to.equal("100");
    const result = verify(f);
    expect(result.ok).to.equal(true);
    expect(result.failures).to.deep.equal([]);
  });

  it("accepts a batch whose deposit funds a brand-new account", () => {
    const f = makeDepositFixture([
      { depositor: CAROL, amountUqor: "700", tx: TX1, block: 100 },
    ]);
    expect(f.batch.balances[CAROL.toLowerCase()]).to.equal("700");
    const result = verify(f);
    expect(result.ok).to.equal(true);
    expect(result.failures).to.deep.equal([]);
  });

  it("flags a tampered deposit amount in the batch file", () => {
    const f = makeDepositFixture([
      { depositor: ALICE, amountUqor: "500", tx: TX1, block: 100 },
    ]);
    f.batch.deposits![0].amountUqor = "501";
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/state root/);
  });

  it("flags a deposit added to the batch file after settlement", () => {
    const f = makeDepositFixture([
      { depositor: ALICE, amountUqor: "500", tx: TX1, block: 100 },
    ]);
    f.batch.deposits!.push({ depositor: BOB, amountUqor: "999", tx: TX2, block: 101 });
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/state root/);
  });

  it("flags a batch whose deposits are dropped from the file", () => {
    const f = makeDepositFixture([
      { depositor: ALICE, amountUqor: "500", tx: TX1, block: 100 },
    ]);
    delete f.batch.deposits;
    const result = verify(f);
    expect(result.ok).to.equal(false);
    expect(result.failures.join(" ")).to.match(/state root/);
  });
});
