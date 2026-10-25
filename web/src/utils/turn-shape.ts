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
 *  · open: anything else (it ended in a tool call, an error, nothing): rows
 *    render as they always did, so a failure is never folded away unread.
 * A person's own message always shows. Turns split at every row sent into the
 * session; a delivery that came in while the session was still working (the rows
 * before it end in a tool call, not an answer) belongs to the turn it interrupted.
 * The live turn is the caller's to leave `open`. Pure: tests/web/turn-shape.test.ts.
 */
import { readTurnMarker, type MarkerTurnMessage } from './turn-end-marker';

export type TurnKind = 'hidden' | 'answered' | 'open';

export interface TurnShape {
  /** Index of the row that opened the turn; -1 when the window starts inside it. */
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
}

export function shapeTurns(messages: readonly MarkerTurnMessage[], opts: TurnShapeOptions): TurnShape[] {
  const stripTag = opts.stripTag ?? ((t: string) => t);
  const bounds: number[] = [];
  messages.forEach((m, i) => { if (m.role === 'user' && opts.isSent(m, i)) bounds.push(i); });
  const segs: { from: number; to: number }[] = [];
  if (messages.length > 0 && (bounds.length === 0 || bounds[0] > 0)) segs.push({ from: -1, to: bounds[0] ?? messages.length });
  bounds.forEach((b, k) => segs.push({ from: b, to: k + 1 < bounds.length ? bounds[k + 1] : messages.length }));

  const lastRowOf = (from: number, to: number): number => {
    for (let i = to - 1; i > from; i--) {
      const m = messages[i];
      if (m.role === 'system' && m.systemVariant !== 'error') continue;
      return i;
    }
    return -1;
  };
  const endsInAnswer = (from: number, to: number): boolean => {
    const i = lastRowOf(from, to);
    return i >= 0 && messages[i].role === 'assistant' && (messages[i].tools?.length ?? 0) === 0;
  };

  // Chains of segments: a delivery mid-work joins the turn it interrupted.
  const chains: { from: number; to: number }[] = [];
  segs.forEach((seg, k) => {
    const prev = chains[chains.length - 1];
    const person = seg.from >= 0 && opts.isPerson(messages[seg.from], seg.from);
    if (prev && !person && !endsInAnswer(segs[k - 1].from, segs[k - 1].to)) prev.to = seg.to;
    else chains.push({ ...seg });
  });

  return chains.map((c, k) => {
    const byPerson = c.from >= 0 && opts.isPerson(messages[c.from], c.from);
    const base = { start: c.from, end: c.to, byPerson, kind: 'open' as TurnKind, answer: -1 };
    if (k === chains.length - 1 && opts.streaming) return base;
    const last = lastRowOf(c.from, c.to);
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
