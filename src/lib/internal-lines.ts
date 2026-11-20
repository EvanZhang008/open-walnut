/**
 * Lines of Walnut's own formats that a session's reply must never show the user.
 *
 * Walnut talks to a session in formats meant for Walnut alone: the status report a side question
 * asks right after each turn (FOR_USER_STATE, FOR_USER_NOW, FOR_USER_ASK, ...: session-hooks/
 * builtins.ts FOR_USER_PROMPT, sessions/status-question.ts), and until 2026-11-19 a version tag in
 * front of every line of a versioned rule block ("[v16908844] ", sessions/instruction-diff.ts).
 * Models copy both into their own replies:
 *   - 2026-10-29: after a compaction a lead's answer ended with a bare FOR_USER_BRIEF block.
 *   - 2026-11-19: replies began with "[v16908844]" after a compaction summary turned the tag into
 *     a rule for every line.
 *   - 2026-11-20: replies of several tasks ended with "FOR_USER_STATE: working" / FOR_USER_NOW /
 *     FOR_USER_NEXT lines, after op answers and a built-in skill told them to write FOR_USER_ASK
 *     "at the end of your turn" (the user: "why it show?").
 * The status side question is how Walnut takes the report; in a reply those lines only print it
 * twice. So the text as the screen shows it (turn-end-marker.ts stripTurnMarker, used by the web
 * chat, the thread cards and the session find) leaves them out, and no text Walnut gives a session
 * tells it to write them in a reply (STATUS_REPORT_CHANNEL; tests/lib/internal-lines.test.ts).
 *
 * Pure and shared with the web client. Outside code blocks only: a fenced or indented block shows
 * as written, and a mention of a field name inside a sentence is not a line of the report.
 */

/** Where a session's status, and an ask of the user, go: never lines of a reply. */
export const STATUS_REPORT_CHANNEL = 'your status report (Walnut asks for it in a question of its own right after your turn; '
  + 'never write its lines in a reply) or task_report_set';

/**
 * A line of the status report: a FOR_USER_ field name (any: a new field is covered too, such as
 * "FOR_USER_THREAD t1:"), optionally bold, then a colon (a full-width one too). A bare field name
 * alone on a line too. Never a list item: "- FOR_USER_STATE: ..." is someone explaining the fields.
 */
const STATUS_FIELD_LINE = /^\s{0,3}(?:\*\*)?FOR_USER_[A-Z][A-Z0-9_]*(?:\*\*)?(?:(?:\s+[^\s:\uFF1A]{1,40})?\s*(?:\*\*)?[:\uFF1A]|\s*$)/;
/** The version tag a versioned block put before each of its lines until 2026-11-19. */
const VERSION_TAG = /^(\s{0,3})\[v[0-9a-f]{8}\]\s+/;
/** A line of Walnut's own tags (the turn-end marker, the tasks line): others read them, so kept. */
const WALNUT_TAG_LINE = /^\s{0,3}<\/?walnut-/;
/** A line that carries a field's value on: indented, or an item of a list. */
const CONTINUATION = /^(?:\s+\S|\s{0,3}(?:[-*+]|\d+[.)])\s)/;
/** While a reply streams in, a last line that is so far only the start of a field name. */
const FIELD_START = /^\s{0,3}(?:\*\*)?F(?:O(?:R(?:_(?:U(?:S(?:E(?:R(?:_[A-Z0-9_]*)?)?)?)?)?)?)?)?$/;

export const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
/** Four spaces (or a tab) in: an indented code block, whose lines are code. */
export const INDENTED_CODE = /^(?: {4}|\t)/;

/** True when the line is a line of the status report (outside code: the caller tracks fences). */
export function isStatusReportLine(line: string): boolean {
  return STATUS_FIELD_LINE.test(line);
}

/** True when the line starts with an old version tag. */
export function hasVersionTag(line: string): boolean {
  return VERSION_TAG.test(line);
}

/**
 * The text without Walnut's internal lines: the status report at its END (from a field line to the
 * end of the text, holding only field lines, the lines that carry a field's value on, blank lines
 * and Walnut's own tag lines, which stay) is dropped, and a version tag at the start of a line is
 * cut off. Only at the end: a field line with the session's words after it is the session
 * explaining the format, and stays. The Brief's block runs to the end whatever its lines are. A text
 * that opens with the report is left as it is: that is a session answering Walnut's own question,
 * which no chat shows as a reply. `streaming`: a last line that is only the start of a field name is
 * held back, so it never flashes up while the report is being written.
 */
export function stripInternalLines(text: string, streaming = false): string {
  if (!text.includes('FOR_USER_') && !text.includes('[v') && !(streaming && /F\S*$/.test(text))) return text;
  const lines = text.split('\n');
  const bare = (l: string) => l.replace(/\r$/, '');
  // Which lines are code (a fence or an indented block), and the version tags cut off the rest.
  const code: boolean[] = [];
  let open: string | null = null;
  const out = lines.map((raw, i) => {
    const line = bare(raw);
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      if (open === null) open = mark;
      else if (mark[0] === open[0] && mark.length >= open.length && !fence[2].trim()) open = null;
      code[i] = true;
      return raw;
    }
    code[i] = open !== null || INDENTED_CODE.test(line);
    return code[i] ? raw : raw.replace(VERSION_TAG, '$1');
  });
  const isField = (i: number) => !code[i] && STATUS_FIELD_LINE.test(bare(out[i]));
  const first = out.findIndex((l) => bare(l).trim());
  // A text that opens with the report: the answer to Walnut's own question, left whole.
  if (first >= 0 && isField(first)) return out.join('\n') === text ? text : out.join('\n');
  // The report's start: the earliest field line from which, to the end, nothing but the report follows.
  let start = -1;
  for (let i = out.length - 1; i > first; i--) {
    const line = bare(out[i]);
    if (!line.trim() || WALNUT_TAG_LINE.test(line)) continue;
    if (isField(i)) { start = i; continue; }
    // A value carried on, indented four spaces deep too (that is not code inside the report).
    if ((!code[i] || INDENTED_CODE.test(line)) && CONTINUATION.test(line)) continue;
    // The session's own words: the report, if any, started after them.
    break;
  }
  // From the Brief's field on, everything is the Brief, whatever came after it.
  const briefAt = out.findIndex((l, i) => i > first && isField(i) && /FOR_USER_BRIEF\b/.test(bare(l)));
  if (briefAt > first && (start < 0 || briefAt < start)) start = briefAt;
  let kept = start < 0 ? out : [...out.slice(0, start), ...out.slice(start).filter((l) => WALNUT_TAG_LINE.test(bare(l)))];
  if (streaming && kept.length > 1 && FIELD_START.test(bare(kept[kept.length - 1])) && kept[kept.length - 1].trim().length >= 4) kept = kept.slice(0, -1);
  const joined = kept.join('\n');
  return joined === text ? text : joined.replace(/\s+$/, '');
}
