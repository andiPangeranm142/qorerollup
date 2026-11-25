# AI Usage — QoreRollup

An honest note on how this entry was built, for the QoreChain Developer
Fest judges.

## What was used

This project was built with **Muse Spark**, an AI coding agent, working
under the direction of the human team (Andi Pangeran, with Ajeng Ayu Kusuma
as the second team member). The AI wrote code, tests, and documentation;
the human directed the work, set the goals, approved the approach, and
owns the result.

## What the AI wrote

- The off-chain sequencer (`scripts/sequencer.ts`), the watchtower
  (`scripts/watchtower.ts`), the pure batch-math library
  (`src/lib/rollup.ts`), and the ML-KEM-1024 batch sealing module
  (`src/lib/kem.ts`).
- The settlement contract (`contracts/QoreRollup.sol`), its tests, and the
  deploy script (`scripts/deploy.ts`) — built by a second AI agent working
  in the same repo against the same fixed interface.
- The Hardhat test suites (`test/QoreRollup.test.ts`,
  `test/sequencer.test.ts`, `test/watchtower.test.ts`, `test/kem.test.ts`,
  `test/merkle.test.ts`, `test/deposit-watcher.test.ts`,
  `test/deposit-credit.test.ts` — 150 tests total, all passing).
- The threat model (`THREAT_MODEL.md`) and this note.
- Post-launch operations tooling (17–24 Nov 2026): the auto-settle
  script (`scripts/auto-settle.ts`, runs on a schedule and settles
  batches with pending deposits), the watchtower status reporter
  (`scripts/watchtower-status.ts`), the revert demonstrations
  (`scripts/revert-demos.ts` — 6 on-chain revert demonstrations, all
  receipts recorded), the forged-batch negative test
  (`scripts/forged-batch.ts`), and the Merkle withdrawal tooling
  (`scripts/merkle-withdraw.ts`, `scripts/verify-merkle-proof.ts`).
- The v2 Merkle redesign (17 Nov 2026): the state root became a Merkle
  root over (account, balance, nonce) leaves (`src/lib/merkle.ts`),
  withdrawals became Merkle-proof withdrawals with a cumulative
  per-account cap (no sequencer help, no nullifier), the batch files
  gained leaves + proofs, and the watchtower gained Merkle verification
  — replacing the v1 contract, whose history is archived in
  `deployments/v1/`.
- Automatic deposit ingestion (17 Nov 2026): the deposit watcher
  (`scripts/deposit-watcher.ts` + the pure logic in
  `src/lib/deposits.ts`), the sequencer rewire that applies pending
  deposits into each batch's state transition (with a pre-settle
  re-verification of every pending deposit against the on-chain logs),
  the watchtower's deposit credit checks (every credit matched
  against the `Deposited` logs; credited totals checked against
  `totalDeposited` in aggregate and per depositor), and the
  deposit-watcher + deposit-credit test suites (including the
  negative cases: a fake credit and a credit exceeding its
  supporting deposit fail at both levels).

The design follows the patterns of the team's earlier QoreChain projects
(Quantum Vault, SealedBid): the ML-DSA-87 signing flow, the EVM window
handling, and the ML-KEM sealing pattern were adapted from those working
codebases rather than invented from scratch.

## What was verified live on-chain

All on-chain evidence is real testnet activity on the QoreChain Diana
testnet (EVM chain id 9800) — no transaction, hash, or receipt in this
repo was fabricated:

- The settlement contract was deployed to Diana and its address recorded
  in `deployments/testnet.json`.
- Batches were settled by the sequencer with real ML-DSA-87 signatures
  over real batch digests; each settlement's EVM transaction hash,
  Cosmos transaction hash, block number, and receipt hash are recorded in
  `deployments/batches/batch-<id>.json` and in `deployments/usage.json`.
- The watchtower re-verifies those batches against the on-chain records
  and the sequencer's registered ML-DSA-87 public key (fetched from the
  chain, not from a local file).
- The KEM public key in `deployments/kem-public-key.json` is the real
  public key whose secret counterpart sealed the batch payloads.
- The auto-deposit cycle is real testnet activity too: a 0.1 QOR
  deposit (EVM tx `0x3c37b8f32daa3b42090a4a16121be141a2ec33747467f879d8b69028275bd08e`)
  was picked up by the deposit watcher, credited by batch #3
  (`0xb0d9842996e735efe3d842fae71309625bd75ceab8c61628224c0f12e560391c`),
  and the deployer withdrew 0.3 QOR against batch #3 with a Merkle
  proof (`0x926d52875bffc10bc5ad3577f740b4e41641c34444972092241521363d0a6a91`).
- The fresh-account test is real testnet activity too: a fresh wallet
  deposited 0.05 QOR (EVM tx `0xba8dbf221d8db7c4045d67e58df1470a041a0b396bd77811692223befde6592b`),
  the deposit watcher picked it up, batch #4 credited it
  (`0x3dc38a1ca1a71b8bb86325b19ce65eee7a1a33df073a700dc30aa431737b56c9`),
  and the fresh account withdrew the full 0.05 QOR against batch #4
  with a Merkle proof
  (`0x231d3a550bc5ecdf5e9ff5a52cf7877d6712619a3b5ed81a55db8d8965b17798`).
  The test followed OUTSIDER_TEST.md end to end but was run by the
  builder — it is a fresh-account test, not an independent outsider
  test.
- Since then the rollup has grown to 8 settled batches (batch-0 …
  batch-7), 6 deposits totalling 0.60 QOR, and 6 Merkle-proof
  withdrawals totalling 0.55 QOR — all recorded in
  `deployments/usage.json` (8 `settle` steps, 6 `deposit` steps, 6
  `merkle-withdraw` steps) and in the per-batch files under
  `deployments/batches/`. The watchtower re-verifies all 8 batches on a
  schedule (8/8 OK — see `deployments/watchtower-status.json`), and the
  deposit watcher has run 400+ ingestion cycles, each recorded as a
  `deposit-watcher` step in `deployments/usage.json` (count them there
  for the live total — the count grows with every run).

Anyone can re-verify the evidence: the batch files contain everything
needed to recompute the commitments, replay the state transitions, and
check the signatures (`npm run watchtower`), and the transaction hashes
resolve on the Diana explorer.

## What the AI did not do

- The AI did not decide to enter the fest, choose the category, or set the
  goals — those were the human team's decisions.
- The AI did not hold or move any real funds. All activity is on the Diana
  testnet with testnet QOR.
- The AI did not fabricate test results: the test suites run against real
  crypto (genuine ML-DSA-87 keypairs sign the digests in the watchtower
  fixtures; genuine ML-KEM-1024 keypairs seal the payloads), and the
  reported counts are the counts the test runner prints.

## Limits the AI is aware of

The threat model (`THREAT_MODEL.md`) documents the demo-grade gaps
honestly: no fraud or validity proofs, a single centralised sequencer,
an advisory-only watchtower that shares its encoding libraries with the
sequencer, batch plaintext published alongside the ciphertext for
verification, and withdrawals that depend on published batch data to
construct a proof. (Two v1 gaps are closed in v2: the state root is now
a Merkle root with inclusion proofs, and withdrawals are proven against
the rollup state instead of the L1 deposit ledger alone. A third gap
closed after v2: L1 deposits are now auto-credited by the deposit
watcher instead of hand-seeded — the one hand-credited exception is
the 0.3 QOR genesis deposit, recorded as such.) The AI wrote
those sections itself and stands by them — they are the reason this
entry is presented as a demo, not a production rollup.
