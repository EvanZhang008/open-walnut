/**
 * Is a text written in the language a reply-language sentence asks for? A test tool only: the
 * letters ratchet (tests/core/walnut-letters-ratchet.test.ts) checks with it that Walnut's own
 * Chinese texts are Chinese. Walnut itself never judges a session's words for their language
 * (2026-11-20, the user removed that reminder; tests/core/hints/no-reply-language-reminder.test.ts).
 *
 * Code, inline code, links, paths, HTML and quoted words are left out before counting: they are
 * English in every language, or keep the language they were said in.
 */
import { expectedScript, type Script } from '../../src/core/human-inbox/walnut-letters/languages.js'

function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:^|\s)[\w.~-]*\/[\w./-]+/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ')
    .replace(/"[^"\n]*"|“[^”]*”|「[^」]*」/g, ' ')
}

export function scriptCounts(text: string): Record<Script, number> {
  const c: Record<Script, number> = { han: 0, kana: 0, hangul: 0, latin: 0, cyrillic: 0 }
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) c.han++
    else if (cp >= 0x3040 && cp <= 0x30ff) c.kana++
    else if (cp >= 0xac00 && cp <= 0xd7af) c.hangul++
    else if (cp >= 0x0400 && cp <= 0x04ff) c.cyrillic++
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) c.latin++
  }
  return c
}

/**
 * True when the text is clearly not in the rule's language, false when it is, null when it cannot
 * tell (the rule names no language, fewer than `minLetters` letters). A CJK character carries about
 * a word, a Latin letter a fifth of one, so letters are weighed (CJK x4) before the share is taken.
 */
export function offLanguage(rule: string, text: string, minLetters = 40): boolean | null {
  const want = expectedScript(rule)
  if (!want || !text) return null
  const c = scriptCounts(prose(text))
  const weight: Record<Script, number> = { han: 4, kana: 4, hangul: 4, latin: 1, cyrillic: 1 }
  const letters = c.han + c.kana + c.hangul + c.latin + c.cyrillic
  if (letters < minLetters) return null
  const total = (Object.keys(c) as Script[]).reduce((n, s) => n + c[s] * weight[s], 0)
  // Japanese text mixes kanji with kana: either counts for it.
  const mine = want === 'kana' ? c.kana * 4 + c.han * 4 : c[want] * weight[want]
  return mine / total < 0.2
}
