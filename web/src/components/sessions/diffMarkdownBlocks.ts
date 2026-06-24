import { marked, type Token, type Tokens } from 'marked';
import { renderMarkdownWithRefs } from '@/utils/markdown';

/** One rendered markdown block, tagged with the 1-based SOURCE line it starts on.
 *  Rendered HTML doesn't map 1:1 to source lines, but every block — and every
 *  individual list item — has a well-defined start line, which is what a reviewer
 *  needs to locate it in the file. Lists are expanded to one entry PER ITEM (and
 *  per nested item), so a 10-bullet list shows 10 line numbers, not one. */
export interface MarkdownBlock {
  /** 1-based source line where this block (or list item) begins. */
  line: number;
  /** Sanitized HTML for just this block / item (via the shared renderer). */
  html: string;
  /** The block's raw markdown source (trimmed), so a comment on this row can
   *  quote what it points at — mirrors how the diff view quotes a line's text. */
  code: string;
}

/**
 * Resolve the 1-based source line a token starts on by locating its first
 * non-blank content in the original source, scanning forward from `fromLine`.
 *
 * WHY not just accumulate token `.raw` newline counts: marked's `text`/list-item
 * tokens include trailing blank lines in `.raw`, which OVERCOUNTS and drifts
 * nested list items by ±1 (observed: a nested bullet at source L30 reported L31).
 * Matching the actual source line is exact. We try a full-line/substring match,
 * then fall back to a short prefix to tolerate inline-markdown normalization, and
 * finally to `fromLine` so a miss never throws.
 */
function lineOfFirstContent(raw: string, fromLine: number, lines: string[]): number {
  const firstContent = (raw.split('\n').find((s) => s.trim()) || '').trim();
  if (!firstContent) return fromLine;
  const start = Math.max(0, fromLine - 1);
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === firstContent || lines[i].includes(firstContent)) return i + 1;
  }
  const probe = firstContent.slice(0, 24);
  for (let i = start; i < lines.length; i++) {
    if (lines[i].includes(probe)) return i + 1;
  }
  return fromLine;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Split markdown into rows for the rendered preview's line-number gutter. Each
 * top-level block (heading, paragraph, blockquote, table, code fence) is one row;
 * a LIST is expanded into one row per item (recursively for nested lists), each
 * tagged with its true source line — so the gutter shows every bullet's number,
 * not a single number for the whole list (which read as "skipped 11 → 43").
 *
 * Rendering: each row's HTML goes through the SAME `renderMarkdownWithRefs` the
 * app uses everywhere (ref linking, image proxy, sanitization). A list item is
 * rendered as a standalone `- …` bullet so it still looks like a list line.
 * Falls back to a single block on any lexer error.
 */
export function markdownBlocksWithLines(text: string, sessionCwd?: string, host?: string): MarkdownBlock[] {
  let tokens: Token[];
  try {
    tokens = marked.lexer(text);
  } catch {
    return [{ line: 1, html: renderMarkdownWithRefs(text, sessionCwd, host), code: text.trim() }];
  }

  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];
  const render = (raw: string) => renderMarkdownWithRefs(raw, sessionCwd, host);

  // Emit one row per list item; recurse into a nested list inside an item. Each
  // item's own "lead" content (everything before its first nested list) renders
  // as a bullet at the item's line; nested items get their own rows/lines.
  const walkList = (list: Tokens.List, fromLine: number): number => {
    let cursor = fromLine;
    for (const item of list.items) {
      const itemLine = lineOfFirstContent(item.raw, cursor, lines);
      // Advance the cursor PAST this item's line so the next item's forward scan
      // starts after it. Without this, two adjacent items with identical first
      // content (e.g. repeated `- TODO`) both resolve to the same line, colliding
      // their `md:L<line>` anchors so a comment on one leaks onto the other.
      cursor = itemLine + 1;
      const children = (item.tokens ?? []) as Token[];
      const nestedLists = children.filter((c): c is Tokens.List => c.type === 'list');
      // The item's lead = its raw up to the first nested list's raw (so we don't
      // duplicate the nested bullets in the lead's HTML).
      let lead = item.raw;
      if (nestedLists.length > 0) {
        const idx = item.raw.indexOf(nestedLists[0]!.raw);
        if (idx > 0) lead = item.raw.slice(0, idx);
      }
      const leadSrc = lead.replace(/\n+$/, '');
      const leadHtml = render(leadSrc);
      if (leadHtml.trim()) blocks.push({ line: itemLine, html: leadHtml, code: leadSrc.trim() });
      // Nested items scan from after the lead and push the cursor past themselves.
      for (const nested of nestedLists) {
        cursor = walkList(nested, cursor);
      }
    }
    return cursor;
  };

  let line = 1;
  for (const tok of tokens) {
    const raw = tok.raw ?? '';
    if (tok.type === 'space') { line += countNewlines(raw); continue; }
    if (tok.type === 'list') {
      walkList(tok as Tokens.List, line);
      line += countNewlines(raw);
      continue;
    }
    const startLine = lineOfFirstContent(raw, line, lines);
    const html = render(raw);
    if (html.trim()) blocks.push({ line: startLine, html, code: raw.trim() });
    line += countNewlines(raw);
  }

  return blocks.length ? blocks : [{ line: 1, html: render(text), code: text.trim() }];
}

/** The anchor + display data for a comment spanning a contiguous range of
 *  rendered-markdown blocks. Mirrors the diff view's CommentDraft fields that
 *  matter for the message, but keyed by synthetic `md:L<line>` anchors since
 *  rendered HTML has no react-diff-view changeKey. */
export interface MarkdownCommentRange {
  /** Where the composer/card anchors (the LAST block's line, so the box renders
   *  just below the selection — matches the diff view's openDraftRange). */
  anchorKey: string;
  /** `md:L<line>` for every block in the range (kept so the whole range can stay
   *  highlighted while the composer is open / after the comment is recorded). */
  changeKeys: string[];
  /** Display location: `path:L15` for one block, `path:L15-L20` for a range. */
  loc: string;
  /** The selected blocks' source, joined with blank lines so a multi-block quote
   *  reads as separate paragraphs. */
  code: string;
}

/**
 * Resolve a contiguous block range [i..j] (indices into `blocks`, in any order)
 * to the anchor + display data a markdown comment needs. Pure so the line/range
 * formatting + anchoring is unit-testable without React. Returns null when the
 * range is empty or out of bounds (caller should no-op).
 *
 * Single block (i===j, or both ends on the same source line) → `path:L15`.
 * Multi-block range → `path:L15-L20`, quoting every block's source.
 */
export function markdownCommentRange(
  blocks: MarkdownBlock[],
  relPath: string,
  i: number,
  j: number,
): MarkdownCommentRange | null {
  if (blocks.length === 0) return null;
  const lo = Math.max(0, Math.min(i, j));
  const hi = Math.min(blocks.length - 1, Math.max(i, j));
  if (hi < lo) return null;
  const slice = blocks.slice(lo, hi + 1);
  if (slice.length === 0) return null;
  const first = slice[0]!.line;
  const last = slice[slice.length - 1]!.line;
  const loc = slice.length > 1 && last !== first ? `${relPath}:L${first}-L${last}` : `${relPath}:L${first}`;
  return {
    anchorKey: `md:L${last}`,
    changeKeys: slice.map((b) => `md:L${b.line}`),
    loc,
    code: slice.map((b) => b.code).join('\n\n'),
  };
}
