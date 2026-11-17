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
 * - The "state root" is the MERKLE ROOT over the post-batch state: one
 *   leaf per non-zero balance, leaf =
 *   keccak256(abi.encodePacked(account, balance, nonce)), binary tree
 *   with sorted pairs (OpenZeppelin MerkleProof convention). See
 *   src/lib/merkle.ts. Any account can prove its balance against a
 *   settled root with a Merkle proof and withdraw directly from the
 *   contract — no sequencer help (contracts/QoreRollup.sol `withdraw`).
 * - Balances live off-chain in deployments/state.json. L1 deposits ARE
 *   credited into rollup balances automatically: the deposit watcher
 *   (scripts/deposit-watcher.ts) reads `Deposited` events from the
 *   settlement contract, records them in deployments/deposits.json, and
 *   the sequencer applies the pending ones into the next batch's state
 *   transition (applyDeposits, below) — so a deposit's credit is part of
 *   the batch the watchtower replays, not a side channel. The genesis
 *   funding (the 0.3 QOR deposit credited before batch #0) predates the
 *   watcher and was seeded by hand; it is recorded in
 *   deployments/deposits.json with status "genesis" so it is never
 *   credited twice.
 * - Nonces start at 0 per account and increment by exactly 1 per tx.
 *   The nonce is part of the leaf, so a leaf proves (balance, nonce)
 *   together — a stale leaf (old nonce) cannot be replayed after the
 *   account's nonce moved on.
 */
import { pqcVerify } from "@qorechain/sdk";
import {
  concat,
  encodePacked,
  hexToBytes,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { unsealBatchPayload } from "./kem";
import {
  buildStateTree,
  leafHash,
  merkleLeafFromJson,
  stateLeaves,
  verifyProof,
  type MerkleLeaf,
  type MerkleLeafJson,
} from "./merkle";

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
 * One L1 deposit credited by a batch, as stored in the batch file.
 * The deposit watcher (scripts/deposit-watcher.ts) finds these on-chain
 * (`Deposited` events); the sequencer applies them into the batch's
 * state transition before the batch's transactions. `tx` + `block`
 * identify the deposit on-chain — the watchtower matches every batch
 * deposit against the contract's event logs, so a batch cannot invent
 * a deposit the chain never saw.
 */
export interface BatchDepositJson {
  /** Depositor address (checksummed). */
  depositor: Address;
  /** Amount in uqor, as a decimal string. */
  amountUqor: string;
  /** EVM transaction hash of the deposit. */
  tx: Hex;
  /** Block the deposit was mined in. */
  block: number;
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
  /** State leaves of the post-batch state (non-zero balances, sorted). */
  leaves: MerkleLeaf[];
  /** Merkle proof per account (lowercase address) against newStateRoot. */
  proofs: Record<string, Hex[]>;
}

/**
 * Apply transactions in order to a balance set, returning the new state root
 * and the new balance/nonce maps. Throws on:
 * - an empty transaction list,
 * - a non-positive amount,
 * - a nonce that does not equal the sender's current nonce (replay or gap),
 * - an insufficient sender balance.
 *
 * The new state root is the MERKLE ROOT over the post-batch state (see
 * src/lib/merkle.ts): one leaf per non-zero balance, sorted ascending by
 * address, leaf = keccak256(abi.encodePacked(account, balance, nonce)),
 * binary tree with sorted pairs. The previous root does NOT feed the new
 * root — the root commits to the current state alone, and the batch chain
 * is enforced by the prevStateRoot fields and the watchtower's replay.
 * A drained account (zero balance) has no leaf and leaves no trace in
 * the tree, but its nonce still moved — so a batch that drains an
 * account does NOT produce the same root as a batch that never funded
 * it (the nonce is part of the leaf).
 */
export function applyTxs(
  // Kept for API stability and to document the chain: the new root does
  // NOT depend on the previous root (a Merkle root commits to the current
  // state alone). Callers still pass it, and verifyBatch checks the
  // batch file's prevStateRoot against the previous batch's root.
  _prevStateRoot: Hex,
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
  // The state root is the Merkle root over the post-batch state leaves
  // (non-zero balances, sorted by address; nonce is part of each leaf).
  const { root, leaves, proofs } = buildStateTree(balances, nonces);
  return { newStateRoot: root, newBalances: balances, newNonces: nonces, leaves, proofs };
}

/**
 * Apply L1 deposit credits to a balance set, returning the new balances.
 * Deposits mint rollup funds: they add to the depositor's balance and do
 * NOT touch nonces (a deposit is not a transaction — it has no nonce to
 * consume). Throws on a malformed deposit (invalid address, non-numeric
 * or non-positive amount) so a corrupt deposits file fails loudly
 * instead of crediting garbage. The input map is not mutated.
 */
export function applyDeposits(
  prevBalances: Map<Address, bigint>,
  deposits: BatchDepositJson[],
): Map<Address, bigint> {
  const balances = new Map<Address, bigint>();
  for (const [addr, bal] of prevBalances) {
    balances.set(addr.toLowerCase() as Address, bal);
  }
  for (const d of deposits) {
    if (!isAddress(d.depositor)) {
      throw new Error(`invalid depositor address in batch deposit: ${String(d.depositor)}`);
    }
    let amount: bigint;
    try {
      amount = BigInt(d.amountUqor);
    } catch {
      throw new Error(`invalid amount in batch deposit for ${d.depositor}: ${String(d.amountUqor)}`);
    }
    if (amount <= 0n) {
      throw new Error(`non-positive amount in batch deposit for ${d.depositor}: ${amount}`);
    }
    const addr = d.depositor.toLowerCase() as Address;
    balances.set(addr, (balances.get(addr) ?? 0n) + amount);
  }
  return balances;
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
 * replay the chain of batches without any other input. `leaves`/`proofs`
 * are the post-batch Merkle state tree, stored so any account can withdraw
 * with its proof and no sequencer help.
 */
export interface BatchFile {
  batchId: number;
  txs: RollupTxJson[];
  /**
   * L1 deposits credited by this batch (empty/absent for batches 0–2,
   * which predate the deposit watcher). Applied to the pre-batch
   * balances BEFORE the batch's transactions, in chain order — the
   * watchtower replays them the same way, and matches each one against
   * the contract's `Deposited` event logs.
   */
  deposits?: BatchDepositJson[];
  prevStateRoot: Hex;
  /** The post-batch Merkle state root (see src/lib/merkle.ts). */
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
  /** Post-batch Merkle leaves (non-zero balances, sorted by address). */
  leaves: MerkleLeafJson[];
  /** Merkle proof per account (lowercase address) against stateRoot. */
  proofs: Record<string, Hex[]>;
  /**
   * PRE-batch balances/nonces (optional for files written before this
   * field existed). The watchtower replays from these: batch 0's pre-state
   * is the operator-seeded genesis funding, which the chained replay from
   * empty genesis cannot know. Without them the watchtower falls back to
   * the chained pre-state from the previous batch file.
   */
  prevBalances?: Record<string, string>;
  /** Pre-batch nonces, paired with prevBalances. */
  prevNonces?: Record<string, number>;
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
 *      (L1 deposit credits first, then the transactions) recompute from
 *      the batch file and match BOTH the batch file and the on-chain
 *      record;
 *  (b4) the Merkle state tree: the batch file's leaves recompute to the
 *      file's stateRoot AND to the on-chain root, every leaf's hash
 *      recomputes from its (account, balance, nonce), the leaves match
 *      the replayed post-batch state exactly, and every leaf's proof
 *      verifies against the root;
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
  let replayedBalances: Map<Address, bigint> | undefined;
  let replayedNonces: Map<Address, number> | undefined;
  try {
    // Deposits credited by this batch apply to the pre-batch balances
    // BEFORE the transactions (same order the sequencer builds with).
    const fundedBalances = applyDeposits(ctx.prevBalances, batch.deposits ?? []);
    const replayed = applyTxs(batch.prevStateRoot, fundedBalances, txs, ctx.prevNonces);
    replayedBalances = replayed.newBalances;
    replayedNonces = replayed.newNonces;
    if (lower(replayed.newStateRoot) !== lower(batch.stateRoot)) {
      failures.push("replayed state root does not match the batch file's stateRoot");
    }
    if (lower(replayed.newStateRoot) !== lower(onChain.stateRoot)) {
      failures.push("replayed state root does not match the on-chain stateRoot");
    }
  } catch (err) {
    failures.push(`state transition replay failed: ${err instanceof Error ? err.message : err}`);
  }

  // (b4) Merkle state tree: leaves recompute to the root, match the
  // replayed post-state, and every proof verifies. This is what makes
  // withdrawals possible — a batch whose leaves are wrong would strand
  // users who cannot prove their balance.
  if (!Array.isArray(batch.leaves) || typeof batch.proofs !== "object" || batch.proofs === null) {
    failures.push("batch file has no Merkle leaves/proofs (pre-v2 batch file)");
  } else {
    let leaves: MerkleLeaf[];
    try {
      leaves = batch.leaves.map(merkleLeafFromJson);
    } catch (err) {
      failures.push(`batch leaves are malformed: ${err instanceof Error ? err.message : err}`);
      leaves = [];
    }
    if (leaves.length > 0) {
      // Each leaf hash recomputes from its (account, balance, nonce).
      for (const l of leaves) {
        if (lower(leafHash(l.account, l.balance, l.nonce)) !== lower(l.leaf)) {
          failures.push(`leaf for ${l.account} does not match its (account, balance, nonce)`);
        }
      }
      // The leaves recompute to the file's root and the on-chain root.
      const { root: leavesRoot } = buildStateTree(
        new Map(leaves.map((l) => [l.account.toLowerCase() as Address, l.balance] as const)),
        new Map(leaves.map((l) => [l.account.toLowerCase() as Address, l.nonce] as const)),
      );
      if (lower(leavesRoot) !== lower(batch.stateRoot)) {
        failures.push("Merkle root recomputed from the batch file's leaves does not match the batch file's stateRoot");
      }
      if (lower(leavesRoot) !== lower(onChain.stateRoot)) {
        failures.push("Merkle root recomputed from the batch file's leaves does not match the on-chain stateRoot");
      }
      // Every leaf's proof verifies against the root.
      for (const l of leaves) {
        const proof = batch.proofs[l.account.toLowerCase()];
        if (!Array.isArray(proof)) {
          failures.push(`no Merkle proof stored for ${l.account}`);
        } else if (!verifyProof(l.leaf, proof, batch.stateRoot)) {
          failures.push(`Merkle proof for ${l.account} does not verify against the batch stateRoot`);
        }
      }
      // The leaves match the replayed post-batch state exactly (no leaf
      // added, removed, or re-valued versus the tx replay).
      if (replayedBalances && replayedNonces) {
        const expectedLeaves = stateLeaves(replayedBalances, replayedNonces);
        const canonical = (ls: MerkleLeaf[]): string =>
          JSON.stringify(
            ls.map((l) => [l.account.toLowerCase(), l.balance.toString(), l.nonce, lower(l.leaf)]),
          );
        const sortedFileLeaves = [...leaves].sort((a, b) =>
          a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1,
        );
        if (canonical(sortedFileLeaves) !== canonical(expectedLeaves)) {
          failures.push("batch file leaves do not match the replayed post-batch state (balances/nonces)");
        }
      }
    }
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
