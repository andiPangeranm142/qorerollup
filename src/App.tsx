import { useEffect, useState } from "react";
import { createPublicClient, http } from "viem";

import {
  CONTRACT_ADDRESS,
  EVM_RPC_URL,
  EXPLORER_URL,
  GITHUB_REPO,
  PROJECT_PAGE,
  SEQUENCER_ADDRESS,
  TESTNET_CHAIN_ID,
  explorerAddress,
  explorerBlock,
  explorerTx,
} from "./config.js";
import { EVIDENCE, type BatchSummary } from "./evidence.js";

/**
 * Minimal ABI for the read-only dashboard: the three cumulative counters,
 * the per-address deposit ledger, and the per-batch record.
 */
const ABI = [
  {
    type: "function",
    name: "batchCount",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalDeposited",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalWithdrawn",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "deposits",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getBatch",
    inputs: [{ name: "batchId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "stateRoot", type: "bytes32" },
          { name: "txDataCommitment", type: "bytes32" },
          { name: "encryptedDataHash", type: "bytes32" },
          { name: "timestamp", type: "uint256" },
          { name: "receiptHash", type: "bytes32" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

const DIANA = {
  id: TESTNET_CHAIN_ID,
  name: "QoreChain Diana Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC_URL] } },
} as const;

const client = createPublicClient({ chain: DIANA, transport: http(EVM_RPC_URL) });

/** 1 uqor = 10^12 wei; 1 QOR = 10^6 uqor. */
const WEI_PER_UQOR = 10n ** 12n;

function weiToQor(wei: bigint): string {
  const uqor = wei / WEI_PER_UQOR;
  return uqorToQor(uqor);
}

function uqorToQor(uqor: bigint | string): string {
  const v = typeof uqor === "string" ? BigInt(uqor) : uqor;
  const whole = v / 1_000_000n;
  const frac = v % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

function shorten(hash: string, head = 10, tail = 8): string {
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function formatUnix(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

type LiveBatch = {
  stateRoot: string;
  txDataCommitment: string;
  encryptedDataHash: string;
  timestamp: bigint;
  receiptHash: string;
};

type LiveState = {
  batchCount: bigint;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  deployerDeposit: bigint;
  batches: LiveBatch[];
} | null;

function useLiveChain(): { live: LiveState; status: "loading" | "live" | "fallback" } {
  const [live, setLive] = useState<LiveState>(null);
  const [status, setStatus] = useState<"loading" | "live" | "fallback">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [batchCount, totalDeposited, totalWithdrawn, deployerDeposit] = await Promise.all([
          client.readContract({ address: CONTRACT_ADDRESS, abi: ABI, functionName: "batchCount" }),
          client.readContract({ address: CONTRACT_ADDRESS, abi: ABI, functionName: "totalDeposited" }),
          client.readContract({ address: CONTRACT_ADDRESS, abi: ABI, functionName: "totalWithdrawn" }),
          client.readContract({
            address: CONTRACT_ADDRESS,
            abi: ABI,
            functionName: "deposits",
            args: [SEQUENCER_ADDRESS],
          }),
        ]);
        // viem decodes a struct return as an object with NAMED keys only —
        // tuple-index access (r[0]) is undefined.
        const batches = await Promise.all(
          Array.from({ length: Number(batchCount) }, async (_, i) => {
            const r = await client.readContract({
              address: CONTRACT_ADDRESS,
              abi: ABI,
              functionName: "getBatch",
              args: [BigInt(i)],
            });
            return {
              stateRoot: r.stateRoot,
              txDataCommitment: r.txDataCommitment,
              encryptedDataHash: r.encryptedDataHash,
              timestamp: r.timestamp,
              receiptHash: r.receiptHash,
            };
          }),
        );
        if (!cancelled) {
          setLive({ batchCount, totalDeposited, totalWithdrawn, deployerDeposit, batches });
          setStatus("live");
        }
      } catch {
        // The public RPC sends no CORS headers, so on a static host the
        // browser cannot read it directly — fall back to the verified
        // evidence file and say so.
        if (!cancelled) setStatus("fallback");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { live, status };
}

function HashLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="hash" href={explorerTx(hash)} target="_blank" rel="noreferrer" title={hash}>
      {label ?? shorten(hash)}
    </a>
  );
}

function BatchCard({ batch, liveBatch }: { batch: BatchSummary; liveBatch?: LiveBatch }) {
  const matches =
    liveBatch === undefined
      ? null
      : liveBatch.stateRoot.toLowerCase() === batch.stateRoot.toLowerCase() &&
        liveBatch.receiptHash.toLowerCase() === batch.receiptHash.toLowerCase();
  return (
    <article className="batch-card" data-testid={`batch-${batch.batchId}`}>
      <header>
        <h3>Batch #{batch.batchId}</h3>
        <span className="pill">
          {batch.txCount} tx{batch.txCount === 1 ? "" : "s"}
        </span>
        {matches === true && <span className="pill ok">✓ matches on-chain getBatch</span>}
        {matches === false && <span className="pill bad">✗ differs from on-chain getBatch</span>}
      </header>
      <dl>
        <div>
          <dt>State root</dt>
          <dd className="mono">{batch.stateRoot}</dd>
        </div>
        <div>
          <dt>Tx-data commitment</dt>
          <dd className="mono">{batch.txDataCommitment}</dd>
        </div>
        <div>
          <dt>Encrypted-data hash (ML-KEM-1024)</dt>
          <dd className="mono">{batch.encryptedDataHash}</dd>
        </div>
        <div>
          <dt>Receipt hash</dt>
          <dd className="mono">{batch.receiptHash}</dd>
        </div>
        <div>
          <dt>Signed digest</dt>
          <dd className="mono">{batch.digest}</dd>
        </div>
        <div>
          <dt>ML-DSA-87 signature</dt>
          <dd>{batch.signatureBytes.toLocaleString("en-US")} bytes, verified on-chain via pqcVerify</dd>
        </div>
        <div>
          <dt>Encrypted payload</dt>
          <dd>
            {batch.kemCiphertextBytes.toLocaleString("en-US")}-byte ML-KEM-1024 ciphertext +{" "}
            {batch.sealedBlobBytes.toLocaleString("en-US")}-byte AES-256-GCM sealed blob
          </dd>
        </div>
        <div>
          <dt>Transactions</dt>
          <dd>
            <ul className="tx-list">
              {batch.txs.map((t, i) => (
                <li key={i} className="mono">
                  {shorten(t.from, 8, 6)} → {shorten(t.to, 8, 6)} ·{" "}
                  {Number(t.amountUqor).toLocaleString("en-US")} uqor ({uqorToQor(t.amountUqor)} QOR)
                  · nonce {t.nonce}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Settled</dt>
          <dd>
            {formatTime(batch.settledAt)}
            {liveBatch && <> · on-chain timestamp {formatUnix(liveBatch.timestamp)}</>}
          </dd>
        </div>
        <div>
          <dt>Submit tx</dt>
          <dd>
            <HashLink hash={batch.cosmosTx} label={`EVM ${shorten(batch.submitTx)}`} /> · block{" "}
            <a href={explorerBlock(batch.block)} target="_blank" rel="noreferrer">
              {batch.block.toLocaleString("en-US")}
            </a>
          </dd>
        </div>
        <div>
          <dt>Cosmos tx</dt>
          <dd>
            <HashLink hash={batch.cosmosTx} />
          </dd>
        </div>
      </dl>
    </article>
  );
}

export function App() {
  const { live, status } = useLiveChain();
  const t = EVIDENCE.totals;
  const batchCount = live ? Number(live.batchCount) : t.batchCount;
  const deposited = live ? weiToQor(live.totalDeposited) : uqorToQor(t.totalDepositedUqor);
  const withdrawn = live ? weiToQor(live.totalWithdrawn) : uqorToQor(t.totalWithdrawnUqor);
  const deployerDeposit = live
    ? weiToQor(live.deployerDeposit)
    : uqorToQor(t.deployerDepositUqor);
  const sourceLabel =
    status === "live"
      ? "Live — read from the Diana testnet just now"
      : status === "loading"
        ? "Reading the chain…"
        : "Live read unavailable from this host (no CORS on the public RPC) — showing the verified evidence file";

  const latest = EVIDENCE.watchtower.latest;
  const okCount = latest.results.filter((r) => r.ok).length;
  const tamper = EVIDENCE.watchtower.tamperDemo;
  const mw = EVIDENCE.merkleWithdraw;
  // Independent checks the tampered batch failed (8 in the v2 tamper demo:
  // file-vs-chain root, replayed root, leaves-recomputed root, all four
  // leaf proofs, decrypted payload).
  const tamperFailures = tamper?.results.find((r) => !r.ok)?.failures.length ?? 0;

  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">QoreChain Developer Fest · Protocol Builders · Diana testnet</p>
        <h1>QoreRollup</h1>
        <p className="lede">
          A minimal post-quantum rollup: an off-chain sequencer batches transactions, signs each
          batch with ML-DSA-87, and settles it on a contract that verifies the signature on-chain
          via the pqcVerify precompile. Batch payloads are sealed with ML-KEM-1024, withdrawals
          are proven with Merkle proofs against settled state roots — with no sequencer help —
          and a watchtower re-verifies every batch.
        </p>
        <div className="contract-box" data-testid="contract">
          <span>Settlement contract (chain id {EVIDENCE.chainId})</span>
          <a href={EVIDENCE.explorerContract} target="_blank" rel="noreferrer" className="mono big">
            {EVIDENCE.contract}
          </a>
          <span className="links">
            <a href={EVIDENCE.explorerContract} target="_blank" rel="noreferrer">
              Explorer ↗
            </a>{" "}
            ·{" "}
            <a href={EVIDENCE.explorerDeployTx} target="_blank" rel="noreferrer">
              Deploy tx ↗
            </a>{" "}
            ·{" "}
            <a href={explorerAddress(EVIDENCE.deployer)} target="_blank" rel="noreferrer">
              Sequencer {shorten(EVIDENCE.deployer)} ↗
            </a>{" "}
            ·{" "}
            <a href={GITHUB_REPO} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>{" "}
            ·{" "}
            <a href={PROJECT_PAGE} target="_blank" rel="noreferrer">
              Project page ↗
            </a>
          </span>
        </div>
      </header>

      <section className="stats" data-testid="live-stats">
        <h2>On-chain state</h2>
        <p className="source">{sourceLabel}</p>
        <div className="stat-grid">
          <div className="stat" data-testid="batch-count">
            <span className="stat-value">{batchCount}</span>
            <span className="stat-label">batches settled (batchCount)</span>
          </div>
          <div className="stat" data-testid="total-deposited">
            <span className="stat-value">{deposited} QOR</span>
            <span className="stat-label">total deposited</span>
          </div>
          <div className="stat" data-testid="total-withdrawn">
            <span className="stat-value">{withdrawn} QOR</span>
            <span className="stat-label">total withdrawn</span>
          </div>
          <div className="stat" data-testid="deployer-deposit">
            <span className="stat-value">{deployerDeposit} QOR</span>
            <span className="stat-label">deployer deposit remaining</span>
          </div>
        </div>
      </section>

      <section data-testid="batches">
        <h2>Settled batches</h2>
        <p>
          Every batch carries a 4,627-byte ML-DSA-87 signature, verified on-chain against the
          sequencer&apos;s registered key before the state root is recorded. Click any submit tx to
          see it on the explorer.
        </p>
        <div className="batch-list">
          {EVIDENCE.batches.map((b) => (
            <BatchCard
              key={b.batchId}
              batch={b}
              liveBatch={live?.batches[b.batchId]}
            />
          ))}
        </div>
      </section>

      <section data-testid="full-cycle">
        <h2>Full cycle — deposit → batches → Merkle withdrawal → reverted attacks</h2>
        <p>Every step below is a real transaction on the Diana testnet (17 Nov 2026).</p>
        <ol className="cycle">
          <li>
            <strong>Seed state</strong> — operator-seeded genesis funding: deployer credited{" "}
            {Number(EVIDENCE.cycle.seed?.amountUqor ?? "0").toLocaleString("en-US")} uqor in the
            rollup state, backed by the 0.3 QOR L1 deposit below. L1 deposits are not
            auto-credited — a documented demo gap (see THREAT_MODEL.md §4).
          </li>
          <li>
            <strong>Deposit 0.3 QOR</strong> —{" "}
            <HashLink hash={EVIDENCE.cycle.deposit.cosmosTx} label={shorten(EVIDENCE.cycle.deposit.tx)} />{" "}
            · block {EVIDENCE.cycle.deposit.block.toLocaleString("en-US")} ·{" "}
            {formatTime(EVIDENCE.cycle.deposit.at)}
          </li>
          <li>
            <strong>Settle batch #0</strong> (1 tx) —{" "}
            <HashLink hash={EVIDENCE.batches[0].cosmosTx} label={shorten(EVIDENCE.batches[0].submitTx)} />{" "}
            · block {EVIDENCE.batches[0].block.toLocaleString("en-US")}
          </li>
          <li>
            <strong>Settle batch #1</strong> (2 txs) —{" "}
            <HashLink hash={EVIDENCE.batches[1].cosmosTx} label={shorten(EVIDENCE.batches[1].submitTx)} />{" "}
            · block {EVIDENCE.batches[1].block.toLocaleString("en-US")}
          </li>
          <li>
            <strong>Settle batch #2</strong> (1 tx) —{" "}
            <HashLink hash={EVIDENCE.batches[2].cosmosTx} label={shorten(EVIDENCE.batches[2].submitTx)} />{" "}
            · block {EVIDENCE.batches[2].block.toLocaleString("en-US")}
          </li>
          <li>
            <strong>
              Merkle-proof withdrawal — {uqorToQor(EVIDENCE.cycle.withdraw.amountUqor)} QOR, no
              sequencer
            </strong>{" "}
            — the independent user wallet{" "}
            {mw?.account ? (
              <>
                <a
                  href={explorerAddress(mw.account)}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                >
                  {shorten(mw.account)}
                </a>{" "}
              </>
            ) : null}
            proved its{" "}
            {Number(mw?.amountUqor ?? EVIDENCE.cycle.withdraw.amountUqor).toLocaleString("en-US")}{" "}
            uqor balance against batch #{mw?.batchId ?? "—"}&apos;s state root with a{" "}
            {mw?.proofSteps ?? "—"}-element Merkle proof and withdrew directly from the contract.{" "}
            <HashLink hash={EVIDENCE.cycle.withdraw.cosmosTx} label={shorten(EVIDENCE.cycle.withdraw.tx)} />{" "}
            · block {EVIDENCE.cycle.withdraw.block.toLocaleString("en-US")}
          </li>
          {EVIDENCE.cycle.reverts.map((r) => (
            <li className="revert" key={r.reason}>
              <strong>
                {r.reason === "double-withdraw"
                  ? "Double-withdraw (attack demo) — REVERTED on-chain"
                  : "Tampered proof (attack demo) — REVERTED on-chain"}
              </strong>{" "}
              —{" "}
              {r.reason === "double-withdraw"
                ? "the same Merkle-proof withdrawal sent again — the cumulative cap already covers the leaf balance. The contract rejected it"
                : "a withdrawal with one flipped hex char in the proof — it no longer verifies against the state root. The contract rejected it"}{" "}
              (<code>{r.error}</code>): receipt status <code>{r.receiptStatus}</code>
              {r.withdrawnBefore !== null && r.withdrawnAfter !== null && (
                <>
                  , cumulative withdrawnAmount stayed at{" "}
                  {Number(r.withdrawnAfter).toLocaleString("en-US")} uqor
                </>
              )}
              .{" "}
              <HashLink hash={r.cosmosTx} label={shorten(r.tx)} /> · block{" "}
              {r.block.toLocaleString("en-US")}
            </li>
          ))}
          <li className="revert">
            <strong>Forged batch — REVERTED on-chain</strong> — a genuine ML-DSA-87 signature over
            the WRONG digest, submitted by the sequencer itself. The contract rejected it (
            <code>InvalidBatchSignature</code>): receipt status{" "}
            <code>{EVIDENCE.cycle.forged.receiptStatus}</code>, batchCount stayed at{" "}
            {EVIDENCE.cycle.forged.batchCountBefore} → {EVIDENCE.cycle.forged.batchCountAfter}.{" "}
            <HashLink hash={EVIDENCE.cycle.forged.cosmosTx} label={shorten(EVIDENCE.cycle.forged.tx)} />{" "}
            · block {EVIDENCE.cycle.forged.block.toLocaleString("en-US")}
          </li>
        </ol>
        <h3>Final rollup balances</h3>
        <table className="balances">
          <thead>
            <tr>
              <th>Account</th>
              <th>Balance (uqor)</th>
              <th>Balance (QOR)</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(EVIDENCE.balances).map(([addr, bal]) => (
              <tr key={addr}>
                <td className="mono">{addr}</td>
                <td>{Number(bal).toLocaleString("en-US")}</td>
                <td>{uqorToQor(bal)}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Total (conserved from the 0.3 QOR deposit)</td>
              <td>
                {Object.values(EVIDENCE.balances)
                  .reduce((a, b) => a + BigInt(b), 0n)
                  .toLocaleString("en-US")}
              </td>
              <td>
                {uqorToQor(
                  Object.values(EVIDENCE.balances).reduce((a, b) => a + BigInt(b), 0n),
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section data-testid="merkle-withdraw">
        <h2>Merkle-proof withdrawal</h2>
        {EVIDENCE.merkleWithdraw ? (
          <>
            <p>
              The user withdraws by presenting a Merkle proof for their balance leaf against a
              settled batch&apos;s state root — directly to the contract, with no sequencer
              involvement. The sequencer cannot block a withdrawal: the proof is verified
              on-chain against the settled root, and a cumulative per-account cap means the
              same leaf can never pay out twice.
            </p>
            <dl className="merkle-details">
              {EVIDENCE.merkleWithdraw.batchId !== null && (
                <div>
                  <dt>Proved against batch</dt>
                  <dd>#{EVIDENCE.merkleWithdraw.batchId}</dd>
                </div>
              )}
              {EVIDENCE.merkleWithdraw.stateRoot && (
                <div>
                  <dt>Batch state root</dt>
                  <dd className="mono">{EVIDENCE.merkleWithdraw.stateRoot}</dd>
                </div>
              )}
              {EVIDENCE.merkleWithdraw.proofSteps !== null && (
                <div>
                  <dt>Merkle proof</dt>
                  <dd>{EVIDENCE.merkleWithdraw.proofSteps} steps</dd>
                </div>
              )}
              {EVIDENCE.merkleWithdraw.amountUqor && (
                <div>
                  <dt>Amount withdrawn</dt>
                  <dd>
                    {Number(EVIDENCE.merkleWithdraw.amountUqor).toLocaleString("en-US")} uqor (
                    {uqorToQor(EVIDENCE.merkleWithdraw.amountUqor)} QOR)
                  </dd>
                </div>
              )}
              {EVIDENCE.merkleWithdraw.account && (
                <div>
                  <dt>Withdrawing account</dt>
                  <dd>
                    <a
                      href={explorerAddress(EVIDENCE.merkleWithdraw.account)}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                    >
                      {EVIDENCE.merkleWithdraw.account}
                    </a>{" "}
                    (independent user wallet — not the sequencer)
                  </dd>
                </div>
              )}
              {EVIDENCE.merkleWithdraw.leaf && (
                <div>
                  <dt>Merkle leaf</dt>
                  <dd className="mono">{EVIDENCE.merkleWithdraw.leaf}</dd>
                </div>
              )}
              {EVIDENCE.merkleWithdraw.proof && (
                <div>
                  <dt>Proof elements</dt>
                  <dd>
                    <ol className="proof-list">
                      {EVIDENCE.merkleWithdraw.proof.map((p) => (
                        <li key={p} className="mono">
                          {p}
                        </li>
                      ))}
                    </ol>
                  </dd>
                </div>
              )}
              {EVIDENCE.merkleWithdraw.withdrawnBefore !== null &&
                EVIDENCE.merkleWithdraw.withdrawnAfter !== null && (
                  <div>
                    <dt>Cumulative withdrawn cap</dt>
                    <dd>
                      {Number(EVIDENCE.merkleWithdraw.withdrawnBefore).toLocaleString("en-US")} →{" "}
                      {Number(EVIDENCE.merkleWithdraw.withdrawnAfter).toLocaleString("en-US")}{" "}
                      uqor — the same leaf can never pay out twice
                    </dd>
                  </div>
                )}
              {EVIDENCE.merkleWithdraw.tx && EVIDENCE.merkleWithdraw.cosmosTx && (
                <div>
                  <dt>Withdrawal tx</dt>
                  <dd>
                    <HashLink
                      hash={EVIDENCE.merkleWithdraw.cosmosTx}
                      label={shorten(EVIDENCE.merkleWithdraw.tx)}
                    />
                    {EVIDENCE.merkleWithdraw.block !== null && (
                      <>
                        {" "}· block{" "}
                        {EVIDENCE.merkleWithdraw.block.toLocaleString("en-US")}
                      </>
                    )}
                  </dd>
                </div>
              )}
              {EVIDENCE.merkleWithdraw.at && (
                <div>
                  <dt>Withdrawn</dt>
                  <dd>{formatTime(EVIDENCE.merkleWithdraw.at)}</dd>
                </div>
              )}
            </dl>
            {EVIDENCE.merkleWithdraw.note && <p>{EVIDENCE.merkleWithdraw.note}</p>}
          </>
        ) : (
          <div className="placeholder">
            <p>
              <strong>Coming in v2 — evidence pending.</strong> The settlement contract is being
              redeployed with Merkle-proof withdrawal: any user will be able to withdraw funds
              by proving their balance against a settled batch&apos;s state root with a Merkle
              proof, without any help from the sequencer. The verified withdrawal (batch,
              state root, proof size, tx) will appear here once the v2 cycle runs.
            </p>
          </div>
        )}
      </section>

      <section data-testid="watchtower">
        <h2>Watchtower</h2>
        <p>
          <code>npm run watchtower</code> re-verifies every batch off-chain: the ML-DSA-87
          signature against the sequencer&apos;s registered key, the state replay, the receipt
          hash, the ML-KEM decrypt check, and the genesis-funding cross-check against the
          contract&apos;s cumulative totalDeposited.
        </p>
        <div className={`watchtower-status ${latest.allOk ? "ok" : "bad"}`}>
          <strong>
            {latest.allOk
              ? `ALL BATCHES OK — ${okCount}/${latest.results.length} batches verified`
              : `VERIFICATION FAILED — ${okCount}/${latest.results.length} batches OK`}
          </strong>
          <span>
            Latest run {formatTime(latest.at)} · decrypt check {latest.decryptCheck}
          </span>
        </div>
        <ul className="watchtower-results">
          {latest.results.map((r) => (
            <li key={r.batchId}>
              Batch #{r.batchId}: {r.ok ? "✓ OK" : `✗ FAIL — ${r.failures.join("; ")}`}
            </li>
          ))}
        </ul>
        {tamper && (
          <div className="tamper-demo">
            <h3>Tamper-catch demo (same day, minutes earlier)</h3>
            <p>{tamper.tampered}</p>
            <ul>
              {tamper.results.map((r) => (
                <li key={r.batchId}>
                  Batch #{r.batchId}:{" "}
                  {r.ok ? "✓ OK" : `✗ FAIL — ${r.failures.join("; ")}`}
                </li>
              ))}
            </ul>
            <p>
              The watchtower failed the tampered batch on {tamperFailures} independent checks and failed the
              next batch on the broken state-root chain. Restoring the file returned ALL BATCHES
              OK. Run log:{" "}
              <a
                href={`${GITHUB_REPO}/blob/main/deployments/watchtower-log.json`}
                target="_blank"
                rel="noreferrer"
              >
                deployments/watchtower-log.json ↗
              </a>
            </p>
          </div>
        )}
      </section>

      <footer>
        <p>
          <strong>Honest limits:</strong> single sequencer, no fraud proofs, operator-seeded
          genesis funding, demo-grade — see{" "}
          <a href={`${GITHUB_REPO}/blob/main/THREAT_MODEL.md`} target="_blank" rel="noreferrer">
            THREAT_MODEL.md ↗
          </a>
          . Read-only dashboard: no wallet connection, no transactions. All numbers come from the
          Diana testnet or the verified evidence in{" "}
          <a href={`${GITHUB_REPO}/tree/main/deployments`} target="_blank" rel="noreferrer">
            deployments/ ↗
          </a>
          .
        </p>
        <p className="muted">
          QoreRollup · QoreChain Developer Fest “Build Before Q-Day” · Protocol Builders ·{" "}
          <a href={EXPLORER_URL} target="_blank" rel="noreferrer">
            explore.qore.network
          </a>{" "}
          (switch to Testnet)
        </p>
      </footer>
    </div>
  );
}
