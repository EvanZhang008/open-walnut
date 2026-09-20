/**
 * The text a reply QUOTES, for a message whose provider only sent HTML.
 *
 * Most newsletters and a lot of ordinary mail arrive as `format: 'html'` with an empty `text`, and a
 * composer writes its draft to the server the MOMENT it opens: replying to one of those from a row menu
 * therefore stored a letter whose quote was the attribution line (`On <date>, <sender> wrote:`) and
 * nothing under it. The row's own snippet proves the text is derivable, so it is derived here.
 *
 * A string pass with no DOM and no parser, deliberately, and it is a TWIN of the server's
 * `htmlToText` (src/integrations/mail/bodies.ts, which builds the snippet and the search index from the
 * same bodies) rather than an import of it: that module carries the body store and its fs dependencies,
 * so pulling it into the browser bundle to reuse forty lines is the wrong trade. The rules both sides
 * keep: script/style bodies go first, block-level tags become newlines so two sentences cannot fuse,
 * the remaining tags are dropped, and nothing here can execute, fetch or recurse.
 */
import type { MailBodyDto } from '@/api/mail';

/** The handful of entities that actually appear in mail bodies; anything else is left as written. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  // Written as escapes: the punctuation these name is exactly what a code style rule bans from a source
  // file, and the quote must still carry the characters the sender typed.
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
};

export function quoteTextFromHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article)\s*>/gi, '\n')
    .replace(/<(li|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z]+|#\d{1,6});/g, (whole, name: string) => {
      const named = ENTITIES[name.toLowerCase()];
      if (named !== undefined) return named;
      if (name.startsWith('#')) {
        const code = Number(name.slice(1));
        return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return whole;
    })
    // The non-breaking space written as \u00a0, never the character itself: a literal one inside a
    // character class is invisible in every diff, and one lost to a reformat would stop collapsing the
    // whitespace HTML mail is full of.
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The quotable text of a body, whichever half the provider filled in.
 *
 * '' means there is genuinely nothing to quote (no body, or markup that held no words), which is not the
 * same answer as a body read that FAILED: that one must not open a composer at all, and its caller
 * tells the two apart by the note the read leaves behind.
 */
export function bodyQuoteText(body: MailBodyDto | null | undefined): string {
  if (!body) return '';
  if (body.text && body.text.trim()) return body.text;
  return body.html ? quoteTextFromHtml(body.html) : '';
}
