/**
 * Every step of a turn before its final answer is ONE fold row, whatever the
 * steps are and however the turn reached the screen (2026-11-11, the user, on a
 * live turn whose sent card and received message sat outside the fold: "why
 * still not collpes, can we test all the cases?", then "If they are togter they
 * need ot be collpesed").
 *
 * The matrix: each kind of step (a command, a file read and edit, reasoning,
 * words between steps, a send to one task and to several, a received message, a
 * runtime notice, a Walnut op, a subagent), alone and mixed, times how the turn is drawn (saved,
 * live, a panel opened mid-turn, a live turn that just ended, a turn a notice cut
 * into), times the view (plain, and Conversation Mode, which a side thread turns
 * on), each checked folded and opened. Checked every time:
 *   - between the person's words and the final answer there is one row, the fold
 *     (the live line under it is the fold's own);
 *   - every row is at most two lines tall, folded or opened;
 *   - no shell placeholder (`$f`) reaches the screen.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { findChord } from './page-find-helpers';
import { mockSession, open, waitForWs, waitForStream, injectEvent, setMockStream, MOCK_SESSION_ID } from './mock-session-harness';

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
  // A line the runtime wrote mid-turn (a retry notice): a step like any other.
  notice: (k) => ({
    row: { role: 'system', systemVariant: 'info', text: `MX_NOTE_${k} Retrying after an upstream error.`, msgId: `mx-m${k}`, timestamp: at(20 + k) },
    blocks: [{ type: 'system', variant: 'info', message: `MX_NOTE_${k} Retrying after an upstream error.`, uuid: `mx-m${k}` }],
  }),
  op: (k) => toolStep(k, 'mcp__walnut__thread_update', { thread_id: `th-${k}`, state: 'working', title: `MX_OP_${k} thread` }, '{"ok":true}'),
  subagent: (k) => toolStep(k, 'Agent', { description: `MX_AGENT_${k} look around`, prompt: 'Look around the repo.', subagent_type: 'Explore' }, 'Nothing odd.'),
};

/** The step sets: each kind twice (a run of one kind) and once (a lone step: 2026-11-12,
 *  the user: "event one shoudol be collpesed", "to keep ti simple clean"), every kind
 *  mixed, and mixed kinds that end on a received notice. */
const SETS: Record<string, string[]> = {
  ...Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, [kind, kind]])),
  ...Object.fromEntries(Object.keys(KINDS).map((kind) => [`one ${kind}`, [kind]])),
  mixed: ['command', 'received', 'edit', 'send-several', 'thinking', 'words', 'notice', 'op', 'read', 'send', 'subagent'],
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
    return Array.from(body.querySelectorAll('button, [role="button"], .provenance-card, .session-system-line'))
      .filter((e) => (e as HTMLElement).offsetParent !== null && e.getBoundingClientRect().width > width * 0.6)
      .filter((e) => !e.parentElement?.closest('button, [role="button"], .provenance-card, .session-system-line'))
      .map((e) => ({ cls: e.className.toString(), text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 120), height: Math.round(e.getBoundingClientRect().height) }));
  });
}

/** Two lines of 14 px text with the row's padding. */
const TWO_LINES = 60;
const PLACEHOLDER = /\$[A-Za-z_{(]/;

/** Between the person's words and the final answer: ONE row, the turn's fold, whatever
 *  and however many the steps are. Returns whether it is the turn's fold. */
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

/** Every shut row (a turn's fold, a run) draws its line and nothing under it, running or not:
 *  the step it is on shows only once the reader opens it (2026-11-14, the user: "Even not
 *  showing the currently working command, below collpes, if people need people cna click intop"). */
async function expectShutRowsLineOnly(history: Locator, label: string) {
  const extra = await history.evaluate((h) => Array.from(h.querySelectorAll('.tool-run-row'))
    .filter((row) => row.querySelector(':scope > .tool-run-toggle[aria-expanded="false"]'))
    .flatMap((row) => Array.from(row.children).filter((c) => !c.classList.contains('tool-run-toggle'))
      .map((c) => `${row.getAttribute('data-testid') ?? 'run'}: ${(c as HTMLElement).innerText.slice(0, 80)}`)));
  expect(extra, `${label}: something drawn under a shut row`).toEqual([]);
}

async function checkBothWays(page: Page, history: Locator, label: string, _set: string[]) {
  await expectShutRowsLineOnly(history, label);
  const isFold = await expectOneFold(history, `${label}, folded`);
  // A run of calls, or one step alone, is the turn's fold too, never a row of its own.
  expect(isFold, `${label}: the row between the words and the answer is the turn's fold`).toBe(true);
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
    // Sent once the panel holds the stream: on a busy machine an event sent before it subscribed is lost.
    await waitForStream(page);
    await page.waitForTimeout(300);
    await injectEvent(page, 'session:tool-use', { sessionId: MOCK_SESSION_ID, toolName: 'Bash', toolUseId: 'mx-live', input: { command: 'sample-cmd --last' } });
    // The new call is in the shut fold, not under it: open it to see it came in, then shut it.
    const live = history.locator('[data-testid="turn-fold"]').last();
    await live.locator(':scope > .tool-run-toggle').click();
    await expect(live.locator(':scope > .process-fold-body')).toContainText('sample-cmd --last', { timeout: 10000 });
    await live.locator(':scope > .tool-run-toggle').click();
    await expect(live).toHaveAttribute('data-open', 'false');
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

// A turn that came to an error line (no answer after it) ends there: its steps fold, the
// error is what the person acts on, so it shows under the fold. Alone too.
for (const before of [['command', 'received'], []] as string[][]) {
  test(`a turn that ends on an error line shows the line, ${before.length ? 'after its steps' : 'alone'}`, async ({ page }) => {
    const { rows } = build(before);
    const error: Row = { role: 'system', systemVariant: 'error', text: 'MX_ERROR Error during compaction: API Error: 400 Input is too long.', timestamp: at(80) };
    await mockSession(page, [...PRIOR, ASK, ...rows, error], 'idle');
    const history = await open(page);
    await expect(history).toContainText('MX_ASK', { timeout: 15000 });
    const line = history.getByText(/MX_ERROR Error during compaction/);
    await expect(line).toBeVisible();
    expect(await line.evaluate((e) => !!e.closest('[data-testid="turn-fold"]'))).toBe(false);
    await expect(history.locator('[data-testid="turn-fold"]')).toHaveCount(before.length ? 1 : 0);
  });
}

// A runtime line left in the stream after the turn is over (no saved twin) is no running
// turn: it shows as its own line, an error in red, never a closed "1 notice" fold.
for (const variant of ['info', 'error'] as const) {
  test(`a runtime ${variant} line after the turn ended shows as its own line`, async ({ page }) => {
    const message = `MX_LEFT ${variant === 'error' ? 'Execution error' : 'Waiting for the endpoint'}`;
    await mockSession(page, [...PRIOR, ASK, FINAL], 'idle', { blocks: [{ type: 'system', variant, message }], isStreaming: false });
    const history = await open(page);
    await expect(history).toContainText('MX_FINAL', { timeout: 15000 });
    const line = history.getByText(message);
    await expect(line).toBeVisible();
    expect(await line.evaluate((e) => !!e.closest('[data-testid="turn-fold"]'))).toBe(false);
  });
}

// A reply the reader watched stream keeps its row after the turn ends; the short words on
// the way to it stay in the fold, saved as they were live (2026-11-12: they showed again).
test('words before a step stay folded when the answer the reader watched stream is saved', async ({ page }) => {
  const words: Row = { role: 'assistant', text: 'MX_LEAD let me check.', msgId: 'mx-lead', timestamp: at(20), tools: [{ name: 'Bash', toolUseId: 'mx-t1', input: { command: 'sample-cmd --one' }, result: 'ok' }] };
  const messages: Row[] = [...PRIOR, ASK];
  await mockSession(page, messages, 'running', { blocks: [], isStreaming: true });
  const history = await open(page);
  await waitForWs(page);
  await waitForStream(page);
  await page.waitForTimeout(300);
  await injectEvent(page, 'session:text-delta', { sessionId: MOCK_SESSION_ID, delta: 'MX_LEAD let me check.', msgId: 'mx-lead' });
  await injectEvent(page, 'session:tool-use', { sessionId: MOCK_SESSION_ID, toolName: 'Bash', toolUseId: 'mx-t1', input: { command: 'sample-cmd --one' }, msgId: 'mx-lead' });
  await injectEvent(page, 'session:tool-result', { sessionId: MOCK_SESSION_ID, toolUseId: 'mx-t1', result: 'ok' });
  await injectEvent(page, 'session:text-delta', { sessionId: MOCK_SESSION_ID, delta: 'MX_FINAL all done.', msgId: 'mx-fin' });
  await expect(history).toContainText('MX_FINAL', { timeout: 10000 });
  const lead = history.getByText('MX_LEAD let me check.');
  await expect(lead).toBeHidden();
  messages.push(words, FINAL);
  await setMockStream(page, { blocks: [], isStreaming: false });
  await injectEvent(page, 'session:result', { sessionId: MOCK_SESSION_ID, result: 'done', isError: false });
  await injectEvent(page, 'session:batch-completed', { sessionId: MOCK_SESSION_ID, count: 1 });
  await page.waitForTimeout(1200);
  await expect(history.locator('[data-testid="turn-fold"]')).toHaveCount(1);
  await expect(lead).toBeHidden();
  await expect(history.getByText('MX_FINAL all done.')).toBeVisible();
});

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
// Also a new session's first turn, with nothing saved yet (2026-11-12: it drew the old run row).
for (const first of [false, true]) test(`a fold opened mid-turn stays open when the turn ends${first ? ', a new session\'s first turn' : ''}`, async ({ page }) => {
  const { rows, blocks } = build(['command', 'send-several', 'words', 'edit']);
  const live = { type: 'tool_call', toolUseId: 'mx-live', name: 'Bash', input: { command: 'sample-cmd --last' }, status: 'calling' };
  const messages: Row[] = first ? [] : [...PRIOR, ASK];
  await mockSession(page, messages, 'running', { blocks: [...blocks, live], isStreaming: true });
  const history = await open(page);
  await waitForWs(page);
  const fold = history.locator('[data-testid="turn-fold"]');
  await expect(fold).toHaveCount(1, { timeout: 15000 });
  await expect(fold.locator(':scope > .tool-run-toggle')).toContainText(/^Working/);
  await expect(history.locator('.tool-run-row:not([data-testid="turn-fold"]):visible')).toHaveCount(0);
  await fold.locator(':scope > .tool-run-toggle').click();
  await expect(fold.locator(':scope > .process-fold-body')).toBeVisible();
  if (first) messages.push(ASK);
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

// An answer's own reasoning, with no step before it: a fold of its own above the answer
// (the reported screen: one Thinking row with its preview between his words and the answer).
for (const live of [false, true]) {
  test(`an answer's own reasoning alone is folded, ${live ? 'while it streams' : 'saved'}`, async ({ page }) => {
    const answer: Row = { role: 'assistant', text: 'MX_FINAL all done.', thinking: 'MX_OWN_THOUGHT tracing the loop first.', msgId: 'mx-fin', timestamp: at(90) };
    const stream = { blocks: [
      { type: 'thinking', content: 'MX_OWN_THOUGHT tracing the loop first.', msgId: 'mx-fin' },
      { type: 'text', content: 'MX_FINAL all done.', msgId: 'mx-fin' },
    ], isStreaming: true };
    await mockSession(page, live ? [...PRIOR, ASK] : [...PRIOR, ASK, answer], live ? 'running' : 'idle', live ? stream : undefined);
    const history = await open(page);
    await expect(history).toContainText('MX_FINAL', { timeout: 15000 });
    await page.waitForTimeout(800);
    await checkBothWays(page, history, `own reasoning / ${live ? 'live' : 'saved'}`, ['thinking']);
    // Saved, its preview is not on screen until the fold is opened (live, the fold's one
    // live line is what it thinks now).
    if (!live) await expect(history.getByText('MX_OWN_THOUGHT')).toBeHidden();
  });
}

// F2: a turn of calls only, with no words and no answer, is the turn's ONE fold while it runs,
// and stays that fold (same row, open if the reader opened it) once it ends with no answer:
// never a bare run row (2026-11-13, the user's rule: "event one shoudol be collpesed").
// Opened by the person's words, by a received notice, and in Conversation Mode; one call and several.
for (const opener of ['person', 'notice', 'conversation'] as const) {
  for (const calls of [1, 3]) {
    test(`F2 · a calls-only turn is one fold live and after it ends with no answer · ${opener} · ${calls} call${calls > 1 ? 's' : ''}`, async ({ page }) => {
      const steps = Array.from({ length: calls }, (_, i) => KINDS.command(i + 1));
      const live = { type: 'tool_call', toolUseId: 'mx-live', name: 'Bash', input: { command: 'sample-cmd --last' }, status: 'calling', msgId: 'mx-mlast' };
      const start: Row = opener === 'notice' ? { role: 'user', text: notice(1), timestamp: at(10), msgId: 'queue-n1', walnutMessageId: 'sn-1' } : ASK;
      const before = opener === 'conversation' ? [...PRIOR, ...QUESTION] : PRIOR;
      const messages: Row[] = [...before, start];
      await mockSession(page, messages, 'running', { blocks: [...steps.flatMap((s) => s.blocks), live], isStreaming: true }, opener === 'conversation' ? QUESTION_RECORD : {});
      const history = await open(page);
      await waitForWs(page);
      if (opener === 'conversation') await expect(history.locator('[data-thread-fold]')).toHaveCount(1, { timeout: 10000 });
      const fold = history.locator('[data-testid="turn-fold"]');
      await expect(fold).toHaveCount(1, { timeout: 15000 });
      await expect(fold.locator(':scope > .tool-run-toggle')).toContainText(/^Working/);
      // No run row, card or call of the turn outside its fold.
      const loose = () => history.evaluate((h) => Array.from(h.querySelectorAll('.tool-run-row, .session-tool-call, [data-testid="session-step-group-row"]'))
        .filter((e) => (e as HTMLElement).offsetParent !== null && !e.closest('[data-testid="turn-fold"]') && !e.closest('[data-thread-fold]') && !e.querySelector('[data-testid="turn-fold"]'))
        .map((e) => (e as HTMLElement).innerText.slice(0, 80)));
      expect(await loose(), 'live: a step outside the fold').toEqual([]);
      // Shut while it runs: only its line, the running command not under it.
      await expectShutRowsLineOnly(history, 'live');
      await expect(history).not.toContainText('sample-cmd --last');
      const key = await fold.getAttribute('data-fold-id');
      await fold.locator(':scope > .tool-run-toggle').click();
      await expect(fold.locator(':scope > .process-fold-body')).toBeVisible();
      // The turn ends on its last call: saved with no answer after it.
      messages.push(...steps.map((s) => s.row), { role: 'assistant', text: '', msgId: 'mx-mlast', timestamp: at(85), tools: [{ name: 'Bash', toolUseId: 'mx-live', input: { command: 'sample-cmd --last' }, result: 'ok' }] });
      await setMockStream(page, { blocks: [], isStreaming: false });
      await injectEvent(page, 'session:tool-result', { sessionId: MOCK_SESSION_ID, toolUseId: 'mx-live', result: 'ok' });
      await injectEvent(page, 'session:result', { sessionId: MOCK_SESSION_ID, result: '', isError: false });
      await injectEvent(page, 'session:batch-completed', { sessionId: MOCK_SESSION_ID, count: 1 });
      await expect(fold.locator(':scope > .tool-run-toggle')).not.toContainText(/^Working/, { timeout: 10000 });
      await page.waitForTimeout(800);
      await expect(fold).toHaveCount(1);
      expect(await fold.getAttribute('data-fold-id'), 'the saved fold is the live one').toBe(key);
      await expect(fold.locator(':scope > .process-fold-body')).toBeVisible();
      expect(await loose(), 'saved: a step outside the fold').toEqual([]);
      const body = fold.locator(':scope > .process-fold-body');
      await expect(body).toContainText('sample-cmd --last');
      for (let i = 1; i <= calls; i++) await expect(body).toContainText(`sample-cmd --step ${i}`);
    });
  }
}

// Find in a shut turn fold: one Enter opens the fold AND the card inside it, and lands on the
// match (2026-11-13, found on live prod in a lead's chat: a match in a received message inside
// a shut fold took two presses, the first only opened the fold). Each kind of received card,
// the word in its folded body or on its title line, stepping forward and back.
const peerNote = (k: number, word: string, inTitle: boolean) => `<walnut-message kind="peer-note" from="Sample lead [abcd1234]" from-session="abcd1234-0000-4000-8000-00000000000${k}" from-task="t1" host="local" title="Next step ${k}${inTitle ? ` ${word}` : ''}">\nPlease recount the nests${inTitle ? '' : `, ${word}`}.\n</walnut-message>`;
const noticeWith = (k: number, word: string) => `<walnut-message kind="notification" from="Walnut" about="Sample canary [c82${k}]" about-task="eeee555${k}" outcome="waiting" note="automated Walnut status notice">\nYour subtask set itself to WAITING, ${word}.\n</walnut-message>`;
for (const kind of ['notification', 'peer-note'] as const) {
  // A notice's words show on its folded line; a peer note's body only once the card opens.
  for (const where of kind === 'peer-note' ? ['body', 'title'] as const : ['body'] as const) {
    for (const dir of ['Enter', 'Shift+Enter'] as const) {
      test(`find · one ${dir} opens a shut fold and lands on a match in a received ${kind}'s ${where}`, async ({ page }) => {
        const WORDX = 'quokkafind';
        const rec: Row = { role: 'user', text: kind === 'peer-note' ? peerNote(2, WORDX, where === 'title') : noticeWith(2, WORDX), timestamp: at(22), msgId: 'queue-n2', walnutMessageId: 'sn-2' };
        const messages: Row[] = [...PRIOR, ASK, KINDS.command(1).row, rec, KINDS.command(3).row, FINAL];
        await mockSession(page, messages, 'idle');
        await page.route(`**/api/sessions/${MOCK_SESSION_ID}/find**`, (route) => route.fulfill({
          json: { matches: [{ id: 'queue-n2', role: 'user', timestamp: at(22), count: 1 }], total: 1, capped: false },
        }));
        const history = await open(page);
        await expect(history).toContainText('MX_FINAL', { timeout: 15000 });
        const fold = history.locator('[data-testid="turn-fold"]');
        await expect(fold).toHaveCount(1);
        await expect(fold).toHaveAttribute('data-open', 'false');
        await history.getByText('MX_FINAL').click();
        await findChord(page);
        await page.keyboard.type(WORDX);
        const label = page.locator('.page-find .fv-search-count');
        await expect(label).toHaveText(/^1 match/, { timeout: 10000 });
        await page.keyboard.press(dir);
        await expect(page.locator('.page-find')).toHaveAttribute('data-revealing', 'false', { timeout: 10000 });
        // Landed on it with that one press: numbered, painted, on screen, in the received row.
        await expect(label).toHaveText('1/1', { timeout: 5000 });
        const active = await history.evaluate((el) => {
          const reg = (window as unknown as { CSS: { highlights: Map<string, Set<AbstractRange>> } }).CSS.highlights;
          const h = reg.get('walnut-find-active')?.size ? reg.get('walnut-find-active') : reg.get('walnut-find-solid-active');
          if (!h?.size) return null;
          const s = [...h][0]!;
          const live = document.createRange();
          live.setStart(s.startContainer, s.startOffset);
          live.setEnd(s.endContainer, s.endOffset);
          const r = live.getBoundingClientRect();
          const box = el.getBoundingClientRect();
          const node = s.startContainer;
          const at = node instanceof Element ? node : node.parentElement;
          return { text: live.toString(), inView: r.height > 0 && r.top >= box.top && r.bottom <= box.top + el.clientHeight, inFold: !!at?.closest('[data-testid="turn-fold"]') };
        });
        expect(active, 'the press selected a match').not.toBeNull();
        expect(active!.text.toLowerCase()).toBe(WORDX);
        expect(active!.inView, 'the match is on screen').toBe(true);
        expect(active!.inFold, 'the match is inside the turn fold').toBe(true);
        await expect(fold).toHaveAttribute('data-open', 'true');
      });
    }
  }
}
