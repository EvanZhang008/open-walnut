/**
 * A live turn's steps and the cards it received while working are ONE row when no
 * word a person reads sits between them. The reported shape (2026-10-26, Main's chat,
 * the user: "still why this is not merged"): "Received a message › / Thinking › /
 * Received a message › / Ran 31 commands › / Received a message › / Ran a command ›"
 * under "Claude Code is working…". Now it is one row while the turn runs, its line
 * saying what happened in order ("A notice: …, thought, a notice: …, ran 3 commands,
 * …", fold-steps.ts), and opening it shows every step and card in order. Words, or a
 * person's message, still split it.
 *
 * History and the WS are mocked (mock-session-harness.ts); stream and queue events
 * are pushed one by one while the turn really runs.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit';
import { MOCK_SESSION_ID as SESSION_ID, injectEvent, mockSession, open, streamTools, waitForWs } from './mock-session-harness';

const SHOTS = '/tmp/step-group-fold';
if (process.env.STEP_GROUP_VIDEO) test.use({ video: { mode: 'on', size: { width: 1280, height: 900 } } });

const kit = createEnvelopeKit();
const notice = (n: number) => kit.buildWalnutMessage({
  kind: 'notification',
  attrs: { from: 'Walnut', 'about-task': 'abcd1234', outcome: 'stopped' },
  body: `SG_NOTICE_${n} Its turn ended.`,
});
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

async function card(page: Page, id: string, n: number) {
  await injectEvent(page, 'session:message-queued', {
    sessionId: SESSION_ID, messageId: id, message: notice(n), source: 'walnut-notify', sentBy: 'agent', enqueuedAt: new Date().toISOString(),
  });
}
/** A card, then wait until the panel shows it: a row is placed where the stream
 *  stood when it arrived, so the next event must not race it. */
async function cardShown(page: Page, hist: Locator, id: string, n: number, total: number) {
  await card(page, id, n);
  void total;
  await expect.poll(() => hist.locator('.tool-run-label').allTextContents(), { timeout: 10000 })
    .toContainEqual(expect.stringContaining(`SG_NOTICE_${n}`));
}
async function think(page: Page, msgId: string, text: string) {
  await injectEvent(page, 'session:thinking-delta', { sessionId: SESSION_ID, delta: text, msgId });
}

/** Every row label in the stream panel and below the person's last message. */
async function labelsAfter(hist: Locator, needle: string): Promise<string[]> {
  return hist.evaluate((el, needle) => {
    const ask = [...el.querySelectorAll('.session-msg')].reverse().find((n) => n.textContent?.includes(needle));
    return [...el.querySelectorAll('.tool-run-label, .provenance-card, .chat-thinking-toggle')]
      .filter((n) => !ask || (ask.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING))
      .filter((n) => !n.closest('.process-fold-body'))
      .map((n) => n.textContent?.trim() ?? '');
  }, needle);
}

test('cards, reasoning and commands in one stretch are one row while the turn runs', async ({ page }) => {
  await mockSession(page, [{ role: 'user', text: 'SG_ASK check the team', timestamp: at(0) }], 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('SG_ASK', { timeout: 15000 });

  // The reported order: card, thinking, card, a burst of commands, card, one command.
  await cardShown(page, hist, 'qm-sg-1', 1, 1);
  await think(page, 'sg_think_1', 'SG_REASONING the first notice means the build is green.');
  await cardShown(page, hist, 'qm-sg-2', 2, 2);
  await streamTools(page, [['sg-1', 'make lint'], ['sg-2', 'make test'], ['sg-3', 'make build']]);
  await cardShown(page, hist, 'qm-sg-3', 3, 3);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-arriving.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  await streamTools(page, [['sg-4', 'git push']]);

  const NOTE = (n: number) => `a notice: SG_NOTICE_${n} Its turn ended`;
  await expect.poll(() => labelsAfter(hist, 'SG_ASK')).toEqual([
    `A notice: SG_NOTICE_1 Its turn ended, thought, ${NOTE(2)}, ran 3 commands, ${NOTE(3)}, ran git push`,
  ]);
  await expect(hist.locator('.provenance-card')).toHaveCount(0);
  await expect(hist.locator('.session-working-indicator')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-one-row.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  await page.waitForTimeout(600);

  // Opened: every card and step, in arrival order.
  const fold = hist.locator('[data-testid="step-group-fold"]');
  await fold.locator(':scope > .tool-run-toggle').click();
  const body = fold.locator('.process-fold-body');
  await expect(body.locator('.provenance-card')).toHaveCount(3);
  await expect(body).toContainText('Thinking');
  await expect(body).toContainText('make test');
  await expect(body).toContainText('git push');
  const order = await body.evaluate((el) => {
    const text = el.textContent ?? '';
    // (Streamed reasoning lands when the next block starts, so a card that came
    // while it was still arriving sits before it: the timeline's own rule.)
    return ['SG_NOTICE_1', 'make lint', 'SG_NOTICE_3', 'git push'].map((n) => text.indexOf(n));
  });
  expect(order.every((v, k) => v >= 0 && (k === 0 || v > order[k - 1]))).toBe(true);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-opened.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  await page.waitForTimeout(600);

  // More arrives while it is open: it joins the same row, which stays open.
  await cardShown(page, hist, 'qm-sg-4', 4, 4);
  await expect(fold.locator(':scope > .tool-run-toggle')).toHaveText(new RegExp(`ran git push, ${NOTE(4)}`));
  await expect(fold).toHaveAttribute('data-open', 'true');
  await page.waitForTimeout(600);
});

test('words or a person\'s message split the stretch, and stay on screen', async ({ page }) => {
  await mockSession(page, [{ role: 'user', text: 'SG_ASK2 go', timestamp: at(0) }], 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('SG_ASK2', { timeout: 15000 });

  await card(page, 'qm-sw-1', 1);
  await page.waitForTimeout(400);
  await streamTools(page, [['sw-1', 'make check']]);
  await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'SG_WORDS the checks pass, now the deploy.', msgId: 'sg_words' });
  // The next call ends the words (streamed text lands when the next block starts).
  await streamTools(page, [['sw-2', 'make deploy']]);
  await card(page, 'qm-sw-2', 2);
  await page.waitForTimeout(400);
  await injectEvent(page, 'session:message-queued', {
    sessionId: SESSION_ID, messageId: 'qm-sw-p', message: 'SG_PERSON also check the logs', source: 'mobile', sentBy: 'person', enqueuedAt: new Date().toISOString(),
  });
  await card(page, 'qm-sw-3', 3);
  await page.waitForTimeout(400);
  await streamTools(page, [['sw-3', 'tail log']]);

  await expect(hist.getByText('SG_WORDS the checks pass, now the deploy.')).toBeVisible();
  await expect(hist.locator('.session-msg', { hasText: 'SG_PERSON' })).toBeVisible();
  await expect.poll(() => labelsAfter(hist, 'SG_ASK2')).toEqual([
    'A notice: SG_NOTICE_1 Its turn ended, ran make check',
    'Ran make deploy, a notice: SG_NOTICE_2 Its turn ended',
    'A notice: SG_NOTICE_3 Its turn ended, ran tail log',
  ]);
});

test('a turn a notice started: the notice in history and the live steps are one row', async ({ page }) => {
  const history = [
    { role: 'user', text: 'SG_ASK3 earlier question', timestamp: at(0) },
    { role: 'assistant', text: 'SG_ANSWER3 done.', timestamp: at(1) },
    { role: 'user', text: notice(7), timestamp: at(2) },
  ];
  await mockSession(page, history, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('SG_ANSWER3', { timeout: 15000 });

  await think(page, 'sg_think_3', 'SG_REASONING3 reading the notice.');
  await card(page, 'qm-st-1', 8);
  await page.waitForTimeout(400);
  await streamTools(page, [['st-1', 'make check']]);

  await expect.poll(() => labelsAfter(hist, 'SG_ANSWER3')).toEqual([
    'A notice: SG_NOTICE_7 Its turn ended, thought, a notice: SG_NOTICE_8 Its turn ended, ran make check',
  ]);
  const fold = hist.locator('[data-testid="turn-fold"]').last();
  await fold.locator(':scope > .tool-run-toggle').click();
  await expect(fold.locator('.provenance-card')).toHaveCount(2);
  await expect(fold).toContainText('make check');
  await expect(fold).toContainText('Thinking');
});
