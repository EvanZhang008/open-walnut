import { describe, it, expect } from 'vitest';
import { marked } from 'marked';
import { renderMarkdownWithRefs, renderToolResultWithRefs } from '@/utils/markdown';

/**
 * Contract: the taskLink `[id|label]` pill and imagePath inline extensions are
 * registered on the global marked singleton BY THE SHARED MODULE, not by a UI
 * component.
 *
 * They historically lived in ChatMessage.tsx, which the session renderer never
 * imports — the session timeline only got the pills because some other mounted
 * chat surface had imported ChatMessage first and mutated the global singleton
 * as a side effect. This suite imports ONLY '@/utils/markdown'; if the
 * extensions ever move back into a component (or get dropped in a refactor),
 * these assertions fail without any component in the module graph.
 */

describe('global marked inline extensions (registered by @/utils/markdown alone)', () => {
  it('renders legacy [id|label] as a clickable task pill', () => {
    const html = renderMarkdownWithRefs('Done: [m1k5q7zr8-a3f1|HomeLab / Fix tax filing]');
    expect(html).toContain('data-task-id="m1k5q7zr8-a3f1"');
    expect(html).toContain('class="task-link"');
    expect(html).toContain('HomeLab / Fix tax filing');
    // The raw bracket syntax must be consumed, not rendered as text
    expect(html).not.toContain('[m1k5q7zr8-a3f1|');
  });

  it('escapes HTML in the pill label', () => {
    const html = renderMarkdownWithRefs('[m1k5q7zr8-a3f1|<b>bold</b> & co]');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; co');
    expect(html).not.toContain('<b>bold</b>');
  });

  // Raw marked.parse (no filePathsToHtml preprocessing) — this is the chat
  // pipeline's shape (ChatMessage.renderMarkdown = entityRefsToHtml → parse),
  // and the purest probe that the imagePath extension is on the singleton.
  // (In renderMarkdownWithRefs, filePathsToHtml wraps bare paths in <a> file
  // links BEFORE marked runs, so the extension doesn't see them — long-standing
  // pipeline difference, not part of this contract.)
  it('renders a bare absolute image path as an inline <img> block (imagePath extension)', () => {
    const html = marked.parse('Saved to /tmp/shots/homepage final.png ok') as string;
    expect(html).toContain('class="inline-image"');
    expect(html).toContain('/api/local-image?path=');
    expect(html).toContain(encodeURIComponent('/tmp/shots/homepage final.png'));
  });

  it('renders a bare /api/images/ path inline (imagePath extension)', () => {
    const html = marked.parse('uploaded: /api/images/abc123.png done') as string;
    expect(html).toContain('class="inline-image"');
    expect(html).toContain('src="/api/images/abc123.png"');
  });

  it('renders an image path inside a backtick code span as an image block (codespan override)', () => {
    const html = renderMarkdownWithRefs('See `/tmp/demo/capture.png`');
    expect(html).toContain('inline-image-block');
    expect(html).toContain(encodeURIComponent('/tmp/demo/capture.png'));
  });

  it('renders a markdown link whose href is an image path as image + caption (link override)', () => {
    const html = renderMarkdownWithRefs('[the screenshot](/tmp/demo/capture.png)');
    expect(html).toContain('inline-image-block');
    expect(html).toContain('inline-image-path');
    expect(html).toContain('the screenshot');
  });

  it('leaves non-image links on the default renderer', () => {
    const html = renderMarkdownWithRefs('[docs](https://example.com/page)');
    expect(html).toContain('href="https://example.com/page"');
    expect(html).not.toContain('inline-image');
  });

  it('does not hijack prose like `convert /tmp/foo.png to jpg` inside code spans', () => {
    const html = renderMarkdownWithRefs('run `convert /tmp/foo.png to jpg` now');
    // Whole-span match required — mixed command text stays a plain code span
    expect(html).toContain('<code>');
    expect(html).not.toContain('inline-image-block');
  });

  // ⚠ PERF pin: start() scans a bounded window and returns a boundary hint.
  // A match sitting far beyond START_SCAN_WINDOW (2048) must still be found
  // via repeated windowed calls — and complete fast (the 2026-07-23 freeze
  // was quadratic scanning on ~15KB messages).
  it('finds a task pill beyond the 2KB scan window in long messages (bounded-scan contract)', () => {
    const filler = 'word '.repeat(1200); // ~6KB of special-char-free text
    const start = performance.now();
    const html = renderMarkdownWithRefs(`${filler}[m1k5q7zr8-a3f1|Deep Pill] tail`);
    const elapsed = performance.now() - start;
    expect(html).toContain('data-task-id="m1k5q7zr8-a3f1"');
    expect(elapsed).toBeLessThan(1000);
  });

  it('tool-result rendering also gets the extensions (same singleton)', () => {
    const html = renderToolResultWithRefs('created [m1k5q7zr8-a3f1|Quick Task]');
    expect(html).toContain('data-task-id="m1k5q7zr8-a3f1"');
  });
});
