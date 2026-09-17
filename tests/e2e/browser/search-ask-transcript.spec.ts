/**
 * The adopted ✦ AI search reads as a conversation, not as JSON.
 *
 * The defect (2026-09-16, user report with a screenshot): "Open as session" now
 * hands over the session the search really ran in — and that session's first turn
 * is the prompt WALNUT wrote (question + a ~2.5KB seed-row dump) while its answer
 * is a bare `{"results":[{"task_id":…}]}`. Both rendered as raw text, so the
 * conversation the user opened to ask a follow-up in opened as machine noise.
 *
 * The fix renders Walnut's OWN two messages: the prompt folds into the panel's
 * existing "machine text Walnut added" disclosure (leaving the query as the
 * bubble), and the answer renders through the SAME rows the ✦ card uses, titled
 * from the live task table. The transcript itself is never rewritten.
 *
 * Follow-up (2026-09-17, "what isnt it the same"): a live answer usually writes
 * its reasoning and a numbered list BEFORE the object, and the first version
 * refused to card anything with prose in it — so the fixture's answer now has
 * that exact shape, and the renderer keeps the words while carding the object.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  ANSWER_CARD, DEAD_TASK_ID, SCREENSHOT_DIR,
  expectAnswerCarded, expectNarrationStillProse, expectNoSidewaysScroll,
  expectPromptFolded, expectReasoningKeptAboveCard, expectRowOpensTask,
  expectSeedDisclosed, openSearchAsk,
} from './search-ask-transcript-helpers';

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test('the question is the bubble, the seeded prompt is one folded row', async ({ page }) => {
  const panel = await openSearchAsk(page);
  await expectPromptFolded(panel);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/1-carded.png` });
});

test('the whole prompt is still one click away, verbatim', async ({ page }) => {
  const panel = await openSearchAsk(page);
  await expectSeedDisclosed(panel);
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/2-prompt-disclosed.png` });
});

test('the answer renders as task rows with live titles, and a dead id says so', async ({ page }) => {
  const panel = await openSearchAsk(page);
  await expectAnswerCarded(panel);
});

test('the model’s narration between searches still renders as prose', async ({ page }) => {
  const panel = await openSearchAsk(page);
  await expectNarrationStillProse(panel);
});

test('the answer’s own reasoning stays above the card (the live shape)', async ({ page }) => {
  const panel = await openSearchAsk(page);
  await expectReasoningKeptAboveCard(panel);
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/6-reasoning-plus-card.png` });
});

test('clicking a row opens that task', async ({ page }) => {
  const panel = await openSearchAsk(page);
  await expectRowOpensTask(page, panel);
});

test('the card does not make the transcript scroll sideways', async ({ page }) => {
  const panel = await openSearchAsk(page);
  await expectNoSidewaysScroll(panel);
});

test('at a narrow window the rows ellipsize instead of overflowing', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  const panel = await openSearchAsk(page);
  await expectNoSidewaysScroll(panel);
  const row = panel.locator(`${ANSWER_CARD} .agent-search-row-title`).first();
  const fits = await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).textOverflow === 'ellipsis');
  expect(fits).toBe(true);
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/3-narrow.png` });
});

test('a reload renders the same cards (the parse is of server history, not of a cache)', async ({ page }) => {
  const panel = await openSearchAsk(page);
  await expectAnswerCarded(panel);
  await page.reload();
  await page.waitForLoadState('networkidle');
  const again = page.locator(`.main-page-session-column .session-panel[data-session-id="pw-search-ask-session"]`);
  await expect(again.locator(ANSWER_CARD)).toBeVisible({ timeout: 30_000 });
  await expectPromptFolded(again);
  await expectAnswerCarded(again);
});

test('the dead row is inert: clicking it opens nothing', async ({ page }) => {
  const panel = await openSearchAsk(page);
  const before = await page.locator('.main-page-session-column .session-panel').count();
  await panel.locator(`${ANSWER_CARD} [data-task-id="${DEAD_TASK_ID}"]`).click();
  await page.waitForTimeout(500);
  expect(await page.locator('.main-page-session-column .session-panel').count()).toBe(before);
});
