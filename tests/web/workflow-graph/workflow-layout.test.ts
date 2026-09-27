/**
 * Workflow grouping and status totals over sparse and dense phase lists.
 */

import { describe, it, expect } from 'vitest';
import { buildLayout, phaseCounts, preferredPhase, visibleWorkflowAgents } from '@/components/sessions/workflow-layout';
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

describe('workflow overview selection and filtering', () => {
  const phases: WorkflowPhase[] = [
    { index: 1, title: 'Search' },
    { index: 2, title: 'Fetch' },
    { index: 3, title: 'Verify' },
  ];
  const agents: WorkflowAgent[] = [
    agent({ agentId: 'a1', phaseIndex: 1, index: 0, label: 'Search sources' }),
    agent({ agentId: 'a2', phaseIndex: 2, index: 1, status: 'completed', label: 'Fetch first source' }),
    agent({ agentId: 'a3', phaseIndex: 2, index: 2, status: 'failed', label: 'Fetch broken source' }),
    agent({ agentId: 'a4', phaseIndex: 2, index: 3, status: 'running', label: 'Fetch current source' }),
    agent({ agentId: 'a5', phaseIndex: 3, index: 4, label: 'Verify sources', promptPreview: 'Check citations and Unicode 符号' }),
  ];

  it('opens a failed phase and puts the failed agent first without changing the phase totals', () => {
    const layout = buildLayout(phases, agents);
    expect(preferredPhase(layout)?.title).toBe('Fetch');
    expect(visibleWorkflowAgents(layout, 2, '').map(a => a.agentId)).toEqual(['a3', 'a4', 'a2']);
    expect(phaseCounts(layout[1].agents)).toMatchObject({ done: 1, running: 1, failed: 1, total: 3 });
  });

  it('opens the running phase when nothing has failed, otherwise the last phase', () => {
    const withoutFailure = buildLayout(phases, agents.filter(a => a.agentId !== 'a3'));
    expect(preferredPhase(withoutFailure)?.title).toBe('Fetch');
    const completed = buildLayout(phases, agents.map(a => ({ ...a, status: 'completed' })));
    expect(preferredPhase(completed)?.title).toBe('Verify');
  });

  it('searches all phases by name, id, prompt and result without mutating the source order', () => {
    const layout = buildLayout(phases, agents);
    expect(visibleWorkflowAgents(layout, 2, 'CITATIONS AND UNICODE 符号').map(a => a.agentId)).toEqual(['a5']);
    expect(visibleWorkflowAgents(layout, 3, 'a3').map(a => a.agentId)).toEqual(['a3']);
    expect(visibleWorkflowAgents(layout, 3, 'no match')).toEqual([]);
    expect(visibleWorkflowAgents(layout, 2, '').map(a => a.agentId)).toEqual(['a3', 'a4', 'a2']);
    expect(layout[1].agents.map(a => a.agentId)).toEqual(['a2', 'a3', 'a4']);
  });
});

describe('phaseCounts and dense fan-out', () => {
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

  it('keeps all agents in a dense phase in their original order', () => {
    const agents: WorkflowAgent[] = Array.from({ length: 107 }, (_, i) =>
      agent({ agentId: `a${i}`, index: i, phaseIndex: 0 }),
    );
    const layout = buildLayout([{ index: 0, title: 'review' }], agents);
    expect(layout[0].agents.map(a => a.agentId)).toEqual(agents.map(a => a.agentId));
  });
});
