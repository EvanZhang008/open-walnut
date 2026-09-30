/**
 * The question map (slice 1b): its rows are the drawer's All view, its shape
 * follows the box width and the user's choice, the rail keeps the current page
 * when it has to cut, and the keyboard moves one row at a time. Over the same
 * dense fixture the browser specs load.
 */
import { describe, it, expect } from 'vitest';
import { buildThreadTree, ROOT_THREAD_KEY, type ThreadTreeMessage } from '@/utils/thread-tree';
import { indexMeta } from '@/utils/thread-meta';
import type { SessionPinnedMessage, SessionThreadAnchor, SessionThreadMeta } from '@/types/session';
import { flattenTree, type TreeRow } from '@/utils/thread-tree-rows';
import {
  MAP_PANEL_MAX_W, MAP_PANEL_MIN_BOX, MAP_PANEL_MIN_W, MAP_RAIL_PITCH, mapHasContent, mapOverlayWidth, mapPanelWidth,
  mapRows, mapShapeFor, mapStep, onPathIds, railMarks,
} from '@/utils/thread-map';
import { buildDenseSession } from '../e2e/browser/threads-fixture';

const NOW = Date.parse('2026-09-26T12:00:00Z');

function dense() {
  const s = buildDenseSession(NOW);
  const messages: ThreadTreeMessage[] = s.rows.map((r) => ({ role: r.role, msgId: r.uuid, text: r.text }));
  const tree = buildThreadTree(messages, s.threadAnchors as SessionThreadAnchor[]);
  const index = indexMeta(s.threadMeta as SessionThreadMeta[]);
  const pins = s.pinnedMessages as SessionPinnedMessage[];
  const keyOf = (q: string) => tree.byRow.get(s.ids.head[q])!.key;
  return { s, tree, index, pins, keyOf };
}

const NO_GROUPS: ReadonlySet<string> = new Set();

function row(id: string, over: Partial<TreeRow> = {}): TreeRow {
  return {
    id, kind: 'thread', key: id, depth: 1, hue: 0, title: id, hasChildren: false, expanded: false,
    disclosureDisabled: false, matched: true, ancestorOnly: false, current: false, openBelow: 0, ...over,
  };
}

describe('mapShapeFor / mapPanelWidth', () => {
  it('is the panel from the threshold up, the rail below it or when collapsed', () => {
    expect(mapShapeFor(MAP_PANEL_MIN_BOX, false)).toBe('panel');
    expect(mapShapeFor(MAP_PANEL_MIN_BOX - 1, false)).toBe('rail');
    expect(mapShapeFor(1400, true)).toBe('rail');
    // Unmeasured: the rail (it never reserves a gutter).
    expect(mapShapeFor(0, false)).toBe('rail');
  });

  it('takes a quarter of the box, clamped, in whole pixels', () => {
    expect(mapPanelWidth(640)).toBe(MAP_PANEL_MIN_W);
    expect(mapPanelWidth(820)).toBe(205);
    expect(mapPanelWidth(1800)).toBe(MAP_PANEL_MAX_W);
    expect(Number.isInteger(mapPanelWidth(777))).toBe(true);
  });

  it('keeps the rail list inside a narrow box', () => {
    expect(mapOverlayWidth(480)).toBe(280);
    expect(mapOverlayWidth(250)).toBe(230);
    expect(mapOverlayWidth(120)).toBe(160);
    // Unmeasured: the full width (the first measure corrects it before paint).
    expect(mapOverlayWidth(0)).toBe(280);
  });
});

describe('mapRows', () => {
  it('equals the drawer All view, row for row', () => {
    const { tree, index, pins, keyOf } = dense();
    const currentKey = keyOf('Q11');
    const map = mapRows({ tree, index, pins, currentKey, doneGroupsOpen: NO_GROUPS });
    const drawer = flattenTree(tree, index, pins, undefined, {
      filter: 'all', query: '', collapsed: new Set(), doneGroupsOpen: new Set(), showHidden: false, currentKey,
    }).rows;
    expect(map.map((r) => [r.id, r.title, r.depth, r.status, r.current])).toEqual(
      drawer.map((r) => [r.id, r.title, r.depth, r.status, r.current]),
    );
    expect(map.find((r) => r.current)?.key).toBe(currentKey);
  });

  it('marks nothing current with no target chosen', () => {
    const { tree, index, pins } = dense();
    const map = mapRows({ tree, index, pins, currentKey: null, doneGroupsOpen: NO_GROUPS });
    expect(map.some((r) => r.current)).toBe(false);
    expect(map[0]).toMatchObject({ kind: 'root', title: 'Main conversation' });
  });

  it('holds open, and disables, the done group that holds the current page', () => {
    const { tree, index, pins } = dense();
    const rootRows = mapRows({ tree, index, pins, currentKey: ROOT_THREAD_KEY, doneGroupsOpen: NO_GROUPS });
    const group = rootRows.find((r) => r.kind === 'done-group')!;
    expect(group.disclosureDisabled).toBe(false);
    // Open it, then land on a question inside it: held open and not toggleable.
    const opened = mapRows({ tree, index, pins, currentKey: ROOT_THREAD_KEY, doneGroupsOpen: new Set([group.key]) });
    const inside = opened[opened.findIndex((r) => r.id === group.id) + 1];
    expect(inside.kind).toBe('thread');
    const onIt = mapRows({ tree, index, pins, currentKey: inside.key, doneGroupsOpen: NO_GROUPS });
    const held = onIt.find((r) => r.id === group.id)!;
    expect(held).toMatchObject({ expanded: true, disclosureDisabled: true });
    expect(onIt.find((r) => r.current)?.key).toBe(inside.key);
  });

  it('opens a done group the user toggled', () => {
    const { tree, index, pins } = dense();
    const closed = mapRows({ tree, index, pins, currentKey: ROOT_THREAD_KEY, doneGroupsOpen: NO_GROUPS });
    const group = closed.find((r) => r.kind === 'done-group' && !r.expanded);
    expect(group).toBeDefined();
    const open = mapRows({ tree, index, pins, currentKey: ROOT_THREAD_KEY, doneGroupsOpen: new Set([group!.key]) });
    expect(open.find((r) => r.id === group!.id)?.expanded).toBe(true);
    expect(open.length).toBeGreaterThan(closed.length);
  });

  it('lists the pending page under its parent, and has content with it alone', () => {
    const tree = buildThreadTree([{ role: 'assistant', msgId: 'a1', text: 'An answer.' }], []);
    const index = indexMeta([]);
    const none = mapRows({ tree, index, pins: [], currentKey: ROOT_THREAD_KEY, doneGroupsOpen: NO_GROUPS });
    expect(mapHasContent(none)).toBe(false);
    const pending = { pageKey: 'pending:a1:x', parentKey: ROOT_THREAD_KEY, parentMsgId: 'a1', title: 'An answer' };
    const rows = mapRows({ tree, index, pins: [], pending, currentKey: pending.pageKey, doneGroupsOpen: NO_GROUPS });
    expect(mapHasContent(rows)).toBe(true);
    expect(rows.map((r) => [r.kind, r.title, r.current])).toEqual([
      ['root', 'Main conversation', false],
      ['pending', 'New question', true],
    ]);
  });

  it('has no content with pins alone (the session keeps its outline)', () => {
    const tree = buildThreadTree([{ role: 'assistant', msgId: 'a1', text: 'An answer.' }], []);
    const pins: SessionPinnedMessage[] = [{ msgId: 'a1', label: 'An answer.', role: 'assistant', pinnedAt: '2026-09-26T11:00:00Z' }];
    const rows = mapRows({ tree, index: indexMeta([]), pins, currentKey: null, doneGroupsOpen: NO_GROUPS });
    expect(rows.map((r) => r.kind)).toEqual(['root', 'pin']);
    expect(mapHasContent(rows)).toBe(false);
  });
});

describe('onPathIds', () => {
  it('walks from the current row up to the root', () => {
    const { tree, index, pins, keyOf } = dense();
    const rows = mapRows({ tree, index, pins, currentKey: keyOf('Q11'), doneGroupsOpen: NO_GROUPS });
    const ids = onPathIds(rows);
    expect(ids.has('root')).toBe(true);
    expect(ids.has(`t:${keyOf('Q1')}`)).toBe(true);
    expect(ids.has(`t:${keyOf('Q11')}`)).toBe(true);
    expect(ids.has(`t:${keyOf('Q2')}`)).toBe(false);
  });

  it('is empty with nothing current', () => {
    expect(onPathIds([row('root', { kind: 'root', depth: 0 }), row('a')]).size).toBe(0);
  });
});

describe('railMarks', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(`r${i}`));

  it('keeps every row when they fit', () => {
    expect(railMarks(rows, 20 * MAP_RAIL_PITCH)).toEqual({ marks: rows, more: 0 });
  });

  it('cuts to the room and counts the rest', () => {
    const { marks, more } = railMarks(rows, 10 * MAP_RAIL_PITCH);
    expect(marks.map((r) => r.id)).toEqual(rows.slice(0, 9).map((r) => r.id));
    expect(more).toBe(11);
  });

  it('never cuts the current row', () => {
    const withCurrent = rows.map((r, i) => (i === 15 ? { ...r, current: true } : r));
    const { marks, more } = railMarks(withCurrent, 10 * MAP_RAIL_PITCH);
    expect(marks).toHaveLength(9);
    expect(marks[8].id).toBe('r15');
    expect(more).toBe(11);
  });

  it('keeps at least one mark in no room at all', () => {
    expect(railMarks(rows, 0).marks).toHaveLength(1);
  });
});

describe('mapStep', () => {
  const ids = ['a', 'b', 'c'];
  it('moves one row and stops at the ends', () => {
    expect(mapStep(ids, 'a', 'ArrowDown')).toBe('b');
    expect(mapStep(ids, 'c', 'ArrowDown')).toBe('c');
    expect(mapStep(ids, 'a', 'ArrowUp')).toBe('a');
    expect(mapStep(ids, 'b', 'Home')).toBe('a');
    expect(mapStep(ids, 'a', 'End')).toBe('c');
  });

  it('starts from the top when focus is outside the rows, and ignores other keys', () => {
    expect(mapStep(ids, undefined, 'ArrowDown')).toBe('a');
    expect(mapStep(ids, 'a', 'Enter')).toBeUndefined();
    expect(mapStep([], 'a', 'ArrowDown')).toBeUndefined();
  });
});
