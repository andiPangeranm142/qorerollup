/**
 * usage.ts - deposit QOR into the rollup and withdraw it back, on Diana.
 *
 * Usage (see README):
 *   npm run usage deposit --amount <uqor>    deposit QOR into QoreRollup
 *   npm run usage withdraw --amount <uqor>   withdraw QOR back (fresh nullifier)
 *
 * Both commands need a live EVM authorisation window for the deployer
 * (run `npm run window open` first). Each step is appended to
 * deployments/usage.json (same file the sequencer writes its settle steps
 * to), with the EVM hash, the Cosmos hash and the block number.
 *
 * Safety: testnet ONLY (EVM chain id 9800). Secrets come from ../.env and
 * are never printed. The withdrawal id is keccak256("QoreRollup.withdraw-<n>")
 * where <n> counts prior withdrawals in usage.json, so every withdrawal
 * uses a fresh nullifier.
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { cosmosHashForEvmTx } from "./cosmos-hash";

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

function loadDeployment(): { contract: Address } {
  const deploymentPath = path.resolve(DEPLOYMENTS, "testnet.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("No deployments/testnet.json yet — deploy the contract first.");
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
    throw new Error("No compiled QoreRollup artifact yet — run `npm run compile` first.");
  }
  const artifact = readJson<{ abi: unknown }>(artifactPath);
  return artifact.abi as never;
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

function countPriorWithdrawals(): number {
  if (!fs.existsSync(USAGE_PATH)) return 0;
  const existing = readJson<{ steps?: Array<{ command?: string }> }>(USAGE_PATH);
  return (existing.steps ?? []).filter((s) => s.command === "withdraw").length;
}

function parseAmount(args: string[]): bigint {
  const i = args.indexOf("--amount");
  const raw = i >= 0 ? args[i + 1] : undefined;
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error("Usage: npm run usage <deposit|withdraw> --amount <uqor>");
  }
  const amount = BigInt(raw);
  if (amount <= 0n) throw new Error("--amount must be positive");
  return amount;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd !== "deposit" && cmd !== "withdraw") {
    console.error("Usage: npm run usage <deposit|withdraw> --amount <uqor>");
    process.exitCode = 1;
    return;
  }
  const amountUqor = parseAmount(args);
  const amountWei = amountUqor * 10n ** 12n; // 1 QOR = 1e6 uqor = 1e18 wei

  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;
  const { contract } = loadDeployment();
  const abi = loadAbi();
  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`Refusing: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}.`);
  }
  const account = evmAccountFromPrivateKey(privateKey);
  const wallet = client.getWalletClient(account);

  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`contract: ${contract}`);
  console.log(`account:  ${account.address}`);

  if (cmd === "deposit") {
    console.log(`\nDepositing ${amountWei} wei (${amountUqor} uqor = ${(Number(amountUqor) / 1_000_000).toFixed(6)} QOR)…`);
    const hash = await writeContract(wallet, {
      address: contract,
      abi,
      functionName: "deposit",
      args: [],
      value: amountWei,
      account: wallet.account ?? null,
      chain: wallet.chain,
    } as never);
    const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
    const cosmos = await cosmosHashForEvmTx(client.publicClient, hash);
    console.log(`  tx: ${hash}`);
    console.log(`  cosmos: ${cosmos.cosmosHash} (block ${cosmos.block})`);
    console.log(`  block: ${receipt.blockNumber}`);
    appendUsageStep(contract, {
      command: "deposit",
      amountUqor: amountUqor.toString(),
      tx: hash,
      cosmosTx: cosmos.cosmosHash,
      block: cosmos.block,
    });
    console.log("Recorded in deployments/usage.json.");
    return;
  }

  // withdraw — fresh nullifier per withdrawal.
  const n = countPriorWithdrawals() + 1;
  const withdrawalId = keccak256(stringToHex(`QoreRollup.withdraw-${n}`));
  const deposited = (await readContract(client.publicClient, {
    address: contract,
    abi,
    functionName: "deposits",
    args: [account.address],
  })) as bigint;
  console.log(`\nDeposited balance: ${deposited} wei`);
  if (deposited < amountWei) {
    throw new Error(
      `Insufficient deposit: ${deposited} wei available, ${amountWei} wei requested.`,
    );
  }
  console.log(`Withdrawing ${amountUqor} uqor (withdrawalId ${withdrawalId})…`);
  const hash = await writeContract(wallet, {
    address: contract,
    abi,
    functionName: "withdraw",
    args: [amountWei, withdrawalId],
    value: 0n,
    account: wallet.account ?? null,
    chain: wallet.chain,
  } as never);
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, hash);
  console.log(`  tx: ${hash}`);
  console.log(`  cosmos: ${cosmos.cosmosHash} (block ${cosmos.block})`);
  console.log(`  block: ${receipt.blockNumber}`);
  appendUsageStep(contract, {
    command: "withdraw",
    amountUqor: amountUqor.toString(),
    withdrawalId,
    tx: hash,
    cosmosTx: cosmos.cosmosHash,
    block: cosmos.block,
  });
  console.log("Recorded in deployments/usage.json.");
}

main().catch((err: unknown) => {
  console.error(`\nUsage failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
