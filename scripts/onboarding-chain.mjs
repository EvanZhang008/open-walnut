#!/usr/bin/env node
/**
 * Record the FULL first-run onboarding *chain* — the experience a brand-new user
 * actually goes through — against a clean-room Walnut (server started with NO creds):
 *
 *   1. Land on a fresh install → the "Get Walnut talking" onboarding banner.
 *   2. Click the banner's "Settings → AI Provider" link (path 3, the manual form).
 *   3. Pick a region + paste a real Bedrock bearer token (masked password field).
 *   4. Click "Test Connection" → wait for the REAL "Connected (NNNms)" round-trip.
 *   5. Click "Save" → poll health until hasReadyProvider=true.
 *   6. Go Home → the onboarding banner is gone → type "hello" → wait for a REAL reply.
 *
 * Proves the chain end-to-end with a live model call, not just static UI.
 *
 * The credential is provided via env (NEVER hard-coded, NEVER committed):
 *   WALNUT_DEMO_BEARER_TOKEN  (a real Bedrock bearer token)
 *   WALNUT_DEMO_REGION        (optional, default us-west-2)
 *
 * The token is typed into a password field (masked dots) — it never appears on screen.
 * Talks only to the clean-room URL (default :3457) — never production :3456.
 */
import path from 'node:path';
import os from 'node:os';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const BASE = arg('url', 'http://localhost:3457');
const OUT = arg('out', 'demo/Final/onboarding-chain.mp4');
const REGION = process.env.WALNUT_DEMO_REGION || 'us-west-2';
const TOKEN = process.env.WALNUT_DEMO_BEARER_TOKEN || '';

if (!TOKEN) {
  console.error('[chain] ERROR: set WALNUT_DEMO_BEARER_TOKEN (a real Bedrock bearer token).');
  process.exit(2);
}

const RECORDER = path.join(os.homedir(), '.claude/skills/record-webapp-video/scripts/recorder.mjs');
const { launchBrowser, recordSegment, smoothMove, smoothClick, smoothType, beat, waitForQuiet } = await import(RECORDER);
const log = (...a) => console.log('[chain]', ...a);

// Sanity: the clean room must really be unconfigured before we start.
const h0 = await (await fetch(`${BASE}/api/system/health`)).json();
log('initial health:', JSON.stringify({ hasReadyProvider: h0.hasReadyProvider, credentialSource: h0.credentialSource }));
if (h0.hasReadyProvider === true) {
  console.error('[chain] ERROR: clean room already has a provider — not a fresh first-run. Aborting.');
  process.exit(3);
}

const browser = await launchBrowser();
const outDir = path.dirname(OUT);
const name = path.basename(OUT).replace(/\.mp4$/, '');

const result = await recordSegment(browser, {
  name,
  baseUrl: BASE,
  outDir,
  run: async (page) => {
    // ── 1. Fresh landing — the onboarding banner ──
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await beat(3000); // let SPA + WS health settle so the banner reflects state
    await page.waitForSelector('text=Get Walnut talking', { timeout: 15_000 }).catch(() => {});
    await beat(2500);

    // Dwell on the hero paste block so a viewer reads the "fastest" path.
    const hero = page.locator('.setup-command-multiline').first();
    if (await hero.count()) {
      const b = await hero.boundingBox();
      if (b) await smoothMove(page, b.x + b.width / 2, b.y + b.height / 2);
      await beat(2500);
    }

    // ── 2. Open the manual provider form via the banner link ──
    const settingsBtn = page.locator('text=Settings → AI Provider').first();
    await smoothClick(page, settingsBtn);
    await beat(2500); // let the AI Provider section render (bedrock card auto-expands)

    // Ensure the Bedrock token field is in view.
    const tokenInput = page.locator('#bedrock-token');
    await tokenInput.waitFor({ state: 'visible', timeout: 10_000 });
    await beat(800);

    // ── 3. Region (select) + bearer token (masked) ──
    await page.selectOption('#bedrock-region', REGION).catch(() => log('• region select skipped'));
    await beat(900);
    // Type into the password field — shows dots, never the secret.
    await smoothType(page, tokenInput, TOKEN, { charDelay: 12 });
    await tokenInput.blur().catch(() => {});
    await beat(1200);

    // ── 4. Test Connection — the real round-trip ──
    const testBtn = page.locator('button:has-text("Test Connection")').first();
    await smoothClick(page, testBtn);
    // Wait for the success StatusIndicator ("Connected (NNNms)").
    const ok = await page.waitForFunction(() => {
      const t = document.body.innerText || '';
      return /connected/i.test(t) && /\d+\s*ms/i.test(t);
    }, { timeout: 45_000 }).then(() => true).catch(() => false);
    log(ok ? '✓ Test Connection succeeded (live round-trip)' : '• success text not detected (continuing)');
    await beat(2200);

    // ── 5. Save, then poll health until ready ──
    const saveBtn = page.locator('button:has-text("Save")').first();
    if (await saveBtn.count()) { await smoothClick(page, saveBtn); await beat(1500); }

    let ready = false;
    for (let i = 0; i < 25; i++) {
      try {
        const h = await (await fetch(`${BASE}/api/system/health`)).json();
        if (h.hasReadyProvider === true) { ready = true; log(`✓ provider ready (source=${h.credentialSource})`); break; }
      } catch { /* ignore */ }
      await beat(1000);
    }
    if (!ready) log('• warning: health never reported hasReadyProvider=true');
    await beat(1200);

    // ── 6. Go Home via the sidebar NavLink (react-router; pushState won't re-render) ──
    const homeNav = page.locator('.sidebar a[href="/"], nav a[href="/"], a[href="/"]').first();
    await homeNav.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    if (await homeNav.count()) await smoothClick(page, homeNav).catch(() => {});
    await beat(2800);

    const stillThere = await page.locator('text=Get Walnut talking').count();
    log(stillThere === 0 ? '✓ onboarding banner gone after setup' : '• banner still present after setup');
    await beat(1500);

    // The home chat textarea lives in the left chat column; wait for it to mount + be visible.
    const box = page.locator('.chat-input-textarea').first();
    await box.waitFor({ state: 'visible', timeout: 15_000 });
    await box.scrollIntoViewIfNeeded().catch(() => {});
    await smoothType(page, box, 'in one sentence, what can you help me with?', { charDelay: 22 });
    await beat(400);
    await box.press('Enter');
    // Wait for the assistant ("Walnut") bubble to actually appear — NOT just any text
    // (the user's own message contains greetings and would false-positive).
    const replied = await page.waitForFunction(() => {
      const roles = Array.from(document.querySelectorAll('.chat-message-role'));
      return roles.some((r) => /walnut/i.test(r.textContent || ''));
    }, { timeout: 60_000 }).then(() => true).catch(() => false);
    log(replied ? '✓ Walnut assistant bubble appeared' : '• butler bubble not detected');
    // Let the turn fully complete (Stop button gone + text settled) so the reply is on screen.
    await waitForQuiet(page, { maxMs: 60_000, quietMs: 3000 });
    await beat(3500); // dwell on the finished reply for the viewer
  },
});

log('recorded →', result?.mp4 || OUT, result?.secs ? `(${result.secs.toFixed(1)}s, ${result.frames} frames)` : '');
await browser.close();
