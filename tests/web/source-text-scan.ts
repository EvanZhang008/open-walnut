/**
 * What a source file renders, for the glyph guards (no-emoji-glyphs.test.ts,
 * disclosure-mark-guard.test.ts): comments blanked out and escapes decoded, line
 * numbers kept.
 */

/** Blank out comments, keep line numbers. Line comments only after space/start. */
export function stripComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)))
}

/**
 * Decode `\uXXXX` and `\u{X...}` escapes into the characters they render, so
 * `'\u25B6'` in source counts like a literal one (C73: the ratchet used to
 * read only literal characters and missed every escaped play triangle).
 * Escapes hold no newline, so line numbers stay put.
 */
export function decodeEscapes(src: string): string {
  return src
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
}
