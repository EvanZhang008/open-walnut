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
import { MOCK_SESSION_ID as SESSION_ID, injectEvent, mockSession, open, streamTools, waitForWs } from './mock-session-harness';

const SHOTS = '/tmp/queued-card-fold';
if (process.env.QUEUED_FOLD_VIDEO) test.use({ video: { mode: 'on', size: { width: 1280, height: 900 } } });

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
      for (const n of document.querySelectorAll('.session-streaming-panel .provenance-card')) {
        if (!n.closest('.process-fold[data-open="true"]')) (window as any).__openCardSeen = true;
      }
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true });
  });
}

// After the turn's commands, a card joins their row (session-step-group-fold.spec.ts).
test('an agent\'s card folds on arrival, mid-turn, and neighbours share the row', async ({ page }) => {
  await mockSession(page, base, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('QF_ASK', { timeout: 15000 });
  await streamTools(page, [['qf-1', 'make check'], ['qf-2', 'make test']]);
  await watchForOpenCards(page);

  await queued(page, 'qm-qf-1', notice(1), 'agent');
  const fold = hist.locator('[data-testid="step-group-fold"]');
  await expect(fold).toHaveCount(1);
  await expect(fold.locator(':scope > .tool-run-toggle')).toHaveText(/^Ran 2 commands, a notice: QF_NOTICE_1 It set its task to WAITING/);
  await expect(fold).toHaveAttribute('data-open', 'false');
  await expect(hist.locator('.provenance-card')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-arrived.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  await page.waitForTimeout(600);

  // A second one right after joins the same row.
  await queued(page, 'qm-qf-2', notice(2), 'agent');
  await expect(fold).toHaveCount(1);
  await expect(fold.locator(':scope > .tool-run-toggle')).toHaveText(/^Ran 2 commands, 2 notices›?$/);
  expect(await page.evaluate(() => (window as any).__openCardSeen)).toBe(false);

  // Opened: both cards, as they were.
  await fold.locator(':scope > .tool-run-toggle').click();
  await expect(fold.locator('.provenance-card')).toHaveCount(2);
  await expect(fold).toContainText('QF_NOTICE_1');
  await expect(fold).toContainText('QF_NOTICE_2');
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-opened.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  await page.waitForTimeout(600);
});

test('a person\'s message never folds, and splits two agent cards', async ({ page }) => {
  await mockSession(page, base, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('QF_ASK', { timeout: 15000 });
  await streamTools(page, [['qp-1', 'make check']]);

  await queued(page, 'qm-qp-1', notice(1), 'agent');
  await queued(page, 'qm-qp-2', 'QF_PHONE_WORDS please also look at the logs', 'person');
  await queued(page, 'qm-qp-3', notice(3), 'agent');
  await expect(hist.locator('.session-msg', { hasText: 'QF_PHONE_WORDS' })).toBeVisible();
  // Before the person's message: the command and the card, one row; after it, the card alone.
  await expect(hist.locator('[data-testid="step-group-fold"] > .tool-run-toggle')).toHaveText([/^Ran make check, a notice: QF_NOTICE_1/]);
  const folds = hist.locator('[data-testid="received-fold"]');
  await expect(folds).toHaveCount(1);
  await expect(folds.locator(':scope > .tool-run-toggle')).toHaveText(/^A notice: QF_NOTICE_3/);
  // An envelope a person's source sent (a letter they answered) shows too.
  await queued(page, 'qm-qp-4', notice(4), 'person');
  await expect(hist.locator('.provenance-card', { hasText: 'QF_NOTICE_4' })).toBeVisible();
  await expect(folds).toHaveCount(1);
});

test('a peer\'s note (bare on the bus, enveloped in the queue) folds as its card', async ({ page }) => {
  await mockSession(page, base, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('QF_ASK', { timeout: 15000 });
  const note = kit.buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'Sample lead [abcd1234]', title: 'QF_PEER_TITLE check' }, body: 'QF_PEER_BODY please check the build.' });
  await injectEvent(page, 'session:message-queued', {
    sessionId: SESSION_ID, messageId: 'qm-qpeer-1', message: 'QF_PEER_BODY please check the build.', source: 'peer',
    sentBy: 'agent', queuedText: note, enqueuedAt: new Date().toISOString(),
  });
  const fold = hist.locator('[data-testid="received-fold"]');
  await expect(fold.locator(':scope > .tool-run-toggle')).toHaveText(/^From Sample lead: QF_PEER_TITLE check/);
  await expect(hist.locator('.session-msg-user', { hasText: 'QF_PEER_BODY' })).toHaveCount(0);
  await fold.locator(':scope > .tool-run-toggle').click();
  await expect(fold.locator('.provenance-card')).toHaveCount(1);
  await expect(fold).toContainText('QF_PEER_TITLE');
});

test('a row without sentBy (an older server) renders as before', async ({ page }) => {
  await mockSession(page, base, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('QF_ASK', { timeout: 15000 });
  await queued(page, 'qm-ql-1', notice(1));
  await expect(hist.locator('.provenance-card', { hasText: 'QF_NOTICE_1' })).toBeVisible();
  await expect(hist.locator('[data-testid="received-fold"]')).toHaveCount(0);
});
