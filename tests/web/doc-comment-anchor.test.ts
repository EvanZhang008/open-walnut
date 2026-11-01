/**
 * A doc comment shows on the same words in the rendered view and in the source
 * (web/src/utils/doc-comment-anchor.ts): a quote picked in one view is found in
 * the other's text across the markup only one of them shows.
 */
import { describe, it, expect } from 'vitest';
import { docTextLocator, hasMarkup, markdownOnlySpans } from '@/utils/doc-comment-anchor';
import { quoteFromText } from '@/utils/text-quote-anchor';

const SOURCE = [
  '# Cache runbook',
  '',
  'When the cache is **cold**, warm it with the `warm` job before traffic.',
  'See [the guide](./guide.md "Guide") for the full list of steps.',
  '',
  '1. Drain the old node',
  '2. Start the new node',
  '- [x] Verify the graphs',
  '',
  '```bash',
  'cache warm --all',
  '```',
  '',
  'Fish &amp; chips are <em>always</em> served hot.',
  '| Key | Value |',
  '| --- | ----- |',
  '| ttl | 30s   |',
].join('\n');

// What the rendered view's DOM text reads: block texts concatenated, no markup.
const RENDERED = [
  'Cache runbook',
  'When the cache is cold, warm it with the warm job before traffic.',
  'See the guide for the full list of steps.',
  'Drain the old node',
  'Start the new node',
  'Verify the graphs',
  'cache warm --all',
  'Fish & chips are always served hot.',
  'KeyValuettl30s',
].join('');

function quoteIn(text: string, words: string) {
  const at = text.indexOf(words);
  if (at < 0) throw new Error(`fixture: ${words}`);
  return quoteFromText(text, at, at + words.length)!;
}

function found(text: string, quote: ReturnType<typeof quoteIn>, markup = true) {
  const at = docTextLocator(text, markup).locate(quote);
  return at ? text.slice(at.start, at.end) : null;
}

describe('doc comment anchors across views', () => {
  it('a comment from the rendered view lands on the same words in the source', () => {
    expect(found(SOURCE, quoteIn(RENDERED, 'cache is cold, warm it'))).toBe('cache is **cold**, warm it');
    expect(found(SOURCE, quoteIn(RENDERED, 'the guide for the full'))).toBe('the guide](./guide.md "Guide") for the full');
    expect(found(SOURCE, quoteIn(RENDERED, 'old nodeStart the new'))).toBe('old node\n2. Start the new');
    expect(found(SOURCE, quoteIn(RENDERED, 'Fish & chips are always'))).toBe('Fish &amp; chips are <em>always');
    expect(found(SOURCE, quoteIn(RENDERED, 'ttl30s'))).toBe('ttl | 30s');
  });

  it('a comment from the source lands on the same words in the rendered view', () => {
    expect(found(RENDERED, quoteIn(SOURCE, 'is **cold**, warm'))).toBe('is cold, warm');
    expect(found(RENDERED, quoteIn(SOURCE, '[the guide](./guide.md "Guide") for'))).toBe('the guide for');
    expect(found(RENDERED, quoteIn(SOURCE, 'Drain the old node\n2. Start'))).toBe('Drain the old nodeStart');
    expect(found(RENDERED, quoteIn(SOURCE, '- [x] Verify the graphs'))).toBe('Verify the graphs');
    // A selection that cut a link in half still finds its words.
    expect(found(RENDERED, quoteIn(SOURCE, 'guide](./guide.md "Guide") for the'))).toBe('guide for the');
  });

  it('the same view finds its own words exactly, as before', () => {
    expect(found(SOURCE, quoteIn(SOURCE, '**cold**'))).toBe('**cold**');
    expect(found(RENDERED, quoteIn(RENDERED, 'warm job'))).toBe('warm job');
  });

  it('picks the occurrence its context names, in the other view too', () => {
    const src = 'Step one: restart the **node** now.\n\nStep two: restart the **node** later.';
    const ren = 'Step one: restart the node now.Step two: restart the node later.';
    expect(docTextLocator(src, true).locate(quoteIn(ren, 'two: restart the node later'))).toEqual({
      start: src.indexOf('two:'), end: src.indexOf(' later.') + ' later'.length,
    });
  });

  it('a repeated word goes to the copy its context names, though the raw context holds markup', () => {
    const src = 'Keep the **data** model small.\n\nMove the data **model** later.'
    const ren = 'Keep the data model small.Move the data model later.'
    // Picked in the rendered view: the second "data" (raw prefix "Move the " vs "Move the ").
    const second = quoteFromText(ren, ren.lastIndexOf('data'), ren.lastIndexOf('data') + 4)!
    expect(docTextLocator(src, true).locate(second)).toEqual({ start: src.lastIndexOf('data'), end: src.lastIndexOf('data') + 4 })
    // Picked in the rendered view: the first "data" (raw prefix "Keep the " vs "Keep the **").
    const first = quoteFromText(ren, ren.indexOf('data'), ren.indexOf('data') + 4)!
    expect(docTextLocator(src, true).locate(first)).toEqual({ start: src.indexOf('data'), end: src.indexOf('data') + 4 })
    // And back: the source's second "data" lands on the rendered second one.
    const back = quoteFromText(src, src.lastIndexOf('data'), src.lastIndexOf('data') + 4)!
    expect(docTextLocator(ren, true).locate(back)).toEqual({ start: ren.lastIndexOf('data'), end: ren.lastIndexOf('data') + 4 })
  })

  it('a link target with parens, and a "2." inside a line that is no list marker', () => {
    const src = 'Read [the page](https://example.com/Foo_(bar)) before you start.'
    expect(found('Read the page before you start.', quoteIn(src, 'the page](https://example.com/Foo_(bar)) before'))).toBe('the page before')
    const ver = 'Release 2. Then roll out the **new** build.'
    const verRen = 'Release 2. Then roll out the new build.'
    expect(found(ver, quoteIn(verRen, '2. Then roll out the new'))).toBe('2. Then roll out the **new')
  })

  it('words that are gone are not found, and a few letters never match inside a word', () => {
    expect(found(SOURCE, { exact: 'the warm-up script', prefix: 'with ', suffix: ' before' })).toBeNull();
    // "ld,w" appears loose inside "cold**, warm"; with no agreeing context it is not taken.
    expect(found(SOURCE, { exact: 'ld,w', prefix: 'zzzz', suffix: 'qqqq' })).toBeNull();
  });

  it('CJK letters count as words (test data as escapes)', () => {
    const src = 'Note: \u7f13\u5b58 **\u9884\u70ed** \u4e4b\u540e\u518d\u5f00\u653e\u3002';
    const ren = 'Note: \u7f13\u5b58 \u9884\u70ed \u4e4b\u540e\u518d\u5f00\u653e\u3002';
    expect(found(src, quoteIn(ren, '\u7f13\u5b58 \u9884\u70ed \u4e4b\u540e'))).toBe('\u7f13\u5b58 **\u9884\u70ed** \u4e4b\u540e');
  });

  it('only marked-up docs mask their syntax', () => {
    expect(hasMarkup('/a/design.md')).toBe(true);
    expect(hasMarkup('/a/page.HTML')).toBe(true);
    expect(hasMarkup('/a/main.ts')).toBe(false);
    // In plain code a "<T>" is text, not a tag: matched as written.
    expect(found('const x = f<Item>(a);', { exact: 'f<Item>(a)' }, false)).toBe('f<Item>(a)');
    const html = 'see <b>bold</b> and <https://example.com>';
    expect(markdownOnlySpans(html).map(([a, b]) => html.slice(a, b))).toEqual(['<b>', '</b>']);
  });
});
