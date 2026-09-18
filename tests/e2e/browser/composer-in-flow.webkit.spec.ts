/**
 * The composer-in-flow matrix in WEBKIT, the engine the report came from (the
 * Mac app is a WKWebView, and it is the engine that draws the overlay scrollbar
 * whose hidden end started this). Its own file because a WebKit pin only holds
 * at the top level of a spec file. Scenario matrix: composer-in-flow-helpers.ts.
 */
import { test, expect } from '@playwright/test';
import { runComposerInFlowMatrix } from './composer-in-flow-helpers';

test.use({ browserName: 'webkit' });

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

test('the transcript scroller, and its scrollbar, end where the composer starts', async ({ page }) => {
  test.setTimeout(90_000);
  await runComposerInFlowMatrix(page);
});
