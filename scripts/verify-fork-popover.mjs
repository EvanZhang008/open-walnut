#!/usr/bin/env node
/**
 * Verify the Fork popover UX (frontend only — does NOT actually fork):
 *   1. Smart placement: popover stays fully on-screen (left>=margin, right<=viewport),
 *      even when the Fork button is near the right edge.
 *   2. Image attach: picking a file shows a thumbnail preview + a remove (×) button.
 *
 * Serves new frontend via Vite (:5173). We intercept the /fork POST so no real
 * fork hits prod — we only assert the request body carries the image + that the UI
 * rendered the preview.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const SESSION = '7b370f7c-c1bd-4961-b7cf-2a69d34d5854';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[verify-fork]', ...a);
let failures = 0;
const check = (c, m) => { if (c) log('PASS:', m); else { console.error('FAIL:', m); failures++; } };

// 1x1 transparent PNG (base64) for the attach test.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  // Intercept the fork POST so we never create a real task on prod; capture its body.
  let forkBody = null;
  await page.route('**/api/sessions/*/fork', async (route) => {
    try { forkBody = route.request().postDataJSON(); } catch { forkBody = null; }
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'pending', sourceSessionId: SESSION, taskId: 'test-fake-task', childTaskCreated: true }) });
  });

  await page.addInitScript((sid) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sid, locked: false }]));
  }, SESSION);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.session-panel', { timeout: 30000 });
  await sleep(1500);

  // --- 1. Smart placement ---------------------------------------------------
  log('--- popover placement ---');
  await page.locator('.session-fork-wrapper > button').first().click();
  await sleep(400);
  const geom = await page.evaluate(() => {
    const p = document.querySelector('.session-fork-popover');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, width: r.width, vw: window.innerWidth, vh: window.innerHeight };
  });
  check(!!geom, 'popover present');
  if (geom) {
    check(geom.left >= 0, `popover left edge on-screen (left=${Math.round(geom.left)})`);
    check(geom.right <= geom.vw, `popover right edge on-screen (right=${Math.round(geom.right)} <= vw=${geom.vw})`);
    check(geom.left >= 4, 'popover not flush against / off the left edge');
  }

  // --- 2. Image attach ------------------------------------------------------
  log('--- image attach ---');
  // Set the hidden file input directly (the 📎 button just clicks it).
  const fileInput = page.locator('.session-fork-popover input[type="file"]');
  await fileInput.setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1x1, 'base64') });
  await sleep(500);
  const previewCount = await page.locator('.session-fork-image-preview').count();
  check(previewCount === 1, `one image thumbnail rendered (got ${previewCount})`);
  const hasRemove = await page.locator('.session-fork-image-remove').count();
  check(hasRemove === 1, 'thumbnail has a remove (×) button');

  await page.screenshot({ path: '/tmp/shot-fork-with-image.png' });

  // --- 3. Submit carries the image -----------------------------------------
  log('--- submit body ---');
  await page.locator('.session-fork-input').fill('verify fork with image');
  await page.locator('.session-fork-submit').click();
  await sleep(800);
  check(!!forkBody, 'fork POST fired');
  if (forkBody) {
    check(forkBody.create_child_task === true, 'body.create_child_task = true');
    check(forkBody.message === 'verify fork with image', 'body.message carries the typed text');
    check(Array.isArray(forkBody.images) && forkBody.images.length === 1, 'body.images has 1 image');
    check(forkBody.images?.[0]?.mediaType === 'image/png', 'image mediaType = image/png');
    check(typeof forkBody.images?.[0]?.data === 'string' && forkBody.images[0].data.length > 0, 'image data (base64) present');
    check(!('name' in (forkBody.images?.[0] ?? {})), 'image payload trimmed to {data, mediaType} (no name/url)');
  }

  await browser.close();
  if (failures) { console.error(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
  log('\nALL FORK-POPOVER CHECKS PASSED');
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
