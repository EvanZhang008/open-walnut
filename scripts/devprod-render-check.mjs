#!/usr/bin/env bun
/**
 * First-paint render check for a freshly built Walnut dist.
 *
 * `scripts/dev-prod.sh` boots the new dist in isolation and only asked it for
 * `/api/config` before killing the production server. 2026-09-02: a bundle built
 * from a half-edited component (a `useMemo` deps array still naming a deleted
 * state variable) passed that probe and crashed on the first paint of `/` in
 * every browser (`ReferenceError: groupBy is not defined`, five error-boundary
 * catches in 14s). A server that serves JSON is not a server that serves the app.
 *
 * This loads the SPA once in a headless browser and reports what a user would
 * see. Exit codes are deliberately three-valued so the deploy can fail closed on
 * certainty and fail open on doubt:
 *
 *   0  the app shell mounted and no render crash was observed
 *   1  DEFINITIVE crash: the React error boundary fired, its banner is on
 *      screen, or #root is still empty when the wait for it ends (the budget,
 *      or soon after an uncaught error: a script that died before mounting)
 *   2  UNDETERMINED: playwright or its browser is missing, the browser failed
 *      to launch, the page never loaded within the budget (machine load), or
 *      the page closed or its renderer crashed before the app mounted
 *
 * Usage: bun scripts/devprod-render-check.mjs <url> [--browser chromium|webkit]
 *        [--timeout-ms N] [--strict]
 * `--strict` also treats any uncaught page exception as a crash (default: warn).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkSessionScroll } from './devprod-session-scroll.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const browserName = opt('--browser', 'chromium');
const timeoutMs = Number(opt('--timeout-ms', '60000')) || 60000;
const strict = args.includes('--strict');
/** The app's own boot-crash line (web/src/main.tsx) and still no shell this long after it: it died. */
const DIED_AFTER_MS = 3000;
/** Any other uncaught error (a stray rejection on a busy boot is one) and still no shell: it died. */
const ERRORED_AFTER_MS = 12000;
const BOOT_CRASH_CONSOLE = /\[react\] uncaught render error|\[boot\] the app failed to load|Failed to load module script/;

if (!url) {
  console.error('usage: devprod-render-check.mjs <url> [--browser chromium|webkit] [--timeout-ms N] [--strict]');
  process.exit(2);
}

// The React error boundary's console line and on-screen banner
// (web/src/components/common/AppErrorBoundary.tsx). Matching both means a
// crash is caught even if crash-recovery reloads the page under us.
const BOUNDARY_CONSOLE = /\[error-boundary\]|render error caught by boundary/;
const BOUNDARY_BANNER = 'Something went wrong rendering the page';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));

let playwright;
try {
  playwright = require('playwright');
} catch {
  console.error('render-check UNDETERMINED: `playwright` is not installed at the repo root.');
  process.exit(2);
}
const browserType = playwright[browserName];
if (!browserType) {
  console.error(`render-check UNDETERMINED: unknown browser "${browserName}".`);
  process.exit(2);
}

const undetermined = (why) => {
  console.error(`render-check UNDETERMINED: ${why}`);
  process.exit(2);
};

let browser;
try {
  browser = await browserType.launch({ headless: true });
} catch (err) {
  undetermined(`could not launch ${browserName}: ${String(err?.message ?? err).split('\n')[0]}`);
}

const boundaryHits = [];
const pageErrors = [];
let verdict = 2;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (BOUNDARY_CONSOLE.test(m.text())) boundaryHits.push(m.text().slice(0, 300));
    else consoleErrors.push(m.text().slice(0, 300));
    if (BOOT_CRASH_CONSOLE.test(m.text())) bootCrashAt ||= Date.now();
  });
  let bootCrashAt = 0;
  let firstErrorAt = 0;
  let pageCrashed = false;
  page.on('pageerror', (e) => { pageErrors.push(String(e).slice(0, 300)); firstErrorAt ||= Date.now(); });
  page.on('crash', () => { pageCrashed = true; });

  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  } catch (err) {
    undetermined(`page did not load within ${timeoutMs}ms: ${String(err?.message ?? err).split('\n')[0]}`);
  }
  // Let the app mount and, if it is going to, crash. networkidle is best-effort:
  // a WS the SPA keeps open must not turn a healthy page into "undetermined".
  const remaining = Math.max(2000, timeoutMs - (Date.now() - started));
  await page.waitForLoadState('networkidle', { timeout: Math.min(remaining, 15000) }).catch(() => {});
  // A quiet network is not a mounted app: on a loaded machine with real data the shell mounts
  // well after the network settles (2026-11-20: three live checks read #root empty at 9 to 10 s
  // while earlier healthy deploys mounted at 11 to 24 s, and the same commit mounted on a copy of
  // the data in 13 s). Wait for the shell, or a crash, up to the budget; then settle briefly.
  // A script that died before mounting ends the wait early: the app's own boot-crash line with
  // #root still empty 3 s later, any other uncaught error with it still empty 12 s later (a busy
  // boot may throw a harmless rejection and mount after it). A closed page or a renderer crash is
  // the machine, not the build: undetermined.
  const deadline = started + timeoutMs;
  for (;;) {
    if (pageCrashed || page.isClosed()) undetermined('the page closed or its renderer crashed before the app mounted');
    const n = await page.evaluate(() => document.getElementById('root')?.children.length ?? 0).catch(() => 0);
    if (n > 0 || Date.now() >= deadline) break;
    if (bootCrashAt && Date.now() - bootCrashAt > DIED_AFTER_MS) break;
    if (firstErrorAt && Date.now() - firstErrorAt > ERRORED_AFTER_MS) break;
    await page.waitForTimeout(250).catch(() => {});
  }
  const mountedMs = Date.now() - started;
  await page.waitForTimeout(1500);

  const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const rootChildren = await page.evaluate(() => document.getElementById('root')?.children.length ?? -1).catch(() => -1);
  const bannerOnScreen = bodyText.includes(BOUNDARY_BANNER);

  if (boundaryHits.length || bannerOnScreen) {
    console.error(`render-check FAILED: React error boundary fired on first paint of ${url}`);
    for (const h of boundaryHits.slice(0, 3)) console.error('  console:', h);
    if (bannerOnScreen) console.error('  banner :', BOUNDARY_BANNER);
    verdict = 1;
  } else if (rootChildren === 0) {
    console.error(`render-check FAILED: #root is empty after ${Date.now() - started}ms (blank page) at ${url}`);
    for (const e of pageErrors.slice(0, 3)) console.error('  pageerror:', e);
    for (const e of consoleErrors.slice(0, 5)) console.error('  console:', e);
    verdict = 1;
  } else if (rootChildren < 0) {
    undetermined('could not inspect #root (page unreachable after load)');
  } else if (strict && pageErrors.length) {
    console.error(`render-check FAILED (--strict): ${pageErrors.length} uncaught page exception(s)`);
    for (const e of pageErrors.slice(0, 3)) console.error('  pageerror:', e);
    verdict = 1;
  } else {
    if (pageErrors.length) {
      console.warn(`render-check WARN: ${pageErrors.length} uncaught page exception(s) (app still mounted; --strict fails on these)`);
      for (const e of pageErrors.slice(0, 3)) console.warn('  pageerror:', e);
    }
    verdict = 0;
    if (await page.locator('.main-page').count()) {
      const scroll = await checkSessionScroll(browser, url, timeoutMs, strict);
      console.log(scroll.message);
      verdict = scroll.code;
    }
    if (verdict === 0) console.log(`render-check OK: ${browserName} mounted ${url} (${rootChildren} root child, mounted at ${mountedMs}ms, ${Date.now() - started}ms)`);
  }
} finally {
  await browser.close().catch(() => {});
}
process.exit(verdict);
