/**
 * revert-demos.ts - three on-chain revert demos for the settlement contract
 * (each a REAL reverted transaction, EVM receipt status 0).
 *
 * Usage (each demo needs a live EVM authorisation window for the CALLER;
 * run `npx tsx --env-file=<env> scripts/window.ts open` first):
 *
 *   # (a) REPLAY — resubmit an already-settled batch, verbatim
 *   #     (same stateRoot / commitment / encrypted-data hash / signature).
 *   #     submitBatch binds the signature to the NEXT batch id, so the
 *   #     replayed signature verifies against no current digest:
 *   #     expect InvalidBatchSignature, batchCount unchanged.
 *   npx tsx --env-file=../.env scripts/revert-demos.ts replay --batch <N>
 *
 *   # (b) WRONG ACCOUNT — withdraw with a VALID proof that belongs to a
 *   #     DIFFERENT account (the victim's leaf balance/nonce/proof, the
 *   #     caller's own address as `account`, so the NotAccountOwner check
 *   #     passes and the proof check is what fails):
 *   #     expect InvalidMerkleProof, withdrawnAmount unchanged.
 *   npx tsx --env-file=../.env.fresh2 scripts/revert-demos.ts wrong-account \
 *     --batch <N> --victim <0x address>
 *
 *   # (c) STALE / NONEXISTENT batchId — withdraw against a batchId that
 *   #     does not exist, with the caller's own valid leaf data:
 *   #     expect BatchNotFound, withdrawnAmount unchanged.
 *   npx tsx --env-file=../.env.fresh1 scripts/revert-demos.ts stale-batch \
 *     --batch <N> --fake <M>
 *
 * Each demo first SIMULATES the call (eth_call) to capture the revert
 * reason the contract returns, then broadcasts it with EXPLICIT gas
 * (viem estimation would fail before broadcast for a reverting call) and
 * requires the EVM receipt to be reverted. The reverting tx is recorded
 * in deployments/usage.json ({ command: "revert-demo", demo: ..., ... })
 * with the EVM hash, the Cosmos hash, the block, the receipt status and
 * the simulated revert reason. Note: the explorer shows reverted EVM
 * txs as Cosmos-level "success" — the revert is in the EVM receipt
 * (status 0), which this script checks explicitly.
 *
 * Safety: testnet ONLY (EVM chain id 9800). Secrets come from the
 * env file passed with --env-file and are never printed. If a demo
 * transaction does NOT revert, this script exits non-zero and shouts:
 * that would mean the attack SUCCEEDED.
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  evmWindowStatus,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { cosmosHashForEvmTx } from "./cosmos-hash";
import type { BatchFile } from "../src/lib/rollup";

const TESTNET_CHAIN_ID = 9800;
const TESTNET_REST = "https://api-testnet.qore.host";
/** Explicit gas for reverting demo txs (estimation would fail pre-broadcast). */
const REVERT_GAS_WITHDRAW = 500_000n;
const REVERT_GAS_SUBMIT = 2_000_000n;
const SEQUENCER_EVM = "0x0140a056ee37D5240b0397eCdF1347Da80E33b9f" as Address;

const ROOT = process.cwd();
const DEPLOYMENTS = path.resolve(ROOT, "deployments");
const BATCHES_DIR = path.resolve(DEPLOYMENTS, "batches");
const USAGE_PATH = path.resolve(DEPLOYMENTS, "usage.json");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
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

/** Parse `--flag value` pairs out of argv. */
function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith("--")) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        out[arg.slice(2)] = "true";
      } else {
        out[arg.slice(2)] = value;
        i++;
      }
    }
  }
  return out;
}

function loadBatch(batchId: number): BatchFile {
  const batchPath = path.resolve(BATCHES_DIR, `batch-${batchId}.json`);
  if (!fs.existsSync(batchPath)) {
    throw new Error(`No batch file for batch ${batchId} (${batchPath}).`);
  }
  return readJson<BatchFile>(batchPath);
}

async function connect() {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;
  const mnemonic = requireEnv("QORE_MNEMONIC");
  const deploymentPath = path.resolve(DEPLOYMENTS, "testnet.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("No deployments/testnet.json yet — deploy the contract first.");
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
  const account = evmAccountFromPrivateKey(privateKey);
  const wallet = client.getWalletClient(account);
  const unified = await deriveUnifiedAccount(mnemonic, 0);
  if (unified.evm.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `Refusing: QORE_MNEMONIC derives EVM address ${unified.evm}, not the private-key account ${account.address}.`,
    );
  }
  return { client, contract, abi, chainId, account, wallet, unified };
}

async function requireLiveWindow(cosmosAddress: string): Promise<void> {
  const window = await evmWindowStatus({ rest: TESTNET_REST, address: cosmosAddress });
  if (!window.found || !window.live || window.remainingTxs < 1n) {
    throw new Error(
      `No live EVM authorisation window for ${cosmosAddress}. ` +
        "Run `npx tsx --env-file=<env> scripts/window.ts open` first, then retry.",
    );
  }
  console.log(
    `window: live (${window.remainingBlocks} blocks, ${window.remainingTxs} txs, ${window.remainingValue} uqor left)`,
  );
}

/**
 * Simulate a call to capture the revert reason the contract returns
 * (viem decodes the custom error from the ABI). Returns the reason
 * string; throws if the simulation SUCCEEDS (the attack would work).
 */
async function simulateRevert(
  client: Awaited<ReturnType<typeof connect>>["client"],
  contract: Address,
  abi: never,
  call: { functionName: string; args: unknown[]; account: Address },
): Promise<string> {
  try {
    await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: call.functionName,
      args: call.args,
      account: call.account,
    } as never);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // viem surfaces the custom error name in the message, e.g.
    // "InvalidBatchSignature()" or "BatchNotFound(999)".
    const match = message.match(/(InvalidBatchSignature|InvalidMerkleProof|BatchNotFound|NotAccountOwner|ZeroWithdraw|OnlySequencer|EmptyBatch)\b[^\n]*/);
    return match ? match[0] : message.split("\n")[0] ?? message;
  }
  throw new Error(
    `SIMULATION SUCCEEDED — the ${call.functionName} call would NOT revert. ` +
      "Refusing to broadcast: investigate before continuing.",
  );
}

/** (a) REPLAY — resubmit an already-settled batch verbatim. */
async function replay(args: string[]): Promise<void> {
  const f = flags(args);
  const batchIdRaw = f["batch"];
  if (!batchIdRaw || !/^\d+$/.test(batchIdRaw)) {
    throw new Error("Usage: revert-demos replay --batch <N>");
  }
  const batchId = Number(batchIdRaw);
  const batch = loadBatch(batchId);
  const { client, contract, abi, chainId, account, wallet, unified } = await connect();
  if (account.address.toLowerCase() !== SEQUENCER_EVM.toLowerCase()) {
    throw new Error(
      `Refusing: replay must be sent by the sequencer (${SEQUENCER_EVM}), not ${account.address} — the OnlySequencer check would mask the signature check.`,
    );
  }
  const batchCountBefore = Number(
    (await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: "batchCount",
    })) as bigint,
  );
  if (batchId >= batchCountBefore) {
    throw new Error(`Batch #${batchId} has not settled yet (batchCount ${batchCountBefore}) — nothing to replay.`);
  }
  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  console.log(`sender:   ${account.address} (the sequencer itself)`);
  console.log(`replaying batch #${batchId} verbatim (stateRoot ${batch.stateRoot})`);
  console.log(`batchCount before: ${batchCountBefore} — the replayed signature is over digest(batchId=${batchId}), not digest(batchId=${batchCountBefore})`);

  await requireLiveWindow(unified.cosmos);

  const callArgs = [batch.stateRoot, batch.txDataCommitment, batch.encryptedDataHash, batch.signature] as unknown[];
  const reason = await simulateRevert(client, contract, abi, {
    functionName: "submitBatch",
    args: callArgs,
    account: account.address,
  });
  console.log(`simulation: the call would REVERT (${reason})`);

  console.log("\nResubmitting the settled batch with explicit gas (expecting an on-chain revert)…");
  const hash = await writeContract(wallet, {
    address: contract,
    abi,
    functionName: "submitBatch",
    args: callArgs,
    value: 0n,
    account: wallet.account ?? null,
    chain: wallet.chain,
    gas: REVERT_GAS_SUBMIT,
  } as never);
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, hash);
  console.log(`  tx: ${hash}`);
  console.log(`  cosmos: ${cosmos.cosmosHash} (block ${cosmos.block})`);
  console.log(`  EVM receipt status: ${receipt.status}`);
  const batchCountAfter = Number(
    (await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: "batchCount",
    })) as bigint,
  );
  console.log(`batchCount after: ${batchCountAfter}`);

  appendUsageStep(contract, {
    command: "revert-demo",
    demo: "replay",
    expected: "revert",
    expectedReason: "InvalidBatchSignature",
    simulatedReason: reason,
    note: "An already-settled batch (same stateRoot, tx-data commitment, encrypted-data hash and ML-DSA-87 signature) resubmitted verbatim. submitBatch binds the signature to the NEXT batch id, so the replayed signature cannot verify against the current digest.",
    replayedBatchId: batchId,
    nextBatchId: batchCountBefore,
    stateRoot: batch.stateRoot,
    txDataCommitment: batch.txDataCommitment,
    encryptedDataHash: batch.encryptedDataHash,
    tx: hash,
    cosmosTx: cosmos.cosmosHash,
    block: cosmos.block,
    receiptStatus: receipt.status,
    batchCountBefore,
    batchCountAfter,
  });

  if (receipt.status !== "reverted") {
    console.error("\n*** REPLAY ACCEPTED — THE CONTRACT DID NOT REVERT! ***");
    process.exitCode = 1;
    return;
  }
  if (batchCountAfter !== batchCountBefore) {
    console.error("\n*** batchCount MOVED despite the revert — inconsistent state! ***");
    process.exitCode = 1;
    return;
  }
  console.log("\nReplayed batch REVERTED on-chain as expected. No batch recorded, batchCount unchanged.");
  console.log("Recorded in deployments/usage.json.");
}

/** (b) WRONG ACCOUNT — withdraw with another account's valid proof. */
async function wrongAccount(args: string[]): Promise<void> {
  const f = flags(args);
  const batchIdRaw = f["batch"];
  const victimRaw = f["victim"];
  if (!batchIdRaw || !/^\d+$/.test(batchIdRaw) || !victimRaw || !isAddress(victimRaw)) {
    throw new Error("Usage: revert-demos wrong-account --batch <N> --victim <0x address>");
  }
  const batchId = Number(batchIdRaw);
  const victim = getAddress(victimRaw);
  const batch = loadBatch(batchId);
  const { client, contract, abi, chainId, account, wallet, unified } = await connect();
  if (account.address.toLowerCase() === victim.toLowerCase()) {
    throw new Error("The caller IS the victim — pick a different --victim.");
  }
  const leaf = batch.leaves?.find((l) => l.account.toLowerCase() === victim.toLowerCase());
  if (!leaf) {
    throw new Error(`Victim ${victim} has no leaf in batch ${batchId}.`);
  }
  const proof = batch.proofs?.[victim.toLowerCase()];
  if (!Array.isArray(proof)) {
    throw new Error(`No Merkle proof stored for ${victim} in batch ${batchId}.`);
  }
  const balance = BigInt(leaf.balance);
  const nonce = leaf.nonce;
  const withdrawnBefore = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "withdrawnAmount",
    args: [account.address],
  })) as bigint;

  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  console.log(`caller:   ${account.address} (withdrawing as itself — NotAccountOwner passes)`);
  console.log(`victim:   ${victim} (the proof's real owner, batch #${batchId})`);
  console.log(`proof:    ${proof.length} element(s) for the victim's leaf (balance ${balance} uqor, nonce ${nonce})`);
  console.log(`already withdrawn (caller, cumulative cap): ${withdrawnBefore} uqor`);

  await requireLiveWindow(unified.cosmos);

  const callArgs = [BigInt(batchId), account.address, balance, BigInt(nonce), proof] as unknown[];
  const reason = await simulateRevert(client, contract, abi, {
    functionName: "withdraw",
    args: callArgs,
    account: account.address,
  });
  console.log(`simulation: the call would REVERT (${reason})`);

  console.log("\nSending the wrong-account withdrawal with explicit gas (expecting an on-chain revert)…");
  const hash = await writeContract(wallet, {
    address: contract,
    abi,
    functionName: "withdraw",
    args: callArgs,
    value: 0n,
    account: wallet.account ?? null,
    chain: wallet.chain,
    gas: REVERT_GAS_WITHDRAW,
  } as never);
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, hash);
  console.log(`  tx: ${hash}`);
  console.log(`  cosmos: ${cosmos.cosmosHash} (block ${cosmos.block})`);
  console.log(`  EVM receipt status: ${receipt.status}`);
  const withdrawnAfter = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "withdrawnAmount",
    args: [account.address],
  })) as bigint;
  console.log(`withdrawnAmount after: ${withdrawnAfter} uqor`);

  appendUsageStep(contract, {
    command: "revert-demo",
    demo: "wrong-account",
    expected: "revert",
    expectedReason: "InvalidMerkleProof",
    simulatedReason: reason,
    note: "A withdrawal with a VALID Merkle proof that belongs to a different account: the caller passes NotAccountOwner (it withdraws as itself) but the computed leaf (caller, victim's balance, victim's nonce) is not in the tree, so the proof check fails.",
    batchId,
    account: account.address,
    victim,
    balanceUqor: balance.toString(),
    nonce,
    leaf: leaf.leaf,
    tx: hash,
    cosmosTx: cosmos.cosmosHash,
    block: cosmos.block,
    receiptStatus: receipt.status,
    withdrawnAmountBefore: withdrawnBefore.toString(),
    withdrawnAmountAfter: withdrawnAfter.toString(),
  });

  if (receipt.status !== "reverted") {
    console.error("\n*** WRONG-ACCOUNT WITHDRAWAL DID NOT REVERT — investigate! ***");
    process.exitCode = 1;
    return;
  }
  if (withdrawnAfter !== withdrawnBefore) {
    console.error("\n*** withdrawnAmount MOVED despite the revert — inconsistent state! ***");
    process.exitCode = 1;
    return;
  }
  console.log("\nWrong-account withdrawal REVERTED on-chain as expected. Cumulative cap unchanged.");
  console.log("Recorded in deployments/usage.json.");
}

/** (c) STALE / NONEXISTENT batchId — withdraw against a batch that does not exist. */
async function staleBatch(args: string[]): Promise<void> {
  const f = flags(args);
  const batchIdRaw = f["batch"];
  const fakeRaw = f["fake"];
  if (!batchIdRaw || !/^\d+$/.test(batchIdRaw) || !fakeRaw || !/^\d+$/.test(fakeRaw)) {
    throw new Error("Usage: revert-demos stale-batch --batch <N> --fake <M>");
  }
  const batchId = Number(batchIdRaw);
  const fakeBatchId = Number(fakeRaw);
  const batch = loadBatch(batchId);
  const { client, contract, abi, chainId, account, wallet, unified } = await connect();
  const batchCount = Number(
    (await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: "batchCount",
    })) as bigint,
  );
  if (fakeBatchId < batchCount) {
    throw new Error(`Batch #${fakeBatchId} EXISTS (batchCount ${batchCount}) — pick a --fake id >= ${batchCount}.`);
  }
  const leaf = batch.leaves?.find(
    (l) => l.account.toLowerCase() === account.address.toLowerCase(),
  );
  if (!leaf) {
    throw new Error(`Account ${account.address} has no leaf in batch ${batchId} — nothing to withdraw with.`);
  }
  const proof = batch.proofs?.[account.address.toLowerCase()];
  if (!Array.isArray(proof)) {
    throw new Error(`No Merkle proof stored for ${account.address} in batch ${batchId}.`);
  }
  const balance = BigInt(leaf.balance);
  const nonce = leaf.nonce;
  const withdrawnBefore = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "withdrawnAmount",
    args: [account.address],
  })) as bigint;

  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  console.log(`caller:   ${account.address} (own valid leaf from batch #${batchId}: balance ${balance} uqor, nonce ${nonce}, ${proof.length}-element proof)`);
  console.log(`fake batchId: ${fakeBatchId} (batchCount ${batchCount} — no such batch)`);
  console.log(`already withdrawn (cumulative cap): ${withdrawnBefore} uqor`);

  await requireLiveWindow(unified.cosmos);

  const callArgs = [BigInt(fakeBatchId), account.address, balance, BigInt(nonce), proof] as unknown[];
  const reason = await simulateRevert(client, contract, abi, {
    functionName: "withdraw",
    args: callArgs,
    account: account.address,
  });
  console.log(`simulation: the call would REVERT (${reason})`);

  console.log("\nSending the stale-batch withdrawal with explicit gas (expecting an on-chain revert)…");
  const hash = await writeContract(wallet, {
    address: contract,
    abi,
    functionName: "withdraw",
    args: callArgs,
    value: 0n,
    account: wallet.account ?? null,
    chain: wallet.chain,
    gas: REVERT_GAS_WITHDRAW,
  } as never);
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, hash);
  console.log(`  tx: ${hash}`);
  console.log(`  cosmos: ${cosmos.cosmosHash} (block ${cosmos.block})`);
  console.log(`  EVM receipt status: ${receipt.status}`);
  const withdrawnAfter = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "withdrawnAmount",
    args: [account.address],
  })) as bigint;
  console.log(`withdrawnAmount after: ${withdrawnAfter} uqor`);

  appendUsageStep(contract, {
    command: "revert-demo",
    demo: "stale-batch",
    expected: "revert",
    expectedReason: "BatchNotFound",
    simulatedReason: reason,
    note: "A withdrawal against a batchId that does not exist, with the caller's own valid leaf data from a real batch: the batch-existence check fails before the proof is even examined.",
    batchId,
    fakeBatchId,
    batchCount,
    account: account.address,
    balanceUqor: balance.toString(),
    nonce,
    leaf: leaf.leaf,
    tx: hash,
    cosmosTx: cosmos.cosmosHash,
    block: cosmos.block,
    receiptStatus: receipt.status,
    withdrawnAmountBefore: withdrawnBefore.toString(),
    withdrawnAmountAfter: withdrawnAfter.toString(),
  });

  if (receipt.status !== "reverted") {
    console.error("\n*** STALE-BATCH WITHDRAWAL DID NOT REVERT — investigate! ***");
    process.exitCode = 1;
    return;
  }
  if (withdrawnAfter !== withdrawnBefore) {
    console.error("\n*** withdrawnAmount MOVED despite the revert — inconsistent state! ***");
    process.exitCode = 1;
    return;
  }
  console.log("\nStale-batch withdrawal REVERTED on-chain as expected. Cumulative cap unchanged.");
  console.log("Recorded in deployments/usage.json.");
}

const USAGE =
  "Usage: revert-demos <replay --batch <N> | wrong-account --batch <N> --victim <0x> | stale-batch --batch <N> --fake <M>>";

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "replay":
      await replay(args);
      break;
    case "wrong-account":
      await wrongAccount(args);
      break;
    case "stale-batch":
      await staleBatch(args);
      break;
    default:
      console.error(cmd ? `Unknown command "${cmd}".` : "No command given.");
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\nRevert demo failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
