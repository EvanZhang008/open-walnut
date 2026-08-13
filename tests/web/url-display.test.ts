/**
 * Plain-text URL tokenizing + Slack-style shortening.
 *
 * Contract under test (the 2026-07-29 report — "the link inside the session note
 * needs to be clickable, and reduce in size, it is too long, like this in Slack"):
 *   - A URL inside plain typed text is found as its own token so the renderer can
 *     make it a real anchor (the note surface previously rendered it as dead text).
 *   - Trailing sentence punctuation stays with the PROSE, but a bracket that the
 *     URL itself opened stays in the URL (wiki links like /Foo_(bar)).
 *   - The on-screen label is bounded, and the shortening keeps the parts a human
 *     recognizes: the host and the LAST path segment. The href is never shortened.
 *   - Garbage / non-URL-ish input degrades instead of throwing — this runs inside
 *     a React render.
 */
import { describe, it, expect } from 'vitest';
import { tokenizeUrls, extractUrls, shortenUrl } from '../../web/src/utils/url-display';

// The real link from the report (a deploy pipeline change_history URL).
const LONG_URL =
  'https://deploy.example.com/pipelines/MarinaServiceCDK/change_history_v2?changes=Commit%3AMarinaServiceCDK%2Fmainline%3A52fbf32b7ea96e00d3f2af08d823ec1d21dacdef';

describe('tokenizeUrls', () => {
  it('splits a URL out of surrounding prose, in order', () => {
    const tokens = tokenizeUrls('2. Deploy to pipeline https://x.dev/a then confirm');
    expect(tokens).toEqual([
      { kind: 'text', text: '2. Deploy to pipeline ' },
      { kind: 'url', text: 'https://x.dev/a', href: 'https://x.dev/a' },
      { kind: 'text', text: ' then confirm' },
    ]);
  });

  it('returns a single text token when there is no URL', () => {
    expect(tokenizeUrls('remember: confirm before deploy')).toEqual([
      { kind: 'text', text: 'remember: confirm before deploy' },
    ]);
  });

  it('handles a URL at the very start and very end', () => {
    expect(tokenizeUrls('https://x.dev/a b')[0]!.kind).toBe('url');
    const end = tokenizeUrls('see https://x.dev/a');
    expect(end[end.length - 1]).toEqual({ kind: 'url', text: 'https://x.dev/a', href: 'https://x.dev/a' });
  });

  it('finds every URL when a note lists several', () => {
    const tokens = tokenizeUrls('a https://x.dev/1 b http://y.dev/2 c');
    expect(tokens.filter(t => t.kind === 'url').map(t => t.text)).toEqual(['https://x.dev/1', 'http://y.dev/2']);
  });

  it('keeps the URL intact across lines — a note\'s link often sits on line 2', () => {
    const tokens = tokenizeUrls('1. confirm\n2. deploy https://x.dev/a\n3. done');
    const url = tokens.find(t => t.kind === 'url')!;
    expect(url.text).toBe('https://x.dev/a');
    // The newline must stay in the text tokens (the preview slices by line).
    expect(tokens.map(t => t.text).join('')).toBe('1. confirm\n2. deploy https://x.dev/a\n3. done');
  });

  it('gives trailing sentence punctuation back to the prose', () => {
    for (const p of ['.', ',', ':', ';', '!', '?']) {
      const url = tokenizeUrls(`see https://x.dev/a${p} next`).find(t => t.kind === 'url')!;
      expect(url.href).toBe('https://x.dev/a');
    }
  });

  it('gives back an unmatched closing bracket but keeps a matched one', () => {
    expect(tokenizeUrls('(see https://x.dev/a)').find(t => t.kind === 'url')!.href).toBe('https://x.dev/a');
    // The URL opened this paren itself — it is part of the path.
    expect(tokenizeUrls('https://w.dev/wiki/Foo_(bar)').find(t => t.kind === 'url')!.href)
      .toBe('https://w.dev/wiki/Foo_(bar)');
  });

  it('does not treat a bare domain or a non-http scheme as a link', () => {
    expect(tokenizeUrls('x.dev/a').every(t => t.kind === 'text')).toBe(true);
    expect(tokenizeUrls('javascript:alert(1)').every(t => t.kind === 'text')).toBe(true);
    expect(tokenizeUrls('file:///etc/passwd').every(t => t.kind === 'text')).toBe(true);
  });

  it('round-trips: concatenating all token text rebuilds the input', () => {
    for (const input of ['a https://x.dev/1 b', LONG_URL, 'no links here', '(https://x.dev/a).', '']) {
      expect(tokenizeUrls(input).map(t => t.text).join('')).toBe(input);
    }
  });

  // CJK prose has no spaces around punctuation, so the URL run must be cut at
  // the first CJK punctuation mark (same contract as the markdown autolink —
  // trimUrlCjkTail is shared; the 2026-08-12 chat report).
  it('cuts the URL at fullwidth punctuation inside CJK prose', () => {
    const url = tokenizeUrls('打开 https://x.dev/a,个人账户,enroll 继续').find(t => t.kind === 'url')!;
    expect(url.href).toBe('https://x.dev/a');
  });

  it('cuts at a halfwidth comma followed by a CJK char', () => {
    const url = tokenizeUrls('看 https://x.dev/a,然后继续').find(t => t.kind === 'url')!;
    expect(url.href).toBe('https://x.dev/a');
  });

  it('keeps CJK letters in the path (wiki slugs)', () => {
    const url = tokenizeUrls('看 https://zh.wikipedia.org/wiki/机器学习 吧').find(t => t.kind === 'url')!;
    expect(url.href).toBe('https://zh.wikipedia.org/wiki/机器学习');
  });

  it('CJK round-trip: token texts still rebuild the input', () => {
    for (const input of ['打开 https://x.dev/a,个人账户 继续', '见 https://x.dev/b。下一句']) {
      expect(tokenizeUrls(input).map(t => t.text).join('')).toBe(input);
    }
  });
});

describe('extractUrls', () => {
  it('dedupes while preserving first-occurrence order', () => {
    expect(extractUrls('a https://x.dev/1 b https://y.dev/2 c https://x.dev/1'))
      .toEqual(['https://x.dev/1', 'https://y.dev/2']);
  });

  it('is empty for link-free text', () => {
    expect(extractUrls('just a note')).toEqual([]);
  });
});

describe('shortenUrl', () => {
  it('bounds the label for the reported long deploy URL', () => {
    const label = shortenUrl(LONG_URL);
    expect(label.length).toBeLessThanOrEqual(56);
    expect(label.length).toBeLessThan(LONG_URL.length / 2);
  });

  it('keeps the host and the last path segment — the recognizable halves', () => {
    const label = shortenUrl(LONG_URL);
    expect(label).toContain('deploy.example.com');
    expect(label).toContain('change_history_v2');
  });

  it('keeps the query PARAM NAME but drops its opaque value', () => {
    const label = shortenUrl(LONG_URL);
    expect(label).toContain('changes=');
    expect(label).not.toContain('52fbf32b7ea96e00d3f2af08d823ec1d21dacdef');
  });

  it('sacrifices the QUERY before the last path segment — the tail names the link', () => {
    // At a budget too tight for both, "…/change_history_v2" must win over
    // "?changes=…": one says WHAT the link is, the other is an opaque key.
    // Regression guard — the first implementation got this backwards and
    // produced "deploy.example.com/…?changes=…" (caught by the E2E).
    const label = shortenUrl(LONG_URL, 42);
    expect(label).toContain('change_history_v2');
    expect(label).not.toContain('changes=');
  });

  it('clips a very long last segment rather than dropping it', () => {
    const label = shortenUrl('https://x.dev/a/b/' + 'seg'.repeat(30), 30);
    expect(label.startsWith('x.dev/…/')).toBe(true);
    expect(label).toContain('…');
    expect(label.length).toBeLessThanOrEqual(30);
  });

  it('leaves an already-short URL alone apart from the scheme and www.', () => {
    expect(shortenUrl('https://x.dev/a')).toBe('x.dev/a');
    expect(shortenUrl('https://www.x.dev/a')).toBe('x.dev/a');
    expect(shortenUrl('https://x.dev/a?b=c')).toBe('x.dev/a?b=c');
  });

  it('drops a trailing slash so the bare host reads cleanly', () => {
    expect(shortenUrl('https://x.dev/')).toBe('x.dev');
  });

  it('never exceeds the caller\'s budget, at any budget, for any shape', () => {
    const urls = [
      LONG_URL,
      'https://x.dev',
      'https://x.dev/' + 'a'.repeat(300),
      'https://' + 'sub.'.repeat(20) + 'x.dev/a/b/c',
      'https://x.dev/a/b/c/d/e/f/g?q=1&r=2#frag',
      'https://x.dev/a#' + 'h'.repeat(100),
    ];
    for (const url of urls) {
      for (const max of [8, 16, 24, 34, 40, 56, 120]) {
        expect(shortenUrl(url, max).length, `${url} @${max}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it('degrades instead of throwing on non-parseable input (runs during render)', () => {
    for (const bad of ['', 'http://', 'not a url', 'https://[oops']) {
      expect(() => shortenUrl(bad)).not.toThrow();
      expect(shortenUrl(bad, 20).length).toBeLessThanOrEqual(20);
    }
  });

  it('signals an elided hash even when the path already fits', () => {
    expect(shortenUrl('https://x.dev/a/b#' + 'h'.repeat(80), 30)).toContain('#…');
  });
});
