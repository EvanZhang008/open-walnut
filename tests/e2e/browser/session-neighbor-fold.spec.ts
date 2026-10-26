/**
 * Neighbouring folded steps are ONE row: a tool run and the context the CLI
 * injected after it (a skill's re-invocation note, the skill's text) used to be
 * five rows in a row, "Ran 5 commands, launched 2 skills ›", "Injected context ›",
 * "Loaded skill … ›", "Injected context ›", "Loaded skill … ›" (2026-10-26, the
 * user: "we want all these combine into one if they are neighbor"). Now they read
 * "Ran 3 commands, launched 2 skills, loaded 2 skills, injected context 2× ›",
 * and opening it shows each step. Words in between, or a person's message, still
 * split them; one context row alone stays its own row.
 *
 * History and the WS are mocked (session-live-turn-fold.spec.ts harness), so the
 * live case injects stream events one by one while the turn really runs.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-neighbor-fold';
const SHOTS = '/tmp/neighbor-fold';

if (process.env.NEIGHBOR_FOLD_VIDEO) test.use({ video: { mode: 'on', size: { width: 1280, height: 900 } } });

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const bash = (id: string, command: string) => ({ name: 'Bash', toolUseId: id, input: { command }, result: 'ok' });
const skill = (id: string, name: string) => ({ name: 'Skill', toolUseId: id, input: { skill: name }, result: `Launching skill: ${name}` });
const note = (name: string) => `(Re-invocation of /${name}: the skill instructions were previously loaded; the arguments follow.)`;
const dump = (name: string) => `Base directory for this skill: /home/sample/.claude/skills/${name}\n\n# ${name}\n\nNB_SKILL_BODY_${name} Steps to follow.`;

// One "open" turn (it ends in context, not an answer), then an answered one, then
// a lone note after an answer, which stays its own row.
const history = [
  { role: 'user', text: 'NB_ASK1 run the checks and write it up', timestamp: at(0) },
  { role: 'assistant', text: '', tools: [bash('b1', 'make lint')], timestamp: at(1) },
  { role: 'assistant', text: '', tools: [bash('b2', 'make test')], timestamp: at(2) },
  { role: 'assistant', text: '', tools: [bash('b3', 'make build')], timestamp: at(3) },
  { role: 'assistant', text: '', tools: [skill('s1', 'sample-plan'), skill('s2', 'sample-explain')], timestamp: at(4) },
  { role: 'user', injected: true, text: note('sample-plan'), timestamp: at(5) },
  { role: 'user', injected: true, text: dump('sample-plan'), timestamp: at(6) },
  { role: 'user', injected: true, text: note('sample-explain'), timestamp: at(7) },
  { role: 'user', injected: true, text: dump('sample-explain'), timestamp: at(8) },
  { role: 'user', text: 'NB_ASK2 is there a tool for that', timestamp: at(9) },
  { role: 'assistant', text: '', tools: [bash('b4', 'which sample-tool')], timestamp: at(10) },
  { role: 'assistant', text: '', tools: [skill('s3', 'sample-plan')], timestamp: at(11) },
  { role: 'user', injected: true, text: dump('sample-plan'), timestamp: at(12) },
  { role: 'assistant', text: 'NB_ANSWER2 yes, sample-tool does it.', timestamp: at(13) },
  { role: 'user', text: 'NB_ASK3 and the next step?', timestamp: at(14) },
  { role: 'assistant', text: 'NB_ANSWER3 then ship it.', timestamp: at(15) },
  { role: 'user', injected: true, text: note('sample-lone'), timestamp: at(16) },
];

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined;
      if (!ws) throw new Error('No captured WebSocket');
      ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
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

async function streamTools(page: Page, calls: (readonly [string, string, string?])[]) {
  for (const [id, command, result = 'ok'] of calls) {
    await injectEvent(page, 'session:tool-use', { sessionId: SESSION_ID, toolName: 'Bash', toolUseId: id, input: { command } });
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: id, result });
  }
}

async function mockSession(page: Page, messages: unknown[], status: 'running' | 'idle') {
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
    if (since !== null) return route.fulfill({ json: { messages: messages.slice(Number(since)), cursor: messages.length, delta: true } });
    return route.fulfill({ json: { messages, cursor: messages.length, delta: false } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: 'pw-task-neighbor-fold', project: 'Walnut', process_status: status,
          mode: 'bypass', startedAt: at(0), lastActiveAt: new Date().toISOString(),
          messageCount: messages.length, title: 'Neighbor fold session',
        },
      },
    });
  });
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sessions?id=${SESSION_ID}`);
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`);
  return panel.locator('.session-history');
}

test('a tool run and the injected context after it are one fold row', async ({ page }) => {
  await mockSession(page, history, 'idle');
  const hist = await open(page);
  await expect(hist).toContainText('NB_ANSWER3 then ship it.', { timeout: 15000 });

  // Turn 1 (open: no answer): one process fold holds the run and all four context rows.
  const ask1 = hist.locator('.session-msg', { hasText: 'NB_ASK1' });
  await ask1.scrollIntoViewIfNeeded();
  const fold1 = hist.locator('[data-testid="process-fold"]').first();
  await expect(fold1.locator(':scope > .tool-run-toggle')).toHaveText(/^Ran 3 commands, launched 2 skills, loaded 2 skills, injected context 2×/);
  // No context row of its own anywhere outside a fold before the person's next message.
  const looseContext = await hist.evaluate((el) => [...el.querySelectorAll('.tool-run-label')]
    .filter((n) => /^(Injected context|Loaded skill)/.test(n.textContent ?? '') && !n.closest('[data-testid="process-fold"],[data-testid="turn-fold"]'))
    .map((n) => n.textContent));
  // The lone note after turn 3's answer is the only one.
  expect(looseContext).toEqual(['Injected context']);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-folded.png`, clip: (await hist.boundingBox())! }).catch(() => {});

  // Opened: each step, in order, each still its own row.
  await fold1.locator(':scope > .tool-run-toggle').click();
  await expect(fold1).toContainText('Loaded skill sample-plan');
  await expect(fold1).toContainText('Loaded skill sample-explain');
  await expect(fold1.locator('.tool-run-label', { hasText: /^Injected context$/ })).toHaveCount(2);
  const labels = await fold1.locator('.tool-run-label').allTextContents();
  expect(labels.filter((t) => /^(Injected context|Loaded skill)/.test(t))).toEqual([
    'Injected context', 'Loaded skill sample-plan', 'Injected context', 'Loaded skill sample-explain',
  ]);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-opened.png`, clip: (await hist.boundingBox())! }).catch(() => {});

  // Turn 2 (answered): the steps before the answer are the turn fold, named with the skill.
  const fold2 = hist.locator('[data-testid="turn-fold"]', { has: page.locator('text=/^Ran a command, launched a skill, loaded a skill/') });
  await expect(fold2).toHaveCount(1);
  await expect(hist.locator('.session-msg', { hasText: 'NB_ANSWER2' })).toBeVisible();
});

test('a skill loaded in a live turn joins the turn fold with its stream tools, and the fold stays open when the turn ends', async ({ page }) => {
  const live: Record<string, unknown>[] = [
    ...history.slice(0, 14),
    { role: 'user', text: 'NB_LIVE_ASK /sample-plan go', timestamp: at(20) },
    { role: 'user', injected: true, text: dump('sample-plan'), timestamp: at(21) },
  ];
  await mockSession(page, live, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('NB_LIVE_ASK', { timeout: 15000 });
  await streamTools(page, [['t-live-1', 'make check'], ['t-live-2', 'make test']]);
  // The person's message shows; after it, one row: the loaded skill and both calls.
  await expect(hist.locator('.session-msg', { hasText: 'NB_LIVE_ASK' })).toBeVisible();
  const last = hist.locator('[data-testid="turn-fold"]').last();
  await expect(last.locator(':scope > .tool-run-toggle')).toHaveText(/^Ran 2 commands, loaded a skill/, { timeout: 10000 });
  // Every row after the person's message (the fold is closed, so its steps are not drawn).
  const rowsAfterAsk = () => hist.evaluate((el) => {
    const ask = [...el.querySelectorAll('.session-msg')].find((n) => n.textContent?.includes('NB_LIVE_ASK'))!;
    return [...el.querySelectorAll('.tool-run-label')]
      .filter((n) => ask.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)
      .map((n) => n.textContent);
  });
  expect(await rowsAfterAsk()).toEqual([expect.stringMatching(/^Ran 2 commands, loaded a skill/)]);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-live.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  await last.locator(':scope > .tool-run-toggle').click();
  await expect(last).toContainText('Loaded skill sample-plan');
  await expect(last).toContainText('make check');
  await expect(last).toContainText('make test');
  await page.waitForTimeout(600);

  // The turn ends: history takes the calls and the answer. The same row, still open.
  live.push(
    { role: 'assistant', text: '', tools: [bash('t-live-1', 'make check'), bash('t-live-2', 'make test')], timestamp: at(22) },
    { role: 'assistant', text: 'NB_LIVE_ANSWER all green.', timestamp: at(23) },
  );
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
  await expect(hist).toContainText('NB_LIVE_ANSWER all green.', { timeout: 10000 });
  const after = hist.locator('[data-testid="turn-fold"]').last();
  await expect(after.locator(':scope > .tool-run-toggle')).toHaveText(/^Ran 2 commands, loaded a skill/);
  await expect(after).toHaveAttribute('data-open', 'true');
  await expect(after).toContainText('Loaded skill sample-plan');
  await expect(hist.locator('.session-streaming-panel .tool-run-row')).toHaveCount(0);
  await page.waitForTimeout(600);
});

test('a failed command in history that the live fold takes in is counted in its header', async ({ page }) => {
  const live = [
    { role: 'user', text: 'NB_FAIL_ASK run it', timestamp: at(0) },
    { role: 'assistant', text: '', tools: [{ ...bash('f1', 'make test'), result: 'Error: 2 tests failed', isError: true }], timestamp: at(1) },
    { role: 'assistant', text: '', tools: [skill('f2', 'sample-plan')], timestamp: at(2) },
    { role: 'user', injected: true, text: dump('sample-plan'), timestamp: at(3) },
  ];
  await mockSession(page, live, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('NB_FAIL_ASK', { timeout: 15000 });
  await streamTools(page, [['f3', 'make test']]);
  const fold = hist.locator('[data-testid="turn-fold"]').last();
  await expect(fold.locator(':scope > .tool-run-toggle')).toHaveText(/^Ran 2 commands, launched a skill, loaded a skill/, { timeout: 10000 });
  await expect(fold.locator('.tool-run-fail')).toHaveText('1 failed');
});

test('a skill loaded after words mid-turn stays its own row while the turn runs', async ({ page }) => {
  const live = [
    { role: 'user', text: 'NB_WORDS_ASK run it', timestamp: at(0) },
    { role: 'assistant', text: 'NB_WORDS first I load the plan.', timestamp: at(1) },
    { role: 'user', injected: true, text: dump('sample-plan'), timestamp: at(2) },
  ];
  await mockSession(page, live, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('NB_WORDS first', { timeout: 15000 });
  await streamTools(page, [['w1', 'make check']]);
  await expect(hist.locator('.tool-run-label', { hasText: /^Ran a command$/ })).toHaveCount(1, { timeout: 10000 });
  // Words stay on screen; the skill row is not folded behind them.
  await expect(hist.locator('.session-msg', { hasText: 'NB_WORDS first' })).toBeVisible();
  await expect(hist.locator('.tool-run-label', { hasText: 'Loaded skill sample-plan' })).toBeVisible();
  await expect(hist.locator('[data-testid="turn-fold"]')).toHaveCount(0);
});
