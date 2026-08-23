/**
 * `<suggest>` action cards in the SESSION timeline.
 *
 * A session's own answer can carry a card. Before this, only the Personal AI chat
 * rendered them, so a card written by a session degraded into loose prose ("Put to
 * Focus Ignore") — silently wrong rather than visibly broken.
 *
 * Three things can only be proven in a browser, and each one is a distinct
 * failure mode:
 *
 *  1. STREAMING — the card must not render half-open. Text arrives as growing
 *     deltas, so between `<suggest …>` and `</suggest>` the parser hides the
 *     block; a card that rendered early would show a live button over an
 *     unfinished suggestion.
 *  2. THE ABSORPTION HANDOFF — the streaming block is replaced by the persisted
 *     history row at turn end. Both render the SAME card, and the receipt has to
 *     survive that swap: it does only because both sides key the card on the
 *     message's `msgId`, which rides the deltas and the stored row alike.
 *  3. RELOAD — the receipt lives in localStorage under the card id, so a reload
 *     must re-derive the same id from the stored text + the same `msgId`.
 *
 * Harness: the client-side WS patch + route mocks from
 * scroll-jump-on-absorption.spec.ts — no daemon, no real CLI, and the invoke
 * endpoint is mocked so no op ever runs.
 */
import { test, expect, type Page } from '@playwright/test';

/** Kept for review — the reviewer looks at these, so never write them to a tmp
 *  dir the suite cleans. */
const SHOTS = '/tmp/action-cards-time';

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

async function mockSessionDetail(page: Page, sessionId: string) {
  await page.route(`**/api/sessions/${sessionId}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: sessionId,
          taskId: `pw-task-${sessionId}`,
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 2,
          title: 'Suggest card probe',
        },
      },
    });
  });
}

/** Two persisted rows so the timeline has real content before the turn starts. */
const base = [
  { role: 'user', text: 'Triage the stale tasks for me.', msgId: 'base-0', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', text: 'Looking now.', msgId: 'base-1', timestamp: '2026-01-01T00:00:01.000Z' },
];

// The answer, split exactly where a real stream would land it: the closer is the
// LAST thing to arrive, which is what makes the half-open case reachable.
const OPEN = [
  'That task has not moved in three weeks.',
  '',
  '<suggest title="Triage this">',
  'It looks stale — put it in Focus?',
  '<action tool="task_focus_tier_set" args=\'{"id":"t_1","tier":"focus"}\' label="Put to Focus" style="primary"/>',
  '<action dismiss label="Leave it"/>',
].join('\n');
const CLOSE = '\n</suggest>\n\nTell me if you want the other two as well.';
const FULL = OPEN + CLOSE;

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

test.describe('session timeline — <suggest> action cards', () => {
  test('hides the card until its closer lands, then renders it clickable', async ({ page }) => {
    const sid = 'pw-suggest-stream';
    await page.route(`**/api/sessions/${sid}/history**`, async (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      if (since !== null) return route.fulfill({ json: { messages: [], cursor: base.length, delta: true, total: base.length } });
      return route.fulfill({ json: { messages: base, cursor: base.length, delta: false, total: base.length } });
    });
    await mockSessionDetail(page, sid);

    await page.goto(`/sessions?id=${sid}`);
    await page.waitForSelector('.session-history .session-msg, .session-history .session-msg-bare', { timeout: 15000 });
    await waitForWs(page);

    // ── Half-open: everything but the closer ──
    await injectEvent(page, 'session:text-delta', { sessionId: sid, delta: OPEN, msgId: 'turn-card' });
    // The prose BEFORE the card is what proves the deltas landed at all — the
    // rest of the message is deliberately withheld from the DOM.
    await expect(page.locator('.session-history')).toContainText('has not moved in three weeks', { timeout: 10000 });
    await page.waitForTimeout(600); // past the 150ms text flusher, twice over

    expect(await page.locator('.sug-card').count(), 'a card rendered before its closing tag arrived').toBe(0);
    const halfOpen = (await page.locator('.session-history').innerText());
    await page.screenshot({ path: `${SHOTS}/session-card-half-open.png`, fullPage: false });
    // Nothing from inside the open card may reach the DOM — not the action label,
    // not the raw markup, and not the BODY. The body is the one that actually
    // leaked: DOMPurify drops the unknown tags but keeps the text between them,
    // so the raw-string render path showed the body as a stray prose line that
    // then vanished when the closer landed. Only the segments path honours the
    // parser's hiding (see needsSegments in components/chat/SuggestSegments.tsx).
    expect(halfOpen, 'the card body leaked as prose while the card was still open').not.toContain('It looks stale');
    expect(halfOpen, 'the action label leaked as prose').not.toContain('Put to Focus');
    expect(halfOpen, 'raw card markup leaked into the timeline').not.toContain('<suggest');
    expect(halfOpen).not.toContain('<action');
    // The prose BEFORE the card is unaffected — hiding starts at the open tag.
    expect(halfOpen).toContain('has not moved in three weeks');

    // ── The closer lands ──
    await injectEvent(page, 'session:text-delta', { sessionId: sid, delta: CLOSE, msgId: 'turn-card' });

    const card = page.locator('.sug-card').first();
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.locator('.sug-card-title')).toHaveText('Triage this');
    await expect(card.locator('.sug-card-body')).toContainText('It looks stale');
    await expect(card.getByRole('button', { name: 'Put to Focus' })).toBeEnabled();
    await expect(card.getByRole('button', { name: 'Leave it' })).toBeEnabled();
    // The op name rides the card face, not just a tooltip.
    await expect(card.locator('.sug-tool')).toHaveText('task_focus_tier_set');
    // The tail after the card still renders — hiding must have ended at the closer.
    await expect(page.locator('.session-history')).toContainText('the other two as well');
    await page.screenshot({ path: `${SHOTS}/session-card-rendered.png`, fullPage: false });
  });

  test('a click survives the turn-end absorption and a reload', async ({ page }) => {
    const sid = 'pw-suggest-receipt';
    // Same msgId on the streaming deltas and on the persisted row — that is the
    // card's receipt scope, and the whole point of this case.
    const MSG_ID = 'turn-receipt-1';
    const persisted = {
      role: 'assistant', text: FULL, msgId: MSG_ID, timestamp: '2026-01-01T00:00:02.000Z',
    };

    let flushed = false;
    await page.route(`**/api/sessions/${sid}/history**`, async (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      const full = flushed ? [...base, persisted] : base;
      if (since !== null) {
        const n = Number(since);
        return route.fulfill({ json: { messages: full.slice(n), cursor: full.length, delta: true, total: full.length } });
      }
      return route.fulfill({ json: { messages: full, cursor: full.length, delta: false, total: full.length } });
    });
    await mockSessionDetail(page, sid);

    // No op ever runs: the click's authorization is real, the execution is mocked.
    let invokes = 0;
    await page.route('**/api/v1/actions/invoke', async (route) => {
      invokes++;
      const body = JSON.parse(route.request().postData() ?? '{}');
      expect(body.tool).toBe('task_focus_tier_set');
      expect(body.args).toEqual({ id: 't_1', tier: 'focus' });
      await route.fulfill({ json: { ok: true, tool: body.tool, result: { ok: true } } });
    });

    await page.goto(`/sessions?id=${sid}`);
    await page.waitForSelector('.session-history .session-msg, .session-history .session-msg-bare', { timeout: 15000 });
    await waitForWs(page);

    await injectEvent(page, 'session:text-delta', { sessionId: sid, delta: FULL, msgId: MSG_ID });
    const card = page.locator('.sug-card').first();
    await expect(card).toBeVisible({ timeout: 10000 });

    // ── The click ──
    await card.getByRole('button', { name: 'Put to Focus' }).click();
    await expect(page.locator('.sug-receipt-done').first()).toContainText('Put to Focus', { timeout: 10000 });
    expect(invokes).toBe(1);
    await page.screenshot({ path: `${SHOTS}/session-card-clicked.png`, fullPage: false });

    // ── Turn ends: the persisted row replaces the streaming block ──
    flushed = true;
    await injectEvent(page, 'session:result', { sessionId: sid, result: 'done', isError: false });
    await injectEvent(page, 'session:batch-completed', { sessionId: sid, count: 1 });

    // Absorption is settled when exactly ONE card is left (the history twin hid
    // the streaming block). A receipt that did not carry over would show up here
    // as a freshly armed button over an op that already ran.
    await expect.poll(() => page.locator('.sug-card').count(), { timeout: 10000 }).toBe(1);
    await page.waitForTimeout(1000); // let any late reset / GC surface
    await expect(page.locator('.sug-receipt-done').first()).toContainText('Put to Focus');
    expect(await page.getByRole('button', { name: 'Put to Focus' }).count(), 're-armed after absorption').toBe(0);
    await page.screenshot({ path: `${SHOTS}/session-card-after-absorption.png`, fullPage: false });

    // ── Reload: the id is re-derived from the stored text + the same msgId ──
    await page.reload();
    await page.waitForSelector('.session-history .session-msg, .session-history .session-msg-bare', { timeout: 15000 });
    await expect(page.locator('.sug-receipt-done').first()).toContainText('Put to Focus', { timeout: 15000 });
    expect(await page.getByRole('button', { name: 'Put to Focus' }).count(), 're-armed after reload').toBe(0);
    await page.screenshot({ path: `${SHOTS}/session-card-after-reload.png`, fullPage: false });
    // Still exactly one invoke: nothing re-fired on the reload path.
    expect(invokes).toBe(1);
  });
});
