/**
 * A message another task (or Walnut) sends in folds into ONE closed row when its
 * turn is saved, also for a reader a little above the bottom of the chat.
 *
 * 2026-11-06, the user, in a full-screen chat that took one reply after another:
 * "why it keep show the receive for every message". Each reply's turn ended and
 * its fold ("Received 1 message · Ran 1 tool") opened by itself, the command and
 * the whole card inside it. The fold opened for the reader (fold-reader-hold.ts)
 * because its rows were in view, though they sat below the row being read. Now
 * only a fold holding the row the reader reads opens
 * (scroll-jump-on-absorption.spec.ts keeps that case).
 *
 * Every envelope kind a session can receive runs the same turn: the kinds are read
 * from envelope-kit.ts, so a new kind fails here until it is listed.
 *
 * History and the WS are mocked (mock-session-harness.ts).
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createEnvelopeKit, type EnvelopeKind } from '../../../src/core/peers/envelope-kit';
import { MOCK_SESSION_ID as SID, injectEvent, takeLine, waitForWs } from './mock-session-harness';

const SHOTS = process.env.RECEIVED_FOLD_SHOTS ?? '/tmp/received-fold-reader';
test.describe.configure({ timeout: 120_000 });

const kit = createEnvelopeKit();
const ENVELOPES: Record<EnvelopeKind, (n: string) => string> = {
  reply: (n) => kit.buildWalnutMessage({ kind: 'reply', attrs: { from: 'Sample sender [abcd1234]', title: `RF_TITLE_${n} wording replaced` }, body: `RF_BODY_${n} The new version is in place.` }),
  'peer-note': (n) => kit.buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'Sample lead [abcd1234]', title: `RF_TITLE_${n} check the chart` }, body: `RF_BODY_${n} Please check the chart.` }),
  notification: (n) => kit.buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', 'about-task': 'abcd1234', outcome: 'status', title: `RF_TITLE_${n} status moved` }, body: `RF_BODY_${n} The task moved to Waiting.` }),
  trigger: (n) => kit.buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Trigger: sample-watch' }, body: `RF_BODY_${n} The check found a new reply.` }),
  'app-state': (n) => kit.buildWalnutMessage({ kind: 'app-state', attrs: { from: 'Sample app', title: `RF_TITLE_${n} app state` }, body: `RF_BODY_${n} The board has two open items.` }),
};

test('every envelope kind is listed here', () => {
  const src = readFileSync(new URL('../../../src/core/peers/envelope-kit.ts', import.meta.url), 'utf8');
  const union = /export type EnvelopeKind = ([^;]+);/.exec(src)?.[1] ?? '';
  const kinds = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  expect(kinds.length).toBeGreaterThan(0);
  expect(Object.keys(ENVELOPES).sort()).toEqual(kinds);
});

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
// A long answer, so the row the reader reads crosses the top of the view while
// the new turn lands under it. It is well over two views tall: every turn's steps
// now fold to one short row (2026-11-12), and with 14 lines the chat was barely
// taller than the 900px view: a reader 77px from the bottom was already at its
// top, so the wheel step up could not move them (one of the two WebKit flakes;
// the other is in wheelUpOver).
const LONG_LINES = 40;
const LONG = Array.from({ length: LONG_LINES }, (_, i) => `RF_ANSWER line ${i + 1}: the chart and the text match.`).join('\n\n');

async function harness(page: Page, getRows: () => unknown[]) {
  await page.addInitScript(() => {
    const Orig = window.WebSocket;
    window.WebSocket = class P extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), location.href).pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const send = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            try {
              const p = JSON.parse(data as string);
              if (p.type === 'req' && p.method === 'session:stream-subscribe') {
                setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'res', id: p.id, ok: true, payload: { blocks: [], isStreaming: false } }) })), 10);
                return;
              }
            } catch { /* non-JSON */ }
            send(data);
          };
        }
      }
    } as any;
    for (const k of Object.getOwnPropertyNames(Orig)) {
      if (k !== 'prototype' && k !== 'length' && k !== 'name') try { (window.WebSocket as any)[k] = (Orig as any)[k]; } catch { /* read-only */ }
    }
  });
  await page.route(`**/api/sessions/${SID}/history**`, async (route) => {
    const rows = getRows();
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null) return route.fulfill({ json: { messages: rows.slice(Number(since)), cursor: rows.length, delta: true } });
    return route.fulfill({ json: { messages: rows, cursor: rows.length, delta: false } });
  });
  await page.route(`**/api/sessions/${SID}`, async (route, req) => {
    if (req.url().includes('/history')) return route.fallback();
    await route.fulfill({ json: { session: {
      claudeSessionId: SID, taskId: 'pw-task-mock-session', project: 'Walnut', process_status: 'idle', mode: 'bypass',
      startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: 2, title: 'Mock session',
    } } });
  });
}

/**
 * One wheel step up over the chat, as a reader moves a little up, until `moved`.
 * Aimed at a point the chat itself answers for in the layout of now, never a box
 * read before: in WebKit the page's layout was seen for a moment with the main
 * page 0px tall (right after a notification or trigger message came in), and a
 * wheel aimed from that box went to the panel's frame, which does not scroll
 * (the old flake: the gap from the bottom stayed where it was). WebKit also
 * applies a queued wheel step late, so each step gets time before the next.
 */
async function wheelUpOver(page: Page, scroller: Locator, moved: () => Promise<boolean>) {
  for (let step = 0; step < 3; step++) {
    const aim: { at?: { x: number; y: number } | null } = {};
    await expect.poll(async () => {
      aim.at = await scroller.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        const at = document.elementFromPoint(p.x, p.y);
        return r.height > 200 && at && el.contains(at) ? p : null;
      });
      return !!aim.at;
    }, { timeout: 10_000 }).toBe(true);
    await page.mouse.move(aim.at!.x, aim.at!.y);
    await page.mouse.wheel(0, -120);
    try {
      await expect.poll(moved, { timeout: 4_000 }).toBe(true);
      return;
    } catch { /* not moved yet: aim again */ }
  }
  expect(await moved(), 'the reader moved up').toBe(true);
}

/** A chat whose answer fills the view takes `rounds` messages of `kind`, each
 *  answered, with the reader moving a little up before each turn is saved. */
async function receiveRounds(page: Page, kind: EnvelopeKind, rounds: number, pauseMs = 0) {
  let rows: unknown[] = [
    { role: 'user', text: 'RF_ASK fix the chart', timestamp: at(0) },
    { role: 'assistant', text: LONG, msgId: 'rf-answer', timestamp: at(1) },
  ];
  await harness(page, () => rows);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sessions?id=${SID}`);
  await waitForWs(page);
  const hist = page.locator(`.session-panel[data-session-id="${SID}"] .session-history`);
  await expect(hist).toContainText(`RF_ANSWER line ${LONG_LINES}`, { timeout: 15_000 });
  await page.waitForTimeout(pauseMs);

  for (let r = 1; r <= rounds; r++) {
    const n = String(r);
    const envelope = ENVELOPES[kind](n);
    const qm = `qm-rf-${kind}-${n}`;
    const toolId = `tu-rf-${kind}-${n}`;
    // As the real turns ran: odd ones say what they do and run a command before
    // the answer, even ones only answer.
    const withCall = r % 2 === 1;
    const narration = `RF_STEP_${n} Changing the wording.`;
    const reply = [`RF_REPLY_${n} handed over.`, 'The chart and the text match.', 'The sender has the final version.'].join('\n\n');

    await injectEvent(page, 'session:message-queued', {
      sessionId: SID, messageId: qm, message: envelope, source: 'peer', sentBy: 'agent', queuedText: envelope, enqueuedAt: new Date().toISOString(),
    });
    await injectEvent(page, 'session:messages-delivered', { sessionId: SID, count: 1, messageIds: [qm], turnGen: r });
    // Claude Code takes the line as its turn starts.
    await takeLine(page, qm);
    await page.waitForTimeout(pauseMs);
    if (withCall) {
      await injectEvent(page, 'session:text-delta', { sessionId: SID, delta: narration, msgId: `rf-step-${n}` });
      await injectEvent(page, 'session:tool-use', { sessionId: SID, toolName: 'Bash', toolUseId: toolId, input: { command: `sample-update --round ${n}` }, msgId: `rf-step-${n}` });
      await injectEvent(page, 'session:tool-result', { sessionId: SID, toolUseId: toolId, result: 'ok' });
    }
    await injectEvent(page, 'session:text-delta', { sessionId: SID, delta: reply, msgId: `rf-reply-${n}` });
    await expect(hist).toContainText(`RF_REPLY_${n}`);

    // The reader moves up a little before the turn is saved: its rows stay in
    // view, under the row they read.
    const gapNow = () => hist.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    const gapBefore = await gapNow();
    // Room above for the wheel step (a chat that ends at its top cannot move up).
    expect(await hist.evaluate((el) => el.scrollTop), 'the reader has room to move up').toBeGreaterThan(240);
    await wheelUpOver(page, hist, async () => (await gapNow()) > gapBefore + 60);
    await page.waitForTimeout(600 + pauseMs);

    rows = [
      ...rows,
      { role: 'user', text: envelope, msgId: `rf-in-${n}`, timestamp: at(10 * r) },
      ...(withCall ? [{ role: 'assistant', text: narration, msgId: `rf-step-${n}`, timestamp: at(10 * r + 1), tools: [{ name: 'Bash', toolUseId: toolId, input: { command: `sample-update --round ${n}` }, result: 'ok' }] }] : []),
      { role: 'assistant', text: reply, msgId: `rf-reply-${n}`, timestamp: at(10 * r + 2) },
    ];
    // The row the reader reads, and how far they are from the bottom.
    const before = await hist.evaluate((el) => {
      const view = el.getBoundingClientRect();
      const row = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((r) => { const b = r.getBoundingClientRect(); return b.bottom > view.top + 24 && b.top < view.bottom; });
      return { id: row?.dataset.messageId ?? null, top: row?.getBoundingClientRect().top ?? 0, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
    });
    await injectEvent(page, 'session:result', { sessionId: SID, isError: false });
    await injectEvent(page, 'session:batch-completed', { sessionId: SID, count: 1 });
    await expect(hist.locator('.session-msg-delivered')).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(800 + pauseMs);
    // Folding rows below it moves the reader's row at most by their distance from
    // the bottom (the page can end there, no further), never toward older rows.
    if (before.id) {
      const top = await hist.evaluate((el, id) => el.querySelector<HTMLElement>(`[data-message-id="${id}"]`)?.getBoundingClientRect().top ?? null, before.id);
      if (top !== null) expect(top - before.top, 'the row the reader reads moved').toBeLessThanOrEqual(before.gap + 2);
      if (top !== null) expect(top - before.top, 'the row the reader reads moved').toBeGreaterThanOrEqual(-2);
    }

    // One closed row per received message; nothing it holds is drawn.
    const folds = hist.locator('[data-testid="process-fold"], [data-testid="turn-fold"], [data-testid="step-group-fold"], [data-testid="received-fold"]');
    await expect(folds.filter({ hasText: /Received 1 message/ })).toHaveCount(r);
    await expect(hist.locator('[data-open="true"]')).toHaveCount(0);
    await expect(hist.locator('.provenance-card')).toHaveCount(0);
    await expect(hist).not.toContainText(`RF_BODY_${n}`);
    // Every earlier turn's steps are folded: its line and call are not drawn.
    for (let k = 1; k < r; k++) await expect(hist).not.toContainText(`RF_STEP_${k}`);
    // Each answer reads once.
    for (let k = 1; k <= r; k++) await expect(hist.getByText(`RF_REPLY_${k} handed over.`, { exact: true })).toHaveCount(1);
  }
  return hist;
}

for (const kind of Object.keys(ENVELOPES) as EnvelopeKind[]) {
  test(`a ${kind} turn folds shut under a reader a little above the bottom`, async ({ page }) => {
    const hist = await receiveRounds(page, kind, 3);
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${kind}.png`, clip: (await hist.boundingBox())! }).catch(() => {});
    // Opened by a click, the card is there once.
    const last = hist.locator('[data-testid="process-fold"], [data-testid="turn-fold"]').filter({ hasText: /Received 1 message/ }).last();
    await last.locator(':scope > .tool-run-toggle').click();
    await expect(hist.locator('.provenance-card')).toHaveCount(1);
  });
}

// A short recording of four replies arriving, on the Mac (macOS WebKit is the Mac
// app's engine) or with PW_VIDEO=1: `${SHOTS}/<project>-demo/*.webm`.
test('demo: four replies in a row stay one closed row each', async ({ browser }) => {
  test.skip(process.platform !== 'darwin' && !process.env.PW_VIDEO, 'recorded on the Mac or with PW_VIDEO=1');
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    recordVideo: { dir: `${SHOTS}/${test.info().project.name}-demo`, size: { width: 1280, height: 900 } },
  });
  const page = await context.newPage();
  try {
    const hist = await receiveRounds(page, 'reply', 4, 900);
    const last = hist.locator('[data-testid="process-fold"], [data-testid="turn-fold"]').filter({ hasText: /Received 1 message/ }).last();
    await last.locator(':scope > .tool-run-toggle').click();
    await expect(hist.locator('.provenance-card')).toHaveCount(1);
    await page.waitForTimeout(1500);
  } finally {
    await context.close();
  }
});
