/**
 * A bare link in a card's few lines reads as a short label (web/src/utils/short-link-labels.ts).
 * 2026-11-21, UI audit: a review URL and two local paths written out whole wrapped over several
 * lines of a Needs you card and pushed its choices out of view.
 *
 * Run through the real renderer, so a change to how it writes anchors (the class this guards: every
 * kind of link it makes from bare words) breaks here, not silently in the card.
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { shortLinkLabel, shortLinkLabelsHtml, shortPath } from '@/utils/short-link-labels';

function anchors(html: string): { text: string; title: string | null; attrs: string }[] {
  const out: { text: string; title: string | null; attrs: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)) {
    out.push({ attrs: m[1], text: m[2], title: /\btitle="([^"]*)"/.exec(m[1])?.[1] ?? null });
  }
  return out;
}

const LONG_PATH = '/Users/someone/.local/state/open-walnut/tasks/b89f10f0-bdd0-5134/design-t3/index.html';
const LONG_URL = 'https://reviews.example.com/projects/acme/changes/CR-321440753/revisions/2';

describe('short link labels in a card', () => {
  it('every kind of bare link the renderer makes reads short and keeps its target', () => {
    const cases: { text: string; full: string; label: RegExp }[] = [
      { text: `The designs are at ${LONG_PATH}, take a look.`, full: LONG_PATH, label: /^…\/design-t3\/index\.html$/ },
      { text: `Video: ${LONG_PATH.replace('index.html', 'video/d1.mp4')}`, full: LONG_PATH.replace('index.html', 'video/d1.mp4'), label: /^…\/video\/d1\.mp4$/ },
      { text: `Review here: ${LONG_URL}`, full: LONG_URL, label: /^reviews\.example\.com\/.*…/ },
      { text: `<${LONG_URL}>`, full: LONG_URL, label: /^reviews\.example\.com\// },
      { text: `[${LONG_URL}](${LONG_URL})`, full: LONG_URL, label: /^reviews\.example\.com\// },
      // A path in backticks: the renderer links it inside its code span.
      { text: `See \`${LONG_PATH}\` now`, full: LONG_PATH, label: /^…\/design-t3\/index\.html$/ },
      // A URL with a query: its &amp; is read as & and written back once.
      { text: `Open ${LONG_URL}?from=card&step=2`, full: `${LONG_URL}?from=card&amp;step=2`, label: /^reviews\.example\.com\// },
    ];
    for (const c of cases) {
      const before = renderMarkdownWithRefs(c.text, undefined, undefined, { inline: true });
      const after = shortLinkLabelsHtml(before);
      const [a] = anchors(after);
      expect(a, c.text).toBeTruthy();
      expect(a.text.length, c.text).toBeLessThanOrEqual(40);
      expect(a.text, c.text).toMatch(c.label);
      expect(a.title, c.text).toBe(c.full);
      // Where it goes is unchanged: the anchor's own attributes are kept as written.
      const [orig] = anchors(before);
      expect(a.attrs.startsWith(orig.attrs), c.text).toBe(true);
    }
  });

  it('a link with its own words, and a short one, stays as written', () => {
    for (const text of [`[Open designs](${LONG_URL})`, 'See https://example.com/a', 'Path /tmp/x/y.png here']) {
      const html = renderMarkdownWithRefs(text, undefined, undefined, { inline: true });
      expect(shortLinkLabelsHtml(html)).toBe(html);
    }
  });

  it('a link that has a title keeps it, and the label is written escaped', () => {
    const html = `<a href="#" class="file-link" title="Open the page" data-file-path="${LONG_PATH}">${LONG_PATH}</a>`;
    const out = shortLinkLabelsHtml(html);
    expect(out.match(/title="/g)?.length).toBe(1);
    expect(out).toContain('title="Open the page"');
    expect(out).toContain('>…/design-t3/index.html</a>');
    expect(shortLinkLabelsHtml(`<a href="#" data-title="x">${LONG_PATH}</a>`)).toContain(`title="${LONG_PATH}"`);
  });

  it('labels', () => {
    expect(shortLinkLabel('not a link at all but long enough to count as words')).toBeNull();
    expect(shortPath('/a/b/c/averyveryveryveryveryveryverylongfilename-of-a-thing.mp4').length).toBeLessThanOrEqual(40);
    // A long folder is cut in its middle, never dropped for the bare file name.
    expect(shortPath('/w/projects/walnut/design/long-folder-name-for-the-pages/index.html')).toMatch(/^…\/long-fold.+pages\/index\.html$/);
  });
});
