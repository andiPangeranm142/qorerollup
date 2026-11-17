/**
 * make-test-wallet.ts - generate a fresh TESTNET-ONLY wallet for trying
 * QoreRollup (see OUTSIDER_TEST.md).
 *
 * Prints the mnemonic, EVM private key, EVM address and Cosmos address.
 * The wallet is derived with the QoreChain SDK (BIP-44 m/44'/60'/0'/0/0),
 * the same derivation the repo scripts expect.
 *
 * TESTNET ONLY. Never send mainnet funds to this wallet, never reuse its
 * mnemonic anywhere else, and never commit the printed values.
 *
 * Usage: npx tsx scripts/make-test-wallet.ts
 */
import { deriveUnifiedAccount, generateMnemonic } from "@qorechain/sdk";

async function main(): Promise<void> {
  const mnemonic = generateMnemonic(128);
  const acc = await deriveUnifiedAccount(mnemonic, 0);
  console.log("# TESTNET ONLY — never use on mainnet. Save these in ../.env (mode 600), outside the repo.");
  console.log(`QORE_MNEMONIC=${mnemonic}`);
  console.log(`QORE_EVM_PRIVATE_KEY=${acc.privateKey}`);
  console.log(`# EVM address: ${acc.evm}`);
  console.log(`# Cosmos address: ${acc.cosmos}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
