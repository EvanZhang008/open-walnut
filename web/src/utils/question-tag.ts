/**
 * Question numbers and the reply tag: how an answer says which question it
 * belongs to.
 *
 * Every question gets a NUMBER when it is asked (`SessionThreadMeta.seq`, the
 * next free one; questions older than this field are numbered by transcript
 * order, before every numbered one). The number is what the sidebar, the turn
 * label and the model all use for the question, so it never changes once given.
 *
 * A question's send opens with a machine banner asking the model to begin its
 * reply with the line `[Q<n>]`. The tag is Walnut's own convention between the
 * prompt and the reply, so it is parsed here (not in the transcript parser),
 * stripped from the text on screen, and used to FILE the reply: a turn whose
 * first answer text carries `[Q4]` belongs to question 4, whatever the user row
 * before it says. That is what makes attribution survive the cases where the
 * user row's pre-assigned uuid is lost (a `--resume` fallback, two sends merged
 * into one turn): before this, such an answer showed while it streamed and then
 * moved to the main conversation the moment the transcript absorbed it.
 *
 * Pure: unit tested in tests/web/question-tag.test.ts.
 */
import type { SessionThreadAnchor, SessionThreadMeta } from '@/types/session';
import { ROOT_THREAD_KEY, isTurnHead, threadIdOf, type ThreadTree, type ThreadTreeMessage } from '@/utils/thread-tree';
import type { ThreadMetaIndex } from '@/utils/thread-meta';
import { ASK_THREAD_RE, isStrictAskRow, stripAskAnswerTags } from '@/utils/ask-answer';

/** `[Q4]` at the very start of a reply (blank lines and bold markers allowed). */
const TAG_HEAD = /^\s*(?:\*\*|__)?\[Q\s?(\d{1,5})\](?:\*\*|__)?[ \t]*:?[ \t]*\r?\n?/;

export interface QuestionTag {
  seq: number;
  /** The text without the tag line (leading blank lines trimmed). */
  rest: string;
}

/** The tag a reply opens with, or null. */
export function parseQuestionTag(text: string | undefined): QuestionTag | null {
  if (!text) return null;
  const m = TAG_HEAD.exec(text);
  if (!m) return null;
  const seq = Number(m[1]);
  if (!Number.isInteger(seq) || seq < 1) return null;
  return { seq, rest: text.slice(m[0].length).replace(/^\s*\n/, '') };
}

/** The reply as shown: the `[Qn]` tag line and every `<walnut-ask-answer>` tag
 *  line gone (ask-answer.ts), everything else verbatim. */
export function stripQuestionTag(text: string): string {
  return stripAskAnswerTags(parseQuestionTag(text)?.rest ?? text);
}

/**
 * A question's number rides its send as the `question` message hint, which the
 * server writes ahead of the text (src/core/hints/hint-registry.ts); the client
 * only asks for it (`questionHint`). Sends from before the hint registry carried a
 * `[Question Q4]…[/Question Q4]` banner in the text instead: the bubble still
 * hides that one (QUESTION_BANNER_RE) and `questionSeqOfRow` still reads it.
 */
export const QUESTION_BANNER_RE = /^Question Q(\d{1,5})$/;

/** The `hints` a question's send asks for: its thread id (6, 6.1; ask-answer.ts). */
export function questionHint(thread: string): Record<string, { arg: string }> {
  return { question: { arg: thread } };
}

const BANNER_IN_TEXT = /^\[Question Q(\d{1,5})\]\nThis message is question \1 of this conversation\.[\s\S]*?^\[\/Question Q\1\]/m;

/** The number an old send's banner gave it, or null (no banner). */
export function bannerSeqOf(text: string | undefined): number | null {
  const m = text ? BANNER_IN_TEXT.exec(text) : null;
  return m ? Number(m[1]) : null;
}

/** The number an OLD-protocol question row was given (its question hint, else an
 *  old banner): what its `[Qn]` reply tag names. A strict question (its hint asks
 *  for the `<walnut-ask-answer>` tag) has none: its answer is read from that tag
 *  alone, never from `[Qn]` or from its place (ask-answer.ts). */
export function questionSeqOfRow(m: { text?: string; hints?: ReadonlyArray<{ kind: string; arg?: string; text?: string }> }): number | null {
  if (isStrictAskRow(m)) return null;
  const hint = m.hints?.find((h) => h.kind === 'question');
  if (hint?.arg && /^\d{1,5}$/.test(hint.arg)) return Number(hint.arg);
  return bannerSeqOf(m.text);
}

/** The row asked a question, of either protocol. */
export function isQuestionRow(m: { text?: string; hints?: ReadonlyArray<{ kind: string; arg?: string; text?: string }> }): boolean {
  return isStrictAskRow(m) || questionSeqOfRow(m) !== null;
}

/**
 * Number per question key. A stored `seq` wins; questions from before the
 * field are numbered 1.. in transcript order, so a session keeps the numbers it
 * had (new questions always get `nextQuestionSeq`, above all of these).
 *
 * A legacy number never reuses a stored one: two questions with one number
 * send the same banner, and the model's `[Qn]` then files the answer under the
 * other one (2026-10-08: a question whose meta was not found was given 1, which
 * the first question held, and its follow-up landed there).
 */
export function questionNumbers(tree: ThreadTree, index: ThreadMetaIndex): Map<string, number> {
  const out = new Map<string, number>();
  const legacy: Array<{ key: string; at: number }> = [];
  const taken = new Set<number>();
  for (const m of index.values()) if (typeof m.seq === 'number' && m.seq > 0) taken.add(m.seq);
  for (const node of tree.threads) {
    if (node.key === ROOT_THREAD_KEY) continue;
    const seq = index.get(node.headId)?.seq;
    if (typeof seq === 'number' && seq > 0) out.set(node.key, seq);
    else legacy.push({ key: node.key, at: node.at });
  }
  legacy.sort((a, b) => a.at - b.at);
  let n = 0;
  for (const l of legacy) {
    do n += 1; while (taken.has(n));
    out.set(l.key, n);
  }
  return out;
}

/** The number the next question gets: above every stored seq and every legacy number. */
export function nextQuestionSeq(tree: ThreadTree, index: ThreadMetaIndex, list?: readonly SessionThreadMeta[]): number {
  let max = 0;
  for (const n of questionNumbers(tree, index).values()) if (n > max) max = n;
  // Meta entries whose question is not in the loaded window still hold their seq.
  for (const m of list ?? index.values()) if (typeof m.seq === 'number' && m.seq > max) max = m.seq;
  return max + 1;
}

/**
 * Thread id per question key (ask-answer.ts): the path stored when it was asked
 * (`SessionThreadMeta.thread`), else its number (a question from before paths).
 */
export function questionPaths(tree: ThreadTree, index: ThreadMetaIndex, numbers = questionNumbers(tree, index)): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of tree.threads) {
    if (node.key === ROOT_THREAD_KEY) continue;
    const stored = index.get(node.headId)?.thread;
    if (stored && ASK_THREAD_RE.test(stored)) out.set(node.key, stored);
    else if (numbers.has(node.key)) out.set(node.key, String(numbers.get(node.key)));
  }
  return out;
}

/**
 * What every surface shows as a question's number (2026-11-03, the user: the
 * ids "must match"): its thread id, the one its tag names (`6.1`), else its
 * number for a question from before ids. The badges, map rows, review cards,
 * turn labels and the composer pill read this, never `questionNumbers` (which
 * the old `[Qn]` tag is read by). Guarded by tests/web/question-label-guard.test.ts.
 */
export function questionLabels(tree: ThreadTree, index: ThreadMetaIndex): Map<string, string> {
  return questionPaths(tree, index);
}

/**
 * The meta list with the questions this client gave a number and an id to that
 * the list does not show yet (their write still in flight, or the render that
 * reads it not run yet), so two questions asked in a row never get one id.
 */
export function withIssued(list: readonly SessionThreadMeta[] | undefined, issued: readonly SessionThreadMeta[]): SessionThreadMeta[] {
  const base = [...(list ?? [])];
  if (issued.length === 0) return base;
  const have = new Set(base.map((m) => m.headId));
  return [...base, ...issued.filter((m) => !have.has(m.headId))];
}

/**
 * The thread id a new question gets (2026-11-03, the user: "the thread can be
 * nested"): asked on the main conversation (or a file), the next top-level
 * number, above every id's first part; asked inside a question (on its page, or
 * about a passage of its answer), that question's id plus the next free child
 * number: 6.1, 6.2, then 6.1.1 under 6.1. Ids are never reused.
 */
export function nextQuestionPath(
  tree: ThreadTree, index: ThreadMetaIndex, list: readonly SessionThreadMeta[] | undefined, parentKey: string,
): string {
  const known = new Set<string>(questionPaths(tree, index).values());
  for (const m of list ?? index.values()) {
    if (m.thread && ASK_THREAD_RE.test(m.thread)) known.add(m.thread);
    else if (typeof m.seq === 'number' && m.seq > 0) known.add(String(m.seq));
  }
  // The question it was asked in may be newer than the index (its meta still in
  // flight): its id is then read from the list.
  const parentHead = tree.byKey.get(parentKey)?.headId;
  const listed = parentHead ? (list ?? []).find((m) => m.headId === parentHead) : undefined;
  const given = parentHead && !index.has(parentHead) && listed?.thread && ASK_THREAD_RE.test(listed.thread) ? listed.thread : undefined;
  const parent = parentKey === ROOT_THREAD_KEY ? undefined : given ?? questionPaths(tree, index).get(parentKey);
  if (!parent) {
    let max = 0;
    for (const p of known) max = Math.max(max, Number(p.split('.')[0]) || 0);
    return String(max + 1);
  }
  const depth = parent.split('.').length + 1;
  let max = 0;
  for (const p of known) {
    const parts = p.split('.');
    if (parts.length === depth && p.startsWith(`${parent}.`)) max = Math.max(max, Number(parts[depth - 1]) || 0);
  }
  // The server's id holds six levels: deeper questions go on at the last one.
  if (depth > 6) {
    const up = parent.split('.').slice(0, -1).join('.');
    let top = 0;
    for (const p of known) {
      const parts = p.split('.');
      if (parts.length === depth - 1 && p.startsWith(`${up}.`)) top = Math.max(top, Number(parts[depth - 2]) || 0);
    }
    return `${up}.${top + 1}`;
  }
  return `${parent}.${max + 1}`;
}

/** Question key per number (the inverse of questionNumbers). */
export function keysBySeq(numbers: ReadonlyMap<string, number>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [key, n] of numbers) out.set(n, key);
  return out;
}

/**
 * The anchors plus one synthetic anchor per turn whose FIRST answer text carries
 * a tag for a question the user row is not (or not yet) anchored to, when that
 * row asked a question (a line typed in the main conversation never moves). The
 * synthetic anchor copies the target question's own (parent + passage), so the
 * tree files the whole turn, user row included, under that question. Client
 * only, never persisted: the tag in the transcript is the durable record.
 *
 * `headBySeq`: number to the question's head row id (from the meta list, so a
 * question whose head is outside the loaded window still resolves).
 */
export function withTagAnchors<M extends ThreadTreeMessage>(
  messages: readonly M[],
  anchors: readonly SessionThreadAnchor[],
  headBySeq: ReadonlyMap<number, string>,
): SessionThreadAnchor[] {
  if (headBySeq.size === 0 || messages.length === 0) return anchors as SessionThreadAnchor[];
  const anchorFor = new Map<string, SessionThreadAnchor>();
  for (const a of anchors) if (a?.msgId && a.parent) anchorFor.set(a.msgId, a);
  const strictHeads = new Set<string>();
  for (const m of messages) if (m.role === 'user' && isStrictAskRow(m)) { const id = threadIdOf(m); if (id) strictHeads.add(id); }
  const extra: SessionThreadAnchor[] = [];
  let headId: string | undefined;
  let headSeq: number | null = null;
  let headIndex = -1;
  let decided = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && !isTurnHead(m)) continue;
    if (m.role === 'user') {
      headId = threadIdOf(m);
      headSeq = questionSeqOfRow(m);
      headIndex = i;
      decided = false;
      continue;
    }
    // A row the split filed by its owner (a strict question's turn) is no answer by place.
    if (decided || !headId || m.role !== 'assistant' || m.ownerId !== undefined || !(m.text ?? '').trim()) continue;
    decided = true;
    const tag = parseQuestionTag(m.text);
    if (!tag) continue;
    const targetHead = headBySeq.get(tag.seq);
    if (!targetHead || targetHead === headId) continue;
    // A strict question's answer is its tag's alone: a `[Qn]` naming its number moves nothing.
    if (strictHeads.has(targetHead)) continue;
    const target = anchorFor.get(targetHead);
    // The tagged question must exist (its own anchor) and precede this turn.
    if (!target) continue;
    // A tag moves only a row that asked a question (its question hint or old
    // banner): the model repeats the tag it saw last, so the answer to a line
    // typed in the main conversation opened with `[Q6]` and the whole turn was
    // filed under question 6 (2026-10-31). The live chat keeps the same rule
    // (web/src/stream/chat-order.ts liveLineOwners).
    if (headSeq === null) continue;
    const own = anchorFor.get(headId);
    if (own && own.parent === target.parent && (own.quote?.exact ?? '') === (target.quote?.exact ?? '')) continue;
    // A tag that only repeats the row's own banner says nothing the anchor does
    // not: the banner is what WE numbered the send, so when they disagree the
    // number was wrong and the anchor (what the user replied in) is right.
    if (own && headSeq === tag.seq) continue;
    const targetAt = messages.findIndex((x) => threadIdOf(x) === targetHead);
    if (targetAt >= 0 && targetAt > headIndex) continue;
    extra.push({
      msgId: headId,
      parent: target.parent,
      ...(target.quote ? { quote: target.quote } : {}),
      source: 'manual',
      at: target.at,
    });
  }
  if (extra.length === 0) return anchors as SessionThreadAnchor[];
  const overridden = new Set(extra.map((a) => a.msgId));
  return [...anchors.filter((a) => !overridden.has(a.msgId)), ...extra];
}

/** Head row id per question number, from the meta list. */
export function headsBySeq(list: readonly SessionThreadMeta[] | undefined): Map<number, string> {
  const out = new Map<number, string>();
  // A strict question (one with a thread id) is never filed by a `[Qn]` tag.
  for (const m of list ?? []) if (typeof m.seq === 'number' && m.seq > 0 && m.headId && !m.thread) out.set(m.seq, m.headId);
  return out;
}

/** The tag key of a run of live blocks: the first text block's tag, resolved
 *  through `keyBySeq`; null when there is none (follow the turn's own guess). */
export function tagKeyOfBlocks(
  blocks: ReadonlyArray<{ type: string; content?: string; parentToolUseId?: string }>,
  from: number,
  to: number,
  keyBySeq: ReadonlyMap<number, string>,
): string | null {
  for (let i = from; i < to && i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== 'text' || b.parentToolUseId) continue;
    if (!(b.content ?? '').trim()) continue;
    const tag = parseQuestionTag(b.content);
    return tag ? keyBySeq.get(tag.seq) ?? null : null;
  }
  return null;
}

type TagBlock = { type: string; content?: string; parentToolUseId?: string };

const isWords = (b: TagBlock) => b.type === 'text' && !b.parentToolUseId && !!(b.content ?? '').trim();
const tagKeyOf = (b: TagBlock, keyBySeq: ReadonlyMap<number, string>): string | null => {
  const tag = parseQuestionTag(b.content);
  return tag ? keyBySeq.get(tag.seq) ?? null : null;
};

/** The question a block of the run belongs to by its tag: a text block with words
 *  is its own tag's (none: the turn's own), a block after words goes with the
 *  turn (a tag files the block it opens, never the work and words after it:
 *  2026-11-03, the running turn's reply after a question's tagged answer was
 *  filed under that question), and a block before any words goes with the run's
 *  first words (`tagKeyOfBlocks`: the steps of a tagged answer). */
export function tagKeyAtBlock(
  blocks: ReadonlyArray<TagBlock>,
  from: number,
  to: number,
  index: number,
  keyBySeq: ReadonlyMap<number, string>,
): string | null {
  const at = Math.min(index, to - 1, blocks.length - 1);
  if (at < from) return null;
  if (isWords(blocks[at])) return tagKeyOf(blocks[at], keyBySeq);
  for (let i = at - 1; i >= from; i--) if (isWords(blocks[i])) return null;
  return tagKeyOfBlocks(blocks, from, to, keyBySeq);
}

/** `tagKeyAtBlock` for every block in one pass. `ends` are the finished runs'
 *  end indices, ascending; the blocks after the last one are the live run. A
 *  render asks for every block's page, and a scan back per block was quadratic
 *  in a long turn. */
export function blockTagKeys(
  blocks: ReadonlyArray<TagBlock>,
  ends: readonly number[],
  keyBySeq: ReadonlyMap<number, string>,
): Array<string | null> {
  const out: Array<string | null> = new Array(blocks.length).fill(null);
  let from = 0;
  for (const end of [...ends, blocks.length]) {
    const to = Math.min(Math.max(end, from), blocks.length);
    if (to <= from) continue;
    const first = tagKeyOfBlocks(blocks, from, to, keyBySeq);
    let spoke = false;
    for (let i = from; i < to; i++) {
      const b = blocks[i];
      if (isWords(b)) { spoke = true; out[i] = tagKeyOf(b, keyBySeq); continue; }
      out[i] = spoke ? null : first;
    }
    from = to;
  }
  return out;
}

/** Every question the run's tagged text blocks name, in order, each once. */
export function tagKeysOfBlocks(
  blocks: ReadonlyArray<TagBlock>,
  from: number,
  to: number,
  keyBySeq: ReadonlyMap<number, string>,
): string[] {
  const out: string[] = [];
  for (let i = from; i < to && i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== 'text' || b.parentToolUseId) continue;
    const tag = parseQuestionTag(b.content);
    const key = tag ? keyBySeq.get(tag.seq) : undefined;
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}
