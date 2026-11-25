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
 *   - 2026-11-24: replies of many sessions ended with one line per open thread ("th-0a1b2c3d4e5f:
 *     answered · ...", in about ten shapes, some inside a tag they made up, `<walnut-status>`), after
 *     the Threads rule said each turn ends with a line for each thread (the user: "why u keep show
 *     all the therd at bottom"; "Why itkeep show the thread info in the normal conversaiton"). A
 *     Claude Code session never sees the status side question in its own conversation, so it
 *     wrote the lines itself.
 * The status side question is how Walnut takes the report; in a reply those lines only print it
 * twice. So the text as the screen shows it (turn-end-marker.ts stripTurnMarker, used by the web
 * chat, the thread cards and the session find) leaves them out, and no text Walnut gives a session
 * tells it to write them in a reply (STATUS_REPORT_CHANNEL, THREAD_LINE_CHANNEL;
 * tests/lib/internal-lines.test.ts).
 *
 * Pure and shared with the web client. Outside code blocks only: a fenced or indented block shows
 * as written, and a mention of a field name inside a sentence is not a line of the report.
 */
import { ABOUT_TAG_NAME } from '../core/org/message-about.js';

/**
 * Where a thread's line goes, named by every text that asks for one or says Walnut writes threads from
 * it (tests/core/sessions/status-threads-kept.test.ts): the status side question, which a Claude Code
 * session never sees in its own chat (2026-11-24). No text puts those lines at "the turn's end"
 * (tests/lib/internal-lines.test.ts). The Threads rule says it in full, once; the other texts name it.
 * Never "never in a reply" alone: a question of his about his threads is answered in the reply
 * (review 2026-11-25).
 */
export const STATUS_QUESTION = 'Walnut\'s status question';
export const THREAD_LINE_CHANNEL = `${STATUS_QUESTION} after your turn; in your reply only if he asks`;

/** Where a session's status, and an ask of the user, go: never lines of a reply. */
export const STATUS_REPORT_CHANNEL = 'your status report (Walnut asks for it in a question of its own right after your turn; '
  + 'never write its lines in a reply) or task_report_set';

/**
 * A line of the status report: a FOR_USER_ field name (any: a new field is covered too, such as
 * "FOR_USER_THREAD t1:"), optionally bold, then a colon (a full-width one too). A bare field name
 * alone on a line too. Never a list item: "- FOR_USER_STATE: ..." is someone explaining the fields.
 *
 * Every pattern here runs in Unicode mode (`u`) and writes digits, word ends and "any character" out
 * ([0-9], (?![A-Za-z0-9_]), [^\n\r\u2028\u2029]): so it counts and folds as the phone's ICU does
 * (ios-native/Walnut/Timeline/InternalLines.swift, review 2026-11-25).
 */
const STATUS_FIELD_LINE = /^\s{0,3}(?:\*\*)?FOR_USER_[A-Z][A-Z0-9_]*(?:\*\*)?(?:(?:\s+[^\s:\uFF1A]{1,40})?\s*(?:\*\*)?[:\uFF1A]|\s*$)/u;
/** The version tag a versioned block put before each of its lines until 2026-11-19. */
const VERSION_TAG = /^(\s{0,3})\[v[0-9a-f]{8}\]\s+/u;
/** A line of Walnut's own tags (the turn-end marker, the tasks line): others read them, so kept. */
const WALNUT_TAG_LINE = /^\s{0,3}<\/?walnut-/u;
/** A line that carries a field's value on: indented, or an item of a list. */
const CONTINUATION = /^(?:\s+\S|\s{0,3}(?:[-*+]|[0-9]+[.)])\s)/u;
/** While a reply streams in, a last line that is so far only the start of a field name. */
const FIELD_START = /^\s{0,3}(?:\*\*)?F(?:O(?:R(?:_(?:U(?:S(?:E(?:R(?:_[A-Z0-9_]*)?)?)?)?)?)?)?)?$/u;
const BRIEF_FIELD = /FOR_USER_BRIEF(?![A-Za-z0-9_])/u;

/** A thread's id as Walnut writes it. */
const THREAD_ID = /th-[0-9a-f]{6,32}/u;
/** Its state, in the words sessions wrote it (English, and Chinese, escaped). */
const THREAD_STATE = /^(?:working|waiting|answered|done|needs|pending|new|closed|\u5904\u7406\u4e2d|\u8fdb\u884c\u4e2d|\u7b49\u5f85\u4e2d|\u5df2\u56de\u7b54|\u7b49\u4f60\u51b3\u5b9a|\u7b49\u4f60\u5b9a|\u5df2\u5b8c\u6210|\u5b8c\u6210|\u5df2\u5173\u95ed)(?![a-z])/iu;
/** A table row or a quote: never a thread's line, whatever it holds (review 2026-11-25). */
const TABLE_OR_QUOTE = /^\s{0,3}[|>]/u;
/** Before the id, a thread's line holds at most a list mark, bold, "Thread " and an opening mark. */
const ID_FIRST = /^\s{0,3}(?:(?:[-*+]|[0-9]+[.)])\s+)?(?:\*\*)?(?:thread\s+|\u7ebf\u7a0b\s*)?[`"]?$/iu;
/**
 * Or a short title right before the id in brackets ("Garden lights (th-...): working"). No sentence
 * mark or comma in it: words like that before the id are prose ("Merged it into the login thread
 * (th-...), done.", review 2026-11-25), and so is a title the id follows with a comma.
 */
const TITLE_FIRST = /^\s{0,3}(?:(?:[-*+]|[0-9]+[.)])\s+)?(?:\*\*)?(?:[^\n\u3002\uff01\uff1f\uff1b\uff0c!?;,.]|\.(?!\s)){1,60}[(\uff08]$/u;
/** After a title-first id: its closing bracket, then a colon. */
const TITLE_ID_CLOSE = /^[)\uff09][`*]*\s*[:\uff1a]\s*[`*]*\s*/u;
/** Between the id and its state: closing marks, its title in brackets or quotes, separators. */
const THREAD_AFTER_ID = /^[`*"\u300d\uff09)\u201d]*\s*(?:(?:"[^"\n]{0,160}"|\u201c[^\u201d\n]{0,160}\u201d|\u300c[^\u300d\n]{0,160}\u300d|\uff08[^\uff09\n]{0,160}\uff09|\([^)\n]{0,160}\))\s*)?[`*]*\s*[:\uff1a|\u00b7\u2014\u2013,\uff0c-]*\s*[`*]*\s*/u;
/** A line of a tag of Walnut's that names a thread (`<walnut-status thread="th-..." state="working">`). */
const THREAD_TAG_LINE = /^\s{0,3}<walnut-[a-z0-9-]+(?![A-Za-z0-9_])[^>]*th-[0-9a-f]{6,32}/iu;
/** A line that is only an opening or closing tag of Walnut's (a wrapper), never a self-closing one. */
const WALNUT_WRAPPER_LINE = /^\s{0,3}<\/?walnut-[a-z0-9-]+(?![A-Za-z0-9_])[^>]*[^/>]?>\s*$/iu;
const SELF_CLOSING = /\/>\s*$/u;
const TAG_NAME = /<(walnut-[a-z0-9-]+)/iu;
/** While a reply streams in, a last line that is so far a tag of Walnut's still coming in (no ">" yet). */
const TAG_SO_FAR = /^\s{0,3}<\/?(?:w(?:a(?:l(?:n(?:u(?:t(?:-[^>\n]*)?)?)?)?)?)?)?$/iu;
const CLOSING_TAG = /^\s*<\//u;
/**
 * The tags whose starts another layer holds while a reply streams in: turn-end-marker.ts TAGS (it
 * imports this file, so they are written out here; tests/lib/internal-lines.test.ts keeps them
 * equal) and message-about.ts. A start of one of them is left to that hold.
 */
export const HELD_ELSEWHERE = ['<walnut-turn status="agent-ack"/>', '<walnut-turn status="no-action"/>'];
const ABOUT_START = `<${ABOUT_TAG_NAME}`;
/** While a reply streams in, a last line that is a tag of Walnut's still coming in that no other layer holds. */
const tagComing = (line: string) => {
  const t = line.trim();
  return TAG_SO_FAR.test(line) && !HELD_ELSEWHERE.some((h) => h.startsWith(t))
    && !(t.length >= 2 && (ABOUT_START.startsWith(t) || t.startsWith(ABOUT_START)));
};
/** A wrapper tag line of Walnut's (opening or closing, never self-closing). */
const isWrapper = (line: string) => WALNUT_WRAPPER_LINE.test(line) && !SELF_CLOSING.test(line);
/** An opening wrapper tag of Walnut's, never its closing one or a self-closing tag. */
const isWrapperOpen = (line: string) => isWrapper(line) && !CLOSING_TAG.test(line);
/**
 * The heading sessions put over those lines ("Thread status:", "Open threads:", "Threads:", and the
 * Chinese ones: "each thread's status", "threads that changed this turn").
 */
const THREAD_HEADING = /^\s{0,3}(?:#{1,4}\s+)?(?:\*\*)?\s*(?:open\s+|\u5404\s*|\u672c\u8f6e[^\s:\uff1a*]{0,6}?)?(?:threads?|\u7ebf\u7a0b)\s*(?:\u7684\s*)?(?:\u72b6\u6001|status(?:es)?|updates?)?\s*(?:\*\*)?\s*[:\uff1a]?\s*(?:\*\*)?\s*$/iu;
const RULE_LINE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;
/** While a reply streams in, a text that may end with that heading (its lines still to come). */
const STREAMING_HEADING_END = /(?:threads?|status(?:es)?|updates?|\u7ebf\u7a0b|\u72b6\u6001)[^A-Za-z0-9_]*$/iu;
/**
 * A list item naming a thread, an optional title in brackets, then a colon, whatever its state words
 * say ("- th-...\uff08title\uff09\uff1awaits for your review"): a thread's line only in a block that is
 * plainly one (a heading over it, a tag of Walnut's around it, or a line with a known state word in
 * it), never a list of thread ids written as content ("the ones merged are:", review 2026-11-25).
 */
const THREAD_ITEM = /^\s{0,3}(?:[-*+]|[0-9]+[.)])\s+(?:\*\*)?`?th-[0-9a-f]{6,32}`?(?:\*\*)?\s*(?:(?:\uff08[^\uff09\n]{0,160}\uff09|\([^)\n]{0,160}\)|\u300c[^\u300d\n]{0,160}\u300d|\u3010[^\u3011\n]{0,160}\u3011|\[[^\]\n]{0,160}\])\s*)?(?:\*\*)?\s*[:\uff1a]/u;
const LIST_ITEM = /^\s*(?:[-*+]|[0-9]+[.)])\s/u;
const LEADING_SPACE = /^\s*/u;
/**
 * Where a sentence ends inside a line: \u3002\uff01\uff1f anywhere; ".", "!" or "?" only before a space or the
 * line's end (so never the dots of "1.0.267.0" or "x.test.ts:242", nor a "?" in a URL), closing
 * marks after it included.
 */
const SENTENCE_END = /(?:[\u3002\uff01\uff1f]+|[.!?]+(?=[)"'\u201d\u300d\uff09*_`]*(?:\s|$)))[)"'\u201d\u300d\uff09*_`]*/gu;
/**
 * A lead-in: the sentence right before a list says it follows (a colon at its end, "as follows",
 * "below", the Chinese ones escaped) or names the threads. The list is then the answer, whatever came
 * before it (review 2026-11-25: "I checked. Here is where they stand:" hid the list he asked for).
 */
const ENDS_WITH_COLON = /[:\uff1a][*_]*\s*$/u;
const LEAD_IN = /\u5982\u4e0b|\u4ee5\u4e0b|\u4e0b\u9762|\u4e0b\u5217|as follows|(?<![A-Za-z])below(?![A-Za-z])|the following|\u7ebf\u7a0b|(?<![A-Za-z])threads?(?![A-Za-z])/iu;
/**
 * Proof a block holds: a URL (to the first CJK character or full-width mark), an absolute path, a
 * letter's id (lt-..., in a letter: link too), a task ref tag, or the target of a relative link or
 * image. A block holding one the reply keeps nowhere else stays (review 2026-11-25: 215 of 541
 * changed replies lost a link or a path with their block).
 */
const EVIDENCE = /https?:\/\/[^\s<>"'`()\[\]\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+|(?<![A-Za-z0-9._~/-])~?\/[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+|(?<![A-Za-z0-9_-])lt-[0-9a-z]{6,}|<task-ref[^>]*>|(?<=\]\()(?![A-Za-z][A-Za-z0-9+.-]*:)[^)\s]+(?=\))/gu;
const EVIDENCE_TAIL = /[.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f]+$/u;
/**
 * A line that waits on him: its state is needs or new, or its words ask him ("waits for your review",
 * "your call", a question; the Chinese ones, escaped: wait for you to decide, review, pick, nod, reply;
 * needs you to; please answer me; please decide), once the words saying he is not needed are taken
 * out. A block with one stays (review 2026-11-25: 39 real replies hid a decision of his, some on
 * threads in waiting, which his Threads view does not show).
 */
const ASKING_STATE = /^(?:needs|new)$/iu;
const TAG_STATE = /(?<![A-Za-z0-9_-])state=["']?([A-Za-z]+)/u;
const ASKS_HIM = /\u7b49\u4f60(?:\u51b3\u5b9a|\u5b9a|\u5ba1|\u9009|\u70b9\u5934|\u56de|\u6279|\u786e\u8ba4|\u770b)|\u8981\u4f60(?:\u70b9\u5934|\u51b3\u5b9a|\u5b9a|\u786e\u8ba4|\u5ba1|\u9009|\u6279\u51c6|\u56de)|\u9700\u8981\u4f60(?:\u56de|\u51b3\u5b9a|\u786e\u8ba4|\u5ba1|\u9009|\u6279\u51c6|\u70b9\u5934|\u770b|\u5904\u7406)|\u8bf7\u56de\u6211|\u8bf7\u4f60(?:\u5b9a|\u9009|\u786e\u8ba4|\u51b3\u5b9a|\u56de)|\u4f60\u6765\u5b9a|\u7531\u4f60(?:\u5b9a|\u51b3\u5b9a)|(?<![A-Za-z])(?:your call|up to you|wait(?:s|ing)? (?:on|for) your?|needs? (?:you|your (?:decision|review|approval|answer|ok|yes|input))|for your (?:review|approval|decision|answer|ok|yes))(?![A-Za-z])|[?\uff1f]/iu;
const NOT_ASKING = /\u4e0d\u9700\u8981\u4f60|\u4e0d\u7528\u4f60|\u65e0\u9700\u4f60|\u4e0d\u7b49\u4f60|no need for you|nothing (?:for|from) you|not waiting (?:on|for) you/giu;

/**
 * How many sentences the words before a thread block hold: two lines or more count as two; in one
 * line, its sentence ends, and one more for words after the last end (a lead-in ending in a colon,
 * "Here is where they stand:", is one sentence). Pure.
 */
export function sentenceCount(lines: readonly string[]): number {
  if (lines.length !== 1) return lines.length === 0 ? 0 : 2;
  const line = lines[0].trim();
  let ends = 0;
  let after = 0;
  for (const m of line.matchAll(SENTENCE_END)) { ends++; after = m.index + m[0].length; }
  return ends + (line.slice(after).trim() ? 1 : 0);
}

/**
 * True when the line is a thread's line of the status question (outside code: the caller tracks
 * fences): a thread's id, then its state word, with at most a title and separators between them, or
 * a short title, the id in brackets, a colon and the state; or a line of a Walnut tag that names a
 * thread. Never a table row, a quote, or prose that names a thread. Pure.
 */
export function isThreadStatusLine(line: string): boolean {
  return threadStateOf(line) !== null;
}

/** A thread's line's state word (a tag's state attribute, '' for a tag without one); null for no thread line. */
function threadStateOf(line: string): string | null {
  const m = THREAD_ID.exec(line);
  if (!m || TABLE_OR_QUOTE.test(line)) return null;
  if (THREAD_TAG_LINE.test(line)) return TAG_STATE.exec(line)?.[1] ?? '';
  const before = line.slice(0, m.index);
  const rest = line.slice(m.index + m[0].length);
  let after: string;
  if (ID_FIRST.test(before)) after = rest.slice(THREAD_AFTER_ID.exec(rest)?.[0].length ?? 0);
  else {
    const close = TITLE_FIRST.test(before) ? TITLE_ID_CLOSE.exec(rest) : null;
    if (!close) return null;
    after = rest.slice(close[0].length);
  }
  return THREAD_STATE.exec(after)?.[0] ?? null;
}

/** A line that waits on him (ASKS_HIM): its words, without the proof in them (a "?" of a URL). */
const asksHim = (line: string) => {
  const state = threadStateOf(line);
  return (state !== null && ASKING_STATE.test(state)) || ASKS_HIM.test(line.replace(EVIDENCE, ' ').replace(NOT_ASKING, ' '));
};

/** While a reply streams in, the start of a thread's line: a list mark, bold, then its id as far as it has come. */
const THREAD_ID_SO_FAR = /^\s{0,3}(?:(?:[-*+]|[0-9]+[.)])(?:\s+|$))?\*{0,2}(?:t(?:h(?:-[0-9a-f]{0,31})?)?)?$/u;
/** While a reply streams in, an id as far as it has come at the line's end ("title (th-3"). */
const ID_SO_FAR_END = /t(?:h(?:-[0-9a-f]{0,31})?)?$/u;
/** While a reply streams in, a last line that may still become a thread's line (its id is in, its state not yet). */
const threadLineSoFar = (line: string) => {
  if (TABLE_OR_QUOTE.test(line)) return false;
  const m = THREAD_ID.exec(line) ?? ID_SO_FAR_END.exec(line);
  if (m && line.length - m.index < 200) {
    const before = line.slice(0, m.index);
    if (ID_FIRST.test(before) || TITLE_FIRST.test(before)) return true;
  }
  return line.trim() !== '' && THREAD_ID_SO_FAR.test(line);
};
/** The headings sessions wrote over thread lines, lowercase, for a heading still coming in ("Thre"). */
const HEADINGS = ['thread status', 'thread statuses', 'thread updates', 'threads', 'open threads',
  '\u5404 thread \u7684\u72b6\u6001', '\u5404 thread \u72b6\u6001', '\u5404\u7ebf\u7a0b\u72b6\u6001', '\u7ebf\u7a0b\u72b6\u6001', '\u672c\u8f6e\u53d8\u4e86\u7684\u7ebf\u7a0b'];
const HEADING_LEAD = /^\s{0,3}(?:#{1,4}\s*)?\**\s*/u;
const HEADING_TRAIL = /\s*[:\uff1a]?\**\s*$/u;
const SPACES = /\s+/gu;
const RULE_SO_FAR = /^\s{0,3}-{2,}\s*$/u;
/** While a reply streams in, a last line that is so far the start of one of those headings, or of a rule above them. */
const headingSoFar = (line: string) => {
  const t = line.replace(HEADING_LEAD, '').replace(HEADING_TRAIL, '').replace(SPACES, ' ').toLowerCase();
  return (t !== '' && HEADINGS.some((h) => h.startsWith(t))) || RULE_SO_FAR.test(line);
};

export const FENCE = /^\s{0,3}(`{3,}|~{3,})([^\n\r\u2028\u2029]*)$/u;
/** Four spaces (or a tab) in: an indented code block, whose lines are code. */
export const INDENTED_CODE = /^(?: {4}|\t)/u;

/** True when the line is a line of the status report (outside code: the caller tracks fences). */
export function isStatusReportLine(line: string): boolean {
  return STATUS_FIELD_LINE.test(line);
}

/** True when the line starts with an old version tag. */
export function hasVersionTag(line: string): boolean {
  return VERSION_TAG.test(line);
}

const TRAILING_SPACE = /\s+$/u;
const STREAMING_TAIL = /[Ft<]\S*$/u;
/** While a reply streams in, whether its last line that is not blank may still be held back (cheap: the whole check runs only then). */
const streamingTailMayHold = (text: string) => {
  const said = text.replace(TRAILING_SPACE, '');
  const tail = said.slice(said.lastIndexOf('\n') + 1);
  return STREAMING_TAIL.test(text) || STREAMING_HEADING_END.test(text) || threadLineSoFar(tail) || headingSoFar(tail) || (LIST_ITEM.test(tail) && said.includes('\n'));
};

/** The URLs and paths in some lines, without the sentence mark a line may end them with. */
const evidenceIn = (lines: readonly string[]) => lines.flatMap((l) => [...l.matchAll(EVIDENCE)].map((m) => m[0].replace(EVIDENCE_TAIL, '')));

/**
 * The text without Walnut's internal lines: the status report at its END (from a field line to the
 * end of the text, holding only field lines, the lines that carry a field's value on, blank lines
 * and Walnut's own tag lines, which stay) is dropped, and a version tag at the start of a line is
 * cut off. Only at the end: a field line with the session's words after it is the session
 * explaining the format, and stays. The Brief's block runs to the end whatever its lines are. A text
 * that opens with the report is left as it is: that is a session answering Walnut's own question,
 * which no chat shows as a reply.
 *
 * Thread lines (2026-11-24) go the same way, with their heading, a rule above them and a tag of
 * Walnut's around them, and only when they are strictly the end of the reply: a list item, a
 * paragraph, a table row or a quote after one ends the block, and then nothing goes; only a line
 * indented under a thread's list item carries it on. Precision first (review 2026-11-25): the rule's
 * words keep new replies clean, so this only cleans what older habits still write, and it never
 * hides what he may need. So the block also stays when it is the whole reply, when it follows one
 * sentence outside a tag a session made up, or a lead-in ("Here is where they stand:", "as
 * follows", a sentence naming the threads), when it holds a URL, a path, a letter or a task the
 * reply keeps nowhere else, when a line of it waits on him (a decision, a question, news he must
 * answer), and when it is the tail of a longer list. Sentences, not lines: a real answer is often one
 * line of several. `streaming`: a last line that is only the start of a field name, a thread's line,
 * its heading or a tag around them is held back, so it never flashes up while it is being written.
 */
export function stripInternalLines(text: string, streaming = false): string {
  if (!text.includes('FOR_USER_') && !text.includes('[v') && !text.includes('th-') && !(streaming && streamingTailMayHold(text))) return text;
  const lines = text.split('\n');
  const bare = (l: string) => l.replace(/\r$/u, '');
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
  const last = out.length - 1;
  // The lines of a tag of Walnut's that names a thread, to its closing tag (one that spans lines).
  const inThreadTag: boolean[] = [];
  let closing: string | null = null;
  for (let i = 0; i < out.length; i++) {
    const line = bare(out[i]);
    if (closing === null && !code[i] && THREAD_TAG_LINE.test(line)) {
      const name = TAG_NAME.exec(line)![1];
      if (!line.includes(`</${name}>`) && !SELF_CLOSING.test(line)) closing = `</${name}>`;
      inThreadTag[i] = true;
    } else if (closing !== null) {
      inThreadTag[i] = true;
      if (line.includes(closing)) closing = null;
    }
  }
  const strict = out.map((l, i) => !code[i] && (inThreadTag[i] === true || isThreadStatusLine(bare(l))));
  const item = out.map((l, i) => !code[i] && THREAD_ITEM.test(bare(l)));
  // While it streams in, the last line as far as it has come (its id, not yet its state).
  let end = last;
  while (end > first && !bare(out[end]).trim()) end--;
  const soFar = streaming && end >= first && !code[end] && threadLineSoFar(bare(out[end]));
  const indent = (i: number) => LEADING_SPACE.exec(bare(out[i]))![0].length;
  const above = (i: number) => { let j = i - 1; while (j >= 0 && !bare(out[j]).trim()) j--; return j; };
  // A list item or an indented line carries a field's value on when nothing but such lines stand
  // between it and the field: a thread's line ends that (what follows one is not a field's value).
  const carriesField = (i: number) => {
    for (let j = above(i); j >= 0; j = above(j)) {
      const l = bare(out[j]);
      if (isField(j)) return true;
      if (strict[j] || item[j] || (code[j] && !INDENTED_CODE.test(l)) || !CONTINUATION.test(l)) return false;
    }
    return false;
  };
  // A line carries a thread's list item on only when it is indented deeper than the item.
  const carriesThread = (i: number, isBlock: (j: number) => boolean) => {
    const own = indent(i);
    if (own === 0) return false;
    for (let j = above(i); j >= 0; j = above(j)) {
      if (indent(j) < own) return isBlock(j) && LIST_ITEM.test(bare(out[j]));
    }
    return false;
  };
  /**
   * The report's start: the earliest line from which, to the end, nothing but the report follows.
   * `threadLines`: which lines count as thread lines (none: the report's fields alone). With thread
   * lines, their heading, a rule above them and a wrapper tag go too.
   */
  const reportStart = (isBlock: (i: number) => boolean) => {
    const withThreads = isBlock !== NONE;
    let start = -1;
    let threads = false;
    let heading = false;
    for (let i = last; i >= first; i--) {
      const line = bare(out[i]);
      if (!line.trim()) continue;
      if (isBlock(i)) { start = i; threads = true; continue; }
      // A heading over thread lines below it is part of the block (the one at its top is added below).
      if (threads && !code[i] && THREAD_HEADING.test(line)) { heading = true; continue; }
      if (WALNUT_TAG_LINE.test(line)) continue;
      if (isField(i)) { start = i; continue; }
      // While it streams in, a thread's line as far as it has come.
      if (withThreads && soFar && i === end) continue;
      // While it streams in, the next field's name as far as it has come ("F", "FOR"): part of the report.
      // So is a tag line of Walnut's as far as it has come ("<walnut-ab", "</"): it stays out until whole.
      if (streaming && i === last && !code[i] && (FIELD_START.test(line) || TAG_SO_FAR.test(line))) continue;
      // A value carried on, indented four spaces deep too (that is not code inside the report).
      if ((!code[i] || INDENTED_CODE.test(line)) && CONTINUATION.test(line) && (carriesField(i) || (withThreads && carriesThread(i, isBlock)))) continue;
      // The session's own words: the report, if any, started after them.
      break;
    }
    if (!withThreads) return { start, threads, heading };
    // While it streams in: a last line that may still become a thread's line, a heading over thread
    // lines that have not come yet, or a tag of Walnut's that may wrap them, stays out until they show
    // what they are. So does the first item under a thread heading while its title comes in before its id.
    const tail = end >= first ? bare(out[end]) : '';
    const up = above(end);
    const underHeading = up >= first && !code[up] && THREAD_HEADING.test(bare(out[up])) && LIST_ITEM.test(tail) && !THREAD_ID.test(tail) && tail.length <= 90;
    if (streaming && start < 0 && end >= first && !code[end] && (soFar || THREAD_HEADING.test(tail) || headingSoFar(tail) || tagComing(tail) || isWrapperOpen(tail) || underHeading)) {
      start = end;
      threads = true;
    }
    if (!threads) return { start, threads, heading };
    let top = false;
    for (let k = above(start); k >= first; k = above(k)) {
      const line = bare(out[k]);
      if (code[k]) break;
      if (isWrapper(line)) { start = k; continue; }
      if (!top && THREAD_HEADING.test(line)) { start = k; top = true; heading = true; continue; }
      if (RULE_LINE.test(line)) start = k;
      break;
    }
    return { start, threads, heading };
  };
  const NONE = () => false;
  const wrappedFrom = (start: number) => out.some((l, i) => i >= start && !code[i] && (inThreadTag[i] === true || isWrapper(bare(l))
    // While it streams in, a tag still coming in may be such a tag.
    || (streaming && i === end && tagComing(bare(l)))));
  // Items whose state is said in free words count only in a block that is plainly one.
  let block = reportStart((i) => strict[i] || item[i]);
  if (block.threads && !block.heading && !wrappedFrom(block.start) && !strict.some((s, i) => s && i >= block.start)) block = reportStart((i) => strict[i]);
  let { start, threads } = block;
  if (threads) {
    const words = out.slice(0, start).map(bare).filter((l) => l.trim() && !WALNUT_TAG_LINE.test(l));
    const wrapped = wrappedFrom(start);
    const lead = words[words.length - 1] ?? '';
    const keptTags = out.slice(start).map(bare).filter((l, j) => WALNUT_TAG_LINE.test(l) && !inThreadTag[start + j] && !isWrapper(l));
    const shown = [...out.slice(0, start), ...keptTags].join('\n');
    // The list is the answer itself: the whole reply, after one sentence outside a made-up tag, or after a lead-in.
    const isTheAnswer = !words.length || (!wrapped && (ENDS_WITH_COLON.test(lead) || LEAD_IN.test(lead) || sentenceCount(words) <= 1));
    // The tail of a longer list: the list stays whole.
    const up = above(start);
    const tailOfList = up >= 0 && !code[up] && LIST_ITEM.test(bare(out[start])) && CONTINUATION.test(bare(out[up]));
    // Proof in it the reply keeps nowhere else, or a line that waits on him.
    const blockLines = out.slice(start).map(bare);
    const keeps = evidenceIn(blockLines).some((e) => !shown.includes(e)) || blockLines.some(asksHim);
    // They stay then, and only the report's field lines after them go.
    if (isTheAnswer || tailOfList || keeps) ({ start, threads } = reportStart(NONE));
  }
  // From the Brief's field on, everything is the Brief, whatever came after it.
  const briefAt = out.findIndex((l, i) => i > first && isField(i) && BRIEF_FIELD.test(bare(l)));
  if (briefAt > first && (start < 0 || briefAt < start)) start = briefAt;
  // Walnut's own self-closing tags after the report stay (the turn marker); a wrapper or a thread's tag
  // goes with the thread lines it holds. While it streams in, a tag still coming in after them waits
  // until it shows whether it is one.
  const keepTag = (l: string, i: number) => WALNUT_TAG_LINE.test(l) && (!threads || (!inThreadTag[i] && !isWrapper(l) && !(streaming && i === end && tagComing(l))));
  let kept = start < 0 ? out : [...out.slice(0, start), ...out.slice(start).filter((l, j) => keepTag(bare(l), start + j))];
  if (streaming && kept.length > 1 && FIELD_START.test(bare(kept[kept.length - 1])) && kept[kept.length - 1].trim().length >= 4) kept = kept.slice(0, -1);
  const joined = kept.join('\n');
  return joined === text ? text : joined.replace(TRAILING_SPACE, '');
}

/** A line as two texts are compared: its trailing white space (and a `\r`) does not count. */
const lineKey = (l: string) => l.replace(/\s+$/, '');
/** Past this many cells the middle is compared by set, not by the exact walk (a long rewrite). */
const DIFF_CELLS_MAX = 200_000;

/**
 * The lines of `raw` that `shown` leaves out, in their order, as one text: what Walnut hid from a
 * reply (its status lines, a turn-end marker, a tasks line), for a developer who asked to see them
 * folded under the reply (Settings > Advanced, `ui.show_hidden_lines`). Any hiding works, since it
 * only compares the two texts: a line is hidden when no line of `shown` stands for it in the
 * longest run they share. A line whose start alone was cut (a `[Q4]:` tag before the words, an old
 * version tag) gives only that start, never the words again. Blank lines at either end are dropped;
 * '' when nothing is hidden.
 */
export function hiddenLinesOf(raw: string, shown: string): string {
  if (raw === shown) return '';
  const a = raw.split('\n').map(lineKey);
  const b = shown ? shown.split('\n').map(lineKey) : [];
  // The common head and tail first: Walnut hides lines at the end, so the walk is usually empty.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  let out: string[];
  if (midB.length === 0) out = midA;
  else if (midA.length * midB.length > DIFF_CELLS_MAX) {
    const kept = new Set(midB);
    out = midA.filter((l) => !kept.has(l));
  } else {
    // The longest common run of lines (classic table, from the end), then one walk from the start.
    // A shown line stands for a raw line that ends with it: the hiding cut only its start.
    const stands = (r: string, sh: string) => r === sh || (!!sh.trim() && r.endsWith(sh));
    const n = midA.length, m = midB.length, w = m + 1;
    const len = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        len[i * w + j] = stands(midA[i], midB[j]) ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
      }
    }
    out = [];
    let i = 0, j = 0;
    while (i < n) {
      if (j < m && stands(midA[i], midB[j])) {
        const cut = midA[i].slice(0, midA[i].length - midB[j].length).trim();
        if (cut) out.push(cut);
        i++; j++;
      } else if (j < m && len[i * w + j + 1] >= len[(i + 1) * w + j]) j++;
      else out.push(midA[i++]);
    }
  }
  let s = 0, e = out.length;
  while (s < e && !out[s].trim()) s++;
  while (e > s && !out[e - 1].trim()) e--;
  return out.slice(s, e).join('\n');
}

/**
 * A stored reply as a person reads it (stripInternalLines), with what was taken out of it beside
 * the text (`hidden`, absent when nothing was): every parse that hides Walnut's lines from a chat row
 * calls this, so a developer's chat can show them folded (tests/lib/hidden-lines.test.ts).
 */
export function splitInternalLines(text: string): { text: string; hidden?: string } {
  const shown = stripInternalLines(text);
  if (shown === text) return { text };
  const hidden = hiddenLinesOf(text, shown);
  return hidden ? { text: shown, hidden } : { text: shown };
}
