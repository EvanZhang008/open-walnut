/**
 * Quiet steps between two answers are ONE row, and the row says what they were,
 * in order. The reported shapes (2026-10-27): after an answer, a lead's note the
 * session acknowledged, a notice it answered with a send and the line, and a reply
 * it answered drew as "Show 2 hidden turns" and "Received a message ›" one above
 * the other; elsewhere "Received a message ›", "Thinking ›", an empty footer, a
 * second "Received a message ›" and "Acknowledged" were five rows. The user: "if
 * it is collapsed near collapsed, need to combine", and of "4 hidden turns": "just
 * show run xxx command, receive xxx, and then ack xx".
 *
 * Conversation Mode (a session with questions, the default view) folds the same
 * way; a question's own turns keep their label line.
 *
 * History and the WS are mocked (mock-session-harness.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { MOCK_SESSION_ID, mockSession, open } from './mock-session-harness';

const SHOTS = '/tmp/quiet-fold-merge';
test.setTimeout(90_000);
if (process.env.QUIET_FOLD_VIDEO) test.use({ video: { mode: 'on', size: { width: 1280, height: 900 } } });

const ACK = '<walnut-turn status="agent-ack"/>';
const at = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
const LEAD = 'from="Team lead [1a2b3c4d]" from-session="1a2b3c4d-0000-4000-8000-000000000001" from-task="t-lead"';

function rows(): Array<Record<string, unknown>> {
  return [
    { role: 'user', text: 'QF_ASK what changed today?', timestamp: at(1), msgId: 'qf-u1' },
    { role: 'assistant', text: 'QF_ANSWER_ONE the build is green and the deploy is live.', timestamp: at(2), msgId: 'qf-a1' },
    { role: 'user', text: `<walnut-message kind="peer-note" ${LEAD} title="Migration is top priority">\nQF_NOTE_BODY hold heavy jobs until it ships.\n</walnut-message>`, timestamp: at(3), msgId: 'qf-u2' },
    { role: 'assistant', text: ACK, thinking: 'QF_THINK_ONE nothing to do here.', timestamp: at(4), msgId: 'qf-a2' },
    { role: 'user', text: '<walnut-message kind="notification" from="Walnut" about="Team lead [1a2b3c4d]" about-session="1a2b3c4d-0000-4000-8000-000000000001" outcome="completed">\nIts turn ended without a reply.\n</walnut-message>', timestamp: at(5), msgId: 'qf-u3' },
    { role: 'assistant', text: '', tools: [{ name: 'mcp__walnut__task_send', input: { task_id: 't-lead', title: 'QF_SENT_TITLE', text: 'Noted.' }, result: 'sent' }], timestamp: at(6), msgId: 'qf-a3' },
    { role: 'assistant', text: ACK, timestamp: at(7), msgId: 'qf-a4' },
    { role: 'user', text: '<walnut-message kind="reply" from="Login script [7c7c7c7c]" from-session="7c7c7c7c-0000-4000-8000-000000000002" from-task="pw-task-001" title="Fixed and verified">\nQF_REPLY_BODY the key works.\n</walnut-message>', timestamp: at(8), msgId: 'qf-u4' },
    { role: 'assistant', text: 'QF_ANSWER_TWO the login works now.', thinking: 'QF_THINK_TWO checking the reply.', timestamp: at(9), msgId: 'qf-a5' },
  ];
}

// The reply names its sender as its card does: by the sending task's title
// (pw-task-001), not the session title the envelope printed.
const LINE = /^From Team lead: Migration is top priority, acknowledged, notice about Team lead: Its turn ended without a reply, sent a message, acknowledged, reply from Playwright test task: Fixed and verified, thought$/;

/** The timeline's own rows (not the rows inside an opened fold), as kind + text. */
async function topRows(page: Page) {
  return page.locator(`.session-panel[data-session-id="${MOCK_SESSION_ID}"] .session-history`).evaluate((el) => {
    const sel = '[data-msg-index],[data-turn-fold-index]';
    return [...el.querySelectorAll(sel)].filter((x) => !x.parentElement!.closest(sel))
      .map((x) => ({ fold: x.hasAttribute('data-turn-fold-index'), text: (x.textContent ?? '').replace(/\s+/g, ' ').trim() }));
  });
}

async function checkMerged(page: Page, tag: string) {
  const hist = page.locator(`.session-panel[data-session-id="${MOCK_SESSION_ID}"] .session-history`);
  await expect(hist).toContainText('QF_ANSWER_TWO', { timeout: 20_000 });
  // Between the two answers: one row, and it is a fold (polled: a history refetch
  // right after the first paint remounts the rows).
  const between = async () => {
    const top = await topRows(page);
    const one = top.findIndex((r) => r.text.includes('QF_ANSWER_ONE'));
    const two = top.findIndex((r) => r.text.includes('QF_ANSWER_TWO'));
    return one < 0 || two < 0 ? top : top.slice(one + 1, two).map((r) => r.fold);
  };
  await expect.poll(between, { timeout: 10_000 }).toEqual([true]);
  const fold = hist.locator('[data-testid="turn-fold"]').filter({ hasText: 'Migration is top priority' });
  await expect(fold).toHaveCount(1);
  await expect(fold.locator(':scope > .tool-run-toggle .tool-run-label')).toHaveText(LINE);
  // A count of turns is never the line, open or closed.
  await expect(hist).not.toContainText(/hidden turn/);
  // The answer's reasoning went into the row: no "Thinking ›" of its own above it.
  const answerRow = hist.locator('[data-message-id="qf-a5"]');
  await expect(answerRow.locator('.tool-run-label', { hasText: 'Thinking' })).toHaveCount(0);
  // One line, ellipsized when narrow, never a wrapped block.
  const box = await fold.locator(':scope > .tool-run-toggle').boundingBox();
  expect(box!.height).toBeLessThan(30);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${tag}-closed.png`, clip: (await hist.boundingBox())! }).catch(() => {});

  // Opened: every step is there, in order, and the acknowledgements read "Acknowledged".
  await fold.locator(':scope > .tool-run-toggle').click();
  const body = fold.locator('.process-fold-body');
  await expect(body).toContainText('Migration is top priority');
  await expect(body).toContainText('Fixed and verified');
  await expect(body.locator('.provenance-card', { hasText: 'Fixed and verified' })).toContainText('Playwright test task');
  // Both no-action turns read "Acknowledged"; the one with reasoning draws no empty footer.
  await expect(body.locator('[data-testid="no-action-mark"]')).toHaveCount(2);
  await expect(body.locator('[data-message-id="qf-a2"] .session-msg')).toHaveCount(0);
  // The answer's reasoning is the last step inside, its own folded row.
  await expect(body.locator('.tool-run-label', { hasText: 'Thinking' }).last()).toBeVisible();
  await expect(fold.locator(':scope > .tool-run-toggle .tool-run-label')).toHaveText(LINE);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${tag}-open.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  await page.waitForTimeout(600);
}

test('quiet turns between two answers are one row that says what happened, in order', async ({ page }) => {
  await mockSession(page, rows(), 'idle');
  await open(page);
  await checkMerged(page, 'linear');
});

test('Conversation Mode folds them the same way; the question keeps its own line', async ({ page }) => {
  const history = [
    ...rows(),
    { role: 'user', text: '> the login works now\n\nQF_QUESTION which key did it use?', timestamp: at(10), msgId: 'qf-q1' },
    { role: 'assistant', text: 'QF_QUESTION_ANSWER the hardware key.', timestamp: at(11), msgId: 'qf-qa1' },
  ];
  await mockSession(page, history, 'idle');
  // The session has a question: Conversation Mode, the default view.
  await page.route(`**/api/sessions/${MOCK_SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history') || request.method() !== 'GET') return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: MOCK_SESSION_ID, taskId: 'pw-task-mock-session', project: 'Walnut', process_status: 'idle',
          mode: 'bypass', startedAt: at(0), lastActiveAt: new Date().toISOString(), messageCount: history.length, title: 'Mock session',
          threadAnchors: [{ msgId: 'qf-q1', parent: 'qf-a5', quote: { exact: 'the login works now' }, source: 'selection', at: at(10) }],
          threadMeta: [{ headId: 'qf-q1', status: 'open', title: 'QF_QUESTION_TITLE', titleSource: 'ai', titleState: 'done', updatedAt: at(12) }],
        },
      },
    });
  });
  await open(page);
  const hist = page.locator(`.session-panel[data-session-id="${MOCK_SESSION_ID}"] .session-history`);
  await expect(hist.locator('[data-thread-fold]', { hasText: 'QF_QUESTION_TITLE' })).toHaveCount(1, { timeout: 20_000 });
  await checkMerged(page, 'conversation');
});
