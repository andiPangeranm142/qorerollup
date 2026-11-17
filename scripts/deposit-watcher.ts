/**
 * deposit-watcher.ts - ingest L1 deposits into the rollup automatically.
 *
 * Usage: npm run deposit-watcher
 *
 * Reads `Deposited` events from the settlement contract (viem getLogs,
 * polling from the persisted last-processed block) and records them in
 * deployments/deposits.json. New deposits become "pending"; the
 * sequencer applies the pending ones into the next batch's state
 * transition (see applyDeposits in src/lib/rollup.ts) and marks them
 * "settled". The watchtower independently matches every batch deposit
 * against the on-chain logs.
 *
 * Idempotency: a deposit is identified by (transaction hash, log index).
 * A deposit already in deployments/deposits.json is NEVER credited
 * again, however often the watcher re-scans — re-runs find the same
 * events, recognise them as already known, and credit nothing.
 *
 * Bootstrap: on a fresh rollup (no state.json, or batchCount 0) the
 * watcher initialises deployments/deposits.json from the deploy block.
 * On a rollup that already has batches but no deposits.json, it REFUSES
 * to guess: the operator must create the file first, marking the
 * deposits that were already credited by hand (the genesis funding) —
 * otherwise the first scan would credit them a second time.
 *
 * Liveness (honest): the watcher is an off-chain process. If it is
 * down, deposits queue on-chain until it runs again — deposits are
 * never lost, because the events stay on-chain and the next scan picks
 * them up from the persisted last-processed block.
 *
 * Read-only: it sends no transactions and needs no secrets or env vars.
 * It appends one step per run to deployments/usage.json (the run log).
 */
import { createEvmClient } from "@qorechain/evm";
import { parseAbi, type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { cosmosHashForEvmTx } from "./cosmos-hash";
import {
  checkCreditedTotal,
  mergeDeposits,
  parseDepositedLog,
  pendingDeposits,
  recordSkippedDeposits,
  totalCreditedUqor,
  type DepositsFile,
  type ParsedDeposit,
  type SkippedDepositInput,
} from "../src/lib/deposits";

const TESTNET_CHAIN_ID = 9800;
const WEI_PER_UQOR = 10n ** 12n;
/** getLogs range per request (keeps RPC responses small). */
const SCAN_CHUNK_BLOCKS = 2000n;

const DEPOSITED_EVENT = parseAbi([
  "event Deposited(address indexed depositor, uint256 amount)",
])[0];

const TOTAL_DEPOSITED_ABI = parseAbi([
  "function totalDeposited() view returns (uint256)",
]);

// npm scripts run with the working directory at the package root.
const ROOT = process.cwd();
const DEPLOYMENTS = path.resolve(ROOT, "deployments");
const DEPOSITS_PATH = path.resolve(DEPLOYMENTS, "deposits.json");
const STATE_PATH = path.resolve(DEPLOYMENTS, "state.json");
const USAGE_PATH = path.resolve(DEPLOYMENTS, "usage.json");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
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

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
  const deploymentPath = path.resolve(DEPLOYMENTS, "testnet.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("No deployments/testnet.json yet — deploy the contract first.");
  }
  const deployment = readJson<{ contract: Address; deployBlock: number }>(deploymentPath);
  const { contract } = deployment;
  const deployBlock = deployment.deployBlock;

  // --- Load or bootstrap the persisted watcher state. ---
  let file: DepositsFile;
  if (fs.existsSync(DEPOSITS_PATH)) {
    file = readJson<DepositsFile>(DEPOSITS_PATH);
    if (file.contract.toLowerCase() !== contract.toLowerCase()) {
      throw new Error(
        `Refusing: deployments/deposits.json is for contract ${file.contract}, ` +
          `but testnet.json says ${contract}. The watcher state belongs to another deployment.`,
      );
    }
  } else {
    const state = fs.existsSync(STATE_PATH)
      ? readJson<{ batchCount: number }>(STATE_PATH)
      : null;
    if (state && state.batchCount > 0) {
      throw new Error(
        "No deployments/deposits.json, but deployments/state.json already has " +
          `${state.batchCount} settled batch(es). Refusing to guess which deposits were ` +
          "already credited by hand: create deployments/deposits.json first, marking the " +
          "already-credited deposits (e.g. the genesis funding) with status \"genesis\" — " +
          "otherwise the first scan would credit them a second time.",
      );
    }
    file = {
      network: "qorechain-diana",
      chainId: TESTNET_CHAIN_ID,
      contract,
      lastProcessedBlock: deployBlock - 1,
      deposits: [],
    };
    console.log("No deposits.json — initialising fresh from the deploy block.");
  }

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Refusing: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`);
  }
  const latestBlock = await client.publicClient.getBlockNumber();
  const fromBlock = BigInt(file.lastProcessedBlock) + 1n;
  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  console.log(`scanning: blocks ${fromBlock}..${latestBlock}`);

  // --- Fetch Deposited events in chunks, in chain order. ---
  const logs: Array<{
    args: { depositor?: string | undefined; amount?: bigint | undefined };
    transactionHash: string;
    blockNumber: bigint;
    logIndex: number;
  }> = [];
  for (let start = fromBlock; start <= latestBlock; start += SCAN_CHUNK_BLOCKS) {
    const end = start + SCAN_CHUNK_BLOCKS - 1n > latestBlock ? latestBlock : start + SCAN_CHUNK_BLOCKS - 1n;
    const chunk = await client.publicClient.getLogs({
      address: contract,
      event: DEPOSITED_EVENT,
      fromBlock: start,
      toBlock: end,
    });
    logs.push(...chunk);
  }
  logs.sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex,
  );
  console.log(`found:    ${logs.length} Deposited event(s)`);

  // --- Parse, merge, and record skips. ---
  const nowIso = new Date().toISOString();
  const fresh: ParsedDeposit[] = [];
  const skipped: SkippedDepositInput[] = [];
  for (const log of logs) {
    const parsed = parseDepositedLog(log);
    if (parsed.ok) {
      fresh.push(parsed.deposit);
    } else {
      console.log(`  skip: tx ${log.transactionHash} (block ${log.blockNumber}): ${parsed.reason}`);
      skipped.push({
        depositor: log.args.depositor ?? "unknown",
        amountWei: log.args.amount?.toString() ?? "unknown",
        tx: log.transactionHash,
        block: Number(log.blockNumber),
        logIndex: log.logIndex,
        reason: parsed.reason,
      });
    }
  }
  const { merged, added, alreadyKnown } = mergeDeposits(file.deposits, fresh, nowIso);
  const skipResult = recordSkippedDeposits(merged, skipped, nowIso);
  const newFile: DepositsFile = {
    ...file,
    lastProcessedBlock: Number(latestBlock),
    deposits: skipResult.merged,
  };

  // --- Cross-check: credited funds must never exceed the chain's total. ---
  const totalDepositedWei = (await client.publicClient.readContract({
    address: contract,
    abi: TOTAL_DEPOSITED_ABI,
    functionName: "totalDeposited",
  })) as bigint;
  const totalDepositedUqor = totalDepositedWei / WEI_PER_UQOR;
  const credited = totalCreditedUqor(newFile, ["pending", "settled", "genesis"]);
  const totalFailure = checkCreditedTotal(newFile, ["pending", "settled", "genesis"], totalDepositedUqor);
  if (totalFailure) {
    throw new Error(
      `Refusing to write: ${totalFailure}. Reconcile deployments/deposits.json by hand.`,
    );
  }

  // --- Resolve Cosmos hashes for the newly added deposits (best effort). ---
  // `added` holds the SAME record objects that are already inside
  // newFile.deposits (mergeDeposits pushes one object into both lists),
  // so setting cosmosTx here lands in the written file.
  for (const d of added) {
    try {
      const { cosmosHash } = await cosmosHashForEvmTx(client.publicClient, d.tx as Hex);
      d.cosmosTx = cosmosHash;
    } catch (err) {
      console.log(
        `  warn: could not resolve the Cosmos hash for ${d.tx} (${err instanceof Error ? err.message : err}) — continuing with the EVM hash only.`,
      );
    }
    console.log(
      `  new: ${d.amountUqor} uqor from ${d.depositor} (tx ${d.tx}, block ${d.block}) -> pending`,
    );
  }
  if (alreadyKnown > 0) {
    console.log(`  already known: ${alreadyKnown} (recognised, NOT credited again)`);
  }
  if (skipResult.added.length > 0) {
    console.log(`  skipped (uncreditable): ${skipResult.added.length} (recorded, funds stay in the contract)`);
  }

  writeJson(DEPOSITS_PATH, newFile);
  const pending = pendingDeposits(newFile);
  const pendingTotal = pending.reduce((sum, d) => sum + BigInt(d.amountUqor), 0n);
  console.log(`pending:  ${pending.length} deposit(s), ${pendingTotal} uqor awaiting the next settle`);
  console.log(`scanned through block ${latestBlock}`);
  console.log(
    `cross-check: credited ${credited} uqor <= totalDeposited ${totalDepositedUqor} uqor — OK`,
  );

  appendUsageStep(contract, {
    command: "deposit-watcher",
    fromBlock: Number(fromBlock),
    toBlock: Number(latestBlock),
    eventsFound: logs.length,
    newDeposits: added.map((d) => ({
      depositor: d.depositor,
      amountUqor: d.amountUqor,
      tx: d.tx,
      cosmosTx: d.cosmosTx ?? null,
      block: d.block,
    })),
    alreadyKnown,
    skipped: skipResult.added.map((d) => ({ tx: d.tx, reason: d.skipReason })),
    pendingCount: pending.length,
    pendingUqor: pendingTotal.toString(),
    creditedUqor: credited.toString(),
    totalDepositedUqor: totalDepositedUqor.toString(),
  });
  console.log("Run recorded in deployments/usage.json.");
}

main().catch((err: unknown) => {
  console.error(`\nDeposit watcher failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
