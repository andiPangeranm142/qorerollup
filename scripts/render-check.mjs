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
await page.waitForSelector('[data-testid="batch-3"]', { timeout: 30000 });
await page.screenshot({ path: screenshotPath, fullPage: true });

const text = await page.evaluate(() => document.body.innerText);
const batchCards = await page.locator(".batch-card").count(); // not [data-testid^='batch-']: that also matches the batch-count stat
// Read the live-stat values directly (robust against the same number
// appearing elsewhere on the page).
const statValue = async (testid) =>
  (await page.locator(`[data-testid="${testid}"] .stat-value`).innerText()).trim();
const batchCountValue = await statValue("batch-count");
const depositedValue = await statValue("total-deposited");
const withdrawnValue = await statValue("total-withdrawn");
const deployerDepositValue = await statValue("deployer-deposit");
const checks = {
  "title QoreRollup": text.includes("QoreRollup"),
  "contract address v2": text.includes("0xb54a8bd2dfffa9f3b8a23c3b4e663fe31667d708"),
  "no v1 contract": !text.includes("0x96051b69"),
  "no nullifier text": !text.toLowerCase().includes("nullifier"),
  "batchCount 4": batchCountValue === "4",
  "4 batch cards": batchCards === 4,
  "total deposited 0.4 QOR": depositedValue === "0.4 QOR",
  "total withdrawn 0.35 QOR": withdrawnValue === "0.35 QOR",
  "deployer deposit 0.4 QOR": deployerDepositValue === "0.4 QOR",
  "watchtower ALL BATCHES OK": text.includes("ALL BATCHES OK"),
  "watchtower 4/4": text.includes("4/4 batches verified"),
  "tamper-catch demo": text.includes("Tamper-catch demo"),
  "tamper failed on 8 checks": text.includes("8 independent checks"),
  "merkle-proof withdrawal section": text.includes("Merkle-proof withdrawal"),
  "merkle section shows real data (not placeholder)":
    text.includes("3 steps") && text.includes("Merkle leaf") && !text.includes("Coming in v2"),
  "merkle withdraw account is the deployer (batch #3 cycle)":
    text.includes("0x0140a056ee37D5240b0397eCdF1347Da80E33b9f"),
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
  "balances total conserved from 0.4 QOR":
    text.includes("conserved from the 0.4 QOR deposited"),
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
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors) console.log(`  ${e}`);
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
