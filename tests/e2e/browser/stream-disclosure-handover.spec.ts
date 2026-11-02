/**
 * What the reader opened or closed in a turn stays that way while the turn runs,
 * when a message they sent mid-turn is saved, and when the turn ends.
 *
 * The user (2026-11-01): streaming and finished must look exactly the same, "no
 * flash, no change of format". A tool run the reader had opened folded shut the
 * moment a message they sent mid-turn was saved: the live blocks sat in one
 * panel that the saved message split, so React built them again, and every
 * disclosure kept its state in the element alone. A live Edit also drew a plain
 * card where its saved row drew the diff.
 *
 * The turn: three tool calls (two commands and an Edit) fold into one run; the
 * reader opens the run, opens the first command's card and folds the Edit's diff
 * shut. A message sent mid-turn is saved together with those calls, the turn runs
 * one more command, and the turn ends. A sampler on every animation frame
 * requires that the run is open, the command's output shown once and the diff
 * folded through both handovers.
 *
 * Harness: the captured /ws socket and route-mocked history of
 * mid-stream-message.spec.ts, so the real client pipeline runs.
 */
import { test, expect, type Page } from '@playwright/test';
import { disableTransitions } from './render-parity-helpers';

const SESSION_ID = 'pw-normal-session';

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    if (!ws) throw new Error('No captured WebSocket: did addInitScript run?');
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
  }, { name, data });
}

type Row = { role: 'user' | 'assistant'; text: string; timestamp: string; msgId?: string; tools?: unknown[] };

/** History as the server serves it: only the rows written so far. */
async function mockRunningSession(page: Page, base: Row[], turn: Row[]): Promise<(n: number) => void> {
  const all = [...base, ...turn];
  let written = base.length;
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    const rows = all.slice(0, written);
    if (since !== null) return route.fulfill({ json: { messages: rows.slice(Number(since)), cursor: rows.length, delta: true } });
    return route.fulfill({ json: { messages: rows, cursor: rows.length, delta: false } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: 'pw-task-001', project: 'Walnut', process_status: 'running', mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: base.length, title: 'Test session',
        },
      },
    });
  });
  return (n) => { written = Math.min(all.length, written + n); };
}

test.beforeEach(async ({ page }) => {
  await disableTransitions(page);
  await page.addInitScript(() => {
    const Orig = window.WebSocket;
    window.WebSocket = class extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), window.location.href).pathname !== '/ws' || (window as any).__capturedWs) return;
        (window as any).__capturedWs = this;
        const origSend = this.send.bind(this);
        let n = 0;
        this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          try {
            const req = JSON.parse(data as string);
            const answer = req.type === 'req' && req.method === 'session:send' ? { messageId: `mock-msg-${++n}` }
              : req.type === 'req' && req.method === 'session:stream-subscribe' ? { blocks: [], isStreaming: false } : null;
            if (answer) {
              setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'res', id: req.id, ok: true, payload: answer }) })), 10);
              return;
            }
          } catch { /* non-JSON */ }
          origSend(data);
        };
      }
    } as any;
    for (const key of Object.getOwnPropertyNames(Orig)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as any)[key] = (Orig as any)[key]; } catch { /* read-only */ }
      }
    }
  });
});

/** Per frame: how the disclosures look. */
async function startSampler(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__disclosureFrames = [];
    w.__disclosureSampling = true;
    const tick = () => {
      if (!w.__disclosureSampling) return;
      const h = document.querySelector('.main-page-session-column .session-history') ?? document.querySelector('.session-history');
      const text = (h as HTMLElement | null)?.innerText ?? '';
      const runs = Array.from(h?.querySelectorAll('.tool-run-row') ?? []).filter((r) => (r.textContent ?? '').includes('echo alpha'));
      w.__disclosureFrames.push({
        outputs: (text.match(/alpha-out/g) ?? []).length,
        runs: runs.length,
        runOpen: runs.length === 1 && !!runs[0].querySelector(':scope > .tool-run-body'),
        diffBodies: h?.querySelectorAll('.edit-diff-body').length ?? 0,
        editCards: Array.from(h?.querySelectorAll('.chat-tool-block-name') ?? []).filter((e) => e.textContent === 'Edit').length,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopSampler(page: Page): Promise<Array<{ outputs: number; runs: number; runOpen: boolean; diffBodies: number; editCards: number }>> {
  return page.evaluate(() => { (window as any).__disclosureSampling = false; return (window as any).__disclosureFrames; });
}

test('an opened run, an opened card and a folded diff stay as the reader left them through a mid-turn save and the turn end', async ({ page }) => {
  const edit = { file_path: '/repo/src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' };
  const toolA = { name: 'Bash', toolUseId: 'toolu_d_a', input: { command: 'echo alpha' }, result: 'alpha-out' };
  const toolB = { name: 'Bash', toolUseId: 'toolu_d_b', input: { command: 'echo beta' }, result: 'beta-out' };
  const toolE = { name: 'Edit', toolUseId: 'toolu_d_e', input: edit, result: 'The file has been updated.' };
  const toolC = { name: 'Bash', toolUseId: 'toolu_d_c', input: { command: 'echo gamma' }, result: 'gamma-out' };
  const now = () => new Date().toISOString();
  const base: Row[] = [
    { role: 'user', text: 'Run the checks', timestamp: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', text: 'Starting.', msgId: 'msg-d-base', timestamp: '2026-01-01T00:00:01.000Z' },
  ];
  const midText = 'Also look at the docs folder';
  const turn: Row[] = [
    { role: 'assistant', text: '', msgId: 'msg-d-t1', timestamp: now(), tools: [toolA, toolB, toolE] },
    { role: 'user', text: midText, timestamp: now() },
    { role: 'assistant', text: '', msgId: 'msg-d-t2', timestamp: now(), tools: [toolC] },
    { role: 'assistant', text: 'All checks pass.', msgId: 'msg-d-reply', timestamp: now() },
  ];
  const land = await mockRunningSession(page, base, turn);

  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => (window as any).__capturedWs?.readyState === WebSocket.OPEN, null, { timeout: 10000 });
  const history = page.locator('.main-page-session-column .session-history').first();
  await expect(history).toContainText('Starting.');

  for (const t of [toolA, toolB, toolE]) {
    await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: t.name, toolUseId: t.toolUseId, input: t.input, taskId: 'pw-task-001' });
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: t.toolUseId, result: t.result, taskId: 'pw-task-001' });
  }
  const liveRun = history.locator('.session-live-row .tool-run-row').filter({ hasText: /^Ran 2 commands/ });
  await expect(liveRun).toHaveCount(1);

  // The reader opens the run, opens the first command, folds the diff.
  await liveRun.locator('.tool-run-toggle').click();
  // Live, the Edit is the diff its saved row draws.
  await expect(liveRun.locator('.edit-diff-body')).toHaveCount(1);
  await liveRun.locator('.chat-tool-block-header', { hasText: 'echo alpha' }).click();
  await expect(liveRun).toContainText('alpha-out');
  await liveRun.locator('.chat-tool-block-header', { hasText: 'Edit' }).click();
  await expect(liveRun.locator('.edit-diff-body')).toHaveCount(0);

  await startSampler(page);

  // A message sent mid-turn; the CLI takes it and the transcript writes the
  // three calls and the message: one history read saves them all.
  const input = page.getByPlaceholder('Send a message to this session...');
  await input.fill(midText);
  await page.locator('.session-panel-input .chat-send-btn-icon').click();
  await expect(input).toHaveValue('');
  await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1 });
  land(2);
  const midRead = page.waitForResponse((r) => r.url().includes(`/api/sessions/${SESSION_ID}/history`), { timeout: 8000 });
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  await midRead;
  // The saved run took over: no live copy of it is left.
  await expect(history.locator('.session-live-row .tool-run-row').filter({ hasText: 'echo alpha' })).toHaveCount(0);
  await expect(history.getByText(midText)).toHaveCount(1);
  await page.waitForTimeout(400);
  await history.screenshot({ path: test.info().outputPath('after-mid-turn-save.png') });

  // The turn goes on, then ends.
  await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: toolC.toolUseId, input: toolC.input, taskId: 'pw-task-001' });
  await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: toolC.toolUseId, result: toolC.result, taskId: 'pw-task-001' });
  await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'All checks pass.', msgId: 'msg-d-reply' });
  await page.waitForTimeout(300);
  land(2);
  await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'All checks pass.', isError: false });
  const endRead = page.waitForResponse((r) => r.url().includes(`/api/sessions/${SESSION_ID}/history`), { timeout: 8000 });
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  await endRead;
  await expect(history.locator('.session-live-row')).toHaveCount(0);
  await page.waitForTimeout(600);
  const frames = await stopSampler(page);

  expect(frames.length).toBeGreaterThan(5);
  const bad = frames.map((f, i) => ({ i, ...f }))
    .filter((f) => f.runs !== 1 || !f.runOpen || f.outputs !== 1 || f.diffBodies !== 0 || f.editCards !== 1);
  expect(bad.slice(0, 5), `frames where the run, the card or the diff changed (of ${frames.length})`).toEqual([]);

  // The finished turn reads as the reader left it.
  const savedRun = history.locator('.tool-run-row').filter({ hasText: 'echo alpha' });
  await expect(savedRun.locator(':scope > .tool-run-body')).toHaveCount(1);
  await expect(savedRun).toContainText('alpha-out');
  await expect(savedRun.locator('.edit-diff-body')).toHaveCount(0);
  await expect(history).toContainText('All checks pass.');
  await history.screenshot({ path: test.info().outputPath('after-turn-end.png') });
});
