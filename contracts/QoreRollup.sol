// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IQorePqcKeyStatus — interface for the QoreChain pqcKeyStatus precompile.
/// @notice The live precompile returns FOUR values since chain v3.2.4
///         (registered, algorithmId, pubkey, possessionProven). This was
///         verified against the live Diana precompile with a raw eth_call
///         before QuantumVault was written: a registered account returns
///         2,752 bytes decoding to (true, 1, 2592-byte pubkey, true), and an
///         unregistered account returns (false, 0, empty, false). The
///         qorechain/evm 0.14.0 type definitions still describe only three
///         values — do not trust them over the live chain.
interface IQorePqcKeyStatus {
    /// @return registered       The account has an ML-DSA key registered on chain.
    /// @return algorithmId      Signature algorithm id (1 = ML-DSA-87 / FIPS 204).
    /// @return pubkey           The public key actually registered on chain.
    /// @return possessionProven The account proved possession of the private key
    ///                          at registration time (MsgRegisterPQCKeyV2).
    function pqcKeyStatus(
        address account
    )
        external
        view
        returns (
            bool registered,
            uint8 algorithmId,
            bytes memory pubkey,
            bool possessionProven
        );
}

/// @title IQorePqcVerify — interface for the QoreChain pqcVerify precompile.
/// @notice Verifies an ML-DSA signature against a public key and a message,
///         on chain. Verified live on Diana before QuantumVault was written:
///         a signature produced by the qorechain sdk's pqcSign over a message
///         verifies true, and the same signature over a different message
///         verifies false.
interface IQorePqcVerify {
    /// @return valid True when the signature is a valid ML-DSA signature by
    ///         `pubkey` over `message`.
    function pqcVerify(
        bytes calldata pubkey,
        bytes calldata signature,
        bytes calldata message
    ) external view returns (bool valid);
}

/// @title QoreRollup
/// @notice Settlement contract for QoreRollup, a minimal post-quantum
///         rollup on the QoreChain testnet (qorechain-diana). An off-chain
///         sequencer batches transactions, signs each batch with ML-DSA-87,
///         and settles it here; the contract verifies the signature on chain
///         via the pqcVerify precompile (0x0A01) against the sequencer's
///         REGISTERED public key from the pqcKeyStatus precompile (0x0A02) —
///         never a caller-supplied key. Each batch's state root is the
///         Merkle root over the post-batch balances — one leaf per account,
///         keccak256(abi.encodePacked(account, balance, nonce)) — so any
///         account can withdraw its rollup balance by proving its leaf
///         against a settled batch root, directly, with NO sequencer help.
///         The sequencer cannot block a withdrawal: the user calls
///         `withdraw` themselves with a proof built from the published
///         batch file.
///
///         Post-quantum protection, three layers deep:
///
///         1. CHAIN-GATED WINDOW. Every EVM transaction on QoreChain is only
///            admitted inside a post-quantum authorisation window opened by
///            a hybrid-signed (secp256k1 + ML-DSA-87) native message. A
///            leaked ECDSA key alone cannot send any transaction at all —
///            including a batch submission — because it cannot open a window.
///         2. CONTRACT-VERIFIED KEY. Before accepting a batch, this contract
///            calls the pqcKeyStatus precompile (0x0A02) for the sequencer
///            and requires a registered ML-DSA key whose possession was
///            proven at registration. No key, or an unproven key: revert.
///         3. VERIFIED BATCH SIGNATURE. Every batch must carry an ML-DSA-87
///            signature over the exact batch digest — chain, contract, batch
///            id, state root, transaction-data commitment and encrypted-data
///            hash — verified on chain via the pqcVerify precompile against
///            the registered key. A batch the sequencer never signed cannot
///            settle, and a signature for one batch, chain or contract cannot
///            be replayed anywhere else.
///
///         Honest limits (see README and docs/THREAT_MODEL.md): this is a
///         minimal rollup, not a production L2. There is a SINGLE
///         centralized sequencer — no rotation, no fallback, no forced
///         inclusion, so a dead or malicious sequencer halts the rollup or
///         censors it. There are NO fraud proofs and no validity proofs:
///         the contract trusts the sequencer's state root once the signature
///         checks out, so a compromised sequencer key can settle a false
///         state root (the off-chain watchtower can only detect and alert,
///         not revert) — and a false root could mint rollup balances that
///         are then withdrawable. Withdrawals need the batch data to
///         construct a proof: if ALL batch data were withheld, a user could
///         not prove their balance — mitigated only by the batch files
///         being published in the public repo and checked by the watchtower.
///         L1 deposits are NOT auto-credited into rollup balances (the
///         operator seeds them); the `deposits` mapping is a record of L1
///         deposits only and withdrawals do not consult it. The contract
///         cannot see whether a window is open (native state is not
///         observable from the EVM), so layer 1 is enforced by the chain,
///         not by this contract. Finally, a lost ML-DSA key means the
///         sequencer can never settle another batch — there is no key
///         rotation and no admin.
///
///         v2 note: this contract replaces v1
///         (0x96051b69a7d0e2236a3fe2e51fe33a55367d36c2), whose withdrawals
///         checked the L1 deposit ledger with a per-withdrawal nullifier
///         and whose state root was a plain hash commitment with no
///         inclusion proofs. v2's state root is a Merkle root and
///         withdrawals are proven against it — see `withdraw`.
contract QoreRollup {
    /// @notice The pqcKeyStatus precompile on QoreChain Diana (chain v3.2.4+).
    address public constant PQC_KEY_STATUS_PRECOMPILE =
        0x0000000000000000000000000000000000000a02;

    /// @notice The pqcVerify precompile on QoreChain Diana.
    address public constant PQC_VERIFY_PRECOMPILE =
        0x0000000000000000000000000000000000000a01;

    /// @notice Wei per uqor: 1 QOR = 10^6 uqor = 10^18 wei, so 1 uqor = 10^12 wei.
    uint256 public constant WEI_PER_UQOR = 1e12;

    /// @notice The only account allowed to settle batches. Set once at
    ///         deployment; there is no rotation. On Diana the deployer is
    ///         the sequencer.
    address public immutable sequencer;

    /// @notice One settled batch.
    /// @param stateRoot The batch's post-state Merkle root: one leaf per
    ///        non-zero balance, leaf = keccak256(abi.encodePacked(account,
    ///        balance, nonce)), binary tree with sorted pairs (OpenZeppelin
    ///        MerkleProof convention).
    /// @param txDataCommitment Commitment over the batch's transaction data.
    /// @param encryptedDataHash Hash of the ML-KEM-1024-encrypted batch
    ///        data blob (data availability commitment).
    /// @param timestamp Block timestamp at settlement.
    /// @param receiptHash keccak256("QoreRollup.receipt", chain id,
    ///        contract, batch id, state root, tx-data commitment) — a
    ///        stable receipt identifier the watchtower and frontend can
    ///        recompute and compare.
    struct Batch {
        bytes32 stateRoot;
        bytes32 txDataCommitment;
        bytes32 encryptedDataHash;
        uint256 timestamp;
        bytes32 receiptHash;
    }

    /// @notice Settled batches by id (sequential from 0).
    mapping(uint256 => Batch) private _batches;

    /// @notice How many batches have settled. The next batch settles at
    ///         this id.
    uint256 public batchCount;

    /// @notice QOR each address has deposited (wei). A record of L1
    ///         deposits only — v2 withdrawals do NOT consult this mapping;
    ///         they prove a rollup balance against a batch state root.
    mapping(address => uint256) public deposits;

    /// @notice Cumulative uqor withdrawn per account (Merkle-proof
    ///         withdrawals). A withdrawal pays
    ///         `balance - withdrawnAmount[account]` and then sets
    ///         `withdrawnAmount[account] = balance`, so the total ever
    ///         withdrawn by an account can never exceed the largest leaf
    ///         balance it has ever proven — withdrawing against several
    ///         batch roots cannot double-spend.
    mapping(address => uint256) public withdrawnAmount;

    /// @notice QOR ever deposited (cumulative; never decremented).
    uint256 public totalDeposited;

    /// @notice QOR ever withdrawn (cumulative, wei).
    uint256 public totalWithdrawn;

    /// @notice Emitted for every settled batch.
    event BatchSettled(
        uint256 indexed batchId,
        bytes32 stateRoot,
        bytes32 txDataCommitment,
        bytes32 encryptedDataHash,
        bytes32 receiptHash
    );

    /// @notice Emitted for every deposit.
    event Deposited(address indexed depositor, uint256 amount);

    /// @notice Emitted for every Merkle-proof withdrawal. `amountUqor` is
    ///         the rollup amount withdrawn; the wei paid out is
    ///         `amountUqor * 1e12`.
    event Withdrawn(
        uint256 indexed batchId,
        address indexed account,
        uint256 amountUqor
    );

    /// @notice The caller is not the sequencer.
    error OnlySequencer();
    /// @notice The sequencer has no ML-DSA key registered on chain.
    error PqcKeyNotRegistered(address account);
    /// @notice The sequencer's ML-DSA key was never proven (no proof of
    ///         possession at registration).
    error PossessionNotProven(address account);
    /// @notice The ML-DSA signature did not verify against the sequencer's
    ///         registered key over the batch digest.
    error InvalidBatchSignature();
    /// @notice No batch exists at this id.
    error BatchNotFound(uint256 batchId);
    error ZeroDeposit();
    error TransferFailed();
    /// @notice The proven balance is not larger than what the account
    ///         already withdrew — the withdrawal amount would be zero.
    error ZeroWithdraw();
    /// @notice All three batch hashes are zero — there is nothing to settle.
    error EmptyBatch();
    /// @notice Only the account itself may withdraw its own funds.
    error NotAccountOwner(address caller, address account);
    /// @notice The Merkle proof does not verify against the batch's state root.
    error InvalidMerkleProof();

    /// @notice Deploy the settlement contract.
    /// @param _sequencer The single account allowed to settle batches.
    constructor(address _sequencer) {
        sequencer = _sequencer;
    }

    /// @notice The digest the sequencer must sign for a batch.
    /// @dev Domain-separated: the literal tag, the chain id, this contract,
    ///      the batch id and the three batch hashes. A signature for one
    ///      batch, chain or contract cannot be replayed anywhere else, and
    ///      each batch id is used exactly once, so the digest is
    ///      single-use by construction.
    /// @param batchId The id the batch will settle at (the current
    ///        batchCount).
    /// @param stateRoot The batch's state-root commitment.
    /// @param txDataCommitment The batch's transaction-data commitment.
    /// @param encryptedDataHash The batch's encrypted-data hash.
    /// @return digest keccak256("QoreRollup.batch", chain id, contract,
    ///         batch id, state root, tx-data commitment, encrypted-data hash).
    function batchDigest(
        uint256 batchId,
        bytes32 stateRoot,
        bytes32 txDataCommitment,
        bytes32 encryptedDataHash
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    "QoreRollup.batch",
                    block.chainid,
                    address(this),
                    batchId,
                    stateRoot,
                    txDataCommitment,
                    encryptedDataHash
                )
            );
    }

    /// @notice Settle a batch signed by the sequencer's ML-DSA-87 key.
    /// @dev Only the sequencer may call this. The sequencer's pubkey comes
    ///      from the pqcKeyStatus precompile — the caller cannot substitute
    ///      their own key. The signature is verified via the pqcVerify
    ///      precompile over the packed batch digest for the NEXT batch id
    ///      (the current batchCount), so the sequencer signs knowing exactly
    ///      which id the batch will take.
    /// @param stateRoot The batch's state-root commitment (Merkle root).
    /// @param txDataCommitment The batch's transaction-data commitment.
    /// @param encryptedDataHash The batch's encrypted-data hash.
    /// @param signature An ML-DSA-87 signature, by the sequencer's
    ///        REGISTERED key, over the digest returned by `batchDigest`
    ///        for the next batch id and these three hashes.
    function submitBatch(
        bytes32 stateRoot,
        bytes32 txDataCommitment,
        bytes32 encryptedDataHash,
        bytes calldata signature
    ) external {
        if (msg.sender != sequencer) revert OnlySequencer();
        if (
            stateRoot == bytes32(0) &&
            txDataCommitment == bytes32(0) &&
            encryptedDataHash == bytes32(0)
        ) revert EmptyBatch();

        // Post-quantum gate: registered ML-DSA key with proven possession.
        // The pubkey used for verification is the one REGISTERED on chain.
        (bool registered, , bytes memory pubkey, bool possessionProven) = IQorePqcKeyStatus(
            PQC_KEY_STATUS_PRECOMPILE
        ).pqcKeyStatus(sequencer);
        if (!registered) revert PqcKeyNotRegistered(sequencer);
        if (!possessionProven) revert PossessionNotProven(sequencer);

        uint256 batchId = batchCount;
        bytes32 digest = batchDigest(
            batchId,
            stateRoot,
            txDataCommitment,
            encryptedDataHash
        );
        bool valid = IQorePqcVerify(PQC_VERIFY_PRECOMPILE).pqcVerify(
            pubkey,
            signature,
            abi.encodePacked(digest)
        );
        if (!valid) revert InvalidBatchSignature();

        bytes32 receiptHash = keccak256(
            abi.encodePacked(
                "QoreRollup.receipt",
                block.chainid,
                address(this),
                batchId,
                stateRoot,
                txDataCommitment
            )
        );
        _batches[batchId] = Batch({
            stateRoot: stateRoot,
            txDataCommitment: txDataCommitment,
            encryptedDataHash: encryptedDataHash,
            timestamp: block.timestamp,
            receiptHash: receiptHash
        });
        batchCount += 1;
        emit BatchSettled(
            batchId,
            stateRoot,
            txDataCommitment,
            encryptedDataHash,
            receiptHash
        );
    }

    /// @notice Deposit QOR into the rollup's L1 ledger. Anyone may deposit;
    ///         deposits need no PQC key — only batch settlement is gated.
    ///         Note: deposits are NOT auto-credited into rollup balances
    ///         (the operator seeds them); see THREAT_MODEL.md §4.
    function deposit() external payable {
        if (msg.value == 0) revert ZeroDeposit();
        deposits[msg.sender] += msg.value;
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw rollup funds by proving a leaf against a settled
    ///         batch's Merkle state root — directly, with NO sequencer
    ///         involvement. The caller proves their own balance:
    ///         leaf = keccak256(abi.encodePacked(account, balance, nonce)),
    ///         verified against batches[batchId].stateRoot with the
    ///         sorted-pair rule (OpenZeppelin MerkleProof convention:
    ///         each step hashes the smaller element first; the TypeScript
    ///         side in src/lib/merkle.ts must agree byte-for-byte).
    /// @dev Checks-effects-interactions: the cumulative cap is updated
    ///      before the external call, so reentrancy cannot double-spend.
    ///      The payout is `balance - withdrawnAmount[account]` in uqor
    ///      (converted to wei at 1e12), so the total ever withdrawn by an
    ///      account can never exceed the largest leaf balance it has ever
    ///      proven — withdrawing the same leaf twice pays zero the second
    ///      time, and withdrawing against a later batch with a higher
    ///      balance pays only the difference.
    /// @param batchId The settled batch whose state root the proof targets.
    /// @param account The account withdrawing (must be msg.sender).
    /// @param balance The account's rollup balance (uqor) in that batch.
    /// @param nonce The account's rollup nonce in that batch.
    /// @param proof The Merkle proof for the leaf, bottom-up ([] for a
    ///        single-leaf tree).
    function withdraw(
        uint256 batchId,
        address account,
        uint256 balance,
        uint256 nonce,
        bytes32[] calldata proof
    ) external {
        if (msg.sender != account) revert NotAccountOwner(msg.sender, account);
        if (batchId >= batchCount) revert BatchNotFound(batchId);

        bytes32 computed = keccak256(abi.encodePacked(account, balance, nonce));
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 element = proof[i];
            computed = element < computed
                ? keccak256(abi.encodePacked(element, computed))
                : keccak256(abi.encodePacked(computed, element));
        }
        if (computed != _batches[batchId].stateRoot) revert InvalidMerkleProof();

        uint256 alreadyWithdrawn = withdrawnAmount[account];
        if (balance <= alreadyWithdrawn) revert ZeroWithdraw();
        uint256 amountUqor = balance - alreadyWithdrawn;
        uint256 amountWei = amountUqor * WEI_PER_UQOR;

        withdrawnAmount[account] = balance;
        totalWithdrawn += amountWei;
        emit Withdrawn(batchId, account, amountUqor);

        (bool ok, ) = payable(msg.sender).call{ value: amountWei }("");
        if (!ok) revert TransferFailed();
    }

    /// @notice One settled batch by id.
    /// @param batchId The batch id (sequential from 0).
    function getBatch(uint256 batchId) external view returns (Batch memory) {
        if (batchId >= batchCount) revert BatchNotFound(batchId);
        return _batches[batchId];
    }
}
