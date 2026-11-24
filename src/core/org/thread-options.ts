/**
 * A thread that waits on him to pick among choices carries them as options he clicks (2026-11-20,
 * the user, on a VP's thread whose summary listed A (recommended) and B while its card offered only
 * Acknowledge: "why not give me some options ... if you recommend this, why can I not just click
 * it?", and "it has to be unified ... it can always give an option, if needed. Acknowledge is for
 * when I do not need to make any choice").
 *
 * `options` on a thread (OrgThread.options) are read by the one reader of a choice's options
 * (ask-options.ts, the report's ask_options too): 2 to ASK_OPTIONS_MAX, kept only while the thread
 * is in needs. A needs write by an agent whose summary asks him to choose (a word of choosing) among
 * lettered or numbered choices ("A:", "B:", "1.", "2.", or the full-width colon forms) with no
 * options is refused (listsChoices), so a
 * choice never reaches him as text he can only acknowledge. Pure; threads-model.ts turns the
 * errors into ThreadError.
 */
import type { AskOption } from '../user-status.js';
import { AskOptionsError, checkChoiceCount, readAskOptions } from '../ask-options.js';

/** A thread's options from a write: none for absent or [], else 2 to ASK_OPTIONS_MAX. Throws AskOptionsError. */
export function threadOptionsOf(raw: unknown): AskOption[] {
  const list = readAskOptions(raw, 'options');
  if (list.length) checkChoiceCount(list, 'options');
  return list;
}

/** A letter choice: "A:", "A" and a full-width colon, "(A):", "**A**:", "Option A (recommended):". */
const LETTER = /(?:^|[\s(\uff08*"'`])([A-F])(?:\*\*)?(?:\s*[(\uff08][^)\uff09\n]{0,40}[)\uff09])?\s*(?:\*\*)?\s*[:\uff1a]/gm;
/** A numbered choice at a line's start: "1.", "1)", "1:", or a full-width colon, after a bullet or bold mark. */
const NUMBER = /^[^\S\n]*(?:[-*][^\S\n]+)?(?:\*\*)?([1-9])(?:\*\*)?[.):\uff1a][^\S\n]+\S/gm;

/** A word of choosing: a list without one is a status list ("1. Built 2. Tested"), not a choice. */
const CHOOSING = /\b(?:pick|choose|chose|option|options|recommend|recommended|recommends|prefer|either|which (?:one|do you|would you|should))\b/i;
/** The same in Chinese, as whole phrases ("pick one", "which one", "recommend", "A or B?"): a single character of choosing is part of other words (review 2026-11-24: "the fix plan: 1. ... 2. ..."). */
const CHOOSING_CJK = /\u9009\u4e00\u4e2a|\u9009\u54ea|\u6311\u4e00\u4e2a|\u6311\u54ea|\u63a8\u8350|\u54ea\u4e2a|\u54ea\u4e00\u4e2a|\u8fd8\u662f[^\u3002\n]*[\uff1f?]/;

/**
 * Whether `text` lists choices: a word of choosing, and two lettered ones A and B (a third and more
 * after them) or two numbered ones 1 and 2 at line starts. Pure.
 */
export function listsChoices(text: string | null | undefined): boolean {
  if (!text?.trim() || !(CHOOSING.test(text) || CHOOSING_CJK.test(text))) return false;
  const letters = new Set([...text.matchAll(LETTER)].map((m) => m[1]));
  if (letters.has('A') && letters.has('B')) return true;
  const numbers = new Set([...text.matchAll(NUMBER)].map((m) => m[1]));
  return numbers.has('1') && numbers.has('2');
}

/** The refusal's words: what to pass instead. */
export const NEEDS_OPTIONS_MESSAGE = 'This thread asks him to pick among choices (A: ..., B: ... or 1. ..., 2. ...) with no options: '
  + 'pass them as options [{ "label": "...", "detail": "...", "recommended": true }, ...], 2 to 5, the recommended one first, so he answers with one click.';

/** The needs write lists choices in `words` and carries no options: refuse it. Throws AskOptionsError. */
export function checkNeedsOptions(words: readonly (string | undefined)[], options: readonly AskOption[] | undefined): void {
  if (options?.length) return;
  if (listsChoices(words.filter(Boolean).join('\n'))) throw new AskOptionsError(NEEDS_OPTIONS_MESSAGE);
}

export { AskOptionsError };
