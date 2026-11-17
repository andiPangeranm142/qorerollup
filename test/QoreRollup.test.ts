import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import type { Address as ViemAddress } from "viem";
import type { QoreRollup, MockPqcKeyStatus, MockPqcVerify } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { buildStateTree } from "../src/lib/merkle";

const KEY_STATUS_PRECOMPILE = "0x0000000000000000000000000000000000000A02";
const VERIFY_PRECOMPILE = "0x0000000000000000000000000000000000000A01";

// The mocks do not validate key/signature lengths (they stand in for the
// precompiles' interfaces, not their cryptography), so short dummy values
// keep the tests fast. Distinct pubkeys per account prove the contract
// passes the REGISTERED pubkey to pqcVerify.
const SEQUENCER_PUBKEY = "0x" + "aa".repeat(32);
const OTHER_PUBKEY = "0x" + "bb".repeat(32);
const DUMMY_SIGNATURE = "0x" + "cc".repeat(64);

const ZERO_HASH = ethers.ZeroHash;
const STATE_ROOT_1 = ethers.keccak256(ethers.toUtf8Bytes("state-root-1"));
const TX_DATA_1 = ethers.keccak256(ethers.toUtf8Bytes("tx-data-1"));
const ENC_DATA_1 = ethers.keccak256(ethers.toUtf8Bytes("enc-data-1"));
const STATE_ROOT_2 = ethers.keccak256(ethers.toUtf8Bytes("state-root-2"));
const TX_DATA_2 = ethers.keccak256(ethers.toUtf8Bytes("tx-data-2"));
const ENC_DATA_2 = ethers.keccak256(ethers.toUtf8Bytes("enc-data-2"));

/**
 * Rules under test:
 *  - Only the sequencer may settle batches, and only with an ML-DSA-87
 *    signature over the exact batch digest, verified via the pqcVerify
 *    precompile (0x0A01) against the REGISTERED pubkey from the
 *    pqcKeyStatus precompile (0x0A02) — never a caller-supplied key.
 *    The sequencer's key must be registered AND possession-proven.
 *  - The batch digest is domain-separated (tag, chain id, contract,
 *    batch id, three hashes); each batch id is used exactly once.
 *  - Deposits credit the L1 ledger. Withdrawals are proven against a
 *    settled batch's Merkle state root: the caller proves their own
 *    (balance, nonce) leaf with a sorted-pair Merkle proof — no
 *    sequencer involvement — and a cumulative per-account cap
 *    (withdrawnAmount) means the total ever withdrawn can never exceed
 *    the largest leaf balance proven. The TypeScript tree in
 *    src/lib/merkle.ts is cross-checked against this contract here:
 *    every proof in the withdraw tests is computed by the TS library.
 *  - Locally, both precompiles are mocks installed at their real addresses
 *    via hardhat_setCode; the real cryptography is verified live on Diana.
 */
async function installMock(
  name: "MockPqcKeyStatus" | "MockPqcVerify",
  address: string,
): Promise<MockPqcKeyStatus | MockPqcVerify> {
  const artifact = await artifacts.readArtifact(name);
  await ethers.provider.send("hardhat_setCode", [address, artifact.deployedBytecode]);
  return (await ethers.getContractAt(name, address)) as unknown as
    | MockPqcKeyStatus
    | MockPqcVerify;
}

describe("QoreRollup", function () {
  let rollup: QoreRollup;
  let keyStatus: MockPqcKeyStatus;
  let verify: MockPqcVerify;
  let sequencer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  beforeEach(async function () {
    [, sequencer, alice, bob] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("QoreRollup");
    rollup = await factory.deploy(sequencer.address);
    await rollup.waitForDeployment();

    keyStatus = (await installMock(
      "MockPqcKeyStatus",
      KEY_STATUS_PRECOMPILE,
    )) as MockPqcKeyStatus;
    verify = (await installMock("MockPqcVerify", VERIFY_PRECOMPILE)) as MockPqcVerify;

    // The sequencer's key is registered with proven possession by default;
    // individual tests override this to exercise the key gates.
    await keyStatus.setKey(sequencer.address, SEQUENCER_PUBKEY, true);
  });

  /** Allow the mock precompile to verify `signature` for the next batch. */
  async function allowNextBatch(
    stateRoot: string,
    txData: string,
    encData: string,
    pubkey: string = SEQUENCER_PUBKEY,
    signature: string = DUMMY_SIGNATURE,
  ): Promise<bigint> {
    const batchId = await rollup.batchCount();
    const digest = await rollup.batchDigest(batchId, stateRoot, txData, encData);
    await verify.allow(pubkey, digest, signature);
    return batchId;
  }

  function expectedReceiptHash(
    chainId: bigint,
    contract: string,
    batchId: bigint,
    stateRoot: string,
    txData: string,
  ): string {
    return ethers.solidityPackedKeccak256(
      ["string", "uint256", "address", "uint256", "bytes32", "bytes32"],
      ["QoreRollup.receipt", chainId, contract, batchId, stateRoot, txData],
    );
  }

  describe("deployment", function () {
    it("sets the sequencer from the constructor", async function () {
      expect(await rollup.sequencer()).to.equal(sequencer.address);
    });

    it("starts with zero batches and zero totals", async function () {
      expect(await rollup.batchCount()).to.equal(0);
      expect(await rollup.totalDeposited()).to.equal(0);
      expect(await rollup.totalWithdrawn()).to.equal(0);
      expect(await rollup.deposits(alice.address)).to.equal(0);
      expect(await rollup.withdrawnAmount(alice.address)).to.equal(0);
    });

    it("exposes the documented precompile addresses", async function () {
      expect((await rollup.PQC_KEY_STATUS_PRECOMPILE()).toLowerCase()).to.equal(
        KEY_STATUS_PRECOMPILE.toLowerCase(),
      );
      expect((await rollup.PQC_VERIFY_PRECOMPILE()).toLowerCase()).to.equal(
        VERIFY_PRECOMPILE.toLowerCase(),
      );
    });
  });

  describe("batchDigest", function () {
    it("matches the documented formula", async function () {
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const expected = ethers.solidityPackedKeccak256(
        ["string", "uint256", "address", "uint256", "bytes32", "bytes32", "bytes32"],
        [
          "QoreRollup.batch",
          chainId,
          await rollup.getAddress(),
          0,
          STATE_ROOT_1,
          TX_DATA_1,
          ENC_DATA_1,
        ],
      );
      expect(await rollup.batchDigest(0, STATE_ROOT_1, TX_DATA_1, ENC_DATA_1)).to.equal(
        expected,
      );
    });

    it("is deterministic for the same inputs", async function () {
      const first = await rollup.batchDigest(0, STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      const second = await rollup.batchDigest(0, STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      expect(first).to.equal(second);
    });

    it("differs across batch ids", async function () {
      const d0 = await rollup.batchDigest(0, STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      const d1 = await rollup.batchDigest(1, STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      expect(d0).to.not.equal(d1);
    });

    it("differs across batch contents", async function () {
      const base = await rollup.batchDigest(0, STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      expect(await rollup.batchDigest(0, STATE_ROOT_2, TX_DATA_1, ENC_DATA_1)).to.not.equal(
        base,
      );
      expect(await rollup.batchDigest(0, STATE_ROOT_1, TX_DATA_2, ENC_DATA_1)).to.not.equal(
        base,
      );
      expect(await rollup.batchDigest(0, STATE_ROOT_1, TX_DATA_1, ENC_DATA_2)).to.not.equal(
        base,
      );
    });

    it("is domain-separated by chain id and contract address", async function () {
      // The formula binds the chain id and this contract, so the same
      // batch inputs digest differently on another chain or contract.
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const contract = await rollup.getAddress();
      const actual = await rollup.batchDigest(0, STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      const otherChain = ethers.solidityPackedKeccak256(
        ["string", "uint256", "address", "uint256", "bytes32", "bytes32", "bytes32"],
        [
          "QoreRollup.batch",
          chainId + 1n,
          contract,
          0,
          STATE_ROOT_1,
          TX_DATA_1,
          ENC_DATA_1,
        ],
      );
      const otherContract = ethers.solidityPackedKeccak256(
        ["string", "uint256", "address", "uint256", "bytes32", "bytes32", "bytes32"],
        [
          "QoreRollup.batch",
          chainId,
          alice.address,
          0,
          STATE_ROOT_1,
          TX_DATA_1,
          ENC_DATA_1,
        ],
      );
      expect(otherChain).to.not.equal(actual);
      expect(otherContract).to.not.equal(actual);
    });
  });

  describe("submitBatch", function () {
    it("records the batch, increments batchCount and emits BatchSettled", async function () {
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const contract = await rollup.getAddress();
      await allowNextBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      const receiptHash = expectedReceiptHash(chainId, contract, 0n, STATE_ROOT_1, TX_DATA_1);

      await expect(
        rollup
          .connect(sequencer)
          .submitBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, DUMMY_SIGNATURE),
      )
        .to.emit(rollup, "BatchSettled")
        .withArgs(0, STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, receiptHash);

      expect(await rollup.batchCount()).to.equal(1);
      const batch = await rollup.getBatch(0);
      expect(batch.stateRoot).to.equal(STATE_ROOT_1);
      expect(batch.txDataCommitment).to.equal(TX_DATA_1);
      expect(batch.encryptedDataHash).to.equal(ENC_DATA_1);
      expect(batch.timestamp).to.be.gt(0);
      expect(batch.receiptHash).to.equal(receiptHash);
    });

    it("settles consecutive batches at sequential ids with distinct digests", async function () {
      await allowNextBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      await rollup
        .connect(sequencer)
        .submitBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, DUMMY_SIGNATURE);
      // The second batch signs a different digest (batch id 1), so the
      // first batch's allowance must NOT carry over.
      await expect(
        rollup
          .connect(sequencer)
          .submitBatch(STATE_ROOT_2, TX_DATA_2, ENC_DATA_2, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(rollup, "InvalidBatchSignature");

      await allowNextBatch(STATE_ROOT_2, TX_DATA_2, ENC_DATA_2);
      await rollup
        .connect(sequencer)
        .submitBatch(STATE_ROOT_2, TX_DATA_2, ENC_DATA_2, DUMMY_SIGNATURE);
      expect(await rollup.batchCount()).to.equal(2);
      expect((await rollup.getBatch(1)).stateRoot).to.equal(STATE_ROOT_2);
    });

    it("reverts for a non-sequencer caller", async function () {
      await allowNextBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      await expect(
        rollup
          .connect(alice)
          .submitBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(rollup, "OnlySequencer");
      expect(await rollup.batchCount()).to.equal(0);
    });

    it("reverts when the sequencer key is not registered", async function () {
      await keyStatus.clearKey(sequencer.address);
      await allowNextBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      await expect(
        rollup
          .connect(sequencer)
          .submitBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, DUMMY_SIGNATURE),
      )
        .to.be.revertedWithCustomError(rollup, "PqcKeyNotRegistered")
        .withArgs(sequencer.address);
    });

    it("reverts when possession was never proven", async function () {
      await keyStatus.setKey(sequencer.address, SEQUENCER_PUBKEY, false);
      await allowNextBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      await expect(
        rollup
          .connect(sequencer)
          .submitBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, DUMMY_SIGNATURE),
      )
        .to.be.revertedWithCustomError(rollup, "PossessionNotProven")
        .withArgs(sequencer.address);
    });

    it("reverts on an invalid signature (never allowed)", async function () {
      await expect(
        rollup
          .connect(sequencer)
          .submitBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(rollup, "InvalidBatchSignature");
    });

    it("reverts on a signature allowed under a different pubkey", async function () {
      // The signature is allowed for OTHER_PUBKEY, but the contract passes
      // the sequencer's REGISTERED pubkey to pqcVerify — so it must fail.
      await allowNextBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, OTHER_PUBKEY);
      await expect(
        rollup
          .connect(sequencer)
          .submitBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(rollup, "InvalidBatchSignature");
    });

    it("reverts on a signature allowed for a different digest", async function () {
      const otherDigest = ethers.solidityPackedKeccak256(["string"], ["something else"]);
      await verify.allow(SEQUENCER_PUBKEY, otherDigest, DUMMY_SIGNATURE);
      await expect(
        rollup
          .connect(sequencer)
          .submitBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(rollup, "InvalidBatchSignature");
    });

    it("reverts on an empty batch (all three hashes zero)", async function () {
      await allowNextBatch(ZERO_HASH, ZERO_HASH, ZERO_HASH);
      await expect(
        rollup
          .connect(sequencer)
          .submitBatch(ZERO_HASH, ZERO_HASH, ZERO_HASH, DUMMY_SIGNATURE),
      ).to.be.revertedWithCustomError(rollup, "EmptyBatch");
      expect(await rollup.batchCount()).to.equal(0);
    });

    it("accepts a batch with only some hashes zero", async function () {
      await allowNextBatch(STATE_ROOT_1, ZERO_HASH, ZERO_HASH);
      await expect(
        rollup
          .connect(sequencer)
          .submitBatch(STATE_ROOT_1, ZERO_HASH, ZERO_HASH, DUMMY_SIGNATURE),
      ).to.emit(rollup, "BatchSettled");
      expect(await rollup.batchCount()).to.equal(1);
    });
  });

  describe("deposit", function () {
    it("credits the depositor, updates totals and emits Deposited", async function () {
      await expect(rollup.connect(alice).deposit({ value: ethers.parseEther("1") }))
        .to.emit(rollup, "Deposited")
        .withArgs(alice.address, ethers.parseEther("1"));
      expect(await rollup.deposits(alice.address)).to.equal(ethers.parseEther("1"));
      expect(await rollup.totalDeposited()).to.equal(ethers.parseEther("1"));
      expect(await rollup.totalWithdrawn()).to.equal(0);
      expect(await ethers.provider.getBalance(await rollup.getAddress())).to.equal(
        ethers.parseEther("1"),
      );
    });

    it("accumulates multiple deposits per depositor", async function () {
      await rollup.connect(alice).deposit({ value: ethers.parseEther("1") });
      await rollup.connect(alice).deposit({ value: ethers.parseEther("0.5") });
      await rollup.connect(bob).deposit({ value: ethers.parseEther("2") });
      expect(await rollup.deposits(alice.address)).to.equal(ethers.parseEther("1.5"));
      expect(await rollup.deposits(bob.address)).to.equal(ethers.parseEther("2"));
      expect(await rollup.totalDeposited()).to.equal(ethers.parseEther("3.5"));
    });

    it("reverts on a zero deposit", async function () {
      await expect(
        rollup.connect(alice).deposit({ value: 0 }),
      ).to.be.revertedWithCustomError(rollup, "ZeroDeposit");
    });
  });

  describe("withdraw (Merkle proof, no sequencer)", function () {
    // Balances are in uqor; 1 uqor = 1e12 wei. The contract is funded
    // with 1 ether of deposits in beforeEach so payouts can land.
    const ALICE_BALANCE = 100_000n; // 0.1 QOR
    const BOB_BALANCE = 50_000n; // 0.05 QOR

    /** Build a state tree with the TS library (cross-checks it vs the contract). */
    function treeFor(
      entries: Array<{ account: string; balance: bigint; nonce: number }>,
    ) {
      const balances = new Map(
        entries.map(
          (e) => [e.account.toLowerCase() as ViemAddress, e.balance] as const,
        ),
      );
      const nonces = new Map(
        entries.map(
          (e) => [e.account.toLowerCase() as ViemAddress, e.nonce] as const,
        ),
      );
      return buildStateTree(balances, nonces);
    }

    /** Settle one batch whose state root is the given Merkle root. */
    async function settleRoot(stateRoot: string): Promise<bigint> {
      const batchId = await rollup.batchCount();
      await allowNextBatch(stateRoot, TX_DATA_1, ENC_DATA_1);
      await rollup
        .connect(sequencer)
        .submitBatch(stateRoot, TX_DATA_1, ENC_DATA_1, DUMMY_SIGNATURE);
      return batchId;
    }

    beforeEach(async function () {
      await rollup.connect(alice).deposit({ value: ethers.parseEther("1") });
    });

    it("pays out for a valid proof, sets the cumulative cap, emits Withdrawn", async function () {
      const tree = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batchId = await settleRoot(tree.root);
      const proof = tree.proofs[alice.address.toLowerCase()] as string[];

      await expect(
        rollup
          .connect(alice)
          .withdraw(batchId, alice.address, ALICE_BALANCE, 0, proof),
      )
        .to.emit(rollup, "Withdrawn")
        .withArgs(batchId, alice.address, ALICE_BALANCE);

      expect(await rollup.withdrawnAmount(alice.address)).to.equal(ALICE_BALANCE);
      expect(await rollup.totalWithdrawn()).to.equal(
        ALICE_BALANCE * 10n ** 12n,
      );
      // v2 withdrawals do NOT touch the L1 deposit ledger.
      expect(await rollup.deposits(alice.address)).to.equal(ethers.parseEther("1"));
      expect(await rollup.totalDeposited()).to.equal(ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(await rollup.getAddress())).to.equal(
        ethers.parseEther("1") - ALICE_BALANCE * 10n ** 12n,
      );
    });

    it("changes the withdrawer's ether balance by the withdrawn amount", async function () {
      const tree = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batchId = await settleRoot(tree.root);
      const proof = tree.proofs[alice.address.toLowerCase()] as string[];
      await expect(
        rollup
          .connect(alice)
          .withdraw(batchId, alice.address, ALICE_BALANCE, 0, proof),
      ).to.changeEtherBalance(alice, ALICE_BALANCE * 10n ** 12n);
    });

    it("works with a single-leaf tree (empty proof)", async function () {
      const tree = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
      ]);
      expect(tree.proofs[alice.address.toLowerCase()]).to.deep.equal([]);
      const batchId = await settleRoot(tree.root);
      await expect(
        rollup.connect(alice).withdraw(batchId, alice.address, ALICE_BALANCE, 0, []),
      )
        .to.emit(rollup, "Withdrawn")
        .withArgs(batchId, alice.address, ALICE_BALANCE);
      expect(await rollup.withdrawnAmount(alice.address)).to.equal(ALICE_BALANCE);
    });

    it("reverts on a tampered proof element", async function () {
      const tree = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batchId = await settleRoot(tree.root);
      const proof = [...(tree.proofs[alice.address.toLowerCase()] as string[])];
      proof[0] = ethers.keccak256(ethers.toUtf8Bytes("tampered"));
      await expect(
        rollup
          .connect(alice)
          .withdraw(batchId, alice.address, ALICE_BALANCE, 0, proof),
      ).to.be.revertedWithCustomError(rollup, "InvalidMerkleProof");
    });

    it("reverts when the proof belongs to another account", async function () {
      const tree = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batchId = await settleRoot(tree.root);
      const bobsProof = tree.proofs[bob.address.toLowerCase()] as string[];
      await expect(
        rollup
          .connect(alice)
          .withdraw(batchId, alice.address, ALICE_BALANCE, 0, bobsProof),
      ).to.be.revertedWithCustomError(rollup, "InvalidMerkleProof");
    });

    it("reverts when the claimed balance does not match the leaf", async function () {
      const tree = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batchId = await settleRoot(tree.root);
      const proof = tree.proofs[alice.address.toLowerCase()] as string[];
      await expect(
        rollup
          .connect(alice)
          .withdraw(batchId, alice.address, ALICE_BALANCE + 1n, 0, proof),
      ).to.be.revertedWithCustomError(rollup, "InvalidMerkleProof");
    });

    it("reverts when the claimed nonce does not match the leaf", async function () {
      const tree = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 3 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batchId = await settleRoot(tree.root);
      const proof = tree.proofs[alice.address.toLowerCase()] as string[];
      await expect(
        rollup
          .connect(alice)
          .withdraw(batchId, alice.address, ALICE_BALANCE, 2, proof),
      ).to.be.revertedWithCustomError(rollup, "InvalidMerkleProof");
    });

    it("reverts when msg.sender is not the account", async function () {
      const tree = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batchId = await settleRoot(tree.root);
      const proof = tree.proofs[alice.address.toLowerCase()] as string[];
      // Bob presents Alice's valid proof for Alice's account — the
      // contract still refuses: only the account owner withdraws.
      await expect(
        rollup
          .connect(bob)
          .withdraw(batchId, alice.address, ALICE_BALANCE, 0, proof),
      )
        .to.be.revertedWithCustomError(rollup, "NotAccountOwner")
        .withArgs(bob.address, alice.address);
    });

    it("reverts on a second withdrawal against the same batch (amount zero)", async function () {
      const tree = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batchId = await settleRoot(tree.root);
      const proof = tree.proofs[alice.address.toLowerCase()] as string[];
      await rollup
        .connect(alice)
        .withdraw(batchId, alice.address, ALICE_BALANCE, 0, proof);
      await expect(
        rollup
          .connect(alice)
          .withdraw(batchId, alice.address, ALICE_BALANCE, 0, proof),
      ).to.be.revertedWithCustomError(rollup, "ZeroWithdraw");
      expect(await rollup.totalWithdrawn()).to.equal(ALICE_BALANCE * 10n ** 12n);
    });

    it("pays only the difference against a later batch with a higher balance", async function () {
      const tree0 = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batch0 = await settleRoot(tree0.root);
      const proof0 = tree0.proofs[alice.address.toLowerCase()] as string[];
      await rollup
        .connect(alice)
        .withdraw(batch0, alice.address, ALICE_BALANCE, 0, proof0);

      const HIGHER = 150_000n;
      const tree1 = treeFor([
        { account: alice.address, balance: HIGHER, nonce: 1 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batch1 = await settleRoot(tree1.root);
      const proof1 = tree1.proofs[alice.address.toLowerCase()] as string[];
      await expect(
        rollup.connect(alice).withdraw(batch1, alice.address, HIGHER, 1, proof1),
      )
        .to.emit(rollup, "Withdrawn")
        .withArgs(batch1, alice.address, HIGHER - ALICE_BALANCE);
      expect(await rollup.withdrawnAmount(alice.address)).to.equal(HIGHER);
      expect(await rollup.totalWithdrawn()).to.equal(HIGHER * 10n ** 12n);
    });

    it("reverts against a later batch with a lower balance", async function () {
      const tree0 = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batch0 = await settleRoot(tree0.root);
      const proof0 = tree0.proofs[alice.address.toLowerCase()] as string[];
      await rollup
        .connect(alice)
        .withdraw(batch0, alice.address, ALICE_BALANCE, 0, proof0);

      const LOWER = 40_000n;
      const tree1 = treeFor([
        { account: alice.address, balance: LOWER, nonce: 1 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const batch1 = await settleRoot(tree1.root);
      const proof1 = tree1.proofs[alice.address.toLowerCase()] as string[];
      await expect(
        rollup.connect(alice).withdraw(batch1, alice.address, LOWER, 1, proof1),
      ).to.be.revertedWithCustomError(rollup, "ZeroWithdraw");
    });

    it("reverts for an unknown batch id", async function () {
      const tree = treeFor([
        { account: alice.address, balance: ALICE_BALANCE, nonce: 0 },
        { account: bob.address, balance: BOB_BALANCE, nonce: 0 },
      ]);
      const proof = tree.proofs[alice.address.toLowerCase()] as string[];
      await expect(
        rollup.connect(alice).withdraw(0, alice.address, ALICE_BALANCE, 0, proof),
      )
        .to.be.revertedWithCustomError(rollup, "BatchNotFound")
        .withArgs(0);
    });
  });

  describe("getBatch", function () {
    it("reverts for a missing batch", async function () {
      await expect(rollup.getBatch(0))
        .to.be.revertedWithCustomError(rollup, "BatchNotFound")
        .withArgs(0);
      await allowNextBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1);
      await rollup
        .connect(sequencer)
        .submitBatch(STATE_ROOT_1, TX_DATA_1, ENC_DATA_1, DUMMY_SIGNATURE);
      await expect(rollup.getBatch(1))
        .to.be.revertedWithCustomError(rollup, "BatchNotFound")
        .withArgs(1);
    });
  });
});
