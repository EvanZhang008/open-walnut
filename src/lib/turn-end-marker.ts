/**
 * The agent acknowledgement line: how a session answers a message from another
 * agent (a peer, a notice, a reply, a trigger) that needs nothing the person
 * should hear about.
 *
 * A coordinating session takes in such messages all day. The session prompt asks
 * it to answer one that needs nothing with one fixed line ALONE,
 * `<walnut-turn status="agent-ack"/>`, and the timeline then hides that whole
 * turn (turn-shape.ts). It is never a label on an answer: a turn a person
 * started, or a line with words before it, shows as the answer it is, the line
 * stripped (2026-10-25, the user: an answer to their question was folded as
 * "No action needed"). Sessions spawned before the rename still write
 * `<walnut-turn status="no-action"/>` (a resume replays the old prompt), so both
 * read the same. Never a guess from wording: no line, no hiding.
 *
 * The line counts only as the last non-blank line of the text, outside any code
 * fence, exactly as written. A quote of it, a line in a code block, a line in the
 * middle, or one inside a tool result is not the marker. Which message and which
 * turn may fold (the main assistant's final message of a FINISHED turn with no
 * failure, question or plan in it) is the timeline's call; this file only reads
 * the text. Pure: tests/web/turn-end-marker.test.ts. Shared: the web client
 * imports it as @open-walnut/turn-end-marker, and the whole-session find
 * (src/core/sessions/session-find.ts) searches the text as the screen shows it.
 */

import { readAboutTag, stripAboutTag } from '../core/org/message-about.js';

export const NO_ACTION_TAG = '<walnut-turn status="agent-ack"/>';
/**
 * How a session ends a turn while its own work still runs (a background command, a subagent, an
 * approval or a reply it waits for): words, never the line above. 2026-11-18, the org reflection:
 * 40 of 108 overnight ack turns came after real work or words, as a "waiting on my build" mark,
 * and one task acked twice with an hour-limited fix still undone. Every op or notice that tells a
 * session to end its turn on such a wait uses this (tests/core/sessions/own-wait-turn-end.test.ts).
 */
export const OWN_WAIT_TURN_END = 'end your turn with one plain sentence on what you wait for, never the agent-ack line';
/** The line's first name, still written by sessions spawned on the old prompt. */
export const LEGACY_NO_ACTION_TAG = '<walnut-turn status="no-action"/>';
const TAGS = [NO_ACTION_TAG, LEGACY_NO_ACTION_TAG];

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
/** Four spaces (or a tab) in: an indented code block, whose lines are code. */
const INDENTED_CODE = /^(?: {4}|\t)/;

export interface TurnMarker {
  /** The text without the marker line (trailing blank lines dropped). */
  text: string;
  /** True when the text ended with the marker. */
  noAction: boolean;
}

/** Read the marker off a message's text. */
export function readTurnMarker(text: string | undefined): TurnMarker {
  const src = readAboutTag(text ?? '').text;
  if (!TAGS.some((t) => src.includes(t))) return { text: src, noAction: false };
  const lines = src.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (last < 0 || !TAGS.includes(lines[last].trim()) || INDENTED_CODE.test(lines[last])) {
    return { text: src, noAction: false };
  }
  // Inside a fence? Track the open fence's own marker: ``` and ~~~ close only themselves.
  let open: string | null = null;
  for (let i = 0; i < last; i++) {
    const m = FENCE.exec(lines[i]);
    if (!m) continue;
    const mark = m[1];
    if (open === null) open = mark;
    // A closing fence carries nothing after it: "```js" inside a block opens nothing and closes nothing.
    else if (mark[0] === open[0] && mark.length >= open.length && !m[2].trim()) open = null;
  }
  if (open !== null) return { text: src, noAction: false };
  return { text: lines.slice(0, last).join('\n').replace(/\s+$/, ''), noAction: true };
}

/**
 * The text as the screen shows it: the marker line never prints. While a message
 * is still streaming, a last line that is so far only the START of the marker is
 * held back too, so the tag never flashes up character by character.
 */
export function stripTurnMarker(text: string, streaming = false): string {
  // The tasks line of an Org chat (message-about.ts) goes first: it may follow the marker.
  text = stripSelfReportBlock(stripAboutTag(text, streaming));
  const read = readTurnMarker(text);
  if (read.noAction) return read.text;
  if (!streaming) return text;
  const cut = text.lastIndexOf('\n');
  const tail = text.slice(cut + 1).trim();
  // Even a lone `<`: the tag's first chunk flashed on its own until the next one arrived.
  return tail.length >= 1 && TAGS.some((t) => t.startsWith(tail)) ? text.slice(0, Math.max(0, cut)) : text;
}

/**
 * A turn-end self-report field the model wrote into its own reply (2026-10-29: after a compaction
 * the summary turned "Walnut asks you for the Brief" into "write the Brief at every turn end", and
 * a lead's answer ended with a bare `FOR_USER_BRIEF` line and the whole list again). Walnut asks
 * for it in a separate question; in a reply it only prints the same thing twice. A line that is
 * exactly the field name (`FOR_USER_BRIEF`, `FOR_USER_BRIEF:`), outside a code block, cuts the text
 * there. Only that field, the one the Brief rule names: another field alone on a line stays, as
 * does a mention of the name inside a sentence.
 */
const SELF_REPORT_FIELD = /^\s{0,3}(?:\*\*)?FOR_USER_BRIEF:?(?:\*\*)?:?\s*$/;

export function stripSelfReportBlock(text: string): string {
  if (!text.includes('FOR_USER_BRIEF')) return text;
  const lines = text.split('\n');
  let open: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (m) {
      const mark = m[1];
      if (open === null) open = mark;
      else if (mark[0] === open[0] && mark.length >= open.length && !m[2].trim()) open = null;
      continue;
    }
    if (open !== null || INDENTED_CODE.test(lines[i])) continue;
    // Not the first line: a reply that is only the field is the model answering Walnut's ask.
    if (i > 0 && SELF_REPORT_FIELD.test(lines[i])) return lines.slice(0, i).join('\n').replace(/\s+$/, '');
  }
  return text;
}

/** The shape the turn rule reads (SessionHistoryMessage). */
export interface MarkerTurnMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  injected?: boolean;
  systemVariant?: 'compact' | 'error' | 'info';
  tools?: { name: string; isError?: boolean; result?: unknown }[];
  /** The CLI started a turn here on a line the chat does not show (a background agent's
   *  `<task-notification>`, history-parse.ts): the turn opens on this row. */
  opensTurn?: boolean;
}

/**
 * Where turns start, the ONE rule every turn splitter reads (turn-shape.ts, noActionRows,
 * the phone's TimelineTurnShape.swift): a row sent into the session (`sent`, the row itself
 * opens the turn and is not one of its steps), or a row the CLI began a turn on from a line
 * the chat hides (`sent: false`, the row is the turn's first step). Without the second kind, a
 * session woken by its background agents read as one turn an hour long: every new progress
 * line reshaped all the lines before it, folded while it settled and flat while the reader
 * watched it stream (2026-11-19).
 */
export type TurnStart = {
  at: number;
  sent: boolean;
  /** The exclusive lower bound of the turn's rows: a sent row is not one of them (`at`), a
   *  hidden start's row is (`at - 1`). */
  from: number;
};

/** `openerAt` replaces the `opensTurn` rule for rows filed apart from their neighbours (a
 *  question's page, turn-shape.ts), which the whole transcript already read. */
export function turnStartsOf<M extends MarkerTurnMessage>(
  messages: readonly M[],
  isSent: (m: M, i: number) => boolean,
  openerAt?: (i: number) => boolean,
): TurnStart[] {
  const out: TurnStart[] = [];
  messages.forEach((m, i) => {
    const prev = out[out.length - 1];
    if (m.role === 'user' && isSent(m, i)) out.push({ at: i, sent: true, from: i });
    // Right after a sent row, the turn that row opened is the one the CLI began.
    else if (openerAt ? openerAt(i) : !!m.opensTurn && !(prev?.sent && prev.at === i - 1)) out.push({ at: i, sent: false, from: i - 1 });
  });
  return out;
}

/** Tools that put something in front of the person: their turn never folds away. */
const PERSON_FACING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Which history rows are a clean acknowledgement: the main assistant's LAST row
 * of a FINISHED turn that something other than a person started (`isPerson`),
 * holding the line and nothing else, in a turn with no failed tool, no question
 * to the person, no plan and no error line. A turn a person started, or a line
 * with words before it, is never one: the words are an answer.
 *
 * Rows split where turns start (turnStartsOf: every message sent into the session,
 * `isSent`: a person's, a peer's, a Walnut notice, a CLI-injected line not being one;
 * and every row a hidden notification began a turn on), so a notice the
 * session answered with the marker alone is its own turn and leaves the answer
 * before it folded. A delivery that came in while the session was still working
 * (the rows before it end in a tool call, not an answer) belongs to that turn:
 * its failures count. A turn is finished when a later one exists or nothing is
 * streaming. A turn whose start is not in `messages` (a tail window) is never
 * folded: its earlier rows, and the failures they may hold, cannot be checked.
 * `stripTag` removes the reply's question tag first (question-tag.ts), the way
 * the screen does.
 */
export function noActionRows(
  messages: readonly MarkerTurnMessage[],
  streaming: boolean,
  stripTag: (text: string) => string = (t) => t,
  isRoutedQuestion: (name: string, result: unknown) => boolean = () => false,
  isSent: (m: MarkerTurnMessage) => boolean = (m) => !m.injected,
  isPerson: (m: MarkerTurnMessage) => boolean = () => false,
): Set<number> {
  const out = new Set<number>();
  const bounds = turnStartsOf(messages, (m) => isSent(m));
  const starts = bounds.map((b) => b.at);
  const fromOf = (k: number) => bounds[k].from;
  /** The last row of [from, to) that counts as the turn's word (an info line does not). */
  const lastRowOf = (from: number, to: number): number => {
    for (let i = to - 1; i > from; i--) {
      const m = messages[i];
      if (m.role === 'system' && m.systemVariant !== 'error') continue;
      return i;
    }
    return -1;
  };
  /** The span ended in an answer (text, no tool call): what follows is a new turn. */
  const endsInAnswer = (from: number, to: number): boolean => {
    const i = lastRowOf(from, to);
    return i >= 0 && messages[i].role === 'assistant' && (messages[i].tools?.length ?? 0) === 0;
  };
  starts.forEach((_start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : messages.length;
    const finished = k + 1 < starts.length || !streaming;
    if (!finished) return;
    const last = lastRowOf(fromOf(k), end);
    if (last < 0) return;
    const final = messages[last];
    if (final.role !== 'assistant' || (final.tools?.length ?? 0) > 0) return;
    const read = readTurnMarker(stripTag(final.text));
    if (!read.noAction || read.text.trim()) return;
    // Back over deliveries that arrived mid-work, to where this turn began.
    let j = k;
    // A hidden start is where the CLI began a turn: the one before it was over.
    while (j > 0 && bounds[j].sent && !endsInAnswer(fromOf(j - 1), starts[j])) j--;
    if (j === 0 && bounds[0].sent && starts[0] > 0 && !endsInAnswer(-1, starts[0])) return;
    // A person's message anywhere in it makes it their turn (turn-shape.ts splits there too).
    for (let q = j; q <= k; q++) if (bounds[q].sent && isPerson(messages[starts[q]])) return;
    for (let i = fromOf(j) + 1; i < end; i++) {
      const m = messages[i];
      if (m.role === 'system' && m.systemVariant === 'error') return;
      for (const t of m.tools ?? []) {
        if (PERSON_FACING_TOOLS.has(t.name)) return;
        if (t.isError && !isRoutedQuestion(t.name, t.result)) return;
      }
    }
    out.add(last);
  });
  return out;
}
