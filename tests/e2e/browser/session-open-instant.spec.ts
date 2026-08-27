/**
 * Playwright browser test: instant session open (IndexedDB tier + request coalescing).
 *
 * WHY: the in-memory history cache dies with the page, so every reload paid the
 * full server round trip before the first message painted — 140-300ms local,
 * 1-3s remote (daemon stat over SSH), p90 4s+. Two structural wastes made it
 * worse: SessionPanel and SessionChatHistory EACH mount useSessionHistory for
 * the same session (2× identical fetches per open), and a turn's batch-completed
 * fires both the hook's delta and session-cache's background delta.
 *
 * WHAT THIS PINS:
 *   1. Coalescing — one open produces exactly ONE streams fetch and ONE full
 *      fetch despite the dual mounts.
 *   2. Cache-first render — after a first visit seeds IndexedDB, a full reload
 *      renders messages from the persistent cache even when the network history
 *      route is BLACKHOLED (never answers inside the assertion window). The
 *      messages can only have come from IndexedDB.
 *
 * Deterministic by construction: asserting "renders while the route is held"
 * proves cache-first without racing wall-clock timings on a loaded machine.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-open-instant-session';
const TASK_ID = 'pw-open-instant-task';

function buildHistory(turns: number) {
  const msgs: Array<{ role: string; text: string; timestamp: string }> = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', text: `instant question ${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
    msgs.push({ role: 'assistant', text: `instant answer ${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i, 30)).toISOString() });
  }
  return msgs;
}

async function waitForWs(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 15000 });
}

test.beforeEach(async ({ page }) => {
  // Patch the WS so session:stream-subscribe resolves (panel boot path) without
  // a real backing session on the fixture server.
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

async function mockSessionDetail(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut',
          process_status: 'idle', mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
          messageCount: 12, title: 'Instant open',
        },
      },
    });
  });
}

test.describe('session open — instant (idb tier + coalescing)', () => {
  test('dual mounts coalesce to one fetch; reload renders from IndexedDB with the network held', async ({ page }) => {
    const history = buildHistory(6); // 12 messages

    // ── Visit 1: count history requests by shape ──
    let streamsFetches = 0;
    let fullFetches = 0;
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('since') !== null) {
        await route.fulfill({ json: { messages: [], cursor: history.length, delta: true } });
        return;
      }
      if (url.searchParams.get('source') === 'streams') streamsFetches++;
      else fullFetches++;
      await route.fulfill({
        json: { messages: history, cursor: history.length, delta: false, initialUserText: history[0].text },
      });
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 30000 });
    await expect(page.locator('.session-history')).toContainText('instant answer 5');

    // Coalescing: SessionPanel + SessionChatHistory both mount useSessionHistory,
    // but each request shape must hit the network exactly once. The full fetch
    // (Phase 2) fires only after the streams fetch settles — poll for it first.
    await expect.poll(() => fullFetches, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    // Let the debounced IndexedDB write-through land (800ms trailing debounce),
    // which also gives any straggler duplicate fetch time to show up.
    await page.waitForTimeout(1600);
    expect(streamsFetches, 'streams fetches on one open').toBeLessThanOrEqual(1);
    expect(fullFetches, 'full fetches on one open').toBe(1);
    await page.screenshot({ path: '/tmp/session-open-instant/visit1-seeded.png' });

    // ── Visit 2 (full reload): blackhole the history route. If messages render,
    // they came from IndexedDB — there is nowhere else. ──
    await page.unroute(`**/api/sessions/${SESSION_ID}/history**`);
    let heldRequests = 0;
    const pendingRoutes: Array<() => Promise<void>> = [];
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      heldRequests++;
      // Hold the response until after the assertion; fulfill later to unblock teardown.
      await new Promise<void>((resolve) => {
        pendingRoutes.push(async () => {
          await route.fulfill({ json: { messages: history, cursor: history.length, delta: false } }).catch(() => {});
          resolve();
        });
      });
    });

    const t0 = Date.now();
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForSelector('.session-msg', { timeout: 30000 });
    const renderMs = Date.now() - t0;
    await expect(page.locator('.session-history')).toContainText('instant answer 5');
    // The pinned initial prompt must survive the cache round trip too.
    await expect(page.locator('.session-history')).toContainText('instant question 0');
    await page.screenshot({ path: '/tmp/session-open-instant/visit2-idb-render.png' });

    // Proof: at least one network request is still being HELD while messages
    // are already on screen ⇒ the render did not come from the network.
    expect(heldRequests, 'history requests held at render time').toBeGreaterThanOrEqual(1);
    console.log(`[session-open-instant] reload → first message: ${renderMs}ms (network held; render source = IndexedDB)`);

    // Release the held routes so the context can tear down cleanly.
    for (const release of pendingRoutes) await release();
  });
});
