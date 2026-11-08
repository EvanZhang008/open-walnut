/**
 * Code blocks in a session reply, in WEBKIT: the Mac app is a WKWebView, where
 * scrollbars take layout room and the clipboard and selection rules differ from
 * Chromium's. Scenario matrix: code-block-actions-helpers.ts.
 */
import { devices, test, expect } from '@playwright/test';
import {
  expectCopyFallbackSelects, expectCopyWorks, expectDarkThemeReadable, expectFramedAndColored,
  expectHeaderStaysInBlock, expectLongBlockFolds, expectSelectionSkipsHeader, expectStreamingBlock, expectWrapKeepsPlace, expectWrapToggles,
} from './code-block-actions-helpers';

// The Chromium project's launch args (--mute-audio) stop WebKit from starting on
// Linux, so this file starts WebKit with none of them.
test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent, launchOptions: {} });

test('really runs in WebKit', async ({ browserName }) => { expect(browserName).toBe('webkit'); });
test('each fence is framed with its language and colored', async ({ page }) => { await expectFramedAndColored(page, 'webkit'); });
test('Copy takes the block alone, every time, from mouse and keyboard', async ({ page }) => { await expectCopyWorks(page); });
test('with no clipboard, Copy selects the code instead', async ({ page }) => { await expectCopyFallbackSelects(page); });
test('Wrap stops the overflow on that block alone and keeps it when redrawn or reloaded', async ({ page }) => { await expectWrapToggles(page, 'webkit'); });
test('selecting the reply leaves the header words out', async ({ page }) => { await expectSelectionSkipsHeader(page); });
test('a streaming block is framed and colored as it grows, without stalls', async ({ page }) => { await expectStreamingBlock(page, 'webkit'); });
test('Wrap from a header stuck mid-block keeps the line under it', async ({ page }) => { await expectWrapKeepsPlace(page); });
test('a sticky header never leaves its block', async ({ page }) => { await expectHeaderStaysInBlock(page); });
test('a long finished block opens folded and unfolds for good', async ({ page }) => { await expectLongBlockFolds(page); });
test('dark theme', async ({ page }) => { await expectDarkThemeReadable(page, 'webkit'); });
