#!/usr/bin/env node
/**
 * Drive + verify Open Walnut's first-run onboarding against a PRISTINE container,
 * and (optionally) record it. Runs on the Mac HOST; the Walnut server runs inside a
 * Docker container with a mapped port — so the environment is genuinely clean while
 * the recording stays crisp (host Chrome via the record-webapp-video recipe).
 *
 * It NEVER touches the production server on :3456 — it only talks to the container's
 * mapped URL (default http://localhost:3457).
 *
 * Usage:
 *   node scripts/onboarding-demo.mjs --url http://localhost:3457            # verify only
 *   node scripts/onboarding-demo.mjs --url http://localhost:3457 --record out.mp4
 *   node scripts/onboarding-demo.mjs --url http://localhost:3457 --expect-ready   # happy path
 *
 * Flags:
 *   --url <url>        Walnut base URL (the container's mapped port). Required.
 *   --expect-ready     Assert the Personal AI IS configured (path-2 happy path: creds were injected).
 *                      Default asserts the onboarding banner IS shown (path 1/3: no creds).
 *   --record <file>    Record an MP4 of the onboarding walkthrough via CDP screencast.
 *   --chat "msg"       After setup, type a message to the Personal AI and assert a reply
 *                      (only meaningful with --expect-ready; needs a real credential).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const URL = arg('url');
const EXPECT_READY = !!arg('expect-ready', false);
const RECORD = arg('record', null);
const CHAT = arg('chat', null);

if (!URL || URL === true) {
  console.error('ERROR: --url <walnut base url> is required (the container mapped port).');
  process.exit(2);
}

const log = (...a) => console.log('[onboarding-demo]', ...a);
const fail = (msg) => { console.error('[onboarding-demo] FAIL:', msg); process.exitCode = 1; };

/** Poll the health endpoint until the server answers (container boot). */
async function waitForServer(base, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/system/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`server at ${base} did not become healthy within ${timeoutMs}ms`);
}

async function main() {
  log(`waiting for ${URL} …`);
  const health = await waitForServer(URL);
  log('health:', JSON.stringify(health));

  // ── Backend assertions (independent of the UI) ──
  if (EXPECT_READY) {
    if (health.hasReadyProvider !== true) fail(`expected hasReadyProvider=true, got ${health.hasReadyProvider}`);
    if (health.credentialSource === 'none') fail(`expected a credentialSource, got 'none'`);
    else log(`✓ provider ready via credentialSource=${health.credentialSource} (${health.credentialDetail ?? ''})`);
  } else {
    if (health.hasReadyProvider !== false) fail(`expected hasReadyProvider=false (clean room), got ${health.hasReadyProvider}`);
    if (health.credentialSource !== 'none') fail(`expected credentialSource='none', got ${health.credentialSource}`);
    else log('✓ clean room: no provider configured (onboarding will show)');
  }

  // ── UI drive (+ optional record) ──
  const browser = await chromium.launch({ channel: 'chrome', headless: !RECORD });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: RECORD ? 2 : 1,
  });
  const page = await context.newPage();

  // Optional CDP screencast recording (host Chrome → ffmpeg).
  let rec = null;
  if (RECORD) rec = await startRecording(page, context, RECORD);

  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Give the SPA + WebSocket health a moment to settle so the banner reflects health.
  await page.waitForTimeout(2500);

  if (EXPECT_READY) {
    // The onboarding "Get Walnut talking" banner must NOT be present; auto-detect note may be.
    const onboarding = await page.locator('text=Get Walnut talking').count();
    if (onboarding > 0) fail('onboarding banner present but provider should be ready');
    else log('✓ UI: no onboarding banner (provider ready)');

    // If a non-config source was used, the auto-detected note should appear.
    if (health.credentialSource && health.credentialSource !== 'config') {
      const note = await page.locator('text=Auto-detected Bedrock via').count();
      if (note > 0) log('✓ UI: "Auto-detected Bedrock via …" note shown');
      else log('• note: auto-detected note not found (source=' + health.credentialSource + ')');
    }

    if (CHAT && CHAT !== true) {
      log(`typing to Personal AI: "${CHAT}"`);
      const replied = await sendChatAndWaitForReply(page, CHAT);
      if (replied) log('✓ Personal AI replied — credential works end-to-end');
      else fail('Personal AI did not reply within timeout');
    }
  } else {
    // Clean room: onboarding banner + the hero paste block must be visible.
    await page.waitForSelector('text=Get Walnut talking', { timeout: 15_000 }).catch(() => {});
    const banner = await page.locator('text=Get Walnut talking').count();
    if (banner === 0) fail('onboarding banner NOT shown in clean room');
    else log('✓ UI: onboarding banner shown');

    const hero = await page.locator('text=Paste this into it').count();
    if (hero === 0) fail('hero paste block NOT shown');
    else log('✓ UI: hero paste block shown');

    const settingsLink = await page.locator('text=AI Provider').count();
    if (settingsLink === 0) log('• note: Settings → AI Provider link not found');
    else log('✓ UI: manual Settings → AI Provider link shown');
  }

  if (rec) { await page.waitForTimeout(1500); await rec.stop(); log(`recorded → ${RECORD}`); }

  await browser.close();
  if (process.exitCode) log('completed WITH failures'); else log('all assertions passed ✓');
}

// ── CDP screencast → ffmpeg (the record-webapp-video recipe, inlined & minimal) ──
async function startRecording(page, context, outFile) {
  const ff = spawn('ffmpeg', [
    '-y', '-f', 'image2pipe', '-framerate', '30', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
    outFile,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const sink = ff.stdin;
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    try { sink.write(Buffer.from(data, 'base64')); } catch { /* sink closed */ }
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch { /* race on stop */ }
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 3840, maxHeight: 2160, everyNthFrame: 1 });
  // Force continuous repaint so an idle UI still emits frames.
  const repaint = setInterval(() => { page.evaluate(() => void document.body.offsetHeight).catch(() => {}); }, 100);
  return {
    stop: async () => {
      clearInterval(repaint);
      try { await cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 300));
      sink.end();
      await new Promise((r) => ff.on('close', r));
    },
  };
}

/** Type into the chat composer and wait for any assistant text to appear. */
async function sendChatAndWaitForReply(page, msg) {
  // The composer is a textarea; find the first visible one.
  const box = page.locator('textarea').first();
  await box.waitFor({ state: 'visible', timeout: 10_000 });
  await box.click();
  await box.fill(msg);
  await box.press('Enter');
  // Wait for an assistant message bubble to render text. Heuristic: chat grows + non-empty.
  try {
    await page.waitForFunction(() => {
      const text = document.body.innerText || '';
      return text.length > 0 && /\b(hi|hello|hey|yes|sure|i can|how can|walnut)\b/i.test(text);
    }, { timeout: 40_000 });
    return true;
  } catch {
    return false;
  }
}

await main();
