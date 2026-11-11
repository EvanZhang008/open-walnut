/**
 * The live turn a received message started folds into ONE row while it runs.
 *
 * History holds the message (a peer's note) once the turn starts; the tool calls
 * the session makes for it are still stream blocks. Drawn apart, that was two
 * rows, "Received a message ›" and "Used 2 tools ›" (2026-10-26, the user: "this
 * 2 can be collapsed"). Now it is one, "Received 1 message · Ran 2 tools ›", the
 * shape the turn keeps once it is answered.
 *
 * History and the WS are mocked (composer-stop-and-indicator.spec.ts harness):
 * the stream is injected event by event, so the turn is really live.
 */
import { test, expect, type Page } from '@playwright/test';
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit';

const SESSION_ID = 'pw-live-turn-fold';
const SHOTS = '/tmp/live-turn-fold';

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined;
      if (!ws) throw new Error('No captured WebSocket — did addInitScript run?');
      ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
    },
    { name, data },
  );
}

const note = createEnvelopeKit().buildWalnutMessage({
  kind: 'peer-note',
  attrs: { from: 'Sample lead [abcd1234]', title: 'LIVE_PEER_TITLE check the build' },
  body: 'Please check the build. LIVE_PEER_BODY',
});
const base = [
  { role: 'user', text: 'LIVE_ASK what is left?', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', text: 'LIVE_ANSWER nothing is left.', timestamp: '2026-01-01T00:00:01.000Z' },
  { role: 'user', text: note, timestamp: '2026-01-01T00:00:02.000Z' },
];

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
    if (since !== null) return route.fulfill({ json: { messages: [], cursor: base.length, delta: true } });
    return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: 'pw-task-live-fold', project: 'Walnut', process_status: 'running',
          mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
          messageCount: 3, title: 'Live turn fold session',
        },
      },
    });
  });
});

test('a received message and the tools the live turn runs for it are one fold row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 10000 });
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`);
  const history = panel.locator('.session-history');
  await expect(history).toContainText('LIVE_ANSWER nothing is left.', { timeout: 15000 });

  for (const [id, toolName, input] of [
    ['tool-live-1', 'Bash', { command: 'make check' }],
    ['tool-live-2', 'Read', { file_path: '/tmp/live/a.ts' }],
  ] as const) {
    await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName, toolUseId: id, input });
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: id, result: 'ok' });
  }

  const folds = history.locator('[data-testid="turn-fold"]');
  await expect(folds).toHaveCount(1, { timeout: 10000 });
  const fold = folds.first();
  await expect(fold.locator(':scope > .tool-run-toggle .tool-run-label')).toHaveText(/^Received 1 message \u00b7 Ran 2 tools/);
  // No second row for the same turn: no tool run, no card outside the fold.
  await expect(history.locator('.tool-run-toggle')).toHaveCount(1);
  await expect(history.locator('.provenance-card')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-live-folded.png`, clip: (await fold.boundingBox())! }).catch(() => {});

  // Opened: the message, then both calls as one run laid out as rows, the run the saved turn's
  // fold will hold (so the body keeps its form when the turn is saved).
  await fold.locator('.tool-run-toggle').first().click();
  await expect(fold.locator('.provenance-card')).toHaveCount(1);
  await expect(fold.locator('.provenance-card')).toContainText('LIVE_PEER_TITLE check the build');
  const innerRun = fold.locator('.process-fold-body > .session-msg-bare > .tool-run-row');
  await expect(innerRun).toHaveCount(1);
  // Opened, the run is its calls, one row each (design 1, 2026-11-11): nothing to open twice.
  await expect(innerRun).toHaveAttribute('data-flat', 'true');
  await expect(fold).toContainText('make check');
  await expect(fold).toContainText('/tmp/live/a.ts');

  // A third call joins the same row.
  await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'tool-live-3', input: { command: 'make test' } });
  await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'tool-live-3', result: 'ok' });
  await expect(fold.locator(':scope > .tool-run-toggle .tool-run-label')).toHaveText(/^Received 1 message(?: from [^·›]+?)? \u00b7 Ran 3 tools/);
  // The third call joined the same run inside it.
  await expect(fold.locator('.process-fold-body > .session-msg-bare > .tool-run-row')).toHaveCount(1);
  await expect(history.locator('[data-testid="turn-fold"]')).toHaveCount(1);
});

test('the fold stays one open row when a history read saves every call the live turn ran so far', async ({ page }) => {
  // 2026-11-02: a returned call gives way to its saved twin (render-filter.ts). When
  // that was every step the turn had drawn, the live fold had nothing left to start
  // from and came apart into the plain rows until the next block, then folded again.
  const saved = [
    ...base,
    { role: 'assistant', text: '', msgId: 'msg-live-calls', timestamp: '2026-01-01T00:00:03.000Z', tools: [
      { name: 'Bash', toolUseId: 'tool-sv-1', input: { command: 'make check' }, result: 'ok' },
      { name: 'Read', toolUseId: 'tool-sv-2', input: { file_path: '/tmp/live/a.ts' }, result: 'ok' },
    ] },
  ];
  let rows = base;
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null) return route.fulfill({ json: { messages: rows.slice(Number(since)), cursor: rows.length, delta: true } });
    return route.fulfill({ json: { messages: rows, cursor: rows.length, delta: false } });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForFunction(() => (window as any).__capturedWs?.readyState === WebSocket.OPEN, null, { timeout: 10000 });
  const history = page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .session-history`);
  await expect(history).toContainText('LIVE_ANSWER nothing is left.', { timeout: 15000 });
  for (const [id, toolName, input] of [
    ['tool-sv-1', 'Bash', { command: 'make check' }],
    ['tool-sv-2', 'Read', { file_path: '/tmp/live/a.ts' }],
  ] as const) {
    await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName, toolUseId: id, input });
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: id, result: 'ok' });
  }
  const folds = history.locator('[data-testid="turn-fold"]');
  await expect(folds).toHaveCount(1, { timeout: 10000 });
  await folds.first().locator('.tool-run-toggle').first().click();
  // Opened, the calls are rows of the fold's one list (design 1, session-worked-for.spec.ts).
  await expect(folds.first()).toContainText('make check');

  await page.evaluate((dump) => {
    const w = window as any;
    w.__foldDump = dump;
    w.__foldFrames = [];
    w.__foldSampling = true;
    const sample = () => {
      if (!w.__foldSampling) return;
      const h = document.querySelector('.session-history');
      const f = h?.querySelectorAll('[data-testid="turn-fold"]') ?? [];
      w.__foldFrames.push({ folds: f.length, open: f.length === 1 && (f[0].textContent ?? '').includes('make check'),
        runs: f.length === 1 ? f[0].querySelectorAll(':scope > .process-fold-body > .session-msg-bare > .tool-run-row').length : 0,
        ...((window as any).__foldDump ? { body: Array.from(f[0]?.querySelectorAll(':scope > .process-fold-body > *') ?? []).map((c) => `${c.className}>${Array.from(c.children).map((x) => x.className).join('|')}`).join(' ; '), after: Array.from(h?.children ?? []).slice(-4).map((c) => `${c.className}:${(c.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60)}`).join(' ; ') } : {}), cardsOutside: Array.from(h?.querySelectorAll('.provenance-card') ?? []).filter((c) => !c.closest('[data-testid="turn-fold"]')).length });
    };
    w.__foldObserver = new MutationObserver(sample);
    w.__foldObserver.observe(document.querySelector('.session-history')!, { subtree: true, childList: true, characterData: true });
    const tick = () => { if (!w.__foldSampling) return; sample(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, !!process.env.FOLD_DUMP);

  // A history read mid-turn saves both calls.
  rows = saved;
  const read = page.waitForResponse((r) => r.url().includes(`/api/sessions/${SESSION_ID}/history`), { timeout: 8000 });
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  await read;
  await page.waitForTimeout(800);
  // The turn goes on.
  await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'tool-sv-3', input: { command: 'make test' } });
  await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'tool-sv-3', result: 'ok' });
  await expect(folds.first()).toContainText('make test');
  await page.waitForTimeout(300);
  // The turn ends and the third call is saved too: the same fold, one run, still open.
  rows = [...saved, { role: 'assistant', text: '', msgId: 'msg-live-call3', timestamp: '2026-01-01T00:00:04.000Z', tools: [
    { name: 'Bash', toolUseId: 'tool-sv-3', input: { command: 'make test' }, result: 'ok' },
  ] }];
  await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
  const endRead = page.waitForResponse((r) => r.url().includes(`/api/sessions/${SESSION_ID}/history`), { timeout: 8000 });
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  await endRead;
  await page.waitForTimeout(800);
  await expect(folds.first()).toContainText('make test');
  if (process.env.FOLD_DUMP) console.log('FOLD_DUMP', await folds.first().evaluate((f) => Array.from(f.querySelectorAll('.process-fold-body > *')).map((c) => `${c.tagName}.${c.className} > ${Array.from(c.children).map((x) => x.className).join('|')}`).join('\n')));
  const frames = await page.evaluate(() => { const w = window as any; w.__foldSampling = false; w.__foldObserver.disconnect(); return w.__foldFrames as Array<{ folds: number; open: boolean; runs: number; cardsOutside: number }>; });
  expect(frames.length).toBeGreaterThan(1);
  const bad = frames.map((f, i) => ({ i, ...f })).filter((f) => f.folds !== 1 || !f.open || f.runs !== 1 || f.cardsOutside !== 0);
  expect(bad.slice(0, 5), `frames where the fold came apart (of ${frames.length})`).toEqual([]);
});

/** The fold's rows as the reader sees them: each body child's class chain and
 *  its place in the fold, so a row that changed form or moved shows up. */
async function foldRows(page: Page) {
  return page.evaluate(() => {
    const f = document.querySelector('.session-history [data-testid="turn-fold"]')!;
    const top = f.getBoundingClientRect().top;
    return Array.from(f.querySelectorAll(':scope > .process-fold-body > *')).map((c) => {
      const chain: string[] = [];
      for (let n: Element | null = c; n && chain.length < 4; n = n.firstElementChild) chain.push(n.className);
      const r = c.getBoundingClientRect();
      return { chain: chain.join(' > '), text: (c.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40), top: Math.round(r.top - top), height: Math.round(r.height) };
    });
  });
}

test('reasoning alone in the live fold is the row its saved message will be', async ({ page }) => {
  let rows = base;
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null) return route.fulfill({ json: { messages: rows.slice(Number(since)), cursor: rows.length, delta: true } });
    return route.fulfill({ json: { messages: rows, cursor: rows.length, delta: false } });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForFunction(() => (window as any).__capturedWs?.readyState === WebSocket.OPEN, null, { timeout: 10000 });
  const history = page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .session-history`);
  await expect(history).toContainText('LIVE_ANSWER nothing is left.', { timeout: 15000 });
  await injectEvent(page, 'session:thinking-delta', { sessionId: SESSION_ID, delta: 'LIVE_REASON weighing the note.', msgId: 'msg-live-think' });
  const fold = history.locator('[data-testid="turn-fold"]');
  await expect(fold).toHaveCount(1, { timeout: 10000 });
  await fold.locator(':scope > .tool-run-toggle').click();
  await expect(fold).toContainText('Thinking');
  await page.waitForTimeout(300);
  const live = await foldRows(page);
  expect(live.some((r) => r.text.startsWith('Thinking'))).toBe(true);

  rows = [...base, { role: 'assistant', text: '', thinking: 'LIVE_REASON weighing the note.', msgId: 'msg-live-think', timestamp: new Date().toISOString() }];
  await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
  const read = page.waitForResponse((r) => r.url().includes(`/api/sessions/${SESSION_ID}/history`), { timeout: 8000 });
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  await read;
  await page.waitForTimeout(800);
  await expect(history.locator('.session-live-row')).toHaveCount(0);
  expect(await foldRows(page)).toEqual(live);
});

test('a call still out when the turn ends stops the fold breathing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForFunction(() => (window as any).__capturedWs?.readyState === WebSocket.OPEN, null, { timeout: 10000 });
  const history = page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .session-history`);
  await expect(history).toContainText('LIVE_ANSWER nothing is left.', { timeout: 15000 });
  await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'tool-out-1', input: { command: 'make check' } });
  const fold = history.locator('[data-testid="turn-fold"]');
  await expect(fold).toHaveCount(1, { timeout: 10000 });
  await expect(fold.locator(':scope > .tool-run-toggle .tool-run-live-dot')).toHaveCount(1);
  await fold.locator(':scope > .tool-run-toggle').click();
  // Opened, the call still out is its own row, breathing (its calling dot).
  await expect(fold.locator('.process-fold-body .tool-run-live-dot, .process-fold-body .chat-tool-block-calling-dot')).toHaveCount(1);
  // The turn is cut with the call still out: nothing returns it.
  await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'interrupted', isError: false });
  await expect(history.locator('.tool-run-live-dot, .chat-tool-block-calling-dot')).toHaveCount(0, { timeout: 5000 });
  await expect(fold).toHaveCount(1);
});
