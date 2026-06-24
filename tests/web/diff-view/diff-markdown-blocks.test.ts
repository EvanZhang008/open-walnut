/**
 * Unit tests for markdownBlocksWithLines — the helper that powers the
 * line-number gutter on the Changed view's rendered-markdown preview.
 *
 * THE CONTRACT: every top-level markdown block — AND every individual list item,
 * recursively — is returned tagged with the 1-based SOURCE line it begins on, so
 * the preview's gutter aligns to the file. A list is NOT one row; each bullet is
 * its own row at its own line (the bug this guards: a multi-bullet list used to
 * show a single number then "skip" to the next heading). Blank lines emit no row.
 */

import { describe, it, expect, vi } from 'vitest';

// The helper renders each block through the shared renderer; stub it to a
// deterministic, dependency-free passthrough so we test line-tagging in
// isolation (the real renderer pulls in DOMPurify/marked extensions, image
// proxying, etc., which aren't what's under test here).
vi.mock('@/utils/markdown', () => ({
  renderMarkdownWithRefs: (text: string) => `<r>${text.trim()}</r>`,
}));

import { markdownBlocksWithLines, markdownCommentRange } from '@/components/sessions/diffMarkdownBlocks';

describe('markdownBlocksWithLines — source line tagging', () => {
  it('tags each block + EACH LIST ITEM with its 1-based source line (no skipped list)', () => {
    //  L1: # Heading
    //  L2: (blank)
    //  L3: first paragraph
    //  L4: (blank)
    //  L5: - a
    //  L6: - b
    const md = '# Heading\n\nfirst paragraph\n\n- a\n- b\n';
    const blocks = markdownBlocksWithLines(md);
    const lines = blocks.map(b => b.line);
    // The list is expanded: bullet `a`→L5 and bullet `b`→L6 each get a row.
    expect(lines).toEqual([1, 3, 5, 6]);
  });

  it('REGRESSION: a multi-line list gives every bullet its true line, not one number then a jump', () => {
    //  L1: - one          (spans L1)
    //  L2: - two          (continuation on L3)
    //  L3:   wrapped
    //  L4: - three        (L4)
    //  L5: (blank)
    //  L6: ## After
    const md = '- one\n- two\n  wrapped\n- three\n\n## After\n';
    const lines = markdownBlocksWithLines(md).map(b => b.line);
    // bullets at L1, L2, L4; heading at L6. NOT [1, 6].
    expect(lines).toEqual([1, 2, 4, 6]);
  });

  it('REGRESSION: nested list items map to their EXACT source line (no ±1 drift)', () => {
    //  L1: - top a
    //  L2: - top b
    //  L3:   - nested b1
    //  L4:   - nested b2
    //  L5: - top c
    const md = '- top a\n- top b\n  - nested b1\n  - nested b2\n- top c\n';
    const lines = markdownBlocksWithLines(md).map(b => b.line);
    expect(lines).toEqual([1, 2, 3, 4, 5]);
  });

  it('REGRESSION: identical-content list items get DISTINCT lines (no colliding md:L anchors)', () => {
    //  L1: - TODO
    //  L2: - TODO
    //  L3: - TODO
    // The forward scan must advance past each matched line, or all three resolve
    // to L1 — colliding their md:L<line> anchors so a comment on one bullet leaks
    // onto the others.
    const md = '- TODO\n- TODO\n- TODO\n';
    const lines = markdownBlocksWithLines(md).map(b => b.line);
    expect(lines).toEqual([1, 2, 3]);
  });

  it('first block starts at line 1', () => {
    const blocks = markdownBlocksWithLines('hello world\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.line).toBe(1);
  });

  it('accounts for multi-line blocks (a fenced code block spans several source lines)', () => {
    //  L1: para
    //  L2: (blank)
    //  L3: ```
    //  L4: code1
    //  L5: code2
    //  L6: ```
    //  L7: (blank)
    //  L8: after
    const md = 'para\n\n```\ncode1\ncode2\n```\n\nafter\n';
    const blocks = markdownBlocksWithLines(md);
    const lines = blocks.map(b => b.line);
    expect(lines).toEqual([1, 3, 8]);
  });

  it('emits no empty blocks for blank-line runs', () => {
    const md = 'a\n\n\n\nb\n';
    const blocks = markdownBlocksWithLines(md);
    expect(blocks.map(b => b.line)).toEqual([1, 5]);
    expect(blocks.every(b => b.html.trim().length > 0)).toBe(true);
  });

  it('every block carries rendered html from the shared renderer', () => {
    const blocks = markdownBlocksWithLines('# Title\n\nbody\n');
    expect(blocks[0]!.html).toContain('Title');
    expect(blocks[1]!.html).toContain('body');
  });

  it('every block carries its raw source `code` (so a comment on the row can quote it)', () => {
    //  L1: # Title  /  L3: body para  /  L5: - bullet
    const blocks = markdownBlocksWithLines('# Title\n\nbody para\n\n- bullet\n');
    expect(blocks.map(b => b.code)).toEqual(['# Title', 'body para', '- bullet']);
  });

  it('empty input → a single fallback block at line 1 (never throws)', () => {
    const blocks = markdownBlocksWithLines('');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.line).toBe(1);
  });
});

/**
 * markdownCommentRange powers DRAG-TO-SELECT in the rendered-markdown view: a
 * line-number drag picks a contiguous range of blocks, and this resolves that
 * [i..j] (indices into the blocks array) to the anchor + loc + quoted source a
 * comment needs — exactly mirroring the diff view's openDraftRange. THE CONTRACT:
 * one block → `path:Ln`; a span → `path:Ln-Lm` anchored at the LAST block, with
 * every block's `md:L<line>` key kept (so the whole range stays highlighted) and
 * all sources joined.
 */
describe('markdownCommentRange — drag range → comment anchor', () => {
  // L1 `# Title`, L3 `body para`, L5 `- bullet` (3 blocks at lines 1/3/5).
  const blocks = markdownBlocksWithLines('# Title\n\nbody para\n\n- bullet\n');

  it('single block (i===j) → `path:Ln`, one anchor, that block as code', () => {
    const r = markdownCommentRange(blocks, 'doc.md', 1, 1);
    expect(r).toEqual({
      anchorKey: 'md:L3',
      changeKeys: ['md:L3'],
      loc: 'doc.md:L3',
      code: 'body para',
    });
  });

  it('multi-block range → `path:Lfirst-Llast`, anchored at the LAST block', () => {
    const r = markdownCommentRange(blocks, 'doc.md', 0, 2);
    expect(r!.loc).toBe('doc.md:L1-L5');
    expect(r!.anchorKey).toBe('md:L5');            // box renders under the last block
    expect(r!.changeKeys).toEqual(['md:L1', 'md:L3', 'md:L5']); // whole range stays lit
    expect(r!.code).toBe('# Title\n\nbody para\n\n- bullet');   // every block quoted
  });

  it('reversed drag (dragged UP: i>j) yields the same range as dragging down', () => {
    expect(markdownCommentRange(blocks, 'doc.md', 2, 0))
      .toEqual(markdownCommentRange(blocks, 'doc.md', 0, 2));
  });

  it('out-of-bounds indices are clamped to valid blocks (a stray index never throws)', () => {
    const r = markdownCommentRange(blocks, 'doc.md', -5, 99);
    expect(r!.loc).toBe('doc.md:L1-L5');           // clamped to [0..2]
    expect(r!.changeKeys).toEqual(['md:L1', 'md:L3', 'md:L5']);
  });

  it('empty blocks → null (caller no-ops, never crashes)', () => {
    expect(markdownCommentRange([], 'doc.md', 0, 0)).toBeNull();
  });
});
