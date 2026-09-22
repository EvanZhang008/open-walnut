/**
 * Finding the unsubscribe link a newsletter only put in its own footer.
 *
 * This is the ONLY path an account whose transport hands over no headers ever has, so it has to work
 * on ordinary marketing markup: tables, tracking urls, an image standing in for the word. And it runs
 * on every body the cache stores, on markup a stranger wrote, inside the server process — so the
 * three properties graded here are recall, restraint and cost.
 *
 * - RESTRAINT: `View in browser` is not an unsubscribe link, and a `mailto:` footer link is the header
 *   path's business, not a candidate here. Counting either would make `bodyCandidates` claim this
 *   message is ambiguous when it is not.
 * - COST: the scan is capped at 256 KB, which is what keeps a 2 MB image-heavy newsletter under a
 *   millisecond. The perf assertion at the end is the ratchet on that.
 *
 * Every fixture is invented markup in the shape real newsletters use.
 */
import { describe, expect, it } from 'vitest';
import {
  extractUnsubscribeLink,
  unsubscribeFromBodyHtml,
  LINK_SCAN_BYTES,
} from '../../src/integrations/mail/unsubscribe-link.js';
import type { StoredListUnsubscribe } from '../../src/integrations/mail/service-dto.js';

const FOOTER = `
<table width="100%"><tr><td align="center">
  <p style="font-size:11px;color:#888">
    You are receiving this because you signed up at the marina.
    <a href="https://track.example.invalid/c/9f2/view">View in browser</a> &middot;
    <a href="https://track.example.invalid/c/9f2/prefs">Manage preferences</a> &middot;
    <a href="https://track.example.invalid/c/9f2/unsub?t=ab12">Unsubscribe</a>
  </p>
</td></tr></table>
`;

describe('the anchors a footer offers', () => {
  it('takes the first matching https link and counts the distinct ones', () => {
    // `Manage preferences` matches and comes first in the markup; `View in browser` does not match.
    expect(extractUnsubscribeLink(FOOTER)).toEqual({
      link: 'https://track.example.invalid/c/9f2/prefs',
      candidates: 2,
    });
  });

  it('finds nothing in a body that says nothing about leaving', () => {
    expect(extractUnsubscribeLink('<p>Hello. <a href="https://example.invalid/a">Read more</a></p>'))
      .toEqual({ candidates: 0 });
  });

  it('counts no candidate for a footer whose only exit is a mailto', () => {
    // The header path owns mailto (RFC 8058 has a field for it); a link this module would never fetch
    // must not make the message look ambiguous.
    const found = extractUnsubscribeLink(
      '<p><a href="mailto:leave@lists.example.invalid?subject=unsubscribe">Unsubscribe</a></p>',
    );
    expect(found).toEqual({ candidates: 0 });
    expect(found.link).toBeUndefined();
  });

  it('refuses an http link, which the guard would refuse anyway', () => {
    expect(extractUnsubscribeLink('<a href="http://lists.example.invalid/u">Unsubscribe</a>'))
      .toEqual({ candidates: 0 });
  });

  it.each([
    ['opt out', '<a href="https://x.example.invalid/1">Opt out of these emails</a>'],
    ['opt-out', '<a href="https://x.example.invalid/1">opt-out</a>'],
    ['optout', '<a href="https://x.example.invalid/1">OPTOUT</a>'],
    ['manage preferences', '<a href="https://x.example.invalid/1">Manage Preferences</a>'],
    ['unsubscribing', '<a href="https://x.example.invalid/1">unsubscribing is easy</a>'],
    ['an image alt', '<a href="https://x.example.invalid/1"><img src="u.png" alt="Unsubscribe"></a>'],
    ['a title attribute', '<a title="Unsubscribe" href="https://x.example.invalid/1">here</a>'],
    ['an aria-label', '<a aria-label="opt out" href="https://x.example.invalid/1">&nbsp;</a>'],
    ['nested markup', '<a href="https://x.example.invalid/1"><span><b>Un</b>subscribe</span></a>'],
    ['single quotes', "<a href='https://x.example.invalid/1'>Unsubscribe</a>"],
    ['no quotes', '<a href=https://x.example.invalid/1>Unsubscribe</a>'],
    ['upper-case scheme', '<a href="HTTPS://x.example.invalid/1">Unsubscribe</a>'],
  ])('finds the link behind %s', (_what, markup) => {
    expect(extractUnsubscribeLink(markup).link?.toLowerCase())
      .toBe('https://x.example.invalid/1');
  });

  it('does not count the same url twice, however many words point at it', () => {
    const markup = `
      <a href="https://x.example.invalid/u">Unsubscribe</a>
      <a href="https://x.example.invalid/u">unsubscribe here</a>
      <a href="https://x.example.invalid/u"><img alt="opt out"></a>
    `;
    expect(extractUnsubscribeLink(markup)).toEqual({ link: 'https://x.example.invalid/u', candidates: 1 });
  });

  it('judges only the label, never the target, so a tracking token cannot invent a match', () => {
    const markup = '<a href="https://track.example.invalid/unsubscribe/x">Read this week\'s issue</a>';
    expect(extractUnsubscribeLink(markup)).toEqual({ candidates: 0 });
  });

  it('refuses an absurdly long url rather than storing it', () => {
    const long = `https://x.example.invalid/${'a'.repeat(2_100)}`;
    expect(extractUnsubscribeLink(`<a href="${long}">Unsubscribe</a>`)).toEqual({ candidates: 0 });
  });

  it('stops counting past a handful of candidates: past that it is ambiguous either way', () => {
    const markup = Array.from({ length: 30 }, (_one, index) =>
      `<a href="https://x.example.invalid/u/${index}">Unsubscribe</a>`).join('\n');
    const found = extractUnsubscribeLink(markup);
    expect(found.link).toBe('https://x.example.invalid/u/0');
    expect(found.candidates).toBeGreaterThan(1);
    expect(found.candidates).toBeLessThanOrEqual(8);
  });

  it('only looks at the first 256 KB', () => {
    const padded = `${'<p>filler</p>'.repeat(30_000)}<a href="https://x.example.invalid/u">Unsubscribe</a>`;
    expect(padded.length).toBeGreaterThan(LINK_SCAN_BYTES);
    expect(extractUnsubscribeLink(padded)).toEqual({ candidates: 0 });
  });
});

describe('what the body read is allowed to store', () => {
  const HEADERS: StoredListUnsubscribe = {
    https: ['https://lists.example.invalid/u/abc'],
    oneClick: true,
    listId: 'weekly.lists.example.invalid',
  };

  it('scans nothing when the headers already named an https url', () => {
    // The sender's own answer stands, and scanning would only invite the two to disagree.
    expect(unsubscribeFromBodyHtml(HEADERS, FOOTER)).toBe(HEADERS);
  });

  it('scans nothing when the headers named a mailto', () => {
    const held: StoredListUnsubscribe = { mailto: ['mailto:leave@lists.example.invalid'], oneClick: false };
    expect(unsubscribeFromBodyHtml(held, FOOTER)).toBe(held);
  });

  it('DOES scan when the capture holds only a list key: a key is not a way out', () => {
    const held: StoredListUnsubscribe = { oneClick: false, listId: 'weekly.lists.example.invalid' };
    expect(unsubscribeFromBodyHtml(held, FOOTER)).toEqual({
      oneClick: false,
      listId: 'weekly.lists.example.invalid',
      bodyLink: 'https://track.example.invalid/c/9f2/prefs',
      bodyCandidates: 2,
    });
  });

  it('builds the whole field for a message that had nothing at all', () => {
    expect(unsubscribeFromBodyHtml(undefined, FOOTER)).toEqual({
      oneClick: false,
      bodyLink: 'https://track.example.invalid/c/9f2/prefs',
      bodyCandidates: 2,
    });
  });

  it('leaves the held value alone when the markup offers nothing', () => {
    expect(unsubscribeFromBodyHtml(undefined, '<p>No footer at all.</p>')).toBeUndefined();
    const held: StoredListUnsubscribe = { oneClick: false, listId: 'x' };
    expect(unsubscribeFromBodyHtml(held, '<p>No footer at all.</p>')).toBe(held);
  });

  it('leaves the held value alone for a body with no html half', () => {
    expect(unsubscribeFromBodyHtml(undefined, undefined)).toBeUndefined();
    expect(unsubscribeFromBodyHtml(undefined, '')).toBeUndefined();
  });
});

describe('cost', () => {
  it('scans a two-megabyte newsletter in under 5ms', () => {
    // Real shape: a wall of tables and inline base64, with the footer at the very end.
    const block = '<table><tr><td><img src="data:image/png;base64,'
      + 'iVBORw0KGgoAAAANSUhEUg'.repeat(20)
      + '"><p>This week in the marina, with pictures.</p></td></tr></table>';
    let html = '';
    while (html.length < 2 * 1024 * 1024) html += block;
    html += FOOTER;
    expect(html.length).toBeGreaterThan(2 * 1024 * 1024);

    // Warm the regex engine, then measure the median of a few runs: a single cold run on a loaded
    // machine measures the JIT, not the scan.
    extractUnsubscribeLink(html);
    const runs: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = performance.now();
      extractUnsubscribeLink(html);
      runs.push(performance.now() - started);
    }
    runs.sort((left, right) => left - right);
    expect(runs[2]!).toBeLessThan(5);
  });
});
