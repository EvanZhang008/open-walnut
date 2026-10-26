import { expect, type TestType } from '@playwright/test';
import {
  TIP_SESSION, OTHER_SESSION, OVERVIEW_ZH, RECAP_ZH, RECAP_NEXT, BOTH,
  mockTipSession, openColumns, popoverOf, expectNoStrip, plusMenuLabels, openLatestUpdate, expectRows,
  expectInViewport, shoot, captureWs, injectEvent,
} from './session-latest-update-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function latestUpdateCases(test: TestType<any, any>): void {
  // Room for a cold dev server's first compile (openColumns waits up to 90 s for the panel).
  test.describe.configure({ timeout: 150_000 });
  test('1. no strip above the composer; "+" leads with Latest update; it opens, closes three ways, and reopens', async ({ page }) => {
    await mockTipSession(page, TIP_SESSION, { current: BOTH });
    const panel = await openColumns(page, [TIP_SESSION]);
    await expectNoStrip(panel);
    await shoot(page, 'composer-without-strip', panel.locator('.chat-input-container, .chat-input').first());

    const labels = await plusMenuLabels(panel);
    expect(labels.find((l) => /Latest update/.test(l)), labels.join(' | ')).toBeTruthy();
    // The first of the caller rows: it is about this session, not an action.
    const firstCallerRow = await page.locator('.chat-plus-menu[role=menu] button.chat-plus-menu-item[data-action-id]').first().getAttribute('data-action-id');
    expect(firstCallerRow).toBe('latest-update');
    await page.keyboard.press('Escape');

    let pop = await openLatestUpdate(panel);
    await expectRows(pop, OVERVIEW_ZH, RECAP_ZH);
    await expectInViewport(pop);
    // "where are we" before "what just happened"
    const [o, l] = await Promise.all([pop.getByTestId('session-recap-overview').boundingBox(), pop.getByTestId('session-recap-latest').boundingBox()]);
    expect(o!.y).toBeLessThan(l!.y);
    await shoot(page, 'popover-open', pop);
    await page.keyboard.press('Escape');
    await expect(popoverOf(page)).toHaveCount(0);

    pop = await openLatestUpdate(panel);
    await pop.getByRole('button', { name: 'Close' }).click();
    await expect(popoverOf(page)).toHaveCount(0);

    pop = await openLatestUpdate(panel);
    await panel.locator('.session-history').click({ position: { x: 20, y: 20 } });
    await expect(popoverOf(page)).toHaveCount(0);

    // Still nothing drawn above the composer, and a fourth open works.
    await expectNoStrip(panel);
    pop = await openLatestUpdate(panel);
    await expectRows(pop, OVERVIEW_ZH, RECAP_ZH);
  });

  test('2. a live recap updates the open popover; an event for another session changes nothing', async ({ page }) => {
    await captureWs(page);
    await mockTipSession(page, TIP_SESSION, { current: BOTH });
    const panel = await openColumns(page, [TIP_SESSION]);
    const pop = await openLatestUpdate(panel);
    await expectRows(pop, OVERVIEW_ZH, RECAP_ZH);
    await injectEvent(page, 'session:recap-updated', {
      sessionId: OTHER_SESSION, recap: 'Someone else\'s turn.', recapAt: '2026-09-18T09:30:00.000Z',
    });
    await page.waitForTimeout(300);
    await expectRows(pop, OVERVIEW_ZH, RECAP_ZH);
    await injectEvent(page, 'session:recap-updated', {
      sessionId: TIP_SESSION, recap: RECAP_NEXT, recapAt: '2026-09-18T09:30:00.000Z',
    });
    await expectRows(pop, OVERVIEW_ZH, RECAP_NEXT);
    await expectNoStrip(panel, [OVERVIEW_ZH, RECAP_NEXT]);
  });

  test('3. a record from before the overview existed shows the Latest row alone', async ({ page }) => {
    await mockTipSession(page, TIP_SESSION, { current: { recap: 'Fixed the timeout bug, tests green.', recapAt: '2026-09-18T09:00:00.000Z' } });
    const panel = await openColumns(page, [TIP_SESSION]);
    const pop = await openLatestUpdate(panel);
    await expectRows(pop, null, 'Fixed the timeout bug, tests green.');
  });

  test('4. a session with no recap has no Latest update row', async ({ page }) => {
    await mockTipSession(page, TIP_SESSION, { current: {} });
    const panel = await openColumns(page, [TIP_SESSION]);
    const labels = await plusMenuLabels(panel);
    expect(labels.some((l) => /Latest update/.test(l)), labels.join(' | ')).toBe(false);
    await expectNoStrip(panel);
  });

  test('5. 300-char rows wrap in full and stay inside the viewport, in a narrow column too', async ({ page }) => {
    const long = (seed: string) => `${seed} `.repeat(40).slice(0, 300).trim();
    const tip = { current: {
      overview: long('overview words'), overviewAt: '2026-09-18T09:00:00.000Z',
      recap: long('recap words'), recapAt: '2026-09-18T09:00:00.000Z',
    } };
    await mockTipSession(page, TIP_SESSION, tip);
    await mockTipSession(page, OTHER_SESSION, { current: {} });
    const panel = await openColumns(page, [TIP_SESSION, OTHER_SESSION]);
    expect((await panel.boundingBox())!.width).toBeLessThan(560);
    const pop = await openLatestUpdate(panel);
    await expectRows(pop, tip.current.overview, tip.current.recap);
    await expectInViewport(pop);
    // Full text, never ellipsized.
    const clipped = await pop.locator('.latest-update-text').evaluateAll((els) => els.some((e) => getComputedStyle(e).textOverflow === 'ellipsis'));
    expect(clipped).toBe(false);
    await shoot(page, 'popover-long-narrow', pop);
  });

  test('6. an event that lands before the record fetch is kept; the older record does not clobber it', async ({ page }) => {
    await captureWs(page);
    const rec = await mockTipSession(page, TIP_SESSION, { current: BOTH }, 2500);
    const panel = await openColumns(page, [TIP_SESSION], 1100, false);
    await injectEvent(page, 'session:recap-updated', {
      sessionId: TIP_SESSION, recap: RECAP_NEXT, recapAt: '2026-09-18T09:30:00.000Z',
    });
    expect(rec.served()).toBe(0);
    await expect.poll(() => rec.served(), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(panel.locator('.session-history')).toContainText('Answer 5.', { timeout: 20_000 });
    const pop = await openLatestUpdate(panel);
    await expectRows(pop, OVERVIEW_ZH, RECAP_NEXT);
  });
}
