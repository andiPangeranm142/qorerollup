/**
 * kem.test.ts - unit tests for the ML-KEM-1024 batch-payload sealing module.
 * No chain involved: pure crypto round-trips, size checks, tamper
 * detection, and payload secrecy. Adapted from SealedBid's kem.test.ts.
 *
 * Run: npx hardhat test test/sequencer.test.ts test/watchtower.test.ts test/kem.test.ts
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import { toHex } from "viem";
import {
  KEM_CIPHERTEXT_SIZE,
  KEM_PUBLIC_KEY_SIZE,
  KEM_SECRET_KEY_SIZE,
  generateKemKeypair,
  kemPublicKeyHash,
  sealBatchPayload,
  unsealBatchPayload,
} from "../src/lib/kem";

const PAYLOAD = JSON.stringify({
  batchId: 0,
  prevStateRoot: "0x" + "00".repeat(32),
  txs: [{ from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", amount: "987654321", nonce: 0 }],
  newStateRoot: "0x" + "ff".repeat(32),
});

describe("generateKemKeypair", () => {
  it("produces FIPS 203 ML-KEM-1024 sized keys", () => {
    const kp = generateKemKeypair();
    expect(kp.publicKey.length).to.equal(KEM_PUBLIC_KEY_SIZE);
    expect(kp.secretKey.length).to.equal(KEM_SECRET_KEY_SIZE);
  });

  it("is deterministic with a seed and distinct without one", () => {
    const seed = new Uint8Array(64).fill(7);
    const a = generateKemKeypair(seed);
    const b = generateKemKeypair(seed);
    expect(a.publicKey).to.deep.equal(b.publicKey);
    expect(a.secretKey).to.deep.equal(b.secretKey);
    const c = generateKemKeypair();
    expect(a.publicKey).to.not.deep.equal(c.publicKey);
  });
});

describe("kemPublicKeyHash", () => {
  it("is stable for a key and distinct across keys", () => {
    const a = generateKemKeypair(new Uint8Array(64).fill(1));
    const b = generateKemKeypair(new Uint8Array(64).fill(2));
    expect(kemPublicKeyHash(a.publicKey)).to.equal(kemPublicKeyHash(a.publicKey));
    expect(kemPublicKeyHash(a.publicKey)).to.not.equal(kemPublicKeyHash(b.publicKey));
    expect(kemPublicKeyHash(a.publicKey)).to.match(/^0x[0-9a-f]{64}$/);
  });
});

describe("sealBatchPayload / unsealBatchPayload", () => {
  it("round-trips a batch payload string", () => {
    const kp = generateKemKeypair();
    const sealed = sealBatchPayload(kp.publicKey, PAYLOAD);
    expect(sealed.kemCiphertext.length).to.equal(KEM_CIPHERTEXT_SIZE);
    expect(sealed.sealedBlob.length).to.be.greaterThan(12 + 16);
    expect(unsealBatchPayload(kp.secretKey, sealed.kemCiphertext, sealed.sealedBlob)).to.equal(
      PAYLOAD,
    );
  });

  it("produces different ciphertexts for the same payload (randomised encapsulation)", () => {
    const kp = generateKemKeypair();
    const s1 = sealBatchPayload(kp.publicKey, PAYLOAD);
    const s2 = sealBatchPayload(kp.publicKey, PAYLOAD);
    expect(s1.kemCiphertext).to.not.deep.equal(s2.kemCiphertext);
    expect(s1.sealedBlob).to.not.deep.equal(s2.sealedBlob);
    expect(unsealBatchPayload(kp.secretKey, s2.kemCiphertext, s2.sealedBlob)).to.equal(PAYLOAD);
  });

  it("fails to open with the wrong secret key", () => {
    const kp = generateKemKeypair();
    const other = generateKemKeypair();
    const sealed = sealBatchPayload(kp.publicKey, PAYLOAD);
    expect(() =>
      unsealBatchPayload(other.secretKey, sealed.kemCiphertext, sealed.sealedBlob),
    ).to.throw();
  });

  it("detects a tampered sealed blob (GCM tag)", () => {
    const kp = generateKemKeypair();
    const sealed = sealBatchPayload(kp.publicKey, PAYLOAD);
    const tampered = new Uint8Array(sealed.sealedBlob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => unsealBatchPayload(kp.secretKey, sealed.kemCiphertext, tampered)).to.throw();
  });

  it("detects a tampered KEM ciphertext (wrong shared secret => GCM failure)", () => {
    const kp = generateKemKeypair();
    const sealed = sealBatchPayload(kp.publicKey, PAYLOAD);
    const tampered = new Uint8Array(sealed.kemCiphertext);
    tampered[100] ^= 0x01;
    expect(() => unsealBatchPayload(kp.secretKey, tampered, sealed.sealedBlob)).to.throw();
  });

  it("rejects wrong-sized keys and ciphertexts", () => {
    const kp = generateKemKeypair();
    expect(() => sealBatchPayload(kp.publicKey.slice(0, 100), PAYLOAD)).to.throw(
      "public key must be 1568 bytes",
    );
    const sealed = sealBatchPayload(kp.publicKey, PAYLOAD);
    expect(() =>
      unsealBatchPayload(kp.secretKey.slice(0, 100), sealed.kemCiphertext, sealed.sealedBlob),
    ).to.throw("secret key must be 3168 bytes");
    expect(() =>
      unsealBatchPayload(kp.secretKey, sealed.kemCiphertext.slice(0, 100), sealed.sealedBlob),
    ).to.throw("ciphertext must be 1568 bytes");
    expect(() =>
      unsealBatchPayload(kp.secretKey, sealed.kemCiphertext, new Uint8Array(10)),
    ).to.throw("too short");
  });
});

describe("sealed payload hides its contents", () => {
  it("neither the ciphertext nor the blob contains the payload in the clear", () => {
    const kp = generateKemKeypair();
    const sealed = sealBatchPayload(kp.publicKey, PAYLOAD);
    const haystack = Buffer.concat([
      Buffer.from(sealed.kemCiphertext),
      Buffer.from(sealed.sealedBlob),
    ]).toString("latin1");
    expect(haystack.includes("987654321")).to.equal(false);
    expect(haystack.includes("batchId")).to.equal(false);
    expect(haystack.includes(toHex(new Uint8Array([9, 8, 7])))).to.equal(false);
  });
});
