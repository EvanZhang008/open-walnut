/**
 * Words a live turn wrote show ONCE while the turn runs on, after a mid-turn
 * history read already holds them. The reported shape (2026-10-26, a lead's live
 * turn in the Mac app and Chrome): the turn wrote "Two things this round: ...",
 * then a command ran in the background; a notice delivered meanwhile refetched
 * history, which now held the words, and the streamed copy stayed under the
 * persisted one, the same paragraph twice for 20 s and more, until the turn's
 * next block. The stream's last block was guarded from matching while the turn
 * runs (render-filter.ts); it is matched now once history holds its whole text.
 *
 * History and the WS are mocked (mock-session-harness.ts); the history array is
 * live, so a refetch mid-turn sees the persisted words.
 */
import { test, expect } from '@playwright/test';
import { MOCK_SESSION_ID as SESSION_ID, injectEvent, mockSession, open, waitForWs } from './mock-session-harness';

const SHOTS = '/tmp/live-words-once';
if (process.env.LIVE_WORDS_VIDEO) test.use({ video: { mode: 'on', size: { width: 1280, height: 900 } } });

const WORDS = 'LW_WORDS Two things this round: the deploy is live, and the inbox task is back to waiting.';
const MORE = ' LW_MORE One more line.';

test('words history already holds show once while the turn runs on', async ({ page }) => {
  const history: Array<Record<string, unknown>> = [{ role: 'user', text: 'LW_ASK how is it going', timestamp: '2026-01-01T00:00:00.000Z' }];
  await mockSession(page, history, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('LW_ASK', { timeout: 15000 });

  await injectEvent(page, 'session:thinking-delta', { sessionId: SESSION_ID, delta: 'LW_REASONING weighing it.', msgId: 'lw_msg' });
  await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: WORDS, msgId: 'lw_msg' });
  await expect(hist.getByText(WORDS)).toHaveCount(1);
  await expect(hist.locator('.session-working-indicator')).toBeVisible();

  // A notice lands mid-turn; its delivery refetches history, which now holds the words.
  history.push({ role: 'assistant', text: WORDS, thinking: 'LW_REASONING weighing it.', msgId: 'lw_msg', timestamp: '2026-01-01T00:00:05.000Z' });
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  // The persisted copy is the one on screen.
  await expect(hist.locator('[data-message-id="lw_msg"]', { hasText: 'LW_WORDS' })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-words-once.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  // ...and it stays once for as long as the turn runs on with nothing new.
  for (let k = 0; k < 6; k++) {
    await expect(hist.getByText(WORDS, { exact: false })).toHaveCount(1);
    await page.waitForTimeout(500);
  }
  await expect(hist.locator('.session-working-indicator')).toBeVisible();

  // More words under the same message: nothing is lost, the new line shows.
  await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: MORE, msgId: 'lw_msg' });
  await expect(hist.getByText('LW_MORE One more line.', { exact: false })).toBeVisible();
  await page.waitForTimeout(600);
});
