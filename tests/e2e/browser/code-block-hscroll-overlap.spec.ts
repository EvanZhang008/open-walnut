/**
 * A code block wider than its column may not paint over the paragraph after it.
 *
 * This is the default-project (Chromium) half. Playwright launches Chromium with
 * `--hide-scrollbars`, so here every scrollbar is 0px: the overlap can neither
 * happen nor be observed, and what this file actually pins is the arithmetic that
 * follows from the fix (the box does not change when it starts overflowing, and
 * the reserved strip is part of the block's bottom edge, not added to it).
 *
 * The engine the bug was reported from is pinned in
 * code-block-hscroll-overlap.webkit.spec.ts. Scenario matrix and mechanism live in
 * code-block-hscroll-helpers.ts.
 */
import { test } from '@playwright/test';
import { expectNoOverlapWhenNarrowed, expectReservedTrackContract } from './code-block-hscroll-helpers';

for (const rich of [false, true]) {
  test(`${rich ? 'rich' : 'plain'} path: narrowing a column does not move the next paragraph under a code block`, async ({ page }) => {
    await expectNoOverlapWhenNarrowed(page, rich);
  });
}

test('every surface that re-declares code-block geometry keeps the reserved-track contract', async ({ page }) => {
  await expectReservedTrackContract(page);
});
