/**
 * Playwright browser test: the "Showing cached history — Reconnecting…" banner
 * must SELF-HEAL once the live read recovers.
 *
 * Reported bug: a remote session's history fetch failed the live read
 * (SSH/daemon down → server served its last-good parse with `stale: true`), so
 * the yellow "Showing cached history … Reconnecting…" banner appeared. Then the
 * host recovered in the background — but the banner NEVER went away.
 *
 * Root cause (fixed): `stale` was only cleared by the NEXT successful full
 * fetch, and for an IDLE remote session nothing ever triggers one — no turn
 * boundary (batch-completed), the browser WS never dropped (_ws:reconnected),
 * and the user didn't switch sessions. The banner froze forever, still showing
 * the stale "Ns ago" from the last failed read.
 *
 * The fix (useSessionHistory): while `stale`, retry a FULL fetch (never
 * `?since=` — a delta read failure 502s and would corrupt the client cursor) on
 * an interval. A healthy fetch adopts the fresh parse and clears the banner.
 *
 * This asserts the guarantee against a REAL browser + the real React hook: the
 * banner shows on a stale payload, and disappears (with fresh content) once the
 * mocked endpoint recovers — driven purely by the hook's self-heal poll, with
 * NO turn boundary, NO WS reconnect, NO session switch.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-stale-session';

/** Mock the session-detail endpoint so the session renders (remote host). */
async function mockSessionDetail(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-stale-task',
          project: 'Walnut',
          host: 'clouddev',
          process_status: 'idle',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 2,
          title: 'Stale banner repro',
        },
      },
    });
  });
}

// Speed up the hook's 10s self-heal poll so the test doesn't wait 10s.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __staleRetryMs?: number }).__staleRetryMs = 500;
    (window as unknown as { __staleBannerGraceMs?: number }).__staleBannerGraceMs = 0;
  });
});

/**
 * A deploy restarts the server, and its first dial to a remote host leaves the
 * live read failing for a few seconds while the session runs on untouched
 * (2026-11-03: every clouddev session flashed "Showing cached history.
 * Reconnecting" for about 10 s on a deploy that changed nothing there). The
 * banner waits STALE_BANNER_GRACE_MS (8 s) and the hook re-reads quickly in the
 * first seconds, so a short drop never shows it; a real outage still does.
 */
test.describe('a short drop of the live read shows no banner', () => {
  async function routeHistory(page: Page, isDown: () => boolean) {
    const cached = [
      { role: 'user', text: 'Old cached question', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Old cached answer', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    const live = [...cached, { role: 'assistant', text: 'Fresh answer after the restart', timestamp: '2026-01-01T00:01:01.000Z' }];
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('source') === 'streams') return route.fulfill({ json: { messages: [], total: 0 } });
      if (url.searchParams.get('since') !== null) {
        if (isDown()) return route.fulfill({ status: 502, json: { error: 'Remote read failed' } });
        return route.fulfill({ json: { messages: [], cursor: live.length, delta: true } });
      }
      if (isDown()) {
        return route.fulfill({ json: { messages: cached, total: cached.length, stale: true, staleReason: 'Reconnecting to clouddev' } });
      }
      return route.fulfill({ json: { messages: live, cursor: live.length, delta: false } });
    });
    await mockSessionDetail(page);
  }

  test.beforeEach(async ({ page }) => {
    // The real grace and the real steady retry: only the quick early re-reads can recover in time.
    await page.addInitScript(() => {
      const w = window as unknown as { __staleRetryMs?: number; __staleBannerGraceMs?: number };
      w.__staleRetryMs = 10_000;
      delete w.__staleBannerGraceMs;
    });
  });

  test('a read failing for 3 s (a server restart) never shows the banner, and the content catches up', async ({ page }) => {
    // Down for 3 s from the first read the page makes.
    let firstAt = 0;
    await routeHistory(page, () => {
      if (!firstAt) firstAt = Date.now();
      return Date.now() - firstAt < 3_000;
    });
    await page.goto(`/sessions?id=${SESSION_ID}`);
    const history = page.locator('.session-history');
    const banner = page.locator('.session-history-stale-banner');
    await expect.poll(() => firstAt, { timeout: 15_000 }).toBeGreaterThan(0);
    const t0 = firstAt;
    let shown = false;
    while (Date.now() - t0 < 12_000) {
      if (await banner.count()) shown = true;
      if (await history.textContent().then((t) => t?.includes('Fresh answer after the restart'))) break;
      await page.waitForTimeout(200);
    }
    expect(shown, 'a 3 s drop must not show the cached-history banner').toBe(false);
    await expect(history).toContainText('Fresh answer after the restart', { timeout: 1_000 });
    // Caught up by the quick re-reads, well before the 10 s steady retry.
    expect(Date.now() - t0).toBeLessThan(9_000);
  });

  test('a read that keeps failing shows the banner after the grace', async ({ page }) => {
    await routeHistory(page, () => true);
    await page.goto(`/sessions?id=${SESSION_ID}`);
    const history = page.locator('.session-history');
    await expect(history).toContainText('Old cached answer', { timeout: 15_000 });
    const t0 = Date.now();
    const banner = page.locator('.session-history-stale-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner.locator('.session-history-stale-text')).toHaveText('Showing cached history. Reconnecting to clouddev...');
    expect(Date.now() - t0).toBeGreaterThan(5_000);
  });
});

test.describe('stale history banner self-heals on reconnect', () => {
  test('banner appears on a stale payload and disappears once the live read recovers — no turn, no WS reconnect', async ({ page }) => {
    const cached = [
      { role: 'user', text: 'Old cached question', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Old cached answer', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    const live = [
      ...cached,
      { role: 'user', text: 'Fresh question after reconnect', timestamp: '2026-01-01T00:01:00.000Z' },
      { role: 'assistant', text: 'Fresh answer after reconnect', timestamp: '2026-01-01T00:01:01.000Z' },
    ];

    // Node-side switch: while true, the full fetch degrades to a stale payload;
    // flip it false to simulate the host recovering.
    let sshDown = true;
    // Records whether any retry ever hit the DELTA path (?since=) — it must NOT,
    // because a delta live-read failure 502s and corrupts the cursor.
    let deltaRequested = false;

    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const source = url.searchParams.get('source');
      const since = url.searchParams.get('since');
      // Remote sessions return empty for the streams fast-path (no local file).
      if (source === 'streams') {
        return route.fulfill({ json: { messages: [], total: 0 } });
      }
      if (since !== null) {
        deltaRequested = true;
        // Mirror the server: a delta read failure is a hard 502, never stale.
        if (sshDown) return route.fulfill({ status: 502, json: { error: 'Remote read failed' } });
        return route.fulfill({ json: { messages: [], cursor: live.length, delta: true } });
      }
      // Full fetch (no since): degraded → stale payload; recovered → live parse.
      if (sshDown) {
        return route.fulfill({
          json: {
            messages: cached,
            total: cached.length,
            stale: true,
            staleReason: 'Remote read failed (clouddev): Connection to clouddev failed recently (52s ago)',
          },
        });
      }
      return route.fulfill({ json: { messages: live, cursor: live.length, delta: false } });
    });
    await mockSessionDetail(page);

    // No networkidle wait: the stale retry polls every 500 ms here, so the page is
    // seldom idle for 500 ms (it timed out about one run in three). The banner wait is the sync.
    await page.goto(`/sessions?id=${SESSION_ID}`);

    // Banner is visible over the cached content.
    const banner = page.locator('.session-history-stale-banner');
    await expect(banner).toBeVisible({ timeout: 8000 });
    await expect(banner).toContainText('Showing cached history');
    const history = page.locator('.session-history');
    await expect(history).toContainText('Old cached answer');
    // Cached content is shown, live-only content is NOT yet present.
    await expect(history).not.toContainText('Fresh answer after reconnect');

    // Host recovers in the background — NO turn, NO WS reconnect, NO nav.
    // The self-heal poll (500ms here) must pick this up on its own.
    sshDown = false;

    // Banner disappears and the fresh content is adopted.
    await expect(banner).toHaveCount(0, { timeout: 8000 });
    await expect(history).toContainText('Fresh answer after reconnect');

    // The retries must have used the FULL path only — never the delta path.
    expect(deltaRequested, 'self-heal must NOT poll the ?since= delta path (it 502s and corrupts the cursor)').toBe(false);
  });
});

/**
 * A leader restart: the browser's socket reconnects within a second or two, and every open
 * remote session re-reads its history as a delta (`?since=`) before the link to its host is
 * back. That delta answered 503 host_reconnecting, about five a restart per open session (218
 * on 2026-11-27). The client now asks with `staleOk=1`, the server answers 200 stale with no
 * rows, and the client keeps its timeline and cursor and catches up through its quick full
 * re-reads: no 503, no banner for a short drop, the newest turn shown once the host is back.
 */
test.describe('a delta while the host reconnects', () => {
  type SocketWindow = Window & { historyTestSocket?: WebSocket }

  test('answers stale instead of a 503, keeps what is shown, and catches up once the host is back', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __staleRetryMs?: number; __staleBannerGraceMs?: number }
      w.__staleRetryMs = 10_000
      delete w.__staleBannerGraceMs
      const NativeWebSocket = window.WebSocket
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          if (new URL(String(url), location.href).pathname === '/ws') (window as SocketWindow).historyTestSocket = this
        }
      }
      for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
        Object.defineProperty(window.WebSocket, key, { value: NativeWebSocket[key] })
      }
    })
    const before = [
      { role: 'user', text: 'Question before the restart', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Answer before the restart', timestamp: '2026-01-01T00:00:01.000Z' },
    ]
    const after = [
      ...before,
      { role: 'user', text: 'Question asked while the link came back', timestamp: '2026-01-01T00:01:00.000Z' },
      { role: 'assistant', text: 'Answer written while the link came back', timestamp: '2026-01-01T00:01:01.000Z' },
    ]
    let down = false
    let hostBack = false
    const deltas: Array<{ staleOk: string | null; answered: number }> = []
    let fivehundreds = 0
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('source') === 'streams') return route.fulfill({ json: { messages: [], total: 0 } })
      const live = hostBack ? after : before
      if (url.searchParams.get('since') !== null) {
        const staleOk = url.searchParams.get('staleOk')
        if (down) {
          // The server's contract (tests/web/routes/sessions-stale-history.test.ts).
          if (staleOk === '1') {
            deltas.push({ staleOk, answered: 200 })
            return route.fulfill({ json: { messages: [], delta: true, stale: true, staleReason: 'Reconnecting to clouddev' } })
          }
          deltas.push({ staleOk, answered: 503 })
          fivehundreds++
          return route.fulfill({ status: 503, json: { error: 'Reconnecting to clouddev', code: 'host_reconnecting' } })
        }
        deltas.push({ staleOk, answered: 200 })
        const since = Number(url.searchParams.get('since'))
        return route.fulfill({ json: { messages: live.slice(since), cursor: live.length, total: live.length, delta: true } })
      }
      if (down) return route.fulfill({ json: { messages: before, total: before.length, stale: true, staleReason: 'Reconnecting to clouddev' } })
      return route.fulfill({ json: { messages: live, cursor: live.length, total: live.length, delta: false } })
    })
    await mockSessionDetail(page)

    await page.goto(`/sessions?id=${SESSION_ID}`)
    const history = page.locator('.session-history')
    const banner = page.locator('.session-history-stale-banner')
    await expect(history).toContainText('Answer before the restart', { timeout: 15_000 })

    // The leader restarted: the link to clouddev is down, and the page's socket reconnects.
    down = true
    await page.waitForFunction(() => (window as SocketWindow).historyTestSocket?.readyState === 1, null, { timeout: 30_000 })
    await page.evaluate(() => {
      (window as SocketWindow).historyTestSocket!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: '_ws:reconnected', data: {} }) }))
    })
    await expect.poll(() => deltas.length, { message: 'the reconnect re-reads as a delta', timeout: 10_000 }).toBeGreaterThan(0)
    expect(deltas[0]).toEqual({ staleOk: '1', answered: 200 })
    // What is shown stays.
    await expect(history).toContainText('Answer before the restart')

    // The link is back two seconds later, with a turn written meanwhile.
    const t0 = Date.now()
    await page.waitForTimeout(2_000)
    hostBack = true
    down = false
    let shown = false
    while (Date.now() - t0 < 12_000) {
      if (await banner.count()) shown = true
      if (await history.textContent().then((t) => t?.includes('Answer written while the link came back'))) break
      await page.waitForTimeout(200)
    }
    await expect(history).toContainText('Answer written while the link came back', { timeout: 1_000 })
    expect(shown, 'a short drop must not show the cached-history banner').toBe(false)
    expect(Date.now() - t0, 'caught up by the quick re-reads, before the 10 s steady retry').toBeLessThan(9_000)
    expect(fivehundreds, 'no delta asked without staleOk').toBe(0)
    // Exactly one copy of each row: the stale delta moved no cursor.
    const text = (await history.textContent()) ?? ''
    for (const row of ['Question before the restart', 'Question asked while the link came back', 'Answer written while the link came back']) {
      expect(text.split(row).length - 1, row).toBe(1)
    }
  })
})
