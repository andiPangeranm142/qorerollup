/**
 * merkle-withdraw.ts - withdraw rollup funds with a Merkle proof, with NO
 * sequencer help (v2 headline proof).
 *
 * Usage (see README):
 *   npm run merkle-withdraw -- --batch <id> [--dry-run]
 *   npm run merkle-withdraw -- --batch <id> --expect-revert
 *   npm run merkle-withdraw -- --batch <id> --tamper-proof --expect-revert
 *
 * The caller is the account in the loaded env file (QORE_MNEMONIC +
 * QORE_EVM_PRIVATE_KEY) — normally ../.env.user, an INDEPENDENT user
 * wallet, not the sequencer (npm run merkle-withdraw loads that file).
 * The script loads deployments/batches/batch-<id>.json, finds the
 * caller's leaf, builds the Merkle proof from the batch file, and calls
 * QoreRollup.withdraw(batchId, account, balance, nonce, proof) directly
 * on the contract. No sequencer call exists anywhere in this path: the
 * caller needs only the published batch file and a live EVM window of
 * their own (register the key + open the window with
 * `npx tsx --env-file=../.env.user scripts/window.ts register|open`,
 * or ../.env for the deployer account). The deployer withdrawal
 * against batch #3 ran with ../.env; the user withdrawal against
 * batch #2 ran with ../.env.user.
 *
 * --dry-run verifies the proof locally (against the batch file's root
 * and the on-chain root) and simulates the call, then stops.
 * --expect-revert sends with EXPLICIT gas (viem estimation would fail
 * before broadcast for a reverting call) and requires the EVM receipt to
 * be reverted — used for the double-withdraw demo (same call twice) and,
 * with --tamper-proof, for a proof with one flipped byte. The reverting
 * tx is recorded in deployments/usage.json as evidence.
 *
 * A successful withdrawal is recorded in deployments/usage.json
 * (command "merkle-withdraw") and in deployments/merkle-withdraw.json
 * (the demo evidence file read by scripts/gen-evidence.mjs), with the
 * EVM hash, the Cosmos hash and the block number.
 *
 * Safety: testnet ONLY (EVM chain id 9800). Secrets come from
 * ../.env.user and are never printed. Note the explorer shows reverted
 * EVM txs as Cosmos-level "success" — the revert is in the EVM receipt
 * (status 0), which this script checks explicitly.
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  evmWindowStatus,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { cosmosHashForEvmTx } from "./cosmos-hash";
import { verifyProof } from "../src/lib/merkle";
import type { BatchFile } from "../src/lib/rollup";

const TESTNET_CHAIN_ID = 9800;
const TESTNET_REST = "https://api-testnet.qore.host";
/** Explicit gas for reverting demo txs (estimation would fail pre-broadcast). */
const REVERT_GAS = 500_000n;

const ROOT = process.cwd();
const DEPLOYMENTS = path.resolve(ROOT, "deployments");
const BATCHES_DIR = path.resolve(DEPLOYMENTS, "batches");
const USAGE_PATH = path.resolve(DEPLOYMENTS, "usage.json");
const MERKLE_WITHDRAW_PATH = path.resolve(DEPLOYMENTS, "merkle-withdraw.json");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (set it in ../.env.user)`);
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

async function main(): Promise<void> {
  const f = flags(process.argv.slice(2));
  const batchIdRaw = f["batch"];
  if (!batchIdRaw || !/^\d+$/.test(batchIdRaw)) {
    throw new Error(
      "Usage: npm run merkle-withdraw -- --batch <id> [--dry-run] [--expect-revert] [--tamper-proof]",
    );
  }
  const batchId = Number(batchIdRaw);
  const dryRun = f["dry-run"] === "true";
  const expectRevert = f["expect-revert"] === "true";
  const tamperProof = f["tamper-proof"] === "true";
  if (tamperProof && !expectRevert) {
    throw new Error("--tamper-proof only makes sense with --expect-revert (the call must revert).");
  }

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

  const batchPath = path.resolve(BATCHES_DIR, `batch-${batchId}.json`);
  if (!fs.existsSync(batchPath)) {
    throw new Error(`No batch file for batch ${batchId} (${batchPath}).`);
  }
  const batch = readJson<BatchFile>(batchPath);

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
      `Refusing: QORE_MNEMONIC derives EVM address ${unified.evm}, not the private-key account ${account.address}. Check ../.env.user.`,
    );
  }

  // The caller's leaf in this batch — from the published batch file, no
  // sequencer involved.
  const leaf = batch.leaves?.find(
    (l) => l.account.toLowerCase() === account.address.toLowerCase(),
  );
  if (!leaf) {
    throw new Error(
      `Account ${account.address} has no leaf in batch ${batchId} (zero balance in that batch) — nothing to withdraw.`,
    );
  }
  const proof = batch.proofs?.[account.address.toLowerCase()];
  if (!Array.isArray(proof)) {
    throw new Error(`No Merkle proof stored for ${account.address} in batch ${batchId}.`);
  }
  const balance = BigInt(leaf.balance);
  const nonce = leaf.nonce;

  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  console.log(`account:  ${account.address} (${unified.cosmos})`);
  console.log(`batch:    #${batchId} (stateRoot ${batch.stateRoot})`);
  console.log(`leaf:     ${leaf.leaf} (balance ${balance} uqor, nonce ${nonce})`);
  console.log(`proof:    ${proof.length} element(s)`);

  // Local verification first: the proof against the batch file's root.
  if (!verifyProof(leaf.leaf, proof, batch.stateRoot)) {
    throw new Error("Local proof verification FAILED against the batch file's stateRoot — refusing to send.");
  }
  console.log("local proof check: OK");

  // On-chain root check: the batch file's root must equal the settled root.
  const onChainBatch = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "getBatch",
    args: [BigInt(batchId)],
  })) as { stateRoot: Hex };
  if (onChainBatch.stateRoot.toLowerCase() !== batch.stateRoot.toLowerCase()) {
    throw new Error(
      `Batch file stateRoot ${batch.stateRoot} does not match the on-chain root ${onChainBatch.stateRoot} — refusing to send.`,
    );
  }
  console.log("on-chain root check: OK");

  // The cumulative cap: what this account already withdrew.
  const withdrawnBefore = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "withdrawnAmount",
    args: [account.address],
  })) as bigint;
  console.log(`already withdrawn (cumulative cap): ${withdrawnBefore} uqor`);
  const amountUqor = balance - withdrawnBefore;
  if (!expectRevert && amountUqor <= 0n) {
    throw new Error(
      `Nothing to withdraw: leaf balance ${balance} uqor is not above the already-withdrawn ${withdrawnBefore} uqor. ` +
        "Re-run with --expect-revert to demonstrate the double-withdraw revert on-chain.",
    );
  }
  console.log(`withdrawable now: ${amountUqor} uqor (${(Number(amountUqor) / 1_000_000).toFixed(6)} QOR)`);

  // The proof to send — tampered for the tampered-proof demo.
  let sendProof: Hex[] = proof;
  if (tamperProof) {
    if (proof.length === 0) {
      throw new Error("Cannot tamper an empty proof (single-leaf tree) — pick a batch with 2+ leaves.");
    }
    sendProof = [...proof];
    const first = sendProof[0] as string;
    // Flip the last hex char of the first proof element.
    sendProof[0] = (first.slice(0, -1) + (first.endsWith("0") ? "1" : "0")) as Hex;
    console.log(`tampered proof: first element ${proof[0]} -> ${sendProof[0]}`);
  }

  if (dryRun) {
    console.log("\nDRY RUN — simulating the call, sending nothing.");
    try {
      // Simulate AS the user: eth_call defaults `from` to the zero
      // address, which would (correctly) trip NotAccountOwner.
      await readContract(client.publicClient, {
        address: contract,
        abi,
        functionName: "withdraw",
        args: [BigInt(batchId), account.address, balance, BigInt(nonce), sendProof],
        account: account.address,
      });
      console.log("simulation: the call would SUCCEED.");
      if (expectRevert) {
        console.error("UNEXPECTED: --expect-revert was given but the simulation succeeded.");
        process.exitCode = 1;
      }
    } catch (err) {
      console.log(`simulation: the call would REVERT (${err instanceof Error ? err.message : err}).`);
      if (!expectRevert) process.exitCode = 1;
    }
    return;
  }

  // A live EVM authorisation window is required for the USER's own
  // account — the user opens it themselves; the sequencer is not involved.
  const window = await evmWindowStatus({ rest: TESTNET_REST, address: unified.cosmos });
  if (!window.found || !window.live || window.remainingTxs < 1n) {
    throw new Error(
      `No live EVM authorisation window for the user (${unified.cosmos}). ` +
        "Run `npx tsx --env-file=../.env.user scripts/window.ts open` first, then retry.",
    );
  }
  console.log(
    `window: live (${window.remainingBlocks} blocks, ${window.remainingTxs} txs, ${window.remainingValue} uqor left)`,
  );

  console.log(
    expectRevert
      ? `\nSending the ${tamperProof ? "TAMPERED-PROOF" : "DOUBLE"} withdrawal with explicit gas (expecting an on-chain revert)…`
      : "\nSending the Merkle-proof withdrawal (no sequencer involved)…",
  );
  const hash = await writeContract(wallet, {
    address: contract,
    abi,
    functionName: "withdraw",
    args: [BigInt(batchId), account.address, balance, BigInt(nonce), sendProof],
    value: 0n,
    account: wallet.account ?? null,
    chain: wallet.chain,
    ...(expectRevert ? { gas: REVERT_GAS } : {}),
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

  if (expectRevert) {
    const reason = tamperProof ? "tampered-proof" : "double-withdraw";
    appendUsageStep(contract, {
      command: "merkle-withdraw-revert",
      expected: "revert",
      reason,
      note:
        reason === "double-withdraw"
          ? "Same Merkle-proof withdrawal sent twice: the second call must revert (ZeroWithdraw) — the cumulative cap already covers the leaf balance."
          : "Merkle-proof withdrawal with one flipped hex char in the proof: must revert (InvalidMerkleProof).",
      batchId,
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
      console.error(`\n*** ${reason.toUpperCase()} CALL DID NOT REVERT — investigate! ***`);
      process.exitCode = 1;
      return;
    }
    if (withdrawnAfter !== withdrawnBefore) {
      console.error("\n*** withdrawnAmount MOVED despite the revert — inconsistent state! ***");
      process.exitCode = 1;
      return;
    }
    console.log(`\n${reason} withdrawal REVERTED on-chain as expected. Cumulative cap unchanged.`);
    console.log("Recorded in deployments/usage.json.");
    return;
  }

  if (receipt.status !== "success") {
    console.error("\n*** WITHDRAWAL REVERTED — expected success! ***");
    process.exitCode = 1;
    return;
  }
  if (withdrawnAfter !== balance) {
    console.error(
      `\n*** withdrawnAmount after (${withdrawnAfter}) does not equal the leaf balance (${balance}) — inconsistent state! ***`,
    );
    process.exitCode = 1;
    return;
  }
  const step = {
    command: "merkle-withdraw",
    note: "Merkle-proof withdrawal against a settled batch state root — no sequencer involvement.",
    batchId,
    account: account.address,
    balanceUqor: balance.toString(),
    amountUqor: amountUqor.toString(),
    nonce,
    leaf: leaf.leaf,
    proof: sendProof,
    proofSteps: sendProof.length,
    stateRoot: batch.stateRoot,
    withdrawnBefore: withdrawnBefore.toString(),
    withdrawnAfter: withdrawnAfter.toString(),
    tx: hash,
    cosmosTx: cosmos.cosmosHash,
    block: cosmos.block,
    receiptStatus: receipt.status,
  };
  appendUsageStep(contract, step);
  writeJson(MERKLE_WITHDRAW_PATH, {
    at: new Date().toISOString(),
    network: "qorechain-diana",
    chainId: TESTNET_CHAIN_ID,
    contract,
    ...step,
  });
  console.log(`\nWithdrawal succeeded: ${amountUqor} uqor paid to ${account.address}.`);
  console.log("Recorded in deployments/usage.json and deployments/merkle-withdraw.json.");
}

main().catch((err: unknown) => {
  console.error(`\nMerkle withdraw failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
