/**
 * A user row the CLI injected (a compaction's summary, a hook's context, a
 * skill's text) starts no turn: it belongs to the turn it sits in (isTurnHead in
 * web/src/utils/thread-tree.ts).
 *
 * 2026-11-03, the user's Go Sandbox review: question 6 was asked, the session
 * compacted, and the answer (`[Q6] ...`) came after the summary and the
 * SessionStart hook's context. Both injected rows started turns of their own, so
 * the card found no reply in question 6's turn ("No answer") while the `[Q6]` tag
 * marked it answered ("Answered"). The shape here is that session's, words
 * replaced.
 *
 * The guard below lists every thread reader from the source and fails on a turn
 * cut by `role === 'user'` that does not go through isTurnHead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitTaggedReplies, type SplitRow } from '@/utils/tagged-reply-split';
import { ROOT_THREAD_KEY, buildThreadTree, isTurnHead, threadKeyOf } from '@/utils/thread-tree';
import { withTagAnchors } from '@/utils/question-tag';
import { deriveThreadStats } from '@/utils/thread-stack-state';
import { cardTurnsOf } from '@/utils/thread-card';
import { reviewTurnIndex } from '@/components/sessions/ThreadReviewSidebar';
import type { SessionHistoryMessage, SessionThreadAnchor } from '@/types/session';

type Row = SplitRow & { timestamp?: string; injected?: boolean; systemVariant?: 'compact' };

const rows: Row[] = [
  { role: 'user', msgId: 'u5', text: 'Draw the flow.' },
  { role: 'assistant', msgId: 'a5', text: 'Step one, step two, step three.' },
  { role: 'user', msgId: 'q6', text: 'Does the deployer have to agree?' },
  { role: 'system', msgId: 'c1', text: 'Context compacted', systemVariant: 'compact' },
  { role: 'user', msgId: 'i1', text: 'This session is being continued from a previous conversation...', injected: true },
  { role: 'user', msgId: 'i2', text: 'Hook context (SessionStart hook): ...', injected: true },
  { role: 'assistant', msgId: 'a6t', text: '', tools: [{ name: 'Read' }] as never },
  { role: 'assistant', msgId: 'a6', text: '[Q6]\n\nNo, the deployer is never asked.' },
  { role: 'user', msgId: 'u7', text: 'Next topic.' },
  { role: 'assistant', msgId: 'a7', text: 'Sure.' },
];
const anchors: SessionThreadAnchor[] = [{ msgId: 'q6', parent: 'a5', quote: { exact: 'step two' }, source: 'selection', at: '2026-11-03T06:22:14Z' }];

describe('an injected row inside a question\'s turn', () => {
  const split = splitTaggedReplies(rows);
  const tree = buildThreadTree(split as never, withTagAnchors(split as never, anchors, new Map([[6, 'q6']])));
  const key = threadKeyOf(anchors[0]);
  const keyOf = (id: string | undefined) => tree.byRow.get(id ?? '')?.key ?? ROOT_THREAD_KEY;

  it('is no turn head', () => {
    expect(isTurnHead(rows[2])).toBe(true);
    expect(isTurnHead(rows[4])).toBe(false);
    expect(isTurnHead(rows[1])).toBe(false);
  });

  it('the answer after it is the question\'s: on its page, in its card, in its stats, in the review column', () => {
    expect(keyOf('a6')).toBe(key);
    expect(keyOf('i1')).toBe(key);
    expect(keyOf('a7')).toBe(ROOT_THREAD_KEY);
    const card = cardTurnsOf(split, tree.byKey.get(key));
    expect(card).toHaveLength(1);
    expect(card[0].replies.map((r) => r.msgId)).toEqual(['a6']);
    const stats = deriveThreadStats(split as never, keyOf);
    expect(stats.answered.has('q6')).toBe(true);
    expect(stats.turnEnds.has('q6')).toBe(false);
    expect(stats.lastQuestion.get(key)).toBe('Does the deployer have to agree?');
    const turn = reviewTurnIndex(split as unknown as SessionHistoryMessage[]).get('q6');
    expect(turn?.reply?.msgId).toBe('a6');
  });
});

// 2026-11-07, Tree Mode on a copy of the user's data: a question page's turn was
// stopped, and the CLI's "[Request interrupted by user]" line started a turn of
// its own, which no anchor names, so "Turn interrupted" was drawn on the main
// conversation's page instead of the question's.
describe('a stopped turn inside a question\'s turn', () => {
  const stopped: Row[] = [
    { role: 'user', msgId: 'u1', text: 'List the steps.' },
    { role: 'assistant', msgId: 'a1', text: 'One, two, three.' },
    { role: 'user', msgId: 'q2', text: 'Write a long list about step two.' },
    { role: 'assistant', msgId: 'a2', text: '', tools: [{ name: 'Read' }] as never },
    { role: 'user', msgId: 'x1', text: '[Request interrupted by user]' },
    { role: 'user', msgId: 'x2', text: '[Request interrupted by user for tool use]' },
    { role: 'user', msgId: 'u3', text: 'Back to the list.' },
  ];
  const qa: SessionThreadAnchor[] = [{ msgId: 'q2', parent: 'a1', quote: { exact: 'two' }, source: 'selection', at: '2026-11-07T08:20:00Z' }];
  const tree = buildThreadTree(stopped as never, qa);
  const key = threadKeyOf(qa[0]);
  const keyOf = (id: string | undefined) => tree.byRow.get(id ?? '')?.key ?? ROOT_THREAD_KEY;

  it('is no turn head, in either of the CLI\'s variants', () => {
    expect(isTurnHead(stopped[4])).toBe(false);
    expect(isTurnHead(stopped[5])).toBe(false);
    expect(isTurnHead({ role: 'user', text: 'I was [Request interrupted by user] here' })).toBe(true);
  });

  it('stays on the question\'s page, and a question stopped before its answer reads stopped', () => {
    expect(keyOf('x1')).toBe(key);
    expect(keyOf('x2')).toBe(key);
    expect(keyOf('u3')).toBe(ROOT_THREAD_KEY);
    const stats = deriveThreadStats(stopped as never, keyOf);
    expect(stats.turnEnds.get('q2')).toBe('interrupted');
  });
});

// ── Guard: every thread reader cuts turns through isTurnHead ──

const WEB = path.resolve(__dirname, '../../web/src');
const READERS = [
  ...fs.readdirSync(path.join(WEB, 'utils')).filter((f) => /^(thread-.*|tagged-reply-split|question-tag|ask-answer|file-thread|review-sidebar.*)\.ts$/.test(f)).map((f) => `utils/${f}`),
  ...fs.readdirSync(path.join(WEB, 'components/sessions')).filter((f) => /^(Thread.*\.tsx|useThread.*\.tsx?|thread-.*\.ts)$/.test(f)).map((f) => `components/sessions/${f}`),
];
/** Role checks that cut no turn, each with why. */
const NOT_A_TURN_CUT: Array<[RegExp, string]> = [
  [/isTurnHead\(/, 'the predicate itself'],
  [/sourceUuid : undefined/, 'threadIdOf: a user row is known by the uuid it was sent under'],
  [/role === 'user' \? undefined : m\.ownerId/, 'rowOwnerOf: only a non-user row has an owner'],
  [/role !== 'user' && m\.ownerId !== undefined/, 'a row filed by its owner is never a user row'],
  [/sourceUuid \|\| !!m\.msgId\?\.startsWith\('queue-'\)/, 'isMidTurn: a property of one line, not a cut'],
  [/isStrictAskRow\(|strictAskOf\(|strictHint\(/, 'reads one row\'s hint: an injected row carries none'],
  [/userUuid/, 'an optimistic bubble, never a history row'],
  [/role === 'user' && !!m\.userUuid/, 'optimistic bubbles'],
  [/INTERRUPT_RE\.test\(/, 'a stopped turn\'s marker: it ends the question it sits in, it cuts no turn'],
];

describe('guard: thread readers cut turns only through isTurnHead', () => {
  it('finds the readers', () => {
    for (const f of ['utils/thread-tree.ts', 'utils/thread-card.ts', 'utils/thread-stack-state.ts', 'utils/tagged-reply-split.ts', 'utils/question-tag.ts', 'components/sessions/ThreadReviewSidebar.tsx']) {
      expect(READERS).toContain(f);
    }
  });

  it('no role check outside the predicate, unless it cuts no turn', () => {
    const bad: string[] = [];
    for (const rel of READERS) {
      const lines = fs.readFileSync(path.join(WEB, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/\.role\s*[!=]==\s*'user'/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
        if (NOT_A_TURN_CUT.some(([re]) => re.test(line))) return;
        // `if (r.role === 'user' && !isTurnHead(r)) continue;` right above: injected rows are gone here.
        if (/isTurnHead\(/.test(lines[i - 1] ?? '')) return;
        // A check right before reading that row's hint (strictAskOf): one row, no cut.
        if (/strictAskOf\(|strictHint\(/.test(lines[i + 1] ?? '')) return;
        bad.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
