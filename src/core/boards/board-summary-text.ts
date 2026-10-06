/**
 * A summary's markdown as one line of plain text, for a kanban card (shared by
 * the server and the web, through board-lanes.ts). Unit-pinned in
 * tests/core/board-lanes.test.ts.
 */
function stripInline(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/;
const ENDS_SENTENCE = /[.!?:;\u3002\uff01\uff1f\u2026]$/;

/**
 * Markdown as one line of plain text (R3-11): a heading reads `Heading: ...`,
 * a list item or a new paragraph starts a new sentence (`. ` unless the line
 * before already ends one), a soft wrapped line joins with a space.
 */
export function stripMarkdown(text: string): string {
  let out = '';
  let prevHeading = false;
  let prevBlock = false;
  let blank = true;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (/^[ \t]*```/.test(raw)) { blank = true; continue; }
    const heading = HEADING.test(raw);
    const item = LIST_ITEM.test(raw);
    const line = stripInline(raw.replace(HEADING, '').replace(/^[ \t]*>[ \t]?/, '').replace(LIST_ITEM, '').replace(/[ \t]+#+[ \t]*$/, heading ? '' : '$&'));
    if (!line) { blank = true; continue; }
    if (out) {
      // An indented line under a list item is that item's soft wrap.
      const starts = heading || item || blank || prevHeading || (prevBlock && !/^[ \t]/.test(raw));
      if (!starts || ENDS_SENTENCE.test(out)) out += ' ';
      else out += prevHeading ? ': ' : '. ';
    }
    out += line;
    prevHeading = heading;
    prevBlock = item;
    blank = false;
  }
  return out.replace(/\s+/g, ' ').trim();
}
