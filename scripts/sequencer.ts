/**
 * sequencer.ts - the QoreRollup off-chain sequencer CLI.
 *
 * Usage (see README):
 *   npm run sequencer keygen                                  generate the rollup data-availability ML-KEM-1024 keypair
 *   npm run sequencer enqueue --from <0x> --to <0x> --amount <uqor>
 *                                                             append a tx to the mempool
 *   npm run sequencer settle [--dry-run]                      settle the whole mempool as one ML-DSA-87-signed batch
 *   npm run sequencer status                                  contract + local state, read-only
 *
 * Safety:
 * - Testnet ONLY (EVM chain id 9800). Every command that touches the chain
 *   checks the chain id first and refuses any other network.
 * - `settle` checks for a live EVM authorisation window and FAILS with a
 *   clear message telling the operator to run `npm run window open` first.
 *   It never opens a window itself: spending must be authorised on purpose.
 * - Secrets (QORE_MNEMONIC, QORE_EVM_PRIVATE_KEY) come from ../.env and are
 *   never printed. The KEM secret key lives OUTSIDE the repo in
 *   ../kem-key.json (mode 600); only the public key is committed.
 * - The mempool is cleared ONLY after the settlement receipt confirms.
 *
 * Balances: rollup balances live in deployments/state.json, seeded by the
 * operator (genesis state is empty). L1 deposits are recorded by the
 * contract but this demo does NOT auto-credit them into rollup balances —
 * see THREAT_MODEL.md. A settle with unfunded senders fails with an
 * "insufficient balance" error naming the account.
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  evmWindowStatus,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { deriveUnifiedAccount, pqcSign } from "@qorechain/sdk";
import {
  concat,
  formatEther,
  getAddress,
  hexToBytes,
  isAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import fs from "node:fs";
import path from "node:path";
import { cosmosHashForEvmTx } from "./cosmos-hash";
import {
  GENESIS_STATE_ROOT,
  applyTxs,
  batchDigest,
  receiptHash,
  rollupTxFromJson,
  rollupTxToJson,
  txDataCommitment,
  type BatchFile,
  type BatchPayload,
  type RollupTx,
  type RollupTxJson,
} from "../src/lib/rollup";
import {
  generateKemKeypair,
  kemPublicKeyHash,
  sealBatchPayload,
  type KemKeypair,
} from "../src/lib/kem";

const TESTNET_CHAIN_ID = 9800;
const TESTNET_REST = "https://api-testnet.qore.host";
const SEQUENCER_EVM = "0x0140a056ee37D5240b0397eCdF1347Da80E33b9f" as Address;
const SEQUENCER_COSMOS = "qor1q9q2q4hwxl2jgzcrjlkd7y68m2qwxwul0nheda";

// npm scripts run with the working directory at the package root.
const ROOT = process.cwd();
const DEPLOYMENTS = path.resolve(ROOT, "deployments");
const BATCHES_DIR = path.resolve(DEPLOYMENTS, "batches");
const STATE_PATH = path.resolve(DEPLOYMENTS, "state.json");
const MEMPOOL_PATH = path.resolve(DEPLOYMENTS, "mempool.json");
const USAGE_PATH = path.resolve(DEPLOYMENTS, "usage.json");
const KEM_PUBLIC_PATH = path.resolve(DEPLOYMENTS, "kem-public-key.json");
/** OUTSIDE the repo, mode 600 — never committed, never printed. */
const KEM_SECRET_PATH = path.resolve(ROOT, "..", "kem-key.json");

interface RollupState {
  batchCount: number;
  stateRoot: Hex;
  /** address (lowercase) -> decimal uqor string. */
  balances: Record<string, string>;
  /** address (lowercase) -> nonce. */
  nonces: Record<string, number>;
}

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
    throw new Error(
      "No deployments/testnet.json yet — the settlement contract has not been deployed. Run `npm run deploy` first.",
    );
  }
  return readJson<{ contract: Address }>(deploymentPath);
}

function loadAbi(): never {
  const artifactPath = path.resolve(
    ROOT,
    "artifacts",
    "contracts",
    "QoreRollup.sol",
    "QoreRollup.json",
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      "No compiled QoreRollup artifact yet — run `npm run compile` first.",
    );
  }
  const artifact = readJson<{ abi: unknown }>(artifactPath);
  return artifact.abi as never;
}

async function connect() {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
  const { contract } = loadDeployment();
  const abi = loadAbi();
  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`,
    );
  }
  return { client, contract, abi, chainId };
}

function genesisState(): RollupState {
  return { batchCount: 0, stateRoot: GENESIS_STATE_ROOT, balances: {}, nonces: {} };
}

function loadState(): RollupState {
  if (!fs.existsSync(STATE_PATH)) return genesisState();
  return readJson<RollupState>(STATE_PATH);
}

function loadMempool(): RollupTxJson[] {
  if (!fs.existsSync(MEMPOOL_PATH)) return [];
  return readJson<RollupTxJson[]>(MEMPOOL_PATH);
}

function loadKemPublicKey(): Uint8Array {
  if (!fs.existsSync(KEM_PUBLIC_PATH)) {
    throw new Error(
      "No deployments/kem-public-key.json yet — run `npm run sequencer keygen` first.",
    );
  }
  const { publicKeyHex } = readJson<{ publicKeyHex: Hex }>(KEM_PUBLIC_PATH);
  return hexToBytes(publicKeyHex);
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

function stateMaps(state: RollupState): {
  balances: Map<Address, bigint>;
  nonces: Map<Address, number>;
} {
  return {
    balances: new Map(
      Object.entries(state.balances).map(
        ([addr, bal]) => [addr.toLowerCase() as Address, BigInt(bal)] as const,
      ),
    ),
    nonces: new Map(
      Object.entries(state.nonces).map(
        ([addr, n]) => [addr.toLowerCase() as Address, n] as const,
      ),
    ),
  };
}

/** keygen: create the rollup data-availability ML-KEM-1024 keypair. */
async function keygen(): Promise<void> {
  if (fs.existsSync(KEM_PUBLIC_PATH) || fs.existsSync(KEM_SECRET_PATH)) {
    throw new Error(
      "KEM keys already exist (deployments/kem-public-key.json and/or ../kem-key.json). " +
        "Refusing to overwrite: delete both files deliberately if you really mean to rotate the key.",
    );
  }
  const kp: KemKeypair = generateKemKeypair();
  const publicKeyHex = toHex(kp.publicKey);
  const createdAt = new Date().toISOString();
  writeJson(KEM_PUBLIC_PATH, {
    publicKeyHex,
    publicKeyHash: kemPublicKeyHash(kp.publicKey),
    createdAt,
  });
  // Secret key: OUTSIDE the repo, mode 600, written atomically-ish (write
  // then chmod, so a umask can never leave it world-readable).
  fs.writeFileSync(
    KEM_SECRET_PATH,
    JSON.stringify(
      { secretKeyHex: toHex(kp.secretKey), publicKeyHex, createdAt },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  fs.chmodSync(KEM_SECRET_PATH, 0o600);
  console.log("ML-KEM-1024 keypair generated.");
  console.log(`  public key: ${KEM_PUBLIC_PATH} (committed, public)`);
  console.log(`  secret key: ${KEM_SECRET_PATH} (mode 600, OUTSIDE the repo)`);
  console.log(`  public key hash: ${kemPublicKeyHash(kp.publicKey)}`);
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

/** enqueue: append one tx to the mempool, assigning its nonce. */
async function enqueue(args: string[]): Promise<void> {
  const f = flags(args);
  const fromRaw = f["from"];
  const toRaw = f["to"];
  const amountRaw = f["amount"];
  if (!fromRaw || !toRaw || !amountRaw) {
    throw new Error(
      "Usage: npm run sequencer enqueue --from <0x address> --to <0x address> --amount <uqor>",
    );
  }
  if (!isAddress(fromRaw)) throw new Error(`--from is not a valid address: ${fromRaw}`);
  if (!isAddress(toRaw)) throw new Error(`--to is not a valid address: ${toRaw}`);
  if (!/^\d+$/.test(amountRaw)) {
    throw new Error(`--amount must be a non-negative integer number of uqor, got: ${amountRaw}`);
  }
  const amount = BigInt(amountRaw);
  if (amount <= 0n) throw new Error("--amount must be positive");
  const from = getAddress(fromRaw);
  const to = getAddress(toRaw);

  const state = loadState();
  const mempool = loadMempool();
  const pendingFromSender = mempool.filter(
    (t) => t.from.toLowerCase() === from.toLowerCase(),
  ).length;
  const nonce = (state.nonces[from.toLowerCase()] ?? 0) + pendingFromSender;
  const tx: RollupTxJson = { from, to, amount: amount.toString(), nonce };
  mempool.push(tx);
  writeJson(MEMPOOL_PATH, mempool);
  console.log(`Enqueued tx #${mempool.length - 1} (nonce ${nonce}):`);
  console.log(`  from:   ${from}`);
  console.log(`  to:     ${to}`);
  console.log(`  amount: ${amount.toString()} uqor`);
}

/** settle: build one batch from the whole mempool and settle it on-chain. */
async function settle(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const { client, contract, abi, chainId } = await connect();
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;
  const mnemonic = requireEnv("QORE_MNEMONIC");
  const account = evmAccountFromPrivateKey(privateKey);
  if (account.address.toLowerCase() !== SEQUENCER_EVM.toLowerCase()) {
    throw new Error(
      `Refusing: QORE_EVM_PRIVATE_KEY belongs to ${account.address}, not the sequencer ${SEQUENCER_EVM}. Check ../.env.`,
    );
  }
  const unified = await deriveUnifiedAccount(mnemonic, 0);
  if (unified.evm.toLowerCase() !== SEQUENCER_EVM.toLowerCase()) {
    throw new Error(
      `Refusing: QORE_MNEMONIC derives EVM address ${unified.evm}, not the sequencer ${SEQUENCER_EVM}. Check ../.env.`,
    );
  }
  const wallet = client.getWalletClient(account);

  const mempool = loadMempool();
  if (mempool.length === 0) {
    throw new Error("Mempool is empty — nothing to settle. Enqueue a tx first.");
  }
  const state = loadState();
  const batchId = state.batchCount;
  const kemPublicKey = loadKemPublicKey();

  // The local batch id and the on-chain batch count must agree, or the
  // sequencer has drifted from the chain (e.g. state.json was reset).
  const onChainBatchCount = Number(
    (await readContract(client.publicClient, {
      address: contract,
      abi,
      functionName: "batchCount",
    })) as bigint,
  );
  if (onChainBatchCount !== batchId) {
    throw new Error(
      `Refusing: local batch id is ${batchId} but the contract's batchCount is ${onChainBatchCount}. ` +
        "The local state has drifted from the chain — reconcile deployments/state.json before settling.",
    );
  }

  const txs: RollupTx[] = mempool.map(rollupTxFromJson);
  const { balances, nonces } = stateMaps(state);
  let newStateRoot: Hex;
  let newBalances: Map<Address, bigint>;
  let newNonces: Map<Address, number>;
  try {
    ({ newStateRoot, newBalances, newNonces } = applyTxs(
      state.stateRoot,
      balances,
      txs,
      nonces,
    ));
  } catch (err) {
    throw new Error(
      `Batch build failed: ${err instanceof Error ? err.message : err}\n` +
        "Rollup balances live in deployments/state.json (seeded by the operator); " +
        "an 'insufficient balance' here means the sender was never funded in the rollup state.",
    );
  }

  const commitment = txDataCommitment(txs);
  const payload: BatchPayload = {
    batchId,
    prevStateRoot: state.stateRoot,
    txs: txs.map(rollupTxToJson),
    newStateRoot,
  };
  const payloadJson = JSON.stringify(payload);
  const { kemCiphertext, sealedBlob } = sealBatchPayload(kemPublicKey, payloadJson);
  const encryptedDataHash = keccak256(
    concat([toHex(kemCiphertext), toHex(sealedBlob)]),
  );
  const digest = batchDigest(
    chainId,
    contract,
    batchId,
    newStateRoot,
    commitment,
    encryptedDataHash,
  );
  const signatureBytes = pqcSign(unified.pqc.secretKey, hexToBytes(digest));
  const signature = toHex(signatureBytes);
  const receipt = receiptHash(chainId, contract, batchId, newStateRoot, commitment);

  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  console.log(`batch:    #${batchId} (${txs.length} txs)`);
  console.log(`prevRoot: ${state.stateRoot}`);
  console.log(`newRoot:  ${newStateRoot}`);
  console.log(`commit:   ${commitment}`);
  console.log(`encHash:  ${encryptedDataHash}`);
  console.log(`digest:   ${digest}`);
  console.log(`receipt:  ${receipt}`);
  console.log(`ML-DSA-87 signature: ${signatureBytes.length} bytes`);

  if (dryRun) {
    console.log("\nDRY RUN — nothing submitted, no state written.");
    console.log("Batch payload (what would be sealed):");
    console.log(payloadJson);
    return;
  }

  // A live EVM authorisation window is required, and the sequencer never
  // opens one itself.
  const window = await evmWindowStatus({ rest: TESTNET_REST, address: SEQUENCER_COSMOS });
  if (!window.found || !window.live || window.remainingTxs < 1n) {
    throw new Error(
      "No live EVM authorisation window for the sequencer " +
        `(${SEQUENCER_COSMOS}): ` +
        (window.found
          ? `window found but not usable (${window.remainingBlocks} blocks, ${window.remainingTxs} txs, ${window.remainingValue} uqor left).`
          : "no window found.") +
        " Run `npm run window open` first, then retry the settle.",
    );
  }
  console.log(
    `\nwindow: live (${window.remainingBlocks} blocks, ${window.remainingTxs} txs, ${window.remainingValue} uqor left)`,
  );

  console.log("\nSubmitting batch…");
  const hash = await writeContract(wallet, {
    address: contract,
    abi,
    functionName: "submitBatch",
    args: [newStateRoot, commitment, encryptedDataHash, signature],
    value: 0n,
    account: wallet.account ?? null,
    chain: wallet.chain,
  } as never);
  const receiptTx = await client.publicClient.waitForTransactionReceipt({ hash });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, hash);
  console.log(`  tx: ${hash}`);
  console.log(`  cosmos: ${cosmos.cosmosHash} (block ${cosmos.block})`);
  console.log(`  block: ${receiptTx.blockNumber}`);

  // Only now — receipt confirmed — do the local writes and clear the mempool.
  const batchFile: BatchFile = {
    batchId,
    txs: txs.map(rollupTxToJson),
    prevStateRoot: state.stateRoot,
    stateRoot: newStateRoot,
    txDataCommitment: commitment,
    encryptedDataHash,
    kemCiphertext: toHex(kemCiphertext),
    sealedBlob: toHex(sealedBlob),
    signature,
    digest,
    submitTx: hash,
    cosmosTx: cosmos.cosmosHash,
    block: cosmos.block,
    receiptHash: receipt,
    balances: Object.fromEntries(
      [...newBalances.entries()].map(([addr, bal]) => [addr, bal.toString()]),
    ),
    nonces: Object.fromEntries(newNonces.entries()),
  };
  writeJson(path.resolve(BATCHES_DIR, `batch-${batchId}.json`), batchFile);
  const newState: RollupState = {
    batchCount: batchId + 1,
    stateRoot: newStateRoot,
    balances: batchFile.balances,
    nonces: batchFile.nonces,
  };
  writeJson(STATE_PATH, newState);
  appendUsageStep(contract, {
    command: "settle",
    batchId,
    txCount: txs.length,
    stateRoot: newStateRoot,
    txDataCommitment: commitment,
    encryptedDataHash,
    digest,
    signature,
    submitTx: hash,
    cosmosTx: cosmos.cosmosHash,
    block: cosmos.block,
    receiptHash: receipt,
  });
  writeJson(MEMPOOL_PATH, []);
  console.log(`\nBatch #${batchId} settled. Wrote deployments/batches/batch-${batchId}.json`);
  console.log("Mempool cleared.");
}

/** status: contract + local state, read-only. */
async function status(): Promise<void> {
  const { client, contract, abi, chainId } = await connect();
  const batchCount = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "batchCount",
  })) as bigint;
  const totalDeposited = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "totalDeposited",
  })) as bigint;
  const totalWithdrawn = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "totalWithdrawn",
  })) as bigint;
  const state = loadState();
  const mempool = loadMempool();
  console.log(`network:        QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract:       ${contract}`);
  console.log(`sequencer:      ${SEQUENCER_EVM}`);
  console.log(`batchCount:     ${batchCount}`);
  console.log(`totalDeposited: ${formatEther(totalDeposited)} QOR`);
  console.log(`totalWithdrawn: ${formatEther(totalWithdrawn)} QOR`);
  console.log(`local batch:    ${state.batchCount}`);
  console.log(`local root:     ${state.stateRoot}`);
  console.log(`mempool:        ${mempool.length} tx(s)`);
}

const USAGE =
  "Usage: npm run sequencer <keygen | enqueue --from <0x> --to <0x> --amount <uqor> | settle [--dry-run] | status>";

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "keygen":
      await keygen();
      break;
    case "enqueue":
      await enqueue(args);
      break;
    case "settle":
      await settle(args);
      break;
    case "status":
      await status();
      break;
    default:
      console.error(cmd ? `Unknown command "${cmd}".` : "No command given.");
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\nSequencer failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
