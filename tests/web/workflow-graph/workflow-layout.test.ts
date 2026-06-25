/**
 * Unit tests for WorkflowGraph's pure layout logic (workflow-layout.ts).
 *
 * The CLI gives us "ordered phases × a bag of agents" with NO agent→agent edges.
 * buildLayout() normalizes that into ordered phases each holding its agents, infers
 * barrier-vs-pipeline from start/finish timestamps, and never drops an orphan agent.
 * These are the correctness guarantees the flow-graph panel depends on.
 */

import { describe, it, expect } from 'vitest';
import { buildLayout, phaseCounts, DENSITY_THRESHOLD } from '@/components/sessions/workflow-layout';
import type { WorkflowAgent, WorkflowPhase } from '@/hooks/useBackgroundTasks';

function agent(p: Partial<WorkflowAgent> & { agentId: string }): WorkflowAgent {
  return { index: 0, status: 'completed', ...p };
}

describe('buildLayout — phase grouping', () => {
  it('fan-out → synthesize: groups agents into 2 ordered phases', () => {
    const phases: WorkflowPhase[] = [{ index: 0, title: 'scan' }, { index: 1, title: 'synthesize' }];
    const agents: WorkflowAgent[] = [
      agent({ agentId: 'a1', index: 0, phaseIndex: 0, label: 'scan:/usr/include' }),
      agent({ agentId: 'a2', index: 1, phaseIndex: 0, label: 'scan:/usr/lib' }),
      agent({ agentId: 'a3', index: 2, phaseIndex: 0, label: 'scan:/usr/bin' }),
      agent({ agentId: 'a4', index: 3, phaseIndex: 0, label: 'scan:/usr/share' }),
      agent({ agentId: 'a5', index: 4, phaseIndex: 1, label: 'synthesize' }),
    ];
    const layout = buildLayout(phases, agents);
    expect(layout).toHaveLength(2);
    expect(layout[0].title).toBe('scan');
    expect(layout[0].agents.map(a => a.agentId)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(layout[1].title).toBe('synthesize');
    expect(layout[1].agents.map(a => a.agentId)).toEqual(['a5']);
  });

  it('sorts phases by index and agents by index regardless of input order', () => {
    const phases: WorkflowPhase[] = [{ index: 1, title: 'second' }, { index: 0, title: 'first' }];
    const agents: WorkflowAgent[] = [
      agent({ agentId: 'b', index: 1, phaseIndex: 0 }),
      agent({ agentId: 'a', index: 0, phaseIndex: 0 }),
      agent({ agentId: 'c', index: 0, phaseIndex: 1 }),
    ];
    const layout = buildLayout(phases, agents);
    expect(layout.map(p => p.title)).toEqual(['first', 'second']);
    expect(layout[0].agents.map(a => a.agentId)).toEqual(['a', 'b']); // sorted by agent index within phase
    expect(layout[1].agents.map(a => a.agentId)).toEqual(['c']);
  });

  it('drops empty phases (no agents matched)', () => {
    const phases: WorkflowPhase[] = [{ index: 0, title: 'scan' }, { index: 1, title: 'empty' }];
    const agents: WorkflowAgent[] = [agent({ agentId: 'a1', phaseIndex: 0 })];
    const layout = buildLayout(phases, agents);
    expect(layout).toHaveLength(1);
    expect(layout[0].title).toBe('scan');
  });
});

describe('buildLayout — orphan handling (sparse/out-of-order snapshots)', () => {
  it('attaches an agent whose phaseIndex matches no phase to a trailing group, never drops it', () => {
    const phases: WorkflowPhase[] = [{ index: 0, title: 'scan' }];
    const agents: WorkflowAgent[] = [
      agent({ agentId: 'a1', phaseIndex: 0 }),
      agent({ agentId: 'orphan', phaseIndex: 9 }), // phase 9 not yet known
    ];
    const layout = buildLayout(phases, agents);
    const allIds = layout.flatMap(p => p.agents.map(a => a.agentId));
    expect(allIds).toContain('orphan');
    expect(allIds).toContain('a1');
  });

  it('no phases at all → one unlabeled bag holding every agent', () => {
    const agents: WorkflowAgent[] = [
      agent({ agentId: 'a1' }),
      agent({ agentId: 'a2' }),
    ];
    const layout = buildLayout([], agents);
    expect(layout).toHaveLength(1);
    expect(layout[0].title).toBe('');
    expect(layout[0].agents).toHaveLength(2);
  });

  it('orphan-group index is unique vs real phases (key-collision invariant)', () => {
    // With real phases present, the orphan catch-all must take MAX_SAFE_INTEGER so it
    // can never collide with a real (small, sequential) phase index used as a React key.
    const withPhases = buildLayout(
      [{ index: 0, title: 'scan' }],
      [{ agentId: 'a', index: 0, status: 'completed', phaseIndex: 0 }, { agentId: 'orphan', index: 1, status: 'completed', phaseIndex: 9 }],
    );
    const orphanGroup = withPhases.find(g => g.agents.some(a => a.agentId === 'orphan'))!;
    expect(orphanGroup.index).toBe(Number.MAX_SAFE_INTEGER);
    expect(withPhases.map(g => g.index)).toEqual([0, Number.MAX_SAFE_INTEGER]); // distinct keys

    // With NO real phases, the single bag takes 0 (no real phase 0 to collide with).
    const noPhases = buildLayout([], [{ agentId: 'x', index: 0, status: 'completed' }]);
    expect(noPhases[0].index).toBe(0);
  });

  it('agent with undefined phaseIndex is treated as an orphan, not silently in phase 0', () => {
    const phases: WorkflowPhase[] = [{ index: 0, title: 'scan' }];
    const agents: WorkflowAgent[] = [
      agent({ agentId: 'real', phaseIndex: 0 }),
      agent({ agentId: 'noPhase' }), // phaseIndex undefined → NO_PHASE sentinel
    ];
    const layout = buildLayout(phases, agents);
    const ids = layout.flatMap(p => p.agents.map(a => a.agentId));
    expect(ids).toContain('noPhase');
    // exactly once (no double-render: must not appear in phase 0 AND the orphan group)
    expect(ids.filter(id => id === 'noPhase')).toHaveLength(1);
  });
});

describe('buildLayout — barrier vs pipeline inference', () => {
  it('non-overlapping phases (phase 2 starts after phase 1 finishes) → barrier=true', () => {
    const phases: WorkflowPhase[] = [{ index: 0, title: 'scan' }, { index: 1, title: 'synth' }];
    const agents: WorkflowAgent[] = [
      agent({ agentId: 'a1', phaseIndex: 0, startedAt: 1000, durationMs: 500 }), // finishes 1500
      agent({ agentId: 'a2', phaseIndex: 1, startedAt: 1600, durationMs: 300 }), // starts after 1500
    ];
    const layout = buildLayout(phases, agents);
    expect(layout[1].barrierFromPrev).toBe(true);
  });

  it('overlapping phases (phase 2 starts before phase 1 finishes) → barrier=false (pipeline)', () => {
    const phases: WorkflowPhase[] = [{ index: 0, title: 'a' }, { index: 1, title: 'b' }];
    const agents: WorkflowAgent[] = [
      agent({ agentId: 'a1', phaseIndex: 0, startedAt: 1000, durationMs: 5000 }), // finishes 6000
      agent({ agentId: 'a2', phaseIndex: 1, startedAt: 2000, durationMs: 300 }),  // starts during phase 1
    ];
    const layout = buildLayout(phases, agents);
    expect(layout[1].barrierFromPrev).toBe(false);
  });

  it('defaults to barrier=true when timestamps are missing (safe fan-out/synthesize default)', () => {
    const phases: WorkflowPhase[] = [{ index: 0, title: 'a' }, { index: 1, title: 'b' }];
    const agents: WorkflowAgent[] = [
      agent({ agentId: 'a1', phaseIndex: 0 }), // no startedAt/durationMs
      agent({ agentId: 'a2', phaseIndex: 1 }),
    ];
    const layout = buildLayout(phases, agents);
    expect(layout[1].barrierFromPrev).toBe(true);
  });

  it('first phase always has barrierFromPrev=true (nothing precedes it)', () => {
    const layout = buildLayout([{ index: 0, title: 'only' }], [agent({ agentId: 'a1', phaseIndex: 0 })]);
    expect(layout[0].barrierFromPrev).toBe(true);
  });
});

describe('phaseCounts + density threshold', () => {
  it('tallies done/running/failed/tokens correctly', () => {
    const agents: WorkflowAgent[] = [
      agent({ agentId: 'a1', status: 'completed', tokens: 100 }),
      agent({ agentId: 'a2', status: 'running', tokens: 50 }),
      agent({ agentId: 'a3', status: 'failed', tokens: 20 }),
      agent({ agentId: 'a4', status: 'stopped', tokens: 10 }),
    ];
    const c = phaseCounts(agents);
    expect(c.total).toBe(4);
    expect(c.done).toBe(2);     // completed + stopped (both terminal)
    expect(c.running).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.tokens).toBe(180);
  });

  it('a fan-out larger than the density threshold is detectable for folding', () => {
    const agents: WorkflowAgent[] = Array.from({ length: DENSITY_THRESHOLD + 10 }, (_, i) =>
      agent({ agentId: `a${i}`, index: i, phaseIndex: 0 }),
    );
    const layout = buildLayout([{ index: 0, title: 'review' }], agents);
    expect(layout[0].agents.length).toBeGreaterThan(DENSITY_THRESHOLD);
  });
});
