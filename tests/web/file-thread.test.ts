/**
 * Questions about a file passage: the pure helpers behind FileThreadLayer.
 */
import { describe, it, expect } from 'vitest';
import { buildThreadTree, threadKeyOf, type ThreadTreeMessage } from '@/utils/thread-tree';
import type { SessionThreadAnchor } from '@/types/session';
import { CARD_GAP, CARD_GROWN_WIDTH, CARD_WIDTH } from '@/utils/thread-card';
import { FILE_CARD_MIN_HEIGHT, fileQuestionMarks, fileQuestionRows, placeFileCard, rectInHost, toHostRect } from '@/utils/file-thread';

const user = (msgId: string, text = `q ${msgId}`): ThreadTreeMessage => ({ role: 'user', msgId, text });
const reply = (msgId: string, text = `a ${msgId}`): ThreadTreeMessage => ({ role: 'assistant', msgId, text });
const anchor = (msgId: string, parent: string, extra: Partial<SessionThreadAnchor> = {}): SessionThreadAnchor =>
  ({ msgId, parent, source: 'selection', at: '2026-10-01T10:00:00Z', ...extra });

describe('fileQuestionMarks', () => {
  const messages = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3'), user('u4'), reply('r4')];
  const inFile = anchor('u2', 'file:/d/cache.md', { quote: { exact: 'late flush' } });
  const otherFile = anchor('u3', 'file:/d/other.md', { quote: { exact: 'late flush' } });
  const inReply = anchor('u4', 'r1', { quote: { exact: 'a u1' } });
  const tree = buildThreadTree(messages, [inFile, otherFile, inReply]);

  it('lists only the questions about THIS file, neutral, with their titles', () => {
    const marks = fileQuestionMarks(tree, new Set(), new Map(), '/d/cache.md');
    expect(marks.map((m) => m.key)).toEqual([threadKeyOf(inFile)]);
    expect(marks[0]).toMatchObject({ parentMsgId: 'file:/d/cache.md', quote: { exact: 'late flush' }, neutral: true, resolved: false, headId: 'u2' });
  });
  it('skips a hidden question and a file with none', () => {
    expect(fileQuestionMarks(tree, new Set([threadKeyOf(inFile)]), new Map(), '/d/cache.md')).toEqual([]);
    expect(fileQuestionMarks(tree, new Set(), new Map(), '/d/none.md')).toEqual([]);
  });
});

describe('placeFileCard', () => {
  const host = { width: 900, height: 700 };
  it('sits below the passage, right edges aligned, at the preferred width, with room to grow', () => {
    const place = placeFileCard({ top: 100, bottom: 120, left: 40, right: 600 }, host);
    expect(place.top).toBe(120 + CARD_GAP);
    expect(place.left).toBe(600 - CARD_WIDTH);
    expect(place.width).toBe(CARD_WIDTH);
    expect(place.maxHeight).toBe(Math.round(host.height * 0.6));
  });
  it('a passage scrolled above the box docks the card at the top; one below docks it, by its foot, at the bottom', () => {
    const high = placeFileCard({ top: -300, bottom: -280, left: 40, right: 600 }, host);
    expect(high.top).toBe(CARD_GAP);
    expect(high.bottom).toBeUndefined();
    const low = placeFileCard({ top: 1200, bottom: 1220, left: 40, right: 600 }, host);
    expect(low.bottom).toBe(CARD_GAP);
    expect(low.maxHeight).toBe(Math.round(host.height * 0.6));
  });
  it('a passage near the bottom of the box: the card hangs over its first line, never on it (2026-11-06, the rendered diff)', () => {
    // The old placement pushed the card up onto the passage to keep 180px in the box.
    const anchor = { top: 560, bottom: 600, left: 40, right: 600 };
    const place = placeFileCard(anchor, host);
    expect(place.bottom).toBe(host.height - (anchor.top - CARD_GAP));
    // Its foot is over the passage, and at full height it stays in the box.
    expect(host.height - place.bottom!).toBeLessThanOrEqual(anchor.top - CARD_GAP);
    expect(place.top).toBeGreaterThanOrEqual(CARD_GAP);
    expect(place.top + place.maxHeight).toBe(anchor.top - CARD_GAP);
    // Expanded: the same foot, all the room above.
    expect(place.grown!.maxHeight).toBe(anchor.top - 2 * CARD_GAP);
    // Room for the smallest card below: under the last line, as before.
    const roomy = placeFileCard({ top: 400, bottom: 420, left: 40, right: 600 }, host);
    expect(roomy.bottom).toBeUndefined();
    expect(roomy.top).toBe(420 + CARD_GAP);
    // Exactly the smallest card's room below still goes below.
    const edge = host.height - CARD_GAP - FILE_CARD_MIN_HEIGHT - CARD_GAP;
    expect(placeFileCard({ top: edge - 20, bottom: edge, left: 40, right: 600 }, host).bottom).toBeUndefined();
    expect(placeFileCard({ top: edge - 19, bottom: edge + 1, left: 40, right: 600 }, host).bottom).toBeDefined();
  });
  it('a small card goes under the passage when its own height fits there (2026-11-06, the rendered diff\'s last lines)', () => {
    // 135px free below: no room for a 180px card, room for a 70px draft.
    const anchor = { top: 517, bottom: 541, left: 40, right: 600 };
    const roomBelow = host.height - (anchor.bottom + CARD_GAP) - CARD_GAP;
    expect(roomBelow).toBe(143);
    const small = placeFileCard(anchor, host, undefined, undefined, 70);
    expect(small.bottom).toBeUndefined();
    expect(small.top).toBe(anchor.bottom + CARD_GAP);
    // It never reaches past the box, and it never sits on the passage.
    expect(small.top + small.maxHeight).toBeLessThanOrEqual(host.height - CARD_GAP);
    expect(small.maxHeight).toBe(roomBelow);
    // Exactly its height of room still goes below; one pixel less goes above.
    expect(placeFileCard(anchor, host, undefined, undefined, roomBelow).bottom).toBeUndefined();
    expect(placeFileCard(anchor, host, undefined, undefined, roomBelow + 1).bottom).toBe(host.height - (anchor.top - CARD_GAP));
    // A card taller than the minimum asks for the minimum only, like no height given.
    expect(placeFileCard(anchor, host, undefined, undefined, 900)).toEqual(placeFileCard(anchor, host));
    // No height (or a useless one): exactly the old placement.
    expect(placeFileCard(anchor, host, undefined, undefined, 0)).toEqual(placeFileCard(anchor, host));
    expect(placeFileCard(anchor, host, undefined, undefined, Number.NaN)).toEqual(placeFileCard(anchor, host));
    expect(placeFileCard(anchor, host).bottom).toBeDefined();
  });
  it('a small card over a passage near the top of the box needs only its own height above', () => {
    // 60px above, 20px below: a 50px card hangs above, its foot over the first line.
    const short = { width: 900, height: 140 };
    const anchor = { top: 76, bottom: 104, left: 40, right: 600 };
    const place = placeFileCard(anchor, short, undefined, undefined, 50);
    expect(place.bottom).toBe(short.height - (anchor.top - CARD_GAP));
    expect(place.top).toBeGreaterThanOrEqual(CARD_GAP);
    // Docking still works: a passage scrolled past either edge keeps its card at that edge.
    expect(placeFileCard({ top: -300, bottom: -280, left: 40, right: 600 }, host, undefined, undefined, 70).top).toBe(CARD_GAP);
    expect(placeFileCard({ top: 1200, bottom: 1220, left: 40, right: 600 }, host, undefined, undefined, 70).bottom).toBe(CARD_GAP);
  });
  it('never leaves the box sideways, and a narrow box gets a card as wide as it allows', () => {
    const right = placeFileCard({ top: 0, bottom: 10, left: 800, right: 1200 }, host);
    expect(right.left + right.width).toBeLessThanOrEqual(host.width - CARD_GAP);
    const left = placeFileCard({ top: 0, bottom: 10, left: 0, right: 100 }, host);
    expect(left.left).toBe(CARD_GAP);
    const narrow = placeFileCard({ top: 0, bottom: 10, left: 0, right: 300 }, { width: 320, height: 700 });
    expect(narrow.width).toBe(320 - 2 * CARD_GAP);
    expect(narrow.left).toBe(CARD_GAP);
  });
  it('a short box: the card takes what is left below the passage, never less than it can show', () => {
    const place = placeFileCard({ top: 100, bottom: 120, left: 0, right: 600 }, { width: 900, height: 300 });
    expect(place.top).toBe(300 - FILE_CARD_MIN_HEIGHT - CARD_GAP);
    expect(place.maxHeight).toBe(FILE_CARD_MIN_HEIGHT);
  });
  it('expanded, the card grows where it is: the same top, wider toward the passage start, all the room below', () => {
    const place = placeFileCard({ top: 100, bottom: 120, left: 40, right: 600 }, host);
    // 900 wide: capped by the view, right edge kept on the passage's when there is room.
    expect(place.grown!.width).toBe(host.width - 2 * CARD_GAP);
    expect(place.grown!.left).toBe(CARD_GAP);
    expect(place.grown!.maxHeight).toBe(host.height - place.top - CARD_GAP);
    const wide = placeFileCard({ top: 100, bottom: 120, left: 40, right: 1300 }, { width: 1400, height: 700 });
    expect(wide.grown!.width).toBe(CARD_GROWN_WIDTH);
    expect(wide.grown!.left + wide.grown!.width).toBe(1300);
    // Never narrower than the card itself.
    const narrow = placeFileCard({ top: 0, bottom: 10, left: 0, right: 300 }, { width: 320, height: 700 });
    expect(narrow.grown!.width).toBe(narrow.width);
  });

  it('a code view: the card stays right of the line-number gutter, narrowed to fit, and gives up only when it cannot', () => {
    // A short passage near the left: right-aligned it would start over the gutter.
    const place = placeFileCard({ top: 100, bottom: 120, left: 70, right: 160 }, host, undefined, 56);
    expect(place.left).toBe(56);
    expect(place.width).toBe(CARD_WIDTH);
    expect(place.grown!.left).toBeGreaterThanOrEqual(56);
    expect(place.grown!.left + place.grown!.width).toBeLessThanOrEqual(host.width - CARD_GAP);
    // A box with little room right of the gutter: a narrower card, still right of it.
    const tight = placeFileCard({ top: 0, bottom: 10, left: 70, right: 160 }, { width: 420, height: 700 }, undefined, 56);
    expect(tight.left).toBe(56);
    expect(tight.left + tight.width).toBeLessThanOrEqual(420 - CARD_GAP);
    // Too narrow even for the smallest card: it may cover the gutter, never leave the box.
    const none = placeFileCard({ top: 0, bottom: 10, left: 70, right: 160 }, { width: 240, height: 700 }, undefined, 56);
    expect(none.left).toBe(CARD_GAP);
    // No column given (prose): unchanged.
    expect(placeFileCard({ top: 0, bottom: 10, left: 0, right: 100 }, host).left).toBe(CARD_GAP);
  });
});

describe('toHostRect / rectInHost', () => {
  // No DOM here: a rect is read for left/top/right/bottom only.
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;
  const host = rect(100, 50, 800, 600);
  it('translates a top-document rect into host coordinates', () => {
    expect(toHostRect(rect(150, 90, 200, 20), host)).toEqual({ top: 40, bottom: 60, left: 50, right: 250 });
  });
  it('adds the frame offset for a rect measured inside an iframe', () => {
    const frame = rect(120, 100, 700, 500);
    expect(toHostRect(rect(10, 20, 100, 10), host, frame)).toEqual({ top: 70, bottom: 80, left: 30, right: 130 });
  });
  it('tells a rect on screen from one scrolled past an edge (with a margin)', () => {
    const box = { width: 800, height: 600 };
    expect(rectInHost({ top: 10, bottom: 30, left: 0, right: 100 }, box)).toBe(true);
    expect(rectInHost({ top: -40, bottom: -20, left: 0, right: 100 }, box)).toBe(false);
    expect(rectInHost({ top: 590, bottom: 610, left: 0, right: 100 }, box, 24)).toBe(false);
    expect(rectInHost({ top: 590, bottom: 610, left: 0, right: 100 }, box)).toBe(true);
  });
});

describe('fileQuestionMarks with a draft', () => {
  it('marks the draft passage of this file ahead of the questions, and not a draft about another file', () => {
    const tree = buildThreadTree([user('u1'), reply('r1')], []);
    const draft = { pageKey: 'pending:file:/r/a.md:x', parentMsgId: 'file:/r/a.md', quote: { exact: 'a passage' }, title: 'New question' };
    const marks = fileQuestionMarks(tree, new Set(), new Map(), '/r/a.md', draft);
    expect(marks.map((m) => [m.key, m.quote.exact, m.resolved])).toEqual([['pending:file:/r/a.md:x', 'a passage', false]]);
    expect(fileQuestionMarks(tree, new Set(), new Map(), '/r/b.md', draft)).toEqual([]);
    expect(fileQuestionMarks(tree, new Set(), new Map(), '/r/a.md', { ...draft, quote: undefined })).toEqual([]);
  });
});

describe('fileQuestionRows (the rail)', () => {
  const messages = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3'), user('u4'), reply('r4')];
  const first = anchor('u2', 'file:/d/cache.md', { quote: { exact: 'late flush' } });
  const other = anchor('u3', 'file:/d/other.md', { quote: { exact: 'late flush' } });
  const second = anchor('u4', 'file:/d/cache.md', { quote: { exact: 'batches are capped' } });
  const tree = buildThreadTree(messages, [first, other, second]);
  const index = new Map([[ 'u4', { headId: 'u4', status: 'open', seq: 7 } ]]) as never;

  it('lists this file\'s questions in order with number, status and the current one', () => {
    const rows = fileQuestionRows(tree, new Set(), index, '/d/cache.md', null, threadKeyOf(second), new Set([threadKeyOf(first)]));
    expect(rows.map((r) => [r.kind, r.number, r.current, r.unread, r.status])).toEqual([
      ['thread', '1', false, true, 'older'],
      ['thread', '7', true, false, 'open'],
    ]);
    expect(rows[1].title.length).toBeGreaterThan(0);
  });
  it('adds the draft about this file last, dashed as pending, and skips a hidden question', () => {
    const draft = { pageKey: 'pending:file:/d/cache.md:x', parentMsgId: 'file:/d/cache.md', quote: { exact: 'a passage' }, title: 'New question' };
    const rows = fileQuestionRows(tree, new Set([threadKeyOf(first)]), new Map(), '/d/cache.md', draft, draft.pageKey, new Set());
    expect(rows.map((r) => [r.kind, r.current])).toEqual([['thread', false], ['pending', true]]);
    expect(rows[1]).toMatchObject({ key: draft.pageKey, title: 'New question', status: 'pending' });
  });
  it('lists every unsent Ask about this file: the one being written and the drafts kept with words', () => {
    const writing = { pageKey: 'pending:file:/d/cache.md:a', parentMsgId: 'file:/d/cache.md', quote: { exact: 'one' }, title: 'One' };
    const kept = { pageKey: 'pending:file:/d/cache.md:b', parentMsgId: 'file:/d/cache.md', quote: { exact: 'two' }, title: 'Two' };
    const elsewhere = { pageKey: 'pending:file:/d/other.md:c', parentMsgId: 'file:/d/other.md', quote: { exact: 'three' }, title: 'Three' };
    const rows = fileQuestionRows(tree, new Set(), new Map(), '/d/cache.md', [writing, kept, elsewhere], writing.pageKey, new Set());
    expect(rows.filter((r) => r.kind === 'pending').map((r) => [r.title, r.current])).toEqual([['One', true], ['Two', false]]);
    expect(fileQuestionMarks(tree, new Set(), new Map(), '/d/cache.md', [writing, kept, elsewhere]).filter((m) => m.key.startsWith('pending:')).map((m) => m.title))
      .toEqual(['One', 'Two']);
  });
  it('is empty for a file nobody asked about', () => {
    expect(fileQuestionRows(tree, new Set(), new Map(), '/d/none.md', null, null, new Set())).toEqual([]);
  });
});
