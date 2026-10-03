/**
 * The reader's view of a board, kept by the host across the leader's rewrites
 * (web/src/components/board/board-view-memory.ts). The report comes from the
 * board author's page, so everything in it is checked and bounded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOARD_VIEW_MAX_ITEMS, BOARD_VIEW_NAME_MAX, _clearBoardViews, boardView, keepBoardView, parseBoardView,
} from '../../web/src/components/board/board-view-memory';

const full = {
  v: 1, y: 840.4, anchor: { path: ['#sec-probe', 'p:2'], top: -12.6 },
  details: [['#sec-rollout'], ['main:1', 'details:3']], closed: [['#sec-notes']],
  threads: { talk: { top: 120 } }, filter: 'decide', folds: { 'choice:deploy': true, 'thread:talk': true },
  name: 'own-view:{"open":["sec-a"]}',
};

afterEach(() => _clearBoardViews());

describe('parseBoardView', () => {
  it('keeps a well-formed report, rounded', () => {
    expect(parseBoardView(full)).toEqual({
      v: 1, y: 840, anchor: { path: ['#sec-probe', 'p:2'], top: -13 },
      details: [['#sec-rollout'], ['main:1', 'details:3']], closed: [['#sec-notes']],
      threads: { talk: { top: 120 } }, filter: 'decide', folds: { 'choice:deploy': true, 'thread:talk': true },
      name: 'own-view:{"open":["sec-a"]}',
    });
  });

  it('is not a view without v:1', () => {
    expect(parseBoardView(null)).toBeNull();
    expect(parseBoardView('x')).toBeNull();
    expect(parseBoardView({ ...full, v: 2 })).toBeNull();
    expect(parseBoardView([full])).toBeNull();
  });

  it('drops the parts that are not what they claim', () => {
    const v = parseBoardView({
      v: 1, y: -5, anchor: { path: [], top: 3 },
      details: [['ok'], 'not-a-path', [''], [1], Array(65).fill('a'), ['x'.repeat(201)]], closed: 'nope',
      threads: { a: { top: -1 }, b: { top: 'x' }, c: { top: Infinity }, d: { top: 4 }, '': { top: 1 } },
      filter: 7, folds: { a: 'yes', b: true, ['x'.repeat(201)]: true }, name: 5,
    });
    expect(v).toEqual({
      v: 1, y: 0, anchor: null, details: [['ok']], closed: [], threads: { d: { top: 4 } }, filter: '', folds: { b: true }, name: '',
    });
  });

  it('bounds every list', () => {
    const many = Array.from({ length: BOARD_VIEW_MAX_ITEMS + 50 }, (_, i) => `t${i}`);
    const v = parseBoardView({
      v: 1, y: 0, anchor: null,
      details: many.map((id) => [`#${id}`]), closed: many.map((id) => [`#${id}`]),
      threads: Object.fromEntries(many.map((id) => [id, { top: 1 }])),
      filter: '', folds: Object.fromEntries(many.map((id) => [id, true])), name: 'n'.repeat(BOARD_VIEW_NAME_MAX + 10),
    })!;
    expect(v.details).toHaveLength(BOARD_VIEW_MAX_ITEMS);
    expect(v.closed).toHaveLength(BOARD_VIEW_MAX_ITEMS);
    expect(Object.keys(v.threads)).toHaveLength(BOARD_VIEW_MAX_ITEMS);
    expect(Object.keys(v.folds)).toHaveLength(BOARD_VIEW_MAX_ITEMS);
    expect(v.name).toHaveLength(BOARD_VIEW_NAME_MAX);
  });
});

describe('keepBoardView / boardView', () => {
  it('keeps the latest report per board, and ignores an invalid one', () => {
    expect(boardView('b1')).toBeNull();
    keepBoardView('b1', full);
    keepBoardView('b1', { v: 9 });
    expect(boardView('b1')?.y).toBe(840);
    keepBoardView('b1', { ...full, y: 10 });
    expect(boardView('b1')?.y).toBe(10);
    keepBoardView('', full);
    expect(boardView('')).toBeNull();
  });

  it('holds at most 50 boards, dropping the least recently reported', () => {
    for (let i = 0; i < 50; i++) keepBoardView(`b${i}`, { ...full, y: i });
    keepBoardView('b0', { ...full, y: 100 }); // b0 is reported again: now the newest
    keepBoardView('b50', full);
    expect(boardView('b0')?.y).toBe(100);
    expect(boardView('b1')).toBeNull();
    expect(boardView('b2')?.y).toBe(2);
    expect(boardView('b50')).not.toBeNull();
  });
});
