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
 *
 * The strict protocol (2026-11-03, utils/ask-answer.ts): a strict question's
 * answer is the text inside its `<walnut-ask-answer>` tag alone, wherever it
 * sits, so position no longer says it. The split gives such rows an explicit
 * owner (`ownerId`); every positional reader must honor it, and the live owner
 * gives a strict question only the blocks that open with its tag. The checks
 * below fail on a reader that files by place alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { splitTaggedReplies, type SplitRow } from '@/utils/tagged-reply-split';
import { buildThreadTree, threadKeyOf, ROOT_THREAD_KEY } from '@/utils/thread-tree';
import { withTagAnchors } from '@/utils/question-tag';
import { deriveThreadStats } from '@/utils/thread-stack-state';
import { strictAskHintText } from './helpers/strict-ask';
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
    && /threadIdOf|ThreadTree|ThreadNode|rowThreadKey|questionSeqOfRow|parseQuestionTag|stripQuestionTag|threadKey|strictAskOf|isStrictAskRow/.test(src))
  || /\b(parseQuestionTag|tagKeyAtBlock|blockTagKeys|tagKeyOfBlocks|tagKeysOfBlocks|liveLineOwners|parseAskAnswers|askAnswerOpening|strictAsksOf|fileStrictAnswers)\(/.test(src);

/** How each file keeps "a question taken mid-turn claims only its own tag". */
const READERS: Record<string, string> = {
  // The two places the rule lives.
  'web/src/stream/chat-order.ts': 'the live rule: liveLineOwners',
  'web/src/utils/tagged-reply-split.ts': 'the stored rule: lays rows out so position is the question',
  // Reads the tag the same way (a tag files its own block or row, never the words after).
  'web/src/utils/question-tag.ts': 'tag reading: withTagAnchors, blockTagKeys',
  // The strict tag's grammar and the strict questions on screen.
  'web/src/utils/ask-answer.ts': 'the strict tag: parseAskAnswers, strictAsksOf',
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
  // The person's own sends only (user rows): a failed send marks its own thread, a confirmed one clears its draft.
  'web/src/utils/thread-meta.ts': 'user rows only: latestUnsentRows, no answer attribution',
  'web/src/utils/drafts.ts': 'user rows only: settleConfirmedDrafts, no answer attribution',
};

/** The positional readers: each takes rows and files a row under the user row before it. */
const POSITIONAL = ['buildThreadTree', 'deriveThreadStats', 'cardTurnsOf', 'withTagAnchors', 'reviewTurnIndex'] as const;
/** Each positional reader's file honors the split's explicit owner. */
const POSITIONAL_FILES = [
  'web/src/utils/thread-tree.ts',
  'web/src/utils/thread-stack-state.ts',
  'web/src/utils/thread-card.ts',
  'web/src/components/sessions/ThreadReviewSidebar.tsx',
  'web/src/utils/question-tag.ts',
] as const;
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
    expect(history).toMatch(/const placeKeyOfBlock = \(index: number\): string => \{\n\s*const byLine = lineOwners\[index\]/);
    // A strict question owns only a block opening with its tag; any other block
    // it would own by place reads in the main conversation, except a card about
    // the turn that the transcript has no row for (utils/stream-block-page.ts).
    expect(history).toMatch(/const pageKeyOfBlock = \(index: number\): string => pageOfStreamBlock\(\n\s*blocks\[index\], strictSpanKeyOfBlock\(blocks\[index\]\), placeKeyOfBlock\(index\),\n\s*\(key\) => strictAsks\.byKey\.has\(key\), ROOT_THREAD_KEY,\n\s*\);/);
    const page = read('web/src/utils/stream-block-page.ts');
    expect(page).toMatch(/if \(spanKey !== null\) return spanKey;\n\s*if \(!isStrictKey\(placeKey\)\) return placeKey;\n\s*return block\?\.type === 'system' && !hasTranscriptTwin\(block\) \? placeKey : rootKey;/);
    expect(history.match(/\bplaceKeyOfBlock\(/g)?.length ?? 0).toBe(1);
    // The `[Qn]` tag never files a strict question's text.
    expect(history.match(/\bkeyBySeq\b/g)?.length ?? 0).toBe(4);
    // The live owners know which turn each block is in: the stream's own boundary too.
    expect(history).toMatch(/liveLineOwners\(blocks, takenLines, lineKeyOf, lineSeqsOf,[\s\S]{0,400}liveTurnEnds\)/);
  });

  it('every positional reader honors the split\'s explicit owner', () => {
    for (const rel of POSITIONAL_FILES) {
      expect(read(rel), `${rel} reads rows by place: it must honor ownerId (tagged-reply-split.ts fileStrictAnswers)`).toMatch(/\bownerId\b|\browOwnerOf\(/);
    }
  });

  it('strict questions: every stored reader files only the tagged text, wherever it sits', () => {
    type Row = SplitRow & { timestamp?: string };
    const strict = (msgId: string, text: string, thread: string, name: string, extra: Partial<Row> = {}): Row =>
      ({ role: 'user', msgId, text, hints: [{ kind: 'question', arg: thread, text: strictAskHintText(thread, name) }], ...extra });
    const rows: Row[] = [
      { role: 'user', msgId: 'u0', text: 'Explain the plan.' },
      { role: 'assistant', msgId: 'a0', text: 'Alpha line.\nBeta line.' },
      // (a) answered inside its tag, with words outside it.
      strict('q6', 'What is alpha?', '6', 'What is alpha'),
      { role: 'assistant', msgId: 'a1', text: 'Checking first.', tools: [{ name: 'Bash' }] },
      { role: 'assistant', msgId: 'a2', text: 'Main words.\n<walnut-ask-answer thread="6" name="What is alpha">\nAlpha means one.\n</walnut-ask-answer>\nMore main words.' },
      // (b) no tag at all: the words stay in the main conversation.
      strict('q7', 'What is beta?', '7', 'What is beta'),
      { role: 'assistant', msgId: 'a3', text: 'Beta means two.' },
    ];
    const anchors: SessionThreadAnchor[] = [
      { msgId: 'q6', parent: 'a0', quote: { exact: 'Alpha line.' }, source: 'selection', at: '2026-11-03T00:00:00Z' },
      { msgId: 'q7', parent: 'a0', quote: { exact: 'Beta line.' }, source: 'selection', at: '2026-11-03T00:00:00Z' },
    ];
    const split = splitTaggedReplies(rows);
    const tree = buildThreadTree(split as never, withTagAnchors(split as never, anchors, new Map()));
    const k6 = threadKeyOf(anchors[0]);
    const k7 = threadKeyOf(anchors[1]);
    const keyOf = (id: string | undefined) => tree.byRow.get(id ?? '')?.key ?? ROOT_THREAD_KEY;
    const textOf = (key: string) => split.filter((r) => r.role === 'assistant' && keyOf(r.msgId) === key).map((r) => r.text);
    // The tree (the Tree page, the timeline's question labels).
    expect(textOf(k6)).toEqual(['Alpha means one.']);
    expect(textOf(k7)).toEqual([]);
    expect(textOf(ROOT_THREAD_KEY)).toEqual(['Alpha line.\nBeta line.', 'Checking first.', 'Main words.', 'More main words.', 'Beta means two.']);
    // The stats: 6 answered, 7 waits (never Answered, never No answer).
    const stats = deriveThreadStats(split as never, keyOf);
    expect(stats.lastAnswer.get(k6)).toBe('Alpha means one.');
    expect(stats.answered.has('q6')).toBe(true);
    expect(stats.lastAnswer.get(k7)).toBeUndefined();
    expect(stats.turnEnds.get('q7')).toBeUndefined();
    expect([...stats.unanswered]).toEqual([k7]);
    expect(stats.lastAnswer.get(ROOT_THREAD_KEY)).toBe('Beta means two.');
    // The card.
    expect(cardTurnsOf(split, tree.byKey.get(k6)).flatMap((t) => t.replies.map((r) => r.text))).toEqual(['Alpha means one.']);
    expect(cardTurnsOf(split, tree.byKey.get(k7)).flatMap((t) => t.replies.map((r) => r.text))).toEqual([]);
    // The review sidebar.
    const review = reviewTurnIndex(split as unknown as SessionHistoryMessage[]);
    expect(review.get('q6')?.reply?.text).toBe('Alpha means one.');
    expect(review.get('q7')?.reply).toBeUndefined();
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
