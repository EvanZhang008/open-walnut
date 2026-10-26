/**
 * A session panel over mocked history and a captured WebSocket: specs push
 * stream and queue events into the page one by one, so a live turn really runs
 * (the composer-stop-and-indicator.spec.ts harness, shared).
 */
import type { Page } from '@playwright/test';

export const MOCK_SESSION_ID = 'pw-mock-session';

export async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined;
      if (!ws) throw new Error('No captured WebSocket');
      ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
    },
    { name, data },
  );
}

export async function waitForWs(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 10000 });
}

export async function streamTools(page: Page, calls: (readonly [string, string, string?])[]) {
  for (const [id, command, result = 'ok'] of calls) {
    await injectEvent(page, 'session:tool-use', { sessionId: MOCK_SESSION_ID, toolName: 'Bash', toolUseId: id, input: { command } });
    await injectEvent(page, 'session:tool-result', { sessionId: MOCK_SESSION_ID, toolUseId: id, result });
  }
}

export async function mockSession(page: Page, messages: unknown[], status: 'running' | 'idle') {
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
  await page.route(`**/api/sessions/${MOCK_SESSION_ID}/history**`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null) return route.fulfill({ json: { messages: messages.slice(Number(since)), cursor: messages.length, delta: true } });
    return route.fulfill({ json: { messages, cursor: messages.length, delta: false } });
  });
  await page.route(`**/api/sessions/${MOCK_SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: MOCK_SESSION_ID, taskId: 'pw-task-mock-session', project: 'Walnut', process_status: status,
          mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
          messageCount: messages.length, title: 'Mock session',
        },
      },
    });
  });
}

export async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sessions?id=${MOCK_SESSION_ID}`);
  const panel = page.locator(`.session-panel[data-session-id="${MOCK_SESSION_ID}"]`);
  return panel.locator('.session-history');
}

