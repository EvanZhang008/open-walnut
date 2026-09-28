/**
 * The stage graph's relationships, driven by the clocks of five real workflow runs
 * (labels stripped; phase titles and timings kept). Each run shows a different shape:
 * deep-research splits, streams, waits for all, then merges; the design-team run has
 * two phases side by side; the review/fix run takes turns for three rounds.
 */
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/real-workflow-timings.json';
import { buildLayout } from '@/components/sessions/workflow-layout';
import { buildStages, type Stage } from '@/components/sessions/workflow-stages';
import type { WorkflowAgent, WorkflowPhase } from '@/hooks/useBackgroundTasks';

type Run = { phases: WorkflowPhase[]; agents: [number, number, number, number, string][] };
const RUNS = fixture as Record<string, Run>;
const T0 = 1_790_000_000_000;

/** What the UI knows at `t` seconds: agents handed out so far, with the CLI's fields for their state then. */
function at(name: string, t = Infinity) {
  const run = RUNS[name];
  const agents: WorkflowAgent[] = [];
  run.agents.forEach(([phaseIndex, q, s, d, st], i) => {
    if (q > t) return;
    const started = s <= t, ended = s + d <= t;
    agents.push({
      agentId: `a${i}`, index: i, label: `agent ${i}`, phaseIndex,
      status: !started ? 'pending' : !ended ? 'running' : st === 'failed' ? 'failed' : 'completed',
      queuedAt: T0 + q * 1000,
      startedAt: started ? T0 + s * 1000 : undefined,
      durationMs: ended ? d * 1000 : undefined,
    });
  });
  const finished = t === Infinity;
  return buildStages(buildLayout(run.phases, agents, { keepEmpty: true }), finished);
}
const links = (stages: Stage[]) => stages.map(s => s.link?.long ?? null);
const states = (stages: Stage[]) => stages.flatMap(s => s.phases.map(p => `${p.title}:${p.state}`));

describe('stage relationships from real runs', () => {
  it('deep-research: splits into 5, streams into Fetch, waits for all 25, merges 75 into 1', () => {
    const stages = at('deep-research');
    expect(stages.map(s => s.phases.map(p => p.title).join('+'))).toEqual(['Scope', 'Search', 'Fetch', 'Verify', 'Synthesize']);
    expect(links(stages)).toEqual([null, 'splits into 5', 'starts as each finishes (5 → 25)', 'after all 25, fans out to 75', 'merges 75 into 1']);
    expect(stages.map(s => s.link?.kind ?? null)).toEqual([null, 'split', 'stream', 'after', 'merge']);
    expect(states(stages)).toEqual(['Scope:done', 'Search:done', 'Fetch:failed', 'Verify:done', 'Synthesize:done']);
    expect(stages[2].phases[0]).toMatchObject({ done: 24, failed: 1, total: 25 });
    expect(Math.round(stages[0].phases[0].spanMs! / 1000)).toBe(32);
  });

  it('deep-research mid-run: counts grow as agents appear, and nothing is claimed for stages not started', () => {
    const stages = at('deep-research', 200);
    // Search still has an agent working, so its count is "so far" until it ends.
    expect(links(stages)).toEqual([null, 'splits, 5 so far', 'starts as each finishes (5 → 21)', 'next', 'next']);
    expect(states(stages)).toEqual(['Scope:done', 'Search:running', 'Fetch:running', 'Verify:future', 'Synthesize:future']);
    expect(stages[3].link).toMatchObject({ kind: 'next', counts: '' });
    expect(stages[3].phases[0].total).toBe(0);
  });

  it('deep-research while Verify queues: running and waiting are counted apart, and its count is only "so far"', () => {
    const stages = at('deep-research', 700);
    expect(stages[3].link).toMatchObject({ kind: 'after', verb: 'after all', long: 'after all 25, 75 so far' });
    const verify = stages[3].phases[0];
    expect(verify.state).toBe('running');
    expect(verify.total).toBe(75);
    expect(verify.running).toBeLessThanOrEqual(12);
    expect(verify.pending).toBe(75 - verify.running - verify.done);
    expect(verify.pending).toBeGreaterThan(0);
  });

  it('design team: two phases that start together are one stage of two branches, and the next waits for both', () => {
    const stages = at('notes-redesign-design-team');
    expect(stages).toHaveLength(8);
    expect(stages[6].phases.map(p => p.title)).toEqual(['Bar Raiser R2', 'Customer Walkthrough']);
    expect(stages[6].link).toMatchObject({ kind: 'branches', counts: '1 → 3 + 3', long: 'splits into 2 branches (3 + 3)' });
    expect(stages[7].link).toMatchObject({ kind: 'merge', long: 'merges 6 into 1' });
    expect(links(stages).slice(1, 6)).toEqual(['splits into 3', 'merges 3 into 1', 'splits into 3', 'after all 3, fans out to 4', 'merges 4 into 1']);
    expect(states(stages)).toContain('Design Revision:failed');
  });

  it('review and fix take turns: the loop is named once the earlier stage comes back', () => {
    // Fix is still working, so it may yet get company: counted, not called a merge.
    expect(at('ux-slice', 20_000)[3].link).toMatchObject({ kind: 'merge', long: 'after all 2, 1 so far' });
    expect(at('ux-slice', 30_000)[3].link).toMatchObject({ kind: 'loop', counts: 'round 2', long: 'takes turns with Nitpick: round 2, 2 → 1 each round' });
    expect(at('ux-slice')[3].link).toMatchObject({ kind: 'loop', counts: 'round 3', long: 'takes turns with Nitpick: round 3, 2 → 1 each round' });
  });

  it('a stage fed one by one reads as a stream even at equal counts; a later wait narrows', () => {
    expect(links(at('fix-all-test-failures'))).toEqual([null, 'starts as each finishes (8 → 8)', 'after all 8, narrows to 2']);
    expect(links(at('adversarial-review-trim-refactor'))).toEqual([null, 'starts as each finishes (6 → 9)', 'merges 9 into 1']);
  });
});

describe('stage relationships while the next stage still grows', () => {
  const phases = [{ index: 1, title: 'Search' }, { index: 2, title: 'Verify' }, { index: 3, title: 'Report' }];
  const t = (s: number) => T0 + s * 1000;
  const done = (id: string, phaseIndex: number, s: number, d: number): WorkflowAgent =>
    ({ agentId: id, index: 0, phaseIndex, status: 'completed', queuedAt: t(s), startedAt: t(s), durationMs: d * 1000 });
  const running = (id: string, phaseIndex: number, s: number): WorkflowAgent =>
    ({ agentId: id, index: 0, phaseIndex, status: 'running', queuedAt: t(s), startedAt: t(s) });
  const search = [done('s1', 1, 0, 5), done('s2', 1, 0, 6), done('s3', 1, 0, 7)];

  it('a stage the CLI is still handing agents to never reads "narrows": 8 of what becomes 20', () => {
    const live = [...search, ...Array.from({ length: 8 }, (_, i) => running(`v${i}`, 2, 8))];
    expect(buildStages(buildLayout(phases, live, { keepEmpty: true }), false)[1].link)
      .toMatchObject({ kind: 'after', verb: 'after all', counts: '3 → 8', long: 'after all 3, 8 so far' });
    const settled = [...search, ...Array.from({ length: 20 }, (_, i) => done(`v${i}`, 2, 8 + Math.floor(i / 8) * 2, 2))];
    expect(buildStages(buildLayout(phases, settled, { keepEmpty: true }), true)[1].link)
      .toMatchObject({ kind: 'after', long: 'after all 3, fans out to 20' });
  });

  it('a split still starting its agents counts them so far; one after one is just "then"', () => {
    const scope = [done('q', 1, 0, 3)];
    const live = [...scope, running('a', 2, 3), running('b', 2, 3)];
    expect(buildStages(buildLayout(phases, live, { keepEmpty: true }), false)[1].link)
      .toMatchObject({ kind: 'split', verb: 'splits', long: 'splits, 2 so far' });
    const chain = [...scope, running('a', 2, 3)];
    expect(buildStages(buildLayout(phases, chain, { keepEmpty: true }), false)[1].link)
      .toMatchObject({ kind: 'after', verb: 'then', counts: '1 → 1', long: 'then' });
  });
});

describe('stage relationships without full clocks', () => {
  const phases = [{ index: 1, title: 'Fan out' }, { index: 2, title: 'Merge' }, { index: 3, title: 'Report' }];

  it('agents without a clock get counts only, never a guessed relationship', () => {
    const agents: WorkflowAgent[] = [
      { agentId: 'a', index: 1, phaseIndex: 1, status: 'completed' },
      { agentId: 'b', index: 2, phaseIndex: 2, status: 'completed' },
      { agentId: 'c', index: 3, phaseIndex: 2, status: 'running' },
    ];
    const stages = buildStages(buildLayout(phases, agents, { keepEmpty: true }), false);
    expect(stages.map(s => s.link?.kind ?? null)).toEqual([null, 'then', 'next']);
    expect(stages[1].link).toMatchObject({ counts: '1 → 2', long: '1 → 2' });
    expect(states(stages)).toEqual(['Fan out:done', 'Merge:running', 'Report:future']);
  });

  it('a streamed stage whose agents all finished waits while its feeder still runs', () => {
    const t = (s: number) => T0 + s * 1000;
    const agents: WorkflowAgent[] = [
      { agentId: 'f1', index: 1, phaseIndex: 1, status: 'completed', queuedAt: t(0), startedAt: t(0), durationMs: 5000 },
      { agentId: 'f2', index: 2, phaseIndex: 1, status: 'running', queuedAt: t(0), startedAt: t(0) },
      { agentId: 'm1', index: 3, phaseIndex: 2, status: 'completed', queuedAt: t(5), startedAt: t(5), durationMs: 2000 },
    ];
    const live = buildStages(buildLayout(phases, agents, { keepEmpty: true }), false);
    expect(live[1].link?.kind).toBe('stream');
    expect(live[1].phases[0].state).toBe('waiting');
    // Once the run is over the same stage is simply done.
    const over = buildStages(buildLayout(phases, agents.map(a => ({ ...a, status: 'completed', durationMs: a.durationMs ?? 9000 })), { keepEmpty: true }), true);
    expect(over[1].phases[0].state).toBe('done');
  });

  it('a declared phase with no agents yet is kept for the graph and dropped for the list', () => {
    const agents: WorkflowAgent[] = [{ agentId: 'a', index: 1, phaseIndex: 1, status: 'running', queuedAt: T0, startedAt: T0 }];
    expect(buildLayout(phases, agents, { keepEmpty: true }).map(p => p.title)).toEqual(['Fan out', 'Merge', 'Report']);
    expect(buildLayout(phases, agents).map(p => p.title)).toEqual(['Fan out']);
  });
});
