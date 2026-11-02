/**
 * The escaping every mail letter uses to place what a sender or a draft wrote inside a document
 * Walnut authors. A leaf on purpose: the letter templates (core/human-inbox/walnut-letters/mail-*.ts)
 * and render.ts both import it, and neither imports the other's runtime.
 */
import type { MailAddress } from './types.js'

/** How much of a url is shown. Long enough for a real unsubscribe token, short of a paragraph. */
const LETTER_URL_CHARS = 600

/**
 * Neutralize text that is about to be placed INSIDE a document we author.
 *
 * `<` and `&` go first because markdown passes raw HTML through, so an un-escaped body could put
 * a tag into the letter. Then two different escapes, and the split is the point:
 *
 * - INLINE, everywhere: the characters that carry structure mid-line. `[` and `]` are what a link
 *   needs, so escaping them is what stops one forming, and `(` `)` mean nothing without them.
 * - LINE START only: a heading, a bullet, a rule, an ordered list. These are escaped ONLY at the
 *   start of a line, because a hyphen or a full stop mid-sentence is punctuation, and escaping
 *   those everywhere turned `bob@example.invalid` into `bob@example\.invalid` in a letter whose
 *   entire job is to show the human the exact address the mail is going to.
 */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]~|])/g, '\\$1')
    .replace(/^(\s*)([#+=-])/gm, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)])/gm, '$1$2\\$3')
}

/**
 * A body as a markdown blockquote, escaped first.
 *
 * EVERY line is prefixed, including the empty ones: a blank line ends a blockquote, so a body
 * with a paragraph break would otherwise close the quote and everything after it would read as
 * the letter's own words rather than as quoted draft content.
 */
export function quotedMarkdown(text: string): string {
  const lines = escapeMarkdown(text).split('\n')
  return lines.map((line) => (line.length > 0 ? `> ${line}` : '>')).join('\n')
}

/** One address as a human reads it, with every part escaped for the letter's markdown. */
export function addressLine(address: MailAddress): string {
  const name = address.name?.trim()
  const plain = name ? `${name} <${address.address}>` : address.address
  return escapeMarkdown(plain)
}

/**
 * A url placed in a document we author, kept exactly as it arrived.
 *
 * A fenced block rather than `escapeMarkdown`, because this is the one field the human may want to
 * copy and open: escaping would show them `https://x/u?a\_b`, which is not the link. Fencing is what
 * makes it inert, and the only way out of a fence is a line that opens or closes one, so backticks
 * and newlines go first. The sender wrote this string (it came off a `List-Unsubscribe` header or out
 * of their own markup), so it is treated as hostile even though it parsed as https.
 */
export function fencedUrl(url: string): string {
  const flat = url.replace(/[`\r\n]/g, '').slice(0, LETTER_URL_CHARS).trim()
  return flat ? `\`\`\`\n${flat}\n\`\`\`` : ''
}
