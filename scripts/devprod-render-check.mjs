#!/usr/bin/env node
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
 *      screen, or #root is still empty after the page settled
 *   2  UNDETERMINED: playwright or its browser is missing, the browser failed
 *      to launch, or the page never settled within the budget (machine load)
 *
 * Usage: node scripts/devprod-render-check.mjs <url> [--browser chromium|webkit]
 *        [--timeout-ms N] [--strict]
 * `--strict` also treats any uncaught page exception as a crash (default: warn).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const browserName = opt('--browser', 'chromium');
const timeoutMs = Number(opt('--timeout-ms', '60000')) || 60000;
const strict = args.includes('--strict');

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
  page.on('console', (m) => {
    if (m.type() === 'error' && BOUNDARY_CONSOLE.test(m.text())) boundaryHits.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));

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
    console.log(`render-check OK: ${browserName} mounted ${url} (${rootChildren} root child, ${Date.now() - started}ms)`);
    verdict = 0;
  }
} finally {
  await browser.close().catch(() => {});
}
process.exit(verdict);
