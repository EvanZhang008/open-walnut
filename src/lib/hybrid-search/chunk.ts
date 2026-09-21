/**
 * Passage extraction for embedding.
 *
 * Three invariants, all machine-checked by tests:
 *
 *  - COVER  — every non-whitespace character of title+summary+note appears in
 *    at least one passage from `coverFrom` onward. When the per-doc cap forces
 *    text out, the dropped amount comes back as `droppedChars`; it is never
 *    silently discarded. This exists because the previous single-passage branch
 *    embedded `head + note.slice(0, 1400)` and threw the rest away: a 22KB task
 *    note reached the vector at 3.4%, and the terms that mattered were in the
 *    96.6%.
 *
 *  - RECALL — `passages[0]` always carries body text when a body exists. The
 *    semantic RECALL lane scans ONLY seq 0 (embed-worker.ts, level-0 matrix),
 *    while rescore takes the max cosine over every seq. So seq 0 decides which
 *    documents can be DISCOVERED, and the old chunked layout (seq 0 = title +
 *    summary, body starting at seq 1) would have made recall strictly worse for
 *    every newly chunked kind. seq 0 is therefore a DIGEST that deliberately
 *    overlaps the cover — overlap is free under a max-cosine rescore.
 *
 *  - BUDGET — every emitted passage fits the embedder's char cap AND the
 *    tokenizer's 512-token cap, for any script. Sizing by characters alone was
 *    wrong for CJK: at roughly one token per character a 1400-char Chinese
 *    chunk was truncated to ~512 characters of content, and because the model
 *    pools on the last token the resulting vector silently described only the
 *    prefix.
 */

import { isCjkCodePoint } from './tokenizer.js';

/** Token budget per passage. Under the tokenizer's 512 cap with room for the
 *  special tokens and for estimator error. */
export const PASSAGE_TOKEN_BUDGET = 480;
/** Hard character ceiling per passage. 1400 keeps the Latin chunk boundaries
 *  this index already had, so session chunking barely moves. */
export const PASSAGE_MAX_CHARS = 1400;
/** CJK/Kana/Hangul: about one token per character. */
export const CHARS_PER_TOKEN_CJK = 1;
/** Everything else: prose is ~4 chars/token and dense code ~2.5, so 3 is the
 *  safe middle. Deliberately an OVER-estimate — breaching the tokenizer cap
 *  loses text invisibly, while over-estimating only makes a passage smaller. */
export const CHARS_PER_TOKEN_OTHER = 3;
/** Share of seq 0's budget the note lead owns and the head can never eat. */
export const SEQ0_LEAD_SHARE = 0.35;
/** Cost budget, not a correctness property: see `droppedChars`. */
export const MAX_CHUNKS_PER_DOC = 40;
/** Back-compat alias — `MAX_CHUNKS_PER_DOC` counts passages including seq 0. */
export const DEFAULT_MAX_PASSAGES = MAX_CHUNKS_PER_DOC;

/**
 * Bump on ANY change to passage layout. `db.ts` gates on it and drops `doc_vec`
 * when it moves, because after a layout change every stored vector describes
 * text this policy would no longer produce. Without the gate the change is a
 * no-op on existing indexes: the backfill only looks for docs with ZERO
 * vectors, so a doc holding one stale vector is invisible to it forever.
 *
 * v1 = head + note.slice(0, 1400) for unchunked kinds, head-only seq 0 for
 *      chunked kinds.
 * v2 = digest seq 0 + full cover, token-budgeted, every kind.
 */
export const PASSAGE_POLICY_VERSION = 2;

/**
 * Which side survives `maxPassages`.
 *  - `tail`   chronological bodies (session transcripts): the newest turns are
 *             what a query is about, and the serializer already feeds a tail
 *             window.
 *  - `spread` structured bodies (task notes, markdown): the goal sits at the
 *             top and the log at the bottom, so BOTH ends matter. Keeps the
 *             first and last chunk unconditionally and strides the middle.
 */
export type OverflowPolicy = 'tail' | 'spread';

export interface PassagePolicy {
  /** Total passages including seq 0. */
  maxPassages: number;
  overflow: OverflowPolicy;
}

export const DEFAULT_PASSAGE_POLICY: PassagePolicy = {
  maxPassages: MAX_CHUNKS_PER_DOC,
  overflow: 'spread',
};

export interface PassageSource {
  title: string;
  summary?: string;
  note?: string;
}

export interface PassageSet {
  passages: string[];
  /** First passage that participates in the COVER. 1 when `passages[0]` is a
   *  digest; 0 when the whole document fit one passage, so no near-duplicate
   *  vector is stored for the ~4.7k short docs that dominate a real index. */
  coverFrom: 0 | 1;
  /** Non-whitespace characters the per-doc cap dropped. 0 for every document
   *  inside budget — this is the COVER invariant, as a number a test can read. */
  droppedChars: number;
}

/**
 * Conservative token count for the tokenizer's 512 cap. Never an exact
 * tokenizer call: this runs per paragraph during indexing, and the only
 * requirement is that it does not UNDER-estimate.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0)!)) cjk++;
    else other++;
  }
  return cjk * CHARS_PER_TOKEN_CJK + Math.ceil(other / CHARS_PER_TOKEN_OTHER);
}

function nonWhitespaceCount(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n++;
  return n;
}

/**
 * End index (exclusive) of the longest prefix of `text` starting at `start`
 * that fits both budgets. Walks code points so an astral CJK character is
 * never split in half.
 */
function budgetedEnd(
  text: string,
  start: number,
  tokenBudget: number,
  charBudget: number,
): number {
  let tokens = 0;
  let others = 0;
  let i = start;
  while (i < text.length) {
    const code = text.codePointAt(i)!;
    const width = code > 0xffff ? 2 : 1;
    if (i + width - start > charBudget) break;
    let nextTokens: number;
    if (isCjkCodePoint(code)) {
      tokens += CHARS_PER_TOKEN_CJK;
      nextTokens = tokens + Math.ceil(others / CHARS_PER_TOKEN_OTHER);
    } else {
      others++;
      nextTokens = tokens + Math.ceil(others / CHARS_PER_TOKEN_OTHER);
    }
    if (nextTokens > tokenBudget) break;
    i += width;
  }
  return i;
}

/** Last word boundary in the final `tailShare` of [start, end), or -1. */
function wordBoundaryBefore(text: string, start: number, end: number): number {
  const window = Math.floor((end - start) * 0.15);
  for (let i = end - 1; i >= end - window && i > start; i--) {
    if (/\s/.test(text[i]!)) return i;
  }
  return -1;
}

/**
 * Clip to a budget, preferring a word boundary in the last 15% so a digest does
 * not end mid-word. Used ONLY for the digest and for queries — never for a
 * cover chunk, because clipping a cover chunk would lose text.
 */
export function clipToTokenBudget(
  text: string,
  tokenBudget: number,
  charBudget: number = PASSAGE_MAX_CHARS,
): string {
  if (tokenBudget <= 0 || charBudget <= 0) return '';
  const end = budgetedEnd(text, 0, tokenBudget, charBudget);
  if (end >= text.length) return text;
  const boundary = wordBoundaryBefore(text, 0, end);
  return text.slice(0, boundary > 0 ? boundary : end).trimEnd();
}

/**
 * Split `text` into budget-sized chunks, paragraph-first. NEVER clips: the
 * concatenation of the result contains every non-whitespace character of the
 * input, which is what makes COVER provable.
 */
export function splitToBudget(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current) chunks.push(current);
    current = '';
  };
  for (const para of text.split(/\n{2,}/)) {
    if (!para.trim()) continue;
    const paraTokens = estimateTokens(para);
    // A paragraph past the budget splits hard — transcripts and tool output
    // contain unbroken walls with no paragraph boundary to use.
    if (paraTokens > PASSAGE_TOKEN_BUDGET || para.length > PASSAGE_MAX_CHARS) {
      flush();
      let at = 0;
      while (at < para.length) {
        const end = budgetedEnd(para, at, PASSAGE_TOKEN_BUDGET, PASSAGE_MAX_CHARS);
        // Guard against a zero-width step on a pathological budget.
        const stop = end > at ? end : Math.min(para.length, at + 1);
        chunks.push(para.slice(at, stop));
        at = stop;
      }
      continue;
    }
    const joined = current ? `${current}\n\n${para}` : para;
    if (
      current
      && (estimateTokens(joined) > PASSAGE_TOKEN_BUDGET || joined.length > PASSAGE_MAX_CHARS)
    ) {
      flush();
      current = para;
    } else {
      current = joined;
    }
  }
  flush();
  return chunks;
}

/**
 * Indices to keep, including the first and the last, striding the middle.
 * Returns INDICES rather than slices so the caller can count what was dropped
 * without comparing chunk text — two chunks can legitimately be identical
 * (repeated log lines), and a text-based set would report the duplicate as kept.
 */
function spreadIndices(n: number, room: number): number[] {
  if (room <= 0) return [];
  if (room === 1) return [0];
  const picked: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < room; i++) {
    const idx = Math.round((i * (n - 1)) / (room - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    picked.push(idx);
  }
  return picked;
}

export function passagesForDoc(
  doc: PassageSource,
  policy?: Partial<PassagePolicy>,
): PassageSet {
  const { maxPassages, overflow } = { ...DEFAULT_PASSAGE_POLICY, ...policy };
  const title = doc.title?.trim() ? doc.title : '';
  const summary = doc.summary?.trim() ? doc.summary : '';
  const note = doc.note?.trim() ? doc.note : '';
  const docText = [title, summary, note].filter((s) => s).join('\n\n');
  if (!docText.trim()) return { passages: [], coverFrom: 0, droppedChars: 0 };

  // Collapse: the whole document fits one passage, so the digest IS the cover.
  // Without this every short doc would store two near-identical vectors.
  if (
    estimateTokens(docText) <= PASSAGE_TOKEN_BUDGET
    && docText.length <= PASSAGE_MAX_CHARS
  ) {
    return { passages: [docText], coverFrom: 0, droppedChars: 0 };
  }

  // seq 0 — the digest. The head is clipped so it can never eat the note's
  // share: a task title+summary reaches 14,390 chars in real data, which would
  // leave zero room for the body and reproduce the original bug one field over.
  const headText = [title, summary].filter((s) => s).join('\n');
  const leadReserve = note ? Math.ceil(PASSAGE_TOKEN_BUDGET * SEQ0_LEAD_SHARE) : 0;
  const headCharCap = note
    ? Math.floor(PASSAGE_MAX_CHARS * (1 - SEQ0_LEAD_SHARE))
    : PASSAGE_MAX_CHARS;
  const head = clipToTokenBudget(
    headText,
    PASSAGE_TOKEN_BUDGET - leadReserve,
    headCharCap,
  );
  // The "- 1" reserves a token for the '\n' joiner. estimateTokens ceils the
  // non-CJK count, so tokens(a) + tokens(b) can be ONE BELOW tokens(a + sep + b)
  // when a's remainder is exact — without this reservation the digest lands a
  // single token over budget, which a fuzz case caught at 481 of 480.
  const lead = note
    ? clipToTokenBudget(
      note,
      PASSAGE_TOKEN_BUDGET - estimateTokens(head) - 1,
      PASSAGE_MAX_CHARS - head.length - 1,
    )
    : '';
  const digest = [head, lead].filter((s) => s).join('\n');

  // seq 1..n — the cover. Split over the WHOLE doc text, including title and
  // summary, so a clipped head is still reachable.
  const chunks = splitToBudget(docText);
  const room = Math.max(1, maxPassages - 1);
  let keptIdx: number[];
  if (chunks.length <= room) {
    keptIdx = chunks.map((_, i) => i);
  } else if (overflow === 'tail') {
    keptIdx = Array.from({ length: room }, (_, i) => chunks.length - room + i);
  } else {
    keptIdx = spreadIndices(chunks.length, room);
  }

  const keptSet = new Set(keptIdx);
  let droppedChars = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (!keptSet.has(i)) droppedChars += nonWhitespaceCount(chunks[i]!);
  }

  return {
    passages: [digest, ...keptIdx.map((i) => chunks[i]!)],
    coverFrom: 1,
    droppedChars,
  };
}
