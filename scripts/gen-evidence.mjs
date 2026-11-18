/**
 * gen-evidence.mjs - generate src/evidence.ts from deployments/*.json
 * (written by scripts/deploy.ts, scripts/sequencer.ts, scripts/usage.ts,
 * scripts/forged-batch.ts and scripts/watchtower.ts), so the demo page can
 * show the verified on-chain evidence with explorer links.
 *
 * Only SUMMARIES are emitted — batch ids, tx counts, hashes, tx links and
 * balances. The full 4,627-byte ML-DSA-87 signatures and 1,568-byte
 * ML-KEM-1024 ciphertexts stay in deployments/batches/*.json; only their
 * byte lengths are included here.
 *
 * Run: node scripts/gen-evidence.mjs (also runs as the `prebuild` step).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "..");
const dep = (p) => path.resolve(root, "deployments", p);
const outPath = path.resolve(root, "src", "evidence.ts");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const testnet = readJson(dep("testnet.json"));
const usage = readJson(dep("usage.json"));
const state = readJson(dep("state.json"));
const watchtower = readJson(dep("watchtower-log.json"));
const kem = readJson(dep("kem-public-key.json"));
// The batch files store L1 deposits with their EVM hash only; the
// explorer links need the Cosmos hash, so join via deposits.json.
const depositsLog = readJson(dep("deposits.json"));
const depositCosmosByTx = new Map(
  depositsLog.deposits.map((d) => [d.tx.toLowerCase(), d.cosmosTx ?? null]),
);

const step = (command) => usage.steps.find((s) => s.command === command);
const settles = usage.steps.filter((s) => s.command === "settle");
// ALL deposit steps (the 0.3 QOR genesis deposit, the 0.1 QOR
// auto-credit-cycle deposit, the 0.05 QOR fresh-account-test
// deposit): totals must SUM them, not take the first.
const depositSteps = usage.steps.filter((s) => s.command === "deposit");
const deposit = depositSteps[0];
// v2: withdrawals are Merkle-proof withdrawals (command "merkle-withdraw",
// no withdrawalId); fall back to the v1 "withdraw" step for old usage logs.
// There are three of them now (user 0.05 QOR + deployer 0.3 QOR +
// fresh test account 0.05 QOR): totals must SUM them, and the cycle
// shows all three.
const withdrawSteps = usage.steps.filter(
  (s) => s.command === "merkle-withdraw" || s.command === "withdraw",
);
const withdraw = withdrawSteps[0];
const sumUqor = (steps) => steps.reduce((sum, s) => sum + BigInt(s.amountUqor), 0n).toString();
const forged = step("forged-batch");
const seed = step("seed-state");
// On-chain reverted withdrawal attacks (v2): the same Merkle-proof
// withdrawal sent twice (ZeroWithdraw) and a withdrawal with one flipped
// hex char in the proof (InvalidMerkleProof). Error names are the
// contract's revert reasons (see README Live usage table).
const REVERT_ERROR = { "double-withdraw": "ZeroWithdraw", "tampered-proof": "InvalidMerkleProof" };
const reverts = usage.steps
  .filter((s) => s.command === "merkle-withdraw-revert" || s.command === "revert-demo")
  .map((s) => {
    if (s.command === "revert-demo") {
      // 18 Nov attack demos (replay / wrong-account / stale-batch): the demo
      // name is the reason and expectedReason is the contract revert reason.
      return {
        at: s.at,
        reason: s.demo,
        error: s.expectedReason ?? "reverted",
        batchId: s.batchId ?? s.replayedBatchId ?? 0,
        tx: s.tx,
        cosmosTx: s.cosmosTx,
        block: s.block,
        receiptStatus: s.receiptStatus,
        withdrawnBefore: s.withdrawnAmountBefore ?? null,
        withdrawnAfter: s.withdrawnAmountAfter ?? null,
        fakeBatchId: s.fakeBatchId ?? null,
        replayedBatchId: s.replayedBatchId ?? null,
        batchCountBefore: s.batchCountBefore ?? null,
        batchCountAfter: s.batchCountAfter ?? null,
      };
    }
    return {
      at: s.at,
      reason: s.reason,
      error: REVERT_ERROR[s.reason] ?? "reverted",
      batchId: s.batchId,
      tx: s.tx,
      cosmosTx: s.cosmosTx,
      block: s.block,
      receiptStatus: s.receiptStatus,
      withdrawnBefore: s.withdrawnAmountBefore ?? null,
      withdrawnAfter: s.withdrawnAmountAfter ?? null,
      fakeBatchId: null,
      replayedBatchId: null,
      batchCountBefore: null,
      batchCountAfter: null,
    };
  });

// Byte length of a 0x-prefixed hex string.
const hexBytes = (h) => (h.startsWith("0x") ? (h.length - 2) / 2 : h.length / 2);

const batches = settles.map((s) => {
  const file = readJson(dep(`batches/batch-${s.batchId}.json`));
  return {
    batchId: s.batchId,
    txCount: s.txCount,
    stateRoot: s.stateRoot,
    prevStateRoot: file.prevStateRoot,
    txDataCommitment: s.txDataCommitment,
    encryptedDataHash: s.encryptedDataHash,
    digest: s.digest,
    receiptHash: s.receiptHash,
    submitTx: s.submitTx,
    cosmosTx: s.cosmosTx,
    block: s.block,
    settledAt: s.at,
    signatureBytes: hexBytes(file.signature),
    kemCiphertextBytes: hexBytes(file.kemCiphertext),
    sealedBlobBytes: hexBytes(file.sealedBlob),
    txs: file.txs.map((t) => ({
      from: t.from,
      to: t.to,
      amountUqor: t.amount,
      nonce: t.nonce,
    })),
    // L1 deposits credited by this batch (applied before the txs).
    // Empty for batches 0-2, which predate the deposit watcher.
    // cosmosTx joins via deposits.json so the demo can link the deposit
    // to explore.qore.network/tx/<cosmos-hash>.
    deposits: (file.deposits ?? []).map((d) => ({
      depositor: d.depositor,
      amountUqor: d.amountUqor,
      tx: d.tx,
      cosmosTx: depositCosmosByTx.get(d.tx.toLowerCase()) ?? null,
      block: d.block,
    })),
    balancesAfter: file.balances,
  };
});

const runs = watchtower.runs;
const latestRun = runs[runs.length - 1];
// The most recent tamper-catch run (v1 runs stay in the log, disambiguated
// by the contract field; the demo shows the latest one).
const tamperRun = [...runs].reverse().find((r) => !r.allOk) ?? null;

// Merkle-proof withdrawal (v2): the user withdraws with a Merkle proof
// against a batch state root, with no sequencer help. The v2 cycle writes
// deployments/merkle-withdraw.json (or a `merkle-withdraw` usage step);
// until then this is null and the demo shows a clearly-labelled placeholder.
let merkleWithdraw = null;
try {
  const mw = readJson(dep("merkle-withdraw.json"));
  merkleWithdraw = {
    at: mw.at ?? null,
    batchId: mw.batchId ?? null,
    // v2 has NO withdrawalId/nullifier: withdrawals are capped
    // cumulatively per account (withdrawnAmount), so the same leaf can
    // never pay out twice.
    account: mw.account ?? null,
    stateRoot: mw.stateRoot ?? null,
    leaf: mw.leaf ?? null,
    proof: Array.isArray(mw.proof) ? mw.proof : null,
    proofSteps: Array.isArray(mw.proof) ? mw.proof.length : (mw.proofSteps ?? null),
    amountUqor: mw.amountUqor ?? null,
    withdrawnBefore: mw.withdrawnBefore ?? null,
    withdrawnAfter: mw.withdrawnAfter ?? null,
    tx: mw.tx ?? null,
    cosmosTx: mw.cosmosTx ?? null,
    block: mw.block ?? null,
    note: mw.note ?? null,
  };
} catch {
  const mwStep = usage.steps.find(
    (s) => s.command === "merkle-withdraw" || s.command === "withdraw-merkle",
  );
  if (mwStep) {
    merkleWithdraw = {
      at: mwStep.at ?? null,
      batchId: mwStep.batchId ?? null,
      account: mwStep.account ?? null,
      stateRoot: mwStep.stateRoot ?? null,
      leaf: mwStep.leaf ?? null,
      proof: Array.isArray(mwStep.proof) ? mwStep.proof : null,
      proofSteps: Array.isArray(mwStep.proof) ? mwStep.proof.length : (mwStep.proofSteps ?? null),
      amountUqor: mwStep.amountUqor ?? null,
      withdrawnBefore: mwStep.withdrawnBefore ?? null,
      withdrawnAfter: mwStep.withdrawnAfter ?? null,
      tx: mwStep.tx ?? null,
      cosmosTx: mwStep.cosmosTx ?? null,
      block: mwStep.block ?? null,
      note: mwStep.note ?? null,
    };
  }
}

const evidence = {
  network: testnet.network,
  chainId: testnet.chainId,
  contract: testnet.contract,
  deployer: testnet.deployer,
  deployTx: testnet.deployTx,
  deployTxCosmos: testnet.deployTxCosmos,
  deployBlock: testnet.deployBlock,
  deployedAt: testnet.deployedAt,
  bytecodeSize: testnet.bytecodeSize,
  explorerContract: testnet.explorerContract,
  explorerDeployTx: testnet.explorerDeployTx,
  // Final on-chain totals (verified by independent read; the live page
  // re-reads them from the chain and falls back to these on failure).
  totals: {
    batchCount: state.batchCount,
    totalDepositedUqor: sumUqor(depositSteps),
    totalWithdrawnUqor: sumUqor(withdrawSteps),
    // v2: Merkle-proof withdrawals do NOT touch the deposits ledger, so
    // deposits(deployer) is still the full 0.4 QOR. The deployer is no
    // longer the only depositor (the fresh test account deposited
    // 0.05 QOR), so this sums deposits.json records from the deployer
    // only — it must match the on-chain deposits[deployer]. (The
    // genesis usage step has no account field, so deposits.json, not
    // the usage steps, is the source here.)
    deployerDepositUqor: depositsLog.deposits
      .filter((d) => d.depositor?.toLowerCase() === testnet.deployer.toLowerCase())
      .reduce((sum, d) => sum + BigInt(d.amountUqor), 0n)
      .toString(),
    finalStateRoot: state.stateRoot,
  },
  balances: state.balances,
  batches,
  cycle: {
    // The seed-state step's own note (written when the gap was real)
    // says deposits are "NOT auto-credited" — stale since the watcher
    // landed. The usage.json history is left intact, but the demo
    // presents the corrected framing: the genesis deposit is the one
    // hand-credited exception, and every later deposit is auto-credited.
    seed: seed
      ? {
          at: seed.at,
          account: seed.account,
          amountUqor: seed.amountUqor,
          note: "Genesis funding: the 0.3 QOR L1 deposit was credited by hand into deployments/state.json before batch #0 — before the deposit watcher existed. Recorded in deployments/deposits.json with status \"genesis\"; every later deposit flows in automatically via the watcher.",
        }
      : null,
    deposit: {
      at: deposit.at,
      amountUqor: deposit.amountUqor,
      tx: deposit.tx,
      cosmosTx: deposit.cosmosTx,
      block: deposit.block,
    },
    // Every deposit (the genesis 0.3 QOR + the auto-credit 0.1 QOR +
    // the fresh-account-test 0.05 QOR), in chain order — the cycle
    // section renders each one.
    deposits: depositSteps.map((d) => ({
      at: d.at,
      amountUqor: d.amountUqor,
      tx: d.tx,
      cosmosTx: d.cosmosTx,
      block: d.block,
    })),
    withdraw: {
      at: withdraw.at,
      amountUqor: withdraw.amountUqor,
      // v2: the withdrawn leaf hash (keccak256(account, balance, nonce)).
      // There is NO nullifier in v2 — withdrawals are capped cumulatively
      // per account instead. The demo UI uses `merkleWithdraw` for the
      // full v2 display; this block keeps the cycle step working.
      leaf: withdraw.leaf ?? withdraw.withdrawalId ?? null,
      tx: withdraw.tx,
      cosmosTx: withdraw.cosmosTx,
      block: withdraw.block,
    },
    // Every Merkle-proof withdrawal (user 0.05 QOR against batch #2 +
    // deployer 0.3 QOR against batch #3 + fresh test account 0.05 QOR
    // against batch #4), in chain order.
    withdrawals: withdrawSteps.map((w) => ({
      at: w.at,
      amountUqor: w.amountUqor,
      account: w.account ?? null,
      batchId: w.batchId ?? null,
      leaf: w.leaf ?? w.withdrawalId ?? null,
      proofSteps: Array.isArray(w.proof) ? w.proof.length : (w.proofSteps ?? null),
      tx: w.tx,
      cosmosTx: w.cosmosTx,
      block: w.block,
    })),
    reverts,
    forged: {
      at: forged.at,
      batchId: forged.batchId,
      note: forged.note,
      tx: forged.tx,
      cosmosTx: forged.cosmosTx,
      block: forged.block,
      receiptStatus: forged.receiptStatus,
      batchCountBefore: forged.batchCountBefore,
      batchCountAfter: forged.batchCountAfter,
    },
  },
  watchtower: {
    latest: {
      at: latestRun.at,
      allOk: latestRun.allOk,
      batchCount: latestRun.batchCount,
      decryptCheck: latestRun.decryptCheck,
      results: latestRun.results,
      // Deposit credit check (e)/(f) from the latest run, or null for
      // runs that predate it. Rendered by the auto-deposit section and
      // the watchtower section.
      depositChecks: latestRun.depositChecks ?? null,
    },
    tamperDemo: tamperRun
      ? {
          at: tamperRun.at,
          allOk: tamperRun.allOk,
          results: tamperRun.results,
          // What was tampered: one hex char flipped in batch 1's claimed
          // state root in the local batch file (see README §Category
          // requirements — Watchtower). The on-chain record was untouched.
          tampered:
            "One hex character flipped in batch #1's claimed stateRoot in the local batch file (on-chain record untouched).",
        }
      : null,
  },
  kem: {
    // Public key only — the secret key lives outside the repo.
    publicKeyBytes: hexBytes(kem.publicKeyHex),
    publicKeyPrefix: kem.publicKeyHex.slice(0, 34),
  },
  // Null until the v2 cycle lands (see the merkleWithdraw block above).
  merkleWithdraw,
};

const header = `/**
 * evidence.ts - GENERATED by scripts/gen-evidence.mjs from
 * deployments/*.json. Do not edit by hand; re-run the generator.
 *
 * Summaries only: batch ids, tx counts, hashes, tx links and balances.
 * Full signatures and ciphertexts stay in deployments/batches/*.json.
 */

export type BatchTx = {
  from: string;
  to: string;
  amountUqor: string;
  nonce: number;
};

export type BatchDeposit = {
  depositor: string;
  amountUqor: string;
  tx: string;
  cosmosTx: string | null;
  block: number;
};

export type BatchSummary = {
  batchId: number;
  txCount: number;
  stateRoot: string;
  prevStateRoot: string;
  txDataCommitment: string;
  encryptedDataHash: string;
  digest: string;
  receiptHash: string;
  submitTx: string;
  cosmosTx: string;
  block: number;
  settledAt: string;
  signatureBytes: number;
  kemCiphertextBytes: number;
  sealedBlobBytes: number;
  txs: BatchTx[];
  deposits: BatchDeposit[];
  balancesAfter: Record<string, string>;
};

export type WatchtowerResult = {
  batchId: number;
  ok: boolean;
  failures: string[];
};

export type MerkleWithdrawEvidence = {
  at: string | null;
  batchId: number | null;
  account: string | null;
  stateRoot: string | null;
  leaf: string | null;
  proof: string[] | null;
  proofSteps: number | null;
  amountUqor: string | null;
  withdrawnBefore: string | null;
  withdrawnAfter: string | null;
  tx: string | null;
  cosmosTx: string | null;
  block: number | null;
  note: string | null;
};

export type RevertEvidence = {
  at: string;
  reason: string;
  error: string;
  batchId: number;
  tx: string;
  cosmosTx: string;
  block: number;
  receiptStatus: string;
  withdrawnBefore: string | null;
  withdrawnAfter: string | null;
  fakeBatchId: number | null;
  replayedBatchId: number | null;
  batchCountBefore: number | null;
  batchCountAfter: number | null;
};

export type Evidence = {
  network: string;
  chainId: number;
  contract: string;
  deployer: string;
  deployTx: string;
  deployTxCosmos: string;
  deployBlock: number;
  deployedAt: string;
  bytecodeSize: number;
  explorerContract: string;
  explorerDeployTx: string;
  totals: {
    batchCount: number;
    totalDepositedUqor: string;
    totalWithdrawnUqor: string;
    deployerDepositUqor: string;
    finalStateRoot: string;
  };
  balances: Record<string, string>;
  batches: BatchSummary[];
  cycle: {
    seed: { at: string; account: string; amountUqor: string; note: string } | null;
    deposit: { at: string; amountUqor: string; tx: string; cosmosTx: string; block: number };
    deposits: { at: string; amountUqor: string; tx: string; cosmosTx: string; block: number }[];
    withdraw: {
      at: string;
      amountUqor: string;
      leaf: string | null;
      tx: string;
      cosmosTx: string;
      block: number;
    };
    withdrawals: {
      at: string;
      amountUqor: string;
      account: string | null;
      batchId: number | null;
      leaf: string | null;
      proofSteps: number | null;
      tx: string;
      cosmosTx: string;
      block: number;
    }[];
    reverts: RevertEvidence[];
    forged: {
      at: string;
      batchId: number;
      note: string;
      tx: string;
      cosmosTx: string;
      block: number;
      receiptStatus: string;
      batchCountBefore: number;
      batchCountAfter: number;
    };
  };
  watchtower: {
    latest: {
      at: string;
      allOk: boolean;
      batchCount: number;
      decryptCheck: string;
      results: WatchtowerResult[];
      depositChecks: { checked: boolean; ok: boolean; failures: string[] } | null;
    };
    tamperDemo: { at: string; allOk: boolean; results: WatchtowerResult[]; tampered: string } | null;
  };
  kem: { publicKeyBytes: number; publicKeyPrefix: string };
  /** Null until the v2 Merkle-proof withdrawal cycle lands. */
  merkleWithdraw: MerkleWithdrawEvidence | null;
};

`;

fs.writeFileSync(
  outPath,
  header + `export const EVIDENCE: Evidence = ${JSON.stringify(evidence, null, 2)};\n`,
);
console.log(
  `gen-evidence: wrote src/evidence.ts (${batches.length} batches, watchtower runs: ${runs.length}).`,
);
