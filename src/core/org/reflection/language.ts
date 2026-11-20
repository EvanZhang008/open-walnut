/**
 * The wrong_language check of the reflection (2026-11-20, the user: he asks for Chinese in his
 * reply-language setting and an agent answered him in English). Deterministic, no model call:
 * an answer he saw with at least LANGUAGE_MIN_LETTERS letters of prose whose Chinese share is under
 * LANGUAGE_MIN_CJK_SHARE is a finding. Code, commands, paths, URLs and identifiers are taken out
 * first: they stay English in a Chinese answer by the user's own rule. Pure.
 */

export const LANGUAGE_MIN_LETTERS = 200;
export const LANGUAGE_MIN_CJK_SHARE = 0.1;

/** The guidance line every wrong_language finding writes (deduped like any other line). */
export const LANGUAGE_GUIDANCE = 'Answer the user in the language his reply-language setting names; only code, commands, paths and identifiers stay as they are.';

// "in", "reply", "talk", "answer" or yong (use) right before the language's name.
const ASKS_IN = '(?:\\bin|\\breply|\\btalk|\\banswer|\\brespond|\\u7528)\\s*(?:simplified\\s+)?';
// zhong wen, han yu, pu tong hua
const CHINESE_RE = new RegExp(`${ASKS_IN}(?:chinese|mandarin|\\u4e2d\\u6587|\\u6c49\\u8bed|\\u666e\\u901a\\u8bdd)`, 'i');
// Asks the replies themselves in English ("reply in English", "talk to me in English", yong ying wen /
// ying yu); "code and commits in English" asks nothing of the replies.
const ENGLISH_RE = /\b(?:reply|replies|talk|answer|respond|speak)\w*(?:\s+to\s+(?:me|the user|him))?\s+in\s+english|\u7528\u82f1(?:\u6587|\u8bed)/i;

/**
 * A reply-language setting that asks to answer him in Chinese ("talk to the user in Chinese",
 * "reply in Chinese", yong zhong wen) and never asks for English: unset, another language, or one
 * that asks for both turns the check off. "code stays English" asks nothing of the replies.
 */
export function wantsChinese(replyLanguage: string | null | undefined): boolean {
  if (!replyLanguage) return false;
  return CHINESE_RE.test(replyLanguage) && !ENGLISH_RE.test(replyLanguage);
}

/** His message asks for English text (a draft, an email, a pull request or review description): its answer is exempt. */
const ENGLISH_ASK_RE = /english|\bdraft|\bemail|\be-mail|\bPR\b|\bCR\b|description|\u82f1\u6587|\u82f1\u8bed/i;
export function asksForEnglish(text: string): boolean { return ENGLISH_ASK_RE.test(text); }

/**
 * The prose of an answer: fenced, indented and inline code, HTML, quoted lines, lists of task
 * references, URLs, paths and identifiers taken out.
 */
export function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    // HTML: a whole block (a widget, a table, an svg), then any tag left.
    .replace(/<(svg|table|style|script|pre|div|details)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>\n]+>/g, ' ')
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
    .replace(/\b(?=\w*\d)\w+\b/g, ' ');
}

export interface LanguageMeasure { letters: number; cjk: number; share: number }

/** Letters of the prose and how many of them are Chinese characters. */
export function measureLanguage(text: string): LanguageMeasure {
  const prose = proseOf(text);
  const letters = (prose.match(/\p{L}/gu) ?? []).length;
  const cjk = (prose.match(/\p{Script=Han}/gu) ?? []).length;
  return { letters, cjk, share: letters ? cjk / letters : 0 };
}

/** An answer that reads in another language than the Chinese the user asked for. */
export function readsNotChinese(text: string): LanguageMeasure | null {
  const m = measureLanguage(text);
  return m.letters >= LANGUAGE_MIN_LETTERS && m.share < LANGUAGE_MIN_CJK_SHARE ? m : null;
}
