/**
 * The recap tip above the session composer: the two rows the turn-complete
 * self-report writes (Overall = the whole session, Latest = the last turn), the
 * \u00d7 that hides one version of it, and the live update that brings it back.
 *
 * Reported (2026-09-18, Mac app screenshot): the tip came out in English for a
 * `language: zh` user, it could not be closed, and it showed only the latest
 * turn. The language half is server-side (tests/core/recap-tip-fields.test.ts);
 * this file drives the browser half, in both engines because the Mac app is a
 * WKWebView.
 *
 * Scenario matrix:
 *  1. a record with both fields shows two labelled rows, in the user's language
 *     (CJK text), with a dismiss control;
 *  2. \u00d7 hides the tip; a reload keeps it hidden (the choice is remembered);
 *  3. a `session:recap-updated` event with new text brings the tip back with the
 *     new Latest row and the overview it did not replace;
 *  4. an event for ANOTHER session changes nothing;
 *  5. a record from before the overview existed shows the Latest row alone;
 *  6. 300-char rows wrap in full (never ellipsize) and stay clear of the \u00d7.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { captureWs, injectEvent } from './ws-capture-helpers';

export { captureWs, injectEvent };

export const TIP_SESSION = 'pw-recap-tip-session';
/** Evidence shots of the composer block (the tip and the input under it). */
export const SHOT_DIR = process.env.RECAP_SHOT_DIR ?? '/tmp/recap-tip';
export const OTHER_SESSION = 'pw-recap-tip-other';

/** The reported case: a Chinese display language. The strings spell "overall:
 *  reworking the composer layout" and "latest: deployed, verified". */
export const OVERVIEW_ZH = '\u91cd\u505a composer \u5e03\u5c40\uff0c\u8ba9\u6eda\u52a8\u6761\u6b62\u4e8e\u6700\u540e\u4e00\u884c\uff1b\u4fee\u590d\u5df2\u63d0\u4ea4\u3002';
export const RECAP_ZH = '\u5df2\u90e8\u7f72\u5230 3456\uff0cWebKit \u4e0e Chromium \u9a8c\u8bc1\u901a\u8fc7\u3002';
export const RECAP_NEXT = '\u65b0\u7684\u4e00\u8f6e\uff1a\u52a0\u4e86\u5173\u95ed\u6309\u94ae\u3002';

export interface TipRecord {
  recap?: string;
  recapAt?: string;
  overview?: string;
  overviewAt?: string;
}

function rows(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    msgId: `${prefix}-m${i}`,
    text: i % 2 === 0 ? `Question ${i}` : `Answer ${i}.`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

/** Mock one idle session whose record carries the given tip fields. The record
 *  is read through a mutable holder so a test can change what the NEXT fetch
 *  returns (a reload after the server wrote a new recap). */
export async function mockTipSession(page: Page, id: string, tip: { current: TipRecord }): Promise<void> {
  const messages = rows(id, 6);
  await page.route(`**/api/sessions/${id}/history**`, (route) => route.fulfill({
    json: { messages, total: messages.length, cursor: messages.length, delta: false },
  }));
  await page.route(`**/api/sessions/${id}`, (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    return route.fulfill({
      json: {
        session: {
          claudeSessionId: id, taskId: `${id}-task`, project: 'Walnut',
          process_status: 'idle', mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(), messageCount: messages.length,
          title: 'Recap tip', cwd: '/tmp',
          ...tip.current,
        },
      },
    });
  });
}

/** Restore the session as a home column and wait for its panel. */
export async function openTipSession(page: Page, id = TIP_SESSION): Promise<Locator> {
  await page.addInitScript((sid) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sid, locked: false }]));
  }, id);
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/');
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('.session-history')).toContainText('Answer 5.', { timeout: 20_000 });
  return panel;
}

export const tipOf = (panel: Locator) => panel.getByTestId('session-recap-tip');

/** Crop the composer block (tip + input card) so the shot stays small and on
 *  point. Named by the engine that actually rendered it: a spec runs under
 *  whichever projects are selected, so the spec's own name would lie. */
export async function shootComposer(panel: Locator, name: string): Promise<void> {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const tip = await tipOf(panel).boundingBox();
  const box = await panel.boundingBox();
  if (!tip || !box) return;
  const engine = panel.page().context().browser()?.browserType().name() ?? 'browser';
  const top = Math.max(box.y, tip.y - 40);
  await panel.page().screenshot({
    path: `${SHOT_DIR}/${engine}-${name}.png`,
    clip: { x: box.x, y: top, width: box.width, height: Math.min(box.y + box.height - top, 260) },
  });
}

/** Both rows, labelled, in the record's language, with the \u00d7 present. */
export async function expectTwoRows(panel: Locator, overview: string, recap: string): Promise<void> {
  const tip = tipOf(panel);
  await expect(tip).toBeVisible();
  const overviewRow = tip.getByTestId('session-recap-overview');
  const latestRow = tip.getByTestId('session-recap-latest');
  await expect(overviewRow.locator('.session-recap-tip-label')).toHaveText('Overall');
  await expect(overviewRow.locator('.session-recap-tip-text')).toHaveText(overview);
  await expect(latestRow.locator('.session-recap-tip-label')).toHaveText('Latest');
  await expect(latestRow.locator('.session-recap-tip-text')).toHaveText(recap);
  await expect(tip.getByRole('button', { name: 'Dismiss recap' })).toBeVisible();
  // The overview reads first: "where are we" before "what just happened".
  const [o, l] = await Promise.all([overviewRow.boundingBox(), latestRow.boundingBox()]);
  expect(o!.y).toBeLessThan(l!.y);
  // The two texts start on one column: the labels differ in width ("Overall" is
  // the wider), and a per-row label box used to shift the second text left.
  const [ot, lt] = await Promise.all([
    overviewRow.locator('.session-recap-tip-text').boundingBox(),
    latestRow.locator('.session-recap-tip-text').boundingBox(),
  ]);
  expect(Math.abs(ot!.x - lt!.x)).toBeLessThanOrEqual(0.5);
}

/** Every row's text is fully laid out (no clipping) and ends left of the \u00d7. */
export async function expectWrappedClearOfClose(panel: Locator): Promise<void> {
  const tip = tipOf(panel);
  const close = await tip.getByRole('button', { name: 'Dismiss recap' }).boundingBox();
  const texts = tip.locator('.session-recap-tip-text');
  const n = await texts.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const el = texts.nth(i);
    const metrics = await el.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(node).lineHeight);
      return { right: r.right, height: r.height, lines: Math.round(r.height / lineHeight), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, text: node.textContent ?? '' };
    });
    expect(metrics.scrollWidth, `row ${i} clipped horizontally`).toBeLessThanOrEqual(metrics.clientWidth + 1);
    if (metrics.text.length >= 200) expect(metrics.lines, `row ${i} should wrap onto several lines`).toBeGreaterThan(1);
    expect(metrics.right, `row ${i} runs under the dismiss button`).toBeLessThanOrEqual(close!.x + 0.5);
  }
}
