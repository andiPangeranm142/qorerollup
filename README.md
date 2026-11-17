# QoreRollup

A minimal post-quantum rollup on QoreChain — a Protocol Builders entry
for the QoreChain Developer Fest ("Build Before Q-Day").

**Status:** live on the Diana testnet (v2). Settlement contract
deployed, 3 batches settled with ML-DSA-87 signatures verified
on-chain, an independent user wallet withdrew 0.05 QOR with a Merkle
proof and no sequencer help, double-withdraw and tampered-proof attacks
reverted on-chain, and the watchtower verifies all batches clean.

- Project page: https://build.qorechain.io/p/qorerollup
- Demo site: https://andipangeranm142.github.io/qorerollup/
- Demo video: docs/demo.mp4 (2:23, silent)

## Team

- **Andi Pangeran** ([@andiPangeranm142](https://github.com/andiPangeranm142)) — Indonesia
- **Ajeng Ayu Kusum** ([@Ajengayukusu](https://github.com/Ajengayukusu)) — Indonesia

## Concept

QoreRollup is a minimal rollup that batches transactions off-chain and
settles them on the QoreChain Diana testnet with post-quantum security:

- An off-chain sequencer collects transactions into batches.
- Each batch is signed with **ML-DSA-87** (post-quantum signatures).
- A settlement contract on Diana verifies the batch signature
  (via the `pqcVerify` precompile, against the sequencer's REGISTERED
  key from the `pqcKeyStatus` precompile) and records the batch's
  Merkle state root, issuing a **verified settlement receipt**.
- **Withdrawals** are proven against a settled batch's Merkle state
  root: any account withdraws its own rollup balance by presenting a
  Merkle proof for its leaf — directly, with **no sequencer help**.
  The sequencer cannot block a withdrawal. A cumulative per-account
  cap (`withdrawnAmount`) means the total ever withdrawn can never
  exceed the largest leaf balance proven, so withdrawing against
  several batch roots cannot double-spend.
- A **watchtower** re-verifies every batch (signature, state replay,
  Merkle tree + every leaf's proof, receipt, decrypt check) and flags
  invalid ones.
- Batch payloads are sealed with **ML-KEM-1024** (+ AES-256-GCM);
  the on-chain commitment is to the ciphertext.
- A **threat model** ([THREAT_MODEL.md](THREAT_MODEL.md)) documents the
  attack surface and mitigations — including what is demo-grade.

## Category requirements (Protocol Builders)

- [x] ML-DSA-signed batches — every settled batch carries a 4,627-byte
  ML-DSA-87 signature, verified on-chain via `pqcVerify`.
- [x] Withdrawal — 0.05 QOR withdrawn on-chain by an independent user
  wallet with a Merkle proof against batch #2's state root, no
  sequencer involvement (see Live usage). The same call sent twice
  REVERTED on-chain (`ZeroWithdraw`), and a call with one flipped hex
  char in the proof REVERTED on-chain (`InvalidMerkleProof`).
- [x] Verified settlement receipt — each batch gets a `receiptHash`
  (`keccak256("QoreRollup.receipt", chainid, contract, batchId,
  stateRoot, txDataCommitment)`), emitted in `BatchSettled` and
  re-verified by the watchtower.
- [x] Watchtower — `npm run watchtower` verifies all 3 batches OK
  (signature, state replay, Merkle tree + proofs, receipt, decrypt
  check, genesis-funding cross-check). Tampered batches are detected
  (see tests) — and demonstrated live: flipping one hex char in a
  batch file's claimed state root made the watchtower FAIL that batch
  on eight independent checks (file vs on-chain root, replayed root,
  leaves-recomputed root, all four leaf proofs, decrypted payload)
  and FAIL the next batch on the broken chain; restoring the file
  byte-identical returned ALL BATCHES OK. Every run is appended to
  the verification log
  ([deployments/watchtower-log.json](deployments/watchtower-log.json)),
  with the contract address on each entry so v1 and v2 runs are
  distinguishable.
- [x] ML-KEM data protection — batch payloads sealed with ML-KEM-1024
  + AES-256-GCM; public key in
  [deployments/kem-public-key.json](deployments/kem-public-key.json),
  secret key held by the operator outside the repo.
- [x] Threat model — [THREAT_MODEL.md](THREAT_MODEL.md).

## Live deployment (Diana testnet, chain id 9800)

- **Settlement contract (v2):** `0xb54a8bd2dfffa9f3b8a23c3b4e663fe31667d708`
  ([explorer](https://explore.qore.network/address/0xb54a8bd2dfffa9f3b8a23c3b4e663fe31667d708) — switch to Testnet)
- **Deployer = sequencer:** `0x0140a056ee37D5240b0397eCdF1347Da80E33b9f`
  (`qor1q9q2q4hwxl2jgzcrjlkd7y68m2qwxwul0nheda`)
- **Demo user wallet** (independent of the sequencer):
  `0x29cb5ABD4309b5A83A6A66e95CbdA1d88F060d4F`
  (`qor19894402rpx66swn2vm54e0dpmz8svr20a952gv`), funded with 2 QOR
  (Cosmos `219FD783C30500EF438F29AC4B6520B2D6609B49DAC4107EA091B1FDF2C07889`),
  own ML-DSA-87 key registered
  (Cosmos `977B19B645464EB918D49FD09A780440C46393DDE6B12E32F770787DC16CEBE8`).
- **Deploy tx:** `0x9f8032e00d66000ff427868c9c57a27ee006d769d1c797b5936457c280022cd0`
  (Cosmos `5DFEEF53AEFBD5F23FA3DA9DC6F47D7168B5A91DEB75843211CA4470E4713510`,
  block 10250134). Bytecode: 3,877 bytes.
- **ML-KEM-1024 data key:** public key hash
  `0xf2ef384e0592c94dbc9b70b175eb8731432bdf0040581aac3d24797bbf8bf862`
  (see [deployments/kem-public-key.json](deployments/kem-public-key.json);
  the v1 keypair was reused, never regenerated).

**v1 superseded.** The first settlement contract,
`0x96051b69a7d0e2236a3fe2e51fe33a55367d36c2`, is superseded by v2: its
withdrawals checked the L1 deposit ledger with a per-withdrawal
nullifier, and its state root was a plain hash commitment with no
inclusion proofs — so a user could not withdraw on the basis of their
rollup balance at all. v2's state root is a Merkle root and withdrawals
are proven against it. The v1 history (3 batches, 1 withdrawal, 1
forged-batch revert) is real on-chain activity and is archived in
[deployments/v1/](deployments/v1/).

## Live usage (17 Nov 2026, all on Diana)

Full step log with hashes: [deployments/usage.json](deployments/usage.json).
Per-batch detail (txs, state roots, leaves, proofs, signatures,
ciphertexts): [deployments/batches/](deployments/batches/).

| Step | Detail | EVM tx | Block |
| --- | --- | --- | --- |
| Deposit | 0.3 QOR into the rollup | `0x0a39abcbd8307280e19f3e035bbbde29a36804b865da95f74d6fac4dd73ee2a5` | 10250139 |
| Batch #0 | 1 tx: deployer → user wallet, 50,000 uqor (2 leaves) | `0x192d42f9ce32dad3e16dd031bcd8e52b8de03edffbb1f8b3ab7f9373d1774382` | 10250155 |
| Batch #1 | 2 txs: deployer → `0x1111…1111` 25,000; `0x1111…1111` → `0x2222…2222` 10,000 uqor (4 leaves) | `0x2604ab6a838cc66c8c0b22f8198aa8fa630333b93616287c016d97e37abfa5ef` | 10250169 |
| Batch #2 | 1 tx: deployer → `0x3333…3333`, 15,000 uqor (5 leaves) | `0xf6ff9ad564f9c2214203a49f3c3747414b554fc61fa4e46d7b000f0d40c412a0` | 10250179 |
| **Merkle withdrawal** | **User wallet withdraws 0.05 QOR with a 3-element Merkle proof against batch #2 — no sequencer involvement** | `0xaa57f3b235d317dc8d2caf2f2444ff0b27822145042490484dbda2bc8c33fc14` | 10250197 |
| **Double-withdraw (attack demo)** | Same Merkle-proof withdrawal sent again — **REVERTED on-chain** (`ZeroWithdraw`), cumulative cap unchanged | `0x1da16ddeeea2b9fa5f456911b36ed615b20b7b551491f2a94b81a532b177a86d` | 10250203 |
| **Tampered-proof (attack demo)** | Withdrawal with one flipped hex char in the proof — **REVERTED on-chain** (`InvalidMerkleProof`) | `0x35715e361b5289e5d4259ea705a56f58c07f1d993323efce8eb946551a076519` | 10250208 |
| **Forged batch (attack demo)** | Genuine ML-DSA-87 signature over the WRONG digest, submitted by the sequencer itself — **REVERTED on-chain** (`InvalidBatchSignature`), `batchCount` unchanged | `0x2fbb8444db842c419b180dc5b34b64b4b636b2c4b1199faedc025558f6d206f3` | 10250217 |

Final on-chain state (verified by independent read): `batchCount` 3,
`totalDeposited` 0.3 QOR, `totalWithdrawn` 0.05 QOR,
`withdrawnAmount[user]` 50,000 uqor, `deposits[deployer]` 0.3 QOR
(v2 withdrawals do not touch the L1 deposit ledger), contract balance
0.25 QOR. Final rollup balances: deployer 210,000 uqor, user wallet
50,000, `0x1111…1111` 15,000, `0x2222…2222` 10,000, `0x3333…3333`
15,000 (total 300,000 — conserved from the 0.3 QOR deposit).

The rollup balances were operator-seeded from the L1 deposit: the
0.3 QOR deposit was credited into `deployments/state.json` by hand
before the first settle. L1 deposits are NOT auto-credited — a
documented demo gap (see [THREAT_MODEL.md](THREAT_MODEL.md) §4).
The watchtower cross-checks the seeded funding against the contract's
cumulative `totalDeposited`, so the operator cannot invent rollup
funds larger than the L1 deposits backing them.

## How it works

```
User txs ──► mempool (deployments/mempool.json)
                │  npm run sequencer settle
                ▼
Sequencer builds a batch: applies txs to the rollup state, computes the
new Merkle state root + tx-data commitment, seals the batch payload with
ML-KEM-1024, signs the batch digest with ML-DSA-87 (pqcSign)
                │  hybrid-signed EVM tx (needs an open EVM window)
                ▼
QoreRollup.submitBatch: checks the caller is the sequencer, reads the
sequencer's REGISTERED ML-DSA key from pqcKeyStatus (0x0A02), verifies
the signature via pqcVerify (0x0A01), records the batch + receiptHash
                │
                ▼
Watchtower (npm run watchtower) re-verifies every batch off-chain:
signature vs the registered key, state replay, Merkle tree + proofs,
receipt, decrypt check.

Withdrawals (no sequencer): the user reads their leaf + proof from the
published batch file and calls QoreRollup.withdraw(batchId, account,
balance, nonce, proof) themselves. The contract verifies the proof
against the settled Merkle root and pays balance − withdrawnAmount.
```

State root: a Merkle root over the post-batch state — one leaf per
non-zero balance, leaf = `keccak256(account, balance, nonce)`, binary
tree with sorted pairs (OpenZeppelin MerkleProof convention). Each
batch file stores the leaves and every account's proof, so any account
can withdraw with no sequencer help. See
[THREAT_MODEL.md](THREAT_MODEL.md) for the full list of demo-grade
simplifications — including the honest data-availability caveat: if
ALL batch data were withheld, a user could not construct a proof.

## Run it yourself (testnet only)

Prerequisites: Node.js 20+, a funded Diana testnet account in `../.env`
(`QORE_MNEMONIC`, `QORE_EVM_PRIVATE_KEY`, `QORE_EVM_RPC_URL` —
mode 600, outside the repo; see `.env.example`). Never commit real keys.

```sh
npm install
npm run compile
npm test                    # 100 tests (34 contract + 15 merkle + 23 sequencer + 18 watchtower + 10 KEM)
npm run window register     # register the account's ML-DSA-87 key (once)
npm run window open         # open an EVM authorisation window
npm run deploy              # deploy the settlement contract
npm run sequencer keygen    # generate the rollup ML-KEM-1024 data keypair
npm run usage deposit --amount 300000        # deposit 0.3 QOR
# Seed deployments/state.json with the deposit (see THREAT_MODEL.md §4),
# then:
npm run sequencer enqueue --from <0x> --to <0x> --amount <uqor>
npm run sequencer settle    # settle the mempool as one ML-DSA-signed batch
npm run merkle-withdraw -- --batch <id> [--dry-run]   # withdraw with a Merkle proof (uses ../.env.user)
npm run watchtower          # re-verify every settled batch
npm run forged-batch        # attack demo: submit a batch with a forged
                            # ML-DSA-87 signature — must REVERT on-chain
npm run sequencer status    # contract + local state, read-only
```

## Tests

- `npm test` — 100 passing: 34 contract tests (Hardhat, mock
  precompiles installed at 0x0A01/0x0A02 via `hardhat_setCode`,
  including Merkle-proof withdrawals proven with the TypeScript tree
  against the contract) and 66 merkle/sequencer/watchtower/KEM tests
  (Merkle tree + proofs incl. odd leaf counts, state transitions,
  digest formulas, KEM round-trip + tamper detection, watchtower
  detection of tampered batches — bad state root, bad signature,
  tampered txs, tampered leaves/proofs, tampered ciphertext, wrong
  receipt).
- `npm run typecheck` — clean.

## AI usage

Built with AI assistance (Muse Spark) under human direction. See
[AI_USAGE.md](AI_USAGE.md). All on-chain evidence is real Diana
testnet activity; nothing in the usage table is simulated.

## Licence

Apache-2.0
