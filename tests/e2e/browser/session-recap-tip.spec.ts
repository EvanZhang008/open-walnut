/**
 * The recap tip's scenario matrix, in Chromium. The WebKit twin is
 * session-recap-tip.webkit.spec.ts (the Mac app is a WKWebView). Matrix and
 * helpers: session-recap-tip-helpers.ts.
 */
import { test, expect } from '@playwright/test';
import {
  TIP_SESSION, OTHER_SESSION, OVERVIEW_ZH, RECAP_ZH, RECAP_NEXT,
  mockTipSession, openTipSession, captureWs, injectEvent, tipOf, shootComposer,
  expectTwoRows, expectWrappedClearOfClose, type TipRecord,
} from './session-recap-tip-helpers';

const BOTH: TipRecord = {
  overview: OVERVIEW_ZH, overviewAt: '2026-09-18T09:00:00.000Z',
  recap: RECAP_ZH, recapAt: '2026-09-18T09:00:00.000Z',
};

test('1. both rows, labelled, in the user\'s language, dismissible', async ({ page }) => {
  await mockTipSession(page, TIP_SESSION, { current: BOTH });
  const panel = await openTipSession(page);
  await expectTwoRows(panel, OVERVIEW_ZH, RECAP_ZH);
  await expectWrappedClearOfClose(panel);
  await shootComposer(panel, 'both-rows');
});

test('2. × hides the tip and a reload keeps it hidden; 3. a new recap brings it back', async ({ page }) => {
  await captureWs(page);
  const tip = { current: BOTH };
  await mockTipSession(page, TIP_SESSION, tip);
  let panel = await openTipSession(page);
  await expectTwoRows(panel, OVERVIEW_ZH, RECAP_ZH);

  await tipOf(panel).getByRole('button', { name: 'Dismiss recap' }).click();
  await expect(tipOf(panel)).toHaveCount(0);
  // The composer is still there: only the tip went.
  await expect(panel.locator('textarea, [contenteditable="true"]').first()).toBeVisible();

  await page.reload();
  panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${TIP_SESSION}"]`);
  await expect(panel.locator('.session-history')).toContainText('Answer 5.', { timeout: 20_000 });
  await expect(tipOf(panel)).toHaveCount(0);

  // The self-report writes the next turn's recap (minutes later, no refetch due):
  // the event alone must bring the tip back, with the overview it did not touch.
  await injectEvent(page, 'session:recap-updated', {
    sessionId: TIP_SESSION, recap: RECAP_NEXT, recapAt: '2026-09-18T09:30:00.000Z',
  });
  await expectTwoRows(panel, OVERVIEW_ZH, RECAP_NEXT);

  // Dismissing THIS version and reloading against a record that now carries it
  // stays hidden too: the remembered choice is per version, not per page load.
  await tipOf(panel).getByRole('button', { name: 'Dismiss recap' }).click();
  await expect(tipOf(panel)).toHaveCount(0);
  tip.current = { ...BOTH, recap: RECAP_NEXT, recapAt: '2026-09-18T09:30:00.000Z' };
  await page.reload();
  await expect(panel.locator('.session-history')).toContainText('Answer 5.', { timeout: 20_000 });
  await expect(tipOf(panel)).toHaveCount(0);

  // An overview-only update is a new version as well.
  await injectEvent(page, 'session:recap-updated', {
    sessionId: TIP_SESSION, overview: 'Overall, rewritten.', overviewAt: '2026-09-18T09:40:00.000Z',
  });
  await expectTwoRows(panel, 'Overall, rewritten.', RECAP_NEXT);
});

test('4. an event for another session changes nothing here', async ({ page }) => {
  await captureWs(page);
  await mockTipSession(page, TIP_SESSION, { current: BOTH });
  const panel = await openTipSession(page);
  await expectTwoRows(panel, OVERVIEW_ZH, RECAP_ZH);
  await injectEvent(page, 'session:recap-updated', {
    sessionId: OTHER_SESSION, recap: 'Someone else\'s turn.', recapAt: '2026-09-18T09:30:00.000Z',
    overview: 'Someone else\'s session.', overviewAt: '2026-09-18T09:30:00.000Z',
  });
  // Give a wrong-session update every chance to land before asserting it did not.
  await page.waitForTimeout(300);
  await expectTwoRows(panel, OVERVIEW_ZH, RECAP_ZH);
});

test('5. a record from before the overview existed shows the Latest row alone', async ({ page }) => {
  await mockTipSession(page, TIP_SESSION, { current: { recap: 'Fixed the timeout bug, tests green.', recapAt: '2026-09-18T09:00:00.000Z' } });
  const panel = await openTipSession(page);
  const tip = tipOf(panel);
  await expect(tip).toBeVisible();
  await expect(tip.getByTestId('session-recap-overview')).toHaveCount(0);
  await expect(tip.getByTestId('session-recap-latest').locator('.session-recap-tip-text')).toHaveText('Fixed the timeout bug, tests green.');
  await expect(tip.getByRole('button', { name: 'Dismiss recap' })).toBeVisible();
});

test('6. 300-char rows wrap in full and stay clear of the ×', async ({ page }) => {
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

test('7. an event that lands before the record fetch resolves is kept, and the older record does not clobber it', async ({ page }) => {
  await captureWs(page);
  // The record answers late (a slow server), carrying the OLD recap.
  const messages = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant', msgId: `late-m${i}`,
    text: i % 2 === 0 ? `Question ${i}` : `Answer ${i}.`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
  await page.route(`**/api/sessions/${TIP_SESSION}/history**`, (route) => route.fulfill({
    json: { messages, total: messages.length, cursor: messages.length, delta: false },
  }));
  let recordServed = 0;
  await page.route(`**/api/sessions/${TIP_SESSION}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await new Promise((r) => setTimeout(r, 2500));
    recordServed++;
    await route.fulfill({ json: { session: {
      claudeSessionId: TIP_SESSION, taskId: `${TIP_SESSION}-task`, project: 'Walnut',
      process_status: 'idle', mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: new Date().toISOString(), messageCount: messages.length, title: 'Recap tip', cwd: '/tmp',
      ...BOTH,
    } } });
  });
  await page.addInitScript((sid) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sid, locked: false }]));
  }, TIP_SESSION);
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/');
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${TIP_SESSION}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });

  // The event beats the record.
  await injectEvent(page, 'session:recap-updated', {
    sessionId: TIP_SESSION, recap: RECAP_NEXT, recapAt: '2026-09-18T09:30:00.000Z',
  });
  expect(recordServed).toBe(0);
  await expect(tipOf(panel).getByTestId('session-recap-latest').locator('.session-recap-tip-text')).toHaveText(RECAP_NEXT);

  // The record lands afterwards with the older recap and the overview the event
  // did not carry: the newer recap stays, the overview appears.
  await expect.poll(() => recordServed, { timeout: 10_000 }).toBeGreaterThan(0);
  await expectTwoRows(panel, OVERVIEW_ZH, RECAP_NEXT);
});
