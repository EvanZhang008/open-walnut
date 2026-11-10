/**
 * A live turn's message cards are folded into the turn from the first frame they
 * appear, the way the saved turn shows them: "Sent 2 ›" above the answer, never the
 * cards themselves.
 *
 * 2026-11-10, the user, of a lead's live turn whose two op cards ("To <task>",
 * "To Thread") sat open under "Thinking ›" and folded into "Sent 2 ›" about 10 s
 * later, when the turn ended: "why it has to wait for like 10s to collapse?", and
 * "p1 is t0, p2 is t10": the first frame must already look like the second. A send
 * was never a run member (tool-merge.ts), so the live step groups took it as a row
 * a person reads and drew it open; it is a step of the turn now ('send' in
 * stream-step-groups.ts), as history counts it.
 *
 * A MutationObserver records every frame in which any message card (an op card or
 * a received card) is drawn outside an opened fold, from before the first block.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit';
import { MOCK_SESSION_ID as SESSION_ID, injectEvent, mockSession, open, takeLine, waitForWs } from './mock-session-harness';

const SHOTS = `${process.env.WALNUT_TASK_DIR || '/tmp'}/shots/live-send-fold`;
if (process.env.LIVE_SEND_VIDEO) test.use({ video: { mode: 'on', size: { width: 1280, height: 900 } } });

const kit = createEnvelopeKit();
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

/** Watch for a card drawn where the reader did not open anything. */
async function watchCards(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __openCards: string[] };
    w.__openCards = [];
    const check = () => {
      for (const el of document.querySelectorAll('.session-history .provenance-card, .session-history .op-card')) {
        if (el.closest('.process-fold-body')) continue;
        w.__openCards.push(`${(el.textContent ?? '').slice(0, 80)} @${Math.round(performance.now())}`);
      }
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
}
const openCards = (page: Page) => page.evaluate(() => (window as unknown as { __openCards: string[] }).__openCards);

/** Row labels below the person's message, outside any fold body. */
async function labelsAfter(hist: Locator, needle: string): Promise<string[]> {
  return hist.evaluate((el, needle) => {
    const ask = [...el.querySelectorAll('.session-msg')].reverse().find((n) => n.textContent?.includes(needle));
    return [...el.querySelectorAll('.tool-run-label, .provenance-card, .op-card')]
      .filter((n) => !ask || (ask.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING))
      .filter((n) => !n.closest('.process-fold-body'))
      .map((n) => n.textContent?.trim() ?? '');
  }, needle);
}

const SEND = `walnut tools call task_send '${JSON.stringify({ to: 'pw-task-001', title: 'LS_SEND_TITLE ten designs for the fold', text: 'LS_SEND_BODY Evan wants ten designs. Make each one match the tool rows.' })}'`;
const THREAD = { id: 'th-ls-1', reply: 'LS_THREAD_REPLY handed to the card task; ten designs coming.' };

test('a live turn\'s sends and cards fold into the turn from the first frame, and stay folded', async ({ page }) => {
  await mockSession(page, [{ role: 'user', text: 'LS_ASK I do not like the big box', timestamp: at(0) }], 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('LS_ASK', { timeout: 15000 });
  await watchCards(page);

  // The reported turn: reasoning, a send still running, its answer, a thread update, then the words.
  await injectEvent(page, 'session:thinking-delta', { sessionId: SESSION_ID, delta: 'LS_REASONING pass it to the card task.', msgId: 'ls_think' });
  await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'ls-send', input: { command: SEND } });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/t0-send-running.png` });
  await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'ls-send', result: JSON.stringify({ delivery: 'queued', targetTaskId: 'pw-task-001', requestId: 'rq-0a1b2c3d4e5f' }) });
  await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'mcp__walnut__thread_update', toolUseId: 'ls-thread', input: THREAD });
  await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'ls-thread', result: '{"ok":true}' });
  // A notice arrives mid-turn, taken at the next tool boundary.
  await injectEvent(page, 'session:message-queued', {
    sessionId: SESSION_ID, messageId: 'qm-ls-1', sentBy: 'agent', source: 'walnut-notify', enqueuedAt: new Date().toISOString(),
    message: kit.buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', 'about-task': 'abcd1234', outcome: 'stopped' }, body: 'LS_NOTICE Its turn ended.' }),
  });
  await takeLine(page, 'qm-ls-1');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/t0-sent.png` });

  // One row, its line counting both sends and the notice.
  await expect.poll(() => labelsAfter(hist, 'LS_ASK')).toEqual([expect.stringMatching(/^(?=.*Received 1 message)(?=.*Sent 2)/)]);

  // The answer: the turn's words stay open below the fold.
  await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'LS_ANSWER got it, ten designs coming.', msgId: 'ls_answer' });
  await expect(hist.getByText('LS_ANSWER got it, ten designs coming.')).toBeVisible();
  // Ten seconds on, it reads the same: nothing opened or moved.
  const box = await hist.locator('[data-testid="step-group-fold"], [data-testid="turn-fold"]').last().boundingBox();
  await page.waitForTimeout(10_000);
  await page.screenshot({ path: `${SHOTS}/t10.png` });
  expect(await labelsAfter(hist, 'LS_ASK')).toEqual([expect.stringMatching(/Sent 2/)]);
  expect(await hist.locator('[data-testid="step-group-fold"], [data-testid="turn-fold"]').last().boundingBox()).toEqual(box);

  expect(await openCards(page), 'no message card was ever drawn outside a fold').toEqual([]);

  // Opened, the fold holds both op cards and the notice, each folded.
  const fold = hist.locator('[data-testid="step-group-fold"], [data-testid="turn-fold"]').last();
  await fold.locator(':scope > .tool-run-toggle').click();
  const body = fold.locator('.process-fold-body');
  await expect(body.locator('.op-card')).toHaveCount(2);
  await expect(body.locator('.provenance-card[data-envelope-kind="notification"]')).toHaveCount(1);
  await expect(body.locator('.provenance-card[data-folded="false"]')).toHaveCount(0);
  await expect(body).toContainText('LS_SEND_TITLE');
  await page.screenshot({ path: `${SHOTS}/opened.png` });
});
