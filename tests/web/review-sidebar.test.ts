/**
 * The fullscreen review sidebar's pure rules (web/src/utils/review-sidebar.ts):
 * when it shows, how its cards stack beside their passages, and the short text
 * a card shows.
 */
import { describe, expect, it } from 'vitest';
import { plainExcerpt, REVIEW_MIN_BOX, reviewGutterOf, reviewSidebarOn, stackReviewCards } from '@/utils/review-sidebar';

const tops = (m: Map<string, number>) => Object.fromEntries(m);

describe('reviewSidebarOn', () => {
  const base = { fullscreen: true, boxWidth: REVIEW_MIN_BOX, conversationMode: true, hasQuestions: true };
  it('fullscreen, Conversation Mode, questions and a wide enough box', () => {
    expect(reviewSidebarOn(base)).toBe(true);
  });
  it('off outside fullscreen, in Tree Mode, without questions, or in a narrow box', () => {
    expect(reviewSidebarOn({ ...base, fullscreen: false })).toBe(false);
    expect(reviewSidebarOn({ ...base, conversationMode: false })).toBe(false);
    expect(reviewSidebarOn({ ...base, hasQuestions: false })).toBe(false);
    expect(reviewSidebarOn({ ...base, boxWidth: REVIEW_MIN_BOX - 1 })).toBe(false);
  });
});

describe('reviewGutterOf', () => {
  it('holds no room with no card on screen, folded or not (no blank column)', () => {
    expect(reviewGutterOf({ available: true, collapsed: false, cards: 0 })).toBeNull();
    expect(reviewGutterOf({ available: true, collapsed: true, cards: 0 })).toBeNull();
    expect(reviewGutterOf({ available: false, collapsed: false, cards: 5 })).toBeNull();
  });
  it('the card column, or the folded bar alone', () => {
    expect(reviewGutterOf({ available: true, collapsed: false, cards: 2 })).toBe('open');
    expect(reviewGutterOf({ available: true, collapsed: true, cards: 2 })).toBe('collapsed');
  });
});

describe('stackReviewCards', () => {
  it('a card sits level with its passage when nothing is in the way', () => {
    expect(tops(stackReviewCards([{ key: 'a', anchor: 40, height: 80 }, { key: 'b', anchor: 400, height: 80 }], 8))).toEqual({ a: 40, b: 400 });
  });

  it('cards close together are pushed down, in passage order, never overlapping', () => {
    const out = stackReviewCards([
      { key: 'c', anchor: 120, height: 60 },
      { key: 'a', anchor: 100, height: 100 },
      { key: 'b', anchor: 110, height: 50 },
    ], 8);
    expect(tops(out)).toEqual({ a: 100, b: 208, c: 266 });
  });

  it('the same passage keeps the input order', () => {
    const out = stackReviewCards([{ key: 'x', anchor: 10, height: 20 }, { key: 'y', anchor: 10, height: 20 }], 4);
    expect(tops(out)).toEqual({ x: 10, y: 34 });
  });

  it('a selected card sits at its passage; the ones above move up to make room', () => {
    const items = [{ key: 'a', anchor: 200, height: 100 }, { key: 'b', anchor: 250, height: 100 }, { key: 'c', anchor: 260, height: 40 }];
    expect(tops(stackReviewCards(items, 8))).toEqual({ a: 200, b: 308, c: 416 });
    expect(tops(stackReviewCards(items, 8, 'b'))).toEqual({ a: 142, b: 250, c: 358 });
  });

  it('with no room above, the cards flow down again from the top', () => {
    const items = [{ key: 'a', anchor: 0, height: 100 }, { key: 'b', anchor: 50, height: 100 }];
    expect(tops(stackReviewCards(items, 8, 'b'))).toEqual({ a: 0, b: 108 });
  });

  it('a passage above the layer (negative) still starts at 0', () => {
    expect(tops(stackReviewCards([{ key: 'a', anchor: -30, height: 20 }], 8))).toEqual({ a: 0 });
  });

  it('twenty-five cards in one long reply stack in order', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, anchor: i * 30, height: 90 }));
    const out = stackReviewCards(items, 8);
    for (let i = 1; i < 25; i++) expect(out.get(`k${i}`)! - out.get(`k${i - 1}`)!).toBe(98);
  });
});

describe('plainExcerpt', () => {
  it('drops markdown marks and folds code', () => {
    expect(plainExcerpt('## Title\n\nSome **bold** and `code`.\n\n```ts\nconst x = 1\n```\nAfter [a link](http://x).', 200))
      .toBe('Title Some bold and code. [code] After a link.');
  });
  it('cuts at the limit with an ellipsis', () => {
    expect(plainExcerpt('one two three four five', 10)).toBe('one two…');
  });
  it('keeps non-ASCII text', () => {
    expect(plainExcerpt('你好 **世界**', 20)).toBe('你好 世界');
  });
});
