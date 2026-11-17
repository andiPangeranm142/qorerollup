# QoreRollup

A post-quantum rollup on QoreChain — a Protocol Builders entry for the
QoreChain Developer Fest ("Build Before Q-Day").

**Status:** in early development. Team invite pending.

## Team

- **Andi Pangeran** ([@andiPangeranm142](https://github.com/andiPangeranm142)) — Indonesia
- **Ajeng Ayu Kusum** ([@Ajengayukusu](https://github.com/Ajengayukusu)) — Indonesia (invite pending)

## Concept

QoreRollup is a minimal rollup that batches transactions off-chain and
settles them on the QoreChain Diana testnet with post-quantum security:

- An off-chain sequencer collects transactions into batches.
- Each batch is signed with **ML-DSA-87** (post-quantum signatures).
- A settlement contract on Diana verifies the batch signature
  (via the `pqcVerify` precompile) and records the batch state root,
  issuing a **verified settlement receipt**.
- **Withdrawals** move funds from the rollup back to the Diana testnet.
- A **watchtower** re-verifies every batch and flags invalid ones.
- Batch data is protected with **ML-KEM-1024** encryption.
- A **threat model** documents the attack surface and mitigations.

## Category requirements (Protocol Builders)

- [ ] ML-DSA-signed batches
- [ ] Withdrawal
- [ ] Verified settlement receipt
- [ ] Watchtower
- [ ] ML-KEM data protection
- [ ] Threat model

## Licence

Apache-2.0
