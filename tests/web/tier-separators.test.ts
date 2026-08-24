/**
 * placeSeparators — where a divider line lands once the list has moved on.
 *
 * The whole point of anchoring a line to its NEIGHBOURS instead of an index is
 * that lists change under it: cards get reordered, completed, moved to another
 * project or another tier. These tests pin the degradation ladder (below-anchor →
 * above-anchor → end of tier) because every rung is a case where an index-based
 * line would have silently swallowed the wrong rows.
 *
 * They also pin the rule that makes the two modes different: in 'By project' a
 * FOLDER IS ONE UNIT, so a line sits between folders and can never land between
 * a folder's label and its own cards.
 */
import { describe, it, expect } from 'vitest';
import {
  anchorsForSlot,
  newSeparatorId,
  placeSeparators,
  projectAnchorsForSlot,
  removeSeparator,
  snapSlotOutOfGroup,
  upsertSeparator,
  type TierSeparator,
} from '../../web/src/components/tasks/tier-separators';

/** project map → projectOf lookup ('' = Inbox, null = not a task). */
const lookup = (projects: Record<string, string>) => (id: string) =>
  (id in projects ? projects[id] : null);

const sep = (over: Partial<TierSeparator> = {}): TierSeparator => ({
  id: 'sep_1',
  tier: 'focus',
  mode: 'custom',
  after: '',
  before: '',
  ...over,
});

/** A project-mode line: folder anchors only, no card anchors. */
const psep = (over: Partial<TierSeparator> = {}): TierSeparator => ({
  id: 'sep_1',
  tier: 'focus',
  mode: 'project',
  ...over,
});

describe('placeSeparators — custom mode (cards are the unit)', () => {
  const ids = ['t1', 't2', 't3'];
  const projectOf = lookup({ t1: 'marina', t2: 'marina', t3: 'acme' });

  it('places the line above its `before` anchor', () => {
    const p = placeSeparators({ ids, projectOf, tier: 'focus', mode: 'custom', separators: [sep({ after: 't1', before: 't2' })] });
    expect(p.above.get('t2')?.map((s) => s.id)).toEqual(['sep_1']);
    expect(p.tail).toEqual([]);
  });

  it('falls back to below the `after` anchor when the row under it is gone', () => {
    const p = placeSeparators({ ids, projectOf, tier: 'focus', mode: 'custom', separators: [sep({ after: 't1', before: 'deleted' })] });
    expect(p.above.get('t2')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('lands at the end of the tier when the `after` anchor is the last row', () => {
    const p = placeSeparators({ ids, projectOf, tier: 'focus', mode: 'custom', separators: [sep({ after: 't3', before: 'deleted' })] });
    expect(p.tail.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('survives losing BOTH anchors — end of tier, never dropped', () => {
    const p = placeSeparators({ ids, projectOf, tier: 'focus', mode: 'custom', separators: [sep({ after: 'gone', before: 'also-gone' })] });
    expect(p.tail.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('an empty tier renders nothing (nothing to divide) but keeps the record', () => {
    const p = placeSeparators({ ids: [], projectOf, tier: 'focus', mode: 'custom', separators: [sep({ before: 't2' })] });
    expect(p.above.size).toBe(0);
    expect(p.tail).toEqual([]);
  });

  it('ignores separators from another tier or the other view mode', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'custom',
      separators: [
        sep({ id: 'other-tier', tier: 'backlog', before: 't2' }),
        psep({ id: 'other-mode', beforeProject: 'marina' }),
        sep({ id: 'mine', before: 't2' }),
      ],
    });
    expect(p.above.get('t2')?.map((s) => s.id)).toEqual(['mine']);
  });

  it('keeps two lines on the same anchor in stored order', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'custom',
      separators: [sep({ id: 'a', before: 't2' }), sep({ id: 'b', before: 't2' })],
    });
    expect(p.above.get('t2')?.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('skips group sentinels — they are not rows a line can anchor to', () => {
    const withGroup = ['group:g1:focus', 't1', 't2', 't3'];
    const p = placeSeparators({ ids: withGroup, projectOf, tier: 'focus', mode: 'custom', separators: [sep({ after: 'group:g1:focus', before: '' })] });
    // The sentinel is not a row, so both anchors miss → end of tier.
    expect(p.tail.map((s) => s.id)).toEqual(['sep_1']);
  });
});

describe('placeSeparators — project mode (a folder is one unit)', () => {
  // Two runs of 'marina', one 'acme', one Inbox — folder order is first-seen.
  const ids = ['t1', 't2', 't3', 't4'];
  const projectOf = lookup({ t1: 'marina', t2: 'marina', t3: 'acme', t4: '' });

  it('draws the line above the folder named by `beforeProject`', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [psep({ afterProject: 'marina', beforeProject: 'acme' })],
    });
    expect(p.aboveProject.get('acme')?.map((s) => s.id)).toEqual(['sep_1']);
    // Never against a card: a line between a folder label and its own cards is
    // exactly the split-folder look this mode must not produce.
    expect(p.above.size).toBe(0);
    expect(p.tail).toEqual([]);
  });

  it('Inbox ("") is a normal folder to sit above', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [psep({ afterProject: 'acme', beforeProject: '' })],
    });
    expect(p.aboveProject.get('')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('falls back to below the `afterProject` folder when the one under it is gone', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [psep({ afterProject: 'marina', beforeProject: 'ghost' })],
    });
    expect(p.aboveProject.get('acme')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('lands at the end of the tier when `afterProject` is the last folder', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [psep({ afterProject: '', beforeProject: 'ghost' })],
    });
    expect(p.tail.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('survives losing BOTH folders — end of tier, never dropped', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [psep({ afterProject: 'ghost', beforeProject: 'also-ghost' })],
    });
    expect(p.tail.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('an empty tier renders nothing but keeps the record', () => {
    const p = placeSeparators({
      ids: [], projectOf, tier: 'focus', mode: 'project',
      separators: [psep({ beforeProject: 'acme' })],
    });
    expect(p.aboveProject.size).toBe(0);
    expect(p.tail).toEqual([]);
  });

  it('keeps two lines on the same boundary in stored order', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [psep({ id: 'a', beforeProject: 'acme' }), psep({ id: 'b', beforeProject: 'acme' })],
    });
    expect(p.aboveProject.get('acme')?.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('a folder that appears twice in the pin order resolves to its FIRST run', () => {
    // Project mode clusters the raw pin order, so a folder renders once. The
    // placement must agree with that or the line would draw twice.
    const split = lookup({ t1: 'marina', t2: 'acme', t3: 'marina' });
    const p = placeSeparators({
      ids: ['t1', 't2', 't3'], projectOf: split, tier: 'focus', mode: 'project',
      separators: [psep({ beforeProject: 'marina' })],
    });
    expect(p.aboveProject.get('marina')?.map((s) => s.id)).toEqual(['sep_1']);
    expect([...p.aboveProject.keys()]).toEqual(['marina']);
  });

  it('LEGACY rows (a line that used to sit INSIDE a run) move to that folder\'s top edge', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      // Old shape: `project` = the run it lived in, card anchors inside that run.
      separators: [{ id: 'old', tier: 'focus', mode: 'project', project: 'acme', after: 't3', before: '' }],
    });
    expect(p.aboveProject.get('acme')?.map((s) => s.id)).toEqual(['old']);
    expect(p.above.size).toBe(0);
  });

  it('a legacy row whose run is gone still survives at the end of the tier', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [{ id: 'old', tier: 'focus', mode: 'project', project: 'ghost', after: 't9', before: '' }],
    });
    expect(p.tail.map((s) => s.id)).toEqual(['old']);
  });
});

describe('a group is one unit (reported 2026-08-24: a joining card split the cluster)', () => {
  // Focus order: g1 g2 g3 are one group, x and y are loose cards.
  const ids = ['x', 'g1', 'g2', 'g3', 'y'];
  const projectOf = lookup({ x: 'p', g1: 'p', g2: 'p', g3: 'p', y: 'p' });
  const groupOf = (id: string) => (id.startsWith('g') ? 'grp' : null);

  it('a line anchored to a MIDDLE member drops below the whole group', () => {
    const p = placeSeparators({
      ids, projectOf, groupOf, tier: 'focus', mode: 'custom',
      separators: [sep({ after: 'g1', before: 'g2' })],
    });
    expect(p.above.get('y')?.map((s) => s.id)).toEqual(['sep_1']);
    expect(p.above.get('g2'), 'never between two members').toBeUndefined();
  });

  it('a line anchored to the LAST member also drops below the group', () => {
    const p = placeSeparators({
      ids, projectOf, groupOf, tier: 'focus', mode: 'custom',
      separators: [sep({ after: 'g2', before: 'g3' })],
    });
    expect(p.above.get('y')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('a line above the group\'s FIRST member stays there — that IS the top boundary', () => {
    const p = placeSeparators({
      ids, projectOf, groupOf, tier: 'focus', mode: 'custom',
      separators: [sep({ after: 'x', before: 'g1' })],
    });
    expect(p.above.get('g1')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('a line below the whole group is left alone', () => {
    const p = placeSeparators({
      ids, projectOf, groupOf, tier: 'focus', mode: 'custom',
      separators: [sep({ after: 'g3', before: 'y' })],
    });
    expect(p.above.get('y')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('a group at the very END pushes the line to the tier tail, not inside it', () => {
    const tailIds = ['x', 'g1', 'g2'];
    const p = placeSeparators({
      ids: tailIds, projectOf, groupOf, tier: 'focus', mode: 'custom',
      separators: [sep({ after: 'g1', before: 'g2' })],
    });
    expect(p.tail.map((s) => s.id)).toEqual(['sep_1']);
    expect(p.above.size).toBe(0);
  });

  it('the `after`-only fallback also snaps out', () => {
    const p = placeSeparators({
      ids, projectOf, groupOf, tier: 'focus', mode: 'custom',
      separators: [sep({ after: 'g1', before: 'deleted' })],
    });
    expect(p.above.get('y')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('two ADJACENT groups keep their own boundary between them', () => {
    const twoIds = ['a1', 'a2', 'b1', 'b2'];
    const twoProj = lookup({ a1: 'p', a2: 'p', b1: 'p', b2: 'p' });
    const twoGroups = (id: string) => (id.startsWith('a') ? 'ga' : 'gb');
    const p = placeSeparators({
      ids: twoIds, projectOf: twoProj, groupOf: twoGroups, tier: 'focus', mode: 'custom',
      separators: [sep({ after: 'a2', before: 'b1' })],
    });
    expect(p.above.get('b1')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('without groupOf nothing snaps — the default keeps old callers exact', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'custom',
      separators: [sep({ after: 'g1', before: 'g2' })],
    });
    expect(p.above.get('g2')?.map((s) => s.id)).toEqual(['sep_1']);
  });
});

describe('snapSlotOutOfGroup', () => {
  const rows = ['x', 'g1', 'g2', 'g3', 'y'];
  const groupOf = (id: string) => (id.startsWith('g') ? 'grp' : null);

  it('a slot inside a run moves to the slot after the run', () => {
    expect(snapSlotOutOfGroup(rows, 2, groupOf)).toBe(4);
    expect(snapSlotOutOfGroup(rows, 3, groupOf)).toBe(4);
  });
  it('the run\'s own boundaries are already legal', () => {
    expect(snapSlotOutOfGroup(rows, 1, groupOf)).toBe(1);
    expect(snapSlotOutOfGroup(rows, 4, groupOf)).toBe(4);
  });
  it('the ends of the list are never inside anything', () => {
    expect(snapSlotOutOfGroup(rows, 0, groupOf)).toBe(0);
    expect(snapSlotOutOfGroup(rows, rows.length, groupOf)).toBe(rows.length);
  });
  it('clamps out-of-range slots', () => {
    expect(snapSlotOutOfGroup(rows, 99, groupOf)).toBe(5);
    expect(snapSlotOutOfGroup(rows, -3, groupOf)).toBe(0);
  });
  it('ungrouped neighbours are untouched', () => {
    expect(snapSlotOutOfGroup(['a', 'b', 'c'], 2, () => null)).toBe(2);
  });
  it('two members of DIFFERENT groups are a legal boundary', () => {
    expect(snapSlotOutOfGroup(['a1', 'b1'], 1, (id) => (id[0] === 'a' ? 'ga' : 'gb'))).toBe(1);
  });
});

describe('anchorsForSlot (custom mode — between cards)', () => {
  const rows = ['a', 'b', 'c'];
  it('top slot has no row above it', () => {
    expect(anchorsForSlot(rows, 0)).toEqual({ after: '', before: 'a' });
  });
  it('middle slot records both neighbours', () => {
    expect(anchorsForSlot(rows, 2)).toEqual({ after: 'b', before: 'c' });
  });
  it('end slot has no row below it', () => {
    expect(anchorsForSlot(rows, 3)).toEqual({ after: 'c', before: '' });
  });
  it('clamps an out-of-range slot', () => {
    expect(anchorsForSlot(rows, 99)).toEqual({ after: 'c', before: '' });
    expect(anchorsForSlot(rows, -5)).toEqual({ after: '', before: 'a' });
  });
  it('an empty list has no neighbours', () => {
    expect(anchorsForSlot([], 0)).toEqual({ after: '', before: '' });
  });
});

describe('projectAnchorsForSlot (project mode — between folders)', () => {
  const runs = ['marina', 'acme', ''];
  it('a boundary records both folders', () => {
    expect(projectAnchorsForSlot(runs, 1)).toEqual({ afterProject: 'marina', beforeProject: 'acme' });
  });
  it('Inbox ("") is a real folder, not "no folder"', () => {
    expect(projectAnchorsForSlot(runs, 2)).toEqual({ afterProject: 'acme', beforeProject: '' });
  });
  it('top of the tier OMITS afterProject — absent means "no folder above"', () => {
    expect(projectAnchorsForSlot(runs, 0)).toEqual({ beforeProject: 'marina' });
  });
  it('bottom of the tier omits beforeProject', () => {
    expect(projectAnchorsForSlot(runs, 3)).toEqual({ afterProject: '' });
  });
  it('clamps an out-of-range boundary', () => {
    expect(projectAnchorsForSlot(runs, 99)).toEqual({ afterProject: '' });
    expect(projectAnchorsForSlot(runs, -5)).toEqual({ beforeProject: 'marina' });
  });
  it('no folders at all means no anchors', () => {
    expect(projectAnchorsForSlot([], 0)).toEqual({});
  });
});

describe('list helpers', () => {
  it('upsert replaces by id and appends a new one', () => {
    const list = [sep({ id: 'a', before: 't1' })];
    const moved = upsertSeparator(list, sep({ id: 'a', before: 't9' }));
    expect(moved).toHaveLength(1);
    expect(moved[0].before).toBe('t9');
    expect(upsertSeparator(moved, sep({ id: 'b' }))).toHaveLength(2);
    // input is not mutated (the caller renders from the old list until the PUT lands)
    expect(list[0].before).toBe('t1');
  });

  it('remove drops exactly one line', () => {
    const list = [sep({ id: 'a' }), sep({ id: 'b' })];
    expect(removeSeparator(list, 'a').map((s) => s.id)).toEqual(['b']);
    expect(removeSeparator(list, 'missing')).toHaveLength(2);
  });

  it('ids are distinct and prefixed', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSeparatorId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.startsWith('sep_')).toBe(true);
  });
});
