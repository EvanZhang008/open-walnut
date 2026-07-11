/**
 * MARKDOWN ROUND-TRIP CORPUS — the #1 editing-quality gate (IMPL-CONTRACT §6/§7.1).
 *
 * The single worst bug class for this editor is markdown that does not survive a
 * load→edit→save cycle byte-for-byte. These tests drive the EXACT serializer +
 * parser the live `NotesEditor` wires (`tiptap-markdown` over the production
 * extensions — owned table GFM serializer, `#tag` node, callout node), via a
 * headless harness (no EditorView; see editor-harness.ts + dom-setup.ts).
 *
 * Two assertions per corpus case:
 *   1. `roundTrip(md) === md`  → byte-clean after ONE cycle (the disk form is
 *      reproduced exactly), and
 *   2. `roundTrip(roundTrip(md)) === roundTrip(md)`  → IDEMPOTENT (a second cycle
 *      changes nothing — so even a "normalized" form is a stable fixed point and
 *      can never drift further on repeated saves).
 *
 * A small set of cases are NOT byte-clean on cycle 1 by DESIGN (CommonMark
 * soft-break semantics; a trailing-block newline; defensive bracket escaping).
 * Those are asserted explicitly in the "documented normalization" block with the
 * exact expected output, so a regression that turns them into DATA LOSS (vs. a
 * known stable normalization) fails loudly. Every case — clean or normalized —
 * MUST be idempotent.
 */
import { describe, it, expect } from 'vitest';
import { createNotesMarkdownHarness } from './editor-harness';

const h = createNotesMarkdownHarness();

/** Assert md survives one cycle byte-for-byte AND is a stable fixed point. */
function expectByteClean(md: string): void {
  const once = h.roundTrip(md);
  expect(once, 'round-trip must be byte-clean').toBe(md);
  const twice = h.roundTrip(once);
  expect(twice, 'round-trip must be idempotent').toBe(once);
}

/**
 * Assert md normalizes to `expected` on cycle 1 (a known, lossless reshape) and
 * is then a stable fixed point. Used only for the documented CommonMark / block
 * normalizations below — never to paper over content loss.
 */
function expectNormalizesTo(md: string, expected: string): void {
  const once = h.roundTrip(md);
  expect(once, 'normalized output').toBe(expected);
  const twice = h.roundTrip(once);
  expect(twice, 'normalized output must be idempotent').toBe(once);
}

// ─── Text styles & headings (reuse StarterKit) ──────────────────────────────

describe('round-trip: text styles & headings', () => {
  it('headings H1–H3', () => expectByteClean('# H1\n\n## H2\n\n### H3'));
  it('inline marks: bold / italic / code / strike', () =>
    expectByteClean('This is **bold** and *italic* and `code` and ~~strike~~.'));
  it('marks combined with a link', () =>
    expectByteClean('~~strike~~ and [link](https://e.com) and **bold**'));
  it('inline code containing a raw pipe (outside a table)', () =>
    expectByteClean('inline `a|b` pipe outside table'));
  it('multiple paragraphs keep their blank-line separators', () =>
    expectByteClean('Para one.\n\nPara two.\n\nPara three.'));
  it('empty document', () => expectByteClean(''));
});

// ─── Lists (bullet / ordered / nested / task) ───────────────────────────────

describe('round-trip: lists', () => {
  it('bullet list', () => expectByteClean('- one\n- two\n- three'));
  it('ordered list', () => expectByteClean('1. one\n2. two\n3. three'));
  it('nested bullet list (2-space indent preserved)', () =>
    expectByteClean('- a\n  - a1\n  - a2\n- b'));
  it('mixed bullet then ordered list', () =>
    expectByteClean('- bullet\n- another\n\n1. ordered\n2. two'));

  // Task-list checkbox STATE is data — an unchecked box must NOT come back
  // checked (regression guard for the `input.checked` reflection the editor
  // relies on; see dom-setup.ts).
  it('task list preserves checked vs. unchecked state', () =>
    expectByteClean('- [ ] todo\n- [x] done'));
  it('nested task list preserves per-item checked state', () =>
    expectByteClean('- [ ] parent\n  - [ ] child\n  - [x] child done'));
});

// ─── Blockquote / divider / code block ──────────────────────────────────────

describe('round-trip: blockquote, divider, code block', () => {
  it('plain blockquote stays a blockquote (not a callout)', () =>
    expectByteClean('> just a normal quote, no admonition'));
  it('divider between paragraphs', () => expectByteClean('above\n\n---\n\nbelow'));
  it('fenced code block with language', () =>
    expectByteClean('```js\nconst x = 1;\n```'));
});

// ─── Links ──────────────────────────────────────────────────────────────────

describe('round-trip: links', () => {
  it('inline link', () =>
    expectByteClean('See [the docs](https://example.com/page) here.'));
  it('link whose URL contains a #fragment (not a tag)', () =>
    expectByteClean('See [issue #5](https://example.com/issues#5) here'));
});

// ─── ![[embed]] — atom inline node, literal-write serialize (BUG 2) ──────────
// The disk form MUST stay literally `![[path]]`. Without the WikiEmbedNode the
// default text serializer escapes `[` `]` `_` → `!\[\[...\]\]` / `\_attachment`
// (data corruption). These cases lock the byte-clean contract for every real
// vault embed form (bare name, vault-relative, legacy `Notion/` prefix, pdf,
// multi-embed on one line) — and that `![alt](url)` images are NOT captured.
describe('round-trip: ![[embeds]]', () => {
  it('bare shortest-unique image name', () =>
    expectByteClean('![[5C01F4A6-94F9-4A9A-8EC5-B113D96E3E7E.png]]'));
  it('vault-relative path with an _attachment folder (underscore preserved)', () =>
    expectByteClean('![[Areas/Travel/_attachment/Untitled.png]]'));
  it('legacy Notion/-rooted path stays byte-clean (resolution is backend-side)', () =>
    expectByteClean('![[Notion/Areas/Travel/_attachment/Untitled.png]]'));
  it('pdf embed with spaces in the name', () =>
    expectByteClean('![[Quarterly Report Draft 2026-03-14.pdf]]'));
  it('two embeds on ONE line each survive', () =>
    expectByteClean('![[a.png]] ![[b.png]]'));
  it('embed sits in a paragraph between text', () =>
    expectByteClean('above\n\n![[Areas/x/_attachment/foo.png]]\n\nbelow'));
  it('unknown extension (.base) still round-trips literally', () =>
    expectByteClean('![[Notion/Areas/Travel/New database/New database.base]]'));
  it('a real ![alt](url) image is NOT swallowed by the embed rule', () =>
    expectByteClean('![alt text](https://example.com/x.png)'));
});

// ─── #tags — literal text, atomic inline node (§3.2) ────────────────────────

describe('round-trip: #tags', () => {
  it('tag mid-sentence and at line-end', () => {
    expectByteClean('discussed #standup and #q3-planning today');
    expectByteClean('ends with a tag #done');
  });
  it('does NOT tag C# / F# (letter directly before #)', () =>
    expectByteClean('I write C# and F# code'));
  it('does NOT tag #123 (digit after #)', () =>
    expectByteClean('issue #123 is not a tag'));
  it('does NOT tag word#notag (no boundary before #)', () =>
    expectByteClean('word#notag should not tag'));
  it('tags a (#scoped) inside parens (paren is an allowed boundary)', () =>
    expectByteClean('a tag (#scoped) here'));
  it('a #tag inside heading text', () => expectByteClean('# Title with #tag'));
});

// ─── Callouts — `> [!kind]` admonition (§3.3) ───────────────────────────────

describe('round-trip: callouts (each frozen kind)', () => {
  for (const kind of ['note', 'tip', 'warning', 'danger', 'info'] as const) {
    it(`single-line ${kind} callout is byte-clean`, () =>
      expectByteClean(`> [!${kind}]\n> a ${kind} body`));
  }

  it('callout with TWO paragraphs (hard break) is byte-clean', () =>
    expectByteClean('> [!note]\n> para one\n>\n> para two'));

  // markdown-it folds soft-wrapped blockquote lines into ONE paragraph (joined
  // by a space) — standard CommonMark. The body text is preserved (no loss),
  // just reflowed; assert the exact stable form.
  it('callout multi-line SOFT break reflows to one paragraph (CommonMark, lossless)', () =>
    expectNormalizesTo(
      '> [!warning]\n> body line one\n> body line two',
      '> [!warning]\n> body line one body line two',
    ));

  // Inline body sharing the marker line is normalized onto its own body line.
  it('callout with inline body on the marker line normalizes to a body line', () =>
    expectNormalizesTo(
      '> [!tip] inline body on marker line',
      '> [!tip]\n> inline body on marker line',
    ));

  // An UNKNOWN kind must stay a plain blockquote (the `[!xxx]` becomes literal
  // text; prosemirror-markdown defensively escapes the leading `[`). Lossless +
  // idempotent — the bytes re-parse to the same text.
  it('unknown [!kind] stays a blockquote (text preserved, bracket escaped)', () =>
    expectNormalizesTo(
      '> [!xxx]\n> stays a blockquote',
      '> \\[!xxx\\] stays a blockquote',
    ));
});

// ─── Tables — OWNED GFM serializer (§3.1), the #1 round-trip risk ────────────
//
// A note that ENDS in a table gains a single trailing "\n" (the block
// terminator from closeBlock). That is NOT data loss — it only appears when the
// table is the final block; a table followed by ANY content is byte-clean (see
// the combos section). Real editor output always ends in a newline. We assert
// the table cases WITH the trailing newline to reflect the true serialized form.

describe('round-trip: tables (owned GFM serializer)', () => {
  it('table with per-column alignment (:-- / :-: / --:)', () =>
    expectByteClean('| Name | Role | Action |\n| :-- | :-: | --: |\n| Ana | Lead | ship |\n'));

  it('table with no alignment (---)', () =>
    expectByteClean('| A | B |\n| --- | --- |\n| 1 | 2 |\n'));

  it('escapes a LITERAL pipe in a cell (\\|)', () =>
    expectByteClean('| Expr | Note |\n| --- | --- |\n| a \\| b | literal pipe |\n'));

  // The verified trap: a raw `|` inside inline-code truncates the row on
  // re-parse. The owned serializer escapes it INSIDE the code span too.
  it('escapes a pipe INSIDE an inline-code span in a cell (`a\\|b`)', () =>
    expectByteClean('| Expr | Note |\n| --- | --- |\n| `a\\|b` | pipe in code |\n'));

  it('preserves an empty cell', () =>
    expectByteClean('| A | B |\n| --- | --- |\n|  | 2 |\n'));

  it('preserves a hard break (<br>) inside a cell', () =>
    expectByteClean('| Multi | Note |\n| --- | --- |\n| line1<br>line2 | x |\n'));

  it('preserves inline marks (bold/italic/code) inside cells', () =>
    expectByteClean('| **Bold** | *it* | `code` |\n| --- | --- | --- |\n| a | b | c |\n'));

  it('NEVER emits raw <table> HTML', () => {
    const out = h.roundTrip('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    expect(out).not.toMatch(/<table|<\/table>|<tr|<td|<th/i);
  });
});

// ─── Table serializer, tested DIRECTLY (§3.1) ───────────────────────────────
//
// The brief calls for testing the OWNED table serializer directly — i.e. build a
// ProseMirror doc from JSON and serialize it WITHOUT the parse leg, so a parser
// change can never mask a serializer regression. This is also where we pin the
// alignment-delimiter mapping and the pipe-escape-inside-inline-code invariant.

describe('table serializer (direct, no parse leg)', () => {
  /** Build a tableCell/tableHeader JSON node with inline text + optional marks. */
  function makeCell(
    nodeType: 'tableCell' | 'tableHeader',
    text: string,
    opts: { marks?: Array<{ type: string }>; align?: 'left' | 'center' | 'right' | null } = {},
  ) {
    return {
      type: nodeType,
      attrs: { colspan: 1, rowspan: 1, colwidth: null, align: opts.align ?? null },
      content: text
        ? [{ type: 'text', text, ...(opts.marks?.length ? { marks: opts.marks } : {}) }]
        : [],
    };
  }
  function makeTableDoc(rows: any[][]) {
    return h.schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'table', content: rows.map((cells) => ({ type: 'tableRow', content: cells })) }],
    });
  }

  it('maps per-column align to the GFM delimiter row (:-- / :-: / --: / ---)', () => {
    const doc = makeTableDoc([
      [
        makeCell('tableHeader', 'L', { align: 'left' }),
        makeCell('tableHeader', 'C', { align: 'center' }),
        makeCell('tableHeader', 'R', { align: 'right' }),
        makeCell('tableHeader', 'N', { align: null }),
      ],
      [
        makeCell('tableCell', '1'),
        makeCell('tableCell', '2'),
        makeCell('tableCell', '3'),
        makeCell('tableCell', '4'),
      ],
    ]);
    expect(h.docToMd(doc)).toBe('| L | C | R | N |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |\n');
  });

  it('escapes a literal pipe in plain cell text', () => {
    const doc = makeTableDoc([
      [makeCell('tableHeader', 'h')],
      [makeCell('tableCell', 'a|b')],
    ]);
    expect(h.docToMd(doc)).toBe('| h |\n| --- |\n| a\\|b |\n');
  });

  it('escapes a pipe INSIDE an inline-code mark (the row-truncation trap)', () => {
    const doc = makeTableDoc([
      [makeCell('tableHeader', 'Expr')],
      [makeCell('tableCell', 'a|b', { marks: [{ type: 'code' }] })],
    ]);
    expect(h.docToMd(doc)).toBe('| Expr |\n| --- |\n| `a\\|b` |\n');
  });

  it('renders an empty cell as blank, not dropped', () => {
    const doc = makeTableDoc([
      [makeCell('tableHeader', 'A'), makeCell('tableHeader', 'B')],
      [makeCell('tableCell', ''), makeCell('tableCell', 'x')],
    ]);
    expect(h.docToMd(doc)).toBe('| A | B |\n| --- | --- |\n|  | x |\n');
  });

  it('preserves inline marks (bold) in a serialized cell', () => {
    const doc = makeTableDoc([
      [makeCell('tableHeader', 'h')],
      [makeCell('tableCell', 'Bold', { marks: [{ type: 'bold' }] })],
    ]);
    expect(h.docToMd(doc)).toBe('| h |\n| --- |\n| **Bold** |\n');
  });
});

// ─── Combos (cross-feature, where escaping bugs hide) ───────────────────────

describe('round-trip: combinations', () => {
  it('table followed by a paragraph is fully byte-clean (no trailing-nl issue)', () =>
    expectByteClean('| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter the table.'));

  it('paragraph, table, paragraph', () =>
    expectByteClean('Before.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter.'));

  it('a #tag inside a table cell survives (literal #tag text)', () =>
    expectByteClean('| Topic | Tag |\n| --- | --- |\n| meeting | #standup |\n'));

  it('a link inside a table cell survives', () =>
    expectByteClean('| Site | Link |\n| --- | --- |\n| ex | [x](https://e.com) |\n'));

  it('a rich document with headings, lists, callout, table, tags, divider', () => {
    const doc = [
      '# Project Notes',
      '',
      'Some intro with a #tag and **bold** text.',
      '',
      '## Tasks',
      '',
      '- [ ] design',
      '- [x] build',
      '',
      '> [!warning]',
      '> watch the edge case',
      '',
      '| Item | Owner |',
      '| :-- | --: |',
      '| api | Ana |',
      '',
      '---',
      '',
      'Closing paragraph with `inline code`.',
    ].join('\n');
    expectByteClean(doc);
  });
});
