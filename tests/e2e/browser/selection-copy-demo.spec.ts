/**
 * DEMO RECORDING (not a regression test — skipped unless PW_DEMO=1).
 *
 * Records a video walkthrough of the selection/copy fix:
 *   1. Open a session with multi-line history.
 *   2. Start streaming deltas.
 *   3. Drag-select lines 2-4 while more deltas stream in — selection stays bounded.
 *   4. Release, keep streaming — selection survives.
 *   5. Right-click the selection — still alive (context-menu Copy works).
 *   6. Click elsewhere — selection clears, stream catches up.
 *
 * Run: PW_DEMO=1 npx playwright test tests/e2e/browser/selection-copy-demo.spec.ts
 * Video lands in test-results/<test-dir>/video.webm.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-selection-demo';

test.skip(process.env.PW_DEMO !== '1', 'demo recording only — run with PW_DEMO=1');

test.use({ video: { mode: 'on', size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } });

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined;
      if (!ws) throw new Error('No captured WebSocket');
      ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
    },
    { name, data },
  );
}

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
            let intercepted = false;
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                intercepted = true;
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: [], isStreaming: false } }),
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
});

test('demo: selection survives streaming, auto-scroll pauses, copy works', async ({ page }) => {
  const baseMessages = [
    { role: 'user', text: 'Explain the design decisions', timestamp: '2026-01-01T00:00:00.000Z' },
    {
      role: 'assistant',
      text: [
        'Here is the summary of the design.',
        'Point one: the event bus decouples every subsystem.',
        'Point two: tasks are the atomic unit of work.',
        'Point three: sessions attach to tasks, not the reverse.',
        'Point four: the daemon owns CLI process lifecycles.',
        'Point five: streaming state is append-only.',
      ].join('\n\n'),
      msgId: 'msg-demo-1',
      timestamp: '2026-01-01T00:00:01.000Z',
    },
  ];
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('since') !== null) {
      return route.fulfill({ json: { messages: [], cursor: baseMessages.length, delta: true } });
    }
    return route.fulfill({ json: { messages: baseMessages, cursor: baseMessages.length, delta: false } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: 'pw-task-demo', project: 'Walnut',
          process_status: 'running', mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
          messageCount: 2, title: 'Selection & copy demo',
        },
      },
    });
  });

  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 10000 });
  await page.waitForSelector('.session-msg', { timeout: 8000 });
  await page.waitForTimeout(800);

  // Streaming begins.
  await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Live answer streaming in now. ', msgId: 'msg-demo-live' });
  await page.waitForTimeout(600);

  // Drag-select points one→three while streaming continues underneath.
  const from = page.locator('.session-history').getByText('Point one', { exact: false }).first();
  const to = page.locator('.session-history').getByText('Point three', { exact: false }).first();
  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  if (!fromBox || !toBox) throw new Error('anchors not visible');
  await page.mouse.move(fromBox.x + 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      fromBox.x + 2 + ((toBox.x + toBox.width * 0.9 - fromBox.x) * i) / 8,
      fromBox.y + fromBox.height / 2 + ((toBox.y + toBox.height / 2 - fromBox.y - fromBox.height / 2) * i) / 8,
    );
    await page.waitForTimeout(120);
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: `Streamed chunk ${i} keeps arriving. `, msgId: 'msg-demo-live' });
  }
  await page.waitForTimeout(1200);
  await page.mouse.up();

  // Keep streaming after release — selection survives.
  for (let i = 9; i <= 14; i++) {
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: `Post-release chunk ${i}. `, msgId: 'msg-demo-live' });
    await page.waitForTimeout(200);
  }

  const sel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(sel).toContain('Point one');
  expect(sel).toContain('Point three');
  expect(sel).not.toContain('Post-release chunk');

  // Right-click the selection (context-menu copy path) — stays alive.
  await from.click({ button: 'right' });
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  const selAfterRightClick = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selAfterRightClick).toContain('Point one');

  // Click away — clears; stream content catches up.
  await page.locator('.session-history').getByText('Here is the summary', { exact: false }).first().click();
  await page.waitForTimeout(600);
  await expect(page.locator('.session-streaming-panel')).toContainText('Post-release chunk 14');
  await page.waitForTimeout(1000);
});
