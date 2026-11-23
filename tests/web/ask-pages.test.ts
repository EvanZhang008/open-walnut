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
import { anyOpen, liveMarks, pageIndex, pagesOf, type AnsweredAsk } from '../../web/src/components/actions/ask-pages';

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

  it('a place that leaves some asks out never gets them back as kept pages', () => {
    // The session's top leaves out the asks that are threads; one answered on the row stays out there.
    const notThreads = (it: ActionItem) => it.id !== 'a';
    expect(pagesOf([b, c], { a: answered(a, 0, ['b', 'c'], 'Water at dawn') }, notThreads).map((p) => p.id)).toEqual(['b', 'c']);
    expect(pagesOf([c], { b: answered(b, 1, ['a', 'c']) }, notThreads).map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('a mark holds only for the ask it answered: reworded, or asked again after it left, it is open', () => {
    const mark = answered(a, 0, ['b'], 'Publish');
    expect(Object.keys(liveMarks([a, b], { a: mark }))).toEqual(['a']);
    // Still gone from the status: kept.
    expect(Object.keys(liveMarks([b], { a: { ...mark, gone: true } }))).toEqual(['a']);
    // The same id with new words.
    expect(liveMarks([{ ...a, summary: 'Publish it on Monday?' }, b], { a: mark })).toEqual({});
    expect(liveMarks([{ ...a, detail: 'Now with the photos.' } as ActionItem, b], { a: mark })).toEqual({});
    // The same id back after the status dropped it.
    expect(liveMarks([a, b], { a: { ...mark, gone: true } })).toEqual({});
    // A single ask reworded: the block shows it open, never an all-answered nothing.
    const reworded = [{ ...a, summary: 'Publish it on Monday?' }];
    expect(anyOpen(pagesOf(reworded, liveMarks(reworded, { a: mark })), liveMarks(reworded, { a: mark }))).toBe(true);
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
    expect(body).toMatch(/useAskPages\(task\.id, task\.user_status\?\.actions \?\? \[\], accepts\)/);
    expect(body.match(/<AskCard\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/\.map\([^)]*\)\s*=>\s*\(?\s*<AskCard\b/);
    expect(block).not.toMatch(/action-needed-more|STRIP_LINES|restShown/);
  });

  it('its arrows have names, and its place is said through one live line that stays', () => {
    const pager = read('AskPager.tsx');
    expect(pager).toMatch(/aria-label="Previous decision"/);
    expect(pager).toMatch(/aria-label="Next decision"/);
    expect(body).toMatch(/aria-live="polite"[^>]*>\s*\{count > 1 \? `Decision \$\{index \+ 1\} of \$\{count\}/);
    // The live line is outside the keyed card, so it is not made anew on each page.
    expect(body.indexOf('aria-live="polite"')).toBeLessThan(body.indexOf('<AskCard'));
  });

  it('a late failure never pulls him off the page he is on, and the place says what was not sent', () => {
    const pages = read('ask-pages.ts');
    const reopen = /const reopen = useLeanCallback\([\s\S]*?\}, \[\]\);/.exec(pages)?.[0] ?? '';
    expect(reopen).toMatch(/write\(\{ \.\.\.now, answered: rest \}\)/);
    expect(reopen).not.toMatch(/at:/);
    expect(body).toMatch(/<AskPager index=\{index\} count=\{count\} unsent=\{unsent\}/);
    expect(read('AskPager.tsx')).toMatch(/not sent/);
  });

  it('a swipe pages only for a finger, and never over selected words', () => {
    const pager = read('AskPager.tsx');
    expect(pager).toMatch(/e\.pointerType !== 'touch'/);
    expect(pager).toMatch(/window\.getSelection\(\)\?\.toString\(\)/);
  });

  it('each page answers on its own: an answer marks its own ask, never several', () => {
    expect(body).toMatch(/book\.answer\(item, said\)/);
    expect(body).not.toMatch(/pages\.(forEach|map)\([^)]*\)\s*=>\s*book\.answer/);
    expect(read('ask-pages.ts')).toMatch(/answered: \{ \.\.\.now\.answered, \[item\.id\]:/);
  });
});

describe('a card\'s buttons come before its box', () => {
  // 2026-11-20, the user: "butotn shoudl be before inbox". Every place draws its ask in
  // .ask-card-answer (ask-card.css), so one order rule holds for all of them.
  const css = readFileSync(join(WEB, 'ask-card.css'), 'utf8');
  const orderOf = (sel: RegExp) => Number((css.match(sel) ?? [])[1]);
  it('the buttons\' order is below the box\'s, and the pager and Snooze come after the box', () => {
    const words = orderOf(/\.ask-card-answer \.org-answer-words \{ order: (\d+);/);
    const buttons = orderOf(/\.ask-card-answer :is\(\.btn, \.org-answer-check, \.approval-actions\):not\([^)]*\)[^{]*\{ order: (\d+);/);
    const tools = orderOf(/\.ask-card-answer \.ask-card-tools \{ order: (\d+);/);
    expect(buttons).toBeLessThan(words);
    expect(tools).toBeGreaterThan(words);
  });
});

describe('the phone draws the same card, one page at a time', () => {
  const swift = readFileSync(join(__dirname, '../../ios-native/Walnut/Views/Tasks/ActionNeededView.swift'), 'utf8');

  it('one page from ActionNeededModel.pages, never a list of every ask', () => {
    expect(swift).toMatch(/ActionNeededModel\.pages\(items, answered: marks\)/);
    expect(swift).toMatch(/ActionNeededModel\.liveMarks\(items, answered: answered\)/);
    expect(swift).not.toMatch(/ForEach\(shown\)/);
    expect(swift).toMatch(/line\(item, index: index, count: pages\.count\)/);
  });

  it('pages by its arrows only: no swipe until one is proven not to set off the row\'s own swipes', () => {
    // A full swipe right on a board row marks its task Done (BoardRowGestures), and a leftward drag
    // closes the Tasks drawer: a page swipe on the card must not reach either (not proven yet).
    expect(swift).not.toMatch(/DragGesture/);
    expect(swift).toMatch(/swipe \(the web's\) waits until it is\s*\n\s*\/\/ proven on the simulator/);
  });

  it('its arrows have names and the place is said', () => {
    expect(swift).toMatch(/accessibilityLabel\("Previous decision"\)/);
    expect(swift).toMatch(/accessibilityLabel\("Next decision"\)/);
    expect(swift).toMatch(/AccessibilityNotification\.Announcement\(ActionNeededModel\.placeText/);
  });

  it('the look: frosted, 18pt continuous corners, a hairline, the dot, quiet keys', () => {
    expect(swift).toMatch(/\.background\(\.ultraThinMaterial, in: RoundedRectangle\(cornerRadius: Self\.corner, style: \.continuous\)\)/);
    expect(swift).toMatch(/private static let corner: CGFloat = 18/);
    expect(swift).toMatch(/\.strokeBorder\(Color\.primary\.opacity/);
    expect(swift).toMatch(/Circle\(\)[\s\S]{0,200}Theme\.warning[\s\S]{0,200}\.frame\(width: 7, height: 7\)/);
    expect(swift).not.toMatch(/\.buttonStyle\(\.bordered(Prominent)?\)/);
  });

  it('an answered page stays marked; a failed one opens again', () => {
    expect(swift).not.toMatch(/sent\.insert|sent\.remove/);
    expect(swift).toMatch(/markAnswered\(item, said: o\.label\)/);
    expect(swift).toMatch(/reopen\(item\)/);
  });
});

describe('the phone\'s cards take the button family (2026-11-21, the user: "2 is good")', () => {
  // The web's ask-card.css and "The button family" in walnut-ui-requirements/standard.md: options
  // as full-width rows, the recommended one blue, at most one blue key a card, every other key
  // grey, the box under the keys, then the tools (pager, Snooze, pin) at the right.
  const IOS = join(__dirname, '../../ios-native/Walnut');
  const family = readFileSync(join(IOS, 'Views/Shared/AskCardKeys.swift'), 'utf8');
  const ask = readFileSync(join(IOS, 'Views/Tasks/ActionNeededView.swift'), 'utf8');
  const threads = readFileSync(join(IOS, 'Views/Org/OrgThreadsView.swift'), 'utf8');
  const card = /struct OrgThreadCard: View \{[\s\S]*?\n\}\n/.exec(threads)?.[0] ?? '';

  it('one home for the look: the keys, the option rows, Snooze', () => {
    expect(family).toMatch(/struct AskChipStyle: ButtonStyle \{\s*var main = false/);
    expect(family).toMatch(/struct AskOptionStyle: ButtonStyle \{\s*var recommended = false/);
    expect(family).toMatch(/\.frame\(maxWidth: \.infinity, minHeight: AskCardKeys\.height, alignment: \.leading\)/);
    expect(family).toMatch(/strokeBorder\(Color\(uiColor: \.separator\)/);
    expect(family).toMatch(/static let corner: CGFloat = 8/);
    expect(family).toMatch(/main \? Theme\.askAccent/);
    expect(family).toMatch(/recommended \? Theme\.askAccent/);
    expect(family).toMatch(/\.lineLimit\(1\)\s*\.truncationMode\(\.tail\)/);
    expect(family).toMatch(/Image\(systemName: "chevron\.down"\)/);
    expect(readFileSync(join(IOS, 'Views/Shared/ReplyBox.swift'), 'utf8')).toMatch(/cornerRadius: AskCardKeys\.corner/);
    for (const src of [ask, card]) expect(src).not.toMatch(/struct Ask\w+Style: ButtonStyle/);
  });

  it('options are rows, and each card has at most one blue key', () => {
    expect(ask).toMatch(/\.buttonStyle\(AskOptionStyle\(recommended: o\.recommended == true\)\)/);
    expect(card).toMatch(/\.buttonStyle\(AskOptionStyle\(recommended: o\.recommended == true\)\)/);
    expect(ask.match(/AskChipStyle\(main: true\)/g)).toHaveLength(1);
    expect(card.match(/AskChipStyle\(main: true\)/g)).toHaveLength(1);
    expect(card).toMatch(/onEdit\(\.acknowledge\)[^\n]*\n\s*\.buttonStyle\(AskChipStyle\(main: true\)\)/);
    expect(card).not.toMatch(/\.buttonStyle\(\.bordered(Prominent)?\)/);
  });

  it('the order: options and keys, then the box, then the tools', () => {
    const body = /private var card: some View \{[\s\S]*?\n {8}\}\n/.exec(card)?.[0] ?? '';
    const at = (s: string) => body.indexOf(s);
    expect(at('optionButtons')).toBeGreaterThan(-1);
    expect(at('optionButtons')).toBeLessThan(at('\n            keys\n'));
    expect(at('\n            keys\n')).toBeLessThan(at('followUpBox'));
    expect(at('followUpBox')).toBeLessThan(at('\n            tools\n'));
    // The watch eye is a tool on the last line, never in the header.
    const header = /private var headerButtons: some View \{[\s\S]*?\n {4}\}\n/.exec(card)?.[0] ?? '';
    expect(header).not.toMatch(/org\.thread\.(watch|pin)/);
    expect(card).toMatch(/snoozeMenu\s*\n\s*watchButton/);
    const line = /\} else \{\s*\/\/ Its options or key first[\s\S]*?tools\(item, index: index, count: count\)/.exec(ask)?.[0] ?? '';
    expect(line.indexOf('answer(item)')).toBeGreaterThan(-1);
    expect(line.indexOf('answer(item)')).toBeLessThan(line.indexOf('wordsBox(item)'));
  });
});
