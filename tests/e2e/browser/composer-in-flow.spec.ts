/**
 * The session composer sits in flow below the transcript scroller, so the
 * scrollbar ends with the last row. Scenario matrix: composer-in-flow-helpers.ts.
 * The WebKit twin is composer-in-flow.webkit.spec.ts (the Mac app is a WKWebView).
 */
import { test } from '@playwright/test';
import { runComposerInFlowMatrix } from './composer-in-flow-helpers';

test('the transcript scroller, and its scrollbar, end where the composer starts', async ({ page }) => {
  test.setTimeout(90_000);
  await runComposerInFlowMatrix(page);
});
