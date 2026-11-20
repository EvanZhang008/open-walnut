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
