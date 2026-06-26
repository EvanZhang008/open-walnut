#!/usr/bin/env node
/**
 * Verify the unified session split views + always-on-top Fork popover.
 *
 * Drives the Vite dev server (:5173) which serves the NEW frontend and proxies
 * API/WS to prod (:3456) — so we test the new code WITHOUT restarting prod.
 *
 *   1. Fork popover renders in a portal at body level (always on top, never clipped).
 *   2. Changed → full-screen split [diff | chat].
 *   3. Files  → full-screen split [file explorer | chat] (was an inline dropdown).
 *   4. Terminal → full-screen split [terminal | chat] (was a centered modal).
 *   5. Clicking a view while another is open switches the left column (mutually exclusive).
 *
 * Usage: node scripts/verify-session-split-views.mjs [--session <id>] [--headed]
 */
import { chromium } from 'playwright';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const BASE = 'http://localhost:5173';
const SESSION = arg('session', '7b370f7c-c1bd-4961-b7cf-2a69d34d5854'); // local, cwd=walnut, has task
const HEADED = !!arg('headed', false);

const log = (...a) => console.log('[verify]', ...a);
let failures = 0;
const check = (cond, msg) => { if (cond) log('PASS:', msg); else { console.error('FAIL:', msg); failures++; } };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // Use the full Chrome (system channel) — the headless_shell build may be absent.
  const browser = await chromium.launch({ headless: !HEADED, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  // Seed the homepage with our session column BEFORE the app loads.
  await page.addInitScript((sid) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sid, locked: false }]));
  }, SESSION);

  log('navigating to', BASE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // Wait for the session panel to mount.
  await page.waitForSelector('.session-panel', { timeout: 30000 });
  await sleep(1500);
  log('session panel mounted');

  // Helper: count fullscreen-promoted panels + which view is in the left column.
  const splitState = async () => page.evaluate(() => {
    const fs = document.querySelector('.session-panel.open-walnut-fullscreen.is-changed-open');
    const diffCol = document.querySelector('.session-panel-diff-col');
    return {
      fullscreen: !!fs,
      leftCol: !!diffCol,
      hasDiff: !!document.querySelector('.session-panel-diff-col .session-diff-view'),
      hasFiles: !!document.querySelector('.session-panel-diff-col .session-file-explorer'),
      hasTerminal: !!document.querySelector('.session-panel-diff-col .session-terminal-panel-embedded'),
      backdrop: !!document.querySelector('.open-walnut-fullscreen-backdrop'),
    };
  });

  const chip = (label) => page.locator('.session-meta-row-2 .session-action-chip', { hasText: new RegExp(`^${label}$`) }).first();

  // ---- 1. Fork popover is portaled to body (always on top) ----------------
  log('--- Fork popover ---');
  const forkBtn = page.locator('.session-fork-wrapper > button').first();
  await forkBtn.click();
  await sleep(400);
  const forkPop = await page.evaluate(() => {
    const p = document.querySelector('.session-fork-popover');
    if (!p) return null;
    const style = getComputedStyle(p);
    // Walk up to see if it's a direct child of body (portal) vs nested in a panel.
    let parent = p.parentElement;
    const isBodyChild = parent === document.body;
    const z = parseInt(style.zIndex || '0', 10);
    return { position: style.position, zIndex: z, isBodyChild };
  });
  check(!!forkPop, 'Fork popover renders');
  if (forkPop) {
    check(forkPop.isBodyChild, 'Fork popover is a direct child of <body> (portal — cannot be clipped)');
    check(forkPop.position === 'fixed', 'Fork popover uses fixed positioning');
    check(forkPop.zIndex >= 9999, `Fork popover z-index (${forkPop.zIndex}) is above panels/overlays`);
  }
  // Close it (Escape) before continuing.
  await page.keyboard.press('Escape');
  await sleep(300);

  // ---- 2. Changed ---------------------------------------------------------
  log('--- Changed view ---');
  await chip('Changed').click();
  await sleep(1200);
  let s = await splitState();
  check(s.fullscreen, 'Changed: panel promoted to fullscreen split');
  check(s.hasDiff, 'Changed: SessionDiffView in the left column');
  check(s.backdrop, 'Changed: fullscreen backdrop present');

  // ---- 3. Files (switch directly — mutual exclusion) ----------------------
  log('--- Files view (switch from Changed) ---');
  await chip('Files').click();
  await sleep(1200);
  s = await splitState();
  check(s.fullscreen, 'Files: still fullscreen split');
  check(s.hasFiles, 'Files: SessionFileExplorer in the left column');
  check(!s.hasDiff, 'Files: diff column replaced (mutually exclusive with Changed)');

  // ---- 4. Terminal --------------------------------------------------------
  log('--- Terminal view (switch from Files) ---');
  await chip('Terminal').click();
  await sleep(2000);
  s = await splitState();
  check(s.fullscreen, 'Terminal: still fullscreen split');
  check(s.hasTerminal, 'Terminal: embedded SessionTerminal in the left column (not a centered modal)');
  check(!s.hasFiles, 'Terminal: files column replaced (mutually exclusive)');
  // The OLD behavior was a centered modal overlay — assert it is GONE.
  const oldModal = await page.evaluate(() => !!document.querySelector('.session-terminal-overlay'));
  check(!oldModal, 'Terminal: no old centered .session-terminal-overlay modal');

  // ---- 5. Toggle off ------------------------------------------------------
  log('--- Close split (toggle Terminal off) ---');
  await chip('Terminal').click();
  await sleep(800);
  s = await splitState();
  check(!s.fullscreen, 'Closing the active view exits fullscreen');
  check(!s.leftCol, 'Closing the active view removes the left column');

  await page.screenshot({ path: '/tmp/walnut-split-views-final.png' });
  log('screenshot → /tmp/walnut-split-views-final.png');

  await browser.close();
  if (failures) { console.error(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
  log('\nALL CHECKS PASSED');
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
