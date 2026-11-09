/**
 * Table family with an OWNED GFM serializer (§3.1 of IMPL-CONTRACT).
 *
 * HARD INVARIANTS:
 * - Disk form = standard GFM pipe table WITH an alignment row
 *   (`:--` left · `:-:` center · `--:` right · `---` none).
 * - Escape `\|` for EVERY literal pipe in cell content, INCLUDING inside
 *   inline-code spans (a raw `|` in `` `x|y` `` truncates the cell on reparse).
 * - First row is ALWAYS header; cells are inline + hard-break only; no merged
 *   cells. These keep `childCount === 1`, so the GFM path is always takeable
 *   and a table NEVER serializes to raw <table> HTML.
 *
 * The shipped tiptap-markdown table serializer is intentionally NOT used — we
 * register our own via the table node's `addStorage().markdown.serialize`.
 * Parsing stays with markdown-it (GFM tables are enabled by default), so this
 * module only owns the SERIALIZE direction.
 */

import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import type { Node as PMNode } from '@tiptap/pm/model';

type Align = 'left' | 'center' | 'right' | null;

/** Map a tableCell/tableHeader `colwidth`-style align attr to a GFM delimiter. */
function alignDelimiter(align: Align): string {
  switch (align) {
    case 'left': return ':--';
    case 'center': return ':-:';
    case 'right': return '--:';
    default: return '---';
  }
}

/**
 * Serialize one cell's inline content to a markdown string, then escape pipes.
 * We render through the serializer state's inline machinery into a scratch
 * buffer so marks (bold/italic/code/link) survive, then post-escape every raw
 * `|` — including those produced inside inline-code spans, which the default
 * serializer would leave bare and truncate the row.
 */
function serializeCell(state: any, cell: PMNode): string {
  // The cell schema is `content: 'inline*'` (see InlineTableCell/Header below),
  // so the inline nodes (text + marks, hardBreak) are DIRECT children of the
  // cell — there is NO wrapping paragraph. `renderInline` must therefore run
  // over the cell itself. (If a paragraph wrapper ever appears — e.g. a future
  // schema change or pasted block content — fall back to the first child block
  // so we still capture its inline run instead of emitting an empty cell.)
  const firstChild = cell.firstChild;
  const inlineHost =
    firstChild && firstChild.isBlock && !cell.inlineContent ? firstChild : cell;
  if (!inlineHost || inlineHost.childCount === 0) return '';

  // Capture inline output into a temporary buffer by swapping the serializer's
  // output buffer + block context. Clearing delim/closed prevents the writer
  // from prepending a block delimiter (e.g. when a table sits inside a list).
  // `inlines` is swapped too: tiptap-markdown records where each bold/italic
  // mark opened and closed as offsets into `out`, and trims at those offsets on
  // a later render. A cell's offsets point into this scratch buffer, so left on
  // the shared stack they were applied to the document's own output: a `)` in a
  // later cell became a run of `*`, and the note's first line lost characters
  // (2026-11-09, a real 229-line note with bold in its table rows).
  const saved = { out: state.out, delim: state.delim, closed: state.closed, atBlockStart: state.atBlockStart, inlines: state.inlines };
  // The buffer starts with the space that follows a cell's `|`: a mark opening
  // the cell gets a non-zero offset (tiptap-markdown skips a trim at offset 0)
  // and the delimiter sees the neighbour it has in the row. trim() drops it.
  state.out = ' ';
  state.delim = '';
  state.closed = null;
  const ownInlines = Array.isArray(saved.inlines);
  if (ownInlines) state.inlines = [];
  try {
    state.renderInline(inlineHost, true);
    // A mark that closes the cell is trimmed on the next render, and a cell has
    // none: render the space that follows it in the row, once per closed mark.
    // Without it `a` + bold `（有）` saved as `a**（有）**`, which loads as text.
    for (let left = ownInlines ? state.inlines.length : 0; left > 0; left--) {
      const top = state.inlines[state.inlines.length - 1];
      if (!top?.start || !top?.end) break;
      state.render(inlineHost.type.schema.text(' '), inlineHost, inlineHost.childCount);
    }
  } catch {
    // Fall back to raw text if inline rendering throws — never lose the cell.
    state.out = inlineHost.textContent;
  }
  let cellMd = state.out;
  state.out = saved.out;
  state.delim = saved.delim;
  state.closed = saved.closed;
  state.atBlockStart = saved.atBlockStart;
  if (Array.isArray(saved.inlines)) state.inlines = saved.inlines;

  // Collapse hard breaks: in a GFM cell, a <br> is encoded literally.
  // prosemirror-markdown writes hardBreak as "\\\n"; turn it into a `<br>`.
  cellMd = cellMd.replace(/\\\n/g, '<br>').replace(/\n/g, '<br>');

  // Escape every literal pipe so it never truncates the row — this also runs
  // over text already emitted inside `` `code` `` spans.
  cellMd = cellMd.replace(/\|/g, '\\|');

  return cellMd.trim();
}

/** Read a cell's alignment, tolerating either an `align` attr or none. */
function cellAlign(cell: PMNode): Align {
  const a = (cell.attrs as Record<string, unknown>)?.align;
  if (a === 'left' || a === 'center' || a === 'right') return a;
  return null;
}

const TableWithSerializer = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: PMNode) {
          const rows: PMNode[] = [];
          node.forEach(row => rows.push(row));
          if (rows.length === 0) { state.closeBlock(node); return; }

          const headerRow = rows[0];
          const colCount = headerRow.childCount;

          // Header row.
          state.write('|');
          headerRow.forEach(cell => {
            state.write(` ${serializeCell(state, cell)} |`);
          });
          state.write('\n');

          // Alignment row (per-column).
          state.write('|');
          headerRow.forEach(cell => {
            state.write(` ${alignDelimiter(cellAlign(cell))} |`);
          });
          state.write('\n');

          // Body rows (pad/truncate to header column count for safety).
          for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            state.write('|');
            for (let c = 0; c < colCount; c++) {
              const cell = c < row.childCount ? row.child(c) : null;
              state.write(` ${cell ? serializeCell(state, cell) : ''} |`);
            }
            state.write('\n');
          }

          state.closeBlock(node);
        },
        parse: {
          // GFM tables are parsed natively by markdown-it.
        },
      },
    };
  },
});

/**
 * Per-column alignment attribute (round-trip-critical, §3.1).
 *
 * markdown-it renders GFM alignment as an inline `style="text-align:…"` on every
 * <th>/<td>; with no alignment it emits no style. We parse that back into an
 * `align` attr so the OWNED serializer's delimiter row reflects the real column
 * alignment — making `| :-- | :-: | --: |` round-trip byte-clean instead of
 * collapsing to `| --- |`. `renderHTML` re-emits the inline style so the live
 * editor (and any HTML-based render) shows the alignment too.
 */
const alignAttribute = {
  align: {
    default: null as Align,
    parseHTML: (el: HTMLElement): Align => {
      const ta = (el.style?.textAlign || el.getAttribute('align') || '').toLowerCase();
      return ta === 'left' || ta === 'center' || ta === 'right' ? (ta as Align) : null;
    },
    renderHTML: (attrs: Record<string, unknown>) => {
      const a = attrs.align;
      return a === 'left' || a === 'center' || a === 'right'
        ? { style: `text-align: ${a}` }
        : {};
    },
  },
};

/**
 * Cell content constraint (round-trip-critical): inline + hard-break only.
 * Overriding `content` to `inline*` forbids block children / nested lists,
 * guaranteeing `childCount === 1` and keeping the GFM pipe path reachable.
 * The `align` attr is merged with the default cell attrs (colspan/rowspan/
 * colwidth) so column alignment survives the markdown round-trip.
 */
const InlineTableCell = TableCell.extend({
  content: 'inline*',
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute };
  },
});
const InlineTableHeader = TableHeader.extend({
  content: 'inline*',
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute };
  },
});

/** The full table extension set to spread into the editor's extensions array. */
export const tableExtensions = [
  TableWithSerializer.configure({
    resizable: true,
    HTMLAttributes: { class: 'notes-table' },
    // First row always rendered as header; merged cells are not produced by the UI.
  }),
  TableRow,
  InlineTableHeader,
  InlineTableCell,
];
