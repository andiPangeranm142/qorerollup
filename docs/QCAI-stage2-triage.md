# QCAI audit — stage 2 triage (25 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/QoreRollup.flattened.sol` (420 lines, no test code), run 25 Nov
  2026 ~22:42 WIB — a fresh audit with the IDENTICAL source as stage 1 (the
  dashboard keeps no history).
- Result: **score 78/100, risk MEDIUM, quantum readiness QUANTUM-SAFE,
  5 findings.** Report: `docs/QCAI-audit-stage2.pdf` (verified from the PDF
  itself: score, risk, readiness, and all five titles/severities/
  recommendations match).
- Cost: 150 QOR (testnet), paid ON-CHAIN from the dashboard wallet
  "SealedBid" (`qor14pwajnz3pn6uzxkchjv856q8639m6uve6hwmc4`) — fee tx
  `C755A0EE…C2832864` to `qor1wv0fvt…` (−150.045 QOR incl. gas; wallet
  balance verified on-chain before/after: 158.74 → 8.695 QOR). The wallet
  was topped up 150 QOR from the deployer before the run
  (tx `919E88A8…7EBA4BE2`, code 0). No faucet was used and no re-login was
  needed (the dashboard session was still active).
- vs stage 1 (same source, 25 Nov ~09:56 WIB): score IMPROVED 72 → 78/100
  — the only stage-2 score improvement of the four projects so far — risk
  UNCHANGED MEDIUM, quantum readiness UNCHANGED QUANTUM-SAFE. Finding
  composition: the HIGH (key rotation) and MEDIUM (reentrancy) findings
  are the same issues reworded; the third MEDIUM is now "Inefficient
  Merkle Proof Verification" (was "Insufficient Validation of Batch
  Digest"); the LOW is now "Lack of Input Validation for Batch ID" (was
  "Missing Input Sanitization for Merkle Proof"); and the INFO finding
  flipped from a warning ("Use of Precompiles Requires Chain-Specific
  Assumptions") to a POSITIVE note ("Good Use of Precompiles for PQC
  Operations"). QoreRollup and SealedBid are now the two QUANTUM-SAFE
  projects (Quantum Vault is also QUANTUM-SAFE at 85/100 x2).

## Finding 1 — HIGH — Missing Quantum-Safe Key Rotation Mechanism

**Verdict: ACCEPTED BY DESIGN — documented limitation; no code change.**

Same issue as stage-1 finding 1. Real and honestly disclosed: a single
sequencer with a fixed ML-DSA key, no rotation, no admin — stated in the
contract's NatSpec ("Honest limits": "a lost ML-DSA key means the
sequencer can never settle another batch — there is no key rotation and
no admin") and in docs/THREAT_MODEL.md. A rotation mechanism
(governance/multisig) would be a redesign, not a patch — and adding an
admin who can rotate the key would weaken the trust model (the admin
could rotate to their own key). A redeploy to add rotation would orphan
8 settled batches, the watchtower history, and the Q-Day Drill evidence.
For a minimal testnet rollup, the disclosed limitation stands. No code
change.

## Finding 2 — MEDIUM — Potential Reentrancy Risk in Withdraw Function

**Verdict: FALSE POSITIVE — the recommendation is inverted; no code
change.**

Same issue as stage-1 finding 2. The contract ALREADY follows
checks-effects-interactions: `withdraw` updates
`withdrawnAmount[account] = balance` and `totalWithdrawn` BEFORE the
external call; the finding's claim that a recipient "could potentially
reenter the withdraw function before the state update is complete" is
factually wrong — the updates are complete before the call. The
recommendation ("update state variables before making external calls")
describes exactly what the code already does. Additionally,
`msg.sender == account` is required, so a "malicious contract"
recipient would be withdrawing its own funds, and reentering with the
same leaf would hit `balance <= alreadyWithdrawn` → revert
`ZeroWithdraw` (the cumulative cap is already updated). No code change.

## Finding 3 — MEDIUM — Inefficient Merkle Proof Verification

**Verdict: NOT APPLICABLE — no code change.**

New in stage 2 (replaces the stage-1 batch-digest finding). The proof
loop MUST consume every element: a Merkle root can only be computed by
hashing the whole proof, so there is no "early termination" to add —
stopping early would produce a wrong root. Each iteration is a single
keccak256; proofs in practice are tiny (8 settled batches, small trees),
and the CALLER pays their own gas for the loop. OpenZeppelin's
MerkleProof is the same loop with the same cost. This is a gas-style
note, not a vulnerability. No code change.

## Finding 4 — LOW — Lack of Input Validation for Batch ID

**Verdict: FALSE POSITIVE — the check already exists; no code change.**

New in stage 2 (replaces the stage-1 proof-sanitization finding).
`withdraw` DOES validate the batch id: `if (batchId >= batchCount)
revert BatchNotFound(batchId)` — any out-of-bounds id reverts before any
proof is checked. "Sequential" ids are guaranteed by construction
(batches settle at `batchCount`, which increments by one), and any
settled batch id is a legitimate withdrawal target — there is no
requirement that withdrawals use the latest batch. No code change.

## Finding 5 — INFO — Good Use of Precompiles for PQC Operations

**Verdict: CONFIRMED BY DESIGN — no action.**

New in stage 2, and it is a POSITIVE finding: the auditor now praises
the correct use of the pqcKeyStatus (0x0A02) and pqcVerify (0x0A01)
precompiles — the same precompiles stage 1 flagged as a
chain-specific-assumption warning. Nothing to do.

## Summary

0 of 5 findings need a code change: 1 false positive (finding 2), 1
false positive (finding 4), 1 not applicable (finding 3), 1 accepted by
design (finding 1), 1 positive (finding 5). No redeploy. Stage 2
confirms stage 1 and scores it higher (72 → 78): the contract enforces
three layers of post-quantum protection (chain-gated window,
contract-verified registered key, verified batch signature) with the
single-sequencer operational risk disclosed, not hidden.
