/**
 * session-scroll-glass.spec.ts in WEBKIT, the Mac app's engine. Its own file because a
 * WebKit pin only holds at the top level of a spec file. Scenario matrix:
 * session-scroll-glass-helpers.ts.
 */
import { devices, expect } from '@playwright/test';
import { test } from './threads-helpers';
import { runComposerGlassMatrix, runFloatingStripGlass, runPathBarGlass } from './session-scroll-glass-helpers';

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent });

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

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
