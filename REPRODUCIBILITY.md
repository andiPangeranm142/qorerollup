# Reproducibility

Anyone can reproduce QoreRollup's test suite and its full on-chain
verification from a fresh clone, with **no secrets and no keys**. This
file documents the exact commands and the results of the run performed
on 18 Nov 2026 (repo at `b22e930`, Node v24.22.1, npm 10.9.4).

## Commands

```sh
git clone https://github.com/andiPangeranm142/qorerollup.git
cd qorerollup
npm ci            # 1,261 packages, no secrets needed
npm test          # full Hardhat suite
npm run watchtower                    # re-verify all settled batches on-chain
npm run verify-merkle-proof -- --batch 5   # verify the published Merkle proofs for one batch
npm run typecheck # both tsconfig projects
```

Notes:

- The watchtower reads the compiled contract artifact
  (`artifacts/contracts/QoreRollup.sol/QoreRollup.json`), which is
  gitignored. `npm test` compiles it as part of the run, so after the
  tests `npm run compile` is a no-op; if you skip the tests, run
  `npm run compile` before the watchtower.
- The first clean-clone run (at `c08b600`) caught a real bug:
  `npm run watchtower` loaded `../.env` (the operator's secrets file)
  via `tsx --env-file`, so the documented command failed in a clean
  clone with `node: ../.env: not found` — even though the watchtower
  itself reads no secrets (only an optional `QORE_EVM_RPC_URL`
  override, defaulting to `https://evm-testnet.qore.host`). Fixed in
  `b22e930`: the script now runs without the env file, and the run
  below is the re-run at `b22e930` with the fix in place.
- The watchtower appends each run to
  `deployments/watchtower-log.json` — in your clone this shows up as a
  modified file. That is expected: the log is the audit trail, not a
  build artifact.

## Results (18 Nov 2026)

| Check | Result |
| --- | --- |
| `npm ci` | ✅ 1,261 packages installed |
| `npm test` | ✅ **150 passing** (3 s) |
| `npm run compile` | ✅ no-op — tests had already compiled |
| `npm run watchtower` | ✅ **ALL BATCHES OK** — batches #0–#7, 8/8 (ML-DSA-87 signatures against the registered on-chain key, state replay, Merkle trees and proofs, receipt hashes, deposit cross-checks: 5 claimed deposits matched against 6 on-chain `Deposited` events, 6 credited deposits totalling 600,000 uqor within `totalDeposited`) |
| `npm run verify-merkle-proof -- --batch 5` | ✅ **7/7 stored proofs verify** against the batch file's stateRoot (leaf hashes recomputed from account/balance/nonce); file stateRoot `0x306910379013d19f4e39ba399c156c9899511ae95bb8be7880f98b82261d991a` equals the settled on-chain root from `getBatch(5)` |
| `npm run typecheck` | ✅ clean (both `tsconfig.json` and `tsconfig.app.json`) |

## What is SKIPPED in a clean clone, and why

One check cannot run without secrets, and it skips honestly instead of
failing:

- **ML-KEM decrypt check — SKIPPED.** The watchtower prints
  `decrypt check SKIPPED (key file not found)` because the operator's
  ML-KEM-1024 secret key lives in `../kem-key.json`, outside the repo
  (mode 600, never committed). Without it, the watchtower cannot
  decrypt the sealed batch blobs to confirm they match the batch
  files — so that one sub-check is skipped and every other check still
  runs. The operator's own runs (with the key present) include the
  decrypt check; see
  [deployments/watchtower-log.json](deployments/watchtower-log.json),
  where each run records whether the check was `enabled` or `skipped
  (no KEM key)`.

Everything else — tests, signatures, state replay, Merkle proofs,
receipts, deposit ledger checks — passes with no secrets at all.

## What a clean clone CANNOT do

Sending transactions needs keys, so these stay operator-only and are
not part of this reproduction: deploying, running the sequencer,
depositing, withdrawing (`npm run merkle-withdraw`, including
`--dry-run`, loads a private key), and opening EVM authorisation
windows. The read-only checks above are the complete verification
surface for an outsider: they prove the settled batches are what the
published batch files claim, without trusting the operator.
