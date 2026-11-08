/**
 * A card an agent sends into a running session (Walnut's notice, another task's
 * note) is folded the moment it arrives. It used to show in full, as a queued
 * row, for the seconds until the session answered and history folded it
 * (2026-10-26, the user: "why it still show for few second, I think directly
 * collapse"). Who sent it comes from the queue's `sentBy` (the send's source);
 * a person's message always shows, and a row with no `sentBy` (an older server)
 * renders as before.
 */
import { test, expect, type Page } from '@playwright/test';
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit';
import { MOCK_SESSION_ID as SESSION_ID, injectEvent, mockSession, streamTools, waitForWs } from './mock-session-harness';

const SHOTS = '/tmp/queued-card-fold';
if (process.env.QUEUED_FOLD_VIDEO) test.use({ video: 'on' });

const kit = createEnvelopeKit();
const notice = (n: number) => kit.buildWalnutMessage({
  kind: 'notification',
  attrs: { from: 'Walnut', 'about-task': 'abcd1234', outcome: 'waiting' },
  body: `QF_NOTICE_${n} It set its task to WAITING without an explicit reply to your request.`,
});
const base = [
  { role: 'user', text: 'QF_ASK check the team', timestamp: '2026-01-01T00:00:00.000Z' },
];

async function queued(page: Page, id: string, message: string, sentBy?: 'person' | 'agent') {
  await injectEvent(page, 'session:message-queued', {
    sessionId: SESSION_ID, messageId: id, message, source: sentBy === 'person' ? 'mobile' : 'walnut-notify',
    enqueuedAt: new Date().toISOString(), ...(sentBy ? { sentBy } : {}),
  });
}

/** Record whether a received card is ever drawn outside a closed fold. */
async function watchForOpenCards(page: Page) {
  await page.evaluate(() => {
    (window as any).__openCardSeen = false;
    const check = () => {
      for (const n of document.querySelectorAll('.session-history .provenance-card')) {
        if (!n.closest('.process-fold[data-open="true"]')) (window as any).__openCardSeen = true;
      }
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true });
  });
}

// The running turn's steps are its one fold ("Working · ..."), and a card that comes
// in joins it (every step before the answer is one fold, 2026-11-12).
const WORKING = '(?:Working \u00b7 )?';

test('an agent\'s card folds on arrival, mid-turn, and neighbours share the row', async ({ page, baseURL }) => {
  await mockSession(page, base, 'running');
  const hist = await openCancelledComposer(page, baseURL!);
  await expect(hist).toContainText('QF_ASK', { timeout: 30000 });
  await waitForWs(page);
  await streamTools(page, [['qf-1', 'make check'], ['qf-2', 'make test']]);
  await watchForOpenCards(page);

  await queued(page, 'qm-qf-1', notice(1), 'agent');
  const fold = hist.locator('[data-testid="turn-fold"]');
  await expect(fold).toHaveCount(1);
  await expect(fold.locator(':scope > .tool-run-toggle')).toHaveText(new RegExp(`^${WORKING}Received 1 message(?: from [^·›]+?)? \u00b7 Ran 2 tools`));
  await expect(fold).toHaveAttribute('data-open', 'false');
  await expect(hist.locator('.provenance-card')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-arrived.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  await page.waitForTimeout(600);

  // A second one right after joins the same row.
  await queued(page, 'qm-qf-2', notice(2), 'agent');
  await expect(fold).toHaveCount(1);
  await expect(fold.locator(':scope > .tool-run-toggle')).toHaveText(new RegExp(`^${WORKING}Received 2 messages(?: from [^·›]+?)? \u00b7 Ran 2 tools›?$`));
  expect(await page.evaluate(() => (window as any).__openCardSeen)).toBe(false);

  // Opened: both cards, as they were.
  await fold.locator(':scope > .tool-run-toggle').click();
  await expect(fold.locator('.provenance-card')).toHaveCount(2);
  await expect(fold).toContainText('QF_NOTICE_1');
  await expect(fold).toContainText('QF_NOTICE_2');
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-opened.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  await page.waitForTimeout(600);
});

test('a person\'s message never folds, and splits two agent cards', async ({ page, baseURL }) => {
  await mockSession(page, base, 'running');
  const hist = await openCancelledComposer(page, baseURL!);
  await expect(hist).toContainText('QF_ASK', { timeout: 30000 });
  await waitForWs(page);
  await streamTools(page, [['qp-1', 'make check']]);

  await queued(page, 'qm-qp-1', notice(1), 'agent');
  await queued(page, 'qm-qp-2', 'QF_PHONE_WORDS please also look at the logs', 'person');
  await queued(page, 'qm-qp-3', notice(3), 'agent');
  await expect(hist.locator('.session-msg', { hasText: 'QF_PHONE_WORDS' })).toBeVisible();
  // Before the person's message: the command and the card, one row; after it, the card alone.
  await expect(hist.locator('[data-testid="turn-fold"] > .tool-run-toggle')).toHaveText([new RegExp(`^${WORKING}Received 1 message(?: from [^·›]+?)? \u00b7 Ran 1 tool`)]);
  const folds = hist.locator('[data-testid="received-fold"]');
  await expect(folds).toHaveCount(1);
  await expect(folds.locator(':scope > .tool-run-toggle')).toHaveText(/^Received 1 message(?: from [^·›]+?)?›?$/);
  // Opened, it is the third notice.
  await folds.locator(':scope > .tool-run-toggle').click();
  await expect(folds).toContainText('QF_NOTICE_3');
  // An envelope a person's source sent (a letter they answered) shows too.
  await queued(page, 'qm-qp-4', notice(4), 'person');
  await expect(hist.locator('.provenance-card', { hasText: 'QF_NOTICE_4' })).toBeVisible();
  await expect(folds).toHaveCount(1);
});

test('a peer\'s note (bare on the bus, enveloped in the queue) folds as its card', async ({ page, baseURL }) => {
  await mockSession(page, base, 'running');
  const hist = await openCancelledComposer(page, baseURL!);
  await expect(hist).toContainText('QF_ASK', { timeout: 30000 });
  await waitForWs(page);
  const note = kit.buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'Sample lead [abcd1234]', title: 'QF_PEER_TITLE check' }, body: 'QF_PEER_BODY please check the build.' });
  await injectEvent(page, 'session:message-queued', {
    sessionId: SESSION_ID, messageId: 'qm-qpeer-1', message: 'QF_PEER_BODY please check the build.', source: 'peer',
    sentBy: 'agent', queuedText: note, enqueuedAt: new Date().toISOString(),
  });
  // Alone in the running turn, it is the turn's fold.
  const fold = hist.locator('[data-testid="turn-fold"]');
  await expect(fold.locator(':scope > .tool-run-toggle')).toHaveText(new RegExp(`^${WORKING}Received 1 message(?: from [^·›]+?)?›?$`));
  await expect(hist.locator('.session-msg-user', { hasText: 'QF_PEER_BODY' })).toHaveCount(0);
  await fold.locator(':scope > .tool-run-toggle').click();
  await expect(fold.locator('.provenance-card')).toHaveCount(1);
  await expect(fold).toContainText('QF_PEER_TITLE');
});

test('a row without sentBy (an older server) renders as before', async ({ page, baseURL }) => {
  await mockSession(page, base, 'running');
  const hist = await openCancelledComposer(page, baseURL!);
  await expect(hist).toContainText('QF_ASK', { timeout: 30000 });
  await waitForWs(page);
  await queued(page, 'qm-ql-1', notice(1));
  await expect(hist.locator('.provenance-card', { hasText: 'QF_NOTICE_1' })).toBeVisible();
  await expect(hist.locator('[data-testid="received-fold"]')).toHaveCount(0);
});

/**
 * The composer's real send, with only the model stubbed: the `session:send` RPC is
 * answered on the captured socket with the queue id the server would give, so the
 * optimistic bubble carries that id (useSessionSend adopts res.messageId).
 */
async function stubSessionSend(page: Page, messageId: string) {
  await page.evaluate((messageId) => {
    const ws = (window as any).__capturedWs as WebSocket;
    const inner = ws.send.bind(ws);
    (window as any).__sessionSends = [];
    ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
      try {
        const parsed = JSON.parse(data as string);
        if (parsed.type === 'req' && parsed.method === 'session:send') {
          (window as any).__sessionSends.push(parsed.payload);
          setTimeout(() => ws.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { messageId, enqueuedAt: new Date().toISOString() } }),
          })), 10);
          return;
        }
      } catch { /* non-JSON */ }
      inner(data);
    };
  }, messageId);
}

/** Type and send through the real composer, then start a new draft in it. */
async function sendThenDraft(page: Page, text: string, draft: string) {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`);
  const box = panel.locator('.chat-input-textarea').first();
  await box.click();
  await box.pressSequentially(text);
  await panel.locator('.chat-send-btn-icon:not(.chat-stop-btn-icon)').click();
  await expect.poll(() => page.evaluate(() => ((window as any).__sessionSends as Array<{ message?: string }>).map((p) => p.message))).toEqual([text]);
  await expect(box).toHaveValue('');
  await box.pressSequentially(draft);
  return box;
}

async function openCancelledComposer(page: Page, baseURL: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(`<a href="${baseURL}/sessions?id=${SESSION_ID}">Open session</a>`);
  await page.getByRole('link', { name: 'Open session', exact: true }).click();
  return page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .session-history`);
}

test('a Stop that returns an edited queued message puts the edited words in the composer, ahead of the new draft', async ({ page, baseURL }) => {
  await mockSession(page, base, 'idle');
  const hist = await openCancelledComposer(page, baseURL!);
  await expect(hist).toContainText('QF_ASK', { timeout: 30000 });
  await waitForWs(page);
  await stubSessionSend(page, 'qm-qc-edited');
  const box = await sendThenDraft(page, 'QC_OLD words as first sent', 'QC_DRAFT typed since');
  // The row was edited in the queue before the Stop cancelled it: the event carries its words now.
  await injectEvent(page, 'session:queued-cancelled', { sessionId: SESSION_ID, messageIds: ['qm-qc-edited'], messages: ['QC_EDITED words after the edit'] });
  await expect(box).toHaveValue(/^QC_EDITED words after the edit/);
  const value = await box.inputValue();
  expect(value).toContain('QC_DRAFT typed since');
  expect(value).not.toContain('QC_OLD');
});

test('a Stop event with no message texts (an older server) returns the bubble\'s own words, draft kept', async ({ page, baseURL }) => {
  await mockSession(page, base, 'idle');
  const hist = await openCancelledComposer(page, baseURL!);
  await expect(hist).toContainText('QF_ASK', { timeout: 30000 });
  await waitForWs(page);
  await stubSessionSend(page, 'qm-qc-legacy');
  const box = await sendThenDraft(page, 'QC_LEGACY words as sent', 'QC_DRAFT typed since');
  await injectEvent(page, 'session:queued-cancelled', { sessionId: SESSION_ID, messageIds: ['qm-qc-legacy'] });
  await expect(box).toHaveValue(/^QC_LEGACY words as sent/);
  expect(await box.inputValue()).toContain('QC_DRAFT typed since');
});
