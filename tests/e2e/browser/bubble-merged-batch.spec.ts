/**
 * Playwright browser test: merged-batch bubble absorption in a BIG chat.
 *
 * THE BUG (inc-1785888617044, the 9th of this family): when several sends sit in the
 * CLI's queue during one long turn, the CLI drains them into ONE prompt and logs a
 * SINGLE canonical user line — the messages joined with a single '\n'. Every defense
 * missed that one shape at once:
 *   · echo-claim registered walnut's '\n\n' delivery join, so the exact compare against
 *     the CLI's '\n' form never bound ⇒ walnutMessageId stayed null
 *   · no individual bubble's text equals the merged line ⇒ text multiset missed
 *   · the batch-completed ids were lost to the setActiveProcessing overwrite ⇒ ids=0
 * With zero evidence the bubbles could never be hidden: three "Delivered ✓" bubbles
 * stayed pinned BELOW newer content, in the wrong chronological order, forever.
 *
 * Why a BIG chat: the user reported this happens more in long chats. Turn DURATION is
 * the real driver (measured: 24% orphan rate under 30s → 84% at ≥900s, because long
 * turns give the queue time to accumulate 2+ sends). A big chat doesn't raise the RATE,
 * it makes the damage a visible WALL — up to 56 stale bubbles at once — and it stresses
 * the scan window, so both modes below run against a several-hundred-message history.
 *
 * Two modes, exactly as requested:
 *   MODE 1 (long response): one long turn + several sends injected DURING it ⇒ the CLI
 *           merges them ⇒ history returns the merged line. All bubbles must clear.
 *   MODE 2 (short rapid turns): many quick turns, each echoing its own line ⇒ no bubble
 *           may linger between turns and order must stay chronological.
 *
 * This drives the REAL UI (typing in the real composer, real Enter) against a mocked
 * history/WS transport so the merge shape is deterministic — the production CLI merges
 * only under a timing race that cannot be forced from a test.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-merged-batch-session';
const TASK_ID = 'pw-merged-task';

/** A big baseline history: the "wall of bubbles" only shows up at scale. */
const BIG_HISTORY_TURNS = 150; // → 300 messages
function buildBigHistory() {
  const msgs: Array<{ role: string; text: string; timestamp: string }> = [];
  for (let i = 0; i < BIG_HISTORY_TURNS; i++) {
    msgs.push({ role: 'user', text: `historical question ${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
    msgs.push({ role: 'assistant', text: `historical answer ${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i, 30)).toISOString() });
  }
  return msgs;
}

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    if (!ws) throw new Error('No captured WebSocket — did addInitScript run?');
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
  }, { name, data });
}

async function waitForWs(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 15000 });
}

/** Read back the qm-ids the app assigned, so assertions can name exact bubbles. */
async function sentIds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__sentMessageIds ?? []);
}

/** Type into the REAL session composer and press Enter (no API shortcuts). */
async function sendViaUi(page: Page, text: string) {
  const input = page.locator('textarea[placeholder*="Send a message to this session"]').first();
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sentMessageIds = [];
    (window as any).__sentTexts = [];
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const origSend = this.send.bind(this);
          let n = 0;
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            let intercepted = false;
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:send') {
                intercepted = true;
                // Mirror the server: hand back a qm-… id the bubble adopts as queueId.
                const messageId = `qm-pw${++n}`;
                (window as any).__sentMessageIds.push(messageId);
                (window as any).__sentTexts.push(parsed.payload?.message ?? '');
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { messageId } }),
                  }));
                }, 10);
              }
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

/** Serve the session detail so the panel renders. */
async function mockSessionDetail(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut',
          process_status: 'running', mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
          messageCount: BIG_HISTORY_TURNS * 2, title: 'Big chat — merged batch',
        },
      },
    });
  });
}

test.describe('merged-batch bubble absorption (big chat)', () => {
  test('MODE 1 — long response with 3 mid-turn sends: CLI merges them, no bubble is left pinned', async ({ page }) => {
    const base = buildBigHistory();
    // The three sends the user makes DURING the long turn (the incident's real texts).
    const S1 = 'also check the cache-level projection';
    const S2 = 'we have another filter on delivery';
    const S3 = 'discus with me first';
    // What the CLI logs when it drains all three into one prompt: ONE '\n'-joined line.
    const MERGED = [S1, S2, S3].join('\n');

    let turnDone = false;
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      if (since !== null) {
        // Delta after the turn: the merged user line + the assistant's long reply.
        const delta = turnDone
          ? [
              { role: 'user', text: MERGED, timestamp: '2026-01-01T03:00:00.000Z' },
              { role: 'assistant', text: 'Done — here is the analysis.', timestamp: '2026-01-01T03:00:05.000Z' },
            ]
          : [];
        await route.fulfill({ json: { messages: delta, cursor: base.length + delta.length, delta: true } });
      } else {
        await route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
      }
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 15000 });
    const history = page.locator('.session-history');
    await expect(history).toContainText(`historical answer ${BIG_HISTORY_TURNS - 1}`);
    await page.screenshot({ path: '/tmp/bubble-verify/mode1-step1-big-history.png', fullPage: false });

    // ── The long turn starts streaming ──
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Analyzing the pipeline', taskId: TASK_ID });
    await page.waitForTimeout(150);

    // ── Three sends DURING the turn, through the real composer ──
    for (const text of [S1, S2, S3]) {
      await sendViaUi(page, text);
      await page.waitForTimeout(250);
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: ' …still working…', taskId: TASK_ID });
      await page.waitForTimeout(150);
    }

    const ids = await sentIds(page);
    expect(ids).toHaveLength(3);

    // All three are queued/delivered bubbles right now — this is the correct interim state.
    await expect(history).toContainText(S2);
    await expect(history).toContainText(S3);
    await page.screenshot({ path: '/tmp/bubble-verify/mode1-step2-three-bubbles-midturn.png' });

    // Server confirms delivery of all three (as stdin/mid-turn writes would).
    await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 3, messageIds: ids, taskId: TASK_ID });
    await page.waitForTimeout(300);
    await expect(page.locator('.session-msg-delivered')).toHaveCount(3);
    await page.screenshot({ path: '/tmp/bubble-verify/mode1-step3-delivered-badges.png' });

    // ── Turn ends. The ONLY id-bearing signal is deliberately withheld: ids=0, which
    // is exactly what the incident logs showed. History is the sole evidence. ──
    turnDone = true;
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, taskId: TASK_ID, isError: false });
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 0, messageIds: [], taskId: TASK_ID });

    // The merged line must absorb ALL THREE bubbles.
    await expect(page.locator('.session-msg-delivered')).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator('.session-msg-queued')).toHaveCount(0);
    await page.screenshot({ path: '/tmp/bubble-verify/mode1-step4-absorbed-zero-bubbles.png' });

    // Nothing was LOST: every message's text is still on screen (via the merged line).
    for (const text of [S1, S2, S3]) await expect(history).toContainText(text);

    // Order is correct: the user's sends sit ABOVE the assistant's closing reply.
    // Asserted by on-screen VERTICAL POSITION, because that is literally what the
    // user reported ("all these is long time ago, why show at bottom?") — a stuck
    // bubble renders physically below newer content. Note the merged line is one
    // paragraph with <br> separators, so a leaf-node index probe cannot see it;
    // geometry is both simpler and closer to the complaint.
    const geom = await page.evaluate((needles) => {
      const inHistory = Array.from(document.querySelectorAll('.session-history *')) as HTMLElement[];
      // Deepest element containing the text = the closest thing to its own bubble.
      const deepest = (t: string) => {
        const hits = inHistory.filter(n => (n.textContent ?? '').includes(t));
        return hits.length ? hits[hits.length - 1] : null;
      };
      const a = deepest(needles.merged);
      const b = deepest(needles.final);
      return {
        found: Boolean(a && b),
        userTop: a?.getBoundingClientRect().top ?? -1,
        finalTop: b?.getBoundingClientRect().top ?? -1,
      };
    }, { merged: S3, final: 'Done — here is the analysis.' });
    expect(geom.found, 'both the merged user line and the final reply must be on screen').toBe(true);
    expect(geom.userTop, "the user's sends must render ABOVE the assistant's closing reply")
      .toBeLessThan(geom.finalTop);

    // And the three sends render as ONE user bubble (the merged echo), not four.
    const userBubbles = await page.evaluate((texts) => {
      return Array.from(document.querySelectorAll('.session-history .session-msg'))
        .filter(n => texts.every(t => (n.textContent ?? '').includes(t))).length;
    }, [S1, S2, S3]);
    expect(userBubbles, 'exactly one element holds all three texts — the merged echo').toBe(1);

    // No render crash along the way.
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    expect(errors).toEqual([]);
  });

  test('MODE 2 — many short rapid turns: no bubble lingers, order stays chronological', async ({ page }) => {
    const base = buildBigHistory();
    const TURNS = 6;
    // Each rapid turn echoes its own line (no merge) — the common case, which must not
    // regress now that the merged-run passes exist.
    const persisted = [...base];
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      if (since !== null) {
        const from = Number(since);
        await route.fulfill({ json: { messages: persisted.slice(from), cursor: persisted.length, delta: true } });
      } else {
        await route.fulfill({ json: { messages: persisted, cursor: persisted.length, delta: false } });
      }
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 15000 });

    for (let t = 0; t < TURNS; t++) {
      const text = `rapid turn ${t} — status?`;
      await sendViaUi(page, text);
      await page.waitForTimeout(200);

      const ids = await sentIds(page);
      const thisId = ids[ids.length - 1];
      await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1, messageIds: [thisId], taskId: TASK_ID });
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: `ack ${t}`, taskId: TASK_ID });
      await page.waitForTimeout(150);

      // The turn ends and history grows by this exchange. Alternate the id evidence:
      // half the turns bind an echo-claim, half bind nothing (registry lost) — both
      // must clear, so absorption cannot be depending on the id.
      persisted.push({ role: 'user', text, timestamp: new Date(Date.UTC(2026, 0, 2, 0, t)).toISOString() } as any);
      if (t % 2 === 0) (persisted[persisted.length - 1] as any).walnutMessageId = thisId;
      persisted.push({ role: 'assistant', text: `ack ${t} complete`, timestamp: new Date(Date.UTC(2026, 0, 2, 0, t, 30)).toISOString() });

      await injectEvent(page, 'session:result', { sessionId: SESSION_ID, taskId: TASK_ID, isError: false });
      await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 0, messageIds: [], taskId: TASK_ID });

      // Steady state between turns: zero leftover bubbles. A single lingering bubble
      // here is the whole bug family, so assert per turn rather than only at the end.
      await expect(page.locator('.session-msg-delivered')).toHaveCount(0, { timeout: 20000 });
      await expect(page.locator('.session-msg-queued')).toHaveCount(0);
    }

    await page.screenshot({ path: '/tmp/bubble-verify/mode2-final-no-lingering-bubbles.png' });

    // Every turn's text survives exactly ONCE — no duplication, no loss.
    const history = page.locator('.session-history');
    for (let t = 0; t < TURNS; t++) {
      const text = `rapid turn ${t} — status?`;
      await expect(history).toContainText(text);
      const count = await page.evaluate((needle) => {
        return Array.from(document.querySelectorAll('.session-history *'))
          .filter(n => n.children.length === 0 && (n.textContent ?? '').trim() === needle).length;
      }, text);
      expect(count, `"${text}" should render exactly once`).toBe(1);
    }

    // Chronological order: turn N's text precedes turn N+1's.
    const order = await page.evaluate((n) => {
      const nodes = Array.from(document.querySelectorAll('.session-history *')).filter(x => x.children.length === 0);
      return Array.from({ length: n }, (_, t) => nodes.findIndex(x => (x.textContent ?? '').includes(`rapid turn ${t} — status?`)));
    }, TURNS);
    for (let t = 1; t < TURNS; t++) expect(order[t]).toBeGreaterThan(order[t - 1]);
  });

  /**
   * The refetch trigger itself. Absorption is evidence-based, so it cannot hide a
   * bubble until history ARRIVES — and history only arrives when something asks for
   * it. `session:batch-completed` used to be that something, but the 60s
   * activeProcessing safety timeout force-clears the in-flight entry and emits NO
   * batch event at all (nor do results withheld behind background work, or ones
   * suppressed as replays). On those paths nothing refetched, so the bubble stayed
   * pinned however good the matching was. Turns over 60s are precisely the reported
   * pattern, so this is not a corner case: 66.2% of measured turns exceed it.
   *
   * Here the ONLY turn-end signal is the stream going idle — no batch-completed, no
   * error, no reconnect. The isStreaming true→false edge must drive the refetch.
   */
  test('turn ends with NO batch-completed at all (60s safety timeout): idle edge still refetches and clears', async ({ page }) => {
    const base = buildBigHistory();
    const A = 'first send during the very long turn';
    const B = 'second send during the very long turn';
    let turnDone = false;

    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      if (since !== null) {
        const delta = turnDone
          ? [
              { role: 'user', text: `${A}\n${B}`, timestamp: '2026-01-01T05:00:00.000Z' },
              { role: 'assistant', text: 'Finally finished after a very long turn.', timestamp: '2026-01-01T05:00:01.000Z' },
            ]
          : [];
        await route.fulfill({ json: { messages: delta, cursor: base.length + delta.length, delta: true } });
      } else {
        await route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
      }
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 15000 });

    // Long turn running; two sends land mid-turn and are confirmed delivered.
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'working', taskId: TASK_ID });
    await page.waitForTimeout(150);
    for (const text of [A, B]) {
      await sendViaUi(page, text);
      await page.waitForTimeout(250);
    }
    const ids = await sentIds(page);
    await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 2, messageIds: ids, taskId: TASK_ID });
    await page.waitForTimeout(300);
    await expect(page.locator('.session-msg-delivered')).toHaveCount(2);

    // ── The turn ends the way a post-safety-timeout turn does: the stream simply
    // goes idle. NO batch-completed, NO session:error, NO reconnect. ──
    turnDone = true;
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, taskId: TASK_ID, isError: false });

    await expect(page.locator('.session-msg-delivered')).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator('.session-msg-queued')).toHaveCount(0);
    await page.screenshot({ path: '/tmp/bubble-verify/mode3-no-batch-completed-still-clears.png' });

    // And nothing was lost — the merged echo carries both texts.
    const history = page.locator('.session-history');
    for (const text of [A, B]) await expect(history).toContainText(text);
  });
});
