/**
 * Code blocks in a session reply: label, colors, Copy, Wrap, streaming.
 * Chromium half; the WebKit pin (the Mac app's engine) is
 * code-block-actions.webkit.spec.ts. Scenario matrix: code-block-actions-helpers.ts.
 */
import { test } from '@playwright/test';
import {
  expectCopyFallbackSelects, expectCopyWorks, expectDarkThemeReadable, expectFramedAndColored,
  expectHeaderStaysInBlock, expectLongBlockFolds, expectSelectionSkipsHeader, expectStreamingBlock, expectWrapKeepsPlace, expectWrapToggles,
} from './code-block-actions-helpers';

test('each fence is framed with its language and colored', async ({ page }) => { await expectFramedAndColored(page, 'chromium'); });
test('Copy takes the block alone, every time, from mouse and keyboard', async ({ page }) => { await expectCopyWorks(page); });
test('with no clipboard, Copy selects the code instead', async ({ page }) => { await expectCopyFallbackSelects(page); });
test('Wrap stops the overflow on that block alone and keeps it when redrawn or reloaded', async ({ page }) => { await expectWrapToggles(page, 'chromium'); });
test('selecting the reply leaves the header words out', async ({ page }) => { await expectSelectionSkipsHeader(page); });
test('a streaming block is framed and colored as it grows, without stalls', async ({ page }) => { await expectStreamingBlock(page, 'chromium'); });
test('Wrap from a header stuck mid-block keeps the line under it', async ({ page }) => { await expectWrapKeepsPlace(page); });
test('a sticky header never leaves its block', async ({ page }) => { await expectHeaderStaysInBlock(page); });
test('a long finished block opens folded and unfolds for good', async ({ page }) => { await expectLongBlockFolds(page); });
test('dark theme', async ({ page }) => { await expectDarkThemeReadable(page, 'chromium'); });
