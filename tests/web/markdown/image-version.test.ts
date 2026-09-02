import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs } from '@/utils/markdown';

/**
 * Embedded images in the Files panel's read-only markdown render must follow the
 * pane's Refresh. The reported bug: an agent regenerated `images/architecture.png`
 * and the markdown that embeds it kept the OLD picture through every Refresh,
 * with no request in the server log — the rendered `<img src>` was byte-identical
 * each time and WebKit serves a URL it already loaded in the document from
 * memory. `imageVersion` makes each Refresh a different URL.
 */
const DIR = '/home/dev/repo/designs';
const DOC = 'Diagram:\n\n![arch](images/architecture.png)\n';
const srcOf = (html: string) => /<img[^>]*\ssrc="([^"]*)"/.exec(html)?.[1] ?? '';

describe('renderMarkdownWithRefs — imageVersion', () => {
  it('folds the version into the proxied image url as &r=', () => {
    const src = srcOf(renderMarkdownWithRefs(DOC, DIR, undefined, { imageVersion: '5.2' }));
    expect(src).toBe(`/api/local-image?path=${encodeURIComponent(`${DIR}/images/architecture.png`)}&r=5.2`);
  });

  it('keeps host and version together for a remote file', () => {
    const src = srcOf(renderMarkdownWithRefs(DOC, DIR, 'devbox', { imageVersion: 9 }));
    expect(src).toContain('&host=devbox');
    expect(src).toMatch(/&r=9$/);
  });

  it('a new version is a new url, even though the markdown text is unchanged', () => {
    // The render is cached by text; the version must be part of that identity or
    // the second call hands back the first call's html with the old token.
    const a = srcOf(renderMarkdownWithRefs(DOC, DIR, undefined, { imageVersion: '1.0' }));
    const b = srcOf(renderMarkdownWithRefs(DOC, DIR, undefined, { imageVersion: '2.0' }));
    expect(a).not.toBe(b);
    expect(a.endsWith('&r=1.0')).toBe(true);
    expect(b.endsWith('&r=2.0')).toBe(true);
  });

  it('chat surfaces (no version) render exactly as before', () => {
    const src = srcOf(renderMarkdownWithRefs(DOC, DIR));
    expect(src).toBe(`/api/local-image?path=${encodeURIComponent(`${DIR}/images/architecture.png`)}`);
    expect(src).not.toContain('&r=');
  });

  it('the lightbox target carries the same url as the picture', () => {
    const html = renderMarkdownWithRefs(DOC, DIR, undefined, { imageVersion: '3.3' });
    const src = srcOf(html);
    expect(html).toContain(`data-lightbox-src="${src}"`);
  });
});
