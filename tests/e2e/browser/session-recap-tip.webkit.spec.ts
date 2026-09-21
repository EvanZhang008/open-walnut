/**
 * The recap tip in WEBKIT — the engine the report came from (the Mac app is a
 * WKWebView). Same matrix as session-recap-tip.spec.ts; the pin has to be its
 * own file rather than a `PW_WEBKIT=1` flag someone remembers to pass.
 */
import { test, expect } from '@playwright/test';
import {
  TIP_SESSION, OTHER_SESSION, OVERVIEW_ZH, RECAP_ZH, RECAP_NEXT, OVERVIEW_ZH_LONG, RECAP_ZH_LONG,
  OVERVIEW_ZH_SHORT, RECAP_ZH_SHORT,
  mockTipSession, openTipSession, openNarrowTipSession, captureWs, injectEvent, tipOf, shootComposer,
  expectTwoRows, expectWrappedClearOfClose, expectInlineLabels, expectBodyCap, type TipRecord,
} from './session-recap-tip-helpers';

test.use({ browserName: 'webkit' });

const BOTH: TipRecord = {
  overview: OVERVIEW_ZH, overviewAt: '2026-09-18T09:00:00.000Z',
  recap: RECAP_ZH, recapAt: '2026-09-18T09:00:00.000Z',
};

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

test('both rows in the user\'s language, × hides, a new recap brings it back', async ({ page }) => {
  await captureWs(page);
  await mockTipSession(page, TIP_SESSION, { current: BOTH });
  const panel = await openTipSession(page);
  await expectTwoRows(panel, OVERVIEW_ZH, RECAP_ZH);
  await expectWrappedClearOfClose(panel);
  await shootComposer(panel, 'both-rows');

  await tipOf(panel).getByRole('button', { name: 'Dismiss recap' }).click();
  await expect(tipOf(panel)).toHaveCount(0);

  await injectEvent(page, 'session:recap-updated', {
    sessionId: TIP_SESSION, recap: RECAP_NEXT, recapAt: '2026-09-18T09:30:00.000Z',
  });
  await expectTwoRows(panel, OVERVIEW_ZH, RECAP_NEXT);
});

test('300-char rows wrap in full and stay clear of the ×', async ({ page }) => {
  const long = (seed: string) => `${seed} `.repeat(40).slice(0, 300).trim();
  await mockTipSession(page, TIP_SESSION, { current: {
    overview: long('overview words'), overviewAt: '2026-09-18T09:00:00.000Z',
    recap: long('recap words'), recapAt: '2026-09-18T09:00:00.000Z',
  } });
  const panel = await openTipSession(page);
  await expect(tipOf(panel)).toBeVisible();
  await expectWrappedClearOfClose(panel);
  await shootComposer(panel, 'long-rows');
});

test('narrow column, real-density text: no icon, inline labels, 4-line cap with a scroll, × clear', async ({ page }) => {
  await mockTipSession(page, TIP_SESSION, { current: {
    overview: OVERVIEW_ZH_LONG, overviewAt: '2026-09-18T09:00:00.000Z',
    recap: RECAP_ZH_LONG, recapAt: '2026-09-18T09:00:00.000Z',
  } });
  await mockTipSession(page, OTHER_SESSION, { current: {} });
  const panel = await openNarrowTipSession(page);
  await expect(tipOf(panel)).toBeVisible();
  await expectInlineLabels(tipOf(panel));
  await expectWrappedClearOfClose(panel);
  await expectBodyCap(panel, true, 4);
  await shootComposer(panel, 'narrow-capped');
});

test('narrow column, short text: fits, no scroll track', async ({ page }) => {
  await mockTipSession(page, TIP_SESSION, { current: {
    overview: OVERVIEW_ZH_SHORT, overviewAt: '2026-09-18T09:00:00.000Z',
    recap: RECAP_ZH_SHORT, recapAt: '2026-09-18T09:00:00.000Z',
  } });
  await mockTipSession(page, OTHER_SESSION, { current: {} });
  const panel = await openNarrowTipSession(page);
  await expectTwoRows(panel, OVERVIEW_ZH_SHORT, RECAP_ZH_SHORT);
  await expectBodyCap(panel, false, 4);
  await shootComposer(panel, 'narrow-short');
});

test('wide column, real-density text fits under the 6-line cap', async ({ page }) => {
  await mockTipSession(page, TIP_SESSION, { current: {
    overview: OVERVIEW_ZH_LONG, overviewAt: '2026-09-18T09:00:00.000Z',
    recap: RECAP_ZH_LONG, recapAt: '2026-09-18T09:00:00.000Z',
  } });
  const panel = await openTipSession(page);
  await expectTwoRows(panel, OVERVIEW_ZH_LONG, RECAP_ZH_LONG);
  await expectBodyCap(panel, false, 6);
  await shootComposer(panel, 'wide-real-density');
});
