/**
 * Playwright browser test: Streaming blocks must NEVER vanish across a turn boundary.
 *
 * Reproduces the exact reported bug:
 *   "The session is generating — it shows blocks 1,2,3,4, then when block 5
 *    generates all of 1-4 disappear, flash back after ~1s, then vanish again."
 *
 * Root cause (fixed): when a turn completed, `batch-completed` triggered a history
 * refetch. The old turn-boundary cleanup cleared streaming blocks by POSITION
 * (blind `slice`/`clear`) the moment the refetch fired — or via a 5s fallback timer
 * when the refetch was slow (7-9s for a large JSONL). That blind clear wiped the
 * NEXT turn's blocks that had already started streaming (the "vanish"), and the
 * flash-back was the server snapshot briefly restoring them before the next clear.
 *
 * The fix (single-timeline model, stream/render-filter.ts): blocks are
 * APPEND-ONLY — nothing is deleted at turn boundaries. A block is HIDDEN at
 * render time only when history proves a twin (tool_call→toolUseId,
 * text→msgId/content, lane→bgTaskFinished). No twin (archive lagging /
 * broken) → the block keeps rendering. The guaranteed failure mode is "shown
 * twice for a moment", NEVER "vanishes".
 *
 * These tests assert that guarantee against a REAL browser + the real React
 * components — the delta history API, the useSessionStream hook, and the
 * SessionChatHistory turn-boundary effect all in the loop.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-normal-session';

// ── Helpers ──

/** Inject a fake WS event by dispatching a MessageEvent on the captured WebSocket. */
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

/** Mock the session-detail endpoint so the session renders as a running session. */
async function mockSessionDetail(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-001',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 2,
          title: 'Vanish repro session',
        },
      },
    });
  });
}

// ── Setup: patch WebSocket before the page loads (capture + auto-respond RPCs) ──

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (!(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const origSend = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            let intercepted = false;
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                intercepted = true;
                // Empty snapshot — the test drives all streaming via injectEvent.
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, data: { blocks: [], isStreaming: false } }),
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

// ── Tests ──

test.describe('Streaming blocks survive turn boundaries (evidence-based promotion)', () => {
  test('a next turn streaming before the archive catches up does NOT vanish; completed turn promotes cleanly once it does', async ({ page }) => {
    const base = [
      { role: 'user', text: 'Kick off the long task', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'On it.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    // What the archive will EVENTUALLY hold for turn 1 (the promotion evidence).
    const turn1Persisted = [
      { role: 'assistant', text: 'Step 1 done.', timestamp: '2026-01-01T00:00:05.000Z',
        tools: [{ name: 'Bash', toolUseId: 'toolu_vanish_1', input: { command: 'echo hi' } }] },
      { role: 'assistant', text: 'Step 2 done.', timestamp: '2026-01-01T00:00:06.000Z' },
    ];

    // archiveCaughtUp is a Node-side closure the test flips to simulate the archive
    // finally flushing turn 1 to JSONL. While false, every delta fetch is EMPTY
    // (turn not flushed) — the exact "archive lagging" condition that used to
    // trigger the blind clear.
    let archiveCaughtUp = false;
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const source = url.searchParams.get('source');
      const since = url.searchParams.get('since');
      if (source === 'streams') {
        return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
      }
      if (since !== null) {
        const n = parseInt(since, 10);
        if (archiveCaughtUp) {
          return route.fulfill({ json: { messages: turn1Persisted, cursor: base.length + turn1Persisted.length, delta: true } });
        }
        return route.fulfill({ json: { messages: [], cursor: n, delta: true } }); // lagging
      }
      // Phase 2 full (no source, no since)
      return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    // ── Turn 1 streams: text → tool → text (three distinct blocks) ──
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Step 1 done.' });
    await page.waitForTimeout(80);
    await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'toolu_vanish_1', input: { command: 'echo hi' } });
    await page.waitForTimeout(50);
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'toolu_vanish_1', result: 'hi' });
    await page.waitForTimeout(50);
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Step 2 done.' });
    await page.waitForTimeout(80);

    // All three turn-1 blocks visible during streaming
    const history = page.locator('.session-history');
    await expect(history).toContainText('Step 1 done.');
    await expect(history).toContainText('Step 2 done.');

    // ── Turn 1 ends ──
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
    await page.waitForTimeout(80);

    // ── Turn 2 STARTS streaming BEFORE the archive flushed turn 1 (the bug trigger) ──
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Message 5 is generating' });
    await page.waitForTimeout(80);

    // Turn-boundary bookkeeping fires while the archive is still lagging (empty delta).
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });

    // ── THE CRITICAL ANTI-VANISH ASSERTION ──
    // Poll continuously across ~6s (covers the 5s fallback timer). At NO point may
    // any block disappear. Old code: 1-4 vanish here (blind clear on empty delta /
    // slice), flash back on snapshot, vanish again. Fixed code: all stay.
    for (let i = 0; i < 12; i++) {
      const txt = (await history.textContent()) ?? '';
      expect(txt, `iteration ${i} lost "Step 1 done."`).toContain('Step 1 done.');
      expect(txt, `iteration ${i} lost "Step 2 done."`).toContain('Step 2 done.');
      expect(txt, `iteration ${i} lost live turn "Message 5"`).toContain('Message 5 is generating');
      await page.waitForTimeout(500);
    }

    // ── Archive catches up → turn 1 promoted into persisted history, turn 2 kept ──
    archiveCaughtUp = true;
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
    await page.waitForTimeout(1500);

    const finalTxt = (await history.textContent()) ?? '';
    // Nothing lost
    expect(finalTxt).toContain('Step 1 done.');
    expect(finalTxt).toContain('Step 2 done.');
    expect(finalTxt).toContain('Message 5 is generating');
    // No duplication — the completed turn now lives ONCE (in persisted history),
    // removed from the streaming panel because its twin was proven present.
    expect((finalTxt.match(/Step 1 done\./g) || []).length, 'Step 1 must appear exactly once').toBe(1);
    expect((finalTxt.match(/Step 2 done\./g) || []).length, 'Step 2 must appear exactly once').toBe(1);

    // The completed turn now renders as persisted history (SessionMessage), and the
    // live turn 2 block is the only thing left in the streaming panel.
    const streamingPanel = page.locator('.session-streaming-panel');
    await expect(streamingPanel).toContainText('Message 5 is generating');
    await expect(streamingPanel).not.toContainText('Step 1 done.');
  });

  test('a completed block WITHOUT a twin in the arrived delta is KEPT, not deleted (broken/incomplete archive)', async ({ page }) => {
    // Edge case the user insisted on: turn-end does NOT guarantee the archive is
    // flushed correctly. Network glitch / process stuck / parser bug can produce a
    // delta that is MISSING the block's twin (or has different content). Destruction
    // must be conditioned on the twin arriving — never on timing. If the archive is
    // broken, the streaming block must survive (worst case: shown twice), and a
    // warning must be logged so a persistent divergence is visible.
    const base = [
      { role: 'user', text: 'Do the important thing', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Working.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    // Broken/incomplete archive: the delta arrives but does NOT contain the
    // streaming block's content (simulates a lost/mangled JSONL line).
    const brokenDelta = [
      { role: 'assistant', text: 'unrelated placeholder that is not the streamed block', timestamp: '2026-01-01T00:00:07.000Z' },
    ];

    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const source = url.searchParams.get('source');
      const since = url.searchParams.get('since');
      if (source === 'streams') {
        return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
      }
      if (since !== null) {
        return route.fulfill({ json: { messages: brokenDelta, cursor: base.length + brokenDelta.length, delta: true } });
      }
      return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
    });
    await mockSessionDetail(page);

    // Capture console warnings — the fix must log when it keeps an unmatched block.
    const warnings: string[] = [];
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text()); });

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    // Stream one distinctive block, then end the turn.
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'IMPORTANT RESULT A that the archive will drop' });
    await page.waitForTimeout(80);
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
    await page.waitForTimeout(80);

    // Turn boundary — the delta that arrives is BROKEN (missing the twin).
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
    await page.waitForTimeout(1500);

    const history = page.locator('.session-history');
    const txt = (await history.textContent()) ?? '';
    // The streamed block MUST survive despite the delta arriving without its twin.
    expect(txt, 'unmatched streaming block must be KEPT, never deleted').toContain('IMPORTANT RESULT A that the archive will drop');

    // A divergence warning must have been surfaced (kept, not deleted).
    // Matches the render-filter tripwire in SessionChatHistory ("render-filter:
    // N completed block(s) had no delta twin — kept, not deleted").
    const hadWarning = warnings.some((w) => /no delta twin/i.test(w));
    expect(hadWarning, `expected a "no delta twin — kept" warning; saw: ${warnings.slice(0, 8).join(' | ')}`).toBe(true);
  });
});
