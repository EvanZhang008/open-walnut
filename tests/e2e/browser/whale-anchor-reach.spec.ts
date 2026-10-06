/**
 * A heavy turn on a transcript past the full read's byte ceiling keeps the chat whole.
 *
 * Reported 2026-10-05 (a 352 MB session full of screenshots): after a turn, every AI
 * reply vanished and the user's own messages piled up at the bottom, until a reload.
 * One turn appended more than the 4 MB tail the server serves such a file from, so
 * the turn-end delta's anchor was gone from the tail; the server declined the delta
 * and the panel swapped its history for a window of a few rows. The delta now reaches
 * back for its anchor. Pinned through the real panel: after a 6 MB turn the earlier
 * replies are still on screen, the new turn sits after them in order, the user's
 * message shows once, and it arrived by delta (no full rebuild).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { WHALE_ANCHOR_SESSION, WHALE_ANCHOR_TASK } from './whale-history-fixture';

test.use({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

async function openWhale(page: Page, baseURL: string): Promise<Locator> {
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await page.locator('.todo-search-input').fill(WHALE_ANCHOR_SESSION);
  const task = page.locator(`.todo-panel-item[data-task-id="${WHALE_ANCHOR_TASK}"]`);
  await expect(task).toBeVisible();
  await task.locator('.todo-item-title').click();
  const panel = page.locator(`.main-page-session-column [data-session-id="${WHALE_ANCHOR_SESSION}"]`);
  await expect(panel).toBeVisible();
  // The chromium and webkit projects share this fixture session (a copy of its own, so
  // whale-history.spec.ts keeps a pristine tail), so the tail is the fixture's last turn
  // or the other engine's heavy turn, whichever ran first.
  await expect(panel.locator('.session-msg-assistant').first()).toBeVisible({ timeout: 60_000 });
  return panel;
}

/** Visible text of the timeline, in DOM order. */
const timelineText = (panel: Locator) => panel.locator('.session-history').evaluate((el) => (el as HTMLElement).innerText);
/** Each AI reply's text, in DOM order. */
// The message body only.
const replies = (panel: Locator) => panel.locator('.session-msg-assistant .session-msg-content').evaluateAll((els) =>
  els.map((el) => (el as HTMLElement).innerText.split('\n').map((l) => l.trim())
    // The row's action strip (copy as MD / Rich, relative time) comes and goes.
    .filter((l) => l && !/^(MD|Rich|just now|\d+[smhd] ago)$/.test(l)).join(' ')).filter(Boolean));

test('a turn bigger than the tail window keeps the earlier replies and arrives by delta', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const panel = await openWhale(page, baseURL!);
  const earlier = await replies(panel);
  expect(earlier.length, 'earlier replies are on screen').toBeGreaterThan(0);

  // Only what the send causes: the panel's own first load can still be landing here.
  let sent = false;
  const responses: Array<{ url: string; delta?: boolean; n: number }> = [];
  const afterSend = new WeakSet<object>();
  page.on('request', (r) => { if (sent) afterSend.add(r); });
  page.on('response', async (r) => {
    if (!afterSend.has(r.request())) return;
    if (!r.url().includes(`/api/sessions/${WHALE_ANCHOR_SESSION}/history`) || r.request().method() !== 'GET') return;
    const body = await r.json().catch(() => null) as { delta?: boolean; messages?: unknown[] } | null;
    responses.push({ url: r.url(), delta: body?.delta, n: body?.messages?.length ?? -1 });
  });

  // Five 1.2 MB tool results: more than the 4 MB tail, less than the 8 MB ceiling.
  const prompt = `heavy screenshots ${Date.now()} MOCK_HEAVY_RESULTS:5x1200`;
  const box = panel.locator('.chat-input-textarea').first();
  await box.click();
  await box.fill(prompt);
  sent = true;
  await box.press('Enter');
  await expect(panel.locator('.session-history')).toContainText('processed your message', { timeout: 60_000 });
  await expect.poll(() => responses.some((r) => r.url.includes('since=')), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(1500);

  const deltas = responses.filter((r) => r.url.includes('since='));
  expect(deltas.at(-1)?.delta, 'the turn-end fetch was served as a delta').toBe(true);
  expect(responses.filter((r) => !r.url.includes('since=')), 'no full rebuild followed').toEqual([]);

  // The earlier replies are still there, in order, ahead of the new turn.
  const still = await replies(panel);
  expect(still.slice(0, earlier.length)).toEqual(earlier);
  expect(still.length, 'and the new reply follows them').toBeGreaterThan(earlier.length);
  const after = await timelineText(panel);
  const lastEarlier = after.lastIndexOf(earlier[earlier.length - 1]);
  const userAt = after.indexOf(prompt.split(' MOCK_')[0]);
  expect(userAt, 'the user message follows the earlier replies').toBeGreaterThan(lastEarlier);
  await expect(panel.locator('.session-msg-user', { hasText: prompt }), 'the user message shows once').toHaveCount(1);
  expect(errors).toEqual([]);
});
