/**
 * watchtower-status.ts - publish the latest watchtower verification as a
 * small JSON status file the demo can fetch.
 *
 * Usage: npm run watchtower-status
 *
 * Runs the REAL watchtower (scripts/watchtower.ts, as a subprocess — the
 * same verification that checks every batch's ML-DSA-87 signature, state
 * replay, Merkle tree, receipt hash and deposit credits against the
 * chain), then derives deployments/watchtower-status.json from the run
 * it just appended to deployments/watchtower-log.json:
 *
 *   { lastRun, batchesVerified, totalBatches, depositsCreditedUqor,
 *     status: "ok" | "fail" }
 *
 * `depositsCreditedUqor` is the credited total from the watcher ledger
 * (settled + genesis records in deployments/deposits.json) — the same
 * definition the watchtower's deposit-credit check (f) uses.
 *
 * Nothing here is faked: the status comes from the run's own log entry.
 * If the watchtower run crashes before appending to the log, no status
 * is published (the previous file, if any, is left untouched) and this
 * script exits non-zero. If the run completes with failures, the status
 * is published with status "fail" and this script exits non-zero, just
 * like the watchtower itself.
 *
 * The deposit watcher (scripts/deposit-watcher.ts) calls
 * publishWatchtowerStatus() after each scan, so the status stays fresh
 * on the schedule the watcher already runs on. The demo fetches the
 * published file from raw.githubusercontent.com (NOT jsDelivr @main,
 * which caches) and falls back to the embedded evidence when the fetch
 * fails.
 *
 * Read-only: it sends no transactions and needs no secrets or env vars.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// npm scripts run with the working directory at the package root.
const ROOT = process.cwd();
const DEPLOYMENTS = path.resolve(ROOT, "deployments");
const WATCHTOWER_LOG_PATH = path.resolve(DEPLOYMENTS, "watchtower-log.json");
const DEPOSITS_PATH = path.resolve(DEPLOYMENTS, "deposits.json");
const STATUS_PATH = path.resolve(DEPLOYMENTS, "watchtower-status.json");
const TSX_BIN = path.resolve(ROOT, "node_modules", ".bin", "tsx");
const WATCHTOWER_SCRIPT = path.resolve(ROOT, "scripts", "watchtower.ts");

export type WatchtowerStatus = {
  /** ISO timestamp of the verification run. */
  lastRun: string;
  /** Batches that passed every check in that run. */
  batchesVerified: number;
  /** Batches on-chain at the time of the run. */
  totalBatches: number;
  /** Credited L1 deposits (settled + genesis) in uqor, as a string. */
  depositsCreditedUqor: string;
  status: "ok" | "fail";
};

/** One entry of deployments/watchtower-log.json (the fields we need). */
type LogRun = {
  at: string;
  batchCount: number;
  results: Array<{ batchId: number; ok: boolean }>;
  allOk: boolean;
};

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function readLogRuns(): LogRun[] {
  if (!fs.existsSync(WATCHTOWER_LOG_PATH)) return [];
  return readJson<{ runs?: LogRun[] }>(WATCHTOWER_LOG_PATH).runs ?? [];
}

/**
 * Derive the published status from one completed watchtower run.
 * Pure (no I/O) so the mapping is easy to reason about and test.
 */
export function deriveWatchtowerStatus(
  run: LogRun,
  depositsCreditedUqor: bigint,
): WatchtowerStatus {
  return {
    lastRun: run.at,
    batchesVerified: run.results.filter((r) => r.ok).length,
    totalBatches: run.batchCount,
    depositsCreditedUqor: depositsCreditedUqor.toString(),
    status: run.allOk ? "ok" : "fail",
  };
}

/**
 * Credited deposits (settled + genesis) from the watcher ledger — the
 * same definition the watchtower's deposit-credit check (f) uses.
 * 0 when the ledger does not exist yet.
 */
export function creditedDepositsUqor(): bigint {
  if (!fs.existsSync(DEPOSITS_PATH)) return 0n;
  const file = readJson<{
    deposits: Array<{ status: string; amountUqor: string }>;
  }>(DEPOSITS_PATH);
  return file.deposits
    .filter((d) => d.status === "settled" || d.status === "genesis")
    .reduce((sum, d) => sum + BigInt(d.amountUqor), 0n);
}

/**
 * Run the real watchtower, then publish deployments/watchtower-status.json
 * from the run it just logged. Returns the published status. Throws (and
 * leaves any previous status file untouched) when the watchtower run
 * crashes before logging a run.
 */
export async function publishWatchtowerStatus(): Promise<WatchtowerStatus> {
  const runsBefore = readLogRuns().length;
  // The watchtower's own stdout passes through, so a caller sees the
  // per-batch verdicts; a non-zero exit means verification failed, which
  // is a publishable outcome (status "fail") — not a crash.
  let exitCode = 0;
  try {
    execFileSync(TSX_BIN, [WATCHTOWER_SCRIPT], { cwd: ROOT, stdio: "inherit" });
  } catch (err) {
    exitCode = (err as { status?: number }).status ?? 1;
  }
  const runsAfter = readLogRuns();
  if (runsAfter.length <= runsBefore) {
    throw new Error(
      `Watchtower run did not append to ${WATCHTOWER_LOG_PATH} (exit ${exitCode}) — ` +
        "refusing to publish a status from a run that never completed.",
    );
  }
  const latest = runsAfter[runsAfter.length - 1] as LogRun;
  const status = deriveWatchtowerStatus(latest, creditedDepositsUqor());
  fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + "\n");
  console.log(
    `Watchtower status published: ${STATUS_PATH} (${status.status}, ` +
      `${status.batchesVerified}/${status.totalBatches} batches verified, ` +
      `${status.depositsCreditedUqor} uqor credited)`,
  );
  return status;
}

// CLI entry (only when run directly — deposit-watcher.ts imports
// publishWatchtowerStatus() and must not trigger a run on import).
if (require.main === module) {
  publishWatchtowerStatus()
    .then((status) => {
      process.exitCode = status.status === "ok" ? 0 : 1;
    })
    .catch((err: unknown) => {
      console.error(
        `\nWatchtower status publish failed: ${err instanceof Error ? err.message : err}`,
      );
      process.exitCode = 1;
    });
}
