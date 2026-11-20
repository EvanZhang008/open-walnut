/**
 * Ratchet: everything that waits on the user is drawn in ONE card (actions/AskCard.tsx AskCardFrame,
 * or AskCard built on it), with its choices as ONE kind of button (org/OrgInlineAnswer.tsx AskOptions).
 *
 * 2026-11-20, the user, on a lead's thread whose summary listed "A (recommended)" and "B" while its
 * card offered only Acknowledge: "why not give me some options ... if you recommend this, why can I
 * not just click it?", then "it has to be unified ... there are still two kinds of thread or two
 * kinds of needs-me ... it can always give an option, if needed. Acknowledge is for when I do not
 * need to make any choice".
 *
 * The class, found from the source so a new member joins by itself: every web component that draws
 * an answer to something waiting on him (an ask's or a letter's or a Board choice's buttons, a live
 * prompt, an approval's words) must draw it inside the one card, or be listed below with why it is
 * not a card of the Needs you set (the thread card, the card of a thread below, a task row's Action
 * needed, the session strip, a node's Needs you list, a Board card's prompt).
 *
 * Then the choices: every source of choices (ACTION_KINDS with options: an ask's ask_options, a
 * letter's actions, a Board choice's options, an AskUserQuestion's options, and a thread's own
 * options) keeps its buttons where a thread card draws it, and a card that waits on him never
 * offers Acknowledge.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ACTION_KINDS } from '../../src/core/action-needed.js';
import { taskAskNow } from '../../src/core/org/thread-report-ask.js';
import type { ActionItem } from '../../src/core/action-needed.js';

const ROOT = join(__dirname, '..', '..');
const WEB = join(ROOT, 'web', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const read = (rel: string): string => strip(readFileSync(join(ROOT, rel), 'utf8'));

/** The parts that answer something waiting on him: drawing one draws a needs-you item. */
const ANSWER_PARTS = /<(OrgInlineAnswer|KanbanCardPrompt|AskOptions|ThreadOptions|ThreadLetterAnswer|ApprovalReply|PermissionRequestCard|PermissionAnswerButtons|PermissionAnswerForm)\b/;
/** The one card. */
const THE_CARD = /<(AskCardFrame|AskCard)\b/;

/** Not a card of the Needs you set, each with why. Only shrinks. */
const NOT_A_CARD: Record<string, string> = {
  // The parts themselves, drawn inside the card by its users.
  'web/src/components/org/OrgInlineAnswer.tsx': 'the answer parts (AskOptions, the words box, a Board prompt), drawn inside the card',
  'web/src/components/common/PermissionPromptControls.tsx': 'a live prompt\'s answer form, a part the toast and the bell panel draw',
  'web/src/components/org/ThreadLetterAnswer.tsx': 'a decision letter\'s answer on its thread, a part the thread card draws inside the card',
  'web/src/components/board/kanban/KanbanCardPrompt.tsx': 'a Board card\'s live prompt, a part the Board card draws inside the card',
  // Its own surfaces, not a card in a list of what waits on him.
  'web/src/components/sessions/StreamingBlockView.tsx': 'the chat transcript\'s own record of the prompt, under the strip that carries its card',
  'web/src/components/common/NotificationToaster.tsx': 'a passing toast for a live prompt; its card is in the strip and on the task row',
  // Not folded yet: the bell panel's own detail pane for a live prompt (its rail and detail layout).
  'web/src/components/common/NotificationPanel.tsx': 'the bell panel\'s detail pane of a live prompt; its card is in the strip and on the task row',
};

describe('one card for everything that waits on him', () => {
  const drawers = walk(WEB)
    .map((p) => relative(ROOT, p).split('\\').join('/'))
    .filter((rel) => ANSWER_PARTS.test(read(rel)));

  it('finds the members (the class is not empty)', () => {
    for (const known of ['web/src/components/actions/ActionNeeded.tsx', 'web/src/components/org/OrgThreads.tsx', 'web/src/components/org/PoppedThreadCard.tsx', 'web/src/components/org/OrgTaskRail.tsx', 'web/src/components/board/kanban/KanbanCard.tsx']) {
      expect(drawers, known).toContain(known);
    }
  });

  it('every component drawing one draws it in the one card, or says why it is no card', () => {
    const own = drawers.filter((rel) => !NOT_A_CARD[rel] && !THE_CARD.test(read(rel)));
    expect(own, 'draw it with AskCardFrame (actions/AskCard.tsx), or list it in NOT_A_CARD with why').toEqual([]);
  });

  it('the list holds no file that went away or now uses the card', () => {
    for (const rel of Object.keys(NOT_A_CARD)) expect(drawers, `${rel} draws no answer part now: drop it`).toContain(rel);
  });

  it('one kind of choice button: only AskOptions draws org-answer-option', () => {
    const drawn = walk(WEB).map((p) => relative(ROOT, p).split('\\').join('/')).filter((rel) => /data-testid="org-answer-option"/.test(read(rel)));
    expect(drawn).toEqual(['web/src/components/org/OrgInlineAnswer.tsx']);
    const src = read('web/src/components/org/OrgInlineAnswer.tsx');
    expect(src.match(/data-testid="org-answer-option"/g)).toHaveLength(1);
  });
});

describe('every source of choices keeps its buttons on a thread card', () => {
  const OPTIONS = [{ id: 'a', label: 'Plan A' }, { id: 'b', label: 'Plan B', recommended: true }];

  it('a thread holding any kind of item carries its choices (ACTION_KINDS, enumerated)', () => {
    for (const kind of ACTION_KINDS) {
      const item: ActionItem = { kind, id: `id-${kind}`, summary: `Pick for ${kind}`, options: OPTIONS };
      const task = { id: 'task-a', phase: 'NEED_ACTION' as const, status: 'todo' as const, user_status: { state: 'needs' as const, source: 'session' as const, actions: [item] } };
      // taskAskNow holds the task's ask: its first ask item, or its own item otherwise.
      const held = taskAskNow(task);
      if (held?.id === item.id) expect(held.options, kind).toEqual(OPTIONS);
    }
    // An ask's options in its report's one-click shape (ask_options) reach the thread too.
    const form = { kind: 'ask' as const, id: 'ask-1', summary: 'Pick', form: { options: OPTIONS } } as unknown as ActionItem;
    expect(taskAskNow({ id: 'task-a', phase: 'NEED_ACTION', status: 'todo', user_status: { state: 'needs', source: 'session', actions: [form] } })?.options).toEqual(OPTIONS);
  });

  it('a held item of any kind is drawn by the one ask card, which answers every kind', () => {
    const threads = read('web/src/components/org/OrgThreads.tsx');
    const held = /const heldItem = [^\n]+/.exec(threads)?.[0] ?? '';
    expect(held, 'the thread card takes the held item whatever its kind').not.toMatch(/kind ===/);
    expect(threads).toMatch(/<AskCard task=\{owner\} item=\{heldItem\}/);
    const card = read('web/src/components/actions/ActionNeeded.tsx');
    for (const kind of ACTION_KINDS) expect(card, `AskCard answers a ${kind}`).toMatch(new RegExp(`['"]${kind}['"]`));
  });

  it('a thread\'s own options are drawn with AskOptions on its card and on the card of a thread below', () => {
    for (const rel of ['web/src/components/org/OrgThreads.tsx', 'web/src/components/org/PoppedThreadCard.tsx']) {
      expect(read(rel), rel).toMatch(/<ThreadOptions thread=\{t\}/);
    }
    const parts = read('web/src/components/org/OrgInlineAnswer.tsx');
    const fn = parts.slice(parts.indexOf('export function ThreadOptions'), parts.indexOf('export function ThreadOptions') + 1500);
    expect(fn).toMatch(/<AskOptions\b/);
  });

  it('a card waiting on him offers no Acknowledge: it shows only off needs', () => {
    const threads = read('web/src/components/org/OrgThreads.tsx');
    // The actions row with Acknowledge is drawn only when the card does not wait on him.
    expect(threads).toMatch(/\{needs \? null : /);
    expect(threads.indexOf('{needs ? null : ')).toBeLessThan(threads.indexOf('data-testid="org-thread-ack"'));
    expect(read('web/src/components/org/PoppedThreadCard.tsx')).not.toMatch(/org-thread-ack|Acknowledge/);
  });
});
