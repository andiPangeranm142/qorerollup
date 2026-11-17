/**
 * forged-batch.ts - prove the settlement contract rejects a forged batch,
 * ON-CHAIN (not just in tests).
 *
 * Usage: npm run forged-batch
 *   (needs a live EVM authorisation window: `npm run window open` first)
 *
 * What it does: builds a fake batch for the NEXT batch id (whatever the
 * contract's batchCount currently is) and submits it with a FORGED
 * ML-DSA-87 signature — a real signature produced by the sequencer's own
 * ML-DSA key, but over a DIFFERENT digest (a nonexistent batch id), so the
 * signature is cryptographically genuine yet does not match this batch.
 * The sender is the sequencer itself, so the only-sequencer check passes
 * and the ONLY thing standing between the forgery and settlement is the
 * on-chain pqcVerify check. Expected outcome: the transaction is included
 * on Diana and REVERTS (InvalidBatchSignature), batchCount does not move,
 * and no batch is recorded.
 *
 * The script sends with an EXPLICIT gas limit: viem's gas estimation would
 * fail before broadcast (the call reverts), leaving no transaction at all.
 * With explicit gas the tx is broadcast, included, and reverts on-chain —
 * which is the whole point: the revert itself is the recorded evidence.
 *
 * The reverting tx is recorded in deployments/usage.json
 * ({ command: "forged-batch", expected: "revert", ... }) with the EVM hash,
 * the Cosmos hash, the block, and the receipt status. Note: the explorer
 * shows reverted EVM txs as Cosmos-level "success" — the revert is in the
 * EVM receipt (status 0), which this script checks explicitly.
 *
 * Safety: testnet ONLY (EVM chain id 9800). Secrets come from ../.env and
 * are never printed. If the transaction does NOT revert, this script exits
 * non-zero and shouts: that would mean the forgery was ACCEPTED.
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { deriveUnifiedAccount, pqcSign } from "@qorechain/sdk";
import { hexToBytes, keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { cosmosHashForEvmTx } from "./cosmos-hash";
import { batchDigest } from "../src/lib/rollup";

const TESTNET_CHAIN_ID = 9800;

const ROOT = process.cwd();
const DEPLOYMENTS = path.resolve(ROOT, "deployments");
const USAGE_PATH = path.resolve(DEPLOYMENTS, "usage.json");

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
    network: "qorechain-diana",
    chainId: TESTNET_CHAIN_ID,
    contract,
    ...(existing ?? {}),
    steps,
  });
}

async function main(): Promise<void> {
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

  const batchCountBefore = Number(
    (await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: "batchCount",
    })) as bigint,
  );
  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  console.log(`sender:   ${account.address} (the sequencer itself)`);
  console.log(`batchCount before: ${batchCountBefore}`);

  // The forged batch: deterministic fake contents for the next batch id.
  const batchId = batchCountBefore;
  const stateRoot = keccak256(stringToHex("QoreRollup.forged-state-root"));
  const txDataCommitment = keccak256(stringToHex("QoreRollup.forged-tx-data"));
  const encryptedDataHash = keccak256(stringToHex("QoreRollup.forged-encrypted-data"));
  const realDigest = batchDigest(chainId, contract, batchId, stateRoot, txDataCommitment, encryptedDataHash);

  // The forgery: a GENUINE ML-DSA-87 signature by the sequencer's key — but
  // over the digest of a nonexistent batch (id 999, zero hashes), NOT over
  // this batch's digest. If the contract verified "any valid signature by
  // the sequencer" instead of "the signature over THIS batch", this would
  // pass. It must not.
  const otherDigest = batchDigest(
    chainId,
    contract,
    999,
    keccak256(stringToHex("QoreRollup.other")),
    keccak256(stringToHex("QoreRollup.other")),
    keccak256(stringToHex("QoreRollup.other")),
  );
  const forgedSignature = toHex(pqcSign(unified.pqc.secretKey, hexToBytes(otherDigest)));
  console.log(`\nForged batch #${batchId}:`);
  console.log(`  stateRoot:   ${stateRoot}`);
  console.log(`  real digest: ${realDigest}`);
  console.log(`  forged signature is over a DIFFERENT digest: ${otherDigest}`);
  console.log(`  signature:   ${forgedSignature.length / 2 - 1} bytes (genuine ML-DSA-87, wrong message)`);

  console.log("\nSubmitting the forged batch with explicit gas (bypassing estimation)…");
  const hash = await writeContract(wallet, {
    address: contract,
    abi,
    functionName: "submitBatch",
    args: [stateRoot, txDataCommitment, encryptedDataHash, forgedSignature],
    value: 0n,
    account: wallet.account ?? null,
    chain: wallet.chain,
    gas: 2_000_000n,
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
    command: "forged-batch",
    expected: "revert",
    note: "Forged ML-DSA-87 signature (genuine signature over a different digest) submitted by the sequencer itself. The contract must reject it: InvalidBatchSignature.",
    batchId,
    stateRoot,
    txDataCommitment,
    encryptedDataHash,
    forgedDigest: otherDigest,
    tx: hash,
    cosmosTx: cosmos.cosmosHash,
    block: cosmos.block,
    receiptStatus: receipt.status,
    batchCountBefore,
    batchCountAfter,
  });

  if (receipt.status !== "reverted") {
    console.error("\n*** FORGERY ACCEPTED — THE CONTRACT DID NOT REVERT! ***");
    console.error("This is a security failure: investigate before any further use.");
    process.exitCode = 1;
    return;
  }
  if (batchCountAfter !== batchCountBefore) {
    console.error("\n*** batchCount MOVED despite the revert — inconsistent state! ***");
    process.exitCode = 1;
    return;
  }
  console.log("\nForged batch REVERTED on-chain as expected. No batch recorded, batchCount unchanged.");
  console.log("Recorded in deployments/usage.json.");
}

main().catch((err: unknown) => {
  console.error(`\nForged-batch demo failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
