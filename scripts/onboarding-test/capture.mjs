#!/usr/bin/env node
/**
 * Capture the FIRST-RUN experience of a freshly installed Walnut server.
 *
 * The server usually runs on a throwaway test machine and is port-forwarded to
 * localhost, so this script only needs a URL. It screenshots the setup banner
 * (three possible states: full onboarding checklist, an "auto-detected
 * credentials" note, or nothing at all) and optionally records a short video.
 *
 *   node scripts/onboarding-test/capture.mjs --url http://127.0.0.1:43456 \
 *        --out /tmp/run --name readme [--video]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const url = arg('--url');
const out = arg('--out');
const name = arg('--name');
const wantVideo = args.includes('--video');

const die = (msg) => { console.error(`capture: ${msg}`); process.exit(1); };
if (!url || !out || !name) die('usage: --url <url> --out <dir> --name <name> [--video]');

const outDir = resolve(out);
const base = url.replace(/\/+$/, '');
const wrote = [];
const step = async (label, fn) => {
  try { return await fn(); } catch { console.log(`capture: ${label} not found, continuing`); return undefined; }
};
const record = (p) => { wrote.push(p); console.log(`capture: wrote ${p}`); };

// Health gate: fail fast with one line rather than letting Playwright time out.
const healthy = await (async () => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/system/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
})();
if (!healthy) die(`server did not answer GET ${base}/api/system/health within 20s`);

mkdirSync(outDir, { recursive: true });
const videoDir = join(outDir, 'video-raw');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  colorScheme: 'light',
  ...(wantVideo ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } : {}),
});
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => { if (consoleErrors.length < 20) consoleErrors.push(String(e)); });

// The ONLY goto in this script: everything after the first load is real UI clicks.
const t0 = Date.now();
await page.goto(base, { waitUntil: 'domcontentloaded' });
await step('network idle', () => page.waitForLoadState('networkidle', { timeout: 15_000 }));
const loadMs = Date.now() - t0;
const pace = wantVideo ? 2500 : 300;

// The auto-detected note reuses `.setup-banner`, so read the title to tell the states apart.
const banner = page.locator('.setup-banner').first();
let bannerState = 'none';
await step('setup banner', async () => {
  await banner.waitFor({ state: 'visible', timeout: 10_000 });
  const title = ((await page.locator('.setup-banner-title').first().textContent()) ?? '').trim();
  bannerState = /Get Walnut talking/i.test(title) ? 'onboarding'
    : /Auto-detected|Using your Claude Code subscription/i.test(title) ? 'auto-detected'
      : 'onboarding';
  console.log(`capture: banner state = ${bannerState} (${title || 'no title'})`);
  if (wantVideo) { await banner.scrollIntoViewIfNeeded(); await page.waitForTimeout(pace); }
});
if (bannerState === 'none') console.log('capture: banner state = none (server already configured)');

const screenshots = [];
const shot = async (label, suffix, target) => {
  const file = join(outDir, `first-run-${name}${suffix}.png`);
  const done = await step(label, async () => { await target.screenshot({ path: file }); return true; });
  if (done) { screenshots.push(file); record(file); }
};

await shot('viewport screenshot', '', page);
await page.waitForTimeout(pace);
if (bannerState !== 'none') await shot('banner screenshot', '-banner', banner);

// Hover the hero block, then follow the manual "Settings → AI Provider" route by clicking it.
await step('setup hero hover', async () => {
  await page.locator('.setup-hero').first().hover({ timeout: 3000 });
  await page.waitForTimeout(1000);
});
await step('settings step button', async () => {
  await page.locator('.setup-step-btn').first().click({ timeout: 3000 });
});
await page.waitForTimeout(2000);
await shot('settings screenshot', '-settings', page);
if (wantVideo) { await page.mouse.wheel(0, 400); await page.waitForTimeout(pace); await page.mouse.wheel(0, -400); await page.waitForTimeout(pace); }

const meta = {
  url: base,
  name,
  bannerState,
  title: await page.title(),
  loadMs,
  consoleErrors,
  screenshots,
};
const metaPath = join(outDir, `first-run-${name}.json`);
writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
record(metaPath);

await context.close();          // flushes the .webm
await browser.close();

if (wantVideo) {
  const src = await step('video file', () => {
    const f = readdirSync(videoDir).find((n) => n.endsWith('.webm'));
    if (!f) throw new Error('no webm');
    return join(videoDir, f);
  });
  if (src) {
    record(src);
    const mp4 = join(outDir, `browser-${name}.mp4`);
    const ff = spawnSync('ffmpeg', ['-y', '-i', src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', '30', mp4], { stdio: 'inherit' });
    if (ff.error || ff.status !== 0) console.log(`capture: ffmpeg unavailable or failed; keeping webm at ${src}`);
    else record(mp4);
  }
}
