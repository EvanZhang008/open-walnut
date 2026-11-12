/**
 * What of each finished turn the reader sees.
 *
 * The person reads a session for its answers. A coordinating session takes in
 * notices, peer messages and replies all day, and works through each with tool
 * calls and sends; shown row by row, that crowds out the few answers that are
 * for the person (2026-10-25, the user: "the user only gets the information they
 * need most"). So every finished turn takes one of three shapes:
 *  · hidden: a turn something else started (a notice, a peer, a trigger) that
 *    ended cleanly with the no-action line (turn-end-marker.ts): none of it shows,
 *    the timeline keeps a small "N turns hidden" toggle in its place;
 *  · answered: a turn that ended in an answer: everything before the answer
 *    (the message that started it unless a person wrote it, notices, tools,
 *    sends, narration) is one folded row, and the answer shows;
 *  · open: anything else (it ended in a tool call, an error, nothing): its words
 *    show, and its steps fold with the steps around them by the one rule of
 *    components/sessions/fold-rows.ts (a failure counts in the fold's header).
 * A person's own message always shows. Turns split at every row sent into the
 * session; a delivery that came in while the session was still working (the rows
 * before it end in a tool call, not an answer) belongs to the turn it interrupted.
 * The live turn is the caller's to leave `open`. Pure: tests/web/turn-shape.test.ts.
 *
 * A session with questions shapes each question's turns on its own rows
 * (`pageOf`): one reply that answered two questions is cut into a part per
 * question (tagged-reply-split.ts), and a question sent while another turn ran
 * sits in the middle of that turn. Shaped over the whole transcript, the turn's
 * answer was the LAST part, so the part answering this question read as
 * narration before it and folded as "An update" (2026-11-04, the user: "why
 * this is update lol this is just an response"). Each question's turns are the
 * turns as its own page shows them, so a person's message is answered by the
 * last words filed under its own question.
 */
import { readTurnMarker, type MarkerTurnMessage } from './turn-end-marker';

export type TurnKind = 'hidden' | 'answered' | 'open';

export interface TurnShape {
  /** Index of the row that opened the turn; -1 when the window starts inside it, or when a
   *  row sent under another question opened it (pageOf). */
  start: number;
  /** First index after the turn. */
  end: number;
  /** A person wrote the opening row: it always shows. */
  byPerson: boolean;
  kind: TurnKind;
  /** The answer row, for `answered`; -1 otherwise. */
  answer: number;
}

export interface TurnShapeOptions {
  /** A row sent into the session (a person's, a peer's, a Walnut notice). */
  isSent: (m: MarkerTurnMessage, i: number) => boolean;
  /** A row a person wrote. */
  isPerson: (m: MarkerTurnMessage, i: number) => boolean;
  /** The marked answer passed the clean-turn rule (noActionRows). */
  isCleanNoAction: (i: number) => boolean;
  /** Removes the reply's question tag first (question-tag.ts). */
  stripTag?: (text: string) => string;
  /** The last turn is still running: it stays `open`. */
  streaming: boolean;
  /** The question a row is filed under (`''` = the main conversation). Each
   *  question's turns are shaped on its own rows; absent, every row is one page. */
  pageOf?: (i: number) => string;
}

/** A turn and the rows it holds (global indices, in order), when its question's
 *  rows interleave with another's; absent, it is the range start..end. */
export interface PagedTurnShape extends TurnShape {
  rows?: readonly number[];
}

export function shapeTurns(messages: readonly MarkerTurnMessage[], opts: TurnShapeOptions): PagedTurnShape[] {
  const pageOf = opts.pageOf;
  const whole = () => shapeRun(messages, opts).map(({ lead: _lead, ...t }) => t);
  if (!pageOf) return whole();
  const byPage = new Map<string, number[]>();
  messages.forEach((_, i) => {
    const key = pageOf(i);
    const list = byPage.get(key);
    if (list) list.push(i); else byPage.set(key, [i]);
  });
  if (byPage.size <= 1) return whole();
  // The newest turn is the one holding the newest row: only it may stay open while live.
  const lastPage = pageOf(messages.length - 1);
  const out: PagedTurnShape[] = [];
  // A row sent into the session, whichever page it is filed under: it starts a turn.
  const sentAt = messages.map((m, i) => m.role === 'user' && opts.isSent(m, i));
  for (const [page, idx] of byPage) {
    const sub = idx.map((i) => messages[i]);
    const at = (j: number) => idx[j];
    // A row sent under another question between two of this page's rows started the
    // turn the later one belongs to: the main conversation's words after it answer it,
    // never narration of the turn before (2026-11-12: an untagged reply to a question
    // folded as "An update" with the next one's).
    const cutBefore = (j: number) => {
      for (let g = at(j - 1) + 1; g < at(j); g++) if (sentAt[g]) return true;
      return false;
    };
    const shapes = shapeRun(sub, {
      ...opts,
      isSent: (m, j) => opts.isSent(m, at(j)),
      isPerson: (m, j) => opts.isPerson(m, at(j)),
      isCleanNoAction: (j) => opts.isCleanNoAction(at(j)),
      streaming: opts.streaming && page === lastPage,
    }, cutBefore);
    for (const t of shapes) {
      const first = t.lead;
      const rows = idx.slice(first, t.end);
      out.push({
        start: t.start >= 0 ? at(t.start) : -1,
        end: rows.length > 0 ? rows[rows.length - 1] + 1 : (t.start >= 0 ? at(t.start) + 1 : 0),
        byPerson: t.byPerson,
        kind: t.kind,
        answer: t.answer >= 0 ? at(t.answer) : -1,
        rows,
      });
    }
  }
  // Transcript order by each turn's first row: callers read the last one as the newest.
  const firstRow = (t: PagedTurnShape) => (t.rows && t.rows.length > 0 ? t.rows[0] : Math.max(t.start, 0));
  return out.sort((a, b) => firstRow(a) - firstRow(b));
}

/** A turn and the index of its first row (its sent row, else the first it holds). */
type RunShape = TurnShape & { lead: number };

function shapeRun(messages: readonly MarkerTurnMessage[], opts: TurnShapeOptions, cutBefore?: (i: number) => boolean): RunShape[] {
  const stripTag = opts.stripTag ?? ((t: string) => t);
  // Where a turn starts: a row sent into the session (`sent`), or a row a send filed
  // elsewhere came right before (`cut`: the turn has no opening row of its own here).
  const bounds: { at: number; sent: boolean }[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && opts.isSent(m, i)) bounds.push({ at: i, sent: true });
    else if (i > 0 && cutBefore?.(i)) bounds.push({ at: i, sent: false });
  });
  // `from` is the opening row (-1: none); `lead` the turn's first row.
  const segs: { from: number; lead: number; to: number }[] = [];
  if (messages.length > 0 && (bounds.length === 0 || bounds[0].at > 0)) segs.push({ from: -1, lead: 0, to: bounds[0]?.at ?? messages.length });
  bounds.forEach((b, k) => segs.push({ from: b.sent ? b.at : -1, lead: b.at, to: k + 1 < bounds.length ? bounds[k + 1].at : messages.length }));
  const firstOf = (seg: { from: number; lead: number }) => (seg.from >= 0 ? seg.from + 1 : seg.lead);

  const lastRowOf = (lo: number, to: number): number => {
    for (let i = to - 1; i >= lo; i--) {
      const m = messages[i];
      if (m.role === 'system' && m.systemVariant !== 'error') continue;
      return i;
    }
    return -1;
  };
  const endsInAnswer = (seg: { from: number; lead: number; to: number }): boolean => {
    const i = lastRowOf(firstOf(seg), seg.to);
    return i >= 0 && messages[i].role === 'assistant' && (messages[i].tools?.length ?? 0) === 0;
  };

  // Chains of segments: a delivery mid-work joins the turn it interrupted.
  const chains: { from: number; lead: number; to: number }[] = [];
  segs.forEach((seg, k) => {
    const prev = chains[chains.length - 1];
    const person = seg.from >= 0 && opts.isPerson(messages[seg.from], seg.from);
    if (prev && !person && !endsInAnswer(segs[k - 1])) prev.to = seg.to;
    else chains.push({ ...seg });
  });

  return chains.map((c, k) => {
    const byPerson = c.from >= 0 && opts.isPerson(messages[c.from], c.from);
    const base = { start: c.from, end: c.to, byPerson, kind: 'open' as TurnKind, answer: -1, lead: c.from >= 0 ? c.from : c.lead };
    if (k === chains.length - 1 && opts.streaming) return base;
    const last = lastRowOf(firstOf(c), c.to);
    if (last < 0) return base;
    const final = messages[last];
    if (final.role !== 'assistant' || (final.tools?.length ?? 0) > 0) return base;
    const read = readTurnMarker(stripTag(final.text ?? ''));
    if (read.noAction && opts.isCleanNoAction(last)) {
      return byPerson ? { ...base, kind: 'answered' as TurnKind, answer: last } : { ...base, kind: 'hidden' as TurnKind };
    }
    if (!read.text.trim()) return base;
    return { ...base, kind: 'answered' as TurnKind, answer: last };
  });
}
