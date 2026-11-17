/**
 * A code block never makes the bubble around it change width by itself, in
 * WEBKIT: the engine it was reported from (the Mac app is a WKWebView, where a
 * <pre>'s scrollWidth can round one pixel past its clientWidth). Scenario
 * matrix: code-block-bubble-width-helpers.ts.
 */
import { devices, expect, test } from '@playwright/test';
import { expectBubblesKeepTheirWidth, expectBubblesSettleAfterResize, expectPaddingTrimStillWorks } from './code-block-bubble-width-helpers';

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent, launchOptions: {} });

test('really runs in WebKit', async ({ browserName }) => { expect(browserName).toBe('webkit'); });
test('every user bubble with a code block keeps one width', async ({ page }) => { await expectBubblesKeepTheirWidth(page, 'webkit'); });
test('bubbles settle again after the window is resized', async ({ page }) => { await expectBubblesSettleAfterResize(page); });
test('a full-width block still trims its padding for a line that only reaches into it', async ({ page }) => { await expectPaddingTrimStillWorks(page); });
