/**
 * Which language a transcription came back in, counted the way speech is: one
 * unit per Chinese character (or kana) and one per English word.
 *
 * Why (2026-11-20, the user's own takes, 2 of 171 in a day): Qwen3-ASR sometimes
 * writes a Chinese take as an English translation (a take that opens with "I'm
 * not blaming you" in Chinese came back as "Oh, not me. I blame you..."). It
 * happens with one word of the 40-term context, and on a phone take's last piece,
 * which starts mid-sentence on English words. Heard again with the language set
 * to Chinese, each comes back as said; a take spoken in English stays English.
 *
 * It also translates only part of a take (2026-11-19, a 62 s take: its first 90
 * words came back as English sentences, its last line in Chinese, so the take as
 * a whole did not read as English). The user's real mixed speech never runs past
 * 13 English words in a row (40 of his takes); a translated stretch is a paragraph.
 */

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/gu
const LATIN_WORD = /[A-Za-z][A-Za-z']*/g

/** Share of the text's units that are CJK characters, with the unit count. */
export function cjkShare(text: string): { share: number; units: number } {
  const cjk = text.match(CJK_CHAR)?.length ?? 0
  const latin = text.match(LATIN_WORD)?.length ?? 0
  const units = cjk + latin
  return { share: units ? cjk / units : 0, units }
}

/** A sentence or more of English with next to no Chinese in it. */
export function readAsEnglish(text: string): boolean {
  const { share, units } = cjkShare(text)
  return units >= 6 && share < 0.2
}

/** Mostly Chinese, the English words of mixed speech included. */
export function readAsChinese(text: string): boolean {
  const { share, units } = cjkShare(text)
  return units >= 4 && share >= 0.5
}

/** The most English words in a row with no Chinese between them. */
export function longestEnglishRun(text: string): number {
  let best = 0
  let run = 0
  for (const unit of text.match(/[A-Za-z][A-Za-z']*|[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/gu) ?? []) {
    run = /^[A-Za-z]/.test(unit) ? run + 1 : 0
    if (run > best) best = run
  }
  return best
}

/** English words in a row that mark a translated stretch inside a Chinese take. */
export const TRANSLATED_RUN_WORDS = 30

/** Worth hearing again as Chinese: all English, or Chinese with a paragraph of English in it. */
export function mayBeTranslated(text: string): boolean {
  if (readAsEnglish(text)) return true
  return (text.match(CJK_CHAR)?.length ?? 0) > 0 && longestEnglishRun(text) >= TRANSLATED_RUN_WORDS
}

/** The Chinese hearing is the take as said: Chinese, and clearly more of it than the first. */
export function chineseHearingWins(first: string, zh: string): boolean {
  return readAsChinese(zh) && cjkShare(zh).share >= cjkShare(first).share + 0.15
}
