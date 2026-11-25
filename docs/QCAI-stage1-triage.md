# QCAI audit — stage 1 triage (25 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/QoreRollup.flattened.sol` (420 lines, no test code), run 25 Nov
  2026 ~09:56 WIB.
- Result: **score 72/100, risk MEDIUM, quantum readiness QUANTUM-SAFE,
  5 findings.** Report: `docs/QCAI-audit-stage1.pdf` (verified from the PDF
  itself: score, risk, readiness, and all five titles/severities/
  recommendations match).
- Cost: 150 QOR (testnet), paid ON-CHAIN from the dashboard wallet
  "SealedBid" (`qor14pwajnz3pn6uzxkchjv856q8639m6uve6hwmc4`) — fee tx
  `A9487788…5ACAD653` to `qor1wv0fvt…` (−150.045 QOR incl. gas; wallet
  balance verified on-chain before/after: 158.92 → 8.875 QOR). The wallet
  was topped up 150 QOR from the deployer before the run
  (tx `6A9D667C…3E4E43AE`, code 0).
- Context: tied with BillPay Guard at 72/100 (Quantum Vault 85/100 x2,
  SealedBid 75/100, QoreVest 65/100) — but the ONLY QUANTUM-SAFE result of
  the five (others: HYBRID x3, CLASSICAL-ONLY x1). The contract genuinely
  verifies ML-DSA-87 signatures on chain (pqcVerify precompile against
  the sequencer's REGISTERED key), which is what the auditor rewarded.
  Stage 2 is a fresh audit with identical source (the dashboard keeps no
  history); stage 2 NOT yet run.

## Finding 1 — HIGH — Missing Quantum-Safe Key Rotation Mechanism

**Verdict: ACCEPTED BY DESIGN — documented limitation; no code change.**

Real and honestly disclosed: a single sequencer with a fixed ML-DSA key,
no rotation, no admin — stated in the contract's NatSpec ("Honest
limits": "a lost ML-DSA key means the sequencer can never settle
another batch — there is no key rotation and no admin") and in
docs/THREAT_MODEL.md. A rotation mechanism (governance/multisig) would
be a redesign, not a patch — and adding an admin who can rotate the key
would weaken the trust model (the admin could rotate to their own key).
A redeploy to add rotation would orphan 8 settled batches, the
watchtower history, and the Q-Day Drill evidence. For a minimal
testnet rollup, the disclosed limitation stands. No code change.

## Finding 2 — MEDIUM — Reentrancy Risk in Withdraw Function

**Verdict: FALSE POSITIVE — the recommendation is inverted; no code
change.**

The contract ALREADY follows checks-effects-interactions: `withdraw`
updates `withdrawnAmount[account] = balance` and `totalWithdrawn` BEFORE
the external call; the finding's claim that a recipient "could
potentially reenter the withdraw function before the state update is
complete" is factually wrong — the updates are complete before the
call. The recommendation ("transfer funds before updating state
variables") is exactly the pattern that CREATES reentrancy risk.
Additionally, `msg.sender == account` is required, so a "malicious
contract" recipient would be withdrawing its own funds, and reentering
with the same leaf would hit `balance <= alreadyWithdrawn` → revert
`ZeroWithdraw` (the cumulative cap is already updated). No code change.

## Finding 3 — MEDIUM — Insufficient Validation of Batch Digest

**Verdict: FALSE POSITIVE — no code change.**

`batchDigest` is a pure view function computing keccak256 over
domain-separated inputs (literal tag, chain id, contract address, batch
id, three batch hashes); there is nothing to "validate" — the digest's
integrity is enforced by the signature check in `submitBatch` (pqcVerify
over the exact digest against the sequencer's registered key). A
malformed digest simply fails signature verification and the batch does
not settle. The domain separation IS the protection. No code change.

## Finding 4 — LOW — Missing Input Sanitization for Merkle Proof

**Verdict: ACCEPTED RISK (negligible); no code change.**

The proof loop is bounded by tree depth: a proof longer than ~256
elements is cryptographically meaningless (a tree with 2^256 leaves),
and the CALLER pays gas for their own calldata and loop iterations — a
huge proof costs the caller gas and fails (out of gas = caller loses
their gas, no state change, no harm to others). The contract cannot be
DoS'd by it; there is no shared resource. A length cap would be
cosmetic. No code change.

## Finding 5 — INFO — Use of Precompiles Requires Chain-Specific Assumptions

**Verdict: ACCEPTED BY DESIGN — documented; no code change.**

The contract is built FOR QoreChain (a fest project on Diana);
portability is not a goal. The precompiles (0x0A01, 0x0A02) are
documented extensively in the NatSpec, and the README/project page
state testnet-only QoreChain. No code change.

## Summary

0 of 5 findings need a code change: 1 false positive (finding 2),
1 false positive (finding 3), 1 accepted risk (finding 4), 2 accepted
by design (findings 1, 5). No redeploy. The audit confirms the
documented security story: three layers of post-quantum protection
(chain-gated window, contract-verified registered key, verified batch
signature) with the single-sequencer operational risk disclosed, not
hidden.
