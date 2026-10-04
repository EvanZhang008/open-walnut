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
  it('a passage scrolled above the box docks the card at the top; one below docks it at the bottom', () => {
    expect(placeFileCard({ top: -300, bottom: -280, left: 40, right: 600 }, host).top).toBe(CARD_GAP);
    const low = placeFileCard({ top: 1200, bottom: 1220, left: 40, right: 600 }, host);
    expect(low.top).toBe(host.height - FILE_CARD_MIN_HEIGHT - CARD_GAP);
    expect(low.maxHeight).toBe(FILE_CARD_MIN_HEIGHT);
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
      ['thread', 1, false, true, 'older'],
      ['thread', 7, true, false, 'open'],
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
