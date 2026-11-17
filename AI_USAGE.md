# AI Usage — QoreRollup

An honest note on how this entry was built, for the QoreChain Developer
Fest judges.

## What was used

This project was built with **Muse Spark**, an AI coding agent, working
under the direction of the human team (Andi Pangeran, with Ajeng Ayu Kusum
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
- The Hardhat test suites (`test/sequencer.test.ts`,
  `test/watchtower.test.ts`, `test/kem.test.ts`, plus the contract tests).
- The threat model (`THREAT_MODEL.md`) and this note.

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
honestly: no fraud or validity proofs, a hash commitment instead of a
Merkle root, withdrawals checked against the L1 deposit ledger only, a
single centralised sequencer, an advisory-only watchtower that shares its
encoding library with the sequencer, and batch plaintext published
alongside the ciphertext for verification. The AI wrote those sections
itself and stands by them — they are the reason this entry is presented as
a demo, not a production rollup.
