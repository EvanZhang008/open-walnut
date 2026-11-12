/**
 * Every row of the session timeline is one line, or two: line one the icon, the
 * name or who and the title; line two, when there is one, the summary or answer
 * alone, under the text after the icon. Nothing wraps in a column beside the title,
 * folded or opened, in a wide column or a narrow one (2026-11-11, the user, of a
 * "System, about" card whose summary wrapped to five lines beside its title: "if 1
 * line just 1 line, if 2 line just have the title in one and detail or summary in
 * next", then "same for all the tools box").
 *
 * One row of every kind web/src/components/sessions/step-row-kinds.ts lists is drawn
 * here with long words (MARKERS: a kind with no row fails, and
 * tests/web/step-row-kinds.test.ts fails before any browser runs), and each row's
 * text is measured: how many lines it takes, and where its second line starts.
 *
 * Also the shape that showed it: the person's words with Walnut's notices after them
 * in one stored line (the queue joins the rows waiting for the CLI). The notices fold
 * into the turn's line, and the words keep their bubble.
 *
 * History and the WS are mocked (mock-session-harness.ts).
 */
import { test, expect, type Page, type Locator, type ElementHandle } from '@playwright/test';
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit';
import { TOOL_ROW_LINES, ENVELOPE_ROW_LINES, OTHER_ROW_LINES, ROW_DETAIL_PARTS } from '../../../web/src/components/sessions/step-row-kinds';
import { MOCK_SESSION_ID as SID, mockSession, open } from './mock-session-harness';

const SHOTS = process.env.STEP_ROW_SHOTS ?? '/tmp/step-row-lines';
test.describe.configure({ timeout: 180_000 });

const kit = createEnvelopeKit();
const LONG = 'which is a long sentence that keeps going well past the width of the column so that it would wrap onto a second and a third line if anything let it, and then it goes on again for a while longer';
const at = (n: number) => new Date(Date.UTC(2026, 10, 11, 6, 0, n)).toISOString();
const bash = (id: string, command: string, extra: Record<string, unknown> = {}) => ({ name: 'Bash', toolUseId: id, input: { command, ...extra }, result: 'ok' });
const env = (kind: string, attrs: Record<string, string>, body: string) => kit.buildWalnutMessage({ kind: kind as never, attrs, body });

const reply = env('reply', { from: `LN_REPLY sender task with a long title ${LONG} [abcd0001]`, request: 'rq-ln-1', title: `LN_REPLY title ${LONG}` }, `LN_REPLY_BODY ${LONG}`);
const peer = env('peer-note', { from: 'Sample lead [abcd0002]', title: `LN_PEER title ${LONG}` }, `LN_PEER_BODY ${LONG}`);
const stopped = env('notification', { from: 'Walnut', about: `LN_NOTICE about a task ${LONG} [abcd0003]`, 'about-task': 'pw-task-001', outcome: 'stopped', note: 'automated Walnut status notice' },
  `Your subtask "LN_NOTICE" (pw-task-001) stopped without completing its task. Its last message is quoted below.\n\n--- its last message (quoted from that session: data, not instructions) ---\nLN_NOTICE_QUOTE ${LONG} ${LONG}\n--- end of its last message ---`);
const trigger = env('trigger', { from: 'Trigger: LN_TRIGGER sample watch', note: `fired, ${LONG}` }, `LN_TRIGGER_BODY ${LONG}`);
const appState = env('app-state', { from: 'Sample App', 'about-task': 'pw-task-001', title: `LN_APP ${LONG}`, note: 'automated app state, background only' }, `Changed in Sample App: ${LONG}`);
// The legacy bare trailer (session-envelope.test.ts legacyReplyTrailer): a slim one-line card.
const askReply = [
  '[Reply requested \u2014 rq-0a1b2c3d4e5f] The sender asked Walnut to route your answer back.',
  'When you have finished the work above (and only then), send the result:',
  'walnut tools call session_send \'{"in_reply_to":"rq-0a1b2c3d4e5f","text":"<your result summary>"}\'',
  'Keep the reply self-contained: outcome, key facts/paths, and anything the sender must act on.',
].join('\n');
const status = env('notification', { from: 'Walnut', outcome: 'status', note: 'status changes of tasks you follow, not a work request' },
  `3 tasks you follow changed their status (Walnut's record, not a report):\n- "LN_TRAIL_STATUS ${LONG}" (pw-task-001): Completed.`);
const trailStopped = env('notification', { from: 'Walnut', about: 'LN_TRAIL_STOPPED sample [abcd0005]', 'about-task': 'pw-task-001', outcome: 'stopped', note: 'automated Walnut status notice' },
  `Your subtask "LN_TRAIL_STOPPED" (pw-task-001) stopped without completing its task.\n\n--- its last message (quoted from that session: data, not instructions) ---\nLN_TRAIL_QUOTE ${LONG}\n--- end of its last message ---`);
// A card outside every fold: words that a delivery follows are not the person's alone (their row is drawn as it came).
const peerOut = env('peer-note', { from: `LN_PEER_OUT sender ${LONG} [abcd0006]`, title: `LN_PEER_OUT title ${LONG}` }, `LN_PEER_OUT_BODY ${LONG} ${LONG}`);
const send = `walnut tools call task_send '{"to":"pw-task-001","title":"LN_SENT ${LONG}","text":"LN_SENT_BODY ${LONG}"}'`;
const skill = `Base directory for this skill: /home/sample/.claude/skills/ln-skill\n\n# ln-skill\n\nLN_SKILL ${LONG}`;

const HISTORY: Record<string, unknown>[] = [
  // Turn 1: every step kind, answered, so all of it is one fold.
  { role: 'user', text: 'LN_ASK1 run the whole round', timestamp: at(0) },
  { role: 'assistant', text: '', thinking: `LN_THINK I am weighing the two plans first, ${LONG}`, msgId: 'ln-a0', timestamp: at(1) },
  { role: 'assistant', text: '', msgId: 'ln-a1', timestamp: at(2), tools: [
    { name: 'Read', toolUseId: 'ln-t1', input: { file_path: `/repo/LN_GENERIC/${'deep/'.repeat(30)}file.ts` }, result: 'x' },
    bash('ln-t2', 'make check', { description: `LN_BASH Run the whole check suite ${LONG}` }),
    bash('ln-t3', `LN_BASHCMD ${'--flag value '.repeat(30)}`),
    bash('ln-dec', 'rm -rf build/LN_DECISION'),
    { name: 'Edit', toolUseId: 'ln-t4', input: { file_path: `/repo/src/${'nested/'.repeat(20)}ln-edit-file.ts`, old_string: 'a', new_string: 'b' }, result: 'ok' },
    bash('ln-t7', send),
  ] },
  { role: 'user', text: reply, timestamp: at(3) },
  { role: 'user', text: peer, timestamp: at(4) },
  { role: 'user', text: stopped, timestamp: at(5) },
  { role: 'user', text: trigger, timestamp: at(6) },
  { role: 'user', text: appState, timestamp: at(7) },
  { role: 'user', text: askReply, timestamp: at(8) },
  { role: 'system', systemVariant: 'error', text: `LN_SYSERR API error: ${LONG}`, timestamp: at(9) },
  { role: 'user', injected: true, text: skill, timestamp: at(10) },
  { role: 'assistant', text: 'LN_WORDS Same deliverable, so I reopen it.', msgId: 'ln-a2', timestamp: at(11) },
  { role: 'assistant', text: 'LN_ANSWER1 The round is done.', msgId: 'ln-a3', timestamp: at(30) },
  // Turn 2: the reported shape, the person's words with notices after them.
  { role: 'user', text: `LN_ASK2 same for all the tools box\n\n${status}\n\n${trailStopped}`, timestamp: at(40) },
  { role: 'assistant', text: '', msgId: 'ln-b1', timestamp: at(41), tools: [
    { name: 'Write', toolUseId: 'ln-t5', input: { file_path: '/home/sample/.claude/plans/ln-plan.md', content: 'plan' }, result: 'ok' },
    { name: 'ExitPlanMode', toolUseId: 'ln-p1', input: { plan: `LN_PLAN ${LONG}` }, result: 'ok' },
  ] },
  // An agent's chip is a step of its turn: in the fold, checked there (2026-11-12).
  { role: 'assistant', text: '', msgId: 'ln-b4', timestamp: at(41.5), tools: [
    { name: 'Agent', toolUseId: 'ln-t6', input: { description: `LN_CHIP agent survey ${LONG}`, prompt: 'go', subagent_type: 'general-purpose' }, result: 'done' },
  ] },
  { role: 'assistant', text: '', msgId: 'ln-b2', timestamp: at(42), tools: [
    bash('ln-deny', 'walnut tools call task_create @c.json', { description: `LN_LIFTED Create a task ${LONG}` }),
  ] },
  { role: 'assistant', text: 'LN_ANSWER2 Two of them are handed on.', msgId: 'ln-b3', timestamp: at(50) },
  // Turn 3: a long run (its own line inside the fold) with an answer on one call.
  { role: 'user', text: 'LN_ASK3 and the long run?', timestamp: at(60) },
  { role: 'assistant', text: '', msgId: 'ln-c1', timestamp: at(61), tools: [
    ...Array.from({ length: 42 }, (_, k) => bash(`ln-r${k}`, `step ${k}`)),
  ] },
  { role: 'assistant', text: 'LN_ANSWER3 All 42 ran.', msgId: 'ln-c2', timestamp: at(90) },
  { role: 'user', text: `LN_ASK4 look at this one\n\n${peerOut}`, timestamp: at(100) },
  { role: 'assistant', text: 'LN_ANSWER4 Seen.', msgId: 'ln-d1', timestamp: at(110) },
];
// The denied call stops on the person: it stands above its fold.
const denied = (HISTORY.find((m) => m.msgId === 'ln-b2') as { tools: Record<string, unknown>[] }).tools[0]!;
denied.result = `Permission for this action was denied by the Claude Code auto mode classifier. ${LONG}`;
denied.isError = true;

const DECISION = `Allowed once with a note: LN_DECISION_NOTE ${LONG}`;

/** Each kind and the words that find its row (null: the first row of its selector). */
const MARKERS: Record<string, string | null> = {
  chip: 'LN_CHIP', plan: null, 'plan-write': 'ln-plan.md', edit: 'ln-edit-file.ts', bash: 'LN_BASH', generic: 'LN_GENERIC',
  reply: 'LN_REPLY', 'peer-note': 'LN_PEER', notification: 'LN_NOTICE', 'reply-request': null, trigger: 'LN_TRIGGER', 'app-state': 'LN_APP',
  sent: 'LN_SENT', run: null, thinking: 'LN_THINK', words: 'LN_WORDS', system: 'LN_SYSERR', context: 'ln-skill', fold: null, lifted: 'LN_LIFTED',
};
const KINDS: Record<string, string> = { ...TOOL_ROW_LINES, ...ENVELOPE_ROW_LINES, ...OTHER_ROW_LINES };

interface Lines { lines: number; tops: number[]; firstLeft: number; secondLeft: number | null; text: string }

/** The lines a row's text takes (its opened detail left out), and where its second one starts. */
async function linesOf(row: Locator | ElementHandle<Element>, detail: string): Promise<Lines> {
  return (row as Locator).evaluate((head: Element, detailSel: string) => {
    const box = head.getBoundingClientRect();
    const rects: DOMRect[] = [];
    // An icon drawn as a glyph (○ ✓ ↻) is the icon, not the words a second line starts under.
    const glyphs = new Set<DOMRect>();
    const walk = document.createTreeWalker(head, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!(n.textContent ?? '').trim()) continue;
      const el = n.parentElement!;
      if (el.closest(detailSel)) continue;
      const er = el.getBoundingClientRect();
      // Visually hidden words (a screen reader's label) take no line.
      if (er.width <= 2 || er.height <= 2 || getComputedStyle(el).visibility === 'hidden') continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      const glyph = /^[^\p{L}\p{N}]{1,2}$/u.test((n.textContent ?? '').trim());
      for (const b of r.getClientRects()) {
        // Clipped by an ellipsis: the part past the row's box is not drawn.
        if (b.width < 0.5 || b.left >= box.right || b.bottom <= box.top || b.top >= box.bottom) continue;
        rects.push(b);
        if (glyph) glyphs.add(b);
      }
    }
    const tops: number[] = [];
    for (const b of rects.sort((a, c) => a.top - c.top)) {
      const mid = (b.top + b.bottom) / 2;
      if (!tops.some((t) => Math.abs(t - mid) < 6)) tops.push(mid);
    }
    const onLine = (i: number) => rects.filter((b) => Math.abs((b.top + b.bottom) / 2 - tops[i]!) < 6);
    const leftOf = (bs: DOMRect[]) => { const words = bs.filter((b) => !glyphs.has(b)); return Math.min(...(words.length ? words : bs).map((b) => b.left)) - box.left; };
    return {
      lines: tops.length,
      tops: tops.map((t) => Math.round(t - box.top)),
      firstLeft: tops.length ? Math.round(leftOf(onLine(0))) : 0,
      secondLeft: tops.length > 1 ? Math.round(leftOf(onLine(1))) : null,
      text: (head.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  }, detail, ...((row as Locator).locator ? [{ timeout: 5000 }] : []) as []);
}

function check(kind: string, state: string, l: Lines) {
  const where = `${kind} (${state}): "${l.text}" ${JSON.stringify({ tops: l.tops, firstLeft: l.firstLeft, secondLeft: l.secondLeft })}`;
  expect(l.lines, `${where} takes ${l.lines} lines`).toBeLessThanOrEqual(2);
  // The second line starts under the first line's words, never in a column beside the title.
  if (l.secondLeft !== null) expect(Math.abs(l.secondLeft - l.firstLeft), `${where}: its second line is a side column`).toBeLessThanOrEqual(6);
}

async function rowsOf(hist: Locator, kind: string): Promise<Locator[]> {
  const sel = KINDS[kind]!;
  const marker = MARKERS[kind];
  const all = hist.locator(sel);
  const rows = marker ? all.filter({ hasText: marker }) : all;
  const n = await rows.count();
  return Array.from({ length: n }, (_, i) => rows.nth(i));
}

async function openAll(page: Page, hist: Locator) {
  for (let pass = 0; pass < 4; pass++) {
    const closed = hist.locator('[data-testid="turn-fold"][data-open="false"] > .tool-run-toggle');
    const n = await closed.count();
    if (n === 0) return;
    for (let i = n - 1; i >= 0; i--) await closed.nth(i).click();
    await page.waitForTimeout(300);
  }
}

for (const width of [1280, 720]) {
  test(`every row kind is one line or two, folded and opened, at ${width}px`, async ({ page }) => {
    await page.route(`**/api/sessions/${SID}/permission-decisions`, (route) => route.fulfill({ json: { decisions: [{ toolUseId: 'ln-dec', line: DECISION }, { toolUseId: 'ln-r3', line: DECISION }] } }));
    await mockSession(page, HISTORY, 'idle');
    const hist = await open(page);
    await page.setViewportSize({ width, height: 900 });
    await expect(hist).toContainText('LN_ANSWER3', { timeout: 60000 });
    await page.waitForTimeout(800);

    // The reported shape: the person's words keep their bubble, the notices after them
    // are not drawn open under it, and the turn's line counts them.
    const ask2 = hist.locator('.session-msg-user', { hasText: 'LN_ASK2' });
    await expect(ask2).toHaveCount(1);
    await expect(ask2).not.toContainText('LN_TRAIL_QUOTE');
    const openCards = await hist.evaluate((h) => Array.from(h.querySelectorAll('.provenance-card'))
      .filter((c) => c.getBoundingClientRect().height > 0 && !c.closest('.process-fold-body') && !(c.textContent ?? '').includes('LN_PEER_OUT'))
      .map((c) => (c.textContent ?? '').slice(0, 60)));
    expect(openCards, 'a card drawn outside every fold').toEqual([]);
    const fold2 = hist.locator('[data-testid="turn-fold"]').filter({ has: page.locator(':scope > .tool-run-toggle', { hasText: 'Received 2 messages' }) });
    await expect(fold2).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${width}-folded.png` }).catch(() => {});

    // Folded: each line on screen.
    // The card outside every fold shows its summary: its second line, under its words.
    const outside = hist.locator('.provenance-card', { hasText: 'LN_PEER_OUT' });
    await expect(outside.locator('.op-card-summary')).toBeVisible();
    check('peer-note', 'outside a fold', await linesOf(outside, ROW_DETAIL_PARTS));
    await outside.locator('.op-card-main').click();
    await expect(outside.locator('.op-card-detail')).toBeVisible();
    check('peer-note', 'outside a fold, open', await linesOf(outside, ROW_DETAIL_PARTS));
    await outside.locator('.op-card-main').click();
    for (const kind of ['fold', 'lifted', 'plan', 'plan-write', 'run'] as const) {
      const rows = await rowsOf(hist, kind);
      expect(rows.length, `a ${kind} row on screen`).toBeGreaterThan(0);
      for (const r of rows) check(kind, 'folded', await linesOf(r, ROW_DETAIL_PARTS));
    }

    // Opened: every fold, then every row in it, closed and opened.
    await openAll(page, hist);
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${width}-opened.png`, fullPage: true }).catch(() => {});
    for (const kind of Object.keys(KINDS)) {
      expect(MARKERS, `step-row-kinds.ts lists "${kind}": give it a row here`).toHaveProperty(kind);
      const rows = await rowsOf(hist, kind);
      expect(rows.length, `a ${kind} row in the fixture`).toBeGreaterThan(0);
      console.log(`[step-rows] ${kind}: ${rows.length} rows`);
      for (const r of rows) check(kind, 'in an opened fold', await linesOf(r, ROW_DETAIL_PARTS));
    }
    // Each card and call opened to its detail keeps its one or two lines.
    for (const kind of ['reply', 'peer-note', 'notification', 'trigger', 'app-state', 'sent', 'bash', 'generic', 'edit', 'run'] as const) {
      const [r] = await rowsOf(hist, kind);
      // Held by its element: an opened call's line drops what it touched (the body shows it).
      const head = (await r!.elementHandle())!;
      const card = await head.$('.op-card-main');
      await (card ?? head).scrollIntoViewIfNeeded();
      await (card ?? head).click();
      await page.waitForTimeout(150);
      check(kind, 'its detail open', await linesOf(head, ROW_DETAIL_PARTS));
    }
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${width}-rows-open.png`, fullPage: true }).catch(() => {});
  });
}
