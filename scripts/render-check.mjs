/**
 * render-check.mjs - verify the built demo renders without errors.
 *
 * Usage: npm run build, then `npx vite preview --port 4173` in one shell
 * and `node scripts/render-check.mjs [url]` in another. Defaults to the
 * local preview URL. Pass the live GitHub Pages URL to check the deployed
 * site instead.
 *
 * Exits non-zero if the page shows a fatal error, if any console error or
 * page error occurs, or if the expected content is missing. Writes a
 * screenshot to /tmp/qr-render.png.
 *
 * Playwright is not a dependency of this repo: it is resolved from the
 * shared install at ~/workspace/codegeist/video-recorder/node_modules
 * via createRequire (NODE_PATH does not work for ESM imports).
 *
 * Chromium cannot use the VM's egress proxy directly (it resolves only to
 * an IPv6 address, and the proxy MITM-signs TLS with its own CA), so the
 * script runs the same localhost TCP forwarder the video-recorder uses
 * (127.0.0.1:3135 -> proxy IPv6:3128) and launches Chromium through it
 * with ignoreHTTPSErrors. Without this, the app's RPC reads fail with
 * ERR_TUNNEL_CONNECTION_FAILED and the live totals show the fallback.
 *
 * Port 3135 (not the video-recorder's 3129 or qore-vest's 3134): those
 * often collide with other agents' forwarders on this shared VM. Override
 * with QR_FORWARDER_PORT if 3135 is taken.
 */
import { createRequire } from "node:module";
import net from "node:net";
import dns from "node:dns/promises";

const require = createRequire("/home/hatch/workspace/codegeist/video-recorder/package.json");
const { chromium } = require("playwright");

const FORWARDER_PORT = Number(process.env.QR_FORWARDER_PORT ?? 3135);

async function startForwarder(localPort = FORWARDER_PORT) {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY || "";
  const u = new URL(raw);
  const target = await dns.lookup(u.hostname, { family: 6 });
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: target.address, port: Number(u.port) || 3128 });
    client.pipe(upstream);
    upstream.pipe(client);
    const onErr = () => { client.destroy(); upstream.destroy(); };
    client.on("error", onErr);
    upstream.on("error", onErr);
  });
  await new Promise((resolve, reject) => {
    server.listen(localPort, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  return server;
}

const url = process.argv[2] ?? "http://localhost:4173/qorerollup/";
const screenshotPath = process.argv[3] ?? "/tmp/qr-render.png";

const forwarder = await startForwarder();
const browser = await chromium.launch({
  proxy: { server: `http://127.0.0.1:${FORWARDER_PORT}`, bypass: "localhost,127.0.0.1" },
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  ignoreHTTPSErrors: true, // egress proxy MITM-signs TLS (see header)
});
const page = await context.newPage();
const errors = [];
// URLs that answered 404: the watchtower-status fetch is best-effort by
// design (see below), so its 404 needs to be distinguishable from a
// genuinely broken asset.
const notFoundUrls = new Set();
page.on("response", (res) => {
  if (res.status() === 404) notFoundUrls.add(res.url());
});
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("requestfailed", (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText ?? ""}`));

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
// Wait for the app to mount and the live chain read (or its fallback) to
// settle: the stats section renders only after React mounts, and the
// source label flips from "Reading the chain…" once the RPC answers.
await page.waitForSelector('[data-testid="live-stats"]', { timeout: 30000 });
await page.waitForFunction(
  () => !document.body.innerText.includes("Reading the chain…"),
  { timeout: 30000 },
);
// Same for the watchtower-status fetch (live file or embedded fallback):
// the status line must have settled before the screenshot and the checks.
await page.waitForFunction(
  () => !document.body.innerText.includes("Checking the live watchtower status…"),
  { timeout: 30000 },
);
await page.waitForSelector('[data-testid="batch-3"]', { timeout: 30000 });
await page.screenshot({ path: screenshotPath, fullPage: true });

const text = await page.evaluate(() => document.body.innerText);
const batchCards = await page.locator(".batch-card").count(); // not [data-testid^='batch-']: that also matches the batch-count stat
// Read the live-stat values directly (robust against the same number
// appearing elsewhere on the page).
const statValue = async (testid) =>
  (await page.locator(`[data-testid="${testid}"] .stat-value`).innerText()).trim();
const batchCountValue = await statValue("batch-count");
const lastBatchValue = await statValue("last-batch");
const depositedValue = await statValue("total-deposited");
const withdrawnValue = await statValue("total-withdrawn");
const deployerDepositValue = await statValue("deployer-deposit");
const contractBalanceValue = await statValue("contract-balance");
// Every /tx/ link must point at the explorer with a Cosmos hash.
const txHrefs = await page.$$eval('a[href*="/tx/"]', (els) => els.map((a) => a.href));
const batch3DepositCosmosLink = await page
  .locator('[data-testid="batch-3"] a[href*="D1BF023F9C1BCB84831ABDB86DFF3098A257936D6DE103A8DDA281B04DD655D9"]')
  .count();
const checks = {
  "title QoreRollup": text.includes("QoreRollup"),
  "contract address v2": text.includes("0xb54a8bd2dfffa9f3b8a23c3b4e663fe31667d708"),
  "no v1 contract": !text.includes("0x96051b69"),
  "no nullifier text": !text.toLowerCase().includes("nullifier"),
  // Live values, read from the chain at render time — update these when a
  // new batch lands (batches 5–7 settled 18 Nov 2026: 8 / 0.6 / 0.55).
  // The batch CARDS below come from the evidence file (8 batches merged).
  "batchCount 8": batchCountValue === "8",
  "last batch id 7": lastBatchValue === "7",
  "8 batch cards": batchCards === 8,
  "total deposited 0.6 QOR": depositedValue === "0.6 QOR",
  "total withdrawn 0.55 QOR": withdrawnValue === "0.55 QOR",
  "deployer deposit 0.4 QOR": deployerDepositValue === "0.4 QOR",
  "contract balance 0.05 QOR": contractBalanceValue === "0.05 QOR",
  "150 Hardhat tests": text.includes("150 Hardhat tests"),
  "no stale 100 tests": !text.includes("100 tests"),
  "explorer mainnet note": text.includes("defaults to Mainnet") && text.includes("switch to Testnet"),
  "all tx links use cosmos hashes":
    txHrefs.length > 0 &&
    txHrefs.every((h) => /^https:\/\/explore\.qore\.network\/tx\/[0-9A-F]{64}$/.test(h)),
  "auto-deposit section": text.includes("Auto-deposit path"),
  "auto-deposit deposit #2": text.includes("Deposit #2 arrived on L1"),
  "auto-deposit deposit cosmos hash linked": txHrefs.includes(
    "https://explore.qore.network/tx/D1BF023F9C1BCB84831ABDB86DFF3098A257936D6DE103A8DDA281B04DD655D9",
  ),
  "auto-deposit batch #3 settle cosmos hash linked": txHrefs.includes(
    "https://explore.qore.network/tx/E0E7F28A654A162FA5822356C25FD3639A24775367A7E928A12C256508EFA818",
  ),
  "auto-deposit balance change 0.21 to 0.3 QOR": text.includes("0.21 QOR to 0.3 QOR"),
  "auto-deposit deposit-credit check OK":
    text.includes("Deposit-credit check OK") &&
    text.includes("never exceed supporting L1 deposits"),
  "batch #3 card deposit link is cosmos (not EVM)": batch3DepositCosmosLink > 0,
  "watchtower live-status line (live file or embedded fallback)":
    text.includes("Live status — last run") ||
    text.includes("Live watchtower status unavailable"),
  "watchtower latest batch #7 OK": text.includes("Latest batch #7: ✓ OK"),
  "watchtower ALL BATCHES OK": text.includes("ALL BATCHES OK"),
  "watchtower 8/8": text.includes("8/8 batches verified"),
  "tamper-catch demo": text.includes("Tamper-catch demo"),
  "tamper failed on 8 checks": text.includes("8 independent checks"),
  "merkle-proof withdrawal section": text.includes("Merkle-proof withdrawal"),
  "merkle section shows real data (not placeholder)":
    text.includes("4 steps") && text.includes("Merkle leaf") && !text.includes("Coming in v2"),
  "merkle withdraw account is the fresh test account (batch #7 cycle)":
    text.includes("0xaf9eD7049d664B805bcd866A44bA3cc2725F1Ded") &&
    text.includes("fresh test account") &&
    text.includes("not an independent outsider"),
  "cycle shows the fresh-account withdrawal (honest label)":
    text.includes("fresh test account (builder-run test)"),
  "auto-credit: batch #3 card shows its credited deposit":
    text.includes("L1 deposits credited (auto-credit)") && text.includes("100,000 uqor"),
  "auto-credit: cycle shows the 0.1 QOR deposit":
    text.includes("Deposit 0.1 QOR (auto-credit cycle)"),
  "auto-credit: cycle shows batch #3 with its deposit":
    text.includes("Settle batch #3") && text.includes("auto-credited"),
  "auto-credit: cycle shows the deployer withdrawal":
    text.includes("Merkle-proof withdrawal — 0.3 QOR"),
  "genesis seed reworded (no stale demo-gap claim)":
    text.includes("Genesis funding") && !text.includes("not auto-credited"),
  "first-cycle user withdrawal still shown":
    text.includes("Merkle-proof withdrawal — 0.05 QOR"),
  "balances total conserved from 0.6 QOR":
    text.includes("conserved from the 0.6 QOR deposited"),
  "double-withdraw revert": text.includes("ZeroWithdraw"),
  "tampered-proof revert": text.includes("InvalidMerkleProof"),
  "forged batch reverted": text.includes("REVERTED on-chain"),
  "receipt hash present": text.includes("Receipt hash"),
  "honest limits footnote": text.includes("Honest limits"),
  "no fatal error text": !/something went wrong|failed to load|white screen/i.test(text),
};
let ok = true;
let passCount = 0;
for (const [name, passed] of Object.entries(checks)) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  if (passed) passCount += 1;
  else ok = false;
}
// The watchtower-status fetch is best-effort by design: until the status
// file is published on main it 404s, and Chromium logs that as a console
// error even though the app handles it via the embedded fallback. Ignore
// that one console 404 — but ONLY when the watchtower-status URL is the
// sole 404 on the page, so a genuinely broken asset still fails the check.
const onlyWt404 =
  notFoundUrls.size > 0 &&
  [...notFoundUrls].every((u) => u.endsWith("/deployments/watchtower-status.json"));
const realErrors = errors.filter(
  (e) =>
    !(
      onlyWt404 &&
      e.startsWith(
        "console: Failed to load resource: the server responded with a status of 404",
      )
    ),
);
if (onlyWt404 && realErrors.length < errors.length) {
  console.log(
    "NOTE ignoring the expected 404 console error for the not-yet-published watchtower-status.json",
  );
}
if (realErrors.length) {
  console.log("ERRORS:");
  for (const e of realErrors) console.log(`  ${e}`);
  ok = false;
} else {
  console.log("PASS no console/page/request errors");
  passCount += 1;
}
console.log(`${passCount}/${Object.keys(checks).length + 1} checks passed`);
console.log(`screenshot: ${screenshotPath}`);
await browser.close();
forwarder.close();
process.exit(ok ? 0 : 1);
