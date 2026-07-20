import { describe, it, expect } from 'vitest';
import { renderNoteMarkdown } from '@/utils/markdown';

/**
 * Contract for the task-NOTE renderer (renderNoteMarkdown / noteMarked instance).
 * Notes are agent-written technical prose, so two GFM behaviors are retuned
 * (2026-07-19 fix — a real note's `~100 commits … ~25 CRs` pair struck out whole
 * paragraphs, and a literal `<a href>` example rendered as a live anchor):
 *  - del requires DOUBLE tildes; a lone `~` stays literal.
 *  - raw inline/block HTML is escaped to visible text (then DOMPurify runs).
 * These pin the custom tokenizer/renderer against marked version bumps.
 */
describe('renderNoteMarkdown (noteMarked instance)', () => {
  it('lone tildes (approx numbers) stay literal — no paragraph-wide strikethrough', () => {
    const html = renderNoteMarkdown(
      'local git UNDERCOUNTS ~100 commits. rollout is ~25 CRs across 15+ accounts.',
    );
    expect(html).not.toContain('<del>');
    expect(html).toContain('~100 commits');
    expect(html).toContain('~25 CRs');
  });

  it('double-tilde still produces <del>, including single-char content', () => {
    expect(renderNoteMarkdown('a ~~struck~~ b')).toContain('<del>struck</del>');
    expect(renderNoteMarkdown('~~x~~')).toContain('<del>x</del>');
  });

  it('unclosed/lone double-tilde does not crash and stays literal', () => {
    expect(renderNoteMarkdown('~~')).toContain('~~');
    expect(renderNoteMarkdown('open ~~never closed')).toContain('never closed');
  });

  it('a literal <a href> example in prose renders as visible text, not a live anchor', () => {
    const html = renderNoteMarkdown(
      'every commit is <a href="/packages/PKG/commits/SHA">, header line states "N changes"',
    );
    expect(html).not.toMatch(/<a\s+href="\/packages/);
    expect(html).toContain('&lt;a href=');
  });

  it('block-level HTML is escaped to visible text too', () => {
    const html = renderNoteMarkdown('<div class="x">\nblock content\n</div>');
    expect(html).not.toContain('<div class="x">');
    expect(html).toContain('&lt;div');
  });

  it('script tags never survive (escape + DOMPurify double layer)', () => {
    const html = renderNoteMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
  });

  it('HTML inside backticks renders as code, unaffected by the retunes', () => {
    const html = renderNoteMarkdown('returns JSON `{"html":"<table>"}` from the endpoint');
    expect(html).toMatch(/<code>.*&lt;table&gt;.*<\/code>/);
  });
});
