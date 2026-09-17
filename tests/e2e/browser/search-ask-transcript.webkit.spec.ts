/**
 * The adopted ✦ search's transcript cards, in WEBKIT — the engine the Mac app is.
 *
 * Engine-specific for two reasons, so a Chromium pass alone would not cover the
 * desktop app: the card's rows are `nowrap` + ellipsis inside a flex message
 * column, and wrap/ellipsis/min-content geometry is exactly where the two engines
 * disagree; and WebKit's late scrollbars have twice made a card that fits in
 * Chromium overflow its container here.
 *
 * Scenarios live in search-ask-transcript-helpers.ts — a `test.use` browser pin
 * only applies at a spec file's top level.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  SCREENSHOT_DIR, expectAnswerCarded, expectNoSidewaysScroll, expectPromptFolded,
  expectSeedDisclosed, openSearchAsk,
} from './search-ask-transcript-helpers';

test.use({ browserName: 'webkit' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

test('both cards render, and the prompt still discloses', async ({ page }) => {
  const panel = await openSearchAsk(page);
  await expectPromptFolded(panel);
  await expectAnswerCarded(panel);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/4-webkit.png` });
  await expectSeedDisclosed(panel);
});

test('no sideways scroll at a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  const panel = await openSearchAsk(page);
  await expectNoSidewaysScroll(panel);
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/5-webkit-narrow.png` });
});
