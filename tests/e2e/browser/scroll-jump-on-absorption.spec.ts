/**
 * Scroll teleport on turn-end absorption (inc-1786553756848).
 *
 * Reproduces: user scrolls UP to read older history while a turn is live
 * (many streaming blocks rendered). The turn ends and the batch lands —
 * streaming blocks get absorbed into persisted history, but history renders
 * only the truncated tail (INITIAL_RENDER_LIMIT=30), so the container's
 * scrollHeight collapses by thousands of px in one frame. The browser clamps
 * scrollTop to the new max — the user is teleported toward the very top
 * (production log: top 7106→1331 within 1s, sh 7948→2214).
 *
 * Auto-scroll only protects the at-bottom case; a reader who scrolled up
 * (isAtBottom=false) has no protection. This spec pins the CURRENT (buggy)
 * geometry collapse as a reproduction and documents the invariant a fix must
 * satisfy: the row the reader was looking at stays in the viewport across the
 * absorption swap.
 *
 * Harness: same client-side WS patch + route mocks as
 * single-timeline-fault-injection.spec.ts (no daemon, no real CLI).
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-scroll-absorption';

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
          taskId: 'pw-task-scroll',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 2,
          title: 'Scroll absorption probe',
        },
      },
    });
  });
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

// 60 persisted rows (> INITIAL_RENDER_LIMIT=30 so the truncation window is
// real) + 120 streamed paragraphs (tall enough that absorption collapses the
// container by thousands of px, like the production whale turn).
const base = Array.from({ length: 60 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  text: `history row ${i} — ${'lorem ipsum dolor sit amet '.repeat(6)}`,
  msgId: `base-${i}`,
  timestamp: new Date(1700000000000 + i * 1000).toISOString(),
}));
const STREAM_COUNT = 120;
const streamed = Array.from({ length: STREAM_COUNT }, (_, i) => ({
  role: 'assistant',
  text: `streamed paragraph ${i} — ${'analysis output line with plenty of words to take vertical space. '.repeat(4)}`,
  msgId: `turn-${i}`,
  timestamp: new Date(1700001000000 + i * 1000).toISOString(),
}));

interface Geom { top: number; sh: number; ch: number }
const geom = (page: Page): Promise<Geom> => page.evaluate(() => {
  const el = document.querySelector('.session-history') as HTMLElement;
  return { top: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight), ch: Math.round(el.clientHeight) };
});

/** First row whose bottom edge is inside the viewport = what the reader sees. */
const viewportAnchor = (page: Page): Promise<string | null> => page.evaluate(() => {
  const el = document.querySelector('.session-history') as HTMLElement;
  const rows = el.querySelectorAll('[data-msg-index], .session-msg, .session-msg-bare');
  const cRect = el.getBoundingClientRect();
  for (const r of rows) {
    const rect = r.getBoundingClientRect();
    if (rect.bottom > cRect.top + 10) return (r.textContent ?? '').slice(0, 60);
  }
  return null;
});

test.describe('Scroll teleport on turn-end absorption', () => {
  test('reader scrolled up mid-turn survives the absorption collapse without a jump to top', async ({ page }) => {
    // FIXED 2026-08-13 (inc-1786553756848): the reading-mode render-window
    // pin (readingPinStart in SessionChatHistory) freezes the truncation
    // window start while the user is scrolled up, so the absorption swap can
    // no longer slide the reader's rows out and collapse scrollHeight. This
    // spec now pins the fix: geometry must stay stable and the reader's
    // viewport anchor row must survive the turn-end absorption.
    let flushed = false;
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const since = url.searchParams.get('since');
      const full = flushed ? [...base, ...streamed] : base;
      if (since !== null) {
        const n = Number(since);
        return route.fulfill({ json: { messages: full.slice(n), cursor: full.length, delta: true, total: full.length } });
      }
      return route.fulfill({ json: { messages: full, cursor: full.length, delta: false, total: full.length } });
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForSelector('.session-history .session-msg, .session-history .session-msg-bare', { timeout: 15000 });
    await waitForWs(page);
    await page.waitForTimeout(500);

    // ── Turn streams 120 paragraphs ──
    for (let i = 0; i < STREAM_COUNT; i++) {
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: streamed[i].text, msgId: `turn-${i}` });
    }
    // Let the 150ms text flusher drain and layout settle.
    await expect.poll(async () => (await geom(page)).sh, { timeout: 8000 }).toBeGreaterThan(6000);

    // ── Reader scrolls UP into older content (real wheel events, mid-turn) ──
    // Stop MID-container, not at the very top: the production teleport is the
    // browser CLAMPING a mid-range scrollTop (7106) to the collapsed max
    // (1331). At top=0 the collapse happens below the reader and no clamp
    // occurs — that variant doesn't reproduce the jump.
    const box = (await page.locator('.session-history').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(40);
      const g = await geom(page);
      if (g.top <= (g.sh - g.ch) / 2) break; // reached mid-range — stop here
    }
    const before = await geom(page);
    const beforeAnchor = await viewportAnchor(page);
    // Preconditions for the bug: far from bottom AND far from top (clampable).
    expect(before.sh - before.top - before.ch).toBeGreaterThan(1000);
    expect(before.top).toBeGreaterThan(2000);
    expect(beforeAnchor).toBeTruthy();

    // ── THE ABSORPTION: turn ends, archive flushes, delta absorbs the blocks ──
    // Pre-fix this collapsed scrollHeight by thousands of px (streamed blocks
    // hidden, history rendering only the 30-row tail) and clamped the reader
    // toward the top. The window pin keeps the reader's rows rendered, so
    // geometry stays stable — assert stability over a settle window instead
    // of waiting for a collapse that must no longer happen.
    flushed = true;
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });

    // Absorption is proven when the streamed paragraphs exist as PERSISTED
    // rows: the delta lands, messages grow past base(60), and with the pinned
    // window they render below the reader. Detect via the earlier-button
    // hidden-count staying while total DOM rows grow — simplest robust probe:
    // wait until row count exceeds what the tail window alone (30) could hold.
    await expect.poll(async () => page.evaluate(() => {
      const el = document.querySelector('.session-history') as HTMLElement;
      return el.querySelectorAll('[data-msg-index]').length;
    }), { timeout: 10000 }).toBeGreaterThan(40);
    // Then hold 1.5s so any late collapse (delayed reset/GC) would surface.
    await page.waitForTimeout(1500);

    const after = await geom(page);
    const afterAnchor = await viewportAnchor(page);

    // ── THE INVARIANTS (the fix) ──
    // 1. No teleport: the reader was mid-container; they must stay there.
    expect(after.top, `teleported: top ${before.top}→${after.top} (sh ${before.sh}→${after.sh})`).toBeGreaterThan(1000);
    // 2. No collapse under the reader: height may grow (rows appended below)
    //    but must not shrink out from under a scrolled-up reader.
    expect(after.sh, `scrollHeight collapsed ${before.sh}→${after.sh}`).toBeGreaterThan(before.sh - 300);
    // 3. The row the reader was looking at is still the first visible row.
    expect(afterAnchor, `reader was looking at "${beforeAnchor}" (top=${before.top}/${before.sh}); after absorption the viewport shows "${afterAnchor}" (top=${after.top}/${after.sh})`)
      .toBe(beforeAnchor);
  });
});
