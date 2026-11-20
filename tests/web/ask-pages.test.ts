/**
 * A task's asks are pages, one shown at a time (web/src/components/actions/ask-pages.ts; 2026-11-20,
 * the user: "also should max shoudl 1 decision, and can left and right", then "each quesiton is jsut
 * left and right, and each quesiton it selse have options, and titme and descirption, don't mix
 * them"). The page logic, and the source rules that keep every place on one page at a time:
 *   - the block draws ONE AskCard, never a list of them, and no "N more" expander
 *   - each page is answered on its own: no card sends several asks' answers in one go
 *   - its arrows have names, and the place is said through one live line that stays
 *   - an answered page stays, marked, until no open ask is left; a later ask starts afresh
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionItem } from '@open-walnut/user-status';
import { anyOpen, pageIndex, pagesOf, type AnsweredAsk } from '../../web/src/components/actions/ask-pages';

const WEB = join(__dirname, '../../web/src/components/actions');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const item = (id: string, kind: ActionItem['kind'] = 'ask'): ActionItem => ({ id, kind, summary: `Question ${id}?` } as ActionItem);
const answered = (it: ActionItem, index: number, peers: string[], said?: string): AnsweredAsk => ({ item: it, index, peers, ...(said ? { said } : {}) });

describe('ask pages', () => {
  const [a, b, c] = [item('a', 'letter'), item('b', 'ask'), item('c', 'choice')];

  it('a page answered here keeps its place after the status drops it', () => {
    const marks = { a: answered(a, 0, ['b', 'c'], 'Water at dawn') };
    expect(pagesOf([b, c], marks).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(pagesOf([a, b, c], marks).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    // In the middle, and past the end of a shorter list.
    expect(pagesOf([a, c], { b: answered(b, 1, ['a', 'c']) }).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(pagesOf([a], { c: answered(c, 2, ['a', 'b']) }).map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('an answered page leaves with the asks it was shown with: a later ask starts afresh', () => {
    const later = item('d');
    expect(pagesOf([later], { a: answered(a, 0, ['b', 'c']) }).map((p) => p.id)).toEqual(['d']);
    expect(pagesOf([], { a: answered(a, 0, ['b']) })).toEqual([]);
  });

  it('the page shown: the kept one, else the one now at its place, never past the end', () => {
    expect(pageIndex(['a', 'b', 'c'], undefined)).toBe(0);
    expect(pageIndex(['a', 'b', 'c'], { id: 'c', index: 2 })).toBe(2);
    // Reordered by a push: it follows its ask.
    expect(pageIndex(['c', 'a', 'b'], { id: 'b', index: 1 })).toBe(2);
    // Its ask left: the one now at its place, or the last.
    expect(pageIndex(['a', 'c'], { id: 'b', index: 1 })).toBe(1);
    expect(pageIndex(['a'], { id: 'c', index: 2 })).toBe(0);
    expect(pageIndex([], { id: 'a', index: 0 })).toBe(0);
  });

  it('with every page answered there is nothing to show', () => {
    expect(anyOpen([a, b], { a: answered(a, 0, ['b']) })).toBe(true);
    expect(anyOpen([a, b], { a: answered(a, 0, ['b']), b: answered(b, 1, ['a']) })).toBe(false);
  });
});

describe('the block shows one ask at a time', () => {
  const block = read('ActionNeeded.tsx');
  const body = /export const ActionNeeded = memo\(function ActionNeeded[\s\S]*$/.exec(block)?.[0] ?? '';

  it('draws one AskCard, from its pages, with no list and no "N more"', () => {
    expect(body).toMatch(/useAskPages\(task\.id, items\)/);
    expect(body.match(/<AskCard\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/\.map\([^)]*\)\s*=>\s*\(?\s*<AskCard\b/);
    expect(block).not.toMatch(/action-needed-more|STRIP_LINES|restShown/);
  });

  it('its arrows have names, and its place is said through one live line that stays', () => {
    const pager = read('AskPager.tsx');
    expect(pager).toMatch(/aria-label="Previous decision"/);
    expect(pager).toMatch(/aria-label="Next decision"/);
    expect(body).toMatch(/aria-live="polite"[^>]*>\s*\{count > 1 \? `Decision \$\{index \+ 1\} of \$\{count\}`/);
    // The live line is outside the keyed card, so it is not made anew on each page.
    expect(body.indexOf('aria-live="polite"')).toBeLessThan(body.indexOf('<AskCard'));
  });

  it('each page answers on its own: an answer marks its own ask, never several', () => {
    expect(body).toMatch(/book\.answer\(item, said\)/);
    expect(body).not.toMatch(/pages\.(forEach|map)\([^)]*\)\s*=>\s*book\.answer/);
    expect(read('ask-pages.ts')).toMatch(/answered: \{ \.\.\.now\.answered, \[item\.id\]:/);
  });
});
