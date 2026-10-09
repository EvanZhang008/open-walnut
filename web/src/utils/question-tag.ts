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
import { ROOT_THREAD_KEY, threadIdOf, type ThreadTree, type ThreadTreeMessage } from '@/utils/thread-tree';
import type { ThreadMetaIndex } from '@/utils/thread-meta';

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

/** The reply as shown: the tag line gone, everything else verbatim. */
export function stripQuestionTag(text: string): string {
  return parseQuestionTag(text)?.rest ?? text;
}

/** The banner name of question n (`[Question Q4]…[/Question Q4]`). */
export const QUESTION_BANNER_RE = /^Question Q(\d{1,5})$/;

export function questionBannerName(seq: number): string {
  return `Question Q${seq}`;
}

/**
 * The machine block a question's send opens with. It uses the repo's
 * `[Name]…[/Name]` banner shape, so every reader that already folds or strips
 * Walnut's banners (the bubble, previews, the titler) handles it the same way;
 * the bubble hides this one outright, since the turn label shows the number.
 */
export function questionBanner(seq: number): string {
  const name = questionBannerName(seq);
  return `[${name}]\nThis message is question ${seq} of this conversation. Begin your reply with the line "[Q${seq}]" (nothing else on that line) so the reply is filed under question ${seq}.\n[/${name}]`;
}

/** The text sent for a question or a follow-up: the banner, then the message. */
export function withQuestionBanner(text: string, seq: number): string {
  return `${questionBanner(seq)}\n\n${text}`;
}

const BANNER_IN_TEXT = /^\[Question Q(\d{1,5})\]\n[\s\S]*?^\[\/Question Q\1\]/m;

/** The number a sent message's banner gave it, or null (no banner). */
export function bannerSeqOf(text: string | undefined): number | null {
  const m = text ? BANNER_IN_TEXT.exec(text) : null;
  return m ? Number(m[1]) : null;
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

/** Question key per number (the inverse of questionNumbers). */
export function keysBySeq(numbers: ReadonlyMap<string, number>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [key, n] of numbers) out.set(n, key);
  return out;
}

/**
 * The anchors plus one synthetic anchor per turn whose FIRST answer text carries
 * a tag for a question the user row is not (or not yet) anchored to. The
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
  const extra: SessionThreadAnchor[] = [];
  let headId: string | undefined;
  let headText: string | undefined;
  let headIndex = -1;
  let decided = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      headId = threadIdOf(m);
      headText = m.text;
      headIndex = i;
      decided = false;
      continue;
    }
    if (decided || !headId || m.role !== 'assistant' || !(m.text ?? '').trim()) continue;
    decided = true;
    const tag = parseQuestionTag(m.text);
    if (!tag) continue;
    const targetHead = headBySeq.get(tag.seq);
    if (!targetHead || targetHead === headId) continue;
    const target = anchorFor.get(targetHead);
    // The tagged question must exist (its own anchor) and precede this turn.
    if (!target) continue;
    const own = anchorFor.get(headId);
    if (own && own.parent === target.parent && (own.quote?.exact ?? '') === (target.quote?.exact ?? '')) continue;
    // A tag that only repeats the row's own banner says nothing the anchor does
    // not: the banner is what WE numbered the send, so when they disagree the
    // number was wrong and the anchor (what the user replied in) is right.
    if (own && bannerSeqOf(headText) === tag.seq) continue;
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
  for (const m of list ?? []) if (typeof m.seq === 'number' && m.seq > 0 && m.headId) out.set(m.seq, m.headId);
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

/** The question a block of the run belongs to: the newest tagged main-lane text
 *  block at or before it (a turn that moves on to `[Q3]` hands everything after
 *  that line to Q3), else the run's first-text rule (`tagKeyOfBlocks`). */
export function tagKeyAtBlock(
  blocks: ReadonlyArray<TagBlock>,
  from: number,
  to: number,
  index: number,
  keyBySeq: ReadonlyMap<number, string>,
): string | null {
  for (let i = Math.min(index, to - 1, blocks.length - 1); i >= from; i--) {
    const b = blocks[i];
    if (b.type !== 'text' || b.parentToolUseId) continue;
    const tag = parseQuestionTag(b.content);
    const key = tag ? keyBySeq.get(tag.seq) : undefined;
    if (key) return key;
  }
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
    let cur: string | null = null;
    for (let i = from; i < to; i++) {
      const b = blocks[i];
      if (b.type === 'text' && !b.parentToolUseId) {
        const tag = parseQuestionTag(b.content);
        const key = tag ? keyBySeq.get(tag.seq) : undefined;
        if (key) cur = key;
      }
      out[i] = cur ?? first;
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
