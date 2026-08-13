/**
 * Playwright: composer stop/send swap + Claude-style working indicator.
 *
 * The 2026-08 composer rework (user-requested):
 *   1. While a turn is streaming and the composer is EMPTY, the primary button
 *      is a square STOP (fires the bare `session:interrupt` RPC). Typing flips
 *      it back to the ↑ send button.
 *   2. The old "Streaming" pill badge is GONE; the turn-is-live signal is the
 *      tail working indicator: walnut icon + "<label> is working…" + elapsed
 *      seconds (+ token estimate once content streams).
 *
 * Uses the captured-WS injection harness (same as
 * single-timeline-fault-injection.spec.ts) so streaming state is driven
 * deterministically without a real CLI. The stop test asserts the DOWNSTREAM
 * effect: clicking stop must put a `session:interrupt` RPC frame on the wire.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-composer-stop';

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined;
      if (!ws) throw new Error('No captured WebSocket — did addInitScript run?');
      const frame = JSON.stringify({ type: 'event', name, data, seq: Date.now() });
      ws.dispatchEvent(new MessageEvent('message', { data: frame }));
    },
    { name, data },
  );
}

async function waitForWs(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 10000 });
}

async function mockSessionDetail(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-composer',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 2,
          title: 'Composer stop session',
        },
      },
    });
  });
}

const base = [
  { role: 'user', text: 'Run the check', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', text: 'Starting.', timestamp: '2026-01-01T00:00:01.000Z' },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    (window as any).__sentFrames = [];
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const origSend = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            let intercepted = false;
            try {
              const parsed = JSON.parse(data as string);
              (window as any).__sentFrames.push(parsed);
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                intercepted = true;
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: [], isStreaming: false } }),
                  }));
                }, 10);
              }
              if (parsed.type === 'req' && parsed.method === 'session:interrupt') {
                // Answer locally so the click resolves without a live runner.
                intercepted = true;
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { ok: true } }),
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
  });

  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const url = new URL(route.request().url());
    const since = url.searchParams.get('since');
    if (since !== null) return route.fulfill({ json: { messages: [], cursor: base.length, delta: true } });
    return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
  });
});

test.describe('Composer stop/send swap + working indicator', () => {
  test('empty composer while streaming → STOP button; typing → send; stop click sends session:interrupt', async ({ page }) => {
    await mockSessionDetail(page);
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    // Idle + empty input → the (disabled) SEND button, no stop.
    // Scope to the SESSION panel — the main-chat composer also renders these classes.
    const panel = page.locator('.session-panel');
    const sendBtn = panel.locator('.chat-send-btn-icon:not(.chat-stop-btn-icon)');
    const stopBtn = panel.locator('.chat-stop-btn-icon');
    await expect(sendBtn).toBeVisible();
    await expect(stopBtn).toHaveCount(0);

    // Turn starts streaming (composer still empty) → primary swaps to STOP.
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Working on it…', msgId: 'msg-c1' });
    await expect(stopBtn).toBeVisible({ timeout: 5000 });
    await expect(sendBtn).toHaveCount(0);

    // Typing mid-turn → flips back to SEND (queue semantics).
    const textarea = panel.locator('.chat-input-textarea').first();
    await textarea.fill('a follow-up');
    await expect(sendBtn).toBeVisible();
    await expect(stopBtn).toHaveCount(0);

    // Clearing the draft → STOP again.
    await textarea.fill('');
    await expect(stopBtn).toBeVisible();

    // DOWNSTREAM: clicking stop must put session:interrupt on the wire with
    // the session id (not just close a menu).
    await stopBtn.click();
    await expect.poll(async () => page.evaluate(() =>
      ((window as any).__sentFrames as Array<{ method?: string; payload?: { sessionId?: string } }>)
        .filter(f => f.method === 'session:interrupt')
        .map(f => f.payload?.sessionId),
    ), { timeout: 5000 }).toContain(SESSION_ID);

    await page.screenshot({ path: '/tmp/composer-stop/stop-button-flow.png' });
  });

  test('working indicator: walnut icon + elapsed seconds + token estimate; no "Streaming" pill anywhere', async ({ page }) => {
    await mockSessionDetail(page);
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });
    const history = page.locator('.session-history');

    // Stream ~600 chars so the token estimate (chars/4) is a visible "~150".
    const chunk = 'All twelve verification checks passed without any warnings. '; // 61 chars
    for (let i = 0; i < 10; i++) {
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: chunk, msgId: 'msg-ind-1' });
    }

    const indicator = page.locator('.session-working-indicator');
    await expect(indicator).toBeVisible({ timeout: 5000 });
    // No icon — the indicator is text-only with a scanning-underline label.
    await expect(indicator.locator('img')).toHaveCount(0);
    await expect(indicator.locator('.session-working-label')).toBeVisible();
    // Label text.
    await expect(indicator).toContainText('is working');
    // Token estimate rendered (610 chars → ~152 tokens).
    await expect(indicator.locator('.session-working-meta')).toContainText('tokens');

    // Elapsed seconds tick: meta shows "0s…" then advances past 1s.
    await expect.poll(async () =>
      (await indicator.locator('.session-working-meta').textContent()) ?? '',
    { timeout: 5000 }).toMatch(/[1-9]\d*s/);

    // Token figure must GROW as the turn produces more output — including
    // TOOL activity (agentic turns are mostly tools; a text-only counter
    // freezes, the reported "token count not going up" bug).
    const readTokens = async () => {
      const meta = (await indicator.locator('.session-working-meta').textContent()) ?? '';
      const m = meta.match(/([\d.]+)(k?) tokens/);
      if (!m) return -1;
      return parseFloat(m[1]) * (m[2] === 'k' ? 1000 : 1);
    };
    const beforeTool = await readTokens();
    expect(beforeTool).toBeGreaterThan(0);
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'tool-ind-1',
      input: { command: 'grep -rn pattern src/ --include "*.ts" | head -50' },
    });
    await injectEvent(page, 'session:tool-result', {
      sessionId: SESSION_ID, toolUseId: 'tool-ind-1',
      result: 'x'.repeat(2000),
    });
    await expect.poll(readTokens, { timeout: 5000 }).toBeGreaterThan(beforeTool + 400);

    // The retired "Streaming" pill must not exist anywhere.
    await expect(page.locator('.session-streaming-badge')).toHaveCount(0);

    await page.screenshot({ path: '/tmp/composer-stop/working-indicator.png' });

    // Turn ends → indicator leaves with isStreaming.
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
    await expect(indicator).toHaveCount(0, { timeout: 5000 });
    // Streamed content is still there (never-vanish invariant intact).
    await expect(history).toContainText('verification checks passed');
  });
});
