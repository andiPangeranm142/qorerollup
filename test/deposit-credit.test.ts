/**
 * deposit-credit.test.ts - negative tests for the deposit-credit path
 * (src/lib/deposits.ts verification helpers). No chain involved: logs
 * are fixtures.
 *
 * Two levels are covered, as the audit requires:
 *  - watcher/sequencer level: `matchDepositClaims` (the sequencer runs
 *    it before every settle, including dry runs, so a tampered
 *    deposits.json can never reach a batch) and `checkCreditedTotal`
 *    (the watcher refuses to write its file when the credited total
 *    exceeds the chain's totalDeposited).
 *  - watchtower level: the same `matchDepositClaims` over the batch
 *    files (check (e)), plus `verifyDepositTotals` and
 *    `checkDepositLedgerConsistency` (check (f)).
 *
 * The two headline negative cases: a FAKE CREDIT (a claim with no
 * on-chain Deposited event at all) and a CREDIT EXCEEDING ITS DEPOSIT
 * (a claim larger than the L1 deposit supporting it) MUST fail at both
 * levels.
 *
 * Run: npx hardhat test test/deposit-credit.test.ts
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import type { Address, Hex } from "viem";
import {
  checkCreditedTotal,
  checkDepositLedgerConsistency,
  matchDepositClaims,
  verifyDepositTotals,
  type DepositClaim,
  type DepositRecord,
  type DepositedLog,
  type DepositsFile,
} from "../src/lib/deposits";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const CHAIN_ID = 9800;

const TX1 = ("0x" + "aa".repeat(32)) as Hex;
const TX2 = ("0x" + "bb".repeat(32)) as Hex;
const TX3 = ("0x" + "cc".repeat(32)) as Hex;
const NOW = "2026-11-17T12:00:00.000Z";

const UQOR = 10n ** 12n;

function log(overrides: Partial<DepositedLog> = {}): DepositedLog {
  return {
    depositor: ALICE.toLowerCase(),
    amountWei: 300000n * UQOR,
    tx: TX1.toLowerCase(),
    block: 10250139,
    logIndex: 0,
    ...overrides,
  };
}

function claim(overrides: Partial<DepositClaim> = {}): DepositClaim {
  return {
    depositor: ALICE,
    amountUqor: "300000",
    tx: TX1,
    block: 10250139,
    source: "batch #0",
    ...overrides,
  };
}

function record(overrides: Partial<DepositRecord> = {}): DepositRecord {
  return {
    depositor: ALICE,
    amountUqor: "300000",
    amountWei: (300000n * UQOR).toString(),
    tx: TX1,
    block: 10250139,
    logIndex: 0,
    status: "pending",
    creditedInBatch: null,
    recordedAt: NOW,
    ...overrides,
  };
}

function file(deposits: DepositRecord[] = []): DepositsFile {
  return {
    network: "qorechain-diana",
    chainId: CHAIN_ID,
    contract: CONTRACT,
    lastProcessedBlock: 10250139,
    deposits,
  };
}

describe("matchDepositClaims — watcher/sequencer + watchtower level", () => {
  it("accepts claims that match their logs exactly (with logIndex)", () => {
    const failures = matchDepositClaims(
      [claim({ logIndex: 0 }), claim({ depositor: BOB, amountUqor: "100000", tx: TX2, block: 10250200, logIndex: 0, source: "batch #3" })],
      [log(), log({ depositor: BOB.toLowerCase(), amountWei: 100000n * UQOR, tx: TX2.toLowerCase(), block: 10250200 })],
    );
    expect(failures).to.deep.equal([]);
  });

  it("accepts a claim without logIndex (batch-file style) matching by tx", () => {
    const failures = matchDepositClaims([claim()], [log()]);
    expect(failures).to.deep.equal([]);
  });

  it("matches two deposits in the same tx by logIndex", () => {
    const failures = matchDepositClaims(
      [
        claim({ logIndex: 0 }),
        claim({ amountUqor: "100000", logIndex: 1, source: "batch #1" }),
      ],
      [log(), log({ amountWei: 100000n * UQOR, logIndex: 1 })],
    );
    expect(failures).to.deep.equal([]);
  });

  it("NEGATIVE: a fake credit — no on-chain event for the tx — FAILS", () => {
    const failures = matchDepositClaims(
      [claim({ tx: TX3, source: "batch #3" })],
      [log()],
    );
    expect(failures).to.have.length(1);
    expect(failures[0].message).to.match(/no Deposited event on-chain \(fake credit\)/);
    expect(failures[0].claim.tx).to.equal(TX3);
    expect(failures[0].message).to.match(/^batch #3: /);
  });

  it("NEGATIVE: a credit EXCEEDING its supporting deposit FAILS", () => {
    const failures = matchDepositClaims(
      [claim({ amountUqor: "300001", source: "batch #3" })],
      [log()],
    );
    expect(failures).to.have.length(1);
    expect(failures[0].message).to.match(/claims 300001 uqor, but the supporting L1 deposit .* is only 300000 uqor/);
    expect(failures[0].message).to.match(/EXCEEDS its deposit/);
  });

  it("NEGATIVE: a credit smaller than its deposit FAILS (exactness — no partial credits)", () => {
    const failures = matchDepositClaims(
      [claim({ amountUqor: "299999" })],
      [log()],
    );
    expect(failures).to.have.length(1);
    expect(failures[0].message).to.match(/must equal its deposit exactly/);
  });

  it("NEGATIVE: a claim naming the wrong depositor FAILS", () => {
    const failures = matchDepositClaims(
      [claim({ depositor: BOB })],
      [log()],
    );
    expect(failures).to.have.length(1);
    expect(failures[0].message).to.match(/names depositor .* but the on-chain event .* names/);
  });

  it("NEGATIVE: a claim naming the wrong block FAILS", () => {
    const failures = matchDepositClaims(
      [claim({ block: 10250140 })],
      [log()],
    );
    expect(failures).to.have.length(1);
    expect(failures[0].message).to.match(/claims block 10250140, but the on-chain event .* is in block 10250139/);
  });

  it("NEGATIVE: two claims against one log — the second is a DOUBLE-CREDIT and FAILS", () => {
    const failures = matchDepositClaims(
      [
        claim({ logIndex: 0, source: "batch #0" }),
        claim({ logIndex: 0, source: "batch #3" }),
      ],
      [log()],
    );
    expect(failures).to.have.length(1);
    expect(failures[0].message).to.match(/already claimed by batch #0 \(double-credit\)/);
    expect(failures[0].claim.source).to.equal("batch #3");
  });

  it("NEGATIVE: two logIndex-less claims against one tx with one log — the second FAILS", () => {
    const failures = matchDepositClaims(
      [claim({ source: "batch #0" }), claim({ source: "batch #3" })],
      [log()],
    );
    expect(failures).to.have.length(1);
    expect(failures[0].message).to.match(/double-credit/);
  });
});

describe("verifyDepositTotals — watchtower level (check f)", () => {
  it("accepts totals within the L1 support", () => {
    const failures = verifyDepositTotals(
      [
        { depositor: ALICE, amountUqor: "300000" },
        { depositor: BOB, amountUqor: "100000" },
      ],
      [
        log(),
        log({ depositor: BOB.toLowerCase(), amountWei: 100000n * UQOR, tx: TX2.toLowerCase(), block: 10250200 }),
      ],
      400000n,
    );
    expect(failures).to.deep.equal([]);
  });

  it("NEGATIVE: aggregate credited total above totalDeposited FAILS", () => {
    const failures = verifyDepositTotals(
      [
        { depositor: ALICE, amountUqor: "300000" },
        { depositor: BOB, amountUqor: "100001" },
      ],
      [
        log(),
        log({ depositor: BOB.toLowerCase(), amountWei: 100000n * UQOR, tx: TX2.toLowerCase(), block: 10250200 }),
      ],
      400000n,
    );
    expect(failures.length).to.be.at.least(1);
    expect(failures.join(" ")).to.match(/total credited deposits \(400001 uqor\) exceed .* totalDeposited \(400000 uqor\)/);
  });

  it("NEGATIVE: one depositor credited above THEIR OWN L1 deposits FAILS even when the aggregate is fine", () => {
    const failures = verifyDepositTotals(
      [
        { depositor: ALICE, amountUqor: "400000" },
        { depositor: BOB, amountUqor: "100000" },
      ],
      [
        log(),
        log({ depositor: BOB.toLowerCase(), amountWei: 300000n * UQOR, tx: TX2.toLowerCase(), block: 10250200 }),
      ],
      600000n,
    );
    expect(failures).to.have.length(1);
    expect(failures[0]).to.match(/is credited 400000 uqor but its L1 deposits total only 300000 uqor/);
    expect(failures[0]).to.match(/exceeds the supporting deposits/);
  });

  it("a non-whole-uqor L1 deposit supports nothing", () => {
    // ALICE deposited 100000 uqor + 1 wei; the 1 wei can never be
    // credited, so crediting 100001 uqor must fail per-depositor even
    // though the aggregate (totalDeposited truncates to 100001 uqor)
    // would still pass.
    const failures = verifyDepositTotals(
      [{ depositor: ALICE, amountUqor: "100001" }],
      [
        log({ amountWei: 100000n * UQOR }),
        log({ amountWei: 1n, tx: TX2.toLowerCase(), block: 10250200 }),
      ],
      100001n,
    );
    expect(failures).to.have.length(1);
    expect(failures[0]).to.match(/is credited 100001 uqor but its L1 deposits total only 100000 uqor/);
  });

  it("NEGATIVE: an account with no L1 deposits credited at all FAILS", () => {
    const failures = verifyDepositTotals(
      [{ depositor: BOB, amountUqor: "1" }],
      [log()],
      300000n,
    );
    expect(failures).to.have.length(1);
    expect(failures[0]).to.match(/is credited 1 uqor but its L1 deposits total only 0 uqor/);
  });
});

describe("checkCreditedTotal — watcher level", () => {
  it("returns null when the credited total is within totalDeposited", () => {
    const f = file([
      record({ tx: TX1, amountUqor: "300000", status: "genesis" }),
      record({ tx: TX2, amountUqor: "100000", status: "pending" }),
    ]);
    expect(checkCreditedTotal(f, ["pending", "settled", "genesis"], 400000n)).to.equal(null);
  });

  it("NEGATIVE: returns a failure when the credited total exceeds totalDeposited", () => {
    const f = file([
      record({ tx: TX1, amountUqor: "300000", status: "genesis" }),
      record({ tx: TX2, amountUqor: "100000", status: "pending" }),
    ]);
    const failure = checkCreditedTotal(f, ["pending", "settled", "genesis"], 350000n);
    expect(failure).to.match(/credited deposits total 400000 uqor but .* totalDeposited is only 350000 uqor/);
    expect(failure).to.match(/claims more than the chain ever received/);
  });
});

describe("checkDepositLedgerConsistency — watchtower level (check f)", () => {
  it("accepts a consistent ledger: genesis + settled-by-3 + the batch claim", () => {
    const failures = checkDepositLedgerConsistency(
      [
        record({ tx: TX1, amountUqor: "300000", status: "genesis", creditedInBatch: null }),
        record({ tx: TX2, amountUqor: "100000", status: "settled", creditedInBatch: 3, block: 10250200 }),
      ],
      [{ batchId: 3, tx: TX2 }],
    );
    expect(failures).to.deep.equal([]);
  });

  it("NEGATIVE: a settled record its batch does not claim FAILS", () => {
    const failures = checkDepositLedgerConsistency(
      [record({ tx: TX2, amountUqor: "100000", status: "settled", creditedInBatch: 3 })],
      [],
    );
    expect(failures).to.have.length(1);
    expect(failures[0]).to.match(/marked settled by batch #3, but batch #3 does not claim it/);
  });

  it("NEGATIVE: a settled record naming the wrong batch FAILS on both sides", () => {
    const failures = checkDepositLedgerConsistency(
      [record({ tx: TX2, amountUqor: "100000", status: "settled", creditedInBatch: 3 })],
      [{ batchId: 2, tx: TX2 }],
    );
    expect(failures).to.have.length(2);
    expect(failures.join(" ")).to.match(/marked settled by batch #3, but batch #3 does not claim it/);
    expect(failures.join(" ")).to.match(/batch #2 claims deposit .* but deposits\.json marks it settled \(creditedInBatch 3\)/);
  });

  it("NEGATIVE: a batch claim with no deposits.json record FAILS", () => {
    const failures = checkDepositLedgerConsistency(
      [record({ tx: TX1, status: "genesis" })],
      [{ batchId: 3, tx: TX2 }],
    );
    expect(failures).to.have.length(1);
    expect(failures[0]).to.match(/batch #3 claims deposit .* but deposits\.json has no record of it/);
  });

  it("NEGATIVE: a batch claim whose record is still pending FAILS", () => {
    const failures = checkDepositLedgerConsistency(
      [record({ tx: TX2, status: "pending", creditedInBatch: null })],
      [{ batchId: 3, tx: TX2 }],
    );
    expect(failures).to.have.length(1);
    expect(failures[0]).to.match(/marks it pending \(creditedInBatch null\)/);
  });

  it("genesis records are exempt — no batch claim is needed for them", () => {
    const failures = checkDepositLedgerConsistency(
      [record({ tx: TX1, status: "genesis", creditedInBatch: null })],
      [],
    );
    expect(failures).to.deep.equal([]);
  });
});
