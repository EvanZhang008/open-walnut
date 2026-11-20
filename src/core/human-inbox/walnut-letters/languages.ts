/**
 * The languages Walnut writes its OWN letters in (2026-11-02, the user's org review: "every letter
 * Walnut writes itself must be in Chinese", e.g. an "SSH sign-in to <host> failed";
 * his lead: in the user's reply language, not hard-coded Chinese, this is a public product).
 *
 * A letter is for the user, so it follows the language he asked to be answered in: the first language
 * his reply-language rule names (config `session.reply_language`, as replyLanguageText reads it), else
 * his display language (`config.agent.language`), else English. A language with no text here falls
 * back to English.
 *
 * To add a language: add its code to LETTER_LANGUAGES. Every kind's text table is a
 * `ByLang<...>`, so the compiler then names each template still missing its text, and the ratchet
 * (tests/core/walnut-letters-ratchet.test.ts) renders every kind in it.
 */
import { replyLanguageText } from '../../sessions/output-mode.js';
import { normalizeLang } from '../../ui-language.js';
import type { Config } from '../../types.js';

/** The script a language is written in. */
export type Script = 'han' | 'kana' | 'hangul' | 'latin' | 'cyrillic';

/** The language names a reply-language sentence may hold, with their script and letter-language code. */
const NAMED: ReadonlyArray<[RegExp, Script, string | null]> = [
  [/\b(chinese|mandarin|cantonese)\b|\u4e2d\u6587|\u6c49\u8bed|\u6f22\u8a9e|\u666e\u901a\u8bdd/i, 'han', 'zh'],
  [/\bjapanese\b|\u65e5\u672c\u8a9e/i, 'kana', 'ja'],
  [/\bkorean\b|\ud55c\uad6d\uc5b4/i, 'hangul', 'ko'],
  [/\brussian\b|\u0440\u0443\u0441\u0441\u043a/i, 'cyrillic', 'ru'],
  [/\b(english|french|german|spanish|portuguese|italian|dutch)\b/i, 'latin', null],
];

function firstNamed(rule: string): { script: Script; lang: string | null } | null {
  let best: { at: number; script: Script; lang: string | null } | null = null;
  for (const [re, script, lang] of NAMED) {
    const m = re.exec(rule);
    if (m && (!best || m.index < best.at)) best = { at: m.index, script, lang };
  }
  return best;
}

/**
 * The script the user's reply-language sentence asks for: the first language it names (the rest is
 * usually "code stays English"); null when it names none.
 */
export function expectedScript(rule: string): Script | null {
  return firstNamed(rule)?.script ?? null;
}

/** The language the rule asks for, by its code (null: a Latin-script one, or none). */
export function ruleLanguage(rule: string): string | null {
  return firstNamed(rule)?.lang ?? null;
}

export const LETTER_LANGUAGES = ['en', 'zh'] as const;
export type LetterLang = (typeof LETTER_LANGUAGES)[number];

/** One value per letter language: a kind's text table. */
export type ByLang<T> = Readonly<Record<LetterLang, T>>;

export function isLetterLang(code: unknown): code is LetterLang {
  return typeof code === 'string' && (LETTER_LANGUAGES as readonly string[]).includes(code);
}

/**
 * The language of Walnut's letters for this config. Pure. A reply-language rule that names a
 * language decides (one Walnut has no text for, French say, gets English); only a rule naming none,
 * or no rule, leaves it to the display language.
 */
export function letterLanguageOf(config: Pick<Config, 'session' | 'agent'> | null | undefined): LetterLang {
  const rule = replyLanguageText(config ?? null);
  if (rule && expectedScript(rule)) {
    const lang = ruleLanguage(rule);
    return isLetterLang(lang) ? lang : 'en';
  }
  const ui = normalizeLang(config?.agent?.language);
  return isLetterLang(ui) ? ui : 'en';
}

/** The language for a letter sent now, read fresh from config; English when the read fails. */
export async function walnutLetterLanguage(): Promise<LetterLang> {
  try {
    const { getConfig } = await import('../../config-manager.js');
    return letterLanguageOf(await getConfig());
  } catch {
    return 'en';
  }
}
