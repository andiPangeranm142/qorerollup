# QoreRollup — Threat Model

An honest account of what QoreRollup protects, what it assumes, and where it
is demo-grade rather than production-grade. Written for the QoreChain
Developer Fest (Protocol Builders category). Nothing in this document is a
claim of production security.

## 1. System overview

An off-chain sequencer collects transactions into batches, seals each batch
payload with ML-KEM-1024, signs the batch digest with ML-DSA-87, and settles
it on the QoreRollup contract on the QoreChain Diana testnet. The contract
verifies the ML-DSA-87 signature via the `pqcVerify` precompile against the
sequencer's registered key and records the batch's Merkle state root (one
leaf per non-zero balance), the tx-data commitment, the encrypted-data hash,
and a settlement receipt hash. Users deposit QOR into the contract and
withdraw by proving their leaf against a settled batch root — directly,
with no sequencer help. A watchtower re-verifies every settled batch
off-chain, including every leaf's Merkle proof.

Trust boundaries:

- **On-chain (trusted):** the QoreRollup contract, the `pqcVerify`
  precompile, the PQC key registry, the EVM authorisation-window mechanism,
  and the Diana chain itself.
- **Off-chain, operator-run (trusted by necessity):** the sequencer, its
  state files (`deployments/state.json`, `deployments/batches/`,
  `deployments/mempool.json`), and the watchtower.
- **Public data:** batch files (including plaintext transactions), the KEM
  public key, and all on-chain records.

## 2. Assets

| Asset | Where it lives | What loss means |
|---|---|---|
| Deposited QOR | QoreRollup contract (`deposits`, `totalDeposited`) | Direct loss of user funds if withdrawal logic is wrong |
| Withdrawal caps | QoreRollup contract (`withdrawnAmount` per account) | A wrong cap lets an account withdraw more than its largest proven leaf balance |
| Batch integrity (state roots, commitments, leaves) | On-chain batch records + off-chain batch files | A false state root becomes the "truth" for the rollup — and its leaves become withdrawable |
| Sequencer ML-DSA-87 key | Derived from the sequencer mnemonic (`../.env`, mode 600) | Whoever holds it can settle arbitrary batches |
| Sequencer EVM key | `../.env` (mode 600) | Whoever holds it can submit batches and drain the sequencer's own deposits |
| KEM secret key | `../kem-key.json` (mode 600, outside the repo) | Whoever holds it can decrypt sealed batch payloads |
| Rollup state files | `deployments/state.json`, `deployments/batches/` | Corruption or loss breaks the sequencer/watchtower chain of verification |

## 3. Trust assumptions

1. **Single centralised sequencer.** There is exactly one sequencer, run by
   the operator. It chooses transaction order, builds batches, and holds the
   signing key. There is no decentralisation, no leader rotation, and no
   forced-inclusion mechanism: if the sequencer censors a transaction, that
   transaction never settles. This is the largest single trust assumption.
   What the sequencer CANNOT do is block a withdrawal: once a batch is
   settled, any account withdraws by proving its leaf against the settled
   root directly — the sequencer is not in the withdrawal path at all.
   (But see §4.11: a user still needs the batch DATA to construct a proof.)
2. **Chain-enforced EVM windows.** Every EVM transaction from the sequencer
   requires a registered ML-DSA-87 key and a live authorisation window. The
   sequencer never opens a window itself — the operator does, deliberately —
   so a compromised sequencer process alone cannot spend without a window
   already being open.
3. **Precompile correctness.** The `pqcVerify` precompile correctly verifies
   ML-DSA-87 signatures against the registered key, and the PQC key registry
   returns the key that was actually registered. If either is wrong, the
   on-chain signature check is meaningless.
4. **Operator key hygiene.** The mnemonic, the EVM private key, and the KEM
   secret key live in mode-600 files outside the repo and are never printed,
   committed, or shared. A leak of any of them is out of scope for the code
   to prevent.
5. **Honest chain data for the watchtower.** The watchtower reads batch
   records and the registered PQC key from the chain and treats them as
   ground truth.

## 4. Attack surface and mitigations

### 4.1 Sequencer key compromise

- **Attack:** an attacker obtains the sequencer mnemonic (or EVM key) and
  settles batches with arbitrary state roots, stealing the rollup's notion
  of balances.
- **Mitigations in place:** keys live outside the repo in mode-600 files;
  scripts never print them; `settle` refuses to run unless the derived
  account is exactly the expected sequencer address (a wrong `.env` fails
  loudly instead of signing with a stranger's key); settlement still needs
  a live EVM window, which the sequencer cannot open itself.
- **Residual risk:** with the key AND an open window, the attacker can
  settle anything. There is no multisig, no timelock, and no fraud-proof
  challenge period. (Demo-grade — see §5.)

### 4.2 Malicious or buggy sequencer settling a false state root

- **Attack:** the sequencer settles a state root that does not follow from
  the batch's transactions (e.g. crediting itself funds).
- **Mitigations in place:** the contract verifies the ML-DSA-87 signature,
  which binds the state root, the tx commitment, and the encrypted-data
  hash together — a settled root cannot later be swapped for another
  without a new signature. The watchtower replays every batch's state
  transition from the previous batch's balances, recomputes the Merkle
  root from the batch file's leaves, and verifies every leaf's proof —
  flagging any root that does not follow from the transactions. Batch
  files publish the plaintext transactions, the leaves and the proofs,
  so anyone can replay them.
- **Residual risk:** the watchtower is advisory only — it cannot halt
  settlement, revert a batch, or slash the sequencer. Detection is not
  prevention. And the watchtower shares the `rollup.ts`/`merkle.ts`
  encoding libraries with the sequencer, so a bug in those libraries
  would be invisible to the watchtower (both sides would compute the
  same wrong answer). Worse, in v2 a false root has a direct payout:
  leaves under a false root are withdrawable, so a compromised
  sequencer key can mint rollup balances and drain the contract's
  deposits before anyone reacts. The only defences are the key hygiene
  in §3.4, the window requirement in §3.2, and the watchtower alarm.
- **What the sequencer cannot do:** block withdrawals. Withdrawal needs
  no sequencer cooperation — the user calls `withdraw` with a proof
  built from the published batch file. A sequencer that goes offline or
  turns hostile after a batch settles cannot stop the users of that
  batch from withdrawing. (It CAN stop settling new batches, freezing
  later balances — see §3.1 — and it can withhold the batch data
  needed to build a proof — see §4.11.)

### 4.3 Transaction replay / reordering / censorship

- **Replay:** each transaction carries a per-account nonce starting at 0,
  enforced in `applyTxs` and persisted in `state.json`. A replayed tx has
  a stale nonce and the batch build fails. Nonces are also bound into the
  tx encoding, so a tx cannot be rebound to a different nonce without
  changing the commitment.
- **Reordering within a batch:** the commitment is over the ordered
  concatenation of encodings, so any reordering changes the commitment and
  invalidates the signature. (Ordering *across* batches is the sequencer's
  choice — see §3.1.)
- **Censorship:** unmitigated by design (single sequencer, no forced
  inclusion). Users can see their tx missing from the published batch
  files, but cannot force it in.
- **Cross-chain replay:** the batch digest binds the EVM chain id and the
  contract address, so a signature for Diana cannot be replayed on another
  chain or another deployment.

### 4.4 Withdrawal abuse

- **Attack:** withdraw more than the rollup balance, withdraw the same
  balance twice (against the same batch or across several batches), or
  withdraw someone else's balance.
- **Mitigations in place (v2):** `withdraw` requires `msg.sender ==
  account` (only the account owner withdraws its own funds); it
  verifies the caller's Merkle proof against the settled batch's state
  root on-chain (sorted-pair rule, the same fold as
  `src/lib/merkle.ts`); and it pays `balance -
  withdrawnAmount[account]`, then sets `withdrawnAmount[account] =
  balance`. The cumulative cap means the total ever withdrawn by an
  account can never exceed the largest leaf balance it has ever
  proven: the same leaf twice pays zero the second time, and a later
  batch with a higher balance pays only the difference. A lower
  balance later pays nothing. The cap is updated before the external
  call (checks-effects-interactions), so reentrancy cannot
  double-spend. The nonce is part of the leaf, so a leaf proves
  (balance, nonce) together.
- **Evidence (on-chain, not just in tests):** on 17 Nov 2026 an
  independent user wallet withdrew 50,000 uqor (0.05 QOR) against
  batch #2 with a 3-element Merkle proof (EVM tx
  `0xaa57f3b235d317dc8d2caf2f2444ff0b27822145042490484dbda2bc8c33fc14`,
  block 10250197). The identical call sent again was included and
  REVERTED (`ZeroWithdraw`, EVM tx
  `0x1da16ddeeea2b9fa5f456911b36ed615b20b7b551491f2a94b81a532b177a86d`,
  block 10250203), and a call with one flipped hex char in the proof
  was included and REVERTED (`InvalidMerkleProof`, EVM tx
  `0x35715e361b5289e5d4259ea705a56f58c07f1d993323efce8eb946551a076519`,
  block 10250208); `withdrawnAmount` stayed 50,000 uqor through both.
  A second withdrawal closed the auto-deposit cycle the same day:
  the deployer withdrew 300,000 uqor (0.3 QOR) against batch #3 with
  a 3-element Merkle proof (EVM tx
  `0x926d52875bffc10bc5ad3577f740b4e41641c34444972092241521363d0a6a91`,
  block 10253087) — its full leaf balance, which includes the
  auto-credited 0.1 QOR deposit (see §4.13).
  Reproduce with `npm run merkle-withdraw -- --batch 2 --expect-revert`
  (and `--tamper-proof`). The same rejections are covered in the
  Hardhat tests (wrong proof, wrong balance/nonce, wrong sender,
  double withdrawal, lower later balance, unknown batch).
- **Residual risk:** the withdrawal proof is only as honest as the
  settled root: a false root (see §4.2) makes false leaves
  withdrawable, and there is no challenge period. Withdrawals also do
  NOT burn rollup balances and do NOT consult the L1 `deposits`
  ledger — the contract pays out of its balance against the proven
  rollup balance, so the rollup balance set and the L1 deposit ledger
  are two books that are never reconciled ON-chain. They ARE
  reconciled off-chain: deposits flow into the rollup only from L1
  `Deposited` events (see §4.13), and the watchtower checks every
  credit against the logs and the credited total against cumulative
  `totalDeposited` — so the operator cannot invent rollup funds
  larger than the L1 deposits backing them. A user whose leaf is in
  a batch whose data was withheld cannot construct a proof at all
  (see §4.11).

### 4.5 KEM key compromise / batch data exposure

- **Attack:** an attacker obtains the KEM secret key and decrypts sealed
  batch payloads, learning transaction contents.
- **Mitigations in place:** the secret key lives outside the repo
  (mode 600); the public key file is the only KEM material committed;
  `keygen` refuses to overwrite existing keys (no silent rotation that
  could orphan old batches or swap in an attacker's key).
- **Residual risk:** a single KEM key is held by the operator — no key
  rotation schedule, no threshold decryption, no forward secrecy across
  batches. Worse, in this demo the protection is largely illustrative:
  the batch plaintext is published in `deployments/batches/` alongside
  the ciphertext so the watchtower (and anyone else) can verify the batch.
  The on-chain commitment is genuinely to the ciphertext, and the
  encryption itself is real (ML-KEM-1024 + AES-256-GCM, tested with
  tamper detection), but the plaintext is not actually hidden from anyone
  who can read the repo. This is a deliberate transparency trade-off for a
  demo and a judging artefact — it is NOT a confidentiality design.
  (See §5.)

### 4.6 State-file tampering / loss

- **Attack:** `state.json`, `deposits.json`, or a batch file is edited
  (or deleted), so the sequencer builds on a false history or the
  watchtower cannot verify.
- **Mitigations in place:** `settle` refuses to run when the local batch
  count disagrees with the on-chain `batchCount`, so a reset or rolled-back
  `state.json` fails loudly instead of settling a duplicate batch id. The
  watchtower replays the whole chain from genesis, so an edited batch file
  fails against the on-chain record (commitment, state root, Merkle leaves
  and proofs, digest, signature, receipt — any of them). A missing batch file is reported as a
  FAIL and stops the chained verification. Batch 0's pre-state — the
  operator-seeded genesis funding — is cross-checked against the chain:
  the watchtower fails the batch if the seeded funding exceeds the
  contract's cumulative `totalDeposited`, so the operator cannot invent
  rollup funds larger than the L1 deposits backing them. A tampered
  `deposits.json` is caught twice: the sequencer re-verifies every
  pending deposit against the on-chain `Deposited` logs before
  settling (a fake credit, or an amount larger than its L1 deposit,
  refuses to settle), and the watchtower re-checks every
  settled/genesis record the same way (see §4.13).
- **Residual risk:** the files are local and unprotected — there is no
  signed checkpoint or backup. Losing `state.json` loses the rollup's
  balance history (recoverable only by replaying all batch files from
  genesis, which the watchtower's chaining logic effectively does).

### 4.7 Mempool manipulation

- **Attack:** a tx is inserted into, removed from, or edited in
  `mempool.json` before settlement.
- **Mitigations in place:** there is no public mempool API — the file is
  local to the operator's machine, and `enqueue` validates addresses and
  amounts and assigns nonces from the settled state plus pending txs. A
  tampered mempool still has to pass `applyTxs` (balances, nonces) at
  settle time, and the settled batch is published for anyone to audit.
- **Residual risk:** anyone with write access to the operator's machine
  can already do worse (steal the keys). No per-tx user signatures exist:
  transactions in the mempool are not signed by their senders, so the
  sequencer can invent transactions from any account that holds a rollup
  balance. User-signed rollup transactions are a production requirement
  this demo does not have.

### 4.8 Dependency / supply-chain risk

- The crypto comes from audited libraries (`@noble/post-quantum` for
  ML-KEM, `@qorechain/sdk` for ML-DSA-87) rather than hand-rolled
  implementations. The digest formulas are pinned by tests against
  independently recomputed values. No dependency is fetched at runtime.

### 4.9 Denial of service

- A huge mempool makes `settle` build one enormous batch (there is no
  batch-size cap). The settlement transaction itself is small (only
  hashes and a signature go on-chain), so the on-chain cost stays bounded,
  but the off-chain sealing and replay work grows with the batch. No rate
  limiting exists because there is no public intake.

### 4.10 Forged batch signature (attacker without the sequencer key)

- **Attack:** anyone — a stranger, a compromised dependency, a second
  operator — submits a batch with a fake ML-DSA-87 signature, hoping the
  contract accepts it and records an attacker-chosen state root.
- **Mitigations in place:** `submitBatch` verifies the signature on-chain
  via the `pqcVerify` precompile (0x0A01) against the sequencer's
  REGISTERED public key, fetched live from the `pqcKeyStatus` precompile
  (0x0A02) — never a caller-supplied key, so an attacker cannot substitute
  their own keypair. The signed digest binds the batch id, the state root,
  the tx commitment, the encrypted-data hash, the chain id and the
  contract address, so a signature for any other batch (or chain, or
  contract) does not verify for this one. Only the sequencer address may
  call `submitBatch` at all, so a stranger's transaction fails even
  before the signature check.
- **Evidence (on-chain, not just in tests):** on 17 Nov 2026 a batch was
  submitted from the sequencer's own account carrying a genuine ML-DSA-87
  signature over a DIFFERENT digest (batch id 999) — the strongest form
  of this attack short of stealing the key, since the sender and the
  signature were both legitimate and only the message was wrong. The
  transaction was included on Diana and REVERTED (`InvalidBatchSignature`,
  EVM tx `0x2fbb8444db842c419b180dc5b34b64b4b636b2c4b1199faedc025558f6d206f3`,
  block 10250217); `batchCount` did not move and no batch was recorded.
  (The same demo was run against the superseded v1 contract earlier the
  same day: EVM tx
  `0xd512dc8aa512be382fab98cc84d45809121a58a440dafee3b7a90eadd3a93a8b`,
  block 10249558 — see `deployments/v1/`.)
  Reproduce with `npm run forged-batch`. The same rejection is also
  covered in the Hardhat tests (invalid / never-allowed / wrong-pubkey /
  wrong-digest signatures).
- **Residual risk:** the defence rests on the precompiles answering
  correctly and on ML-DSA-87 itself. A break in either would void every
  signature check at once — that is the shared assumption of the whole
  QoreChain post-quantum design, not something this project can mitigate
  alone. (See §3.)

### 4.11 Withheld batch data (data-availability failure)

- **Attack:** the sequencer settles a batch on-chain but withholds the
  batch contents — the transactions, the plaintext payload, or the
  ciphertext — so nobody can recompute the state transition or check
  what the state root actually commits to. A settled root nobody can
  audit is a blank cheque for the sequencer. In v2 this has a second,
  sharper edge: **a user whose balance is in a withheld batch cannot
  construct the Merkle proof needed to withdraw**. The sequencer cannot
  block a withdrawal directly (see §4.2), but withholding ALL batch
  data achieves the same result indirectly — the funds are locked in
  the contract with no way to prove ownership of them. Stated plainly:
  v2's "no sequencer help" withdrawal assumes the batch data is
  public.
- **Mitigations in place:** the settlement transaction commits on-chain
  to the tx-data commitment AND to the encrypted-data hash
  (`keccak256(kemCiphertext || sealedBlob)`), so the sequencer cannot
  later present different data for a settled batch without the hashes
  mismatching. The batch files (`deployments/batches/batch-<id>.json`)
  publish the full plaintext transactions, the Merkle leaves and
  proofs, the ciphertext and the sealed blob, and the watchtower
  verifies the published data against the on-chain commitments on
  every run — a missing batch file is a FAIL that stops the chained
  verification, and a file whose data does not reproduce the on-chain
  hashes fails loudly. The batch files live in this PUBLIC repo, so
  anyone who has ever fetched them holds a copy of the data a
  withdrawal needs — the sequencer cannot retroactively un-publish
  them.
- **Residual risk (demo-grade):** the publication channel is a Git repo
  on the operator's machine — there is no DA layer, no DA committee, no
  on-chain calldata or blobs, and no deadline by which data must appear.
  If the operator settles a batch and never publishes its file, the
  watchtower reports the batch as unverifiable, but nothing forces
  publication and nothing rolls the batch back. The watchtower can only
  sound the alarm; it cannot produce data it was never given. A
  production rollup would need a real DA layer (see §5).

### 4.12 Dead watchtower (verification liveness)

- **Attack / failure:** the watchtower stops running — the operator
  forgets it, the machine dies, the script crashes on a malformed file —
  and batches keep settling with nobody checking them. A silent
  watchtower is worse than a loud one: an attacker who can also silence
  the alarm can settle a false batch unnoticed.
- **Mitigations in place:** settlement does not depend on the watchtower
  at all (it is read-only and advisory), so a dead watchtower never halts
  the rollup — but equally, a dead watchtower never blocks a bad batch.
  What exists: every run appends to the verification log
  (`deployments/watchtower-log.json`), so a gap in the log's timestamps
  is itself evidence the watchtower has not run; anyone with the repo and
  a Diana RPC endpoint can run `npm run watchtower` themselves — the
  checks need no secrets except the optional decrypt check (which skips
  cleanly without the KEM key); and the batch files plus the on-chain
  record are sufficient input for an independent re-implementation of
  the checks.
- **Residual risk (demo-grade):** there is no alerting, no schedule, no
  second watchtower instance, and no on-chain heartbeat — if the operator
  stops running it, nothing complains. The verification log records runs
  that happened; it cannot record runs that did not. A production
  deployment would run multiple independent watchtowers with alerting
  and an on-chain fraud-proof path so a detection has consequences.

### 4.13 Deposit ingestion (auto-credit)

- **Attack:** the operator (or anyone who can edit the operator's
  files) credits rollup balances that no L1 deposit backs — inventing
  funds out of thin air — or credits the same deposit twice, or
  credits a deposit for more than its L1 amount. In v2 a false credit
  has a direct payout: the credited balance is withdrawable against
  the next settled root.
- **How it works (the real state, since 17 Nov 2026):** deposits flow
  automatically. The deposit watcher (`scripts/deposit-watcher.ts`,
  `npm run deposit-watcher`) reads `Deposited` events from the
  settlement contract from a persisted last-processed block and
  records them in `deployments/deposits.json`, identified by
  (transaction hash, log index). The sequencer applies the pending
  ones into the next batch's state transition — deposits first, then
  the mempool txs — and the batch file records them, so the credit is
  part of the batch the watchtower replays. The 0.3 QOR genesis
  deposit is the one hand-credited exception: it was credited before
  batch #0, before the watcher existed, and is recorded with status
  "genesis" so the watcher never credits it twice. No manual seeding
  exists in the live path: `settle` refuses to run without
  `deposits.json`.
- **Mitigations in place:** idempotency — a deposit already in
  `deposits.json` is never credited again, however often the watcher
  re-scans (proven live: rewinding the watcher's last-processed block
  and re-running found the 0.1 QOR deposit "already known" and
  credited nothing). Pre-settle verification — the sequencer
  re-verifies every pending deposit against the on-chain logs before
  crediting it, so a tampered `deposits.json` refuses to settle
  (demonstrated: a fake pending deposit made a dry-run settle refuse
  with "no Deposited event on-chain (fake credit)"). Post-settlement
  verification — the watchtower's checks (e) and (f) match every
  batch claim and every settled/genesis ledger record against the
  on-chain logs, check the credited total against `totalDeposited`
  in aggregate and per depositor, and check the ledger against the
  batch files; a credit larger than its supporting L1 deposit fails
  the run (demonstrated: inflating batch #3's claimed deposit by
  1 uqor failed with "the credit EXCEEDS its deposit"). The watcher
  itself refuses to write its file when the credited total exceeds
  `totalDeposited`. Non-whole-uqor deposits are recorded as
  `skipped`, never rounded — the funds stay in the contract.
- **Evidence (on-chain, not just in tests):** on 17 Nov 2026 the
  deployer deposited 0.1 QOR (EVM tx
  `0x3c37b8f32daa3b42090a4a16121be141a2ec33747467f879d8b69028275bd08e`,
  block 10252674), the watcher picked it up as pending, batch #3
  credited it and settled (EVM tx
  `0xb0d9842996e735efe3d842fae71309625bd75ceab8c61628224c0f12e560391c`,
  block 10252704), and the deployer withdrew 0.3 QOR against batch
  #3 with a Merkle proof (EVM tx
  `0x926d52875bffc10bc5ad3577f740b4e41641c34444972092241521363d0a6a91`,
  block 10253087) — deposit → auto-credit → batch → withdraw, every
  step on-chain. The negative cases are covered in the Hardhat tests
  (`test/deposit-credit.test.ts`: a fake credit and a credit
  exceeding its supporting deposit fail at both the watcher/sequencer
  level and the watchtower level).
- **Residual risk (honest liveness note):** the watcher is an
  off-chain process that runs on a 30-minute schedule (since 17 Nov
  2026), with no alerting — if a run is missed, deposits queue until
  the next run. Deposits are never lost,
  because the events stay on-chain and the next scan picks them up
  from the persisted last-processed block. But there is no forced
  inclusion: a sequencer that ignores a pending deposit (or never
  runs the watcher) strands the depositor's funds in the contract
  with no on-chain escape hatch — the deposit cannot be reclaimed
  except by withdrawing a rollup balance the sequencer never
  credited. The watcher, the sequencer and the watchtower all read
  the same RPC endpoint by default (configurable via
  `QORE_EVM_RPC_URL`); a lying endpoint could mislead all three at
  once. The defence is running the watchtower against an independent
  endpoint — the checks need no secrets.

## 5. DEMO-GRADE vs PRODUCTION-GRADE

This is a Developer Fest demo on a testnet. The following are explicit,
deliberate gaps — not oversights:

| Area | Demo-grade (this project) | Production-grade would need |
|---|---|---|
| Fraud / validity proofs | None. No fraud proofs, no validity (ZK) proofs, no challenge period. A settled batch is final the moment it is mined — and in v2 its leaves are immediately withdrawable. | A challenge window with fraud proofs, or validity proofs verified on-chain. |
| State commitments | **Done in v2:** Merkle root over (account, balance, nonce) leaves, sorted pairs; every batch file stores the leaves and proofs. | A Verkle tree or a state trie with storage proofs for richer state. |
| Withdrawals | **Done in v2:** proven against the rollup state root (Merkle proof + cumulative per-account cap), no sequencer help. Still demo-grade: no challenge period, so a false root's leaves are withdrawable; withdrawals do not burn rollup balances or reconcile with the L1 deposit ledger. | A challenge period before withdrawals finalise, on-chain reconciliation of rollup balances with L1 deposits, and a real DA layer so proofs can always be constructed. |
| Sequencer | Single, centralised, operator-run. No forced inclusion, no rotation, no liveness guarantee. Cannot block withdrawals from settled batches, but can halt new batches and (via §4.11) strand funds by withholding batch data. | Decentralised sequencer set or based sequencing, forced inclusion, escape hatch. |
| Watchtower | Advisory only — prints FAIL lines, cannot halt settlement or slash. Shares `rollup.ts`/`merkle.ts`/`deposits.ts` with the sequencer, so a shared-library bug is invisible to it. | Independent implementation, on-chain fraud-proof submission, bonded challengers. |
| Batch data | Plaintext published in `deployments/batches/` for verification; the on-chain commitment is to the ciphertext. Transparency chosen over confidentiality. | Real data-availability layer (DA committee, DA chain, or on-chain calldata/blobs) with the plaintext genuinely restricted. |
| KEM keys | Single key held by the operator; no rotation, no threshold, no forward secrecy. | Rotating keys, threshold decryption, per-batch keys. |
| User signatures | Rollup transactions are NOT signed by their senders; the sequencer can invent txs from any funded account. | Every rollup tx signed by its sender (ideally PQ-signed). |
| Deposits | **Done:** deposit events credited into the rollup state by the sequencer via the deposit watcher, verifiable by the watchtower (checks (e)/(f)); the 0.3 QOR genesis deposit is the one hand-credited exception, recorded as such. Still demo-grade: the watcher is an off-chain process (runs on a 30-minute schedule since 17 Nov 2026), and there is no forced inclusion — a sequencer that ignores a deposit strands it. | On-chain deposit queue with forced inclusion, so the sequencer cannot ignore a deposit; on-chain reconciliation of rollup balances with L1 deposits. |
| Key management | Mode-600 files on the operator's machine. | HSM/KMS, multisig, timelocks, key rotation. |

## 6. What would change the assessment

The single highest-leverage improvement is a fraud-proof challenge period
with an on-chain dispute path: it turns the watchtower from an alarm bell
into an enforcement mechanism — and in v2 it matters more than before,
because a false root's leaves are immediately withdrawable. The second is
user-signed rollup transactions, which removes the sequencer's ability to
invent transfers. The third is a real data-availability layer, so a user
can always construct a withdrawal proof even if the sequencer stops
publishing batch files. (The Merkle state commitment with inclusion proofs
— the third item in the v1 version of this section — is done in v2.)
