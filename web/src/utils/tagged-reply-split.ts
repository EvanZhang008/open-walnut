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
 * Without any tag it was worse: the turn went on with its own work after taking
 * the question, and its whole reply read as the question's answer (2026-11-03,
 * the user: "this is not answer question of this thread").
 *
 * This lays the rows out the way the turns were meant: the turn's own rows
 * first, then each question with the part of the reply under its tag, and
 * nothing when the model never wrote its tag (the question reads No answer). A
 * tag files the part it opens, up to the next tag or the end of its row (one
 * reply message); the rows after it are the turn's again. Only a CLI turn with a
 * question taken mid-turn is touched; everything else is returned as it is
 * (same array). Every positional reader (the thread tree, the stats, the card,
 * the review sidebar) reads these rows, so they all agree
 * (tests/web/question-answer-readers-guard.test.ts).
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
export function isMidTurn(m: { role: string; sourceUuid?: string; msgId?: string }): boolean {
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
  /** The question number of the line that started the turn now running (null: none). */
  let turnSeq: number | null = null;
  let sawTurn = false;
  let i = 0;
  // A mid-turn line of the turn's own question (a follow-up typed in it) goes on
  // with that turn: what follows is the same question's either way.
  const asked = (m: M) => { const seq = midTurnSeq(m); return seq !== null && seq !== turnSeq ? seq : null; };
  while (i < rows.length) {
    const first = rows[i];
    if (!sawTurn || asked(first) === null) {
      if (first.role === 'user') {
        sawTurn = true;
        if (!isMidTurn(first)) turnSeq = questionSeqOfRow(first);
        else if (midTurnSeq(first) === null) turnSeq = null;
      }
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
    while (end < rows.length && !(rows[end].role === 'user' && asked(rows[end]) === null)) end++;
    const stretch = rows.slice(i, end);
    // Every row the stretch's questions were asked in, per number, in order.
    const questions = new Map<number, M[]>();
    for (const r of stretch) {
      const seq = asked(r);
      if (seq !== null) questions.set(seq, [...(questions.get(seq) ?? []), r]);
    }
    const seqs = new Set(questions.keys());
    const placed = new Set<M>([...questions.values()].flat());
    const own: M[] = [];
    const answers = new Map<number, M[]>();
    const put = (seq: number | null, row: M) => {
      if (seq === null) { own.push(row); return; }
      const list = answers.get(seq) ?? [];
      list.push(row);
      answers.set(seq, list);
    };
    // A tag line hands what follows it IN ITS ROW (one reply message) to that
    // question, up to the next tag; the rows after it, and what comes before the
    // first tag, are the turn's own (the live view's rule, question-tag.ts
    // blockTagKeys). The question's own row marks when it was taken: the turn's
    // work and answer after it ("ROOT-DONE" above) are still the turn's.
    for (const r of stretch) {
      if (placed.has(r)) continue;
      const parts = r.role === 'assistant' && r.text ? cutAtTags(r.text, seqs) : null;
      if (!parts || (parts.length === 1 && parts[0].seq === null)) { put(null, r); continue; }
      const sig = [...seqs].join(',');
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
      parts.forEach((p, n) => put(p.seq, segs[n]));
    }
    changed = true;
    out.push(...own);
    for (const [seq, asks] of questions) out.push(...asks, ...(answers.get(seq) ?? []));
    i = end;
  }
  return changed && out.some((r, k) => r !== rows[k]) ? out : rows;
}
