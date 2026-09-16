/**
 * The code-block scrollbar overlap, in WEBKIT — the engine it was reported from.
 *
 * The Mac app is a WKWebView, and this bug only EXISTS where a scrollbar takes
 * layout room: WebKit lays a late horizontal track out inside the `<pre>` alone,
 * so the block grew 6px while its ancestors kept their old height and it painted
 * over the next paragraph. Chromium under Playwright hides scrollbars entirely,
 * which is why the pin has to be its own file rather than a `PW_WEBKIT=1` flag
 * someone remembers to pass. Scenario matrix: code-block-hscroll-helpers.ts.
 */
import { test, expect } from '@playwright/test';
import { expectNoOverlapWhenNarrowed, expectReservedTrackContract } from './code-block-hscroll-helpers';

test.use({ browserName: 'webkit' });

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

for (const rich of [false, true]) {
  test(`${rich ? 'rich' : 'plain'} path: narrowing a column does not move the next paragraph under a code block`, async ({ page }) => {
    await expectNoOverlapWhenNarrowed(page, rich);
  });
}

test('every surface that re-declares code-block geometry keeps the reserved-track contract', async ({ page }) => {
  await expectReservedTrackContract(page);
});
