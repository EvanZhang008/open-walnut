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
    await page.setViewportSize({ width: 1280, height: 720 });
    const history = buildHistory(6); // 12 messages
    const opens: Array<{ source: string; ms: number; stages: Record<string, number>;
      outsideViewportAtAttach?: boolean; viewportSeen?: boolean; viewportEnteredMs?: number }> = [];
    page.on('console', async message => {
      if (!message.text().includes('[session-open] first content')) return;
      try {
        const record = await message.args()[1]?.jsonValue();
        if (record?.sessionId === SESSION_ID) opens.push(record);
      } catch { /* A context closed after the log; no measurement is invented. */ }
    });

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

    const savedSessionUrl = new URL(`/sessions?id=${SESSION_ID}`, test.info().project.use.baseURL).href;
    await page.setContent(`<a href="${savedSessionUrl}">Open saved session</a>`);
    await page.getByRole('link', { name: 'Open saved session', exact: true }).click();
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
    await page.screenshot({ path: '/tmp/session-open-instant/visit1-seeded.png', scale: 'css' });

    // ── Visit 2 (full reload): blackhole the history route. If messages render,
    // they came from IndexedDB — there is nowhere else. ──
    await page.unroute(`**/api/sessions/${SESSION_ID}/history**`);
    let heldRequests = 0;
    let heldScreens = 0;
    const pendingRoutes: Array<() => Promise<void>> = [];
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      heldRequests++;
      if (new URL(route.request().url()).searchParams.get('source') === 'streams') heldScreens++;
      // Hold the response until after the assertion; fulfill later to unblock teardown.
      await new Promise<void>((resolve) => {
        pendingRoutes.push(async () => {
          await route.fulfill({ json: { messages: history, cursor: history.length, delta: false } }).catch(() => {});
          resolve();
        });
      });
    });

    const previousOpens = opens.length;
    const t0 = Date.now();
    await page.reload();
    await page.waitForSelector('.session-msg', { timeout: 30000 });
    const renderMs = Date.now() - t0;
    await expect(page.locator('.session-history')).toContainText('instant answer 5');
    // The pinned initial prompt must survive the cache round trip too.
    await expect(page.locator('.session-history')).toContainText('instant question 0');
    await page.screenshot({ path: '/tmp/session-open-instant/visit2-idb-render.png', scale: 'css' });

    // Proof: at least one network request is still being HELD while messages
    // are already on screen ⇒ the render did not come from the network.
    // Cache paint may precede even dispatching the background verification.
    await expect.poll(() => heldRequests, { message: 'background history request is held' }).toBeGreaterThanOrEqual(1);
    console.log(`[session-open-instant] reload → first message: ${renderMs}ms (network held; render source = IndexedDB)`);

    await expect.poll(() => opens.slice(previousOpens).find(record => record.source === 'idb')).toBeTruthy();
    const restored = opens.slice(previousOpens).find(record => record.source === 'idb')!;
    // A cache that answers inside the grace window (150 ms) costs no first-screen
    // request. A reload's first IndexedDB open can itself be slower than that, and
    // then the screen read going out is the point (the delayed-open test below).
    const idbMs = restored.stages.idbReady - restored.stages.idbStart;
    console.log(`[session-open-instant] reload stages ${JSON.stringify(restored.stages)}; first-screen reads ${heldScreens}`);
    if (idbMs < 120) expect(heldScreens, 'first-screen reads while IndexedDB answered in time').toBe(0);
    const stages = ['historyEffect', 'idbStart', 'idbReady', 'historyReady', 'historyAdopted', 'contentDetected'];
    let last = 0;
    for (const stage of stages) {
      expect(restored.stages[stage], stage).toBeGreaterThanOrEqual(last);
      last = restored.stages[stage];
    }
    expect(restored.ms).toBeGreaterThanOrEqual(last);
    await test.info().attach('restored-open-stages', { body: JSON.stringify(restored), contentType: 'application/json' });

    // A restored column outside the viewport is not a visible loading wait.
    // Fixture CSS makes a real viewport resize reveal it without changing its DOM.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = '@media (max-width: 999px) { .session-panel { transform: translateX(1600px); } }';
        document.head.appendChild(style);
      });
    });
    await page.setViewportSize({ width: 900, height: 720 });
    const beforeOffscreen = opens.length;
    await page.reload();
    await expect(page.locator('.session-history')).toContainText('instant answer 5');
    // The IDB rows exist, but an offscreen body has not qualified as first content.
    expect(opens.slice(beforeOffscreen)).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(() => opens.slice(beforeOffscreen).find(record => record.source === 'idb')).toBeTruthy();
    const revealed = opens.slice(beforeOffscreen).find(record => record.source === 'idb')!;
    expect(revealed.outsideViewportAtAttach).toBe(true);
    expect(revealed.viewportSeen).toBe(true);
    expect(revealed.viewportEnteredMs).toBeGreaterThanOrEqual(0);
    expect(revealed.ms).toBeGreaterThanOrEqual(revealed.viewportEnteredMs!);
    await test.info().attach('offscreen-open-stages', { body: JSON.stringify(revealed), contentType: 'application/json' });
    await page.screenshot({ path: '/tmp/session-open-instant/visit3-viewport-render.png', scale: 'css' });

    // Release the held routes so the context can tear down cleanly.
    for (const release of pendingRoutes) await release();
  });
});

/** Holds the history cache's IndexedDB open (its onsuccess) until the page calls
 *  window.__releaseHistoryDb(): storage that is late without blocking the page. */
async function holdHistoryDbOpen(page: Page) {
  await page.addInitScript(() => {
    // Patched on the prototype and on the real request (no Proxy around a native
    // object, which WebKit does not take): the page's own onsuccess is kept back.
    const proto = IDBFactory.prototype;
    const original = proto.open;
    proto.open = function (this: IDBFactory, name: string, version?: number) {
      const request = version === undefined ? original.call(this, name) : original.call(this, name, version);
      if (name !== 'walnut-history-cache') return request;
      let handler: ((this: IDBRequest, ev: Event) => unknown) | null = null;
      Object.defineProperty(request, 'onsuccess', {
        configurable: true,
        get: () => handler,
        set: (value) => { handler = value; },
      });
      request.addEventListener('success', (event) => {
        (window as any).__historyDbHeld = true;
        (window as any).__releaseHistoryDb = () => handler?.call(request, event);
      });
      return request;
    } as typeof proto.open;
  });
}

// Storage can be late without blocking the page's event loop. A kept server
// screen must be allowed to paint while the IndexedDB open is still pending.
test('a readable first screen does not wait for a delayed IndexedDB open', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockSessionDetail(page);
  const history = buildHistory(200);
  let held = false;
  let streams = 0;
  let releaseFull!: () => void;
  const fullGate = new Promise<void>(resolve => { releaseFull = resolve; });
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('since')) {
      await route.fulfill({ json: { messages: [], cursor: history.length, delta: true } });
    } else if (url.searchParams.get('source') === 'streams') {
      streams++;
      await route.fulfill({ json: { messages: history.slice(-40), total: history.length, windowed: true } });
    } else {
      await fullGate;
      await route.fulfill({ json: { messages: history, cursor: history.length, initialUserText: history[0].text } }).catch(() => {});
    }
  });
  await holdHistoryDbOpen(page);
  const url = new URL(`/sessions?id=${SESSION_ID}`, test.info().project.use.baseURL).href;
  try {
    await page.setContent(`<a href="${url}">Open saved session</a>`);
    await page.getByRole('link', { name: 'Open saved session', exact: true }).click();
    await page.waitForFunction(() => (window as any).__historyDbHeld === true);
    held = true;
    // This assertion fails on the old serial IDB-before-network load path.
    await expect.poll(() => streams, { message: 'first screen fetched with storage held' }).toBe(1);
    await expect(page.locator('.session-history')).toContainText('instant answer 199');
    await page.screenshot({ path: '/tmp/session-open-instant/slow-idb-first-screen.png', scale: 'css' });
    await page.evaluate(() => (window as any).__releaseHistoryDb?.());
    held = false;
    releaseFull();
    await expect(page.locator('.session-history')).toContainText('instant answer 199');
    await expect(page.locator('.session-history')).toContainText('instant question 0');
  } finally {
    if (held) await page.evaluate(() => (window as any).__releaseHistoryDb?.()).catch(() => {});
    releaseFull();
  }
});

// The first screen wins over a late IndexedDB, then the full read fails (the
// host is offline): the cached transcript that arrives late is still shown.
test('a late IndexedDB copy fills in when the full read fails after the first screen won', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockSessionDetail(page);
  const history = buildHistory(200);
  const pattern = `**/api/sessions/${SESSION_ID}/history**`;
  await page.route(pattern, async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('since')) await route.fulfill({ json: { messages: [], cursor: history.length, delta: true } });
    else await route.fulfill({ json: { messages: history, cursor: history.length, initialUserText: history[0].text } });
  });
  const url = new URL(`/sessions?id=${SESSION_ID}`, test.info().project.use.baseURL).href;
  await page.setContent(`<a href="${url}">Open saved session</a>`);
  await page.getByRole('link', { name: 'Open saved session', exact: true }).click();
  await expect(page.locator('.session-history')).toContainText('instant question 0', { timeout: 30_000 });
  // The debounced IndexedDB write-through (800 ms) lands.
  await page.waitForTimeout(1600);

  await page.unroute(pattern);
  let fullFailed = 0;
  await page.route(pattern, async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('since')) await route.fulfill({ status: 503, json: { error: 'host offline' } });
    else if (url.searchParams.get('source') === 'streams') {
      await route.fulfill({ json: { messages: history.slice(-40), total: history.length, windowed: true } });
    } else {
      fullFailed++;
      await route.fulfill({ status: 503, json: { error: 'host offline' } });
    }
  });
  await holdHistoryDbOpen(page);
  let held = false;
  try {
    await page.reload();
    await page.waitForFunction(() => (window as any).__historyDbHeld === true);
    held = true;
    await expect(page.locator('.session-history')).toContainText('instant answer 199');
    await expect(page.locator('.session-history')).not.toContainText('instant question 0');
    await expect.poll(() => fullFailed, { message: 'the full read failed' }).toBeGreaterThanOrEqual(1);
    await page.evaluate(() => (window as any).__releaseHistoryDb?.());
    held = false;
    // The cache brings what the short screen lacks (the pinned first prompt).
    await expect(page.locator('.session-history')).toContainText('instant question 0');
    await expect(page.locator('.session-history')).toContainText('instant answer 199');
    await page.screenshot({ path: '/tmp/session-open-instant/late-idb-fallback.png', scale: 'css' });
  } finally {
    if (held) await page.evaluate(() => (window as any).__releaseHistoryDb?.()).catch(() => {});
  }
});
