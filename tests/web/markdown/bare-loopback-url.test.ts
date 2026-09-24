import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs, markdownToRichHtml, renderNoteMarkdown } from '@/utils/markdown';

/**
 * Dev servers print their address without a scheme ("Local: localhost:5173",
 * "listening on 0.0.0.0:8080"). GFM only autolinks http(s):// and www., so the
 * address a session had just started was plain text and nothing could open it.
 * The bareLoopbackUrl extension links those, and only those: the shapes that
 * merely CONTAIN a loopback address (an ssh -L spec, another scheme, a path, a
 * code span) stay text.
 */

const anchors = (html: string) => (html.match(/<a[\s>]/gi) ?? []).length;
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);

describe('bare loopback addresses become links', () => {
  it.each([
    ['localhost:8377', 'http://localhost:8377'],
    ['localhost:8377/', 'http://localhost:8377/'],
    ['127.0.0.1:8000/api/x?y=1', 'http://127.0.0.1:8000/api/x?y=1'],
    ['0.0.0.0:5173', 'http://0.0.0.0:5173'],
    ['[::1]:3000/a', 'http://[::1]:3000/a'],
    ['LOCALHOST:8080', 'http://LOCALHOST:8080'],
  ])('%s', (addr, href) => {
    const html = renderMarkdownWithRefs(`Server is up at ${addr} now`);
    expect(anchors(html)).toBe(1);
    expect(hrefs(html)).toEqual([encodeURI(href)]);
    expect(html).toContain(`>${addr}</a>`);
  });

  it('at the very start of a message and inside parentheses', () => {
    expect(hrefs(renderMarkdownWithRefs('localhost:8080 is ready'))).toEqual(['http://localhost:8080']);
    expect(hrefs(renderMarkdownWithRefs('(see localhost:8080/x)'))).toEqual(['http://localhost:8080/x']);
  });

  it('trailing sentence punctuation and emphasis stay outside the link', () => {
    expect(hrefs(renderMarkdownWithRefs('Open localhost:8080/app.'))).toEqual(['http://localhost:8080/app']);
    expect(hrefs(renderMarkdownWithRefs('Open localhost:8080, then log in'))).toEqual(['http://localhost:8080']);
    const bold = renderMarkdownWithRefs('Open **localhost:8080/app** now');
    expect(hrefs(bold)).toEqual(['http://localhost:8080/app']);
    expect(bold).toContain('<strong>');
  });

  it('CJK prose around the address is not swallowed', () => {
    // "open: localhost:8377/ , then ..." with a full-width colon and comma.
    const html = renderMarkdownWithRefs('打开：localhost:8377/，然后刷新');
    expect(hrefs(html)).toEqual(['http://localhost:8377/']);
    expect(html).toContain('，然后');
  });

  it('a loopback address inside a longer token stays text', () => {
    for (const text of [
      'ssh -N -L 8377:localhost:8377 -L 8080:localhost:8080 dev-box',
      'bind localhost:8080:remote-host:80 first',
      'ws://localhost:9000/socket',
      'see /etc/localhost:80 there',
      'user@localhost:22 via ssh',
      'mylocalhost:8080 is not it',
      'localhost:123456 is not a port',
      'plain localhost is a word',
    ]) {
      expect(anchors(renderMarkdownWithRefs(text)), text).toBe(0);
    }
  });

  it('a scheme URL stays ONE link (GFM owns it)', () => {
    const html = renderMarkdownWithRefs('Open http://localhost:8377/ and https://127.0.0.1:8443/x');
    expect(hrefs(html)).toEqual(['http://localhost:8377/', 'https://127.0.0.1:8443/x']);
  });

  it('code spans and fences are untouched', () => {
    expect(anchors(renderMarkdownWithRefs('run `curl localhost:8080/health`'))).toBe(0);
    expect(anchors(renderMarkdownWithRefs('```\ncurl localhost:8080/health\n```'))).toBe(0);
  });

  it('no nested anchor inside a link label', () => {
    const html = renderMarkdownWithRefs('[localhost:8080](http://localhost:8080/app)');
    expect(anchors(html)).toBe(1);
    expect(hrefs(html)).toEqual(['http://localhost:8080/app']);
  });

  it('renders a plain anchor: the panel decides at click time, not the renderer', () => {
    const html = renderMarkdownWithRefs('at localhost:8080');
    expect(html).not.toContain('class=');
    expect(html).not.toContain('data-');
  });

  it('copy-as-rich-text and notes link it too', () => {
    expect(hrefs(markdownToRichHtml('at localhost:8080/x'))).toEqual(['http://localhost:8080/x']);
    expect(hrefs(renderNoteMarkdown('at localhost:8080/x'))).toEqual(['http://localhost:8080/x']);
  });

  it('a long message with many colons stays linear (start() window)', () => {
    const filler = 'a:b '.repeat(20_000);
    const t0 = performance.now();
    const html = renderMarkdownWithRefs(`${filler} then localhost:8080 ${filler}`);
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(hrefs(html)).toEqual(['http://localhost:8080']);
  });
});
