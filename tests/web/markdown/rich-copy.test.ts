import { describe, it, expect } from 'vitest';
import { markdownToRichHtml, renderMarkdownWithRefs } from '@/utils/markdown';

/**
 * Contract for the "copy as rich text" path (markdownToRichHtml):
 *  - turns markdown structure into standard semantic HTML (h/strong/ul/code/table),
 *  - stays self-contained: NO walnut-internal links (file-link / task-ref /
 *    session-ref / /api/local-image proxy) that would be dead — or leak internal
 *    filesystem paths — once pasted into an external editor.
 *
 * Note on sanitization: markdownToRichHtml runs the SAME DOMPurify.sanitize call
 * as the on-screen renderMarkdownWithRefs. DOMPurify only sanitizes against a real
 * browser DOM (in a bare node env DOMPurify.isSupported is false and it passes
 * input through), so the XSS-stripping guarantee is verified in the Playwright E2E
 * where DOMPurify actually runs — not asserted here where it would be a no-op.
 */
describe('markdownToRichHtml (copy as rich text)', () => {
  it('renders headings, bold, and lists as semantic HTML', () => {
    const html = markdownToRichHtml('# Title\n\nsome **bold** text\n\n- one\n- two');
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
  });

  it('renders inline code and fenced code blocks', () => {
    const html = markdownToRichHtml('use `npm run build`\n\n```\nconst x = 1;\n```');
    expect(html).toContain('<code>npm run build</code>');
    expect(html).toContain('<pre>');
    expect(html).toContain('const x = 1;');
  });

  it('renders GFM tables', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const html = markdownToRichHtml(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('keeps ordinary markdown links but does NOT inject internal file/task/session links', () => {
    const md = 'See [docs](https://example.com) and /Users/me/repo/src/foo.ts:42';
    const html = markdownToRichHtml(md);
    // Real link preserved
    expect(html).toContain('href="https://example.com"');
    // The bare path is NOT turned into a clickable file-link anchor (that's
    // renderMarkdownWithRefs' job, and it's meaningless outside the app).
    expect(html).not.toContain('file-link');
    expect(html).not.toContain('data-file-path');
    // Sanity: the on-screen renderer DOES add the internal link, proving the two
    // paths genuinely differ.
    expect(renderMarkdownWithRefs(md)).toContain('file-link');
  });

  it('does not carry task-ref / session-ref internal anchors into rich text', () => {
    const md = 'Blocked on <task-ref id="abc123-def4" label="Do thing"/>';
    const html = markdownToRichHtml(md);
    expect(html).not.toContain('task-link');
    expect(html).not.toContain('data-task-id');
  });

  it('never throws on empty or whitespace input', () => {
    expect(() => markdownToRichHtml('')).not.toThrow();
    expect(() => markdownToRichHtml('   \n  ')).not.toThrow();
  });
});
