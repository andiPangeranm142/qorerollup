# QoreRollup

A minimal post-quantum rollup on QoreChain — a Protocol Builders entry
for the QoreChain Developer Fest ("Build Before Q-Day").

**Status:** live on the Diana testnet. Settlement contract deployed,
3 batches settled with ML-DSA-87 signatures verified on-chain, 1
withdrawal completed, watchtower verifying all batches clean.

- Project page: https://build.qorechain.io/p/qorerollup
- Demo site: in progress (GitHub Pages)
- Demo video: in progress (≤3 min, silent)

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
  key from the `pqcKeyStatus` precompile) and records the batch state
  root, issuing a **verified settlement receipt**.
- **Withdrawals** move funds from the rollup back to the Diana testnet.
- A **watchtower** re-verifies every batch (signature, state replay,
  receipt, decrypt check) and flags invalid ones.
- Batch payloads are sealed with **ML-KEM-1024** (+ AES-256-GCM);
  the on-chain commitment is to the ciphertext.
- A **threat model** ([THREAT_MODEL.md](THREAT_MODEL.md)) documents the
  attack surface and mitigations — including what is demo-grade.

## Category requirements (Protocol Builders)

- [x] ML-DSA-signed batches — every settled batch carries a 4,627-byte
  ML-DSA-87 signature, verified on-chain via `pqcVerify`.
- [x] Withdrawal — 0.1 QOR withdrawn on-chain (see Live usage).
- [x] Verified settlement receipt — each batch gets a `receiptHash`
  (`keccak256("QoreRollup.receipt", chainid, contract, batchId,
  stateRoot, txDataCommitment)`), emitted in `BatchSettled` and
  re-verified by the watchtower.
- [x] Watchtower — `npm run watchtower` verifies all 3 batches OK
  (signature, state replay, receipt, decrypt check, genesis-funding
  cross-check). Tampered batches are detected (see tests) — and
  demonstrated live: flipping one hex char in a batch file's claimed
  state root made the watchtower FAIL that batch on three independent
  checks (file vs on-chain root, replayed root, decrypted payload) and
  FAIL the next batch on the broken chain; restoring the file returned
  ALL BATCHES OK. Every run is appended to the verification log
  ([deployments/watchtower-log.json](deployments/watchtower-log.json)).
- [x] ML-KEM data protection — batch payloads sealed with ML-KEM-1024
  + AES-256-GCM; public key in
  [deployments/kem-public-key.json](deployments/kem-public-key.json),
  secret key held by the operator outside the repo.
- [x] Threat model — [THREAT_MODEL.md](THREAT_MODEL.md).

## Live deployment (Diana testnet, chain id 9800)

- **Settlement contract:** `0x96051b69a7d0e2236a3fe2e51fe33a55367d36c2`
  ([explorer](https://explore.qore.network/address/0x96051b69a7d0e2236a3fe2e51fe33a55367d36c2) — switch to Testnet)
- **Deployer = sequencer:** `0x0140a056ee37D5240b0397eCdF1347Da80E33b9f`
  (`qor1q9q2q4hwxl2jgzcrjlkd7y68m2qwxwul0nheda`)
- **Deploy tx:** `0xa2b176083386339f9f45d5faf6e11ebb272317b835e4a1a7524089b25c863636`
  (Cosmos `D6B800EC3273750ACE8D67532E0AAA39C3FCFFD7B51C81E4D3272052CBBED6D7`,
  block 10249119). Bytecode: 3,399 bytes.
- **ML-KEM-1024 data key:** public key hash
  `0xf2ef384e0592c94dbc9b70b175eb8731432bdf0040581aac3d24797bbf8bf862`
  (see [deployments/kem-public-key.json](deployments/kem-public-key.json)).

## Live usage (17 Nov 2026, all on Diana)

Full step log with hashes: [deployments/usage.json](deployments/usage.json).
Per-batch detail (txs, state roots, signatures, ciphertexts):
[deployments/batches/](deployments/batches/).

| Step | Detail | EVM tx | Block |
| --- | --- | --- | --- |
| Deposit | 0.3 QOR into the rollup | `0x642e0266e5ed3855894dac385ed0c6fc34497bfe4f173fad13d46b5d3b2ff8a5` | 10249360 |
| Batch #0 | 1 tx: deployer → `0x1111…1111`, 50,000 uqor | `0xe2549fb69a248c272a5bda0b5b80612f21c0288f7aa08681562a7ada27318564` | 10249377 |
| Batch #1 | 2 txs: deployer → `0x2222…2222` 25,000; `0x1111…1111` → `0x2222…2222` 10,000 uqor | `0x6b22abf3260b0b7c0e6467da30bf1decdb0d67627c57512e721bad18cb3ddf56` | 10249387 |
| Batch #2 | 1 tx: deployer → `0x3333…3333`, 15,000 uqor | `0x4a0958c3ad17f1c07d899292893758fb3af2f70d8f92b063315efdc4d6040f3b` | 10249393 |
| Withdraw | 0.1 QOR back to the deployer | `0x6ccceb8ce8179ea0a7254342f5e9cb5ddcdbe3c50e688193cb8e07d687a3460f` | 10249398 |
| **Forged batch (attack demo)** | Genuine ML-DSA-87 signature over the WRONG digest, submitted by the sequencer itself — **REVERTED on-chain** (`InvalidBatchSignature`), `batchCount` unchanged | `0xd512dc8aa512be382fab98cc84d45809121a58a440dafee3b7a90eadd3a93a8b` | 10249558 |

Final on-chain state (verified by independent read): `batchCount` 3,
`totalDeposited` 0.3 QOR, `totalWithdrawn` 0.1 QOR, deployer deposit
0.2 QOR. Final rollup balances: deployer 210,000 uqor, `0x1111…1111`
40,000, `0x2222…2222` 35,000, `0x3333…3333` 15,000 (total 300,000 —
conserved from the 0.3 QOR deposit).

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
new state root + tx-data commitment, seals the batch payload with
ML-KEM-1024, signs the batch digest with ML-DSA-87 (pqcSign)
                │  hybrid-signed EVM tx (needs an open EVM window)
                ▼
QoreRollup.settleBatch: checks the caller is the sequencer, reads the
sequencer's REGISTERED ML-DSA key from pqcKeyStatus (0x0A02), verifies
the signature via pqcVerify (0x0A01), records the batch + receiptHash
                │
                ▼
Watchtower (npm run watchtower) re-verifies every batch off-chain:
signature vs the registered key, state replay, receipt, decrypt check.
```

State root: a hash commitment over the sorted set of non-zero
balances — `keccak256(prevStateRoot, (address, balance)...)` — NOT a
Merkle root (no inclusion proofs). See [THREAT_MODEL.md](THREAT_MODEL.md)
for the full list of demo-grade simplifications.

## Run it yourself (testnet only)

Prerequisites: Node.js 20+, a funded Diana testnet account in `../.env`
(`QORE_MNEMONIC`, `QORE_EVM_PRIVATE_KEY`, `QORE_EVM_RPC_URL` —
mode 600, outside the repo; see `.env.example`). Never commit real keys.

```sh
npm install
npm run compile
npm test                    # 73 tests (30 contract + 43 sequencer/watchtower/KEM)
npm run window register     # register the account's ML-DSA-87 key (once)
npm run window open         # open an EVM authorisation window
npm run deploy              # deploy the settlement contract
npm run sequencer keygen    # generate the rollup ML-KEM-1024 data keypair
npm run usage deposit --amount 300000        # deposit 0.3 QOR
# Seed deployments/state.json with the deposit (see THREAT_MODEL.md §4),
# then:
npm run sequencer enqueue --from <0x> --to <0x> --amount <uqor>
npm run sequencer settle    # settle the mempool as one ML-DSA-signed batch
npm run usage withdraw --amount 100000       # withdraw 0.1 QOR
npm run watchtower          # re-verify every settled batch
npm run forged-batch        # attack demo: submit a batch with a forged
                            # ML-DSA-87 signature — must REVERT on-chain
npm run sequencer status    # contract + local state, read-only
```

## Tests

- `npm test` — 73 passing: 30 contract tests (Hardhat, mock
  precompiles installed at 0x0A01/0x0A02 via `hardhat_setCode`) and 43
  sequencer/watchtower/KEM tests (state transitions, digest formulas,
  KEM round-trip + tamper detection, watchtower detection of tampered
  batches — bad state root, bad signature, tampered txs, tampered
  ciphertext, wrong receipt).
- `npm run typecheck` — clean.

## AI usage

Built with AI assistance (Muse Spark) under human direction. See
[AI_USAGE.md](AI_USAGE.md). All on-chain evidence is real Diana
testnet activity; nothing in the usage table is simulated.

## Licence

Apache-2.0
