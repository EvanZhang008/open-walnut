/**
 * A code block never makes the bubble around it change width by itself, in
 * Chromium. Scenario matrix: code-block-bubble-width-helpers.ts.
 */
import { test } from '@playwright/test';
import { expectBubblesKeepTheirWidth, expectBubblesSettleAfterResize, expectPaddingTrimStillWorks } from './code-block-bubble-width-helpers';

test('every user bubble with a code block keeps one width', async ({ page }) => { await expectBubblesKeepTheirWidth(page, 'chromium'); });
test('bubbles settle again after the window is resized', async ({ page }) => { await expectBubblesSettleAfterResize(page); });
test('a full-width block still trims its padding for a line that only reaches into it', async ({ page }) => { await expectPaddingTrimStillWorks(page); });
