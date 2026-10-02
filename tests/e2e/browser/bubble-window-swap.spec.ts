/**
 * Playwright browser test: "Delivered" bubbles whose rows the client never loads.
 *
 * THE BUG (inc-1790922678361, reported as "my old messages pile up at the bottom
 * again, a refresh fixes it"): six sends landed mid-turn during a 13-minute turn.
 * The server was redeployed before the turn ended, so its history cache was cold
 * and the panel's refetch came back as a byte-bounded TAIL WINDOW whose first row
 * was the compaction summary, minutes after those sends. Their rows sat above the
 * window; later deltas only append; no text pass could ever see them. The bubbles
 * stayed "Delivered ✓" under every later turn until a reload (which drops them,
 * because the server had already removed the queue rows at delivery).
 *
 * The fix accounts for such a bubble by position, the way the launch bubble is: a
 * delivered bubble enqueued before the loaded window's first row (by more than the
 * clock slack) has its row above the window. A bubble enqueued INSIDE the window
 * keeps rendering until its row arrives, because there a missing row is real.
 *
 * Drives the REAL composer against a mocked history/WS transport so the swap is
 * deterministic (the production shape needs a redeploy mid-turn).
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-window-swap-session';
const TASK_ID = 'pw-window-swap-task';

const BIG_HISTORY_TURNS = 150;
function buildBigHistory() {
  const msgs: Array<{ role: string; text: string; timestamp: string }> = [];
  for (let i = 0; i < BIG_HISTORY_TURNS; i++) {
    msgs.push({ role: 'user', text: `historical question ${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
    msgs.push({ role: 'assistant', text: `historical answer ${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i, 30)).toISOString() });
  }
  return msgs;
}

/** The server clock the mocked `session:send` stamps on each enqueue, in order. */
const ENQUEUED_AT = [
  '2026-01-01T03:00:00.000Z', // first mid-turn send
  '2026-01-01T03:01:30.000Z', // second mid-turn send
  '2026-01-01T03:21:00.000Z', // the send made after the swap, inside the window
];
/** The tail window the cold server answers with: starts at the compaction. */
const WINDOW_ROWS = [
  { role: 'user', text: 'This session is being continued from a previous conversation that ran out of context.', timestamp: '2026-01-01T03:20:00.000Z', injected: true },
  { role: 'assistant', text: 'Picking up where the turn left off.', timestamp: '2026-01-01T03:20:05.000Z' },
];

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    if (!ws) throw new Error('No captured WebSocket — did addInitScript run?');
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
  }, { name, data });
}

async function waitForWs(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 15000 });
}

async function sentIds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__sentMessageIds ?? []);
}

/** Type into the REAL session composer and press Enter. */
async function sendViaUi(page: Page, text: string) {
  const input = page.locator('textarea[placeholder*="Send a message to this session"]').first();
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((enqueuedAt: string[]) => {
    (window as any).__sentMessageIds = [];
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const origSend = this.send.bind(this);
          let n = 0;
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            let intercepted = false;
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:send') {
                intercepted = true;
                // Mirror the server: a qm-… id plus the enqueue time on ITS clock.
                const messageId = `qm-pw${++n}`;
                (window as any).__sentMessageIds.push(messageId);
                const payload = { messageId, enqueuedAt: enqueuedAt[n - 1] ?? new Date().toISOString() };
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload }),
                  }));
                }, 10);
              }
              if (parsed.type === 'req' && (parsed.method === 'session:stream-subscribe' || parsed.method === 'session:get-queue')) {
                intercepted = true;
                const payload = parsed.method === 'session:get-queue' ? { messages: [] } : { blocks: [], isStreaming: false };
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload }),
                  }));
                }, 10);
              }
            } catch { /* non-JSON */ }
            if (!intercepted) origSend(data);
          };
        }
      }
    } as any;
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as any)[key] = (OrigWebSocket as any)[key]; } catch { /* read-only */ }
      }
    }
  }, ENQUEUED_AT);
});

async function mockSessionDetail(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut',
          process_status: 'running', mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
          messageCount: BIG_HISTORY_TURNS * 2, title: 'Big chat — window swap',
        },
      },
    });
  });
}

test.describe('bubbles above a swapped tail window', () => {
  test('a cold tail window after a mid-turn redeploy: the old sends clear, a send inside the window stays until its row lands', async ({ page }) => {
    const base = buildBigHistory();
    const S1 = 'first send during the long turn';
    const S2 = 'second send during the long turn';
    const S3 = 'a send made after the server came back';
    // Phases of the mocked server: 'warm' serves the full array and empty
    // deltas (the turn is still running); 'cold' is the restarted server whose
    // delta route answers with a rebuilt, windowed tail; 'landed' appends S3's
    // row to that window.
    let phase: 'warm' | 'cold' | 'landed' = 'warm';
    const window = [...WINDOW_ROWS];
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      if (phase === 'warm') {
        if (since !== null) return route.fulfill({ json: { messages: [], cursor: base.length, delta: true } });
        return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
      }
      if (phase === 'landed' && window.length === WINDOW_ROWS.length) {
        window.push({ role: 'user', text: S3, timestamp: '2026-01-01T03:21:00.400Z' } as any);
        window.push({ role: 'assistant', text: 'Answered the late send.', timestamp: '2026-01-01T03:21:30.000Z' });
      }
      // The restarted server knows nothing of the client's cursor space: it
      // rebuilds (delta:false) with the bounded tail window it could read.
      if (since !== null && Number(since) <= window.length && phase === 'landed') {
        return route.fulfill({ json: { messages: window.slice(Number(since)), cursor: window.length, delta: true } });
      }
      return route.fulfill({ json: { messages: window, cursor: window.length, delta: false, windowed: true } });
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 15000 });
    const history = page.locator('.session-history');
    await expect(history).toContainText(`historical answer ${BIG_HISTORY_TURNS - 1}`);

    // ── The long turn streams; two sends land mid-turn and are delivered ──
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Working through the pipeline', taskId: TASK_ID });
    await page.waitForTimeout(150);
    for (const text of [S1, S2]) {
      await sendViaUi(page, text);
      await page.waitForTimeout(250);
    }
    const ids = await sentIds(page);
    expect(ids).toHaveLength(2);
    await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 2, messageIds: ids, taskId: TASK_ID });
    await expect(page.locator('.session-msg-delivered')).toHaveCount(2);
    await page.screenshot({ path: '/tmp/bubble-window-swap/step1-two-delivered-midturn.png' });

    // ── The server is redeployed mid-turn. When the turn ends, the refetch meets
    // a cold cache and comes back as a tail window starting at the compaction. ──
    phase = 'cold';
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, taskId: TASK_ID, isError: false });
    await expect(history).toContainText('Picking up where the turn left off.', { timeout: 15000 });

    // Both bubbles are accounted for: their rows sit above the loaded window.
    await expect(page.locator('.session-msg-delivered')).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator('.session-msg-queued')).toHaveCount(0);
    await expect(history).not.toContainText(S1);
    await expect(history).not.toContainText(S2);
    await page.screenshot({ path: '/tmp/bubble-window-swap/step2-window-swapped-no-pinned-bubbles.png' });

    // ── Control: a send made now, inside the window, must keep its bubble until
    // its own row arrives — a missing row INSIDE the window is a real mismatch. ──
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Next turn', taskId: TASK_ID });
    await page.waitForTimeout(150);
    await sendViaUi(page, S3);
    await page.waitForTimeout(250);
    const [, , id3] = await sentIds(page);
    await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1, messageIds: [id3], taskId: TASK_ID });
    await expect(page.locator('.session-msg-delivered')).toHaveCount(1);
    // A refetch that still lacks the row (another turn-end) leaves it on screen.
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, taskId: TASK_ID, isError: false });
    await page.waitForTimeout(1500);
    await expect(page.locator('.session-msg-delivered')).toHaveCount(1);
    await expect(history).toContainText(S3);
    await page.screenshot({ path: '/tmp/bubble-window-swap/step3-inside-window-bubble-kept.png' });

    // Its row lands with the next turn: the bubble clears, the text stays once.
    phase = 'landed';
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Answering', taskId: TASK_ID });
    await page.waitForTimeout(150);
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, taskId: TASK_ID, isError: false });
    await expect(page.locator('.session-msg-delivered')).toHaveCount(0, { timeout: 15000 });
    await expect(history).toContainText(S3);
    const copies = await page.evaluate((needle) => {
      return Array.from(document.querySelectorAll('.session-history *'))
        .filter((n) => n.children.length === 0 && (n.textContent ?? '').trim() === needle).length;
    }, S3);
    expect(copies, `"${S3}" renders exactly once`).toBe(1);
    await page.screenshot({ path: '/tmp/bubble-window-swap/step4-row-landed-clean.png' });
  });
});
