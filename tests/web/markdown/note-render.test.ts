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

  /**
   * A markdown comment is the ONE html shape that is dropped rather than escaped.
   * Obsidian hides comments and the global Marked instance loses them to DOMPurify,
   * so escaping them here made Walnut the only reader that printed them — which is
   * how a project tracking note's format examples (`<!-- example row: … -->`)
   * showed up as prose in the project detail pane.
   */
  describe('markdown comments are invisible, like every other reader of these bytes', () => {
    it('drops a block comment instead of printing it', () => {
      const html = renderNoteMarkdown('## Log\n\n<!-- example: - 2026-09-21 triage: nothing new -->\n');
      expect(html).toContain('<h2>Log</h2>');
      expect(html).not.toContain('&lt;!--');
      expect(html).not.toContain('example:');
    });

    it('keeps a header-only table intact when a comment sits under it', () => {
      const html = renderNoteMarkdown(
        '| Item | State |\n| --- | --- |\n<!-- example row: | Design review | in progress | -->\n',
      );
      expect(html).toContain('<th>Item</th>');
      // The comment must not become a visible table row, nor visible text.
      expect(html).not.toContain('Design review');
      expect(html).not.toContain('&lt;!--');
    });

    it('still escapes an html token that is a comment PLUS something else', () => {
      // The strictness matters: anything beyond one comment keeps the old
      // escaping, which is what makes hostile note HTML inert.
      const html = renderNoteMarkdown('<!-- ok --><img src=x onerror="alert(1)">\n');
      expect(html).toContain('&lt;');
      expect(html).not.toMatch(/<img[^>]*onerror/);
    });

    it('never lets a comment smuggle live markup through', () => {
      const html = renderNoteMarkdown('<!-- <script>alert(1)</script> -->\n');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert(1)');
    });
  });
});
