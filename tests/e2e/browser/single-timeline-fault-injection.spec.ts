/**
 * Playwright fault-injection tests for the SINGLE-TIMELINE model
 * (non-destructive absorption: streaming blocks are append-only; history
 * absorption HIDES blocks at render time; nothing is deleted at turn
 * boundaries).
 *
 * Each test injects a production-observed failure ordering and asserts the
 * two invariants the refactor guarantees:
 *   1. NEVER VANISH — content the user watched generate stays visible until
 *      its persisted twin renders.
 *   2. NO STEADY-STATE DUPLICATION — once history absorbs a block, exactly one
 *      copy renders.
 *
 * Faults covered:
 *   A. batch-completed arrives BEFORE session:result (the ~20-50ms bus race —
 *      session-runner subscribes before main-ai, so the batch event outruns
 *      the enriched result re-emit).
 *   B. history refetch held for seconds (slow SSH / whale JSONL) while the
 *      turn ends — blocks must keep rendering the whole wait, then collapse.
 *   C. /compact rewrites history mid-session (message count SHRINKS while
 *      cursor stays valid) — no pinned-at-bottom bubbles, no crash, correct
 *      final content (inc-1783472776601 family).
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-fault-injection';

// ── Helpers (same harness as streaming-block-vanish.spec.ts) ──

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
          taskId: 'pw-task-fault',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 2,
          title: 'Fault injection session',
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

const base = [
  { role: 'user', text: 'Run the check', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', text: 'Starting.', timestamp: '2026-01-01T00:00:01.000Z' },
];

test.describe('Single-timeline fault injection', () => {
  test('FAULT A: batch-completed 50ms BEFORE session:result — no vanish, no steady-state duplication', async ({ page }) => {
    const streamedText = 'The verification finished successfully with 12 checks.';
    let turnFlushed = false;

    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const since = url.searchParams.get('since');
      if (!turnFlushed) {
        // Archive not flushed yet at the time the raced batch-completed fetches.
        if (since !== null) return route.fulfill({ json: { messages: [], cursor: base.length, delta: true } });
        return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
      }
      const full = [...base, { role: 'assistant', text: streamedText, msgId: 'msg-race-1', timestamp: '2026-01-01T00:00:09.000Z' }];
      if (since !== null) {
        const n = Number(since);
        return route.fulfill({ json: { messages: full.slice(n), cursor: full.length, delta: true } });
      }
      return route.fulfill({ json: { messages: full, cursor: full.length, delta: false } });
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });
    const history = page.locator('.session-history');

    // Stream the turn's text (msgId threading like the real provider).
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: streamedText, msgId: 'msg-race-1' });
    await expect(history).toContainText('12 checks');

    // THE RACE: batch-completed lands FIRST (archive still empty)…
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
    // …result lands ~50ms later.
    await page.waitForTimeout(50);
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });

    // Mid-race: the streamed text must still be visible (nothing was deleted).
    await expect(history).toContainText('12 checks');

    // Archive flushes; the next turn-boundary refresh delivers the twin.
    turnFlushed = true;
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });

    // Steady state: exactly ONE copy (persisted), streaming copy hidden.
    await expect.poll(async () => {
      const txt = (await history.textContent()) ?? '';
      return (txt.match(/12 checks/g) || []).length;
    }, { timeout: 8000 }).toBe(1);
    await expect(history).toContainText('12 checks'); // and it's the persisted one — still visible
  });

  test('FAULT B: history refetch held for seconds after turn end — blocks keep rendering, then collapse to one copy', async ({ page }) => {
    const streamedText = 'Slow-archive answer: the deployment completed.';
    let releaseHold: (() => void) | null = null;
    const hold = new Promise<void>((r) => { releaseHold = r; });
    let held = false;

    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const since = url.searchParams.get('since');
      if (since !== null && !held) {
        // First post-turn delta fetch: HOLD it (simulates 10s SSH fetch; shortened).
        held = true;
        await hold;
        const full = [...base, { role: 'assistant', text: streamedText, msgId: 'msg-slow-1', timestamp: '2026-01-01T00:00:09.000Z' }];
        return route.fulfill({ json: { messages: full.slice(Number(since)), cursor: full.length, delta: true } });
      }
      if (since !== null) {
        const full = [...base, { role: 'assistant', text: streamedText, msgId: 'msg-slow-1', timestamp: '2026-01-01T00:00:09.000Z' }];
        return route.fulfill({ json: { messages: full.slice(Number(since)), cursor: full.length, delta: true } });
      }
      return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });
    const history = page.locator('.session-history');

    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: streamedText, msgId: 'msg-slow-1' });
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });

    // While the refetch hangs (6s sampled — PAST the old 5s fallback timer, so
    // a revert's blind-clear actually fires inside the window), the streamed
    // content must remain visible the WHOLE time.
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1000);
      const txt = (await history.textContent()) ?? '';
      expect(txt, `streamed text vanished during the ${i + 1}s wait`).toContain('deployment completed');
    }

    // Release the archive → twin arrives → collapses to exactly one copy.
    releaseHold!();
    await expect.poll(async () => {
      const txt = (await history.textContent()) ?? '';
      return (txt.match(/deployment completed/g) || []).length;
    }, { timeout: 8000 }).toBe(1);
  });

  test('FAULT C: /compact rewrites history mid-session (count shrinks) — no crash, content correct, no pinned leftovers', async ({ page }) => {
    // Long pre-compact history (10 messages) → compact rewrites to 3.
    const longHistory = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `Pre-compact message ${i}`,
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    }));
    const compacted = [
      { role: 'assistant', text: 'Summary of the earlier conversation.', timestamp: '2026-01-01T00:01:00.000Z' },
      { role: 'user', text: 'Continue please', timestamp: '2026-01-01T00:01:01.000Z' },
      { role: 'assistant', text: 'Post-compact answer content.', msgId: 'msg-pc-1', timestamp: '2026-01-01T00:01:02.000Z' },
    ];
    let compactedNow = false;

    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const since = url.searchParams.get('since');
      const current = compactedNow ? compacted : longHistory;
      if (since !== null) {
        const n = Number(since);
        if (n > current.length) {
          // since out of range after shrink → server falls back to full payload
          return route.fulfill({ json: { messages: current, cursor: current.length, delta: false } });
        }
        return route.fulfill({ json: { messages: current.slice(n), cursor: current.length, delta: true } });
      }
      return route.fulfill({ json: { messages: current, cursor: current.length, delta: false } });
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });
    const history = page.locator('.session-history');
    await expect(history).toContainText('Pre-compact message 9');

    // Compact happens server-side; the CLI emits a system event, then the next
    // turn streams and ends. History is now REWRITTEN (10 → 3 messages).
    compactedNow = true;
    await injectEvent(page, 'session:system-event', { sessionId: SESSION_ID, variant: 'compact', message: 'Context compacted' });
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Post-compact answer content.', msgId: 'msg-pc-1' });
    await expect(history).toContainText('Post-compact answer content.');
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });

    // Post-compact steady state: rewritten history renders; the streamed copy
    // of the post-compact answer collapses to one (id match is shrink-immune).
    await expect.poll(async () => {
      const txt = (await history.textContent()) ?? '';
      return (txt.match(/Post-compact answer content\./g) || []).length;
    }, { timeout: 8000 }).toBe(1);
    await expect(history).toContainText('Summary of the earlier conversation.');

    // Order sanity: the post-compact answer must render BELOW the summary
    // (pinned-at-bottom-out-of-order was the inc-1783472776601 symptom).
    const txt = (await history.textContent()) ?? '';
    expect(txt.indexOf('Summary of the earlier conversation.'))
      .toBeLessThan(txt.indexOf('Post-compact answer content.'));
  });
});
