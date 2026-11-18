/**
 * verify-merkle-proof.ts - verify the Merkle proofs in a PUBLISHED batch
 * file, with no secrets and no sequencer involvement.
 *
 * Usage: npm run verify-merkle-proof -- --batch <id>
 *
 * For batch <id> it:
 *  (1) recomputes every leaf hash from (account, balance, nonce) in
 *      deployments/batches/batch-<id>.json and checks it against the
 *      stored leaf;
 *  (2) verifies every stored proof against the batch file's stateRoot
 *      with the repo's own verifyProof (src/lib/merkle.ts — the same
 *      fold the contract performs in withdraw());
 *  (3) reads the settled state root for the batch from the contract
 *      (read-only getBatch) and checks it equals the file's root — so
 *      the published proofs are proven against the ON-CHAIN root, not
 *      just against a root the file claims.
 *
 * Read-only: it never sends a transaction and needs no keys. This is the
 * same verification the watchtower runs as check (b4) for every batch,
 * and the same local + on-chain root check merkle-withdraw.ts runs
 * before sending — packaged as a standalone, single-batch check anyone
 * can run from a fresh clone. See REPRODUCIBILITY.md.
 */
import { createPublicClient, http, defineChain, parseAbi, type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { leafHash, verifyProof } from "../src/lib/merkle";

const TESTNET_CHAIN_ID = 9800;

// npm scripts run with the working directory at the package root.
const ROOT = process.cwd();
const DEPLOYMENTS = path.resolve(ROOT, "deployments");
const BATCHES_DIR = path.resolve(DEPLOYMENTS, "batches");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
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
    throw new Error("Usage: npm run verify-merkle-proof -- --batch <id>");
  }
  const batchId = Number(batchIdRaw);

  const deploymentPath = path.resolve(DEPLOYMENTS, "testnet.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("No deployments/testnet.json yet — the settlement contract has not been deployed.");
  }
  const { contract } = readJson<{ contract: Address }>(deploymentPath);
  const batchPath = path.resolve(BATCHES_DIR, `batch-${batchId}.json`);
  if (!fs.existsSync(batchPath)) {
    throw new Error(`No batch file for batch ${batchId} (${batchPath}).`);
  }
  const batch = readJson<{
    batchId: number;
    stateRoot: Hex;
    leaves: Array<{ account: Address; balance: string; nonce: number; leaf: Hex }>;
    proofs: Record<string, Hex[]>;
  }>(batchPath);

  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
  const diana = defineChain({
    id: TESTNET_CHAIN_ID,
    name: "QoreChain Diana",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [evmRpc] } },
  });
  const client = createPublicClient({ chain: diana, transport: http() });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Refusing: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`);
  }

  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  console.log(`batch #${batch.batchId}: ${batch.leaves.length} leaves, file stateRoot ${batch.stateRoot}`);

  // (1)+(2) leaf hashes recomputed, stored proofs verified against the file root.
  let ok = 0;
  for (const leaf of batch.leaves) {
    const recomputed = leafHash(leaf.account, BigInt(leaf.balance), leaf.nonce);
    if (recomputed.toLowerCase() !== leaf.leaf.toLowerCase()) {
      throw new Error(`Leaf hash mismatch for ${leaf.account} — refusing to continue.`);
    }
    const proof = batch.proofs[leaf.account.toLowerCase()];
    if (!Array.isArray(proof)) {
      throw new Error(`No stored proof for ${leaf.account} in batch ${batchId}.`);
    }
    if (!verifyProof(leaf.leaf, proof, batch.stateRoot)) {
      throw new Error(`Proof FAILED for ${leaf.account} against the file stateRoot.`);
    }
    ok++;
  }
  console.log(
    `proof check: ${ok}/${batch.leaves.length} stored proofs verify against the file stateRoot ` +
      "(leaf hashes recomputed from account/balance/nonce)",
  );

  // (3) the file's stateRoot equals the settled on-chain root.
  const onChain = (await client.readContract({
    address: contract,
    abi: parseAbi([
      "function getBatch(uint256) view returns (bytes32 stateRoot, bytes32 txDataCommitment, bytes32 encryptedDataHash, uint256 timestamp, bytes32 receiptHash)",
    ]),
    functionName: "getBatch",
    args: [BigInt(batchId)],
  })) as unknown;
  const onChainRoot = (
    Array.isArray(onChain) ? onChain[0] : (onChain as { stateRoot: string }).stateRoot
  ) as string;
  console.log(`on-chain root: ${onChainRoot}`);
  if (onChainRoot.toLowerCase() !== batch.stateRoot.toLowerCase()) {
    throw new Error(
      `Batch file stateRoot ${batch.stateRoot} does not match the on-chain root ${onChainRoot}.`,
    );
  }
  console.log("on-chain root check: OK — the published proofs verify against the settled root");
}

main().catch((err: unknown) => {
  console.error(`\nMerkle proof verification failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
