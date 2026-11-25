# QoreRollup — flattened contract source for QCAI audit

File: `QoreRollup.flattened.sol` — 420 lines, 19,909 bytes.
Generated with hardhat v2.29.2 (`npx hardhat flatten`) from
`contracts/QoreRollup.sol` (414 lines, no imports). The body is
byte-identical to the deployed source (verified by diff from the
pragma line onward); no test code is included (the `mocks/` contracts
are test-only and are not part of this file).

Deployed: 0xb54a8bd2dfffa9f3b8a23c3b4e663fe31667d708 on qorechain-diana
(chain 9800), deploy tx
0x9f8032e00d66000ff427868c9c57a27ee006d769d1c797b5936457c280022cd0.

## How to run the audit

1. Open https://dashboard.qorechain.io/audit, sign in with the project account.
2. Start a NEW audit. The form has no file upload — paste the entire
   contents of `QoreRollup.flattened.sol` into the "Contract Source Code"
   textarea.
3. Set Blockchain = QoreChain. Run the audit (150 QOR testnet per run,
   paid ON-CHAIN from the connected dashboard wallet — the fee is a real
   MsgSend to qor1wv0fvt5qzx7gllk9ckzv3u6ypceaqq8evuny0h; make sure the
   wallet holds ≥150 QOR + gas BEFORE running. The faucet alone
   (100 QOR/24h) is NOT enough — top up from the deployer first).
4. Wait for the result. Record score / risk / quantum readiness / findings.
5. Export the PDF and save it as `docs/QCAI-audit-stage1.pdf`
   (stage 2: `docs/QCAI-audit-stage2.pdf`), then triage every finding in
   `docs/QCAI-stage1-triage.md` (stage 2 likewise).

Notes: the dashboard keeps NO audit history and offers NO stage-2 option
on an existing result — stage 2 is a fresh audit with the identical
source. The dashboard failed twice on BillPay Guard's stage 2 on 25 Nov
("No wallet found" toast) because the account had no dashboard wallet;
the fix (approved by the user 25 Nov 09:11) was creating one via the
dashboard's own "Create a new wallet" button (wallet "SealedBid"
qor14pwajnz3pn6uzxkchjv856q8639m6uve6hwmc4, funded by top-ups from the
deployer).

## Auditor context

- Settlement contract for a minimal post-quantum rollup. An off-chain
  sequencer batches transactions, signs each batch with ML-DSA-87, and
  settles it here; the contract verifies the signature ON-CHAIN via the
  pqcVerify precompile (0x0A01) against the sequencer's REGISTERED public
  key from the pqcKeyStatus precompile (0x0A02) — never a caller-supplied
  key.
- Each batch's state root is the Merkle root over the post-batch balances
  (one leaf per account, keccak256(abi.encodePacked(account, balance,
  nonce))). Any account can withdraw its rollup balance by proving its
  leaf against a settled batch root, directly, with NO sequencer help —
  the sequencer cannot block a withdrawal.
- The precompile interfaces at the top of the file describe the LIVE
  Diana precompiles (verified by raw eth_call before the contract was
  written); the qorechain/evm 0.14.0 type definitions describe only three
  pqcKeyStatus return values, but the live precompile returns four.
- Testnet only (qorechain-diana).
