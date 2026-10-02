/**
 * Facet counts (web/src/components/tasks/filter-facets.ts, G28): the one-pass
 * algorithm equals a per-value brute force on every bucket, counts move with
 * the other dimensions, and the owner's density stays under the 8ms budget.
 */
import { describe, it, expect } from 'vitest';
import type { Task, TaskPhase } from '../../src/core/types';
import { DEFAULT_FILTER_STATE as S0, type FilterState } from '../../web/src/components/tasks/filter-bar-types';
import { buildFilterEvalContext } from '../../web/src/components/tasks/filter-predicate';
import { bruteForceFacetCounts, computeFacetCounts } from '../../web/src/components/tasks/filter-facets';

const NOW = new Date('2026-10-01T12:00:00Z');
const PHASES: TaskPhase[] = ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING', 'COMPLETE'];

/** Deterministic pseudo-random dataset (no Math.random: reproducible failures). */
function dataset(open: number, archived: number, projects: number, tags: number): Task[] {
  let x = 7;
  const rnd = (n: number) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
  const out: Task[] = [];
  for (let i = 0; i < open + archived; i++) {
    const phase = i < open ? PHASES[rnd(4)] : 'COMPLETE';
    const p = rnd(projects + 1);
    out.push({
      id: `t${i}`,
      title: `Task ${i}`,
      status: phase === 'COMPLETE' ? 'done' : 'todo',
      phase,
      priority: (['none', 'important', 'immediate', 'backlog'] as const)[rnd(4)],
      project: p === projects ? '' : `Project ${String(p + 1).padStart(2, '0')}`,
      source: rnd(5) === 0 ? 'ms-todo' : 'local',
      sprint: rnd(3) === 0 ? `S${rnd(4)}` : undefined,
      tags: Array.from({ length: rnd(3) }, () => `label:tag${rnd(tags)}`),
      start_date: rnd(10) === 0 ? '2099-01-01' : undefined,
      created_at: '2026-09-20T00:00:00Z',
      updated_at: rnd(2) ? '2026-09-30T00:00:00Z' : '2026-05-01T00:00:00Z',
    } as unknown as Task);
  }
  return out;
}

const facets = (tasks: Task[], s: FilterState) => computeFacetCounts(tasks, buildFilterEvalContext(tasks, s, NOW));

describe('computeFacetCounts', () => {
  const tasks = dataset(300, 200, 12, 20);
  const states: [string, FilterState][] = [
    ['default', S0],
    ['project', { ...S0, projects: ['Project 03', ''] }],
    ['status complete', { ...S0, status: ['COMPLETE'] }],
    ['source + tag', { ...S0, sources: ['ms-todo'], tagsAny: ['label:tag1', 'label:tag2'] }],
    ['any date + priority + time', { ...S0, date: '', priorities: ['important'], time: { ...S0.time, preset: '7d' } }],
    ['sprint + open complete', { ...S0, sprints: ['S1'], status: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] }],
  ];
  for (const [name, s] of states) {
    it(`equals the brute force for every value (${name})`, () => {
      const fast = facets(tasks, s);
      const slow = bruteForceFacetCounts(tasks, s, undefined, NOW);
      for (const dim of Object.keys(slow) as (keyof typeof slow)[]) {
        const strip = (r: Record<string, number> | undefined) =>
          Object.fromEntries(Object.entries(r ?? {}).filter(([, n]) => n > 0));
        expect(strip(fast[dim])).toEqual(strip(slow[dim]));
      }
    });
  }
  it('Project counts change when Status widens (C43)', () => {
    const open = facets(tasks, S0).project!;
    const withDone = facets(tasks, { ...S0, status: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] }).project!;
    expect(withDone['Project 01']).toBeGreaterThan(open['Project 01']);
  });
  it('a selected value still counts as if the dimension were open (Linear style)', () => {
    const f = facets(tasks, { ...S0, projects: ['Project 03'] }).project!;
    expect(f['Project 04']).toBe(facets(tasks, S0).project!['Project 04']);
  });
  it('3400 tasks, 30 projects, 80 tags: median of 5 runs under 8ms', () => {
    const big = dataset(400, 3000, 30, 80);
    const s: FilterState = { ...S0, projects: ['Project 05'], tagsAny: ['label:tag3'] };
    const ctx = buildFilterEvalContext(big, s, NOW);
    computeFacetCounts(big, ctx);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      computeFacetCounts(big, ctx);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    expect(runs[2]).toBeLessThan(8);
  });
});
