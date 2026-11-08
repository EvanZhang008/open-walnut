/**
 * Questions about a file passage: the pure helpers behind FileThreadLayer.
 */
import { describe, it, expect } from 'vitest';
import type { ThreadLiveState } from '@/utils/thread-meta';
import { buildThreadTree, threadKeyOf, type ThreadTreeMessage } from '@/utils/thread-tree';
import type { SessionThreadAnchor } from '@/types/session';
import { CARD_GAP, CARD_GROWN_WIDTH, CARD_WIDTH } from '@/utils/thread-card';
import { ASK_CHIP_HEIGHT, ASK_CHIP_WIDTH, FILE_CARD_MIN_HEIGHT, fileQuestionMarks, placeAskChip, fileQuestionRows, placeFileCard, placeFileCardBelow, rectInHost, toHostRect } from '@/utils/file-thread';

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
  it('a passage scrolled past an edge keeps its card beside it (never docked over other lines), and the card is away', () => {
    const highAnchor = { top: -300, bottom: -280, left: 40, right: 600 };
    const high = placeFileCard(highAnchor, host);
    expect(high.top).toBe(highAnchor.bottom + CARD_GAP);
    expect(placeFileCardBelow(highAnchor, host, 0).away).toBe(true);
    const lowAnchor = { top: 1200, bottom: 1220, left: 40, right: 600 };
    const low = placeFileCard(lowAnchor, host);
    expect(host.height - low.bottom!).toBe(lowAnchor.top - CARD_GAP);
    expect(placeFileCardBelow(lowAnchor, host, 0).away).toBe(true);
    // On screen, it is not away.
    expect(placeFileCardBelow({ top: 100, bottom: 120, left: 40, right: 600 }, host, 0).away).toBeUndefined();
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
    // A passage scrolled past either edge: the card stays by it (and is away, not drawn).
    expect(placeFileCard({ top: -300, bottom: -280, left: 40, right: 600 }, host, undefined, undefined, 70).top).toBe(-280 + CARD_GAP);
    expect(placeFileCardBelow({ top: 1200, bottom: 1220, left: 40, right: 600 }, host, 0, undefined, 70).away).toBe(true);
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
  it('a short box: the card takes what is left below the passage, and stays under it (shorter, never pushed onto it)', () => {
    const place = placeFileCard({ top: 100, bottom: 120, left: 0, right: 600 }, { width: 900, height: 300 });
    expect(place.top).toBe(120 + CARD_GAP);
    expect(place.maxHeight).toBe(300 - 120 - 2 * CARD_GAP);
    expect(place.maxHeight).toBeLessThan(FILE_CARD_MIN_HEIGHT);
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

  it('fits inside the box at every width, a box narrower than the card included', () => {
    // 2026-11-08: a 180px editor beside the file tree drew a 180px card from 8px, its
    // right edge and buttons clipped. Every width, anchor and gutter stays inside.
    for (let width = 40; width <= 1400; width += 7) {
      for (const right of [0, 30, width / 2, width, width + 200]) {
        for (const gutter of [undefined, 0, 48, width - 20]) {
          const p = placeFileCard({ top: 100, bottom: 120, left: 0, right }, { width, height: 700 }, undefined, gutter);
          expect(p.left).toBeGreaterThanOrEqual(CARD_GAP);
          expect(p.left + p.width).toBeLessThanOrEqual(width - CARD_GAP);
          expect(p.grown!.left + p.grown!.width).toBeLessThanOrEqual(width - CARD_GAP);
          expect(p.grown!.width).toBeGreaterThanOrEqual(p.width);
        }
      }
    }
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
    const rows = fileQuestionRows(tree, new Set(), index, '/d/cache.md', null, threadKeyOf(second), new Set([threadKeyOf(first)]), new Map());
    expect(rows.map((r) => [r.kind, r.number, r.current, r.unread, r.status])).toEqual([
      ['thread', '1', false, true, 'older'],
      ['thread', '7', true, false, 'open'],
    ]);
    expect(rows[1].title.length).toBeGreaterThan(0);
  });
  it('adds the draft about this file last, dashed as pending, and skips a hidden question', () => {
    const draft = { pageKey: 'pending:file:/d/cache.md:x', parentMsgId: 'file:/d/cache.md', quote: { exact: 'a passage' }, title: 'New question' };
    const rows = fileQuestionRows(tree, new Set([threadKeyOf(first)]), new Map(), '/d/cache.md', draft, draft.pageKey, new Set(), new Map());
    expect(rows.map((r) => [r.kind, r.current])).toEqual([['thread', false], ['pending', true]]);
    expect(rows[1]).toMatchObject({ key: draft.pageKey, title: 'New question', status: 'pending' });
  });
  it('lists every unsent Ask about this file: the one being written and the drafts kept with words', () => {
    const writing = { pageKey: 'pending:file:/d/cache.md:a', parentMsgId: 'file:/d/cache.md', quote: { exact: 'one' }, title: 'One' };
    const kept = { pageKey: 'pending:file:/d/cache.md:b', parentMsgId: 'file:/d/cache.md', quote: { exact: 'two' }, title: 'Two' };
    const elsewhere = { pageKey: 'pending:file:/d/other.md:c', parentMsgId: 'file:/d/other.md', quote: { exact: 'three' }, title: 'Three' };
    const rows = fileQuestionRows(tree, new Set(), new Map(), '/d/cache.md', [writing, kept, elsewhere], writing.pageKey, new Set(), new Map());
    expect(rows.filter((r) => r.kind === 'pending').map((r) => [r.title, r.current])).toEqual([['One', true], ['Two', false]]);
    expect(fileQuestionMarks(tree, new Set(), new Map(), '/d/cache.md', [writing, kept, elsewhere]).filter((m) => m.key.startsWith('pending:')).map((m) => m.title))
      .toEqual(['One', 'Two']);
  });
  it('follows the same failure, retry and answering state as the card, then uses persisted status', () => {
    const key = threadKeyOf(first);
    for (const status of ['failed', 'queued', 'answering'] as const) {
      const live = new Map<string, ThreadLiveState>([[key, status]]);
      const rows = fileQuestionRows(tree, new Set(), new Map(), '/d/cache.md', null, key, new Set(), live);
      expect(rows.find((r) => r.key === key)?.status).toBe(status);
      expect(rows.find((r) => r.key === threadKeyOf(second))?.status).toBe('older');
    }
    const resolved = new Map([[first.msgId, { headId: first.msgId, status: 'resolved', seq: 1 }]]) as never;
    expect(fileQuestionRows(tree, new Set(), resolved, '/d/cache.md', null, key, new Set(), new Map([[key, 'failed']]))[0].status).toBe('resolved');
    expect(fileQuestionRows(tree, new Set(), new Map(), '/d/cache.md', null, key, new Set(), new Map())[0].status).toBe('older');
  });
  it('is empty for a file nobody asked about', () => {
    expect(fileQuestionRows(tree, new Set(), new Map(), '/d/none.md', null, null, new Set(), new Map())).toEqual([]);
  });
});

describe('placeAskChip', () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
  const HOST = { width: 760, height: 600 };
  const overlaps = (a: { left: number; top: number; right: number; bottom: number }, spot: { top: number; left: number }) =>
    spot.left < a.right && spot.left + ASK_CHIP_WIDTH > a.left && spot.top < a.bottom && spot.top + ASK_CHIP_HEIGHT > a.top;

  it('goes after the end of a short last line, inside the block', () => {
    const block = box(20, 100, 700, 160);
    const last = box(20, 140, 300, 160);
    const spot = placeAskChip(block, last, HOST);
    expect(spot.left).toBeGreaterThanOrEqual(300);
    expect(spot.left + ASK_CHIP_WIDTH).toBeLessThanOrEqual(700);
    expect(overlaps(last, spot)).toBe(false);
  });

  it('a full last line: right of the block when the view has room there', () => {
    const block = box(20, 100, 600, 120);
    const spot = placeAskChip(block, box(20, 100, 598, 120), HOST);
    expect(spot.left).toBeGreaterThanOrEqual(600);
    expect(overlaps(block, spot)).toBe(false);
  });

  it('a full last line in a full-width block: under its right end, off its words', () => {
    const block = box(20, 100, 740, 160);
    const spot = placeAskChip(block, box(20, 140, 739, 160), HOST);
    expect(spot.top).toBeGreaterThanOrEqual(160);
    expect(spot.left + ASK_CHIP_WIDTH).toBeLessThanOrEqual(756);
  });

  it('no known last line: still never over the block when there is room beside it', () => {
    const block = box(20, 100, 600, 180);
    expect(overlaps(block, placeAskChip(block, null, HOST))).toBe(false);
  });

  it('a full-width block with a full last line: under it when the gap is clear, over it when the next line is in the way', () => {
    const block = box(20, 200, 740, 260);
    const last = box(20, 240, 739, 260);
    const clearBelow = placeAskChip(block, last, HOST, { near: [box(20, 300, 700, 320)] });
    expect(clearBelow.top).toBeGreaterThanOrEqual(260);
    const tight = [box(20, 168, 740, 188), box(20, 270, 740, 290)];
    const spot = placeAskChip(block, last, HOST, { near: [tight[1], box(20, 150, 740, 170)] });
    // Under covers the next line (270..290 against 262..282); over (178..198) is clear of the line before (150..170).
    expect(spot.top + ASK_CHIP_HEIGHT).toBeLessThanOrEqual(200);
    expect(overlaps(box(20, 150, 740, 170), spot)).toBe(false);
    // Both ways covered: the one covering less.
    const least = placeAskChip(block, last, HOST, { near: tight });
    expect([262, 178]).toContain(least.top);
  });

  it('a last line past the view\'s right edge (a wide code block): not after it, clamped over its words', () => {
    const block = box(20, 100, 1200, 120);
    const spot = placeAskChip(block, box(20, 100, 900, 120), HOST);
    expect(spot.top).toBeGreaterThanOrEqual(120);
  });

  it('a last line below the view: not after it (unseen), beside or around the block instead', () => {
    const block = box(20, 100, 740, 900);
    const spot = placeAskChip(block, box(20, 880, 300, 900), HOST);
    expect(spot.top).toBeGreaterThanOrEqual(0);
    expect(spot.top + ASK_CHIP_HEIGHT).toBeLessThanOrEqual(HOST.height);
    expect(spot.top + ASK_CHIP_HEIGHT).toBeLessThanOrEqual(100);
  });

  it('a block taller than the view on both ends: its corner, on screen', () => {
    const spot = placeAskChip(box(20, -50, 740, 900), null, HOST);
    expect(spot.top).toBeGreaterThanOrEqual(0);
    expect(spot.left + ASK_CHIP_WIDTH).toBeLessThanOrEqual(HOST.width);
  });

  it('stays inside a narrow view', () => {
    const spot = placeAskChip(box(0, 0, 120, 20), box(0, 0, 119, 20), { width: 120, height: 400 });
    expect(spot.left).toBeGreaterThanOrEqual(0);
    expect(spot.left + ASK_CHIP_WIDTH).toBeLessThanOrEqual(120);
  });
});
