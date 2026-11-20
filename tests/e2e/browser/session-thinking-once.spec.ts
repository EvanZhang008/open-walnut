/**
 * A thought shows once: one "Thinking" row (SessionThinking, the step row), never a
 * "Thinking" run line with another thinking row or its peek under it (2026-11-11, the
 * user: the new thinking row is good, but the old one with the chevron still showed
 * above it, "上面的那种三角形 ... 下面又是显示一个 thinking ... 太混乱了").
 *
 * Every way a thought reaches the screen, live and saved: reasoning streamed with and
 * without its message id, reasoning between calls, reasoning before an answer, and a
 * saved message of reasoning alone; each with its turn's fold closed and opened.
 * Each thought's words must be on screen at most once, and no line but the thinking
 * row itself may say "Thinking".
 *
 * A thought on its own in the timeline is the line every fold is, "> Thinking": the
 * chevron, the word, nothing else. Its step row (the icon, its first line) is inside and
 * shows once the line is opened, in every one of those ways (2026-11-20, the user, of
 * one live thought drawn with its first line between two of his messages: "even if only
 * one thining shoud also collapes", then of the icon row: "collpe like > Thinking ...
 * just liek all other not even icon icon isinside te collpes"). `bareRows` is that
 * guard: it reads the screen, so a new way of drawing a thought that shows its icon or
 * its words outside an opened list fails here too.
 *
 * History and the WS are mocked (mock-session-harness.ts).
 */
import { test, expect, type Locator } from '@playwright/test';
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit';
import { MOCK_SESSION_ID as SID, mockSession, open, injectEvent, waitForWs } from './mock-session-harness';

test.describe.configure({ timeout: 120_000 });

const at = (n: number) => new Date(Date.UTC(2026, 10, 11, 6, 0, n)).toISOString();

/** Where each marker's words are drawn on screen, and every line that says "Thinking". */
async function thinkingOnScreen(hist: Locator, markers: string[]) {
  return hist.evaluate((h: Element, ms: string[]) => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const shown: Record<string, number> = {};
    for (const m of ms) {
      shown[m] = 0;
      const walk = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if ((n.textContent ?? '').includes(m) && visible(n.parentElement!)) shown[m]++;
      }
    }
    // A line reading "Thinking" that is not the thinking row's own label.
    const otherLines = Array.from(h.querySelectorAll('.tool-run-label, .process-fold-label, .tool-run-toggle'))
      .filter((el) => visible(el) && (el.textContent ?? '').trim() === 'Thinking' && !el.closest('.tool-run-row--step')
        // A thought on its own: its fold line is the word, the one row inside it the thought.
        && !(el.closest('.tool-run-row')?.matches('[data-testid="thought-fold"]')))
      .map((el) => (el as HTMLElement).outerHTML.slice(0, 120));
    const rows = Array.from(h.querySelectorAll('.tool-run-row--step')).filter(visible).length;
    // A thinking step row (the icon, the first line) outside any list the reader opened,
    // and a thought's fold line that reads anything but "Thinking" behind its chevron.
    const bareRows = [
      ...Array.from(h.querySelectorAll('.tool-run-row--step'))
        .filter((row) => visible(row) && !!row.querySelector(':scope > .tool-run-toggle [data-step-icon="thought"]')
          && !row.closest('.process-fold-body, .tool-run-body'))
        .map((row) => `step row: ${(row.querySelector(':scope > .tool-run-toggle')?.textContent ?? '').trim()}`),
      ...Array.from(h.querySelectorAll('[data-testid="thought-fold"] > .tool-run-toggle'))
        .filter((line) => visible(line) && ((line.textContent ?? '').trim() !== 'Thinking'
          || !line.firstElementChild?.classList.contains('process-fold-chevron')
          || !!line.querySelector('[data-step-icon]:not([data-step-icon="chevron"])')))
        .map((line) => `fold line: ${(line as HTMLElement).outerHTML.slice(0, 160)}`),
    ];
    return { shown, otherLines, rows, bareRows };
  }, markers);
}

async function expectOnce(hist: Locator, markers: string[], where: string) {
  const r = await thinkingOnScreen(hist, markers);
  for (const m of markers) expect(r.shown[m], `${where}: "${m}" is drawn ${r.shown[m]} times`).toBeLessThanOrEqual(1);
  expect(r.otherLines, `${where}: a line besides the thinking row says "Thinking"`).toEqual([]);
  expect(r.bareRows, `${where}: a thought outside an opened list is not the one line "> Thinking"`).toEqual([]);
  return r;
}

async function bothWays(hist: Locator, markers: string[], where: string) {
  await expectOnce(hist, markers, `${where}, fold closed`);
  // Open every fold and run line (never a thinking row itself: its words would show whole).
  const closed = hist.locator('[data-testid="turn-fold"][data-open="false"] > .tool-run-toggle, .tool-run-row:not(.tool-run-row--step) > .tool-run-toggle[aria-expanded="false"]');
  for (let pass = 0, n = await closed.count(); n > 0 && pass < 6; pass++, n = await closed.count()) {
    await closed.last().click();
    await hist.page().waitForTimeout(200);
  }
  const r = await expectOnce(hist, markers, `${where}, fold opened`);
  // Opened, every thought is on screen: once.
  for (const m of markers) expect(r.shown[m], `${where}, opened: "${m}" is not on screen`).toBe(1);
}

const SAVED = [
  { role: 'user', text: 'TH_ASK1 plan it', timestamp: at(0) },
  { role: 'assistant', text: '', thinking: 'TH_ALONE weighing the two plans', msgId: 'th-a0', timestamp: at(1) },
  { role: 'assistant', text: '', thinking: 'TH_BEFORE_CALL which file first', msgId: 'th-a1', timestamp: at(2), tools: [
    { name: 'Bash', toolUseId: 'th-t1', input: { command: 'make check' }, result: 'ok' },
  ] },
  { role: 'assistant', text: '', thinking: 'TH_BETWEEN the check passed', msgId: 'th-a2', timestamp: at(3), tools: [
    { name: 'Read', toolUseId: 'th-t2', input: { file_path: '/repo/a.ts' }, result: 'x' },
  ] },
  { role: 'assistant', text: 'TH_ANSWER1 Done.', thinking: 'TH_BEFORE_ANSWER all good, say so', msgId: 'th-a3', timestamp: at(9) },
  // Words with a notice after them (the queue joined the rows), answered with no step
  // between: the notice and the answer's reasoning are one fold, the reasoning once.
  { role: 'user', text: `TH_ASK2 and now?\n\n${createEnvelopeKit().buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'status', note: 'status changes of tasks you follow, not a work request' }, body: '1 task you follow changed its status:\n- "Sample" (pw-task-001): Completed.' })}`, timestamp: at(20) },
  { role: 'assistant', text: 'TH_ANSWER2 Nothing left.', thinking: 'TH_AFTER_NOTICE nothing is open', msgId: 'th-a4', timestamp: at(25) },
];

test('a saved thought shows once, its fold closed or opened', async ({ page }) => {
  await mockSession(page, SAVED, 'idle');
  const hist = await open(page);
  await expect(hist).toContainText('TH_ANSWER1', { timeout: 60000 });
  await expect(hist).toContainText('TH_ANSWER2', { timeout: 60000 });
  await bothWays(hist, ['TH_ALONE', 'TH_BEFORE_CALL', 'TH_BETWEEN', 'TH_BEFORE_ANSWER', 'TH_AFTER_NOTICE'], 'saved');
});

const LIVE_BASE = [
  { role: 'user', text: 'TH_ASK0 earlier', timestamp: at(0) },
  { role: 'assistant', text: 'TH_ANSWER0 earlier answer.', msgId: 'th-b0', timestamp: at(1) },
  { role: 'user', text: 'TH_ASK2 go on', timestamp: at(2) },
];

for (const withId of [true, false]) {
  test(`a live thought shows once (${withId ? 'with' : 'without'} its message id), alone, before a call, after it`, async ({ page }) => {
    await mockSession(page, LIVE_BASE, 'running');
    const hist = await open(page);
    await waitForWs(page);
    await expect(hist).toContainText('TH_ANSWER0', { timeout: 60000 });
    const think = (delta: string, id: string) => injectEvent(page, 'session:thinking-delta', { sessionId: SID, delta, ...(withId ? { msgId: id } : {}) });

    // Reasoning alone, still streaming.
    await think('TH_LIVE_ALONE weighing it', 'th-l1');
    await page.waitForTimeout(600);
    await bothWays(hist, ['TH_LIVE_ALONE'], 'live, reasoning alone');

    // A call after it, then reasoning again at the tail.
    await injectEvent(page, 'session:tool-use', { sessionId: SID, toolName: 'Bash', toolUseId: 'th-lt1', input: { command: 'make check' } });
    await injectEvent(page, 'session:tool-result', { sessionId: SID, toolUseId: 'th-lt1', result: 'ok' });
    await think('TH_LIVE_AFTER the check passed', 'th-l2');
    await page.waitForTimeout(300);
    await bothWays(hist, ['TH_LIVE_ALONE', 'TH_LIVE_AFTER'], 'live, reasoning around a call');
  });
}

test('one live thought on its own is the one line "> Thinking": opened it shows its row and the thought, shut it is the line again', async ({ page }) => {
  await mockSession(page, LIVE_BASE, 'running');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('TH_ANSWER0', { timeout: 60000 });
  // An answer so far (a table: words a reader reads, never narration), then one thought
  // after it: a stretch of reasoning alone, with no step beside it to fold with.
  await injectEvent(page, 'session:text-delta', { sessionId: SID, delta: 'TH_SOFAR here is the table\n\n| a | b |\n|---|---|\n| 1 | 2 |\n', msgId: 'th-s1' });
  await injectEvent(page, 'session:thinking-delta', { sessionId: SID, delta: 'TH_SOLO_FIRST tally the closed ones\nTH_SOLO_REST then check each cause', msgId: 'th-s2' });
  await expect(hist).toContainText('TH_SOFAR', { timeout: 30000 });
  const fold = hist.locator('[data-testid="thought-fold"]');
  await expect(fold).toHaveCount(1);
  const line = fold.locator(':scope > .tool-run-toggle');

  // Shut: the chevron, then the word; no icon, no row, none of the thought's words.
  const shut = async (where: string) => {
    await expect(fold).toHaveAttribute('data-open', 'false');
    await expect(line).toHaveText('Thinking');
    expect(await line.evaluate((el) => el.firstElementChild?.classList.contains('process-fold-chevron'))).toBe(true);
    await expect(fold.locator('[data-step-icon="thought"]')).toHaveCount(0);
    await expect(fold.locator('.tool-run-row--step')).toHaveCount(0);
    await expect(hist).not.toContainText('TH_SOLO_FIRST');
    // The same line every other fold is: its box and its chevron's place match a turn fold's.
    await expectOnce(hist, ['TH_SOLO_FIRST', 'TH_SOLO_REST'], where);
  };
  await shut('one live thought, shut');

  // Opened: the thinking row is inside, with its icon and the thought's first line.
  await line.click();
  await expect(fold).toHaveAttribute('data-open', 'true');
  const row = fold.locator('.process-fold-body .tool-run-row--step');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-step-icon="thought"]')).toHaveCount(1);
  await expect(row.locator('.tool-run-detail')).toContainText('TH_SOLO_FIRST');
  await expectOnce(hist, ['TH_SOLO_FIRST', 'TH_SOLO_REST'], 'one live thought, opened');
  // The row opens the whole thought.
  await row.locator(':scope > .tool-run-toggle').click();
  await expect(row.locator('.chat-thinking-content')).toContainText('TH_SOLO_REST');
  await expectOnce(hist, ['TH_SOLO_FIRST', 'TH_SOLO_REST'], 'one live thought, read');

  await line.click();
  await shut('one live thought, shut again');
});
