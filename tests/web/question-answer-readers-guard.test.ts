/**
 * GUARD: every reader that decides "this assistant text answers question X"
 * agrees, and none of them files the running turn's reply under a question that
 * was only taken mid-turn (2026-11-03, the user: "this is not answer question of
 * this thread somehow consider as result of the thread").
 *
 * The bug was one rule told by position in several places: "the words after a
 * question's line are its answer". The live owners (stream/chat-order.ts), and
 * after the transcript landed the thread tree, the stats (Answered / No answer),
 * the card, the review sidebar and the Tree page all read it that way, so a
 * question asked while the main turn ran took that turn's reply.
 *
 * The rule now lives in two places only, the live owners and
 * utils/tagged-reply-split.ts, which lays the stored rows out so that their
 * position IS their question. Every positional reader must read those rows.
 *
 * This test enumerates, from the source, every file that walks rows or blocks
 * by role next to a question concept, and fails on one not listed below with the
 * way it keeps the rule. It pins that the positional readers are fed the split
 * rows and the live ones go through `pageKeyOfBlock`, and it runs the reported
 * shape through every stored reader at once: they must all agree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { splitTaggedReplies, type SplitRow } from '@/utils/tagged-reply-split';
import { buildThreadTree, threadKeyOf, ROOT_THREAD_KEY } from '@/utils/thread-tree';
import { withTagAnchors } from '@/utils/question-tag';
import { deriveThreadStats } from '@/utils/thread-stack-state';
import { cardTurnsOf } from '@/utils/thread-card';
import { reviewTurnIndex } from '@/components/sessions/ThreadReviewSidebar';
import type { SessionHistoryMessage, SessionThreadAnchor } from '@/types/session';

const ROOT = join(__dirname, '..', '..');
const WEB = join(ROOT, 'web', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(WEB).map((p) => ({ rel: relative(ROOT, p), src: readFileSync(p, 'utf8') }));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Walks rows or blocks by role, next to a question concept; or reads the reply tag to file. */
const decidesAnswers = (src: string) =>
  (/role [!=]== '(user|assistant)'/.test(src)
    && /threadIdOf|ThreadTree|ThreadNode|rowThreadKey|questionSeqOfRow|parseQuestionTag|stripQuestionTag|threadKey/.test(src))
  || /\b(parseQuestionTag|tagKeyAtBlock|blockTagKeys|tagKeyOfBlocks|tagKeysOfBlocks|liveLineOwners)\(/.test(src);

/** How each file keeps "a question taken mid-turn claims only its own tag". */
const READERS: Record<string, string> = {
  // The two places the rule lives.
  'web/src/stream/chat-order.ts': 'the live rule: liveLineOwners',
  'web/src/utils/tagged-reply-split.ts': 'the stored rule: lays rows out so position is the question',
  // Reads the tag the same way (a tag files its own block or row, never the words after).
  'web/src/utils/question-tag.ts': 'tag reading: withTagAnchors, blockTagKeys',
  // Positional, over the split rows only (SessionChatHistory feeds them).
  'web/src/utils/thread-tree.ts': 'positional over split rows: buildThreadTree',
  'web/src/utils/thread-stack-state.ts': 'positional over split rows: deriveThreadStats',
  'web/src/utils/thread-card.ts': 'positional over split rows: cardTurnsOf',
  'web/src/components/sessions/ThreadReviewSidebar.tsx': 'positional over split rows: reviewTurnIndex',
  // Wires them: split rows for the positional readers, pageKeyOfBlock for live blocks.
  'web/src/components/sessions/SessionChatHistory.tsx': 'split rows + pageKeyOfBlock',
  // Display only: strips the tag from the text on screen.
  'web/src/components/sessions/SessionMessage.tsx': 'display only',
  // Header counts and the drawer mount: no attribution.
  'web/src/components/sessions/SessionPanel.tsx': 'no attribution',
};

/** The positional readers: each takes rows and files a row under the user row before it. */
const POSITIONAL = ['buildThreadTree', 'deriveThreadStats', 'cardTurnsOf', 'withTagAnchors', 'reviewTurnIndex'] as const;
/** Where they may be called from (each feeds the split rows). */
const POSITIONAL_CALLERS = new Set([
  'web/src/components/sessions/SessionChatHistory.tsx',
  'web/src/components/sessions/useThreadReviewPane.tsx',
]);

describe('guard: one rule decides which question an answer belongs to', () => {
  it('every file that files answers by role and question is listed with how it keeps the rule', () => {
    const deciding = files.filter((f) => decidesAnswers(f.src)).map((f) => f.rel).sort();
    const unlisted = deciding.filter((rel) => !(rel in READERS));
    expect(unlisted, `A new reader decides which question an answer belongs to.
Read the split rows (tagged-reply-split.ts) or pageKeyOfBlock (live), never "the rows after a question's row", then list it here.`).toEqual([]);
    expect(Object.keys(READERS).filter((rel) => !deciding.includes(rel)), 'a listed file stopped deciding: remove it').toEqual([]);
  });

  it('the positional readers are called only where the split rows are at hand, and only with them', () => {
    for (const name of POSITIONAL) {
      const callers = files.filter((f) => new RegExp(`(?<![\\w.])${name}\\(`).test(f.src) && !new RegExp(`function ${name}\\b`).test(f.src)).map((f) => f.rel);
      expect(callers.filter((rel) => !POSITIONAL_CALLERS.has(rel)), `${name} called from a new place`).toEqual([]);
    }
    const history = read('web/src/components/sessions/SessionChatHistory.tsx');
    expect(history).toMatch(/const messages = useMemo\(\(\) => splitTaggedReplies\(loadedMessages\), \[loadedMessages\]\)/);
    expect(history).toMatch(/withPendingUserRows<ThreadTreeMessage>\(messages, optimisticMessages\)/);
    expect(history).toMatch(/buildThreadTree\(threadRows, tagAnchors\)/);
    expect(history).toMatch(/withTagAnchors\(threadRows as ThreadTreeMessage\[\]/);
    expect(history).toMatch(/deriveThreadStats\(messages, rowThreadKey\)/);
    expect(history).toMatch(/cardTurnsOf\(messages, /);
    expect(history).toMatch(/useThreadReviewPane\(\{[\s\S]{0,300}\bmessages, liveText:/);
    expect(history).not.toMatch(new RegExp(`(${POSITIONAL.join('|')})\\((loadedMessages|historyRows)\\b`));
    expect(read('web/src/components/sessions/useThreadReviewPane.tsx')).toMatch(/reviewTurnIndex\(a\.messages\)/);
  });

  it('live blocks get their question through pageKeyOfBlock alone', () => {
    const history = read('web/src/components/sessions/SessionChatHistory.tsx');
    // The owners are read in pageKeyOfBlock and in the live turn's key, nowhere else.
    expect(history.match(/\blineOwners\[/g)?.length ?? 0).toBe(3);
    expect(history.match(/\bblockTagKeys\(/g)?.length ?? 0).toBe(1);
    expect(history).toMatch(/const pageKeyOfBlock = \(index: number\): string => \{\n\s*const byLine = lineOwners\[index\]/);
    // The live owners know which turn each block is in: the stream's own boundary too.
    expect(history).toMatch(/liveLineOwners\(blocks, takenLines, lineKeyOf, lineSeqsOf,[\s\S]{0,400}liveTurnEnds\)/);
  });

  it('the reported shape: every stored reader keeps the main turn\'s reply out of the question', () => {
    type Row = SplitRow & { timestamp?: string };
    const rows: Row[] = [
      { role: 'user', msgId: 'u0', text: 'Explain the plan.' },
      { role: 'assistant', msgId: 'a0', text: 'Alpha line.\nBeta line.' },
      { role: 'user', msgId: 'u1', text: 'Build revision 4 of the page.' },
      { role: 'assistant', msgId: 'a1', text: '', tools: [{ name: 'Bash' }] },
      { role: 'user', msgId: 'queue-1', sourceUuid: 'src-q3', text: 'Can a pod use an account from another namespace?', hints: [{ kind: 'question', arg: '3' }] },
      { role: 'assistant', msgId: 'a2', text: '', tools: [{ name: 'Write' }] },
      { role: 'assistant', msgId: 'a3', text: 'Revision 4 is built: 25 sections.' },
    ];
    const anchors: SessionThreadAnchor[] = [{ msgId: 'src-q3', parent: 'a0', quote: { exact: 'Alpha line.' }, source: 'selection', at: '2026-11-03T00:00:00Z' }];
    const split = splitTaggedReplies(rows);
    const tree = buildThreadTree(split as never, withTagAnchors(split as never, anchors, new Map([[3, 'src-q3']])));
    const key = threadKeyOf(anchors[0]);
    const keyOf = (id: string | undefined) => tree.byRow.get(id ?? '')?.key ?? ROOT_THREAD_KEY;
    const stats = deriveThreadStats(split as never, keyOf);
    const REPLY = 'Revision 4 is built: 25 sections.';
    // The tree (Tree Mode pages, map counts).
    expect(tree.byRow.get('a3')?.key).toBe(ROOT_THREAD_KEY);
    // The stats (Answered / No answer, the takeaway's last answer).
    expect(stats.lastAnswer.get(key)).toBeUndefined();
    expect(stats.lastAnswer.get(ROOT_THREAD_KEY)).toBe(REPLY);
    expect(stats.turnEnds.get('src-q3')).toBe('silent');
    // The card.
    expect(cardTurnsOf(split, tree.byKey.get(key)).flatMap((t) => t.replies.map((r) => r.text))).toEqual([]);
    // The review sidebar.
    expect(reviewTurnIndex(split as unknown as SessionHistoryMessage[]).get('src-q3')?.reply).toBeUndefined();
    expect(reviewTurnIndex(split as unknown as SessionHistoryMessage[]).get('u1')?.reply?.text).toBe(REPLY);
  });
});
