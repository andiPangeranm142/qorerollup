# Auto-settle — schedule and run evidence

`scripts/auto-settle.ts` settles rollup batches without an operator: each run ingests fresh L1 deposits, enqueues one 1-uqor sequencer self-transfer if the mempool is empty, opens an EVM window if needed, and settles at most ONE batch — then verifies on-chain that batchCount rose by exactly one and the receipt succeeded. If there is nothing to settle it exits quietly (code 0, no transaction sent).

## Schedule

Every 6 hours since 18 Nov 2026 18:19 WIB (00:19, 06:19, 12:19, 18:19 WIB), as a scheduled job. The job runs the script from the persistent checkout (never a fresh clone — the script relies on on-disk state files that are not all committed) and appends its output to the run log. The job runs until the fest winners are announced (16 Dec 2026).

## Runs on record

These are the runs whose outputs are recorded in the run log. Most runs correctly do nothing — a new deposit is the only thing that triggers a settle, and none arrived between 18 and 26 Nov.

| Run (WIB) | batchCount | Watchtower | Outcome |
| --- | --- | --- | --- |
| 18 Nov 2026 18:19 | 8 | 8/8 | Nothing to settle |
| 19 Nov 2026 00:19 | 8 | 8/8 | Nothing to settle |
| 22 Nov 2026 06:20 | 8 | 8/8 | Nothing to settle |
| 23 Nov 2026 18:20 | 8 | 8/8 | Nothing to settle |
| 25 Nov 2026 06:21 | 8 | 8/8 | Nothing to settle |
| 26 Nov 2026 12:21 | 8 | 8/8 | Nothing to settle |
| 26 Nov 2026 19:55 | 8 → 9 | 9/9 after | **Batch #8 settled** (manual run, operator-triggered — see below) |
| 27 Nov 2026 00:20 | 9 | 9/9 (run #475) | Nothing to settle |

The first live settle was the 26 Nov 19:55 run: a 0.05 QOR deposit from `0xD836…bedb30` (tx `0x242fe55477222c732e7aa36c45fb3492165ef0dd66484a9eda35a3fca74977ad`, block 10789217) was credited and settled as batch #8 — settle tx `0x5564b5cbd9db9d0640c5c0e3eac20910bdfab9ed28e57597620d66590499ce96`, Cosmos tx `1FC71F138E2489B58BF582230F35428D66EC05D6E6970AE82DB3EFE015A5D005`, block 10789431, ML-DSA-87 signature 4,627 bytes. Every scheduled run before it correctly found nothing to settle.

## Where to verify

- This file's table: run times and outcomes above.
- `deployments/usage.json`: the `auto-settle` step for the 26 Nov settle (batchId 8, tx, block).
- `deployments/batches/batch-8.json`: the settled batch itself.
- `deployments/watchtower-log.json`: the watchtower re-verifies every batch after each run (9/9 OK as of 27 Nov 00:20 WIB, run #475).
- `scripts/auto-settle.ts`: the script itself — testnet-only guard, one-batch-per-run cap, on-chain verification before it reports success.
