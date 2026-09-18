/**
 * Shared kit for "the adopted ✦ search reads as a conversation" — the transcript
 * side of the AI search.
 *
 * Both engines need the SAME scenarios: Chromium for the matrix, WebKit because
 * the Mac app is a WKWebView and this change is all wrap/ellipsis/overflow
 * geometry inside a message column. A `test.use` browser pin only works at a spec
 * file's top level, so the WebKit half is its own file and the scenarios live
 * here.
 *
 * Fixture (tests/e2e/browser/test-server.ts): session `pw-search-ask-session`
 * whose transcript is the REAL prompt the server builds, the model's narration,
 * and the bare JSON answer naming two live tasks plus one dead id.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { REAL_PANEL, loadHome, seedColumns } from './draft-helpers';

export const SCREENSHOT_DIR = process.env.SEARCH_ASK_SHOT_DIR ?? '/tmp/search-ask-transcript';
export const SESSION_ID = 'pw-search-ask-session';
export const LIVE_TASK_ID = 'pw-task-vscode';
export const DONE_TASK_ID = 'pw-task-done-marmalade';
export const DEAD_TASK_ID = 'pw-task-vanished-0001';
/** The answer names this one by a unique PREFIX (`pw-task-question-r`). */
export const PREFIX_TASK_ID = 'pw-task-question-recovery';

/** The folded prompt row, and the answer card. */
export const PROMPT_BANNER = '[data-testid="injected-banner"][data-banner-name="AI search prompt"]';
export const ANSWER_CARD = '[data-testid="session-search-answer"]';

/** Mount the adopted search session's panel on the homepage. */
export async function openSearchAsk(page: Page): Promise<Locator> {
  await seedColumns(page, [SESSION_ID]);
  await loadHome(page);
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${SESSION_ID}"]`);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  // History arrives from the server, so wait for the transcript, not the shell.
  await expect(panel.locator(ANSWER_CARD)).toBeVisible({ timeout: 30_000 });
  return panel;
}

/**
 * The first turn reads as the QUESTION: the seeded prompt is folded into one
 * disclosure row, and no part of the row dump is on screen.
 */
export async function expectPromptFolded(panel: Locator): Promise<void> {
  const bubble = panel.locator('.session-msg-user').first();
  await expect(bubble.locator(PROMPT_BANNER)).toBeVisible();
  const text = await bubble.innerText();
  expect(text).toContain('unit test');
  expect(text).not.toContain('SEED RESULTS');
  expect(text).not.toContain('Find the Walnut task matching');
}

/**
 * The panel says what this conversation IS.
 *
 * The adopt path titles the ask `Search query: <what was typed>` (2026-09-17):
 * bare search words read as a todo the user wrote themselves, on the board and in
 * the session header alike. The label costs 14 characters of a one-line title, so
 * the geometry is checked with it: the header must ellipsize, never widen the
 * panel or wrap into a second line.
 */
export async function expectTitleLabelled(panel: Locator): Promise<void> {
  const title = panel.locator('.session-panel-title').first();
  await expect(title).toHaveText('Search query: unit test');
  // The header is `nowrap` + ellipsis, so the failure the label can cause is not a
  // wrap: it is the query disappearing into "Search query: uni…". Nothing may be
  // clipped at the widths tested here — that is what bounds how long the label
  // may get, and it is the reason the label is short.
  const fit = await title.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(fit.scrollWidth, `the labelled title is clipped: ${JSON.stringify(fit)}`)
    .toBeLessThanOrEqual(fit.clientWidth + 1);
}

/** WCAG relative luminance of a computed `rgb(...)` / `rgba(...)` colour. */
function luminance(color: string): number {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Collapse, not strip: the whole prompt is one click away, verbatim — AND legible.
 *  The disclosure sits in a user bubble (white-ish text on `--accent`), where a
 *  code block that only sets its own light background renders grey-on-grey. */
export async function expectSeedDisclosed(panel: Locator): Promise<void> {
  const banner = panel.locator(PROMPT_BANNER);
  await banner.locator('.tool-run-toggle').click();
  const body = banner.locator('[data-testid="injected-banner-body"]');
  await expect(body).toBeVisible();
  await expect(body).toContainText('SEED RESULTS');
  await expect(body).toContainText('Find the Walnut task matching this search');
  await expect(body).toContainText(LIVE_TASK_ID);

  const tones = await body.locator('pre').first().evaluate((pre) => {
    const code = pre.querySelector('code') ?? pre;
    return {
      background: getComputedStyle(pre).backgroundColor,
      text: getComputedStyle(code).color,
    };
  });
  const [light, dark] = [luminance(tones.background), luminance(tones.text)].sort((a, b) => b - a);
  const ratio = (light + 0.05) / (dark + 0.05);
  expect(ratio, `prompt disclosure contrast ${JSON.stringify(tones)}`).toBeGreaterThanOrEqual(4.5);
}

/**
 * The answer reads as task rows, titled from the LIVE task table — not from the
 * ids the transcript froze, and not as JSON.
 */
export async function expectAnswerCarded(panel: Locator): Promise<void> {
  const card = panel.locator(ANSWER_CARD);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Two board searches match');
  // Five rows in the answer, four tasks: the literal repeat collapses.
  await expect(card.locator('.agent-search-results > li')).toHaveCount(4);
  await expect(card).toContainText('4 matches');
  await expect(card.locator(`[data-task-id="${LIVE_TASK_ID}"]`)).toHaveCount(1);

  // An id PREFIX resolves to the real task, so its row is titled and clickable
  // under the FULL id — the model does answer with prefixes.
  const viaPrefix = card.locator(`[data-task-id="${PREFIX_TASK_ID}"]`);
  await expect(viaPrefix.locator('.agent-search-row-title')).toHaveText('Question recovery fixture');

  const live = card.locator(`[data-task-id="${LIVE_TASK_ID}"]`);
  await expect(live.locator('.agent-search-row-title')).toHaveText('Editor fixture task');
  await expect(live.locator('.agent-search-row-project')).toHaveText('Walnut');

  const done = card.locator(`[data-task-id="${DONE_TASK_ID}"]`);
  await expect(done).toHaveClass(/is-done/);
  await expect(done.locator('.agent-search-row-title')).toHaveText('Finished marmalade task');
  await expect(done.locator('.agent-search-row-project')).toHaveText('Ideas');

  // A dead id is shown and named, never silently dropped and never clickable.
  const dead = card.locator(`[data-task-id="${DEAD_TASK_ID}"]`);
  await expect(dead).toHaveClass(/is-missing/);
  await expect(dead).toContainText('no longer exists');
  expect(await dead.evaluate((el) => el.tagName)).toBe('SPAN');

  // One list, not two: every row's title starts on the same left edge, including
  // the dead one (which has no phase circle and needs an empty slot instead).
  const titleLefts = await card.locator('.agent-search-row-title')
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  expect(titleLefts).toHaveLength(4);
  expect(new Set(titleLefts).size, `row title left edges ${titleLefts.join(',')}`).toBe(1);

  // Nothing of the answer's own JSON is on screen.
  const panelText = await panel.innerText();
  expect(panelText).not.toContain('task_id');
  expect(panelText).not.toContain('"results"');
  expect(panelText).not.toContain('confidence');
}

/** The model's mid-run narration is prose, and stays prose. */
export async function expectNarrationStillProse(panel: Locator): Promise<void> {
  const narration = panel.locator('.session-msg-assistant', { hasText: 'SEARCH_ASK_NARRATION' }).first();
  await expect(narration).toBeVisible();
  await expect(narration.locator(ANSWER_CARD)).toHaveCount(0);
}

/**
 * The answer message's OWN WORDS survive above the card.
 *
 * The live shape (user report, 2026-09-17): reasoning + a numbered list, then the
 * object, in one message. The first version refused to card anything with prose in
 * it, which left that JSON on screen — so this pins both halves at once: the words
 * render as markdown, the object renders as rows, in that order.
 */
export async function expectReasoningKeptAboveCard(panel: Locator): Promise<void> {
  const message = panel.locator('.session-msg-assistant', { hasText: 'SEARCH_ASK_REASONING' }).first();
  await expect(message).toBeVisible();
  // Markdown, not raw text: the numbered list is a real list with bold titles.
  await expect(message.locator('ol li strong').first()).toHaveText('Editor fixture task');
  // The card lives in the SAME message, below the words.
  const card = message.locator(ANSWER_CARD);
  await expect(card).toBeVisible();
  const order = await message.evaluate((el) => {
    const prose = el.querySelector('ol');
    const answer = el.querySelector('[data-testid="session-search-answer"]');
    if (!prose || !answer) return 'missing';
    return prose.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING ? 'card-after-prose' : 'card-before-prose';
  });
  expect(order).toBe('card-after-prose');
  // …and the object itself is gone from the words.
  const text = await message.innerText();
  expect(text).not.toContain('task_id');
  expect(text).not.toContain('"results"');
}

/** A row opens its task — and for a task with a session, that session's column. */
export async function expectRowOpensTask(page: Page, panel: Locator): Promise<void> {
  await panel.locator(`${ANSWER_CARD} [data-task-id="${LIVE_TASK_ID}"]`).click();
  await expect(page.locator(`${REAL_PANEL}[data-session-id="pw-vscode-session"]`)).toBeVisible({ timeout: 20_000 });
}

/**
 * The transcript never scrolls sideways because of this card. The rows' titles
 * are `nowrap`, so without `min-width:0` on the card they would set the message
 * column's min-content width — the 2026-09-03 sideways-scroll shape, in a new
 * place.
 */
export async function expectNoSidewaysScroll(panel: Locator): Promise<void> {
  const geometry = await panel.locator('.session-history').evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflowX: getComputedStyle(el).overflowX,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.overflowX).toBe('hidden');
}
