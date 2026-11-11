/**
 * Tree Mode's split screen (design 4, the path bar): the pure rules in
 * web/src/utils/tree-split-state.ts and the path bar's model
 * (web/src/components/sessions/tree-path-model.ts). The pages on screen are the
 * last n of the path (n = 1 to 3: the reader's cap, the room, the path); Cmd+[ /
 * Cmd+] move them one level, a segment click on a page on screen only focuses
 * it and one off screen slides the pages, a pick from a level's list switches
 * it and cuts the levels right of it, a narrow pane shows one page.
 */
import { describe, expect, it } from 'vitest';
import {
  answeringPages,
  CUTTING_VIAS, LEFT_SHARE_DEFAULT, MAX_PANES, PAGE_MIN_PX, clampLeftShare, isLeftShare, NO_TREE_SPLIT, SPLIT_MIN_WIDTH, askPlacement, paneColumns, barShown, closePaneMove, isPrefix,
  isTreeSplitRecord, levelHeading, levelKeys, levelPickMoves, pairChordDir, pairMoveTarget, paneCap, paneCount, readOnlyLandings, retargetNav,
  roomFor, sameTreeSplit, segmentRoles, segmentTarget, splitShown, trailFor, trailHeadsOf, trailKeysOf, withPaneCap,
} from '@/utils/tree-split-state';
import { pathBarHeading, pathBarLevelItems, pathBarSegments } from '@/components/sessions/tree-path-model';
import { panelHistoryOf } from '@/utils/find-scope';
import { ROOT_THREAD_KEY, type ThreadNode, type ThreadTree } from '@/utils/thread-tree';
import type { ThreadMetaIndex } from '@/utils/thread-meta';

/** Main > 6 > 6.1 > 6.1.2, with siblings 4 (beside 6), 6.2 (beside 6.1), 6.1.1 (beside 6.1.2). */
function fixtureTree(): ThreadTree {
  const spec: Array<{ key: string; parentKey?: string; head: string; label: string }> = [
    { key: 'k4', parentKey: ROOT_THREAD_KEY, head: 'h4', label: 'Pod creation implies access' },
    { key: 'k6', parentKey: ROOT_THREAD_KEY, head: 'h6', label: 'Who may impersonate' },
    { key: 'k61', parentKey: 'k6', head: 'h61', label: 'Same namespace' },
    { key: 'k62', parentKey: 'k6', head: 'h62', label: 'Cross namespace' },
    { key: 'k611', parentKey: 'k61', head: 'h611', label: 'Edit role' },
    { key: 'k612', parentKey: 'k61', head: 'h612', label: 'Binding as resource policy' },
  ];
  const root: ThreadNode = {
    key: ROOT_THREAD_KEY, parent: '', depth: 0, hue: 0, topIndex: -1, headId: '', at: 0, label: '', turnIds: [], childKeys: [],
  };
  const byKey = new Map<string, ThreadNode>([[ROOT_THREAD_KEY, root]]);
  spec.forEach((s, i) => {
    const parent = byKey.get(s.parentKey!)!;
    const node: ThreadNode = {
      key: s.key, parent: `m-${s.key}`, parentKey: s.parentKey, depth: parent.depth + 1, hue: 152, topIndex: 0,
      headId: s.head, at: i + 1, label: s.label, turnIds: [s.head], childKeys: [],
    };
    byKey.set(s.key, node);
    parent.childKeys.push(s.key);
  });
  return { threads: [...byKey.values()], byKey } as unknown as ThreadTree;
}

const tree = fixtureTree();
const NONE: ReadonlySet<string> = new Set();
const labels = new Map([['k4', '4'], ['k6', '6'], ['k61', '6.1'], ['k62', '6.2'], ['k611', '6.1.1'], ['k612', '6.1.2']]);
const FULL = [ROOT_THREAD_KEY, 'k6', 'k61', 'k612'];

describe('the trail the path bar shows', () => {
  it('keeps the deeper levels while the page path is the start of it', () => {
    expect(trailFor(FULL, [ROOT_THREAD_KEY, 'k6'])).toEqual(FULL);
    expect(trailFor(FULL, FULL)).toEqual(FULL);
    expect(trailFor(FULL, [ROOT_THREAD_KEY])).toEqual(FULL);
  });
  it('is cut back to the path once the reader goes somewhere else', () => {
    expect(trailFor(FULL, [ROOT_THREAD_KEY, 'k6', 'k62'])).toEqual([ROOT_THREAD_KEY, 'k6', 'k62']);
    expect(trailFor(FULL, [ROOT_THREAD_KEY, 'k6', 'k61', 'k612', 'pending:x'])).toEqual([...FULL, 'pending:x']);
    expect(isPrefix(['a'], ['a', 'b'])).toBe(true);
    expect(isPrefix(['a', 'b'], ['a'])).toBe(false);
  });
  it('round-trips through head ids, stopping at a page the tree does not hold', () => {
    expect(trailHeadsOf(tree, FULL)).toEqual(['h6', 'h61', 'h612']);
    expect(trailHeadsOf(tree, [...FULL, 'pending:x'])).toEqual(['h6', 'h61', 'h612']);
    expect(trailKeysOf(tree, ['h6', 'h61', 'h612'], NONE)).toEqual(FULL);
  });
  it('stops at a head that is gone, hidden, or not a child of the level before', () => {
    expect(trailKeysOf(tree, ['h6', 'gone', 'h612'], NONE)).toEqual([ROOT_THREAD_KEY, 'k6']);
    expect(trailKeysOf(tree, ['h6', 'h61', 'h612'], new Set(['k61']))).toEqual([ROOT_THREAD_KEY, 'k6']);
    expect(trailKeysOf(tree, ['h6', 'h611x'], NONE)).toEqual([ROOT_THREAD_KEY, 'k6']);
    expect(trailKeysOf(tree, ['h4', 'h61'], NONE)).toEqual([ROOT_THREAD_KEY, 'k4']);
    // Before the tree is known (a reload), nothing resolves: Main alone, nothing written.
    expect(trailKeysOf({ threads: [], byKey: new Map() } as unknown as ThreadTree, ['h6'], NONE)).toEqual([ROOT_THREAD_KEY]);
  });
});

describe('how many pages sit side by side', () => {
  it('two pages, the current and the one before it, wherever they fit (2026-11-10)', () => {
    expect(MAX_PANES).toBe(2);
    expect(roomFor(0)).toBe(1);
    expect(roomFor(SPLIT_MIN_WIDTH - 1)).toBe(1);
    expect(roomFor(SPLIT_MIN_WIDTH)).toBe(2);
    // A Home column (700 to 900px) and the full-screen sheet show both pages, never three.
    for (const width of [700, 800, 899, 1100, 1460, 2400]) {
      expect(roomFor(width), String(width)).toBe(2);
      for (const pathLength of [2, 3, 4, 6]) expect(paneCount({ cap: 2, width, pathLength }), `${width} ${pathLength}`).toBe(2);
    }
    expect(paneCount({ cap: 1, width: 1400, pathLength: 4 })).toBe(1);
    expect(paneCount({ cap: 2, width: 1400, pathLength: 1 })).toBe(1);
    expect(splitShown({ cap: 2, width: SPLIT_MIN_WIDTH, depth: 1 })).toBe(true);
    expect(splitShown({ cap: 2, width: SPLIT_MIN_WIDTH - 1, depth: 3 })).toBe(false);
    expect(splitShown({ cap: 2, width: 1400, depth: 0 })).toBe(false);
    expect(splitShown({ cap: 1, width: 1400, depth: 2 })).toBe(false);
  });
  it('the parent and child pages are equal by default, the divider moves them within the bounds', () => {
    expect(paneColumns(2)).toBe('minmax(0, 0.5000fr) minmax(0, 0.5000fr)');
    expect(paneColumns(2, 0.4)).toBe('minmax(0, 0.4000fr) minmax(0, 0.6000fr)');
    expect(paneColumns(2, 0.1)).toBe('minmax(0, 0.2500fr) minmax(0, 0.7500fr)');
    expect(paneColumns(2, 0.9)).toBe('minmax(0, 0.7500fr) minmax(0, 0.2500fr)');
    expect(paneColumns(1)).toBe('minmax(0, 1fr)');
    expect(paneColumns(1, 0.3)).toBe('minmax(0, 1fr)');
    expect(clampLeftShare(Number.NaN)).toBe(LEFT_SHARE_DEFAULT);
    // Each page keeps PAGE_MIN_PX when the column has room for it.
    expect(clampLeftShare(0.25, 800)).toBeCloseTo(PAGE_MIN_PX / 800);
    expect(clampLeftShare(0.75, 800)).toBeCloseTo(1 - PAGE_MIN_PX / 800);
    expect(clampLeftShare(0.25, 400)).toBe(0.5);
    expect(clampLeftShare(0.3, 2000)).toBe(0.3);
    expect(isLeftShare(0.5)).toBe(true);
    expect(isLeftShare(0.1)).toBe(false);
    expect(isLeftShare('0.5')).toBe(false);
  });
  it('a record from before the cap reads as the most pages (its split:false was the old default, not a choice)', () => {
    expect(paneCap({ split: false, trail: [] })).toBe(MAX_PANES);
    expect(paneCap(NO_TREE_SPLIT)).toBe(MAX_PANES);
    expect(withPaneCap(NO_TREE_SPLIT, 1)).toEqual({ split: false, trail: [], panes: 1 });
    expect(withPaneCap({ split: false, trail: ['a'] }, 2)).toEqual({ split: true, trail: ['a'], panes: 2 });
    expect(withPaneCap(NO_TREE_SPLIT, 9).panes).toBe(MAX_PANES);
  });
  it('a record an older build kept with three pages is still read, as two', () => {
    const old = { split: true, trail: ['h1'], panes: 3 };
    expect(isTreeSplitRecord(old)).toBe(true);
    expect(paneCap(old)).toBe(2);
  });
  it('shows the bar in Tree Mode once there is a level besides Main', () => {
    expect(barShown({ stackMode: true, trailLength: 2 })).toBe(true);
    expect(barShown({ stackMode: true, trailLength: 1 })).toBe(false);
    expect(barShown({ stackMode: false, trailLength: 3 })).toBe(false);
  });
  it('marks the pages on screen L, M, R (or the single page only)', () => {
    expect(segmentRoles(4, 3, 2)).toEqual([null, null, 'L', 'R']);
    expect(segmentRoles(4, 1, 2)).toEqual(['L', 'R', null, null]);
    expect(segmentRoles(4, 3, 3)).toEqual([null, 'L', 'M', 'R']);
    expect(segmentRoles(3, 2, 3)).toEqual(['L', 'M', 'R']);
    expect(segmentRoles(4, 3, 1)).toEqual([null, null, null, 'only']);
    expect(segmentRoles(4, 0, 1)).toEqual(['only', null, null, null]);
  });
});

describe('moving along the path', () => {
  it('Cmd+[ / Cmd+] move the pages one level and stop at the ends, never shrinking the split', () => {
    expect(pairMoveTarget(4, 3, -1, 2)).toBe(2);
    expect(pairMoveTarget(4, 2, 1, 2)).toBe(3);
    expect(pairMoveTarget(4, 3, 1, 2)).toBeNull();
    expect(pairMoveTarget(4, 1, -1, 2)).toBeNull();
    expect(pairMoveTarget(4, 3, -1, 3)).toBe(2);
    expect(pairMoveTarget(3, 2, -1, 3)).toBeNull();
    expect(pairMoveTarget(5, 4, -1, 3)).toBe(3);
    // One page: it moves alone, down to Main.
    expect(pairMoveTarget(4, 1, -1, 1)).toBe(0);
    expect(pairMoveTarget(4, 0, -1, 1)).toBeNull();
  });
  it('a segment on screen only takes the focus; one left of the pages slides them; one right goes there', () => {
    expect(segmentTarget(4, 2, 3, 2)).toBeNull();
    expect(segmentTarget(4, 3, 3, 2)).toBeNull();
    expect(segmentTarget(4, 0, 3, 2)).toBe(1);
    expect(segmentTarget(4, 1, 3, 2)).toBe(2);
    expect(segmentTarget(4, 0, 3, 3)).toBe(2);
    expect(segmentTarget(4, 3, 1, 2)).toBe(3);
    expect(segmentTarget(4, 0, 3, 1)).toBe(0);
    expect(segmentTarget(4, 9, 1, 2)).toBe(3);
  });
  it('closing the right page closes its level; closing a left one shows one page fewer', () => {
    expect(closePaneMove('R', 3, 3)).toEqual({ target: 2, panes: 3 });
    expect(closePaneMove('R', 1, 2)).toEqual({ target: 0, panes: 2 });
    expect(closePaneMove('L', 3, 3)).toEqual({ target: 3, panes: 2 });
    expect(closePaneMove('L', 3, 2)).toEqual({ target: 3, panes: 1 });
  });
});

describe('a navigation while pages sit side by side (2026-11-04: picking Main dropped to one page)', () => {
  const trail = [ROOT_THREAD_KEY, 'a', 'b', 'c'];
  const at = (n: number) => trail.slice(0, n + 1);
  it('onto a level on screen: it only takes the focus', () => {
    expect(retargetNav({ path: at(1), trail, panes: 2, room: 2, toPath: at(0), via: 'map' })).toEqual({ kind: 'focus', key: ROOT_THREAD_KEY });
    expect(retargetNav({ path: at(3), trail, panes: 3, room: 3, toPath: at(1), via: 'path-bar-list' })).toEqual({ kind: 'focus', key: 'a' });
  });
  it('onto a level left of the pages: they slide, as many as fit', () => {
    expect(retargetNav({ path: at(3), trail, panes: 2, room: 2, toPath: at(0), via: 'drawer' })).toEqual({ kind: 'path', path: at(1) });
    expect(retargetNav({ path: at(3), trail, panes: 2, room: 3, toPath: at(0), via: 'crumb' })).toEqual({ kind: 'path', path: at(2) });
  });
  it('as asked: a deeper level, the page on screen, another question, one page, a cut', () => {
    expect(retargetNav({ path: at(1), trail, panes: 2, room: 2, toPath: at(3), via: 'map' })).toBeNull();
    expect(retargetNav({ path: at(2), trail, panes: 2, room: 2, toPath: at(2), via: 'map' })).toBeNull();
    expect(retargetNav({ path: at(2), trail, panes: 2, room: 2, toPath: [ROOT_THREAD_KEY, 'x'], via: 'map' })).toBeNull();
    expect(retargetNav({ path: at(2), trail, panes: 1, room: 1, toPath: at(0), via: 'map' })).toBeNull();
    for (const via of CUTTING_VIAS) expect(retargetNav({ path: at(2), trail, panes: 2, room: 2, toPath: at(1), via })).toBeNull();
  });
});

describe('the chord', () => {
  it('reads Cmd+[ / Cmd+] on a Mac and Ctrl elsewhere, and nothing else', () => {
    const k = (key: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
      key, code: key === '[' ? 'BracketLeft' : key === ']' ? 'BracketRight' : 'KeyA', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m,
    });
    expect(pairChordDir(k('[', { metaKey: true }), true)).toBe(-1);
    expect(pairChordDir(k(']', { metaKey: true }), true)).toBe(1);
    expect(pairChordDir(k('[', { ctrlKey: true }), true)).toBe(0);
    expect(pairChordDir(k('[', { ctrlKey: true }), false)).toBe(-1);
    expect(pairChordDir(k(']', { metaKey: true, shiftKey: true }), true)).toBe(0);
    expect(pairChordDir(k('[', { metaKey: true, altKey: true }), true)).toBe(0);
    expect(pairChordDir(k('[', {}), true)).toBe(0);
    expect(pairChordDir(k('a', { metaKey: true }), true)).toBe(0);
  });
});

describe('a level\'s list', () => {
  it('lists the siblings under the same parent; Main\'s and level 1\'s are the questions on Main', () => {
    expect(levelKeys(tree, FULL, 0, NONE)).toEqual(['k4', 'k6']);
    expect(levelKeys(tree, FULL, 1, NONE)).toEqual(['k4', 'k6']);
    expect(levelKeys(tree, FULL, 2, NONE)).toEqual(['k61', 'k62']);
    expect(levelKeys(tree, FULL, 3, NONE)).toEqual(['k611', 'k612']);
    expect(levelKeys(tree, FULL, 2, new Set(['k62']))).toEqual(['k61']);
  });
  it('a pick cuts the levels right of it back to it (the path to the pick is the new trail)', () => {
    // Picking 4 at level 1 from (6 | 6.1): the stack goes to Main > 4; the trail follows.
    expect(trailFor(FULL, [ROOT_THREAD_KEY, 'k4'])).toEqual([ROOT_THREAD_KEY, 'k4']);
    // Picking the segment's own question again changes nothing.
    expect(trailFor(FULL, [ROOT_THREAD_KEY, 'k6', 'k61'])).toEqual(FULL);
  });
  it('picking the question a segment already shows moves nothing, in any segment, not only the right one', () => {
    expect(levelPickMoves(FULL, 1, 'k6')).toBe(false);
    expect(levelPickMoves(FULL, 2, 'k61')).toBe(false);
    expect(levelPickMoves(FULL, 3, 'k612')).toBe(false);
    expect(levelPickMoves(FULL, 1, 'k4')).toBe(true);
    expect(levelPickMoves(FULL, 3, 'k611')).toBe(true);
  });
  it('names its level', () => {
    expect(levelHeading(0, undefined)).toBe('Level 1 \u00b7 questions on Main');
    expect(levelHeading(1, undefined)).toBe('Level 1 \u00b7 questions on Main');
    expect(levelHeading(3, '6.1')).toBe('Level 3 \u00b7 questions on 6.1');
    expect(pathBarHeading(FULL, 2, labels)).toBe('Level 2 \u00b7 questions on 6');
  });
});

describe('the path bar model', () => {
  const index: ThreadMetaIndex = new Map();
  it('draws one segment per level with its number, title and role', () => {
    const segs = pathBarSegments([...FULL, 'pending:x'], segmentRoles(5, 4, 2), tree, index, labels);
    expect(segs.map((s) => [s.number ?? '', s.title, s.role])).toEqual([
      ['', 'Main conversation', null],
      ['6', 'Who may impersonate', null],
      ['6.1', 'Same namespace', null],
      ['6.1.2', 'Binding as resource policy', 'L'],
      ['', 'New question', 'R'],
    ]);
  });
  it('lists a level with numbers and status, the segment\'s own question current', () => {
    const items = pathBarLevelItems(tree, FULL, 2, { hidden: NONE, index, live: new Map([['k62', 'answering']]), unread: new Set(['k61']), labels });
    expect(items.map((i) => [i.number, i.status, i.current, i.unread])).toEqual([
      ['6.1', 'older', true, true],
      ['6.2', 'answering', false, false],
    ]);
    // Main's list marks the level-1 question open below it.
    expect(pathBarLevelItems(tree, FULL, 0, { hidden: NONE, index, live: new Map(), unread: NONE, labels }).find((i) => i.current)?.key).toBe('k6');
  });
});

describe('the kept record', () => {
  it('accepts its own shape only, and compares by value', () => {
    expect(isTreeSplitRecord({ split: true, trail: ['h6'] })).toBe(true);
    expect(isTreeSplitRecord({ split: 'yes', trail: [] })).toBe(false);
    expect(isTreeSplitRecord({ split: true, trail: [1] })).toBe(false);
    expect(isTreeSplitRecord(null)).toBe(false);
    expect(isTreeSplitRecord({ split: true, trail: [], panes: 2 })).toBe(true);
    expect(isTreeSplitRecord({ split: true, trail: [], panes: 4 })).toBe(false);
    expect(isTreeSplitRecord({ split: true, trail: [], panes: 1.5 })).toBe(false);
    expect(sameTreeSplit(NO_TREE_SPLIT, { split: true, trail: [], panes: MAX_PANES })).toBe(true);
    expect(sameTreeSplit(NO_TREE_SPLIT, { split: true, trail: [] })).toBe(false);
    expect(sameTreeSplit({ split: true, trail: ['a'] }, { split: true, trail: ['b'] })).toBe(false);
  });
});

describe('the left half never writes the panel\'s page landings', () => {
  it('reads the panel\'s record and ignores its own writes (Esc back kept landing a third down the box)', () => {
    const base = new Map([['k61', { scrollTop: 121, boxTop: 161, sentenceTop: 246 }]]);
    const view = readOnlyLandings(base);
    expect(view.get('k61')).toEqual({ scrollTop: 121, boxTop: 161, sentenceTop: 246 });
    expect(view.has('k61')).toBe(true);
    // The half's scroll memory saves a bare scrollTop under the page it shows.
    view.set('k61', { scrollTop: 93 });
    view.delete('k61');
    expect(base.get('k61')).toEqual({ scrollTop: 121, boxTop: 161, sentenceTop: 246 });
    expect(view.has('missing')).toBe(false);
  });
});

describe('an Ask from a passage the tree does not know yet (an answer still streaming)', () => {
  const path = [ROOT_THREAD_KEY, 'k6', 'k61'];
  it('hangs on the page on screen: the right page by default', () => {
    expect(askPlacement({ path })).toEqual({ parentKey: 'k61', base: path });
  });
  it('hangs on the page the passage is on when it names one: the split\'s left page', () => {
    expect(askPlacement({ path, onScreenKey: 'k6' })).toEqual({ parentKey: 'k6', base: [ROOT_THREAD_KEY, 'k6'] });
    expect(askPlacement({ path, onScreenKey: ROOT_THREAD_KEY })).toEqual({ parentKey: ROOT_THREAD_KEY, base: [ROOT_THREAD_KEY] });
  });
  it('a passage the tree knows keeps its own question', () => {
    expect(askPlacement({ path, onScreenKey: 'k6', known: 'k4' }).parentKey).toBe('k4');
  });
  it('hangs on the sibling page above the right one, which is no level of the path', () => {
    expect(askPlacement({ path, onScreenKey: 'k62', onScreenPath: [ROOT_THREAD_KEY, 'k6', 'k62'] }))
      .toEqual({ parentKey: 'k62', base: [ROOT_THREAD_KEY, 'k6', 'k62'] });
    // A path that is not the named page's own is not trusted.
    expect(askPlacement({ path, onScreenKey: 'k62', onScreenPath: [ROOT_THREAD_KEY, 'k6'] }).parentKey).not.toBe('k62');
  });
  it('a pending page on top stands for the page on screen (no named page)', () => {
    expect(askPlacement({ path: [...path, 'pending'], pendingParentKey: 'k61' })).toEqual({ parentKey: 'k61', base: path });
  });
});

describe('a find from no chat of a split panel searches the main stack', () => {
  const el = (name: string, inLeft: boolean) => ({ name, closest: (sel: string) => (sel === '.tree-split-left' && inLeft ? {} : null) });
  it('skips the left half, which comes first in the DOM', () => {
    const left = el('left', true);
    const right = el('right', false);
    const panel = { querySelectorAll: () => [left, right] } as unknown as Element;
    expect(panelHistoryOf(panel)).toBe(right);
    expect(panelHistoryOf({ querySelectorAll: () => [right] } as unknown as Element)).toBe(right);
    expect(panelHistoryOf({ querySelectorAll: () => [left] } as unknown as Element)).toBeNull();
  });
});

describe('answeringPages: only the page a turn answers offers Stop', () => {
  it('is null with no turn running', () => {
    expect(answeringPages(false, new Map([['1', 'answering']]))).toBeNull()
  })
  it('names the questions being answered, never the queued ones', () => {
    expect([...answeringPages(true, new Map([['1', 'answering'], ['1.2', 'queued'], ['2', 'failed']]))!]).toEqual(['1'])
  })
  it('a turn answering no question is the main conversation\'s', () => {
    expect([...answeringPages(true, new Map([['1.2', 'queued']]))!]).toEqual([''])
    expect([...answeringPages(true, new Map())!]).toEqual([''])
  })
})
