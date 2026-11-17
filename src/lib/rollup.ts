/**
 * rollup.ts - pure batch math for QoreRollup. No network, no secrets.
 *
 * This is the single source of truth for batch encoding, state transitions,
 * digests and verification, shared by the sequencer (scripts/sequencer.ts)
 * and the watchtower (scripts/watchtower.ts). Every formula here must match
 * the settlement contract (contracts/QoreRollup.sol) exactly; the Hardhat
 * tests pin the digests against independently recomputed values.
 *
 * STATE MODEL — read this before assuming anything:
 * - The "state root" is a HASH COMMITMENT over the sorted set of non-zero
 *   balances, NOT a Merkle root: there are no inclusion proofs. It is
 *   keccak256(abi.encodePacked(prevStateRoot, (address, uint256 balance)...))
 *   with entries sorted ascending by address and zero balances omitted.
 *   Anyone holding the full balance set can recompute it; nobody can prove
 *   a single balance without revealing the whole set. That is a deliberate
 *   demo-grade simplification — see THREAT_MODEL.md.
 * - Balances live off-chain in deployments/state.json. L1 deposits are
 *   recorded by the contract (deposits mapping) but this demo does NOT
 *   automatically credit them into rollup balances: the operator seeds
 *   state.json. A production rollup would credit deposits on-chain.
 * - Nonces start at 0 per account and increment by exactly 1 per tx.
 */
import { pqcVerify } from "@qorechain/sdk";
import {
  concat,
  encodePacked,
  hexToBytes,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { unsealBatchPayload } from "./kem";

/** One rollup transaction. Amounts are in uqor, the rollup's unit, 1:1 with the native lane's uqor (1 QOR = 10^6 uqor). */
export interface RollupTx {
  from: Address;
  to: Address;
  /** Amount in uqor. */
  amount: bigint;
  /** Must equal the sender's current nonce (starting at 0). */
  nonce: number;
}

/** A rollup transaction as stored in JSON files (bigint is not JSON-safe). */
export interface RollupTxJson {
  from: Address;
  to: Address;
  /** Amount in uqor, as a decimal string. */
  amount: string;
  nonce: number;
}

export function rollupTxToJson(tx: RollupTx): RollupTxJson {
  return { from: tx.from, to: tx.to, amount: tx.amount.toString(), nonce: tx.nonce };
}

export function rollupTxFromJson(json: RollupTxJson): RollupTx {
  return {
    from: json.from,
    to: json.to,
    amount: BigInt(json.amount),
    nonce: json.nonce,
  };
}

/**
 * Canonical encoding of one transaction:
 * abi.encodePacked(from, to, uint256 amount, uint256 nonce).
 */
export function encodeTx(tx: RollupTx): Hex {
  return encodePacked(
    ["address", "address", "uint256", "uint256"],
    [tx.from, tx.to, tx.amount, BigInt(tx.nonce)],
  );
}

/**
 * Commitment to an ordered list of transactions: keccak256 over the
 * concatenated encodings, in order. Throws on an empty list — a batch with
 * no transactions is not a batch.
 */
export function txDataCommitment(txs: RollupTx[]): Hex {
  if (txs.length === 0) {
    throw new Error("cannot commit to an empty transaction list");
  }
  return keccak256(concat(txs.map(encodeTx)));
}

/** The state root before any batch: keccak256(utf8 "QoreRollup.genesis"). */
export const GENESIS_STATE_ROOT: Hex = keccak256(stringToHex("QoreRollup.genesis"));

export interface ApplyTxsResult {
  newStateRoot: Hex;
  /** Balances after applying, zero balances omitted, keys lowercased. */
  newBalances: Map<Address, bigint>;
  /** Nonces after applying, keys lowercased. */
  newNonces: Map<Address, number>;
}

/**
 * Apply transactions in order to a balance set, returning the new state root
 * and the new balance/nonce maps. Throws on:
 * - an empty transaction list,
 * - a non-positive amount,
 * - a nonce that does not equal the sender's current nonce (replay or gap),
 * - an insufficient sender balance.
 *
 * The new state root is keccak256(abi.encodePacked(prevStateRoot, then one
 * (address, uint256 balance) pair per non-zero balance, sorted ascending by
 * address)). This is a hash commitment over the sorted balance set, NOT a
 * Merkle root: it commits to the whole set at once and supports no
 * per-account inclusion proof.
 */
export function applyTxs(
  prevStateRoot: Hex,
  prevBalances: Map<Address, bigint>,
  txs: RollupTx[],
  prevNonces: Map<Address, number> = new Map(),
): ApplyTxsResult {
  if (txs.length === 0) {
    throw new Error("cannot apply an empty transaction list");
  }
  // Normalise keys to lowercase so checksummed and lowercase spellings of
  // the same address are one account.
  const balances = new Map<Address, bigint>();
  for (const [addr, bal] of prevBalances) {
    balances.set(addr.toLowerCase() as Address, bal);
  }
  const nonces = new Map<Address, number>();
  for (const [addr, n] of prevNonces) {
    nonces.set(addr.toLowerCase() as Address, n);
  }

  for (const tx of txs) {
    if (tx.amount <= 0n) {
      throw new Error(`invalid amount ${tx.amount} for tx from ${tx.from}: must be positive`);
    }
    const from = tx.from.toLowerCase() as Address;
    const to = tx.to.toLowerCase() as Address;
    const expectedNonce = nonces.get(from) ?? 0;
    if (tx.nonce !== expectedNonce) {
      throw new Error(
        `wrong nonce for ${tx.from}: tx nonce ${tx.nonce}, expected ${expectedNonce}`,
      );
    }
    const senderBalance = balances.get(from) ?? 0n;
    if (senderBalance < tx.amount) {
      throw new Error(
        `insufficient balance for ${tx.from}: has ${senderBalance} uqor, needs ${tx.amount} uqor`,
      );
    }
    balances.set(from, senderBalance - tx.amount);
    balances.set(to, (balances.get(to) ?? 0n) + tx.amount);
    nonces.set(from, expectedNonce + 1);
  }

  // Zero balances are omitted from the commitment, so drop them from the
  // returned map too (state.json stays a clean picture of the committed set).
  for (const [addr, bal] of [...balances]) {
    if (bal === 0n) balances.delete(addr);
  }
  const entries = [...balances.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  // Exactly abi.encodePacked(prevStateRoot, (address, uint256)...):
  // 32-byte root, then 20-byte address + 32-byte balance per entry.
  const packed = concat([
    prevStateRoot,
    ...entries.flatMap(([addr, bal]) => [addr as Hex, toHex(bal, { size: 32 })]),
  ]);
  return { newStateRoot: keccak256(packed), newBalances: balances, newNonces: nonces };
}

/**
 * The digest the sequencer signs for a batch. MUST match the contract's
 * batchDigest exactly:
 * keccak256(abi.encodePacked("QoreRollup.batch", chainid, contract,
 *   batchId, stateRoot, txDataCommitment, encryptedDataHash)).
 * The ML-DSA-87 signature is over the 32 bytes of this digest.
 */
export function batchDigest(
  chainId: number | bigint,
  contract: Address,
  batchId: number | bigint,
  stateRoot: Hex,
  commitment: Hex,
  encryptedDataHash: Hex,
): Hex {
  return keccak256(
    encodePacked(
      ["string", "uint256", "address", "uint256", "bytes32", "bytes32", "bytes32"],
      [
        "QoreRollup.batch",
        BigInt(chainId),
        contract,
        BigInt(batchId),
        stateRoot,
        commitment,
        encryptedDataHash,
      ],
    ),
  );
}

/**
 * The verified settlement receipt hash. MUST match the contract's receipt
 * computation exactly:
 * keccak256(abi.encodePacked("QoreRollup.receipt", chainid, contract,
 *   batchId, stateRoot, txDataCommitment)).
 */
export function receiptHash(
  chainId: number | bigint,
  contract: Address,
  batchId: number | bigint,
  stateRoot: Hex,
  commitment: Hex,
): Hex {
  return keccak256(
    encodePacked(
      ["string", "uint256", "address", "uint256", "bytes32", "bytes32"],
      ["QoreRollup.receipt", BigInt(chainId), contract, BigInt(batchId), stateRoot, commitment],
    ),
  );
}

/** The JSON payload sealed with ML-KEM-1024 for one batch. */
export interface BatchPayload {
  batchId: number;
  prevStateRoot: Hex;
  txs: RollupTxJson[];
  newStateRoot: Hex;
}

/**
 * A settled batch as stored in deployments/batches/batch-<id>.json.
 * `balances`/`nonces` are the POST-batch state, stored so the watchtower can
 * replay the chain of batches without any other input.
 */
export interface BatchFile {
  batchId: number;
  txs: RollupTxJson[];
  prevStateRoot: Hex;
  stateRoot: Hex;
  txDataCommitment: Hex;
  encryptedDataHash: Hex;
  /** ML-KEM-1024 ciphertext (1568 bytes), 0x hex. */
  kemCiphertext: Hex;
  /** AES-256-GCM blob (nonce || ciphertext || tag), 0x hex. */
  sealedBlob: Hex;
  /** ML-DSA-87 signature over the batch digest, 0x hex. */
  signature: Hex;
  digest: Hex;
  submitTx: Hex;
  cosmosTx: string;
  block: number;
  receiptHash: Hex;
  /** Post-batch balances: address (lowercase) -> decimal uqor string. */
  balances: Record<string, string>;
  /** Post-batch nonces: address (lowercase) -> nonce. */
  nonces: Record<string, number>;
}

/** One batch as the contract reports it via getBatch. */
export interface OnChainBatch {
  stateRoot: Hex;
  txDataCommitment: Hex;
  encryptedDataHash: Hex;
  timestamp: bigint;
  receiptHash: Hex;
}

export interface VerifyBatchContext {
  chainId: number | bigint;
  contract: Address;
  /** The batch id this batch is expected to be (the loop index). */
  batchId: number;
  /** The sequencer's REGISTERED ML-DSA-87 public key, from the chain. */
  sequencerPublicKey: Uint8Array;
  /** Expected previous state root (GENESIS for batch 0). */
  prevStateRoot: Hex;
  /** Balances before this batch (empty for batch 0). */
  prevBalances: Map<Address, bigint>;
  /** Nonces before this batch (empty for batch 0). */
  prevNonces: Map<Address, number>;
  /**
   * ML-KEM-1024 secret key for the decrypt check. When omitted the decrypt
   * check is skipped (decryptSkipped: true) and the other checks still run.
   */
  kemSecretKey?: Uint8Array;
}

export interface VerifyBatchResult {
  ok: boolean;
  /** One entry per failed check, naming what failed. Empty when ok. */
  failures: string[];
  /** True when the decrypt check was skipped for want of the KEM key. */
  decryptSkipped: boolean;
}

const lower = (hex: string): string => hex.toLowerCase();

function canonicalTxs(txs: RollupTxJson[]): string {
  return txs.map((t) => `${lower(t.from)}|${lower(t.to)}|${t.amount}|${t.nonce}`).join(";");
}

/**
 * Verify one settled batch against the on-chain record and the pre-batch
 * state. Pure: every input is passed in, so tests can drive it with
 * fixtures and the CLI only fetches the inputs. Checks:
 *  (a) the ML-DSA-87 signature verifies against the sequencer's REGISTERED
 *      public key over the recomputed batch digest;
 *  (b) the tx commitment, the encrypted-data hash and the state transition
 *      recompute from the batch file and match BOTH the batch file and the
 *      on-chain record;
 *  (c) the on-chain receipt hash matches the recomputed receipt;
 *  (d) when a KEM secret key is given, the sealed blob decrypts to a payload
 *      that matches the batch file.
 * A failure names the check that failed; verification never throws for a
 * bad batch (malformed inputs are reported as failures).
 */
export function verifyBatch(
  batch: BatchFile,
  onChain: OnChainBatch,
  ctx: VerifyBatchContext,
): VerifyBatchResult {
  const failures: string[] = [];
  let decryptSkipped = false;

  if (batch.batchId !== ctx.batchId) {
    failures.push(`batch id mismatch: file says ${batch.batchId}, expected ${ctx.batchId}`);
  }
  if (lower(batch.prevStateRoot) !== lower(ctx.prevStateRoot)) {
    failures.push("prevStateRoot does not match the previous batch's state root");
  }

  // (b1) tx commitment recomputes from the batch file's txs.
  let txs: RollupTx[];
  try {
    txs = batch.txs.map(rollupTxFromJson);
  } catch (err) {
    failures.push(`batch txs are malformed: ${err instanceof Error ? err.message : err}`);
    return { ok: false, failures, decryptSkipped };
  }
  let recomputedCommitment: Hex | undefined;
  try {
    recomputedCommitment = txDataCommitment(txs);
  } catch (err) {
    failures.push(`tx commitment failed: ${err instanceof Error ? err.message : err}`);
  }
  if (recomputedCommitment) {
    if (lower(recomputedCommitment) !== lower(batch.txDataCommitment)) {
      failures.push("txDataCommitment does not match the batch file's transactions");
    }
    if (lower(recomputedCommitment) !== lower(onChain.txDataCommitment)) {
      failures.push("txDataCommitment does not match the on-chain record");
    }
  }
  if (lower(batch.txDataCommitment) !== lower(onChain.txDataCommitment)) {
    failures.push("batch file txDataCommitment differs from the on-chain record");
  }

  // (b2) encrypted-data hash recomputes from the stored ciphertext + blob.
  let recomputedEncryptedHash: Hex | undefined;
  try {
    recomputedEncryptedHash = keccak256(
      concat([batch.kemCiphertext, batch.sealedBlob]),
    );
  } catch (err) {
    failures.push(`encryptedDataHash failed: ${err instanceof Error ? err.message : err}`);
  }
  if (recomputedEncryptedHash) {
    if (lower(recomputedEncryptedHash) !== lower(batch.encryptedDataHash)) {
      failures.push("encryptedDataHash does not match the stored KEM ciphertext + sealed blob");
    }
    if (lower(recomputedEncryptedHash) !== lower(onChain.encryptedDataHash)) {
      failures.push("encryptedDataHash does not match the on-chain record");
    }
  }
  if (lower(batch.encryptedDataHash) !== lower(onChain.encryptedDataHash)) {
    failures.push("batch file encryptedDataHash differs from the on-chain record");
  }

  // (b3) state root: file vs on-chain, then full replay from pre-batch state.
  if (lower(batch.stateRoot) !== lower(onChain.stateRoot)) {
    failures.push("batch file stateRoot differs from the on-chain record");
  }
  try {
    const { newStateRoot } = applyTxs(batch.prevStateRoot, ctx.prevBalances, txs, ctx.prevNonces);
    if (lower(newStateRoot) !== lower(batch.stateRoot)) {
      failures.push("replayed state root does not match the batch file's stateRoot");
    }
    if (lower(newStateRoot) !== lower(onChain.stateRoot)) {
      failures.push("replayed state root does not match the on-chain stateRoot");
    }
  } catch (err) {
    failures.push(`state transition replay failed: ${err instanceof Error ? err.message : err}`);
  }

  // Digest: recomputed from the ON-CHAIN values (what was actually settled).
  const recomputedDigest = batchDigest(
    ctx.chainId,
    ctx.contract,
    ctx.batchId,
    onChain.stateRoot,
    onChain.txDataCommitment,
    onChain.encryptedDataHash,
  );
  if (lower(recomputedDigest) !== lower(batch.digest)) {
    failures.push("batch file digest does not match the digest recomputed from the on-chain record");
  }

  // (a) ML-DSA-87 signature over the recomputed digest bytes.
  let signatureOk = false;
  try {
    signatureOk = pqcVerify(
      ctx.sequencerPublicKey,
      hexToBytes(recomputedDigest),
      hexToBytes(batch.signature),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    failures.push("ML-DSA-87 signature does not verify against the sequencer's registered public key");
  }

  // (c) receipt hash.
  const recomputedReceipt = receiptHash(
    ctx.chainId,
    ctx.contract,
    ctx.batchId,
    onChain.stateRoot,
    onChain.txDataCommitment,
  );
  if (lower(recomputedReceipt) !== lower(onChain.receiptHash)) {
    failures.push("on-chain receiptHash does not match the recomputed receipt");
  }
  if (lower(recomputedReceipt) !== lower(batch.receiptHash)) {
    failures.push("batch file receiptHash does not match the recomputed receipt");
  }

  // (d) decrypt check, when the KEM secret key is available.
  if (!ctx.kemSecretKey) {
    decryptSkipped = true;
  } else {
    try {
      const payloadJson = unsealBatchPayload(
        ctx.kemSecretKey,
        hexToBytes(batch.kemCiphertext),
        hexToBytes(batch.sealedBlob),
      );
      const payload = JSON.parse(payloadJson) as BatchPayload;
      if (payload.batchId !== batch.batchId) {
        failures.push("decrypted payload batchId does not match the batch file");
      }
      if (lower(payload.prevStateRoot) !== lower(batch.prevStateRoot)) {
        failures.push("decrypted payload prevStateRoot does not match the batch file");
      }
      if (lower(payload.newStateRoot) !== lower(batch.stateRoot)) {
        failures.push("decrypted payload newStateRoot does not match the batch file");
      }
      if (canonicalTxs(payload.txs) !== canonicalTxs(batch.txs)) {
        failures.push("decrypted payload transactions do not match the batch file");
      }
    } catch (err) {
      failures.push(
        `decrypt check failed (tampered blob/ciphertext or wrong key): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { ok: failures.length === 0, failures, decryptSkipped };
}
