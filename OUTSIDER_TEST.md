# Outsider test — try QoreRollup end to end (Diana testnet)

Deposit testnet QOR into the rollup, then withdraw it — using only your
own wallet. No team keys are involved at any step. Total time about
30–60 minutes, mostly waiting for your deposit to settle into a batch.

You need: Node.js 20+, git, a terminal. Everything is free (testnet).

## 0. Clone + install

```sh
git clone https://github.com/andiPangeranm142/qorerollup.git
cd qorerollup
npm install
```

## 1. Create a fresh testnet wallet

```sh
npx tsx scripts/make-test-wallet.ts
```

This prints a new 12-word mnemonic, its EVM private key, EVM address
and Cosmos address. **Testnet only** — never send mainnet funds to this
wallet and never reuse its mnemonic anywhere else.

## 2. Save the credentials (outside the repo)

Create a file named `.env` in the folder **above** the repo (next to
the `qorerollup` folder, not inside it), with mode 600:

```sh
QORE_NETWORK=testnet
QORE_EVM_RPC_URL=https://evm-testnet.qore.host
QORE_MNEMONIC=<the 12 words from step 1>
QORE_EVM_PRIVATE_KEY=<the 0x private key from step 1>
QORE_WINDOW_BLOCKS=1200
QORE_WINDOW_TXS=10
```

Then copy it — the withdraw script reads a second file, same account:

```sh
cp ../.env ../.env.user
```

Never commit these files. (See `.env.example` in the repo.)

## 3. Fund the wallet — free, from the faucet

https://dashboard.qorechain.io/faucet — sign in, paste your EVM (`0x`)
address, claim **100 QOR** (once per 24 hours per account and per
address). Wait for it to arrive; check on the explorer
(https://explore.qore.network — switch it to **Testnet** first).

## 4. Register the post-quantum key (once) + open an EVM window

```sh
npm run window register   # first tx of a fresh account MUST be the PQC key registration
npm run window open       # opens an EVM authorisation window (~40 min / 1200 blocks)
```

EVM calls on Diana need an open window — without one, transactions
fail. If a step below fails with a window error, just run
`npm run window open` again and retry immediately.

## 5. Deposit 0.05 QOR

```sh
npm run usage -- deposit --amount 50000
```

This calls `deposit()` on the settlement contract
`0xb54a8bd2dfffa9f3b8a23c3b4e663fe31667d708`. Save the transaction hash.

> ⚠️ Do NOT just send QOR to the contract address: a plain transfer
> emits no `Deposited` event, so the watcher never credits it and the
> funds strand. Always deposit via the `deposit()` call above.

## 6. Wait — the team settles your deposit into a batch

The deposit watcher (runs every 30 minutes) picks up your deposit
automatically; the team settles the next batch and pushes the batch
file to this repo. We will tell you the batch number. You can watch
`deployments/deposits.json` and `deployments/batches/` on GitHub.

## 7. Withdraw — your own signature, no sequencer help

```sh
git pull                              # get the latest batch file
npm run window open                   # fresh window (the old one expired)
npm run merkle-withdraw -- --batch <N>  # N = your batch number from step 6
```

The script builds your Merkle proof from the published batch file and
calls `withdraw()` for you. **0.05 QOR returns to your wallet.** Save
the transaction hash.

## 8. Verify

On the explorer (switch to Testnet): your deposit transaction (success,
`Deposited` event) and your withdraw transaction (success, 0.05 QOR
paid out). Contract:
https://explore.qore.network/address/0xb54a8bd2dfffa9f3b8a23c3b4e663fe31667d708

## Troubleshooting

- **Window expired / no window:** run `npm run window open` and retry
  immediately.
- **Deposit not credited after 1 hour:** tell the team (the watcher
  runs every 30 minutes; a missed run is caught by the next one).
- **Withdraw says `BatchNotFound`:** the batch has not settled yet —
  wait for the team to confirm the batch number.
