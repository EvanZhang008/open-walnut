/**
 * The lines the web composer puts in front of a person's words when a message is
 * sent from a Tree Mode page or an Ask here question, in ONE place: the composer
 * writes them with these builders (web/src/utils/thread-tree.ts), and every reader
 * splits them off with `splitComposedFraming`: the chat bubble (SessionMessage,
 * which folds them behind "Walnut added"), the phone's transcript (`added` and
 * `textWithoutContext`, src/lib/walnut-added.ts), the title readers (own-words.ts)
 * and the question card (thread-card.ts).
 *
 * The framing, in the order it can come:
 *  - a reply-tag banner `[Question Q4]` ... `[/Question Q4]` (older sends);
 *  - an orientation line, for a model that reads ONE linear context: where this
 *    message goes back to. `(Back to the main conversation)`, or
 *    `(Back to the earlier question thread="6" about “title”)`; the `thread="6"`
 *    is the question's id, the same one its `question` hint names in
 *    `<walnut-ask thread="6" name="…">` (src/core/sessions/ask-thread.ts), so the
 *    line and the tag the answer must sit in agree. Sends from before 2026-11-16
 *    carry the line without the id;
 *  - a file question's ``About `<path>:<line>`:`` line;
 *  - the quoted passage (`> ...` lines).
 * 2026-11-16, the user: "why in tree mode it shows back to xx ... this should be
 * hidden (collapse by default, can open to see)".
 *
 * Pure (its one import is import-free too): the server, the web and the tests read
 * the same rules.
 */
import { splitAttachmentHeaders } from './attachment-headers.js';

export const BACK_TO_MAIN_LINE = '(Back to the main conversation)';

/** A thread id: 6, 6.1, 6.1.2 (ASK_THREAD_RE in src/core/sessions/ask-thread.ts). */
const THREAD_ID_RE = /^\d{1,5}(?:\.\d{1,5}){0,5}$/;

function threadPart(thread: string | undefined): string {
  return thread && THREAD_ID_RE.test(thread) ? ` thread="${thread}"` : '';
}

/** A title inside the line's curly quotes, on one line, without a closing quote of its own. */
function titlePart(title: string): string {
  return title.replace(/\s+/g, ' ').replace(/”/g, '"').trim();
}

/** The line a follow-up from a question page opens with when the newest turn is elsewhere. */
export function backToQuestionLine(title: string, thread?: string): string {
  return `(Back to the earlier question${threadPart(thread)} about “${titlePart(title)}”)`;
}

/** The older anchored form (an anchor that is not a fresh selection). */
export function backToThreadLine(label: string, thread?: string): string {
  return `(Back to the earlier thread${threadPart(thread)} about “${titlePart(label)}”)`;
}

/** A file question's line ahead of its quote. */
export function fileAboutLine(location: string): string {
  return `About \`${location}\`:`;
}

const QUESTION_BANNER_OPEN_RE = /^\[Question Q\d{1,5}\]\s*$/;
const QUESTION_BANNER_CLOSE_RE = /^\[\/Question Q\d{1,5}\]\s*$/;
export const ORIENTATION_LINE_RE =
  /^\(Back to (?:the main conversation|the earlier (?:question|thread)(?: thread="(\d{1,5}(?:\.\d{1,5}){0,5})")? about “.*”)\)\s*$/;
export const FILE_ABOUT_LINE_RE = /^About `[^`\n]+`:\s*$/;

export interface ComposedFraming {
  /** The composer's lines, as sent (blank lines between them kept). */
  framing: string;
  /** The person's own words after them. */
  words: string;
  /** Which lines it holds, for its one-line label (`framingLabel`). */
  orientation: boolean;
  aboutFile: boolean;
  quote: boolean;
  /** The question id the orientation line names (`thread="6"`), when it names one. */
  thread?: string;
  /** The line says the message goes back to the main conversation. */
  toMain?: boolean;
}

/**
 * The composer's framing split from the words, or null when the text opens with
 * none. The pictures and files a send carries ride in front of the composed text
 * (`[Images attached …]`, attachment-headers.ts): they stay at the head of `words`,
 * and the framing after them comes off. A leading quote counts as framing after a
 * file's About line or the older "thread" line, the two places the composer
 * quotes. Anywhere else it is the person's own as often as the composer's (a
 * passage comment quotes its passages the same way, and a question page's head
 * row already hides its quote), so it stays in the words unless `quoteAlone` (a
 * reader that names the message: its title, a card's question) asks for it, and
 * then only when words follow it.
 */
export function splitComposedFraming(text: string, opts: { quoteAlone?: boolean } = {}): ComposedFraming | null {
  const lead = splitAttachmentHeaders(text);
  if (lead.text === text) return splitFraming(text, opts);
  const split = splitFraming(lead.text, opts);
  return split ? { ...split, words: `${text.slice(0, text.length - lead.text.length)}${split.words}`.trim() } : null;
}

function splitFraming(text: string, opts: { quoteAlone?: boolean }): ComposedFraming | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const skipBlank = () => { while (i < lines.length && !lines[i].trim()) i++; };
  skipBlank();
  const first = i;
  if (i < lines.length && QUESTION_BANNER_OPEN_RE.test(lines[i])) {
    const close = lines.findIndex((l, k) => k > i && QUESTION_BANNER_CLOSE_RE.test(l));
    if (close > i) { i = close + 1; skipBlank(); }
  }
  let thread: string | undefined;
  let toMain = false;
  let threadLine = false;
  const orientation = i < lines.length ? ORIENTATION_LINE_RE.exec(lines[i]) : null;
  if (orientation) {
    thread = orientation[1];
    toMain = lines[i].trim() === BACK_TO_MAIN_LINE;
    threadLine = lines[i].startsWith('(Back to the earlier thread');
    i++;
    skipBlank();
  }
  const aboutFile = i < lines.length && FILE_ABOUT_LINE_RE.test(lines[i]);
  if (aboutFile) { i++; skipBlank(); }
  let k = i;
  while (k < lines.length && lines[k].startsWith('>')) k++;
  const after = lines.slice(k).join('\n').trim();
  // The composer quotes after a file's About line and after the older "thread" line only;
  // after the main or a question line, a quote is the person's own (a passage comment).
  const quotedAfter = aboutFile || threadLine;
  const quote = k > i && (quotedAfter || (!!opts.quoteAlone && !!after));
  if (quote) { i = k; skipBlank(); }
  if (i === first) return null;
  const words = lines.slice(i).join('\n').trim();
  return {
    framing: lines.slice(first, i).join('\n').trim(),
    words,
    orientation: !!orientation,
    aboutFile,
    quote,
    ...(thread ? { thread } : {}),
    ...(toMain ? { toMain } : {}),
  };
}

/** The words without the composer's framing (a lone leading quote too), for a reader that names the
 *  message; the text itself when it has none or nothing follows it. */
export function withoutComposedFraming(text: string): string {
  const split = splitComposedFraming(text, { quoteAlone: true });
  return split?.words || text.trim();
}

/** The framing's one-line label, closed above the words (the chat's marker, the phone's "Walnut added" row). */
export function framingLabel(f: ComposedFraming): string {
  if (f.toMain) return 'Sent to the main conversation';
  if (f.thread) return `Sent to question ${f.thread}`;
  if (f.orientation) return 'Sent to an earlier question';
  if (f.aboutFile) return 'About a passage of a file';
  if (f.quote) return 'About a quoted passage';
  return 'Sent with context';
}
