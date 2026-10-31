/**
 * The live turn a received message started folds into ONE row while it runs.
 *
 * History holds the message (a peer's note) once the turn starts; the tool calls
 * the session makes for it are still stream blocks. Drawn apart, that was two
 * rows, "Received a message ›" and "Used 2 tools ›" (2026-10-26, the user: "this
 * 2 can be collapsed"). Now it is one, "Received 1 message · Ran 2 tools ›", the
 * shape the turn keeps once it is answered.
 *
 * History and the WS are mocked (composer-stop-and-indicator.spec.ts harness):
 * the stream is injected event by event, so the turn is really live.
 */
import { test, expect, type Page } from '@playwright/test';
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit';

const SESSION_ID = 'pw-live-turn-fold';
const SHOTS = '/tmp/live-turn-fold';

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined;
      if (!ws) throw new Error('No captured WebSocket — did addInitScript run?');
      ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
    },
    { name, data },
  );
}

const note = createEnvelopeKit().buildWalnutMessage({
  kind: 'peer-note',
  attrs: { from: 'Sample lead [abcd1234]', title: 'LIVE_PEER_TITLE check the build' },
  body: 'Please check the build. LIVE_PEER_BODY',
});
const base = [
  { role: 'user', text: 'LIVE_ASK what is left?', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', text: 'LIVE_ANSWER nothing is left.', timestamp: '2026-01-01T00:00:01.000Z' },
  { role: 'user', text: note, timestamp: '2026-01-01T00:00:02.000Z' },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const origSend = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: [], isStreaming: false } }),
                  }));
                }, 10);
                return;
              }
            } catch { /* non-JSON */ }
            origSend(data);
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
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null) return route.fulfill({ json: { messages: [], cursor: base.length, delta: true } });
    return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: 'pw-task-live-fold', project: 'Walnut', process_status: 'running',
          mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
          messageCount: 3, title: 'Live turn fold session',
        },
      },
    });
  });
});

test('a received message and the tools the live turn runs for it are one fold row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 10000 });
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`);
  const history = panel.locator('.session-history');
  await expect(history).toContainText('LIVE_ANSWER nothing is left.', { timeout: 15000 });

  for (const [id, toolName, input] of [
    ['tool-live-1', 'Bash', { command: 'make check' }],
    ['tool-live-2', 'Read', { file_path: '/tmp/live/a.ts' }],
  ] as const) {
    await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName, toolUseId: id, input });
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: id, result: 'ok' });
  }

  const folds = history.locator('[data-testid="turn-fold"]');
  await expect(folds).toHaveCount(1, { timeout: 10000 });
  const fold = folds.first();
  await expect(fold.locator('.tool-run-toggle')).toHaveText(/^Received 1 message from Sample lead \u00b7 Ran 2 tools/);
  // No second row for the same turn: no tool run, no card outside the fold.
  await expect(history.locator('.tool-run-toggle')).toHaveCount(1);
  await expect(history.locator('.provenance-card')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-live-folded.png`, clip: (await fold.boundingBox())! }).catch(() => {});

  // Opened: the message and both calls, in order.
  await fold.locator('.tool-run-toggle').click();
  await expect(fold.locator('.provenance-card')).toHaveCount(1);
  await expect(fold.locator('.provenance-card')).toContainText('LIVE_PEER_TITLE check the build');
  await expect(fold).toContainText('make check');
  await expect(fold).toContainText('/tmp/live/a.ts');

  // A third call joins the same row.
  await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'tool-live-3', input: { command: 'make test' } });
  await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'tool-live-3', result: 'ok' });
  await expect(fold.locator('.tool-run-toggle')).toHaveText(/^Received 1 message(?: from [^·›]+?)? \u00b7 Ran 3 tools/);
  await expect(history.locator('[data-testid="turn-fold"]')).toHaveCount(1);
});
