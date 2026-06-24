/**
 * Unit tests for markdownBlocksWithLines — the helper that powers the
 * line-number gutter on the Changed view's rendered-markdown preview.
 *
 * THE CONTRACT: every top-level markdown block is returned tagged with the
 * 1-based SOURCE line it begins on, so the preview's gutter aligns to the file.
 * Blank lines advance the counter but emit no block.
 */

import { describe, it, expect, vi } from 'vitest';

// The helper renders each block through the shared renderer; stub it to a
// deterministic, dependency-free passthrough so we test line-tagging in
// isolation (the real renderer pulls in DOMPurify/marked extensions, image
// proxying, etc., which aren't what's under test here).
vi.mock('@/utils/markdown', () => ({
  renderMarkdownWithRefs: (text: string) => `<r>${text.trim()}</r>`,
}));

import { markdownBlocksWithLines } from '@/components/sessions/diffMarkdownBlocks';

describe('markdownBlocksWithLines — source line tagging', () => {
  it('tags each block with its 1-based source start line (blank lines counted)', () => {
    //  L1: # Heading
    //  L2: (blank)
    //  L3: first paragraph
    //  L4: (blank)
    //  L5: - a
    //  L6: - b
    const md = '# Heading\n\nfirst paragraph\n\n- a\n- b\n';
    const blocks = markdownBlocksWithLines(md);
    const lines = blocks.map(b => b.line);
    expect(lines).toEqual([1, 3, 5]);
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

  it('empty input → a single fallback block at line 1 (never throws)', () => {
    const blocks = markdownBlocksWithLines('');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.line).toBe(1);
  });
});
