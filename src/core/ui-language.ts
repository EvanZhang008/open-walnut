/**
 * The user's display language for AI-written UI text (`config.agent.language`).
 *
 * One home for the two helpers every prompt that speaks TO the user needs: the
 * diff captions on the Changed tab and the session recap tip both read the same
 * setting, and both used to keep their own copy of the language table. A prompt
 * that writes for a model (task notes, tool instructions) does not use this:
 * those stay English by contract.
 */

/** Normalize a language hint ('zh-CN', 'ZH_Hans') to its primary subtag. */
export function normalizeLang(hint: string | undefined): string | undefined {
  const primary = (hint ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

const LANG_NAMES: Record<string, string> = {
  zh: 'Simplified Chinese (简体中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
};

/** The name a prompt should use for a normalized language code. */
export function uiLanguageName(lang: string): string {
  return LANG_NAMES[lang] ?? `the language with ISO 639-1 code '${lang}'`;
}

/** The configured display language when it is set and is NOT English, else
 *  undefined: callers add a language directive only in that case, so the
 *  default install's prompts stay byte-identical. */
export function nonEnglishUiLanguage(hint: string | undefined): string | undefined {
  const lang = normalizeLang(hint);
  return lang && lang !== 'en' ? lang : undefined;
}

/** The configured display language, read fresh from config; undefined when the
 *  setting is absent or the read fails (a language is a preference, never a
 *  reason for the caller's own work to stop). Callers that also have a browser
 *  locale to hand fall back to it themselves. */
export async function configuredUiLanguage(): Promise<string | undefined> {
  try {
    const { getConfig } = await import('./config-manager.js');
    return normalizeLang((await getConfig()).agent?.language);
  } catch {
    return undefined;
  }
}
