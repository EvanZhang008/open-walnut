import fs from 'node:fs/promises';
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { seedColumns } from './draft-helpers';
import { isolateUiPrefs } from './todo-panel-helpers';

const SID = 'pw-codex-stream-retry';
const TITLE = 'Neutral retry conversation';
const OLD_ID = 'codex-interrupted-reply';
const FINAL_ID = 'codex-recovered-reply';
const NOTICE = 'Response interrupted. Codex is retrying.';
// More than 80 characters: the real system renderer must collapse this detail.
const PARTIAL = 'The interrupted draft answer began checking the neutral workspace, listed the first two findings, and stopped before its final recommendation.';
const FINAL = 'The recovered answer is complete and includes all three verified findings.';
const SHOTS = '/tmp/walnut-codex-latency';
const BASE = [{ role: 'user', text: 'Check the neutral workspace', msgId: 'neutral-prompt', timestamp: '2026-01-01T00:00:00.000Z' }];
const PARTIAL_ROW = { role: 'assistant', text: PARTIAL, msgId: OLD_ID, unsettled: true, timestamp: '2026-01-01T00:00:01.000Z' };
const ERROR_ROW = { role: 'system', text: NOTICE, msgId: OLD_ID, systemVariant: 'error', systemDetail: PARTIAL, timestamp: PARTIAL_ROW.timestamp };
const FINAL_ROW = { role: 'assistant', text: FINAL, msgId: FINAL_ID, timestamp: '2026-01-01T00:00:03.000Z' };
const ERROR_BLOCK = { type: 'system', variant: 'error', message: NOTICE, detail: PARTIAL, uuid: OLD_ID, replacesMsgId: OLD_ID };

const panel = (page: Page) => page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"]`);
const history = (page: Page) => panel(page).locator('.session-history');
const failedAnswer = (page: Page) => history(page).locator(`[data-message-id="${OLD_ID}"][data-msg-role="assistant"]`);
const finalAnswer = (page: Page) => history(page).locator(`[data-message-id="${FINAL_ID}"][data-msg-role="assistant"]`);
const errorCard = (page: Page) => history(page).locator('.tool-run-row').filter({
  has: page.locator('.tool-run-toggle').filter({ hasText: NOTICE }),
});

async function inject(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__codexRetryWs as WebSocket | undefined;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('The fixture WebSocket is not open');
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: ++(window as any).__codexRetrySeq }) }));
  }, { name, data });
}

async function captureWs(page: Page) {
  // Same transport as single-timeline-fault-injection.spec.ts. Only the app's /ws
  // socket is captured; Vite's HMR socket and unrelated real fixture RPCs remain real.
  await page.addInitScript(() => {
    (window as any).__codexRetrySeq = Date.now();
    (window as any).__codexRetrySubscriptions = 0;
    (window as any).__codexRetrySnapshotReplies = 0;
    (window as any).__codexRetrySnapshot = { blocks: [], isStreaming: false, completedLen: 0 };
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), location.href).pathname !== '/ws') return;
        (window as any).__codexRetryWs = this;
        const realSend = this.send.bind(this);
        this.send = (raw: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          let frame: { type?: string; id?: string; method?: string; payload?: { sessionId?: string } };
          try { frame = JSON.parse(String(raw)); } catch { realSend(raw); return; }
          if (frame.type !== 'req' || frame.payload?.sessionId !== 'pw-codex-stream-retry') { realSend(raw); return; }
          let payload: unknown;
          if (frame.method === 'session:stream-subscribe') {
            (window as any).__codexRetrySubscriptions++;
            payload = (window as any).__codexRetrySnapshot;
          } else if (frame.method === 'session:get-queue') payload = { messages: [] };
          else { realSend(raw); return; }
          setTimeout(() => {
            this.dispatchEvent(new MessageEvent('message', {
              data: JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }),
            }));
            if (frame.method === 'session:stream-subscribe') (window as any).__codexRetrySnapshotReplies++;
          }, 0);
        };
      }
    } as typeof WebSocket;
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (!['prototype', 'length', 'name'].includes(key)) {
        try { (window.WebSocket as any)[key] = (Original as any)[key]; } catch { /* Read-only static property. */ }
      }
    }
  });
}

async function waitForSubscription(page: Page, after = 0) {
  await page.waitForFunction((count) => {
    const ws = (window as any).__codexRetryWs as WebSocket | undefined;
    return ws?.readyState === WebSocket.OPEN && (window as any).__codexRetrySnapshotReplies > count;
  }, after, { timeout: 15_000 });
}

async function reopenViaFinder(page: Page): Promise<Locator> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+Shift+O');
  const finder = page.locator('.session-search-panel');
  await expect(finder).toBeVisible();
  const input = finder.locator('.session-search-input');
  await expect(input).toBeFocused();
  const answered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/sessions/recent' && url.searchParams.get('q') === TITLE;
  });
  await input.fill(TITLE);
  await answered;
  await finder.locator('.session-search-result').filter({ hasText: TITLE }).click();
  await expect(panel(page)).toBeVisible();
  return panel(page);
}

async function expectRetryCard(page: Page) {
  await expect(failedAnswer(page)).toHaveCount(0);
  await expect(history(page)).not.toContainText(PARTIAL);
  await expect(errorCard(page)).toHaveCount(1);
  await expect(errorCard(page).locator('.session-system-detail-pre')).toHaveCount(0);
  const toggle = errorCard(page).locator('.tool-run-toggle').first();
  await toggle.click();
  await expect(errorCard(page).locator('.session-system-detail-pre')).toHaveText(PARTIAL);
  // Detail is allowed inside the one system card, never in a normal answer body.
  await expect(failedAnswer(page)).toHaveCount(0);
  await toggle.click();
  await expect(errorCard(page).locator('.session-system-detail-pre')).toHaveCount(0);
}

async function expectFinalOnce(page: Page) {
  await expect(finalAnswer(page)).toHaveCount(1);
  await expect(finalAnswer(page)).toContainText(FINAL);
  await expect.poll(async () => ((await history(page).textContent()) ?? '').split(FINAL).length - 1).toBe(1);
  await expect(history(page).getByText(NOTICE, { exact: false })).toHaveCount(1);
  await expect(failedAnswer(page)).toHaveCount(0);
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await fs.mkdir(SHOTS, { recursive: true });
  await panel(page).screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png` });
}

// Matrix: live-only failed text; failed text already persisted and revised by ID;
// retry arriving while its column is closed. Each also converges through history,
// a fresh page load, and a real finder-driven stream resubscription.
test.use({ viewport: { width: 1280, height: 900 } });
for (const scenario of ['live', 'persisted-prefix', 'offscreen'] as const) {
  test(`Codex retry replaces the ${scenario} failed answer with one collapsed card and one final answer`, async ({ page, baseURL }, info) => {
    test.setTimeout(60_000);
    await isolateUiPrefs(page);
    await seedColumns(page, [SID]);
    await page.addInitScript(() => localStorage.setItem('open-walnut-home-chat-visible', 'false'));
    await captureWs(page);
    let phase: 'base' | 'partial' | 'retry' | 'finished' = 'base';
    let revisedRequests = 0;
    let retryRevisionRequests = 0;
    let finishedReads = 0;
    const record = () => ({
      claudeSessionId: SID, taskId: '', project: 'Demo', title: TITLE,
      engine: 'codex', provider: 'acp', acpModel: 'neutral-balanced', acpModelName: 'Neutral Balanced',
      process_status: phase === 'finished' ? 'idle' : 'running', mode: 'bypass', output_mode: 'markdown',
      startedAt: BASE[0].timestamp, lastActiveAt: new Date().toISOString(), messageCount: phase === 'finished' ? 3 : 1,
    });
    await page.route('**/api/sessions', (route) => route.fulfill({ json: { sessions: [record()] } }));
    await page.route('**/api/sessions/recent**', (route) => route.fulfill({ json: { sessions: [record()] } }));
    await page.route(`**/api/sessions/${SID}`, (route) => route.fulfill({ json: { session: record(), pendingPermissions: [], cron: null } }));
    await page.route(`**/api/sessions/${SID}/controls`, (route) => route.fulfill({ json: { controls: [], source: 'acp' } }));
    await page.route(`**/api/sessions/${SID}/model-catalog`, (route) => route.fulfill({ json: {
      models: [{ modelId: 'neutral-balanced', name: 'Neutral Balanced' }], currentModelId: 'neutral-balanced', source: 'acp',
    } }));
    await page.route(`**/api/sessions/${SID}/plan`, (route) => route.fulfill({ json: { content: null } }));
    await page.route(`**/api/sessions/${SID}/workflow`, (route) => route.fulfill({ json: null }));
    await page.route(`**/api/sessions/${SID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const rows = phase === 'finished' ? [...BASE, ERROR_ROW, FINAL_ROW]
        : phase === 'retry' ? [...BASE, ERROR_ROW]
          : phase === 'partial' ? [...BASE, PARTIAL_ROW] : BASE;
      if (phase === 'finished') finishedReads++;
      const since = url.searchParams.get('since');
      if (since === null) return route.fulfill({ json: { messages: rows, cursor: rows.length, total: rows.length, delta: false } });
      const revisionRequested = (phase === 'retry' || phase === 'finished') && (url.searchParams.get('revise') ?? '').split(',').includes(OLD_ID);
      if (revisionRequested) {
        revisedRequests++;
        if (phase === 'retry') retryRevisionRequests++;
      }
      // Preserve cursor space: the old assistant row becomes the system row at
      // the same ID/index. Revisions replace the prefix; only new rows append.
      const anchor = url.searchParams.get('anchorMsgId');
      const anchorIndex = anchor ? rows.findIndex((row) => row.msgId === anchor) : -1;
      const offset = anchorIndex >= 0 ? anchorIndex + 1 + Number(url.searchParams.get('anchorTail') ?? 0) : Number(since);
      await route.fulfill({ json: {
        messages: rows.slice(offset), cursor: rows.length, delta: true,
        ...(revisionRequested ? { revisedMessages: [ERROR_ROW] } : {}),
      } });
    });

    if (!baseURL) throw new Error('The isolated Playwright fixture must provide baseURL');
    await page.evaluate((url) => { location.href = url; }, `${baseURL}/`);
    await expect(panel(page)).toBeVisible({ timeout: 30_000 });
    await waitForSubscription(page);
    await expect(history(page)).toContainText(BASE[0].text);

    await inject(page, 'session:text-delta', { sessionId: SID, delta: PARTIAL, msgId: OLD_ID });
    await expect(failedAnswer(page)).toContainText(PARTIAL);
    if (scenario === 'persisted-prefix') {
      // Only after the real text delta: history polling must not pre-create the
      // answer or the replacement and accidentally mask the streaming race.
      phase = 'partial';
      await inject(page, 'session:batch-completed', { sessionId: SID, count: 1 });
      await expect(history(page).locator(`[data-message-id="${OLD_ID}"][data-msg-ts]`)).toHaveCount(1);
    }
    const subscriptions = await page.evaluate(() => (window as any).__codexRetrySubscriptions as number);
    if (scenario === 'offscreen') {
      await panel(page).getByRole('button', { name: 'Close session panel', exact: true }).click();
      await expect(panel(page)).toHaveCount(0);
    }

    // The adapter has rewritten the interrupted row, but no successful reply
    // exists yet. The notice itself must trigger this revision read mid-turn.
    phase = 'retry';
    await inject(page, 'session:system-event', { sessionId: SID, variant: 'error', message: NOTICE, uuid: OLD_ID, replacesMsgId: OLD_ID, detail: PARTIAL });
    if (scenario === 'persisted-prefix') {
      await expect.poll(() => retryRevisionRequests, { message: 'the retry notice must re-read its unsettled history row before the final answer' }).toBeGreaterThan(0);
      await expect(history(page).locator(`[data-message-id="${OLD_ID}"][data-msg-role="system"]`)).toHaveCount(1);
      await expect(failedAnswer(page)).toHaveCount(0);
      await expect(finalAnswer(page)).toHaveCount(0);
      expect(phase).toBe('retry');
    }
    if (scenario === 'offscreen') {
      // Resubscribe BEFORE the retry produces new text. A snapshot ending at
      // the notice must not seed the next accumulator with the failed draft.
      await page.evaluate((snapshot) => { (window as any).__codexRetrySnapshot = snapshot; }, {
        blocks: [{ type: 'text', content: PARTIAL, msgId: OLD_ID }, ERROR_BLOCK],
        completedLen: 0, isStreaming: true,
      });
      await reopenViaFinder(page);
      await waitForSubscription(page, subscriptions);
      await expect(finalAnswer(page)).toHaveCount(0);
    }
    await expectRetryCard(page);
    await screenshot(page, info, `stream-${scenario}-interrupted`);
    await inject(page, 'session:text-delta', { sessionId: SID, delta: FINAL, msgId: FINAL_ID });
    await expectFinalOnce(page);
    await expect(finalAnswer(page)).not.toContainText(PARTIAL);
    await expect(history(page)).not.toContainText(PARTIAL + FINAL);
    await inject(page, 'session:result', { sessionId: SID, result: FINAL, isError: false });
    // The successful archive row appears only AFTER the real new-ID text and
    // result. The failed row's earlier revision must not depend on turn end.
    phase = 'finished';
    await inject(page, 'session:batch-completed', { sessionId: SID, count: 1 });
    await page.evaluate(({ partial, notice, final, oldId, finalId }) => {
      (window as any).__codexRetrySnapshot = { blocks: [
        { type: 'text', content: partial, msgId: oldId },
        { type: 'system', variant: 'error', message: notice, detail: partial, uuid: oldId, replacesMsgId: oldId },
        { type: 'text', content: final, msgId: finalId },
      ], completedLen: 3, isStreaming: false };
    }, { partial: PARTIAL, notice: NOTICE, final: FINAL, oldId: OLD_ID, finalId: FINAL_ID });
    await expect.poll(() => finishedReads).toBeGreaterThan(0);
    await expectFinalOnce(page);
    await expectRetryCard(page);
    if (scenario === 'persisted-prefix') await expect.poll(() => revisedRequests).toBeGreaterThan(0);
    await screenshot(page, info, `stream-${scenario}-history`);

    // A fresh page loses the live hook's state, so the history alone must carry
    // the system role, collapsed detail, stable old ID, and exactly one final.
    await page.reload();
    await expect(panel(page)).toBeVisible({ timeout: 30_000 });
    await waitForSubscription(page);
    await expectFinalOnce(page);
    await expectRetryCard(page);
    await screenshot(page, info, `stream-${scenario}-reload`);

    const afterReload = await page.evaluate(() => (window as any).__codexRetrySubscriptions as number);
    await panel(page).getByRole('button', { name: 'Close session panel', exact: true }).click();
    await expect(panel(page)).toHaveCount(0);
    // Retained server snapshot is authoritative on resubscribe; do not inject
    // fake React state or route around the actual finder/open-column path.
    await page.evaluate((snapshot) => { (window as any).__codexRetrySnapshot = snapshot; }, {
      blocks: [{ type: 'text', content: PARTIAL, msgId: OLD_ID }, ERROR_BLOCK, { type: 'text', content: FINAL, msgId: FINAL_ID }],
      completedLen: 3, isStreaming: false,
    });
    await reopenViaFinder(page);
    await waitForSubscription(page, afterReload);
    await expectFinalOnce(page);
    await expectRetryCard(page);
    await screenshot(page, info, `stream-${scenario}-resubscribed`);
  });
}
