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
 *  6. 300-char rows wrap in full (never ellipsize) and stay clear of the \u00d7;
 *  7. an event that beats the record fetch is kept;
 *  8. layout (2026-09-19 report: the label column and the icon cost a narrow
 *     column a third of its width, the card stacked ten lines high): no icon,
 *     labels inline at the start of their paragraph, the body capped at a few
 *     lines and scrolling past that in a NARROW column, uncapped content that
 *     fits, the \u00d7 fixed outside the scroll box.
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
/** Real-density pair (the 2026-09-19 screenshot ran ~100 and ~75 CJK characters):
 *  the same sentences repeated, so a narrow column has to cap them. */
export const OVERVIEW_ZH_LONG = OVERVIEW_ZH.repeat(4);
export const RECAP_ZH_LONG = RECAP_ZH.repeat(3);
/** One line each even in a narrow column ("deployed." / "verified."). */
export const OVERVIEW_ZH_SHORT = '\u5df2\u90e8\u7f72\u3002';
export const RECAP_ZH_SHORT = '\u9a8c\u8bc1\u901a\u8fc7\u3002';

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

/** Two columns in an 1100px window: ~274px each, the reported narrow case. Both
 *  sessions must be mocked; the second is only there to take the width. */
export async function openNarrowTipSession(page: Page, id = TIP_SESSION, filler = OTHER_SESSION): Promise<Locator> {
  await page.addInitScript(([sid, other]) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sid, locked: false }, { id: other, locked: false }]));
  }, [id, filler] as const);
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/');
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('.session-history')).toContainText('Answer 5.', { timeout: 20_000 });
  const box = await panel.boundingBox();
  expect(box!.width, 'the column must actually be narrow for this scenario to mean anything').toBeLessThan(340);
  return panel;
}

export const tipOf = (panel: Locator) => panel.getByTestId('session-recap-tip');
export const bodyOf = (panel: Locator) => tipOf(panel).locator('.session-recap-tip-body');

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
  await expectFirstLineClearOfClose(panel);
  // The overview reads first: "where are we" before "what just happened".
  const [o, l] = await Promise.all([overviewRow.boundingBox(), latestRow.boundingBox()]);
  expect(o!.y).toBeLessThan(l!.y);
  await expectInlineLabels(tip);
}

/** No icon, and each label is an inline run: the text's first glyph sits on the
 *  label's own line, right after it, instead of in a column of its own. */
export async function expectInlineLabels(tip: Locator): Promise<void> {
  await expect(tip.locator('.session-recap-tip-icon')).toHaveCount(0);
  expect((await tip.innerText()).includes('\u{1F4AC}'), 'no speech-balloon icon in the card').toBe(false);
  const rows = tip.locator('.session-recap-tip-row');
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const m = await rows.nth(i).evaluate((row) => {
      const label = row.querySelector('.session-recap-tip-label')!.getBoundingClientRect();
      const textNode = row.querySelector('.session-recap-tip-text')!.firstChild as Text;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 1);
      const glyph = range.getBoundingClientRect();
      return { labelTop: label.top, labelRight: label.right, glyphTop: glyph.top, glyphLeft: glyph.left, glyphHeight: glyph.height };
    });
    // Same line: the glyph's box overlaps the label's line vertically...
    expect(Math.abs(m.glyphTop - m.labelTop), `row ${i}: label and text are not on one line`).toBeLessThan(m.glyphHeight);
    // ...and it starts to the label's right, not under it.
    expect(m.glyphLeft, `row ${i}: text does not follow the label inline`).toBeGreaterThanOrEqual(m.labelRight - 0.5);
  }
}

/** The body's cap. `scrollable` = whether this content, at this width, must
 *  overflow: then the body scrolls (class + real overflow), stays at or under
 *  N lines, and scrolling to the end reaches the last paragraph in full (the
 *  text is never ellipsized, only scrolled). Otherwise nothing is clipped and no
 *  scroll track is switched on. Either way NO scrollbar may take layout width
 *  (the visible bar collided with the \u00d7 in the reported screenshot) and the
 *  first line stops short of the \u00d7. */
export async function expectBodyCap(panel: Locator, scrollable: boolean, maxLines: number): Promise<void> {
  const body = bodyOf(panel);
  await expect(body).toHaveAttribute('data-scrollable', String(scrollable));
  const m = await body.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      overflowY: cs.overflowY, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth, offsetWidth: (el as HTMLElement).offsetWidth,
      lineHeight: parseFloat(cs.lineHeight), padY: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
      rect: el.getBoundingClientRect().toJSON() as DOMRect,
    };
  });
  // A scroll track would show up as layout width the content cannot use.
  expect(m.offsetWidth - m.clientWidth, 'a scrollbar is taking layout width').toBeLessThanOrEqual(1);
  const lines = (m.clientHeight - m.padY) / m.lineHeight;
  if (scrollable) {
    // A CAPPED box must end on a LINE boundary in whichever engine is running: a
    // cap computed from a ratio (1.35 x 11px) is 14.85px in Chromium but floored
    // to 14px in WebKit, which showed four lines plus a sliced fifth in the Mac
    // app. (An UNCAPPED box is as tall as its content, which carries a stray
    // pixel per paragraph, so this only holds here.)
    expect(Math.abs(lines - Math.round(lines)), `the cap cuts a line in half (${lines} lines)`).toBeLessThan(0.1);
    expect(m.overflowY).toBe('auto');
    expect(m.scrollHeight).toBeGreaterThan(m.clientHeight + 1);
    expect(lines, 'the body shows more lines than its cap').toBeLessThanOrEqual(maxLines + 0.15);
    // Scroll to the end: the last paragraph's bottom is inside the box.
    const reached = await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      const last = el.lastElementChild!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const pb = parseFloat(getComputedStyle(el).paddingBottom);
      return { lastBottom: last.bottom, boxBottom: box.bottom - pb, scrollTop: el.scrollTop };
    });
    expect(reached.scrollTop).toBeGreaterThan(0);
    expect(reached.lastBottom).toBeLessThanOrEqual(reached.boxBottom + 1);
    // At the end of the scroll the fade is gone, so the last line reads at full
    // strength; before that it marks "there is more".
    await expect(body).toHaveAttribute('data-more', 'false');
    await body.evaluate((el) => { el.scrollTop = 0; });
    await expect(body).toHaveAttribute('data-more', 'true');
    await expect(body).toHaveJSProperty('tabIndex', 0);
  } else {
    expect(m.overflowY).toBe('hidden');
    expect(m.scrollHeight, 'content that fits must not be clipped').toBeLessThanOrEqual(m.clientHeight + 1);
    // Nothing to reveal: no fade, and the box is not a tab stop.
    await expect(body).toHaveAttribute('data-more', 'false');
    await expect(body).toHaveJSProperty('tabIndex', -1);
  }
  await expectFirstLineClearOfClose(panel);
}

/** The opening line stops short of the \u00d7; later lines may run past it,
 *  because the button carries the card's background and the text scrolls
 *  behind it. Measured on the first line's own client rect, not the paragraph's. */
export async function expectFirstLineClearOfClose(panel: Locator): Promise<void> {
  const close = await tipOf(panel).getByRole('button', { name: 'Dismiss recap' }).boundingBox();
  expect(close, 'the dismiss button is visible').toBeTruthy();
  const firstLineRight = await tipOf(panel).locator('.session-recap-tip-row').first().evaluate((row) => {
    const range = document.createRange();
    range.selectNodeContents(row);
    const rects = [...range.getClientRects()];
    const top = Math.min(...rects.map((r) => r.top));
    return Math.max(...rects.filter((r) => r.top <= top + 1).map((r) => r.right));
  });
  expect(firstLineRight, 'the first line runs under the dismiss button').toBeLessThanOrEqual(close!.x + 0.5);
}

/** Every paragraph is fully laid out across (no horizontal clipping) and wraps
 *  when long. Only the FIRST line has to clear the \u00d7 (see
 *  expectFirstLineClearOfClose); vertical capping is the body's business
 *  (expectBodyCap). */
export async function expectWrappedClearOfClose(panel: Locator): Promise<void> {
  const tip = tipOf(panel);
  const close = await tip.getByRole('button', { name: 'Dismiss recap' }).boundingBox();
  const rows = tip.locator('.session-recap-tip-row');
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const el = rows.nth(i);
    const metrics = await el.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(node).lineHeight);
      return { right: r.right, height: r.height, lines: Math.round(r.height / lineHeight), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, text: node.textContent ?? '' };
    });
    expect(metrics.scrollWidth, `row ${i} clipped horizontally`).toBeLessThanOrEqual(metrics.clientWidth + 1);
    if (metrics.text.length >= 200) expect(metrics.lines, `row ${i} should wrap onto several lines`).toBeGreaterThan(1);
    expect(metrics.right, `row ${i} overflows the card`).toBeLessThanOrEqual(close!.x + close!.width + 4);
  }
  await expectFirstLineClearOfClose(panel);
}
