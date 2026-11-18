/**
 * auto-settle.ts - settle pending rollup deposits in one unattended run.
 *
 * Usage (see README):
 *   npm run auto-settle [--dry-run]     settle at most one batch, then commit + push the record
 *
 * What one run does, in order:
 *   1. Testnet-only guard: refuse to run unless the EVM chain id is 9800
 *      (QoreChain Diana testnet) and the required env vars are present.
 *      Nothing that could send a transaction happens before this check.
 *   2. Run the deposit watcher (live mode only) so L1 deposits that arrived
 *      since the last watcher run are ingested into deployments/deposits.json.
 *      In --dry-run mode the watcher is NOT run: deposits.json is read as-is.
 *   3. If there are no pending deposits AND the mempool is empty, exit
 *      quietly with code 0 and send NO transaction.
 *   4. If deposits are pending but the mempool is empty, enqueue one tiny
 *      (1 uqor) sequencer self-transfer first — `settle` refuses an empty
 *      mempool, and this is the same pattern batches #4-#7 used.
 *   5. Check the EVM authorisation window and open one if it is expired
 *      (unlike `sequencer settle`, which refuses without a window, this
 *      script is meant to run unattended, so it opens the window itself).
 *   6. Settle AT MOST ONE batch (via `scripts/sequencer.ts settle`, so the
 *      batch build, ML-DSA-87 signing, deposit re-verification and local
 *      state writes are exactly the sequencer's), then verify the result:
 *      the receipt status is success AND the on-chain batchCount went up
 *      by exactly one. Append an `auto-settle` step to deployments/usage.json.
 *   7. Commit + push ONLY the new batch file and deployments/usage.json to
 *      the auto-settle branch (pulling/merging first if the remote moved;
 *      never force-push). Git failures after a successful settle are loud
 *      warnings, not run failures: the settle already happened on-chain,
 *      and re-running would find nothing left to settle.
 *
 * Exit codes (for a scheduler):
 *   0  nothing to settle, dry run, or one batch settled (+ verified).
 *   1  failure. If a transaction may already have been attempted, the error
 *      message says so explicitly — check the on-chain batchCount before
 *      retrying, never blindly re-run.
 *
 * Safety:
 * - Testnet ONLY (EVM chain id 9800). The RPC endpoint comes from
 *   QORE_EVM_RPC_URL (default https://evm-testnet.qore.host); pointing it
 *   at any other chain makes the run refuse before any transaction.
 * - Secrets (QORE_MNEMONIC, QORE_EVM_PRIVATE_KEY) come from ../.env and are
 *   never printed. The KEM secret key is never needed here.
 * - The settle itself is delegated to `sequencer settle`, which re-verifies
 *   every pending deposit against the on-chain `Deposited` logs before
 *   crediting it, so a tampered deposits.json still refuses to settle.
 *
 * Git caveat: a settle also modifies deployments/state.json,
 * deployments/mempool.json and deployments/deposits.json, which this script
 * deliberately does NOT commit (only the batch file + usage.json are
 * committed, per the runbook). The scheduled runs MUST therefore run from a
 * persistent checkout — a fresh clone per run would see a stale state.json
 * and refuse to settle. If the record-keeping policy changes, extend
 * COMMIT_FILES below.
 */
import { createEvmClient, evmWindowStatus } from "@qorechain/evm";
import { parseAbi, type Address, type Hex } from "viem";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pendingDeposits, type DepositsFile } from "../src/lib/deposits";
import type { BatchFile, RollupTxJson } from "../src/lib/rollup";

const TESTNET_CHAIN_ID = 9800;
const TESTNET_REST = "https://api-testnet.qore.host";
const SEQUENCER_EVM = "0x0140a056ee37D5240b0397eCdF1347Da80E33b9f" as Address;
const SEQUENCER_COSMOS = "qor1q9q2q4hwxl2jgzcrjlkd7y68m2qwxwul0nheda";
/** Tiny self-transfer that keeps a deposit-only batch non-empty (batches #4-#7). */
const TINY_TX_UQOR = 1n;
/** The branch this script commits + pushes to. Never main. */
const BRANCH = "auto-settle";
const GIT_USER_NAME = "Andi Pangeran";
const GIT_USER_EMAIL = "342708382+andiPangeranm142@users.noreply.github.com";
/** The only files a settle run commits (see the header caveat). */
const COMMIT_FILES = ["deployments/usage.json"] as const;

const BATCH_COUNT_ABI = parseAbi([
  "function batchCount() view returns (uint256)",
]);

// npm scripts run with the working directory at the package root.
const ROOT = process.cwd();
const DEPLOYMENTS = path.resolve(ROOT, "deployments");
const BATCHES_DIR = path.resolve(DEPLOYMENTS, "batches");
const STATE_PATH = path.resolve(DEPLOYMENTS, "state.json");
const MEMPOOL_PATH = path.resolve(DEPLOYMENTS, "mempool.json");
const USAGE_PATH = path.resolve(DEPLOYMENTS, "usage.json");
const DEPOSITS_PATH = path.resolve(DEPLOYMENTS, "deposits.json");
/** tsx entry point, for spawning the sibling scripts with the same runtime. */
const TSX_CLI = path.resolve(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const USAGE =
  "Usage: npm run auto-settle [--dry-run]\n" +
  "  Settle at most one batch of pending deposits + mempool txs, then commit\n" +
  "  the batch file + usage.json to the auto-settle branch. --dry-run only\n" +
  "  reports what would happen and sends no transaction.";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (set it in ../.env)`);
  }
  return value;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function loadDeployment(): { contract: Address } {
  const deploymentPath = path.resolve(DEPLOYMENTS, "testnet.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("No deployments/testnet.json yet — deploy the contract first.");
  }
  return readJson<{ contract: Address }>(deploymentPath);
}

function loadMempool(): RollupTxJson[] {
  if (!fs.existsSync(MEMPOOL_PATH)) return [];
  return readJson<RollupTxJson[]>(MEMPOOL_PATH);
}

function loadDeposits(): DepositsFile {
  if (!fs.existsSync(DEPOSITS_PATH)) {
    throw new Error(
      "No deployments/deposits.json yet — run `npm run deposit-watcher` first so " +
        "L1 deposits are ingested before settling.",
    );
  }
  return readJson<DepositsFile>(DEPOSITS_PATH);
}

function appendUsageStep(contract: Address, step: Record<string, unknown>): void {
  const existing = fs.existsSync(USAGE_PATH)
    ? readJson<Record<string, unknown>>(USAGE_PATH)
    : null;
  const prevSteps = existing?.steps;
  const steps: Array<Record<string, unknown>> = Array.isArray(prevSteps)
    ? (prevSteps as Array<Record<string, unknown>>)
    : [];
  steps.push({ at: new Date().toISOString(), ...step });
  writeJson(USAGE_PATH, {
    ...(existing ?? {}),
    network: "qorechain-diana",
    chainId: TESTNET_CHAIN_ID,
    contract,
    steps,
  });
}

/**
 * Run a sibling script (deposit-watcher, sequencer, window) in-process-env:
 * the secrets are already loaded by this script's own --env-file, so the
 * children inherit them and need no --env-file of their own (which would
 * also resolve wrong from a worktree, where ../.env is not the repo's .env).
 */
function runScript(name: string, script: string, args: string[]): void {
  console.log(`\n--- ${name} ---`);
  const res = spawnSync(
    process.execPath,
    [TSX_CLI, path.resolve(ROOT, "scripts", script), ...args],
    { cwd: ROOT, stdio: "inherit", env: process.env },
  );
  if (res.error) {
    throw new Error(`${name} could not start: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `${name} failed (exit ${res.status ?? res.signal ?? "unknown"}). See its output above.`,
    );
  }
}

/** Run git with captured output (for status checks). */
function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** Run git with inherited stdio (for merge/commit/push, so the operator sees it). */
function gitLive(args: string[]): number | null {
  const res = spawnSync("git", args, { cwd: ROOT, stdio: "inherit" });
  if (res.error) throw new Error(`git ${args[0]} could not start: ${res.error.message}`);
  return res.status;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(" ")}\n${USAGE}`);
  }

  // --- 1. Guards: required env vars, then the testnet-only chain check. ---
  // Both happen before anything that could send a transaction.
  requireEnv("QORE_EVM_PRIVATE_KEY");
  requireEnv("QORE_MNEMONIC");
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
  const { contract } = loadDeployment();
  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}. ` +
        `This script only ever runs on the QoreChain Diana testnet (RPC: ${evmRpc}).`,
    );
  }
  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  if (dryRun) console.log("mode:     DRY RUN — no transactions, no writes, no git");

  const readBatchCount = async (): Promise<number> =>
    Number(
      (await client.publicClient.readContract({
        address: contract,
        abi: BATCH_COUNT_ABI,
        functionName: "batchCount",
      })) as bigint,
    );
  const batchCountBefore = await readBatchCount();
  console.log(`batchCount (on-chain): ${batchCountBefore}`);

  // --- 2. Ingest fresh deposits (live mode only; dry-run reads as-is). ---
  if (!dryRun) {
    runScript("deposit-watcher", "deposit-watcher.ts", []);
  }
  const depositsFile = loadDeposits();
  const pending = pendingDeposits(depositsFile);
  const pendingTotal = pending.reduce((sum, d) => sum + BigInt(d.amountUqor), 0n);
  let mempool = loadMempool();
  console.log(`pending deposits: ${pending.length} (${pendingTotal} uqor)`);
  console.log(`mempool:          ${mempool.length} tx(s)`);

  // --- 3. Nothing to settle: exit quietly, no transaction. ---
  if (pending.length === 0 && mempool.length === 0) {
    console.log("\nNothing to settle — exiting quietly (code 0, no transaction sent).");
    return;
  }

  // --- Dry run with work pending: report, don't touch anything. ---
  if (dryRun) {
    console.log(
      `\nDRY RUN — would settle one batch (${pending.length} deposit(s), ` +
        `${mempool.length} mempool tx(s))` +
        (pending.length > 0 && mempool.length === 0
          ? ", enqueueing one 1-uqor sequencer self-transfer first" : "") +
        ". No transaction sent, nothing written.",
    );
    return;
  }

  // From here on, a transaction may be attempted: failures must exit
  // non-zero with a message that says so (see the catch at the bottom).
  let txAttempted = false;
  let enqueuedTinyTx = false;
  let windowOpened = false;
  try {
    // --- 4. Deposit-only batch: enqueue one tiny tx so settle has a mempool. ---
    if (pending.length > 0 && mempool.length === 0) {
      runScript("sequencer enqueue (1-uqor self-transfer)", "sequencer.ts", [
        "enqueue",
        "--from",
        SEQUENCER_EVM,
        "--to",
        SEQUENCER_EVM,
        "--amount",
        TINY_TX_UQOR.toString(),
      ]);
      enqueuedTinyTx = true;
      mempool = loadMempool();
      if (mempool.length === 0) {
        throw new Error("Enqueue reported success but the mempool is still empty — refusing to settle.");
      }
    }

    // --- 5. EVM window: open one if expired (unlike `sequencer settle`,
    // which refuses without a window — this script runs unattended). ---
    const windowUsable = async (): Promise<boolean> => {
      const w = await evmWindowStatus({ rest: TESTNET_REST, address: SEQUENCER_COSMOS });
      console.log(
        `window:   ${w.found ? (w.live ? "live" : "not usable") : "none"}` +
          (w.found ? ` (${w.remainingBlocks} blocks, ${w.remainingTxs} txs, ${w.remainingValue} uqor left)` : ""),
      );
      return w.found && w.live && w.remainingTxs >= 1n;
    };
    if (!(await windowUsable())) {
      console.log("EVM window expired or missing — opening a new one…");
      txAttempted = true; // opening a window is a native-lane transaction
      runScript("window open", "window.ts", ["open"]);
      windowOpened = true;
      if (!(await windowUsable())) {
        throw new Error(
          "Opened an EVM window but it is still not usable — refusing to settle. " +
            "Check `npm run window status` before retrying.",
        );
      }
    }

    // --- 6. Settle at most one batch, then verify the result. ---
    const settleBaseline = await readBatchCount();
    txAttempted = true;
    runScript("sequencer settle (one batch)", "sequencer.ts", ["settle"]);

    const batchCountAfter = await readBatchCount();
    if (batchCountAfter !== settleBaseline + 1) {
      throw new Error(
        `Settle verification FAILED: on-chain batchCount went from ${settleBaseline} to ` +
          `${batchCountAfter} (expected exactly +1). A transaction WAS attempted — ` +
          "check the chain and deployments/state.json by hand before retrying; do NOT re-run blindly.",
      );
    }
    const batchId = settleBaseline;
    const batchPath = path.resolve(BATCHES_DIR, `batch-${batchId}.json`);
    if (!fs.existsSync(batchPath)) {
      throw new Error(
        `Settle verification FAILED: batchCount went up to ${batchCountAfter} but ` +
          `${batchPath} is missing. A transaction WAS submitted — reconcile the local ` +
          "state by hand before retrying.",
      );
    }
    const batchFile = readJson<BatchFile>(batchPath);
    const batchDeposits = batchFile.deposits ?? [];
    const receipt = await client.publicClient.getTransactionReceipt({
      hash: batchFile.submitTx as Hex,
    });
    if (receipt.status !== "success") {
      throw new Error(
        `Settle verification FAILED: submit tx ${batchFile.submitTx} has receipt status ` +
          `"${receipt.status}". A transaction WAS submitted — reconcile by hand before retrying.`,
      );
    }
    console.log(
      `\nVerified: batch #${batchId} settled (batchCount ${settleBaseline} -> ${batchCountAfter}, ` +
        `receipt success, tx ${batchFile.submitTx}).`,
    );

    appendUsageStep(contract, {
      command: "auto-settle",
      batchId,
      txCount: batchFile.txs.length,
      depositsSettled: batchDeposits.length,
      depositsUqor: batchDeposits
        .reduce((sum, d) => sum + BigInt(d.amountUqor), 0n)
        .toString(),
      batchCountBefore: settleBaseline,
      batchCountAfter,
      submitTx: batchFile.submitTx,
      cosmosTx: batchFile.cosmosTx,
      block: batchFile.block,
      receiptStatus: "success",
      enqueuedTinyTx,
      windowOpened,
    });
    console.log("Recorded in deployments/usage.json.");

    // --- 7. Commit + push ONLY the new batch file + usage.json. ---
    // Git is record-keeping, not the settle: failures here are loud
    // warnings, not run failures (the batch is already on-chain).
    try {
      const branch = git(["branch", "--show-current"]).stdout.trim();
      if (branch !== BRANCH) {
        console.error(
          `\nWARNING: not on the ${BRANCH} branch (on "${branch || "(detached)"}"). ` +
            `Batch #${batchId} is settled on-chain but NOT committed — commit ` +
            `${path.relative(ROOT, batchPath)} + deployments/usage.json by hand.`,
        );
        return;
      }
      const fetch = git(["fetch", "origin"]);
      if (fetch.status !== 0) {
        throw new Error(`git fetch origin failed: ${fetch.stderr.trim()}`);
      }
      const remoteExists =
        git(["rev-parse", "--verify", "--quiet", `origin/${BRANCH}`]).status === 0;
      if (remoteExists) {
        const behind = Number(
          git(["rev-list", "--count", `HEAD..origin/${BRANCH}`]).stdout.trim() || "0",
        );
        if (behind > 0) {
          console.log(`Remote ${BRANCH} moved (${behind} commit(s) ahead) — merging first…`);
          const mergeStatus = gitLive(["merge", "--no-edit", `origin/${BRANCH}`]);
          if (mergeStatus !== 0) {
            throw new Error(
              `git merge origin/${BRANCH} failed (exit ${mergeStatus}) — resolve the ` +
                "conflict by hand; the batch itself is already settled on-chain.",
            );
          }
        }
      }
      const files = [path.relative(ROOT, batchPath), ...COMMIT_FILES];
      const addStatus = gitLive(["add", ...files]);
      if (addStatus !== 0) throw new Error(`git add failed (exit ${addStatus})`);
      const diff = git(["diff", "--cached", "--quiet"]);
      if (diff.status === 0) {
        console.log("Nothing new to commit (batch file + usage.json unchanged) — skipping git.");
        return;
      }
      const commitStatus = gitLive([
        "-c",
        `user.name=${GIT_USER_NAME}`,
        "-c",
        `user.email=${GIT_USER_EMAIL}`,
        "commit",
        "-m",
        `auto-settle: settle batch #${batchId} (${batchFile.txs.length} txs, ${batchDeposits.length} deposits)`,
      ]);
      if (commitStatus !== 0) throw new Error(`git commit failed (exit ${commitStatus})`);
      const pushStatus = gitLive(["push", "origin", BRANCH]);
      if (pushStatus !== 0) {
        throw new Error(
          `git push origin ${BRANCH} failed (exit ${pushStatus}) — the commit is local; push it by hand.`,
        );
      }
      console.log(`Committed + pushed batch #${batchId} to origin/${BRANCH}.`);
    } catch (gitErr) {
      console.error(
        `\nWARNING: batch #${batchId} is settled and verified on-chain, but the git ` +
          `record-keeping failed: ${gitErr instanceof Error ? gitErr.message : gitErr}\n` +
          "Reconcile the commit by hand; do NOT re-run the settle.",
      );
    }
  } catch (err) {
    if (txAttempted) {
      throw new Error(
        `${err instanceof Error ? err.message : err}\n` +
          "NOTE: a transaction may already have been attempted in this run — check the " +
          "on-chain batchCount (and `npm run sequencer status`) before retrying.",
      );
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error(`\nAuto-settle failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
