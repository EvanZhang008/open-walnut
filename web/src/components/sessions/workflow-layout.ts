/**
 * Group workflow agents by their recorded phase and count their statuses.
 * The CLI reports phases and agents, not agent-to-agent dependencies.
 */

import type { WorkflowPhase, WorkflowAgent, BackgroundTask } from '@/hooks/useBackgroundTasks';

// ── Agent vs plain-task split (WorkflowProgress legacy mode) ──
// The CLI stamps task_type on task_started: agent-like kinds get their own
// "Agents" section so background AGENTS aren't lumped in with plain background
// TASKS (local_bash shell commands etc.). Tasks recovered from disk have no
// taskType — fall back to subagentType (only the Agent tool sets it), else
// treat as a plain task. taskType is authoritative when present.
const AGENT_TASK_TYPES = new Set(['local_agent', 'remote_agent', 'in_process_teammate']);
export function isAgentTask(t: BackgroundTask): boolean {
  if (t.taskType) return AGENT_TASK_TYPES.has(t.taskType);
  return !!t.subagentType;
}

/** Terminal statuses (count toward "done"). */
export const TERMINAL = new Set(['completed', 'failed', 'stopped', 'killed', 'cancelled']);
/** Sentinel for an agent with no phaseIndex (mirrors WorkflowProgress's original). */
export const NO_PHASE = -1;

export interface LaidOutPhase {
  index: number;
  title: string;
  agents: WorkflowAgent[];
}

/** Normalize (phases, agents) into ordered phases each holding its agents.
 *  An agent whose phaseIndex matches no known phase is attached to a synthetic
 *  trailing group (happens with sparse/out-of-order snapshots), never dropped. */
export function buildLayout(phases: WorkflowPhase[], agents: WorkflowAgent[]): LaidOutPhase[] {
  const sortedPhases = [...phases].sort((a, b) => a.index - b.index);
  const known = new Set(sortedPhases.map(p => p.index));
  const groups: LaidOutPhase[] = sortedPhases.map(p => ({
    index: p.index,
    title: p.title,
    agents: agents.filter(a => (a.phaseIndex ?? NO_PHASE) === p.index).sort((a, b) => a.index - b.index),
  }));

  // Orphans: agents whose phaseIndex isn't among the known phases (or no phases at all).
  const orphans = agents
    .filter(a => !known.has(a.phaseIndex ?? NO_PHASE))
    .sort((a, b) => a.index - b.index);
  if (orphans.length) {
    // No phases at all → one unlabeled bag at index 0; otherwise a trailing catch-all.
    // index = MAX_SAFE_INTEGER so the catch-all sorts/renders strictly AFTER every real
    // phase, and (since real phase indices are small sequential ints from the workflow
    // script) can never collide with a real phase's index → the index doubles as a
    // stable, unique React key. The `0`-vs-MAX choice is mutually exclusive with a real
    // phase 0: the orphan only takes 0 when there are zero real phases.
    groups.push({
      index: groups.length ? Number.MAX_SAFE_INTEGER : 0,
      title: '',
      agents: orphans,
    });
  }

  return groups.filter(g => g.agents.length > 0);
}

export function preferredPhase(layout: LaidOutPhase[]): LaidOutPhase | undefined {
  return layout.find(phase => phase.agents.some(agent => agent.status === 'failed'))
    ?? layout.find(phase => phase.agents.some(agent => agent.status === 'running' || agent.status === 'paused'))
    ?? layout[layout.length - 1];
}

export function visibleWorkflowAgents(layout: LaidOutPhase[], phaseIndex: number | undefined, query: string): WorkflowAgent[] {
  const needle = query.trim().toLocaleLowerCase();
  const matching = needle
    ? layout.flatMap(phase => phase.agents.filter(agent => [agent.label, agent.agentId, agent.promptPreview, agent.resultPreview]
      .some(value => value?.toLocaleLowerCase().includes(needle))))
    : layout.find(phase => phase.index === phaseIndex)?.agents ?? [];
  const priority = (status: string) => {
    if (status === 'failed') return 0;
    if (status === 'running' || status === 'paused') return 1;
    if (status === 'pending') return 2;
    return 3;
  };
  return [...matching].sort((a, b) => priority(a.status) - priority(b.status) || a.index - b.index);
}

export function phaseCounts(agents: WorkflowAgent[]) {
  let done = 0, running = 0, failed = 0, tokens = 0;
  for (const a of agents) {
    if (a.status === 'running') running++;
    else if (a.status === 'failed') failed++;
    else if (TERMINAL.has(a.status)) done++;
    tokens += a.tokens ?? 0;
  }
  return { done, running, failed, tokens, total: agents.length };
}
