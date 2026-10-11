/**
 * Playwright browser test: a history answer that brings less than the column
 * already shows never replaces it.
 *
 * Reported (gate review, 2026-10-02): on a slow but live link the first full
 * read answered at its 60s bound "still loading" with 0 messages, and the
 * column cleared what it showed: "Showing cached history ... Reconnecting..."
 * over "No conversation history found", for 10s, until a retry came after the
 * read had finished. The hook now keeps what it shows on such an answer, says
 * the history is still loading, and asks again at once (joining the read), and
 * a stale answer with fewer messages than shown keeps the shown ones under the
 * banner.
 *
 * Against a real browser and the real hook; the history endpoint is mocked so
 * the answers' shapes and timing are exact: Phase 1 (the local stream read)
 * shows two messages, then the full read answers as the server does.
 */
import { test, expect, type Page } from '@playwright/test';

// Each test waits up to 30s for the column, then up to 30s for the history:
// the default 30s test timeout cut a slow (loaded) run in the middle.
test.describe.configure({ timeout: 90_000 });

const OLD = [
  { role: 'user', text: 'Question the column already shows', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', text: 'Answer the column already shows', timestamp: '2026-01-01T00:00:01.000Z' },
];
const FULL = [
  ...OLD,
  { role: 'user', text: 'Question read from the host', timestamp: '2026-01-01T00:01:00.000Z' },
  { role: 'assistant', text: 'Answer read from the host', timestamp: '2026-01-01T00:01:01.000Z' },
];

async function mockSessionDetail(page: Page, sessionId: string, messageCount = 2) {
  await page.route(`**/api/sessions/${sessionId}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: sessionId,
          taskId: `${sessionId}-task`,
          project: 'Walnut',
          host: '__cloudbox__',
          process_status: 'idle',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount,
          title: 'History keeps what it shows',
        },
      },
    });
  });
}

/**
 * Every 250ms until `done`: what the column says, in order, without repeats.
 * `done` judges the same read that was noted, so the last state noted is the
 * one that ended the watch (a second read could see a newer state than the
 * last one noted).
 */
async function watch(page: Page, done: (text: string) => boolean, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const note = (s: string) => { if (seen[seen.length - 1] !== s) seen.push(s); };
  const history = page.locator('.session-history').first();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const text = await history.innerText().catch(() => '');
    const parts = [
      text.includes('Answer the column already shows') ? 'shown' : 'not-shown',
      text.includes('Answer read from the host') ? 'full' : '',
      text.includes('Still loading this conversation from Cloud') ? 'loading-line' : '',
      text.includes('Showing cached history') ? 'stale-banner' : '',
      text.includes('No conversation history found') ? 'EMPTY' : '',
    ].filter(Boolean);
    note(parts.join('+'));
    if (done(text)) break;
    await page.waitForTimeout(250);
  }
  return seen;
}

/** Keep the page's own /ws socket, so a test can deliver a server event on it. */
async function captureWs(page: Page) {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class CapturedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), window.location.href).pathname === '/ws' && !(window as any).__capturedWs) (window as any).__capturedWs = this;
      }
    } as any;
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as any)[key] = (OrigWebSocket as any)[key]; } catch { /* read-only */ }
      }
    }
  });
}

/** A turn ended: the column asks for what came after what it holds (a `?since=` read). */
async function endTurn(page: Page, sessionId: string) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 15_000 });
  await page.evaluate((sid) => {
    const ws = (window as any).__capturedWs as WebSocket;
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: 'session:batch-completed', data: { sessionId: sid, count: 1 }, seq: Date.now() }) }));
  }, sessionId);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __staleRetryMs?: number }).__staleRetryMs = 500;
  });
});

test('a history still loading: the column keeps what it shows, says so, and swaps in the history when it is in', async ({ page }) => {
  const sid = 'pw-history-still-loading';
  let fullAsks = 0;
  await page.route(`**/api/sessions/${sid}/history**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('source') === 'streams') return route.fulfill({ json: { messages: OLD, total: OLD.length } });
    if (url.searchParams.get('since') !== null) return route.fulfill({ json: { messages: [], cursor: FULL.length, delta: true } });
    fullAsks += 1;
    // The server's answer at its bound while the read goes on: stale, empty
    // (nothing cached yet), and `loading`. The third ask finds the read done.
    await new Promise((r) => setTimeout(r, 1_500));
    if (fullAsks <= 2) {
      return route.fulfill({
        json: { messages: [], total: 0, stale: true, staleReason: 'Still loading from Cloud. Try again in a moment.', loading: { from: 'Cloud' } },
      });
    }
    return route.fulfill({ json: { messages: FULL, cursor: FULL.length, delta: false } });
  });
  await mockSessionDetail(page, sid);
  await page.goto(`/sessions?id=${sid}`);
  const history = page.locator('.session-history').first();
  await expect(history).toContainText('Answer the column already shows', { timeout: 30_000 });
  const seen = await watch(page, (text) => text.includes('Answer read from the host'), 30_000);
  // Shown the whole time, the loading line while the read went on, then the history.
  expect(seen).toContain('shown+loading-line');
  expect(seen[seen.length - 1]).toBe('shown+full');
  expect(seen.filter((s) => s.startsWith('not-shown') || s.includes('EMPTY') || s.includes('stale-banner'))).toEqual([]);
  expect(fullAsks).toBe(3);
});

test('a stale answer with fewer messages than shown: what is shown stays, under the banner', async ({ page }) => {
  const sid = 'pw-history-stale-fewer';
  let fullAsks = 0;
  await page.route(`**/api/sessions/${sid}/history**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('source') === 'streams') return route.fulfill({ json: { messages: OLD, total: OLD.length } });
    if (url.searchParams.get('since') !== null) return route.fulfill({ status: 502, json: { error: 'Reconnecting to Cloud' } });
    fullAsks += 1;
    // Nothing cached on the server and the host still connecting: an empty stale answer.
    return route.fulfill({ json: { messages: [], total: 0, stale: true, staleReason: 'Reconnecting to Cloud' } });
  });
  await mockSessionDetail(page, sid);
  await page.goto(`/sessions?id=${sid}`);
  const history = page.locator('.session-history').first();
  await expect(history).toContainText('Answer the column already shows', { timeout: 30_000 });
  await expect(page.locator('.session-history-stale-banner').first()).toBeVisible({ timeout: 15_000 });
  // Several retries come and go (500ms here); none of them takes the history away.
  await expect.poll(() => fullAsks, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await expect(history).toContainText('Answer the column already shows');
  await expect(history).not.toContainText('No conversation history found');
});

test('nothing shown yet and the history still loading: the column says so, never "No conversation history found"', async ({ page }) => {
  const sid = 'pw-history-cold-loading';
  let fullAsks = 0;
  await page.route(`**/api/sessions/${sid}/history**`, async (route) => {
    const url = new URL(route.request().url());
    // The local stream read has nothing for this session: the column starts empty.
    if (url.searchParams.get('source') === 'streams') return route.fulfill({ json: { messages: [], total: 0 } });
    if (url.searchParams.get('since') !== null) return route.fulfill({ json: { messages: [], cursor: FULL.length, delta: true } });
    fullAsks += 1;
    await new Promise((r) => setTimeout(r, 1_500));
    if (fullAsks <= 2) {
      return route.fulfill({
        json: { messages: [], total: 0, stale: true, staleReason: 'Still loading from Cloud. Try again in a moment.', loading: { from: 'Cloud' } },
      });
    }
    return route.fulfill({ json: { messages: FULL, cursor: FULL.length, delta: false } });
  });
  await mockSessionDetail(page, sid);
  await page.goto(`/sessions?id=${sid}`);
  const seen = await watch(page, (text) => text.includes('Answer read from the host'), 30_000);
  // The loading line while the read went on, then the history; the empty state never.
  expect(seen).toContain('not-shown+loading-line');
  expect(seen[seen.length - 1]).toBe('shown+full');
  expect(seen.filter((s) => s.includes('EMPTY') || s.includes('stale-banner'))).toEqual([]);
  expect(fullAsks).toBe(3);
});

test('a turn-end delta cut while the host still sends: the column says it is loading, never the stale banner, and the history swaps in', async ({ page }) => {
  // Gate review (2026-10-03): a `?since=` read cut at the stream cap answered 502
  // "Still loading from Cloud", and the hook put that sentence in the stale
  // banner ("live connection unavailable (Still loading ...)"). The server now
  // adds `loading` to that answer; the hook shows the loading line and joins the
  // full read, which a delta cannot.
  const sid = 'pw-history-delta-loading';
  let fullAsks = 0;
  let deltaAsks = 0;
  await captureWs(page);
  await page.route(`**/api/sessions/${sid}/history**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('source') === 'streams') return route.fulfill({ json: { messages: OLD, total: OLD.length } });
    if (url.searchParams.get('since') !== null) {
      deltaAsks += 1;
      return route.fulfill({ status: 502, json: { error: 'Still loading from Cloud. Try again in a moment.', loading: { from: 'Cloud' } } });
    }
    fullAsks += 1;
    // The first full read is the opening one: what the column shows.
    if (fullAsks === 1) return route.fulfill({ json: { messages: OLD, cursor: OLD.length, delta: false } });
    await new Promise((r) => setTimeout(r, 1_500));
    // The joined full read answers "still loading" once, then has the history.
    if (fullAsks === 2) {
      return route.fulfill({
        json: { messages: [], total: 0, stale: true, staleReason: 'Still loading from Cloud. Try again in a moment.', loading: { from: 'Cloud' } },
      });
    }
    return route.fulfill({ json: { messages: FULL, cursor: FULL.length, delta: false } });
  });
  await mockSessionDetail(page, sid);
  await page.goto(`/sessions?id=${sid}`);
  const history = page.locator('.session-history').first();
  await expect(history).toContainText('Answer the column already shows', { timeout: 30_000 });
  await expect.poll(() => fullAsks, { timeout: 30_000 }).toBe(1);
  await endTurn(page, sid);
  const seen = await watch(page, (text) => text.includes('Answer read from the host'), 30_000);
  // WebKit may resync once more on its own (a second delta, answered the same way).
  expect(deltaAsks).toBeGreaterThanOrEqual(1);
  expect(seen).toContain('shown+loading-line');
  expect(seen[seen.length - 1]).toBe('shown+full');
  expect(seen.filter((s) => s.startsWith('not-shown') || s.includes('EMPTY') || s.includes('stale-banner'))).toEqual([]);
  expect(fullAsks).toBeGreaterThanOrEqual(3);
});

test('an empty column and a turn-end delta cut while the host still sends: the loading line, never "No conversation history found" beside it', async ({ page }) => {
  // The delta path hands over to the full read it joins and clears its own
  // loading flags; only the loading line's own state keeps the empty state away
  // then (gate review 2026-10-03, mutant M22: nothing caught its removal).
  const sid = 'pw-history-delta-loading-empty';
  let fullAsks = 0;
  let deltaAsks = 0;
  await captureWs(page);
  await page.route(`**/api/sessions/${sid}/history**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('source') === 'streams') return route.fulfill({ json: { messages: [], total: 0 } });
    if (url.searchParams.get('since') !== null) {
      deltaAsks += 1;
      return route.fulfill({ status: 502, json: { error: 'Still loading from Cloud. Try again in a moment.', loading: { from: 'Cloud' } } });
    }
    fullAsks += 1;
    // A session with no history yet: the column is empty, and says so.
    if (fullAsks === 1) return route.fulfill({ json: { messages: [], cursor: 0, delta: false } });
    await new Promise((r) => setTimeout(r, 1_500));
    if (fullAsks === 2) {
      return route.fulfill({
        json: { messages: [], total: 0, stale: true, staleReason: 'Still loading from Cloud. Try again in a moment.', loading: { from: 'Cloud' } },
      });
    }
    return route.fulfill({ json: { messages: FULL, cursor: FULL.length, delta: false } });
  });
  await mockSessionDetail(page, sid, 0);
  await page.goto(`/sessions?id=${sid}`);
  const history = page.locator('.session-history').first();
  await expect(history).toContainText('No conversation history found', { timeout: 30_000 });
  await expect.poll(() => fullAsks, { timeout: 30_000 }).toBe(1);
  await endTurn(page, sid);
  const seen = await watch(page, (text) => text.includes('Answer read from the host'), 30_000);
  expect(deltaAsks).toBeGreaterThanOrEqual(1);
  expect(seen).toContain('not-shown+loading-line');
  expect(seen[seen.length - 1]).toBe('shown+full');
  expect(seen.filter((s) => (s.includes('loading-line') && s.includes('EMPTY')) || s.includes('stale-banner'))).toEqual([]);
});
