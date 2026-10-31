/**
 * Questions answered inside the running turn's reply.
 *
 * A question sent while a turn runs reaches the model mid-turn (the CLI hands it
 * over as a `queued_command` attachment, and the transcript keeps it only as a
 * `queue-…` row at the place it was sent). The model then answers it inside the
 * reply it was already writing, each answer under its `[Qn]` line:
 *
 *   ROOT-DONE            <- the turn's own answer
 *   [Q1]
 *   answer to question 1
 *   [Q2]
 *   answer to question 2
 *
 * Every reader of the rows takes "a user row and everything up to the next one"
 * as one turn, so the whole reply (and the turn's own tool calls after the
 * question) was filed under the LAST question sent: question 1 read New with no
 * answer, the main conversation lost its own reply (2026-10-29 real-CLI run).
 *
 * This splits such a reply at those lines and lays the rows out the way the
 * turns were meant: the turn's own rows first, then each question with the part
 * of the reply under its tag. Only a CLI turn with a mid-turn question AND a tag
 * for it is touched; everything else is returned as it is (same array).
 *
 * Pure: unit tested in tests/web/tagged-reply-split.test.ts.
 */
import { questionSeqOfRow } from '@/utils/question-tag';

export interface SplitRow {
  role: 'user' | 'assistant' | 'system';
  text?: string;
  msgId?: string;
  sourceUuid?: string;
  hints?: ReadonlyArray<{ kind: string; arg?: string }>;
  tools?: unknown;
  thinking?: string;
  usage?: unknown;
}

/** `[Q4]` opening a line (bold markers allowed), anywhere in the reply. */
const TAG_LINE = /^[ \t]*(?:\*\*|__)?\[Q\s?(\d{1,5})\]/gm;

/** A user line the CLI took while a turn ran: kept only as a `queue-…` row. */
function isMidTurn(m: SplitRow): boolean {
  return m.role === 'user' && (!!m.sourceUuid || !!m.msgId?.startsWith('queue-'));
}

function midTurnSeq(m: SplitRow): number | null {
  return isMidTurn(m) ? questionSeqOfRow(m) : null;
}

/** The reply cut at each tag line naming one of `seqs`; `seq` null = before the first. */
export function cutAtTags(text: string, seqs: ReadonlySet<number>): Array<{ seq: number | null; text: string }> {
  const fences = fenceSpans(text);
  const cuts: Array<{ at: number; seq: number }> = [];
  for (const m of text.matchAll(TAG_LINE)) {
    const seq = Number(m[1]);
    if (m.index === undefined || !seqs.has(seq)) continue;
    // A tag quoted inside a code block is text, not a filing mark.
    if (fences.some(([a, b]) => m.index! > a && m.index! < b)) continue;
    cuts.push({ at: m.index, seq });
  }
  if (cuts.length === 0) return [{ seq: null, text }];
  const out: Array<{ seq: number | null; text: string }> = [];
  const head = text.slice(0, cuts[0].at).trimEnd();
  if (head.trim()) out.push({ seq: null, text: head });
  cuts.forEach((c, n) => {
    const part = text.slice(c.at, n + 1 < cuts.length ? cuts[n + 1].at : text.length).trim();
    if (part) out.push({ seq: c.seq, text: part });
  });
  return out;
}

/** [start, end) of each fenced code block (``` or ~~~ opening a line); an unclosed one runs to the end. */
function fenceSpans(text: string): Array<[number, number]> {
  if (!text.includes('```') && !text.includes('~~~')) return [];
  const spans: Array<[number, number]> = [];
  let open: { at: number; mark: string } | null = null;
  for (const m of text.matchAll(/^[ \t]{0,3}(`{3,}|~{3,})/gm)) {
    if (m.index === undefined) continue;
    if (!open) open = { at: m.index, mark: m[1][0] };
    else if (m[1][0] === open.mark) { spans.push([open.at, m.index]); open = null; }
  }
  if (open) spans.push([open.at, text.length]);
  return spans;
}

/** Split parts per source row, so a re-render with unchanged rows hands the same
 *  objects back and the memoized message rows do not re-render. */
const partsCache = new WeakMap<object, { sig: string; segs: unknown[] }>();

export function splitTaggedReplies<M extends SplitRow>(rows: M[]): M[] {
  if (!rows.some((m) => midTurnSeq(m) !== null)) return rows;
  const out: M[] = [];
  let changed = false;
  let sawTurn = false;
  let i = 0;
  while (i < rows.length) {
    const first = rows[i];
    if (!sawTurn || midTurnSeq(first) === null) {
      if (first.role === 'user') sawTurn = true;
      out.push(first);
      i++;
      continue;
    }
    // The rest of this CLI turn: up to the next line the CLI ran as a turn of its
    // own, or a line taken mid-turn that asked no question (typed in the main
    // conversation): what the model writes after that answers it, whatever tag it
    // repeats (2026-10-31: a main line's answer opened with `[Q6]` and was filed
    // under question 6).
    let end = i + 1;
    while (end < rows.length && !(rows[end].role === 'user' && midTurnSeq(rows[end]) === null)) end++;
    const stretch = rows.slice(i, end);
    const questions = new Map<number, M>();
    for (const r of stretch) {
      const seq = midTurnSeq(r);
      if (seq !== null && !questions.has(seq)) questions.set(seq, r);
    }
    const seqs = new Set(questions.keys());
    const placed = new Set<M>(questions.values());
    const own: M[] = [];
    const answers = new Map<number, M[]>();
    const put = (seq: number | null, row: M) => {
      if (seq === null) { own.push(row); return; }
      const list = answers.get(seq) ?? [];
      list.push(row);
      answers.set(seq, list);
    };
    // The live view's rule (question-tag.ts blockTagKeys): a tag line hands what
    // follows it, in this row and the rows after, to that question until the next
    // tag. What comes before the first tag is the turn's own: the live view, which
    // cannot see when a question was sent, gives it to the first tagged question,
    // but here the question's own row marks that moment, and the turn's work and
    // answer after it ("ROOT-DONE" above) are still the turn's.
    let cur: number | null = null;
    let split = false;
    for (const r of stretch) {
      if (placed.has(r)) continue;
      const parts = r.role === 'assistant' && r.text ? cutAtTags(r.text, seqs) : null;
      if (!parts || (parts.length === 1 && parts[0].seq === null)) { put(cur, r); continue; }
      split = true;
      const sig = `${[...seqs].join(',')}|${cur ?? ''}`;
      const hit = partsCache.get(r);
      const segs = hit && hit.sig === sig ? hit.segs as M[] : parts.map((p, n) => {
        // The first part keeps the row's id (live blocks and anchors name it); its
        // thinking stays with it, its tool calls go with the last part they follow.
        const seg: M = { ...r, text: p.text, ...(n === 0 ? {} : { msgId: `${r.msgId ?? 'row'}~${n}` }) };
        if (n > 0) { delete seg.thinking; delete seg.usage; }
        if (n < parts.length - 1) delete seg.tools;
        return seg;
      });
      if (segs !== hit?.segs) partsCache.set(r, { sig, segs });
      parts.forEach((p, n) => {
        const seq = p.seq ?? cur;
        if (p.seq !== null) cur = p.seq;
        put(seq, segs[n]);
      });
    }
    if (!split) {
      out.push(...stretch);
    } else {
      changed = true;
      out.push(...own);
      for (const [seq, q] of questions) out.push(q, ...(answers.get(seq) ?? []));
    }
    i = end;
  }
  return changed ? out : rows;
}
