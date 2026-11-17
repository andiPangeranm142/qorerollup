import { EVIDENCE } from "./evidence.js";

/** EVM chain id of the QoreChain testnet (`qorechain-diana`). */
export const TESTNET_CHAIN_ID = EVIDENCE.chainId;

/** QoreChain block explorer (covers the testnet — switch to Testnet). */
export const EXPLORER_URL = "https://explore.qore.network";

/** Diana testnet EVM JSON-RPC endpoint (public, read-only). */
export const EVM_RPC_URL = "https://evm-testnet.qore.host";

/** The deployed settlement contract, from deployments/testnet.json. */
export const CONTRACT_ADDRESS = EVIDENCE.contract as `0x${string}`;

/** Deployer = sequencer. */
export const SEQUENCER_ADDRESS = EVIDENCE.deployer as `0x${string}`;

export const GITHUB_REPO = "https://github.com/andiPangeranm142/qorerollup";
export const PROJECT_PAGE = "https://build.qorechain.io/p/qorerollup";

export function explorerTx(cosmosHash: string): string {
  return `${EXPLORER_URL}/tx/${cosmosHash}`;
}

export function explorerAddress(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function explorerBlock(block: number): string {
  return `${EXPLORER_URL}/block/${block}`;
}
