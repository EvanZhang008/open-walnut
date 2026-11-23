/**
 * The one judge of whether a text is in the language the user's Reply language setting names
 * (config `session.reply_language`). Pure, no model call.
 *
 * Who may use it (tests/core/hints/no-reply-language-reminder.test.ts pins the list):
 *  - the send gate (src/ops/reply-language-gate.ts): a session's words the user reads (a message to
 *    another task, a thread, a letter, the Board, the Brief, a report, an AskUserQuestion prompt) in
 *    another language are not sent, and the session is told to write them again. 2026-11-23, Main for
 *    the user: a reply to him with no Chinese in it must not go out, held by the product rather than
 *    by each session remembering; option A: only what a session sends, never its chat reply.
 *  - the daily reflection's wrong_language finding (core/org/reflection/language.ts).
 * Never a reminder or a note beside a send that went out, and never a correction in the chat: the
 * user removed those on 2026-11-20 ("remove this remidner, we don't need").
 *
 * Code, commands, paths, URLs, identifiers, acronyms and quoted words are taken out first: they stay
 * as they are in any language by the user's own rule, and a quote keeps the words it quotes.
 */

/** The script a language is written in. */
export type Script = 'han' | 'kana' | 'hangul' | 'latin' | 'cyrillic'

/** The language names a reply-language sentence may hold, with their script and letter-language code. */
const NAMED: ReadonlyArray<[RegExp, Script, string | null]> = [
  [/\b(chinese|mandarin|cantonese)\b|\u4e2d\u6587|\u6c49\u8bed|\u6f22\u8a9e|\u666e\u901a\u8bdd/i, 'han', 'zh'],
  [/\bjapanese\b|\u65e5\u672c\u8a9e/i, 'kana', 'ja'],
  [/\bkorean\b|\ud55c\uad6d\uc5b4/i, 'hangul', 'ko'],
  [/\brussian\b|\u0440\u0443\u0441\u0441\u043a/i, 'cyrillic', 'ru'],
  [/\b(english|french|german|spanish|portuguese|italian|dutch)\b/i, 'latin', null],
]

function firstNamed(rule: string): { script: Script; lang: string | null } | null {
  let best: { at: number; script: Script; lang: string | null } | null = null
  for (const [re, script, lang] of NAMED) {
    const m = re.exec(rule)
    if (m && (!best || m.index < best.at)) best = { at: m.index, script, lang }
  }
  return best
}

/**
 * The script the user's reply-language sentence asks for: the first language it names (the rest is
 * usually "code stays English"); null when it names none.
 */
export function expectedScript(rule: string): Script | null {
  return firstNamed(rule)?.script ?? null
}

/** The language the rule asks for, by its code (null: a Latin-script one, or none). */
export function ruleLanguage(rule: string): string | null {
  return firstNamed(rule)?.lang ?? null
}

/**
 * Asks the replies themselves in English ("reply in English", "talk to me in English"; in Chinese,
 * a reply or talk-to-me verb right beside yong ying wen / ying yu); "code and commits in English",
 * in either language, asks nothing of the replies.
 */
export const ENGLISH_REPLY_RE = /\b(?:reply|replies|talk|answer|respond|speak)\w*(?:\s+to\s+(?:me|the user|him|her|them))?\s+in\s+english|(?:\u56de\u590d|\u56de\u7b54|\u8ddf\u6211\u8bf4|\u548c\u6211\u8bf4|\u5bf9\u6211\u8bf4)\S{0,4}\u7528\u82f1(?:\u6587|\u8bed)|\u7528\u82f1(?:\u6587|\u8bed)(?:\u56de\u590d|\u56de\u7b54|\u8ddf\u6211\u8bf4|\u548c\u6211\u8bf4|\u5bf9\u6211\u8bf4)/i

/**
 * The script the send gate holds a session's words to, or null (no gate): the rule's first named
 * language, unless that is not English and the rule also asks for replies in English ("Chinese to
 * me, English to reviewers"): two languages for replies is a rule only a reader can apply.
 */
export function gateScript(rule: string | null | undefined): Script | null {
  if (!rule?.trim()) return null
  const want = expectedScript(rule)
  if (!want) return null
  if (want !== 'latin' && ENGLISH_REPLY_RE.test(rule)) return null
  return want
}

/**
 * The prose of a text: fenced, indented and inline code, quoted lines and quoted spans, list lines
 * that only name tasks, URLs, paths and identifiers taken out. HTML: `blocks: 'drop'` takes whole
 * widget blocks out (the reflection's reading of a chat answer); `'text'` keeps the words inside the
 * tags and drops only code, scripts, styles and pictures (a letter or a Board page is HTML through
 * and through).
 */
export function proseOf(text: string, opts: { blocks?: 'drop' | 'text' } = {}): string {
  let t = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
  t = opts.blocks === 'text'
    ? t.replace(/<(svg|style|script|pre|code|textarea|blockquote|q)\b[\s\S]*?<\/\1>/gi, ' ')
    : t.replace(/<(svg|table|style|script|pre|div|details)\b[\s\S]*?<\/\1>/gi, ' ')
  return t
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    // Indented code, quoted lines (his own words, a log), list lines that only name tasks.
    .replace(/^(?: {4}|\t).*$/gm, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+.*(?:\]\([^)]*\)|\btask:|\btasks\/).*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    // Paths: anything with a slash in it, or a file name with an extension.
    .replace(/(?:^|\s|\()(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]*)+/g, ' ')
    .replace(/\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yaml|yml|py|sh|swift|go|rs|java|txt|log|html|css|sql|toml)\b/gi, ' ')
    // Identifiers: snake_case, camelCase, dotted names, words with digits, ids.
    .replace(/\b\w*_\w*\b/g, ' ')
    .replace(/\b[a-z]+[A-Z]\w*\b/g, ' ')
    .replace(/\b\w+(?:\.\w+)+\b/g, ' ')
    .replace(/\b(?=\w*\d)\w+\b/g, ' ')
}

/** Quoted spans (someone's own words, a title, a label) keep the language they were said in. */
function unquoted(prose: string): string {
  return prose.replace(/"[^"\n]{1,400}"|\u201c[^\u201d]{1,400}\u201d|\u300c[^\u300d]{1,400}\u300d|\u300e[^\u300f]{1,400}\u300f/g, ' ')
}

export interface ScriptMeasure {
  /** Words of prose: each Han, kana or Hangul character counts one, and so does each Latin or Cyrillic word. */
  words: number
  /** How many of them are in the script asked for. */
  inScript: number
  share: number
}

const scriptWords: Record<Script, RegExp> = {
  han: /\p{Script=Han}/gu,
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu,
  hangul: /\p{Script=Hangul}/gu,
  latin: /\p{Script=Latin}+/gu,
  cyrillic: /\p{Script=Cyrillic}+/gu,
}

/**
 * The share of a text's prose in `script`, by words. A Chinese character is about a word, so
 * counting Latin words (not letters) beside it keeps a Chinese reply that names many English terms
 * ("PR description and commit message are fixed") on the Chinese side. Acronyms (PR, CR, API) are
 * terms, not prose, and are left out.
 */
export function measureScript(text: string, script: Script): ScriptMeasure {
  const prose = unquoted(proseOf(text, { blocks: 'text' })).replace(/\b[A-Z]{2,6}s?\b/g, ' ')
  const count = (re: RegExp) => (prose.match(re) ?? []).length
  const cjk = count(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
  const words = cjk + count(scriptWords.latin) + count(scriptWords.cyrillic)
  const inScript = count(scriptWords[script])
  return { words, inScript, share: words ? inScript / words : 0 }
}

/** Fewer words of prose than this are never judged: "Done.", an id, a path, a one-word label. */
export const GATE_MIN_WORDS = 5
/**
 * Under this share of the asked script, the words read in another language. Measured on the user's
 * November letters and messages from sessions: every Chinese one was at 0.25 or more (one asking
 * approval of an English mail, at 0.26), every English one under 0.11; "Conclusion below." in
 * Chinese ahead of an English paragraph is 0.16, and is held.
 */
export const GATE_MIN_SHARE = 0.2

/** The measure when the text reads in another language than `script`, else null. */
export function readsOffScript(text: string, script: Script): ScriptMeasure | null {
  if (!text) return null
  const m = measureScript(text, script)
  return m.words >= GATE_MIN_WORDS && m.share < GATE_MIN_SHARE ? m : null
}

/** The tail every refusal ends with: what to write again and what may stay as it is. */
export const GATE_REWRITE =
  'Only code, commands, paths, identifiers and quoted words stay as they are: text meant for someone else '
  + '(a draft, an email, a pull request or review description, a reply for a colleague) goes in a code block or '
  + 'a "> " quote, with the lines for the user around it in his language.'

/** The words a refused send answers with: `what` names it ("Your message (task_send)"). */
export function gateRefusal(what: string, rule: string, m: ScriptMeasure, again: string): string {
  return `${what} was not sent: the user reads it, and his Reply language setting says "${rule}", but only `
    + `${m.inScript} of its ${m.words} words are in that language. ${again} ${GATE_REWRITE}`
}
