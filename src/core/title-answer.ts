/**
 * The one rule a title a MODEL wrote must pass before Walnut writes it onto a task, a session,
 * a conversation question, a side thread, a chat conversation or a fork group.
 *
 * The person's own words name a task first (quick-start.ts); a model may only refine that, and
 * only with a title. 2026-11-11 review: before sign-in the real Claude Code answered the title
 * question with "Not logged in · Please run /login", and that became the task's title for good;
 * with a mock model every task and Ask thread was renamed to its first reply ("Hello! I processed
 * your message: ..."). So an answer is refused, and the current title kept, when it is:
 *   - Claude Code's own error text (isCliErrorText),
 *   - reply prose: an assistant's first words ("Hello!", "Sure,", "I'll ..."), unless the
 *     person's words start that way too ("Hello world app"),
 *   - the title question echoed back, a refusal, the `Session: …` placeholder shape,
 *   - text sharing no content with the words it names (`words`): a title is read off those
 *     words, so one with none of them came from somewhere else. A title in another script
 *     (a translation the task system asked for) is not compared.
 *
 * tests/core/title-answer-paths-guard.test.ts lists every source file that writes a model's
 * title and fails on one that does not call this rule.
 */

import { isCliErrorText } from './sessions/cli-error-reply.js';

export interface TitleSource {
  /** The words the title names (the person's message, a question). Absent: no overlap check. */
  words?: string;
}

/** Refusals and meta-prose: writing "I cannot determine..." as a title is worse than none. */
const REFUSAL_RE = /^(i can(?:no|')t|i cannot|i'm sorry|i am sorry|sorry[,!]|as an ai|i(?:'| a)m unable|there (?:is|was) no)/i;

/** How a reply opens, never a title, whatever the person wrote. */
const REPLY_OPENING_RE = /^(?:here(?:'s| is| are)|let me|of course|got it|no problem|certainly|absolutely|i(?:'ll| will|'ve| have|'m| am|'d| would)?)(?=[\s,!.:;—]|$)/i;

/** Greeting and acknowledgement words: a reply's when followed by "!" or ",", or absent from the person's words ("Hello world app" is a title). */
const REPLY_WORD_RE = /^(hello|hi|hey|greetings|sure|okay|ok|great|thanks|thank you)(?=([\s,!.:;—]|$))/i;

/** The title question (session-title-backend.ts buildTitleQuestion) or a caller's prompt, echoed back. */
const QUESTION_ECHO_RE = /generate a title|user'?s first message|current placeholder title|reply with only|^(?:passage|question|prompt|conversation|task titles)\s*:/i;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'what', 'that', 'this', 'from', 'into', 'about', 'please', 'can',
  'could', 'would', 'should', 'you', 'your', 'are', 'was', 'were', 'has', 'have', 'had', 'its',
  'our', 'out', 'how', 'why', 'when', 'where', 'who', 'which', 'there', 'their', 'them', 'then',
  'than', 'but', 'not', 'all', 'any', 'some', 'just', 'also', 'like', 'want', 'need', 'make', 'let',
]);

/** Scripts written without spaces: compared by character pairs, not words. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

interface Tokens { spaced: string[]; unspaced: Set<string> }

function tokensOf(text: string): Tokens {
  const spaced: string[] = [];
  const unspaced = new Set<string>();
  for (const run of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (UNSPACED.test(run)) {
      const chars = [...run].filter((c) => UNSPACED.test(c));
      for (let i = 0; i + 1 < chars.length; i++) unspaced.add(chars[i] + chars[i + 1]);
      if (chars.length === 1) unspaced.add(chars[0]);
    } else if ((run.length >= 3 || /\d/.test(run)) && !STOP_WORDS.has(run)) {
      spaced.push(run);
    }
  }
  return { spaced, unspaced };
}

/** Two words are one when equal, or when they share a stem of 4+ letters ("summarize" / "summary"). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n >= 4;
}

/**
 * Whether `title` carries content from `words`. Compared only within a kind both have (spaced
 * words, unspaced characters), so a translation into another script is never refused; words with
 * nothing to compare (a greeting, an emoji) refuse nothing.
 */
export function sharesUserContent(title: string, words: string): boolean {
  const t = tokensOf(title);
  const w = tokensOf(words);
  const spacedKind = t.spaced.length > 0 && w.spaced.length > 0;
  const unspacedKind = t.unspaced.size > 0 && w.unspaced.size > 0;
  if (!spacedKind && !unspacedKind) return true;
  if (spacedKind && t.spaced.some((a) => w.spaced.some((b) => sameWord(a, b)))) return true;
  if (unspacedKind && [...t.unspaced].some((p) => w.unspaced.has(p))) return true;
  return false;
}

/** Why a cleaned candidate is no title, or null when it is one. */
export function titleRefusal(candidate: string, source: TitleSource = {}): string | null {
  const text = candidate.trim();
  if (text.length < 2) return 'empty';
  if (isCliErrorText(text)) return 'cli_error';
  if (REFUSAL_RE.test(text)) return 'refusal';
  if (/^session:\s/i.test(text)) return 'placeholder';
  if (QUESTION_ECHO_RE.test(text)) return 'question_echo';
  const words = source.words?.trim() ?? '';
  if (REPLY_OPENING_RE.test(text)) return 'reply_prose';
  // An exclamation with more after it is a reply talking ("Hi there! How can I help?"), never a title.
  if (/!\s+\S/.test(text)) return 'reply_prose';
  const greeting = REPLY_WORD_RE.exec(text);
  if (greeting && (/^[,!]/.test(text.slice(greeting[1].length))
    || !new RegExp(`(^|[^\\p{L}])${greeting[1]}($|[^\\p{L}])`, 'iu').test(words))) return 'reply_prose';
  if (words && !sharesUserContent(text, words)) return 'no_user_content';
  return null;
}

/** `candidate` when it passes the rule, else null (the caller keeps the title it has). */
export function screenTitle(candidate: string | null | undefined, source: TitleSource = {}): string | null {
  if (!candidate) return null;
  return titleRefusal(candidate, source) ? null : candidate;
}

/**
 * A model's title answer, cleaned and screened: the first non-empty line, quote, markdown and
 * label wrappers off, whitespace collapsed, capped at 200. Null for anything that is no title.
 */
export function cleanTitleAnswer(answer: string, source: TitleSource = {}): string | null {
  const firstLine = answer.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const cleaned = firstLine
    // Wrappers come off FIRST: a model that answers `**Title: X**` hides the label
    // behind the bold markers, so a label-first pass leaves "Title:" in the title.
    .replace(/^[#>*`_\s]+|[*`_\s]+$/g, '')   // markdown heading/bold/code wrappers
    .replace(/^["'“”]+|["'“”]+$/g, '')       // quote wrappers
    .replace(/^(?:title\s*:\s*)/i, '')      // "Title: ..." label echo
    .replace(/\s+/g, ' ')
    .trim();
  return screenTitle(cleaned, source)?.slice(0, 200) ?? null;
}
