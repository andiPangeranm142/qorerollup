/**
 * kem.ts - ML-KEM-1024 (FIPS 203) sealing for QoreRollup batch payloads.
 *
 * Adapted from the SealedBid KEM module (same constants, same error style):
 * pure-JS crypto from @noble/post-quantum (ML-KEM) and @noble/ciphers
 * (AES-256-GCM). No native modules, no network calls.
 *
 * What this module does — and what it deliberately does NOT do:
 * - It generates ML-KEM-1024 keypairs, encapsulates a shared secret to a
 *   public key, and seals a batch payload (a JSON string) with AES-256-GCM
 *   under that shared secret. All of that happens OFF-CHAIN, in the
 *   sequencer.
 * - It never talks to the chain. The settlement contract only stores the
 *   keccak256 commitment to the ciphertext + sealed blob
 *   (encryptedDataHash); the ciphertext and blob themselves live in
 *   deployments/batches/ so the watchtower can re-verify them. The batch
 *   PLAINTEXT is also published there for verification — a deliberate
 *   transparency trade-off for a demo: the on-chain commitment is to the
 *   ciphertext, so the encryption story is real, but the plaintext is not
 *   actually hidden from anyone who can read the repo. See THREAT_MODEL.md.
 *
 * Sizes (FIPS 203, ML-KEM-1024): public key 1568 bytes, ciphertext 1568
 * bytes, secret key 3168 bytes, shared secret 32 bytes.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { hexToBytes, keccak256, toHex, type Hex } from "viem";

/** ML-KEM-1024 public (encapsulation) key size, in bytes. */
export const KEM_PUBLIC_KEY_SIZE = 1568;
/** ML-KEM-1024 ciphertext size, in bytes. */
export const KEM_CIPHERTEXT_SIZE = 1568;
/** ML-KEM-1024 secret (decapsulation) key size, in bytes. */
export const KEM_SECRET_KEY_SIZE = 3168;
/** ML-KEM-1024 shared secret size, in bytes (also the AES-256 key size). */
export const SHARED_SECRET_SIZE = 32;
/** AES-GCM nonce size, in bytes. */
export const GCM_NONCE_SIZE = 12;

/** A sealed batch payload, ready to store alongside a settled batch. */
export interface SealedBatchPayload {
  /** ML-KEM-1024 ciphertext (1568 bytes). */
  kemCiphertext: Uint8Array;
  /** AES-256-GCM blob: 12-byte nonce || ciphertext || 16-byte tag. */
  sealedBlob: Uint8Array;
}

/** An ML-KEM-1024 keypair. */
export interface KemKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Generate a fresh ML-KEM-1024 keypair.
 * @param seed Optional 64-byte deterministic seed (tests only). Without it,
 *             the keypair comes from the platform CSPRNG.
 */
export function generateKemKeypair(seed?: Uint8Array): KemKeypair {
  const kp = seed ? ml_kem1024.keygen(seed) : ml_kem1024.keygen();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** keccak256 of a public key — the binding stored next to the public key file. */
export function kemPublicKeyHash(publicKey: Uint8Array): Hex {
  return keccak256(toHex(publicKey));
}

/**
 * Seal a batch payload (a JSON string) to the rollup data-availability
 * ML-KEM-1024 public key: encapsulate a fresh shared secret, then
 * AES-256-GCM-encrypt the payload under it. The shared secret itself is
 * never stored or transmitted — only the 1568-byte KEM ciphertext that lets
 * the secret-key holder re-derive it.
 */
export function sealBatchPayload(publicKey: Uint8Array, payload: string): SealedBatchPayload {
  if (publicKey.length !== KEM_PUBLIC_KEY_SIZE) {
    throw new Error(`ML-KEM-1024 public key must be ${KEM_PUBLIC_KEY_SIZE} bytes, got ${publicKey.length}`);
  }
  const { cipherText, sharedSecret } = ml_kem1024.encapsulate(publicKey);
  const nonce = new Uint8Array(GCM_NONCE_SIZE);
  globalThis.crypto.getRandomValues(nonce);
  const cipher = gcm(sharedSecret, nonce);
  const encrypted = cipher.encrypt(new TextEncoder().encode(payload));
  const sealedBlob = new Uint8Array(GCM_NONCE_SIZE + encrypted.length);
  sealedBlob.set(nonce, 0);
  sealedBlob.set(encrypted, GCM_NONCE_SIZE);
  return { kemCiphertext: cipherText, sealedBlob };
}

/**
 * Open a sealed batch payload with the ML-KEM-1024 secret key.
 * Throws if the ciphertext is the wrong size, the blob is too short, or
 * the GCM authentication tag does not verify (tampered blob or wrong key).
 */
export function unsealBatchPayload(
  secretKey: Uint8Array,
  kemCiphertext: Uint8Array,
  sealedBlob: Uint8Array,
): string {
  if (secretKey.length !== KEM_SECRET_KEY_SIZE) {
    throw new Error(`ML-KEM-1024 secret key must be ${KEM_SECRET_KEY_SIZE} bytes, got ${secretKey.length}`);
  }
  if (kemCiphertext.length !== KEM_CIPHERTEXT_SIZE) {
    throw new Error(`ML-KEM-1024 ciphertext must be ${KEM_CIPHERTEXT_SIZE} bytes, got ${kemCiphertext.length}`);
  }
  if (sealedBlob.length <= GCM_NONCE_SIZE + 16) {
    throw new Error("Sealed batch blob is too short to hold a nonce and a GCM tag");
  }
  const sharedSecret = ml_kem1024.decapsulate(kemCiphertext, secretKey);
  const nonce = sealedBlob.subarray(0, GCM_NONCE_SIZE);
  const encrypted = sealedBlob.subarray(GCM_NONCE_SIZE);
  const cipher = gcm(sharedSecret, nonce);
  return new TextDecoder().decode(cipher.decrypt(encrypted));
}

/** Hex helpers (viem-backed, so bytes <-> 0x strings stay consistent). */
export const bytesToHex = (bytes: Uint8Array): Hex => toHex(bytes);
export const hexToBytesSafe = (hex: Hex): Uint8Array => hexToBytes(hex);
