/**
 * "Latest update" in the session composer's "+" menu: the two recap paragraphs
 * the turn-complete self-report writes (Overall = the whole session, Latest =
 * the last turn), opened on demand in a popover.
 *
 * Until 2026-10-26 they were a grey card above every composer. The user: "it is
 * not very useful and it takes a lot of space, that space is precious; put it
 * in the plus menu, like a latest update". Both engines run the matrix (the Mac
 * app is a WKWebView).
 *
 * Scenario matrix:
 *  1. a session with a recap draws NOTHING above the composer; the "+" menu
 *     leads with "Latest update"; it opens a popover with both labelled rows in
 *     the user's language (CJK); Escape, the close button and an outside click
 *     each close it, and it opens again every time;
 *  2. a `session:recap-updated` event updates the popover while it is open; an
 *     event for ANOTHER session changes nothing;
 *  3. a record from before the overview existed shows the Latest row alone;
 *  4. a session with no recap has no "Latest update" row;
 *  5. 300-char rows wrap in full, inside the viewport, in a narrow column too;
 *  6. an event that beats the record fetch is kept.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { captureWs, injectEvent } from './ws-capture-helpers';

export { captureWs, injectEvent };

export const TIP_SESSION = 'pw-latest-update-session';
export const OTHER_SESSION = 'pw-latest-update-other';
export const SHOT_DIR = process.env.RECAP_SHOT_DIR ?? '/tmp/latest-update';

/** The reported case: a Chinese display language ("overall: reworking the
 *  composer layout", "latest: deployed, verified", "a new round: added a close button"). */
export const OVERVIEW_ZH = '\u91cd\u505a composer \u5e03\u5c40\uff0c\u8ba9\u6eda\u52a8\u6761\u6b62\u4e8e\u6700\u540e\u4e00\u884c\uff1b\u4fee\u590d\u5df2\u63d0\u4ea4\u3002';
export const RECAP_ZH = '\u5df2\u90e8\u7f72\u5230 3456\uff0cWebKit \u4e0e Chromium \u9a8c\u8bc1\u901a\u8fc7\u3002';
export const RECAP_NEXT = '\u65b0\u7684\u4e00\u8f6e\uff1a\u52a0\u4e86\u5173\u95ed\u6309\u94ae\u3002';

export interface TipRecord {
  recap?: string;
  recapAt?: string;
  overview?: string;
  overviewAt?: string;
}

export const BOTH: TipRecord = {
  overview: OVERVIEW_ZH, overviewAt: '2026-09-18T09:00:00.000Z',
  recap: RECAP_ZH, recapAt: '2026-09-18T09:00:00.000Z',
};

function rows(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    msgId: `${prefix}-m${i}`,
    text: i % 2 === 0 ? `Question ${i}` : `Answer ${i}.`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

export function sessionRecord(id: string, tip: TipRecord, messageCount = 6) {
  return {
    claudeSessionId: id, taskId: `${id}-task`, project: 'Walnut',
    process_status: 'idle', mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: new Date().toISOString(), messageCount,
    title: 'Latest update', cwd: '/tmp',
    ...tip,
  };
}

/** Mock one idle session whose record carries the given recap fields, read
 *  through a holder so a test can change what the NEXT fetch returns. */
export async function mockTipSession(page: Page, id: string, tip: { current: TipRecord }, delayMs = 0): Promise<{ served: () => number }> {
  const messages = rows(id, 6);
  let served = 0;
  await page.route(`**/api/sessions/${id}/history**`, (route) => route.fulfill({
    json: { messages, total: messages.length, cursor: messages.length, delta: false },
  }));
  await page.route(`**/api/sessions/${id}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    served++;
    return route.fulfill({ json: { session: sessionRecord(id, tip.current, messages.length) } });
  });
  return { served: () => served };
}

/** Restore the given sessions as home columns and wait for the first one's panel. */
export async function openColumns(page: Page, ids: string[], width = 1100, wait = true): Promise<Locator> {
  await page.addInitScript((sids) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify(sids.map((id) => ({ id, locked: false }))));
  }, ids);
  await page.setViewportSize({ width, height: 760 });
  // A real link click into the app, never page.goto (repo rule).
  const base = test.info().project.use.baseURL ?? `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`;
  await page.setContent(`<a href="${base}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click();
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids[0]}"]`);
  // The first spec of a run meets a cold dev server that is still compiling the app.
  await expect(panel).toBeVisible({ timeout: 90_000 });
  if (wait) await expect(panel.locator('.session-history')).toContainText('Answer 5.', { timeout: 20_000 });
  return panel;
}

export const popoverOf = (page: Page) => page.getByTestId('latest-update-popover');

/** Nothing of the recap is drawn in the panel itself: neither its rows nor its
 *  text (the popover is portalled to the body, outside the panel). */
export async function expectNoStrip(panel: Locator, texts: string[] = [OVERVIEW_ZH, RECAP_ZH]): Promise<void> {
  await expect(panel.getByTestId('session-recap-overview')).toHaveCount(0);
  await expect(panel.getByTestId('session-recap-latest')).toHaveCount(0);
  for (const t of texts) await expect(panel).not.toContainText(t);
}

export async function plusMenuLabels(panel: Locator): Promise<string[]> {
  await panel.locator('.chat-plus-btn').first().click();
  const menu = panel.page().locator('.chat-plus-menu[role=menu]');
  await expect(menu).toBeVisible();
  return (await menu.locator('button.chat-plus-menu-item').allInnerTexts()).map((t) => t.trim());
}

/** Open "Latest update" from the "+" menu; returns the popover. */
export async function openLatestUpdate(panel: Locator): Promise<Locator> {
  const page = panel.page();
  await panel.locator('.chat-plus-btn').first().click();
  const row = page.locator('.chat-plus-menu[role=menu] button.chat-plus-menu-item[data-action-id="latest-update"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveText(/Latest update/);
  await row.click();
  const pop = popoverOf(page);
  await expect(pop).toBeVisible();
  await expect(page.locator('.chat-plus-menu[role=menu]')).toHaveCount(0);
  return pop;
}

export async function expectRows(pop: Locator, overview: string | null, recap: string): Promise<void> {
  if (overview) {
    const o = pop.getByTestId('session-recap-overview');
    await expect(o.locator('.latest-update-label')).toHaveText('Overall');
    await expect(o.locator('.latest-update-text')).toHaveText(overview);
  } else {
    await expect(pop.getByTestId('session-recap-overview')).toHaveCount(0);
  }
  const l = pop.getByTestId('session-recap-latest');
  await expect(l.locator('.latest-update-label')).toHaveText('Latest');
  await expect(l.locator('.latest-update-text')).toHaveText(recap);
}

/** The popover sits wholly inside the viewport. */
export async function expectInViewport(pop: Locator): Promise<void> {
  const box = (await pop.boundingBox())!;
  const vp = pop.page().viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
}

export async function shoot(page: Page, name: string, clip?: Locator): Promise<void> {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const engine = page.context().browser()?.browserType().name() ?? 'browser';
  const box = clip ? await clip.boundingBox() : null;
  await page.screenshot({
    path: `${SHOT_DIR}/${engine}-${name}.png`,
    ...(box ? { clip: { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 20), width: Math.min(box.width + 40, 1280), height: box.height + 120 } } : {}),
  });
}
