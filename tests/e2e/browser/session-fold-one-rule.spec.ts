/**
 * Consecutive fold rows with no words between them are ONE row, whatever steps,
 * row kinds or turn boundaries sit between them (web/src/components/sessions/fold-rows.ts).
 *
 * 2026-10-30, the user, the fourth report of this split: between two answers of a
 * coordinating session three fold rows sat back to back, "Received 1 message",
 * "Ran 4 commands · 1 failed", "Received 1 message · Ran 1 tool · 20 failed".
 * The first fixture copies that session's structure with neutral words: a trigger
 * notice, four commands with one failed, the no-action line (a turn with a failure
 * is "open"), a re-check notice, twenty API error lines, one more command, the
 * answer. The second puts every step kind the timeline draws between two answers,
 * across a turn boundary, so a kind the rule misses splits the row again.
 *
 * History and the WS are mocked (mock-session-harness.ts).
 */
import { test, expect, type Locator } from '@playwright/test';
import { mockSession, open } from './mock-session-harness';

const SHOTS = '/tmp/fold-combine';

// A cold fixture boot on a loaded machine takes most of the default 30 s.
test.describe.configure({ timeout: 120_000 });
const TAG = '<walnut-turn status="agent-ack"/>';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const bash = (id: string, command: string, fail = false) => ({
  name: 'Bash', toolUseId: id, input: { command }, result: fail ? 'Error: exit 1' : 'ok', ...(fail ? { isError: true } : {}),
});
const notice = (from: string, body: string) => `<walnut-message kind="notification" from="${from}" title="${body}">\n${body}\n</walnut-message>`;
const trigger = (from: string, body: string) => `<walnut-message kind="trigger" from="${from}">\n${body}\n</walnut-message>`;
const peer = (from: string, body: string) => `<walnut-message kind="peer-note" from="${from}">\n${body}\n</walnut-message>`;
const sys = (variant: 'error' | 'info' | 'compact', text: string, n: number) => ({ role: 'system', systemVariant: variant, text, timestamp: at(n) });

/** The rows that split on the real session, in its order. */
const reported = (() => {
  let n = 0;
  const rows: Record<string, unknown>[] = [
    { role: 'user', text: 'OR_ASK please keep checking the letter', timestamp: at(n++) },
    { role: 'assistant', text: 'OR_ANSWER_A still waiting for the reply; a check runs every 15 minutes.', timestamp: at(n++) },
    { role: 'user', text: notice('Trigger: sample-letter-reply', 'The check found no new reply'), timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [bash('r1', 'sample-check --status')], timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [bash('r2', 'sample-check --letter', true)], timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [bash('r3', 'sample-check --letter --fixed')], timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [bash('r4', 'sample-check --trigger')], timestamp: at(n++) },
    { role: 'assistant', text: TAG, timestamp: at(n++) },
    { role: 'user', text: trigger('Walnut: re-check', 'Is what you asked still open?'), timestamp: at(n++) },
  ];
  for (let k = 0; k < 20; k++) rows.push(sys('error', k % 3 === 2 ? 'API error: Request timed out.' : 'API error: 502 upstream unavailable', n++));
  rows.push(
    { role: 'assistant', text: '', tools: [bash('r5', 'sample-check --letter --fixed')], timestamp: at(n++) },
    { role: 'assistant', text: 'OR_ANSWER_B still waiting; the check was wrong at first and runs now.', timestamp: at(n++) },
  );
  return rows;
})();

/** Every step kind between two answers, an open turn into an answered one. */
const everyKind = (() => {
  let n = 100;
  return [
    { role: 'user', text: 'OR_ASK2 run the whole round', timestamp: at(n++) },
    { role: 'assistant', text: 'OR_ANSWER_C started.', timestamp: at(n++) },
    // An open turn: a peer note, reasoning alone, a command, a failed one, a send,
    // injected context, one error line, one info line, a run of system lines.
    { role: 'user', text: peer('Docs lead [aaaaaaaa]', 'The review is done.'), timestamp: at(n++) },
    { role: 'assistant', text: '', thinking: 'Look at the review first.', timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [bash('k1', 'sample-review --read')], timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [bash('k2', 'sample-review --apply', true)], timestamp: at(n++) },
    sys('error', 'API error: Request timed out.', n++),
    { role: 'assistant', text: '', tools: [{ name: 'Skill', toolUseId: 'k3', input: { skill: 'sample-notes' }, result: 'Launching skill: sample-notes' }], timestamp: at(n++) },
    { role: 'user', injected: true, text: 'Base directory for this skill: /home/sample/.claude/skills/sample-notes\n\n# sample-notes\n\nWrite them short.', timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [{ ...bash('k4', `walnut tools call task_send '{"to":"pw-task-fold","title":"Review applied","text":"review applied"}'`), result: 'Message queued for pw-task-fold. Accepted for delivery, not a completed reply. Do NOT resend.' }], timestamp: at(n++) },
    sys('info', 'Retrying the turn after an upstream error.', n++),
    sys('compact', 'Conversation compacted', n++),
    sys('error', 'API error: 502 upstream unavailable', n++),
    { role: 'assistant', text: TAG, timestamp: at(n++) },
    // An answered turn a notice started: everything before its answer.
    { role: 'user', text: notice('Walnut', 'A subtask finished'), timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [bash('k5', 'sample-review --verify', true)], timestamp: at(n++) },
    { role: 'assistant', text: 'OR_ANSWER_D the round is done.', timestamp: at(n++) },
  ];
})();

/** The rows the reader sees between the row holding `from` and the one holding
 *  `to` (each top-level row wrapper; nothing inside an opened fold). */
async function rowsBetween(hist: Locator, from: string, to: string): Promise<string[]> {
  return hist.evaluate((el, [a, b]) => {
    const rows = [...el.querySelectorAll('[data-msg-index], [data-turn-fold-index]')]
      .filter((n) => !n.parentElement?.closest('[data-msg-index], [data-turn-fold-index], .process-fold-body'));
    const text = (n: Element) => (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    const i = rows.findIndex((n) => text(n).includes(a));
    const j = rows.findIndex((n) => text(n).includes(b));
    return rows.slice(i + 1, j < 0 ? rows.length : j).map(text);
  }, [from, to] as const);
}

for (const [name, history, a, b, phrase] of [
  ['the reported session', reported, 'OR_ANSWER_A', 'OR_ANSWER_B', /^Received 2 messages from Walnut: re-check \+1 · Ran 5 tools\s*21 failed/],
  ['every step kind', everyKind, 'OR_ANSWER_C', 'OR_ANSWER_D', /^Received 2 messages from Docs lead \+1 · Sent 1 to Turn fold fixture task · Ran 4 tools · 2 notices\s*4 failed/],
] as const) {
  test(`${name}: the steps between two answers are one fold row`, async ({ page }) => {
    await mockSession(page, history, 'idle');
    const hist = await open(page);
    await expect(hist).toContainText(b, { timeout: 60000 });
    const between = await rowsBetween(hist, a, b);
    expect(between).toHaveLength(1);
    expect(between[0]).toMatch(phrase);
    await hist.locator('.session-msg', { hasText: b }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name.replace(/\s+/g, '-')}.png`, clip: (await hist.boundingBox())! }).catch(() => {});

    // Opened, every step is inside, the failed ones and the error lines included.
    const fold = hist.locator('[data-testid="turn-fold"]', { has: page.locator('.tool-run-toggle', { hasText: phrase }) });
    await fold.locator(':scope > .tool-run-toggle').click();
    await expect(fold).toHaveAttribute('data-open', 'true');
    await expect(fold).toContainText(name === 'every step kind' ? 'Ran 2 commands' : 'Ran 4 commands');
    await expect(fold.locator('.tool-run-fail').nth(1)).toHaveText('1 failed');
    await expect(fold).toContainText(name === 'every step kind' ? '3 system messages' : '20 errors');
  });
}

test('words still split the stretch, and a question to the person stays out', async ({ page }) => {
  let n = 300;
  const history = [
    { role: 'user', text: 'OR_ASK3 go', timestamp: at(n++) },
    { role: 'assistant', text: 'OR_ANSWER_E first part done.', timestamp: at(n++) },
    { role: 'user', text: notice('Walnut', 'A check ran'), timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [bash('w1', 'sample-a', true)], timestamp: at(n++) },
    { role: 'assistant', text: 'OR_WORDS halfway there.', tools: [bash('w2', 'sample-b')], timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [bash('w3', 'sample-c')], timestamp: at(n++) },
    { role: 'assistant', text: '', tools: [{ name: 'AskUserQuestion', toolUseId: 'w4', input: { questions: [{ question: 'OR_QUESTION which one?', options: [{ label: 'A' }, { label: 'B' }] }] } }], timestamp: at(n++) },
  ];
  await mockSession(page, history, 'idle');
  const hist = await open(page);
  await expect(hist).toContainText('OR_WORDS', { timeout: 60000 });
  const before = await rowsBetween(hist, 'OR_ANSWER_E', 'OR_WORDS');
  expect(before).toHaveLength(1);
  expect(before[0]).toMatch(/^Received 1 message · Ran 1 tool\s*1 failed/);
  // The question is not a step: its row (a run that asked it) stays its own, after the words.
  const after = await rowsBetween(hist, 'OR_WORDS', 'sample-unreachable');
  expect(after).toEqual([expect.stringMatching(/asked a question/)]);
});

test('a fold of sends names the tasks they went to, also when only the answer says it', async ({ page }) => {
  let n = 400;
  const history = [
    { role: 'user', text: 'OR_ASK4 tell both teams', timestamp: at(n++) },
    { role: 'assistant', text: 'OR_ANSWER_F on it.', timestamp: at(n++) },
    { role: 'user', text: notice('Walnut', 'A new ask'), timestamp: at(n++) },
    // Arguments built in a subshell: only the answer (cut short) names the target.
    { role: 'assistant', text: '', tools: [{ ...bash('s1', `walnut tools call task_send "$(python3 -c 'import json;print(json.dumps({"to":X}))')" | cut -c1-60`), result: 'Message delivered on this host to pw-task-fo' }], timestamp: at(n++) },
    // A loop over two tasks: one call, two sends.
    { role: 'assistant', text: '', tools: [{ ...bash('s2', `for id in pw-task-fold pw-task-rider; do walnut tools call task_send "{\\"to\\":\\"$id\\",\\"title\\":\\"Heads up\\"}"; done`), result: 'Message delivered on this host to pw-task-fold\nMessage delivered on this host to pw-task-rider' }], timestamp: at(n++) },
    { role: 'assistant', text: 'OR_ANSWER_G both told.', timestamp: at(n++) },
  ];
  await mockSession(page, history, 'idle');
  const hist = await open(page);
  await expect(hist).toContainText('OR_ANSWER_G', { timeout: 60000 });
  const between = await rowsBetween(hist, 'OR_ANSWER_F', 'OR_ANSWER_G');
  expect(between).toHaveLength(1);
  await expect.poll(async () => (await rowsBetween(hist, 'OR_ANSWER_F', 'OR_ANSWER_G'))[0])
    .toMatch(/^Received 1 message( from [^·]+)? · Sent 3 to Turn fold fixture task, Rider fixture task/);
  const fold = hist.locator('[data-testid="turn-fold"]', { hasText: 'Sent 3' });
  await fold.locator(':scope > .tool-run-toggle').click();
  // Opened: each send card names its task, never "another session".
  const cards = fold.locator('.provenance-card[data-envelope-kind="outbound"]');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Turn fold fixture task');
  await expect(cards.nth(1)).toContainText('Turn fold fixture task, Rider fixture task');
  for (let i = 0; i < 2; i++) await expect(cards.nth(i)).not.toContainText('another session');
  await hist.locator('.session-msg', { hasText: 'OR_ANSWER_G' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-named-sends.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  // The loop's card opens to a link per task.
  await cards.nth(1).locator('.provenance-fold').first().click();
  await expect(cards.nth(1).locator('a.task-link')).toHaveCount(2);
});
