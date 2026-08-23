/**
 * placeSeparators — where a divider line lands once the list has moved on.
 *
 * The whole point of anchoring a line to its NEIGHBOURS instead of an index is
 * that lists change under it: cards get reordered, completed, moved to another
 * project or another tier. These tests pin the degradation ladder (below-anchor →
 * above-anchor → end of scope) because every rung is a case where an index-based
 * line would have silently swallowed the wrong rows.
 */
import { describe, it, expect } from 'vitest';
import {
  anchorsForSlot,
  newSeparatorId,
  placeSeparators,
  removeSeparator,
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

describe('placeSeparators — custom mode (one flat scope)', () => {
  const ids = ['t1', 't2', 't3'];
  const projectOf = lookup({ t1: 'marina', t2: 'marina', t3: 'acme' });

  it('places the line above its `before` anchor', () => {
    const p = placeSeparators({ ids, projectOf, tier: 'focus', mode: 'custom', separators: [sep({ after: 't1', before: 't2' })] });
    expect(p.above.get('t2')?.map((s) => s.id)).toEqual(['sep_1']);
    expect(p.tail.size).toBe(0);
  });

  it('falls back to below the `after` anchor when the row under it is gone', () => {
    const p = placeSeparators({ ids, projectOf, tier: 'focus', mode: 'custom', separators: [sep({ after: 't1', before: 'deleted' })] });
    expect(p.above.get('t2')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('lands at the end of the scope when the `after` anchor is the last row', () => {
    const p = placeSeparators({ ids, projectOf, tier: 'focus', mode: 'custom', separators: [sep({ after: 't3', before: 'deleted' })] });
    expect(p.tail.get('')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('survives losing BOTH anchors — end of scope, never dropped', () => {
    const p = placeSeparators({ ids, projectOf, tier: 'focus', mode: 'custom', separators: [sep({ after: 'gone', before: 'also-gone' })] });
    expect(p.tail.get('')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('an empty tier renders nothing (nothing to divide) but keeps the record', () => {
    const p = placeSeparators({ ids: [], projectOf, tier: 'focus', mode: 'custom', separators: [sep({ before: 't2' })] });
    expect(p.above.size).toBe(0);
    expect(p.tail.size).toBe(0);
  });

  it('ignores separators from another tier or the other view mode', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'custom',
      separators: [
        sep({ id: 'other-tier', tier: 'backlog', before: 't2' }),
        sep({ id: 'other-mode', mode: 'project', project: 'marina', before: 't2' }),
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
    // The sentinel is not in any scope, so both anchors miss → end of scope.
    expect(p.tail.get('')?.map((s) => s.id)).toEqual(['sep_1']);
  });
});

describe('placeSeparators — project mode (one scope per run)', () => {
  const ids = ['t1', 't2', 't3', 't4'];
  const projectOf = lookup({ t1: 'marina', t2: 'marina', t3: 'acme', t4: '' });

  it('resolves inside its own project run', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [sep({ mode: 'project', project: 'marina', after: 't1', before: 't2' })],
    });
    expect(p.above.get('t2')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('a line in Inbox ("") is a normal scope', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [sep({ mode: 'project', project: '', after: '', before: 't4' })],
    });
    expect(p.above.get('t4')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('does NOT follow a task that moved to another project — it stays in its run', () => {
    // Anchor t3 now belongs to 'acme', but the line was placed in 'marina'.
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [sep({ mode: 'project', project: 'marina', after: 't3', before: 't3' })],
    });
    expect(p.above.size).toBe(0);
    expect(p.tail.get('marina')?.map((s) => s.id)).toEqual(['sep_1']);
  });

  it('a run with no rows left renders nothing at all', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [sep({ mode: 'project', project: 'ghost', before: 't2' })],
    });
    expect(p.above.size).toBe(0);
    expect(p.tail.size).toBe(0);
  });

  it('tails are keyed per run', () => {
    const p = placeSeparators({
      ids, projectOf, tier: 'focus', mode: 'project',
      separators: [
        sep({ id: 'end-marina', mode: 'project', project: 'marina', after: 't2' }),
        sep({ id: 'end-acme', mode: 'project', project: 'acme', after: 't3' }),
      ],
    });
    expect(p.tail.get('marina')?.map((s) => s.id)).toEqual(['end-marina']);
    expect(p.tail.get('acme')?.map((s) => s.id)).toEqual(['end-acme']);
  });
});

describe('anchorsForSlot', () => {
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
  it('an empty scope has no neighbours', () => {
    expect(anchorsForSlot([], 0)).toEqual({ after: '', before: '' });
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
