/**
 * A session its background agent wakes reads the same while a wake-up streams, ends and settles.
 *
 * 2026-11-19, the user, of a lead's chat that wrote one progress line per wake-up: "it sometime
 * become this ... after few second turn back". The wake-ups are turns the CLI began on hidden
 * notification lines; with no boundary in the rows, the hour read as one turn, its lines folded
 * as "9 updates" while quiet and shown flat after the reader watched a reply stream. History now
 * marks each wake-up's first row (`opensTurn`), so each line is its own turn's answer.
 *
 * Checked here through the real chat: the rows above the newest line are the same before it
 * streams, while it streams, right after it ends and once history holds it, and no progress
 * line is ever folded as an update. While a wake-up streams, the turn before it is over because
 * the CLI reported taking the notification (its command_lifecycle `started`, streamed as a user
 * line, checked on the reported session's stream file): a wake-up that starts with a tool call
 * leaves the line before it in place too. History and the WS are mocked
 * (session-live-turn-fold.spec.ts harness), the stream injected event by event.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-wakeup-turns';
const SHOTS = '/tmp/wakeup-turns';
const at = (m: number) => `2026-01-01T03:${String(m).padStart(2, '0')}:00.000Z`;
const said = (id: string, text: string, m: number, extra: Record<string, unknown> = {}) => ({ role: 'assistant', text, msgId: id, timestamp: at(m), ...extra });
const calls = (id: string, m: number, names: string[], extra: Record<string, unknown> = {}) => said(id, '', m, {
  tools: names.map((name, k) => ({ name, toolUseId: `${id}-t${k}`, input: { command: 'make check' }, result: 'ok' })), ...extra,
});
const woke = { opensTurn: true };

const BASE = [
  { role: 'user', text: 'WAKE_ASK is the design right?', timestamp: at(0) },
  said('m-answer', 'WAKE_ANSWER yes, the rules stay the same.', 1),
  calls('m-tools', 20, ['Bash', 'Bash', 'Bash'], woke),
  said('m-step', 'WAKE_STEP step one is done, starting step two.', 21),
  said('m-p1', 'WAKE_P1 the tests are running.', 30, woke),
  said('m-p2', 'WAKE_P2 the type check passed.', 34, woke),
  said('m-ack', '<walnut-turn status="agent-ack"/>', 38, woke),
  said('m-p3', 'WAKE_P3 one step was refused, looking into it.', 41, woke),
  said('m-p4', 'WAKE_P4 found the cause, rerunning.', 43, woke),
];
const NEWEST = said('m-p5', 'WAKE_P5 running the last two rounds.', 50, woke);

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    if (!ws) throw new Error('No captured WebSocket');
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
  }, { name, data });
}

let rows: Record<string, unknown>[] = BASE;

test.beforeEach(async ({ page }) => {
  rows = BASE;
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
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: [], isStreaming: false } }),
                  }));
                }, 10);
                return;
              }
            } catch { /* non-JSON */ }
            origSend(data);
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
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null && Number(since) <= rows.length) return route.fulfill({ json: { messages: rows.slice(Number(since)), cursor: rows.length, delta: true } });
    return route.fulfill({ json: { messages: rows, cursor: rows.length, delta: false } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: 'pw-task-wakeup', project: 'Walnut', process_status: 'idle',
          mode: 'bypass', startedAt: at(0), lastActiveAt: new Date().toISOString(),
          messageCount: rows.length, title: 'Wake-up turns session',
        },
      },
    });
  });
});

test('the lines above a wake-up keep their shape while it streams, ends and settles', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForFunction(() => (window as any).__capturedWs?.readyState === WebSocket.OPEN, null, { timeout: 30_000 });
  const history = page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .session-history`);
  await expect(history).toContainText('WAKE_P4', { timeout: 15000 });

  /** What the reader sees above the newest line: each fold's line and each shown message. */
  const above = () => history.evaluate((el) => {
    const out: string[] = [];
    el.querySelectorAll('[data-testid="turn-fold"] > .tool-run-toggle .tool-run-label, .markdown-body').forEach((n) => {
      if (n.closest('.process-fold-body')) return;
      const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t && !t.includes('WAKE_P5')) out.push(t.slice(0, 40));
    });
    return out;
  });
  const before = await above();
  // Every progress line shows as its own turn's answer, never folded as an update.
  for (const p of ['WAKE_P1', 'WAKE_P2', 'WAKE_P3', 'WAKE_P4', 'WAKE_STEP']) expect(before.some((t) => t.startsWith(p)), p).toBe(true);
  expect(before.some((t) => /\bupdates?\b/i.test(t))).toBe(false);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-before.png` }).catch(() => {});

  // A new wake-up: the CLI says it took the notification (command_lifecycle started, which
  // Walnut streams as a user line), then streams its one line.
  await injectEvent(page, 'session:user-line', { sessionId: SESSION_ID, uuid: 'wake-line-1' });
  await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: NEWEST.text, msgId: NEWEST.msgId });
  await expect(history).toContainText('WAKE_P5');
  expect(await above()).toEqual(before);

  // It ends; history then holds it.
  rows = [...BASE, NEWEST];
  await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: NEWEST.text, isError: false });
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  expect(await above()).toEqual(before);
  // Over the next seconds (history read, settle), nothing above it moves.
  for (let k = 0; k < 6; k++) {
    await page.waitForTimeout(500);
    expect(await above(), `after ${k * 500 + 500} ms`).toEqual(before);
  }
  await expect(history.locator('.markdown-body', { hasText: 'WAKE_P5' })).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-after.png` }).catch(() => {});
});

test('a wake-up that starts with a tool call leaves the line before it as it was', async ({ page }) => {
  // The turn before ran tools and then wrote its line; the new wake-up's first live block is a
  // call. The line is that turn's answer, never words "on the way" of the turn now running.
  const prior = [...BASE, calls('m-tools2', 45, ['Bash'], woke), said('m-p45', 'WAKE_P45 rerun started.', 46)];
  rows = prior;
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForFunction(() => (window as any).__capturedWs?.readyState === WebSocket.OPEN, null, { timeout: 30_000 });
  const history = page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .session-history`);
  await expect(history).toContainText('WAKE_P45', { timeout: 15000 });
  /** The shown messages (outside any fold) and each fold's line. */
  const view = () => history.evaluate((el) => {
    const out: string[] = [];
    el.querySelectorAll('[data-testid="turn-fold"] > .tool-run-toggle .tool-run-label, .markdown-body').forEach((n) => {
      if (n.closest('.process-fold-body')) return;
      const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) out.push(t.slice(0, 40));
    });
    return out;
  });
  const before = await view();
  expect(before.some((t) => t.startsWith('WAKE_P45'))).toBe(true);
  // The CLI took the next notification (its command_lifecycle `started`, streamed as a user line).
  await injectEvent(page, 'session:user-line', { sessionId: SESSION_ID, uuid: 'wake-line-2' });
  await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'live-t1', input: { command: 'make test' }, msgId: 'm-live' });
  await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'live-t1', result: 'ok' });
  await page.waitForTimeout(800);
  const during = await view();
  // Everything that showed still shows, in place; the live turn adds its own row after it.
  expect(during.slice(0, before.length)).toEqual(before);
  await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: NEWEST.text, msgId: NEWEST.msgId });
  rows = [...prior, calls('m-live', 49, ['Bash'], woke), said(NEWEST.msgId, NEWEST.text, 50)];
  await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: NEWEST.text, isError: false });
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  for (let k = 0; k < 6; k++) {
    await page.waitForTimeout(500);
    expect((await view()).slice(0, before.length), `after ${k * 500 + 500} ms`).toEqual(before);
  }
  await expect(history.locator('.markdown-body', { hasText: 'WAKE_P5' })).toHaveCount(1);
});
