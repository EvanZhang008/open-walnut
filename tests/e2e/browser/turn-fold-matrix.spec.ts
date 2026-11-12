/**
 * Every step of a turn before its final answer is ONE fold row, whatever the
 * steps are and however the turn reached the screen (2026-11-11, the user, on a
 * live turn whose sent card and received message sat outside the fold: "why
 * still not collpes, can we test all the cases?", then "If they are togter they
 * need ot be collpesed").
 *
 * The matrix: each kind of step (a command, a file read and edit, reasoning,
 * words between steps, a send to one task and to several, a received message, a
 * Walnut op, a subagent), alone and mixed, times how the turn is drawn (saved,
 * live, a panel opened mid-turn, a live turn that just ended, a turn a notice cut
 * into), times the view (plain, and Conversation Mode, which a side thread turns
 * on), each checked folded and opened. Checked every time:
 *   - between the person's words and the final answer there is one row, the fold
 *     (the live line under it is the fold's own);
 *   - every row is at most two lines tall, folded or opened;
 *   - no shell placeholder (`$f`) reaches the screen.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockSession, open, waitForWs, injectEvent, setMockStream, MOCK_SESSION_ID } from './mock-session-harness';

test.describe.configure({ mode: 'parallel', timeout: 90_000 });

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
type Row = Record<string, unknown>;
type Block = Record<string, unknown>;

/** One step: its saved row, and the stream blocks a live turn drew for it. */
interface Step { row: Row; blocks: Block[] }

// Tasks of the fixture, so the card names them.
const TARGETS = ['pw-task-001', 'pw-task-vscode', 'pw-task-tags'];
const loopSend = `for f in ${TARGETS.map((t) => `/tmp/mx/go_${t}.json`).join(' ')}; do walnut tools call task_send @$f 2>&1 | head -1; done`;
const loopResult = TARGETS.map((t) => `Message delivered on this host to ${t}`).join('\n');
const notice = (k: number) => `<walnut-message kind="notification" from="Walnut" about="Sample canary [c82${k}]" about-task="eeee555${k}" outcome="waiting" note="automated Walnut status notice">\nYour subtask set itself to WAITING.\n</walnut-message>`;

function toolStep(k: number, name: string, input: Record<string, unknown>, result = 'ok'): Step {
  const id = `mx-t${k}`;
  return {
    row: { role: 'assistant', text: '', msgId: `mx-m${k}`, timestamp: at(20 + k), tools: [{ name, toolUseId: id, input, result }] },
    blocks: [{ type: 'tool_call', toolUseId: id, name, input, status: 'done', result, msgId: `mx-m${k}` }],
  };
}

const KINDS: Record<string, (k: number) => Step> = {
  command: (k) => toolStep(k, 'Bash', { command: `sample-cmd --step ${k}` }),
  read: (k) => toolStep(k, 'Read', { file_path: `/tmp/mx/file-${k}.ts` }, 'line one\nline two'),
  edit: (k) => toolStep(k, 'Edit', { file_path: `/tmp/mx/file-${k}.ts`, old_string: 'one', new_string: 'two' }, 'The file was edited'),
  thinking: (k) => ({
    row: { role: 'assistant', text: '', thinking: `MX_THINK_${k} weighing the next step.`, msgId: `mx-m${k}`, timestamp: at(20 + k) },
    blocks: [{ type: 'thinking', content: `MX_THINK_${k} weighing the next step.`, msgId: `mx-m${k}` }],
  }),
  words: (k) => ({
    row: { role: 'assistant', text: `MX_WORDS_${k} Checking the build next.`, msgId: `mx-m${k}`, timestamp: at(20 + k) },
    blocks: [{ type: 'text', content: `MX_WORDS_${k} Checking the build next.`, msgId: `mx-m${k}` }],
  }),
  send: (k) => toolStep(k, 'Bash', { command: `walnut tools call task_send '{"to":"pw-task-001","title":"MX_SEND_${k} go ahead","text":"Go ahead with the plan."}'` }, 'Message delivered on this host to pw-task-001'),
  'send-several': (k) => toolStep(k, 'Bash', { command: loopSend }, loopResult),
  received: (k) => ({
    row: { role: 'user', text: notice(k), timestamp: at(20 + k), msgId: `queue-n${k}`, walnutMessageId: `sn-${k}` },
    blocks: [],
  }),
  op: (k) => toolStep(k, 'mcp__walnut__thread_update', { thread_id: `th-${k}`, state: 'working', title: `MX_OP_${k} thread` }, '{"ok":true}'),
  subagent: (k) => toolStep(k, 'Agent', { description: `MX_AGENT_${k} look around`, prompt: 'Look around the repo.', subagent_type: 'Explore' }, 'Nothing odd.'),
};

/** The step sets: each kind alone (twice, so a run of one kind is checked), every
 *  kind mixed, and mixed kinds that end on a received notice. */
const SETS: Record<string, string[]> = {
  ...Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, [kind, kind]])),
  mixed: ['command', 'received', 'edit', 'send-several', 'thinking', 'words', 'op', 'read', 'send', 'subagent'],
  'ends-on-notice': ['command', 'command', 'send-several', 'received'],
};

const PRIOR: Row[] = [
  { role: 'user', text: 'MX_PRIOR_ASK an earlier question', timestamp: at(0), msgId: 'mx-u0' },
  { role: 'assistant', text: 'MX_PRIOR_ANSWER an earlier answer.', timestamp: at(5), msgId: 'mx-a0' },
];
const ASK: Row = { role: 'user', text: 'MX_ASK please do the work', timestamp: at(10), msgId: 'mx-u1' };
const FINAL: Row = { role: 'assistant', text: 'MX_FINAL all done.', timestamp: at(90), msgId: 'mx-fin' };

function build(set: string[]) {
  const steps = set.map((kind, i) => KINDS[kind](i + 1));
  return { rows: steps.map((s) => s.row), blocks: steps.flatMap((s) => s.blocks) };
}

/** A question asked earlier (its anchor on the session record): Conversation Mode is on,
 *  and the question's exchange folds to its label line above the turn. */
const QUESTION: Row[] = [
  { role: 'user', text: 'MX_SIDE what does the earlier answer mean?', timestamp: at(6), msgId: 'mx-q1' },
  { role: 'assistant', text: 'MX_SIDE_ANSWER it means this.', timestamp: at(7), msgId: 'mx-q1a' },
];
const QUESTION_RECORD = { threadAnchors: [{ msgId: 'mx-q1', parent: 'mx-a0', quote: { exact: 'an earlier answer' }, source: 'selection', at: at(6) }] };

/** The history's top-level rows in order: what the reader scrolls past. */
async function topRows(history: Locator) {
  return history.evaluate((h) => {
    // The panel's own status line under the history ("Claude Code is working… 4s") is not a row of the turn.
    const sel = '[data-msg-index], .session-live-row > *:not(.session-working-row), .session-msg-bare, [data-testid="turn-fold"]';
    return Array.from(h.querySelectorAll(sel))
      .filter((e) => !e.parentElement?.closest(sel) && (e as HTMLElement).offsetParent !== null)
      .map((e) => {
        const r = e.getBoundingClientRect();
        // The turn's fold sits in a wrapper row of its own.
        const testid = e.getAttribute('data-testid') ?? (e.querySelector(':scope > [data-testid="turn-fold"]') ? 'turn-fold' : '');
        // innerText reads empty while WebKit has not laid the row out for text yet; its words are the same.
        const words = (e as HTMLElement).innerText || e.textContent || '';
        return { testid, cls: e.className.toString(), text: words.replace(/\s+/g, ' ').trim().slice(0, 160), height: Math.round(r.height) };
      })
      .filter((r) => r.height > 0);
  });
}

/** The step rows inside the open fold, each still closed: every full-width row button
 *  (a call's header, a run's line, a card, reasoning, folded words) not inside another row. */
async function foldStepRows(fold: Locator) {
  return fold.evaluate((f) => {
    const body = f.querySelector(':scope > .process-fold-body') as HTMLElement | null;
    if (!body) return [];
    const width = body.getBoundingClientRect().width;
    return Array.from(body.querySelectorAll('button, [role="button"], .provenance-card'))
      .filter((e) => (e as HTMLElement).offsetParent !== null && e.getBoundingClientRect().width > width * 0.6)
      .filter((e) => !e.parentElement?.closest('button, [role="button"], .provenance-card'))
      .map((e) => ({ cls: e.className.toString(), text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 120), height: Math.round(e.getBoundingClientRect().height) }));
  });
}

/** Two lines of 14 px text with the row's padding. */
const TWO_LINES = 60;
const PLACEHOLDER = /\$[A-Za-z_{(]/;

/** Between the person's words and the final answer: ONE row. A turn of several kinds of
 *  steps is the turn's fold; a turn of one step (a run of one kind of call, one reasoning)
 *  is that step's own closed row. Returns whether it is the turn's fold. */
async function expectOneFold(history: Locator, label: string, opened = false): Promise<boolean> {
  const rows = await topRows(history);
  const ask = rows.findIndex((r) => r.text.includes('MX_ASK'));
  expect(ask, `${label}: the person's words are on screen\n${JSON.stringify(rows, null, 1)}`).toBeGreaterThanOrEqual(0);
  const fin = rows.findIndex((r) => r.text.includes('MX_FINAL'));
  const between = rows.slice(ask + 1, fin < 0 ? undefined : fin);
  expect(between.length, `${label}: one row between the words and the answer\n${JSON.stringify(between, null, 1)}`).toBe(1);
  const isFold = between[0]!.testid === 'turn-fold';
  // An open fold is as tall as its steps: its own line and each step are checked in foldStepRows.
  const tall = between.filter((r) => r.height > TWO_LINES && !(isFold && opened));
  expect(tall, `${label}: rows taller than two lines`).toEqual([]);
  expect(between.map((r) => r.text).join('\n'), `${label}: a shell placeholder on screen`).not.toMatch(PLACEHOLDER);
  // After the answer the turn is over: no step of it is drawn again below it.
  if (fin >= 0) expect(rows.slice(fin + 1).filter((r) => r.testid === 'turn-fold' || /sample-cmd|MX_/.test(r.text)), `${label}: a step after the answer`).toEqual([]);
  return isFold;
}

/** Steps a run row takes ("Ran 3 tools ›"): calls and the reasoning between them. */
const RUN_KINDS = new Set(['command', 'read', 'edit', 'thinking', 'op']);

async function checkBothWays(page: Page, history: Locator, label: string, set: string[]) {
  const isFold = await expectOneFold(history, `${label}, folded`);
  // Steps that are all one run's (calls and reasoning), or one kind of step: that one
  // closed row is the whole turn.
  if (!isFold) {
    expect(set.every((k) => RUN_KINDS.has(k)) || new Set(set).size === 1, `${label}: only a run or one kind of step is a lone row`).toBe(true);
    return;
  }
  const fold = history.locator('[data-testid="turn-fold"]').last();
  await fold.locator(':scope > .tool-run-toggle').click();
  await expect(fold.locator(':scope > .process-fold-body')).toBeVisible();
  await page.waitForTimeout(200);
  await expectOneFold(history, `${label}, opened`, true);
  const steps = await foldStepRows(fold);
  expect(steps.length, `${label}: the open fold lists its steps\n${JSON.stringify(steps, null, 1)}`).toBeGreaterThan(0);
  expect(steps.filter((s) => s.height > TWO_LINES), `${label}: open fold rows taller than two lines`).toEqual([]);
  // A step drawn twice (its live block beside its saved row) shows the same line twice.
  const texts = steps.map((s) => s.text).filter((t) => /MX_|sample-cmd|file-\d|go_/.test(t));
  expect(texts.filter((t, k) => texts.indexOf(t) !== k), `${label}: a step drawn twice`).toEqual([]);
  expect(steps.map((s) => s.text).join('\n'), `${label}: a shell placeholder in the open fold`).not.toMatch(PLACEHOLDER);
  await fold.locator(':scope > .tool-run-toggle').click();
  await expect(fold.locator(':scope > .process-fold-body')).toHaveCount(0);
}

// stream-only: nothing of the turn is saved yet, every step so far is the stream's (a
// received message is a saved row, so that state has none).
type State = 'saved' | 'live' | 'opened-mid-turn' | 'just-ended' | 'notice-cut-in' | 'stream-only';
const STATES: State[] = ['saved', 'live', 'opened-mid-turn', 'just-ended', 'notice-cut-in', 'stream-only'];

async function run(page: Page, set: string[], state: State, conv: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? ''}`));
  // A render error the panel's boundary caught reaches only the console.
  page.on('console', (m) => { if (m.type() === 'error' && /error-boundary|\[react\]|Error:/.test(m.text())) errors.push(m.text()); });
  const { rows, blocks } = build(set);
  const live = { type: 'tool_call', toolUseId: 'mx-live', name: 'Bash', input: { command: 'sample-cmd --last' }, status: 'calling' };
  const before = conv ? [...PRIOR, ...QUESTION] : PRIOR;
  const messages: Row[] = state === 'saved' ? [...before, ASK, ...rows, FINAL]
    : state === 'stream-only' ? [...before, ASK]
    : state === 'notice-cut-in' ? [...before, ASK, ...rows, { role: 'user', text: notice(9), timestamp: at(80), msgId: 'queue-n9', walnutMessageId: 'sn-9' }]
      : [...before, ASK, ...rows];
  // A running turn's stream says so from the start; 'live' and 'notice-cut-in' have history
  // caught up with every step so far, and the next call comes in after the panel opened.
  const stream = state === 'opened-mid-turn' || state === 'just-ended' || state === 'stream-only' ? { blocks: [...blocks, live], isStreaming: true }
    : state === 'live' || state === 'notice-cut-in' ? { blocks: [], isStreaming: true } : undefined;
  await mockSession(page, messages, state === 'saved' ? 'idle' : 'running', stream, conv ? QUESTION_RECORD : {});
  const history = await open(page);
  await waitForWs(page);
  await expect(history).toContainText('MX_ASK', { timeout: 15000 }).catch((e) => { throw new Error(`${e.message}\npage errors:\n${errors.join('\n')}`); });
  // Conversation Mode: the question's exchange is its label line.
  if (conv) await expect(history.locator('[data-thread-fold]')).toHaveCount(1, { timeout: 10000 });
  if (state === 'live' || state === 'notice-cut-in') {
    await injectEvent(page, 'session:tool-use', { sessionId: MOCK_SESSION_ID, toolName: 'Bash', toolUseId: 'mx-live', input: { command: 'sample-cmd --last' } });
  }
  if (state === 'just-ended') {
    await expect(history.locator('[data-testid="turn-fold"]')).toHaveCount(1, { timeout: 10000 });
    messages.push({ role: 'assistant', text: '', msgId: 'mx-mlast', timestamp: at(85), tools: [{ name: 'Bash', toolUseId: 'mx-live', input: { command: 'sample-cmd --last' }, result: 'ok' }] }, FINAL);
    await setMockStream(page, { blocks: [], isStreaming: false });
    await injectEvent(page, 'session:tool-result', { sessionId: MOCK_SESSION_ID, toolUseId: 'mx-live', result: 'ok' });
    await injectEvent(page, 'session:result', { sessionId: MOCK_SESSION_ID, result: 'done', isError: false });
    await injectEvent(page, 'session:batch-completed', { sessionId: MOCK_SESSION_ID, count: 1 });
  }
  if (state === 'saved' || state === 'just-ended') await expect(history).toContainText('MX_FINAL', { timeout: 10000 });
  await page.waitForTimeout(800);
  const drawn = state === 'stream-only' ? set.filter((k) => k !== 'received') : set;
  await checkBothWays(page, history, `${set.join('+')} / ${state}${conv ? ' / conversation mode' : ''}`, state === 'saved' ? drawn : [...drawn, 'command']);
  expect(errors, 'no page errors').toEqual([]);
}

for (const conv of [false, true]) {
  for (const [name, set] of Object.entries(SETS)) {
    for (const state of STATES) {
      // Saved rows that end in words before a notice are a finished turn by the transcript's
      // own record (turn-shape.ts): its last words are its answer, not a step.
      if (state === 'notice-cut-in' && set[set.length - 1] === 'words') continue;
      test(`${conv ? 'conversation mode' : 'plain'} · ${name} · ${state}`, async ({ page }) => {
        await run(page, set, state, conv);
      });
    }
  }
}

// A send to several tasks is one row that says how many; the names are in the open card.
test('a send to several tasks reads "To 3 tasks" and lists them open', async ({ page }) => {
  const { rows } = build(['send-several']);
  await mockSession(page, [...PRIOR, ASK, ...rows, FINAL], 'idle');
  const history = await open(page);
  await expect(history).toContainText('MX_FINAL', { timeout: 15000 });
  const fold = history.locator('[data-testid="turn-fold"]').last();
  await fold.locator(':scope > .tool-run-toggle').click();
  const card = fold.locator('.provenance-card.op-card').first();
  await expect(card.locator('.op-card-to')).toContainText(/To\s*3 tasks/);
  await expect(card.locator('.op-card-to .op-card-to-pill')).toHaveCount(0);
  await card.locator('.op-card-main').click();
  await expect(card.locator('.op-card-recipients .op-card-to-pill')).toHaveCount(3);
  // What the card shows (its raw command, under "Command & response", is the command as typed).
  expect(await card.evaluate((e) => (e as HTMLElement).innerText)).not.toMatch(PLACEHOLDER);
});

/** A call a rule refused: the person must act on it, so it stands outside the fold. */
function deniedStep(k: number): Step {
  const id = `mx-t${k}`;
  const input = { command: `sample-cmd --denied ${k}` };
  const result = 'Permission to use Bash has been denied.';
  return {
    row: { role: 'assistant', text: '', msgId: `mx-m${k}`, timestamp: at(20 + k), tools: [{ name: 'Bash', toolUseId: id, input, result, isError: true }] },
    blocks: [{ type: 'tool_call', toolUseId: id, name: 'Bash', input, status: 'error', result, msgId: `mx-m${k}` }],
  };
}

/** Rows between the person's words and the answer that are not inside the turn's fold. */
async function outsideFold(history: Locator, selector: string) {
  return history.locator(selector).evaluateAll((els) => els.filter((e) => !e.closest('[data-testid="turn-fold"]') && (e as HTMLElement).offsetParent !== null).length);
}

for (const live of [false, true]) {
  test(`a step a rule refused stands outside the fold, ${live ? 'while the turn runs' : 'saved'}`, async ({ page }) => {
    const steps = [KINDS.command(1), deniedStep(2), KINDS.edit(3)];
    const rows = steps.map((x) => x.row);
    const stream = { blocks: [...steps.flatMap((x) => x.blocks), { type: 'tool_call', toolUseId: 'mx-live', name: 'Bash', input: { command: 'sample-cmd --last' }, status: 'calling' }], isStreaming: true };
    await mockSession(page, live ? [...PRIOR, ASK, ...rows] : [...PRIOR, ASK, ...rows, FINAL], live ? 'running' : 'idle', live ? stream : undefined);
    const history = await open(page);
    await expect(history).toContainText('MX_ASK', { timeout: 15000 });
    if (!live) await expect(history).toContainText('MX_FINAL', { timeout: 10000 });
    // The steps fold (a turn fold, or one run row when they are all calls); the refused one
    // is also drawn above, where it is seen.
    await expect.poll(() => outsideFold(history, '[data-testid="lifted-step"]')).toBe(1);
    await expect(history.locator('[data-testid="lifted-step"]')).toContainText(/denied|sample-cmd/i);
  });
}

test('long words in the middle of a turn are read, not folded', async ({ page }) => {
  const long = 'MX_LONG here is what I found:\n\n- first finding\n- second finding\n- third finding\n- fourth finding';
  const rows: Row[] = [KINDS.command(1).row, { role: 'assistant', text: long, msgId: 'mx-m2', timestamp: at(22) }, KINDS.edit(3).row];
  await mockSession(page, [...PRIOR, ASK, ...rows, FINAL], 'idle');
  const history = await open(page);
  await expect(history).toContainText('MX_FINAL', { timeout: 15000 });
  const words = history.getByText('MX_LONG here is what I found');
  await expect(words).toBeVisible();
  expect(await words.evaluate((e) => !!e.closest('[data-testid="turn-fold"]'))).toBe(false);
});

// A fold the reader opened while the turn ran stays open when the turn is saved.
test('a fold opened mid-turn stays open when the turn ends', async ({ page }) => {
  const { rows, blocks } = build(['command', 'send-several', 'words', 'edit']);
  const live = { type: 'tool_call', toolUseId: 'mx-live', name: 'Bash', input: { command: 'sample-cmd --last' }, status: 'calling' };
  const messages: Row[] = [...PRIOR, ASK];
  await mockSession(page, messages, 'running', { blocks: [...blocks, live], isStreaming: true });
  const history = await open(page);
  await waitForWs(page);
  const fold = history.locator('[data-testid="turn-fold"]');
  await expect(fold).toHaveCount(1, { timeout: 15000 });
  await fold.locator(':scope > .tool-run-toggle').click();
  await expect(fold.locator(':scope > .process-fold-body')).toBeVisible();
  messages.push(...rows, { role: 'assistant', text: '', msgId: 'mx-mlast', timestamp: at(85), tools: [{ name: 'Bash', toolUseId: 'mx-live', input: { command: 'sample-cmd --last' }, result: 'ok' }] }, FINAL);
  await setMockStream(page, { blocks: [], isStreaming: false });
  await injectEvent(page, 'session:tool-result', { sessionId: MOCK_SESSION_ID, toolUseId: 'mx-live', result: 'ok' });
  await injectEvent(page, 'session:result', { sessionId: MOCK_SESSION_ID, result: 'done', isError: false });
  await injectEvent(page, 'session:batch-completed', { sessionId: MOCK_SESSION_ID, count: 1 });
  await expect(history).toContainText('MX_FINAL', { timeout: 10000 });
  await page.waitForTimeout(800);
  await expect(history.locator('[data-testid="turn-fold"]')).toHaveCount(1);
  await expect(history.locator('[data-testid="turn-fold"] > .process-fold-body')).toBeVisible();
});
