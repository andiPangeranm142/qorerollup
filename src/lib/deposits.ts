/**
 * deposits.ts - pure deposit-ingestion logic for QoreRollup. No network,
 * no secrets, no file I/O: the deposit watcher (scripts/deposit-watcher.ts)
 * fetches `Deposited` events from the chain and calls these helpers to
 * parse, deduplicate and credit them.
 *
 * WHY THIS EXISTS: the v2 rollup credited its genesis funding by hand
 * (the operator wrote the 0.3 QOR deposit into deployments/state.json
 * before batch #0). That was a documented demo gap: an L1 deposit did
 * not flow into the rollup on its own. Since the deposit watcher landed,
 * deposits flow automatically: the watcher reads `Deposited` events from
 * the settlement contract, records them in deployments/deposits.json,
 * and the sequencer applies the pending ones into the next batch's state
 * transition (see applyDeposits in src/lib/rollup.ts). The watchtower
 * independently re-checks every batch deposit against the on-chain logs.
 *
 * IDEMPOTENCY — the one property this module must never get wrong: a
 * deposit is identified by (transaction hash, log index), and a deposit
 * already recorded in deployments/deposits.json is NEVER credited again,
 * no matter how often the watcher re-scans. Re-runs are safe: they find
 * the same events, recognise them as already known, and credit nothing.
 *
 * VERIFICATION — the second property: a credit must never exceed the L1
 * deposit supporting it. `matchDepositClaims` matches every claimed
 * credit against the on-chain `Deposited` logs (same tx, depositor,
 * amount and block; each log backs exactly one claim), and
 * `verifyDepositTotals` checks the credited amounts against the L1
 * totals — in aggregate and per depositor. The sequencer runs the match
 * before every settle (a tampered deposits.json cannot reach a batch),
 * and the watchtower runs both checks on every verification run (a
 * settled batch cannot hide a fake or inflated credit).
 *
 * REPRESENTABILITY: rollup balances are counted in uqor (1 QOR = 10^6
 * uqor = 10^18 wei), so 1 uqor = 10^12 wei. A deposit whose wei amount
 * is not a whole number of uqor cannot be credited exactly — it is
 * recorded as `skipped` (with a reason) instead of being rounded, and
 * the funds stay safely in the contract's L1 deposit ledger.
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";

/** Wei per uqor: 1 QOR = 10^6 uqor = 10^18 wei, so 1 uqor = 10^12 wei. */
export const WEI_PER_UQOR = 10n ** 12n;

/** Lifecycle of one ingested deposit. */
export type DepositStatus =
  /** Seen on-chain, waiting to be included in a batch. */
  | "pending"
  /** Included in a settled batch (creditedInBatch set). */
  | "settled"
  /** The genesis deposit, credited by hand before batch #0 — before the
   *  watcher existed. Recorded so the watcher never credits it twice. */
  | "genesis"
  /** Seen on-chain but not creditable (e.g. a non-whole-uqor amount).
   *  The funds stay in the contract; the record exists so the deposit is
   *  visible and never silently re-processed. */
  | "skipped";

/** One ingested L1 deposit, as stored in deployments/deposits.json. */
export interface DepositRecord {
  /** Depositor address (checksummed). */
  depositor: Address;
  /** Amount in uqor, decimal string (JSON-safe). */
  amountUqor: string;
  /** Amount in wei, decimal string (exactly amountUqor * 10^12). */
  amountWei: string;
  /** EVM transaction hash of the deposit. */
  tx: Hex;
  /** Cosmos transaction hash wrapping the deposit (when resolved). */
  cosmosTx?: string;
  /** Block the deposit was mined in. */
  block: number;
  /** Log index of the Deposited event within its receipt. */
  logIndex: number;
  status: DepositStatus;
  /** Batch id that credited this deposit (null until settled). */
  creditedInBatch: number | null;
  /** ISO timestamp when the deposit was first recorded. */
  recordedAt: string;
  /** ISO timestamp when the deposit was credited (settled/genesis). */
  creditedAt?: string;
  /** Why a deposit was skipped (status "skipped" only). */
  skipReason?: string;
  /** Free-form note (used for the genesis record). */
  note?: string;
}

/** deployments/deposits.json: the watcher's persisted state. */
export interface DepositsFile {
  network: string;
  chainId: number;
  contract: Address;
  /** Last block the watcher has scanned (inclusive). The next run scans
   *  from lastProcessedBlock + 1. */
  lastProcessedBlock: number;
  deposits: DepositRecord[];
}

/** A freshly parsed `Deposited` event, before it is recorded. */
export interface ParsedDeposit {
  depositor: Address;
  amountUqor: bigint;
  amountWei: bigint;
  tx: Hex;
  block: number;
  logIndex: number;
}

export type ParseDepositedLogResult =
  | { ok: true; deposit: ParsedDeposit }
  | { ok: false; reason: string };

/** The identity of a deposit: (transaction hash, log index). */
export function depositKey(tx: string, logIndex: number): string {
  return `${tx.toLowerCase()}:${logIndex}`;
}

/** Convert a wei amount to uqor, or null when it is not a whole number
 *  of uqor (a deposit that cannot be credited exactly). */
export function weiToUqor(amountWei: bigint): bigint | null {
  if (amountWei % WEI_PER_UQOR !== 0n) return null;
  return amountWei / WEI_PER_UQOR;
}

/** Minimal shape of a `Deposited` log as viem's getLogs returns it.
 *  (viem types decoded event args as optional and possibly undefined,
 *  so the parser validates them instead of assuming they are present.) */
export interface DepositedLogInput {
  args: { depositor?: string | undefined; amount?: bigint | undefined };
  transactionHash: string;
  blockNumber: bigint;
  logIndex: number;
}

/**
 * Parse one `Deposited` log into a creditable deposit. Returns a reason
 * instead of throwing, so the watcher can record unparseable logs as
 * `skipped` and keep going rather than dying on one bad event.
 */
export function parseDepositedLog(log: DepositedLogInput): ParseDepositedLogResult {
  const { depositor, amount } = log.args;
  if (typeof depositor !== "string" || !isAddress(depositor)) {
    return { ok: false, reason: `depositor is not a valid address: ${String(depositor)}` };
  }
  if (typeof amount !== "bigint") {
    return { ok: false, reason: `amount is not a bigint: ${String(amount)}` };
  }
  if (amount <= 0n) {
    return { ok: false, reason: `amount is not positive: ${amount}` };
  }
  const amountUqor = weiToUqor(amount);
  if (amountUqor === null) {
    return {
      ok: false,
      reason:
        `amount ${amount} wei is not a whole number of uqor ` +
        `(1 uqor = 10^12 wei) — cannot be credited exactly`,
    };
  }
  if (log.blockNumber < 0n || log.logIndex < 0) {
    return { ok: false, reason: `invalid block/log position: block ${log.blockNumber}, logIndex ${log.logIndex}` };
  }
  return {
    ok: true,
    deposit: {
      depositor: getAddress(depositor),
      amountUqor,
      amountWei: amount,
      tx: log.transactionHash as Hex,
      block: Number(log.blockNumber),
      logIndex: log.logIndex,
    },
  };
}

/**
 * Merge freshly parsed deposits into the recorded set. Deposits already
 * recorded (any status) are recognised by (tx, logIndex) and NOT added
 * again — this is the idempotency guarantee. New deposits are appended
 * with status "pending". Returns the merged list, the newly added
 * records, and the count of already-known deposits.
 */
export function mergeDeposits(
  existing: DepositRecord[],
  fresh: ParsedDeposit[],
  nowIso: string,
): { merged: DepositRecord[]; added: DepositRecord[]; alreadyKnown: number } {
  const known = new Set(existing.map((d) => depositKey(d.tx, d.logIndex)));
  const merged = [...existing];
  const added: DepositRecord[] = [];
  let alreadyKnown = 0;
  for (const f of fresh) {
    if (known.has(depositKey(f.tx, f.logIndex))) {
      alreadyKnown += 1;
      continue;
    }
    const record: DepositRecord = {
      depositor: f.depositor,
      amountUqor: f.amountUqor.toString(),
      amountWei: f.amountWei.toString(),
      tx: f.tx,
      block: f.block,
      logIndex: f.logIndex,
      status: "pending",
      creditedInBatch: null,
      recordedAt: nowIso,
    };
    merged.push(record);
    added.push(record);
    known.add(depositKey(f.tx, f.logIndex));
  }
  // Keep the file in chain order (block, then log index).
  merged.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return { merged, added, alreadyKnown };
}

/** Input for recording a deposit that could not be credited. */
export interface SkippedDepositInput {
  depositor: string;
  amountWei: string;
  tx: string;
  block: number;
  logIndex: number;
  reason: string;
}

/**
 * Record deposits that were seen on-chain but cannot be credited
 * (see parseDepositedLog). Deduplicated by (tx, logIndex) like everything
 * else — a re-scan records the same skip only once.
 */
export function recordSkippedDeposits(
  existing: DepositRecord[],
  skipped: SkippedDepositInput[],
  nowIso: string,
): { merged: DepositRecord[]; added: DepositRecord[] } {
  const known = new Set(existing.map((d) => depositKey(d.tx, d.logIndex)));
  const merged = [...existing];
  const added: DepositRecord[] = [];
  for (const s of skipped) {
    if (known.has(depositKey(s.tx, s.logIndex))) continue;
    const record: DepositRecord = {
      // A skipped deposit may carry an invalid address (that is why it
      // was skipped); keep the raw value rather than checksumming it.
      depositor: s.depositor as Address,
      amountUqor: "0",
      amountWei: s.amountWei,
      tx: s.tx as Hex,
      block: s.block,
      logIndex: s.logIndex,
      status: "skipped",
      creditedInBatch: null,
      recordedAt: nowIso,
      skipReason: s.reason,
    };
    merged.push(record);
    added.push(record);
    known.add(depositKey(s.tx, s.logIndex));
  }
  merged.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return { merged, added };
}

/** Pending deposits, in chain order — the ones the next settle must apply. */
export function pendingDeposits(file: DepositsFile): DepositRecord[] {
  return file.deposits
    .filter((d) => d.status === "pending")
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

/**
 * Mark deposits as settled by a batch. Pure: returns a new file object;
 * the caller writes it. Only "pending" deposits are flipped — anything
 * else (already settled, genesis, skipped) is left untouched, so a
 * double-mark can never re-credit.
 */
export function markDepositsSettled(
  file: DepositsFile,
  keys: Set<string>,
  batchId: number,
  nowIso: string,
): DepositsFile {
  return {
    ...file,
    deposits: file.deposits.map((d) => {
      if (d.status !== "pending") return d;
      if (!keys.has(depositKey(d.tx, d.logIndex))) return d;
      return { ...d, status: "settled" as const, creditedInBatch: batchId, creditedAt: nowIso };
    }),
  };
}

/** Total uqor credited by deposits in the given statuses. */
export function totalCreditedUqor(file: DepositsFile, statuses: DepositStatus[]): bigint {
  const wanted = new Set(statuses);
  return file.deposits
    .filter((d) => wanted.has(d.status))
    .reduce((sum, d) => sum + BigInt(d.amountUqor), 0n);
}

// ---------------------------------------------------------------------------
// Credit verification (watchtower check (e)/(f), sequencer pre-settle check)
// ---------------------------------------------------------------------------

/** A deposit credit claim to verify — from a batch file or deposits.json. */
export interface DepositClaim {
  depositor: string;
  amountUqor: string;
  tx: string;
  block: number;
  /** Log index of the Deposited event. Present for deposits.json records;
   *  batch files do not carry it, so batch claims match by tx alone. */
  logIndex?: number;
  /** Human label for failure messages, e.g. "batch #3". */
  source: string;
  /** Batch id for attribution (batch-file claims only). */
  batchId?: number;
}

/** A `Deposited` event log, normalised for matching. */
export interface DepositedLog {
  /** Lowercased depositor address. */
  depositor: string;
  amountWei: bigint;
  /** Lowercased EVM transaction hash. */
  tx: string;
  block: number;
  logIndex: number;
}

/** One failed credit check: the claim that failed and why. */
export interface DepositCheckFailure {
  claim: DepositClaim;
  message: string;
}

/**
 * Normalise raw `Deposited` logs (as viem's getLogs returns them) into
 * the shape the matchers use. A log whose args failed to decode cannot
 * back any claim — it cannot be matched — so it is left out.
 */
export function normalizeDepositedLogs(logs: DepositedLogInput[]): DepositedLog[] {
  const out: DepositedLog[] = [];
  for (const l of logs) {
    if (typeof l.args.depositor !== "string" || typeof l.args.amount !== "bigint") continue;
    out.push({
      depositor: l.args.depositor.toLowerCase(),
      amountWei: l.args.amount,
      tx: l.transactionHash.toLowerCase(),
      block: Number(l.blockNumber),
      logIndex: l.logIndex,
    });
  }
  return out;
}

/**
 * Match every claimed deposit credit against the on-chain `Deposited`
 * logs. A claim must match a real log — same transaction (and log
 * index, when the claim carries one), same depositor, same amount, same
 * block — and each log may back exactly one claim.
 *
 * Returns one failure per bad claim (empty when every claim checks
 * out). The two negative cases the audit cares about have explicit
 * messages: a claim with no on-chain event at all is a FAKE CREDIT,
 * and a claim larger than its supporting log is a CREDIT EXCEEDING ITS
 * DEPOSIT. A claim smaller than its log also fails: a credit must
 * equal its deposit exactly — partial credits are not supported, so a
 * short claim would leave funds unaccounted for.
 */
export function matchDepositClaims(
  claims: DepositClaim[],
  logs: DepositedLog[],
): DepositCheckFailure[] {
  const failures: DepositCheckFailure[] = [];
  /** Log key (tx:logIndex) -> the claim source that already used it. */
  const usedBy = new Map<string, string>();
  for (const claim of claims) {
    const fail = (message: string): void => {
      failures.push({ claim, message: `${claim.source}: ${message}` });
    };
    const txLower = claim.tx.toLowerCase();
    // Candidate logs: same tx, and the same log index when the claim
    // carries one (deposits.json records do; batch files do not).
    const candidates = logs.filter(
      (l) =>
        l.tx === txLower &&
        (claim.logIndex === undefined || l.logIndex === claim.logIndex),
    );
    if (candidates.length === 0) {
      fail(
        `claims a deposit from tx ${claim.tx} that has no Deposited event on-chain (fake credit)`,
      );
      continue;
    }
    const unused = candidates.filter((l) => !usedBy.has(depositKey(l.tx, l.logIndex)));
    if (unused.length === 0) {
      fail(
        `claims deposit ${claim.tx}, but that deposit is already claimed by ${usedBy.get(depositKey(candidates[0].tx, candidates[0].logIndex))} (double-credit)`,
      );
      continue;
    }
    // Lowest log index first, so two claims for one tx (no log index)
    // consume the tx's logs in order rather than colliding.
    unused.sort((a, b) => a.logIndex - b.logIndex);
    const log = unused[0];
    usedBy.set(depositKey(log.tx, log.logIndex), claim.source);
    if (log.depositor !== claim.depositor.toLowerCase()) {
      fail(
        `names depositor ${claim.depositor}, but the on-chain event for tx ${claim.tx} names ${log.depositor}`,
      );
    }
    let claimWei: bigint;
    try {
      claimWei = BigInt(claim.amountUqor) * WEI_PER_UQOR;
    } catch {
      fail(`has an invalid amount: ${claim.amountUqor} uqor`);
      continue;
    }
    if (claimWei > log.amountWei) {
      fail(
        `claims ${claim.amountUqor} uqor, but the supporting L1 deposit in tx ${claim.tx} is only ${log.amountWei / WEI_PER_UQOR} uqor — the credit EXCEEDS its deposit`,
      );
    } else if (claimWei < log.amountWei) {
      fail(
        `claims ${claim.amountUqor} uqor, but the L1 deposit in tx ${claim.tx} is ${log.amountWei / WEI_PER_UQOR} uqor — a credit must equal its deposit exactly`,
      );
    }
    if (log.block !== claim.block) {
      fail(
        `claims block ${claim.block}, but the on-chain event for tx ${claim.tx} is in block ${log.block}`,
      );
    }
  }
  return failures;
}

/** A credited deposit for the totals check (amount + owner only). */
export interface CreditedDeposit {
  depositor: string;
  amountUqor: string;
}

/**
 * Check credited amounts against the L1 deposits supporting them:
 * in aggregate (total credited must not exceed the contract's
 * cumulative `totalDeposited`) and per depositor (each account's
 * credited total must not exceed that account's own L1 deposits).
 * A non-whole-uqor L1 deposit supports nothing — it can never be
 * credited — so it is left out of the per-depositor support.
 * Returns one failure per violated bound (empty when all is well).
 */
export function verifyDepositTotals(
  credited: CreditedDeposit[],
  logs: DepositedLog[],
  totalDepositedUqor: bigint,
): string[] {
  const failures: string[] = [];
  const totalCredited = credited.reduce((sum, c) => sum + BigInt(c.amountUqor), 0n);
  if (totalCredited > totalDepositedUqor) {
    failures.push(
      `total credited deposits (${totalCredited} uqor) exceed the contract's totalDeposited (${totalDepositedUqor} uqor) — credits larger than the supporting L1 deposits`,
    );
  }
  const support = new Map<string, bigint>();
  for (const l of logs) {
    const uqor = weiToUqor(l.amountWei);
    if (uqor === null) continue;
    support.set(l.depositor, (support.get(l.depositor) ?? 0n) + uqor);
  }
  const perAccount = new Map<string, bigint>();
  for (const c of credited) {
    const key = c.depositor.toLowerCase();
    perAccount.set(key, (perAccount.get(key) ?? 0n) + BigInt(c.amountUqor));
  }
  for (const [account, amount] of [...perAccount.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const backed = support.get(account) ?? 0n;
    if (amount > backed) {
      failures.push(
        `${account} is credited ${amount} uqor but its L1 deposits total only ${backed} uqor — the credit exceeds the supporting deposits`,
      );
    }
  }
  return failures;
}

/**
 * Cross-check the watcher ledger (deposits.json) against the batch
 * files: every settled record must be claimed by the batch it names,
 * and every batch claim must have a settled record naming that batch.
 * Genesis records are exempt (they predate the watcher and are claimed
 * by no batch); pending records are exempt (not yet credited).
 * Returns one failure per inconsistency (empty when the ledgers agree).
 */
export function checkDepositLedgerConsistency(
  records: DepositRecord[],
  batchClaims: Array<{ batchId: number; tx: string }>,
): string[] {
  const failures: string[] = [];
  for (const r of records.filter((d) => d.status === "settled")) {
    if (r.creditedInBatch === null) {
      failures.push(
        `deposits.json: settled deposit ${r.tx} names no batch (creditedInBatch is null)`,
      );
      continue;
    }
    const claimed = batchClaims.some(
      (c) => c.batchId === r.creditedInBatch && c.tx.toLowerCase() === r.tx.toLowerCase(),
    );
    if (!claimed) {
      failures.push(
        `deposits.json: deposit ${r.tx} is marked settled by batch #${r.creditedInBatch}, but batch #${r.creditedInBatch} does not claim it`,
      );
    }
  }
  for (const c of batchClaims) {
    const rec = records.find((d) => d.tx.toLowerCase() === c.tx.toLowerCase());
    if (!rec) {
      failures.push(
        `batch #${c.batchId} claims deposit ${c.tx}, but deposits.json has no record of it`,
      );
    } else if (rec.status !== "settled" || rec.creditedInBatch !== c.batchId) {
      failures.push(
        `batch #${c.batchId} claims deposit ${c.tx}, but deposits.json marks it ${rec.status} (creditedInBatch ${rec.creditedInBatch})`,
      );
    }
  }
  return failures;
}

/**
 * The watcher's cross-check as a pure predicate: the credited total
 * (given statuses) must not exceed the contract's cumulative
 * `totalDeposited`. Returns a failure message, or null when the bound
 * holds. The watcher refuses to write its file on a failure.
 */
export function checkCreditedTotal(
  file: DepositsFile,
  statuses: DepositStatus[],
  totalDepositedUqor: bigint,
): string | null {
  const credited = totalCreditedUqor(file, statuses);
  if (credited > totalDepositedUqor) {
    return (
      `credited deposits total ${credited} uqor but the contract's totalDeposited ` +
      `is only ${totalDepositedUqor} uqor — the file claims more than the chain ever received`
    );
  }
  return null;
}
