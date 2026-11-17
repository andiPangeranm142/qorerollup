/**
 * watchtower.ts - re-verify every settled QoreRollup batch.
 *
 * Usage: npm run watchtower
 *
 * For each batch 0..batchCount-1 it loads deployments/batches/batch-<id>.json
 * and verifies, via the pure verifyBatch in src/lib/rollup.ts:
 *  (a) the ML-DSA-87 signature verifies off-chain against the sequencer's
 *      REGISTERED public key (fetched from the chain with fetchPqcStatus),
 *      over the recomputed batch digest;
 *  (b) the state transition replays from the previous batch's balances and
 *      matches both the batch file and the on-chain getBatch record;
 *  (c) the on-chain receiptHash matches the recomputed receipt;
 *  (d) when ../kem-key.json exists, the sealed blob decrypts to a payload
 *      matching the batch file; otherwise the decrypt check is SKIPPED and
 *      the other checks still run.
 *
 * Prints one OK/FAIL line per batch naming which check failed, and exits 0
 * only if every batch passes. Read-only: it never sends a transaction.
 *
 * Honest limits (see THREAT_MODEL.md): the watchtower is ADVISORY — it
 * cannot halt settlement or slash anyone — and it shares the rollup.ts
 * encoding library with the sequencer, so a bug in the shared library would
 * not be caught here. What it does catch is a sequencer that settles
 * something different from what its own batch files claim.
 */
import { createEvmClient, readContract } from "@qorechain/evm";
import { fetchPqcStatus, pqcStatusPublicKey } from "@qorechain/sdk";
import { hexToBytes, type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import {
  GENESIS_STATE_ROOT,
  applyTxs,
  rollupTxFromJson,
  verifyBatch,
  type BatchFile,
  type OnChainBatch,
} from "../src/lib/rollup";

const TESTNET_CHAIN_ID = 9800;
const TESTNET_REST = "https://api-testnet.qore.host";
const SEQUENCER_COSMOS = "qor1q9q2q4hwxl2jgzcrjlkd7y68m2qwxwul0nheda";

// npm scripts run with the working directory at the package root.
const ROOT = process.cwd();
const DEPLOYMENTS = path.resolve(ROOT, "deployments");
const BATCHES_DIR = path.resolve(DEPLOYMENTS, "batches");
/** OUTSIDE the repo (mode 600). Absent => decrypt check is skipped. */
const KEM_SECRET_PATH = path.resolve(ROOT, "..", "kem-key.json");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function recordsToBalances(record: Record<string, string>): Map<Address, bigint> {
  return new Map(
    Object.entries(record).map(
      ([addr, bal]) => [addr.toLowerCase() as Address, BigInt(bal)] as const,
    ),
  );
}

function recordsToNonces(record: Record<string, number>): Map<Address, number> {
  return new Map(
    Object.entries(record).map(
      ([addr, n]) => [addr.toLowerCase() as Address, n] as const,
    ),
  );
}

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
  const deploymentPath = path.resolve(DEPLOYMENTS, "testnet.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      "No deployments/testnet.json yet — the settlement contract has not been deployed.",
    );
  }
  const { contract } = readJson<{ contract: Address }>(deploymentPath);
  const artifactPath = path.resolve(
    ROOT,
    "artifacts",
    "contracts",
    "QoreRollup.sol",
    "QoreRollup.json",
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error("No compiled QoreRollup artifact yet — run `npm run compile` first.");
  }
  const abi = readJson<{ abi: unknown }>(artifactPath).abi as never;

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Refusing: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`);
  }

  // The sequencer's REGISTERED public key is the trust anchor for check (a):
  // fetched from the chain, never from a local file.
  const pqcStatus = await fetchPqcStatus({ rest: TESTNET_REST, address: SEQUENCER_COSMOS });
  const sequencerPublicKey = pqcStatusPublicKey(pqcStatus);
  if (!pqcStatus.registered || !sequencerPublicKey) {
    throw new Error(
      `Sequencer ${SEQUENCER_COSMOS} has no registered ML-DSA-87 public key on-chain — ` +
        "the watchtower cannot verify any signature. Run `npm run window register` for the sequencer account first.",
    );
  }
  console.log(`network:   QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract:  ${contract}`);
  console.log(`sequencer: ${SEQUENCER_COSMOS} (registered ML-DSA-87 key, ${sequencerPublicKey.length} bytes)`);

  // Decrypt check key: present only on the operator's machine.
  let kemSecretKey: Uint8Array | undefined;
  if (fs.existsSync(KEM_SECRET_PATH)) {
    const { secretKeyHex } = readJson<{ secretKeyHex: Hex }>(KEM_SECRET_PATH);
    kemSecretKey = hexToBytes(secretKeyHex);
    console.log("decrypt check: enabled (KEM secret key found)");
  } else {
    console.log("decrypt check SKIPPED (key file not found)");
  }

  const batchCount = Number(
    (await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: "batchCount",
    })) as bigint,
  );
  console.log(`batches on-chain: ${batchCount}`);
  if (batchCount === 0) {
    console.log("No batches settled yet — nothing to verify.");
    return;
  }

  // Chain the pre-batch state through the batch files: batch 0 starts from
  // genesis, each later batch from the previous file's post-state.
  let prevStateRoot: Hex = GENESIS_STATE_ROOT;
  let prevBalances = new Map<Address, bigint>();
  let prevNonces = new Map<Address, number>();
  let allOk = true;

  for (let batchId = 0; batchId < batchCount; batchId++) {
    const batchPath = path.resolve(BATCHES_DIR, `batch-${batchId}.json`);
    const onChainRaw = (await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: "getBatch",
      args: [BigInt(batchId)],
    })) as [Hex, Hex, Hex, bigint, Hex];
    const onChain: OnChainBatch = {
      stateRoot: onChainRaw[0],
      txDataCommitment: onChainRaw[1],
      encryptedDataHash: onChainRaw[2],
      timestamp: onChainRaw[3],
      receiptHash: onChainRaw[4],
    };

    if (!fs.existsSync(batchPath)) {
      console.log(`batch ${batchId}: FAIL — batch file missing (${batchPath})`);
      allOk = false;
      // Cannot chain past a missing file: the next batch's pre-state is unknown.
      break;
    }
    const batch = readJson<BatchFile>(batchPath);
    const result = verifyBatch(batch, onChain, {
      chainId,
      contract,
      batchId,
      sequencerPublicKey,
      prevStateRoot,
      prevBalances,
      prevNonces,
      kemSecretKey,
    });
    if (result.ok) {
      console.log(`batch ${batchId}: OK`);
    } else {
      allOk = false;
      console.log(`batch ${batchId}: FAIL — ${result.failures.join("; ")}`);
    }

    // Advance the chained pre-state from this file's post-state; if the file
    // predates the balances field, replay the transition instead.
    if (batch.balances && batch.nonces) {
      prevBalances = recordsToBalances(batch.balances);
      prevNonces = recordsToNonces(batch.nonces);
    } else {
      try {
        const replayed = applyTxs(
          batch.prevStateRoot,
          prevBalances,
          batch.txs.map(rollupTxFromJson),
          prevNonces,
        );
        prevBalances = replayed.newBalances;
        prevNonces = replayed.newNonces;
      } catch {
        // verifyBatch already reported the replay failure above; keep the
        // previous pre-state so later batches fail loudly too.
      }
    }
    prevStateRoot = batch.stateRoot;
  }

  console.log(allOk ? "\nWatchtower: ALL BATCHES OK" : "\nWatchtower: FAILURES FOUND (see above)");
  process.exitCode = allOk ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`\nWatchtower failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
