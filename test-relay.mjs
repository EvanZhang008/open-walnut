/**
 * Test script: check relay status, test Playwright connection, read diagnostic logs.
 * Run from project dir: node /tmp/walnut-test-relay.mjs
 */
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const PORT = 18792;

async function checkRelayRunning() {
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/extension/status`);
    if (resp.ok) return await resp.json();
  } catch {}
  return null;
}

async function testPlaywright() {
  const endpoint = `ws://127.0.0.1:${PORT}/cdp`;
  console.log(`\nTesting Playwright connectOverCDP → ${endpoint} (no auth)...`);
  try {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
    const pages = browser.contexts().flatMap(c => c.pages());
    console.log(`✅ Connected: contexts=${browser.contexts().length} pages=${pages.length}`);
    for (const p of pages) console.log(`   page: ${p.url()}`);
    await browser.close();
  } catch (err) {
    console.log(`❌ ${err.message.split('\n')[0]}`);
  }
}

async function main() {
  console.log("=== Walnut Browser Relay Test ===\n");

  const status = await checkRelayRunning();
  if (!status) {
    console.log("❌ Relay not running on port", PORT);
    console.log("   Need to trigger browser tool first.");
    process.exit(1);
  }
  console.log("✅ Relay running. Extension connected:", status.connected);

  if (!status.connected) {
    console.log("⚠️  Extension not connected — please click the extension icon in Chrome.");
  }

  await testPlaywright();

  console.log("\n=== Diagnostic logs (last 30 lines) ===");
  try {
    const logs = execSync(
      'grep -E "\\[relay\\]|\\[pw-session\\]|\\[server-context\\]" /tmp/walnut/watchdog.log 2>/dev/null | tail -30',
      { encoding: 'utf8' }
    );
    console.log(logs.trim() || "(no diagnostic logs yet)");
  } catch {
    console.log("(no diagnostic logs yet)");
  }
}

main().catch(console.error);
