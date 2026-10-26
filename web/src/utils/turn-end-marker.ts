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
 * the text. Pure: tests/web/turn-end-marker.test.ts.
 */

export const NO_ACTION_TAG = '<walnut-turn status="agent-ack"/>';
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
  const src = text ?? '';
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
  const read = readTurnMarker(text);
  if (read.noAction) return read.text;
  if (!streaming) return text;
  const cut = text.lastIndexOf('\n');
  const tail = text.slice(cut + 1).trim();
  // Even a lone `<`: the tag's first chunk flashed on its own until the next one arrived.
  return tail.length >= 1 && TAGS.some((t) => t.startsWith(tail)) ? text.slice(0, Math.max(0, cut)) : text;
}

/** The shape the turn rule reads (SessionHistoryMessage). */
export interface MarkerTurnMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  injected?: boolean;
  systemVariant?: 'compact' | 'error' | 'info';
  tools?: { name: string; isError?: boolean; result?: unknown }[];
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
 * Rows split at every message sent into the session (`isSent`: a person's, a
 * peer's, a Walnut notice; a CLI-injected line is not one), so a notice the
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
  const starts: number[] = [];
  messages.forEach((m, i) => { if (m.role === 'user' && isSent(m)) starts.push(i); });
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
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : messages.length;
    const finished = k + 1 < starts.length || !streaming;
    if (!finished) return;
    const last = lastRowOf(start, end);
    if (last < 0) return;
    const final = messages[last];
    if (final.role !== 'assistant' || (final.tools?.length ?? 0) > 0) return;
    const read = readTurnMarker(stripTag(final.text));
    if (!read.noAction || read.text.trim()) return;
    // Back over deliveries that arrived mid-work, to where this turn began.
    let j = k;
    while (j > 0 && !endsInAnswer(starts[j - 1], starts[j])) j--;
    if (j === 0 && starts[0] > 0 && !endsInAnswer(-1, starts[0])) return;
    // A person's message anywhere in it makes it their turn (turn-shape.ts splits there too).
    for (let q = j; q <= k; q++) if (isPerson(messages[starts[q]])) return;
    for (let i = starts[j] + 1; i < end; i++) {
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
