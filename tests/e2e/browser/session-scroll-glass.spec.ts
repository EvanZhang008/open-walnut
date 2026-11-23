/**
 * The session chat scrolls behind its glass chrome (Chromium). Scenario matrix:
 * session-scroll-glass-helpers.ts. Playwright's headless Chromium hides scrollbars
 * by default; this file shows them, so the thumb can be read in pixels. The WebKit
 * twin is session-scroll-glass.webkit.spec.ts (the Mac app is a WKWebView).
 */
import { test } from './threads-helpers';
import { CHROMIUM_SILENT } from './pw-silence';
import { runComposerGlassMatrix, runFloatingStripGlass, runPathBarGlass } from './session-scroll-glass-helpers';

test.use({ launchOptions: { args: CHROMIUM_SILENT, ignoreDefaultArgs: ['--hide-scrollbars'] } });
test.skip(({ browserName }) => browserName !== 'chromium', 'the WebKit twin covers WebKit');

test('the transcript runs on under the composer and the header, the thumb stops at both', async ({ page }) => {
  test.setTimeout(90_000);
  await runComposerGlassMatrix(page);
});

test('Tree Mode\'s path bar floats under the header on a single page', async ({ page }) => {
  test.setTimeout(120_000);
  await runPathBarGlass(page);
});

test('the threads line above the chat floats on glass, and growing keeps the reader at the end', async ({ page }) => {
  test.setTimeout(180_000);
  await runFloatingStripGlass(page);
});
