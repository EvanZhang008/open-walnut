/**
 * workflow-layout — pure layout logic for WorkflowGraph (no React, unit-testable).
 *
 * The CLI gives us "ordered phases × a bag of agents per phase" with NO agent→agent
 * dependency edges. This module normalizes that into ordered phases each holding its
 * agents, and infers whether each phase is a parallel() barrier or a pipeline()-style
 * overlapping flow from agent start/finish timestamps. Rendering lives in
 * WorkflowGraph.tsx; this file is intentionally pure so it can be tested in isolation.
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

/** Above this many agents in a phase, collapse to a density bar (Level-of-Detail). */
export const DENSITY_THRESHOLD = 6;
/** Terminal statuses (count toward "done"). */
export const TERMINAL = new Set(['completed', 'failed', 'stopped', 'killed', 'cancelled']);
/** Sentinel for an agent with no phaseIndex (mirrors WorkflowProgress's original). */
export const NO_PHASE = -1;

export interface LaidOutPhase {
  index: number;
  title: string;
  agents: WorkflowAgent[];
  /** True when this phase appears to start only AFTER the previous phase finished
   *  (a parallel() barrier). False = overlapping start times → pipeline()-style flow.
   *  Inferred from startedAt/durationMs; defaults true (the fan-out/synthesize case). */
  barrierFromPrev: boolean;
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
    barrierFromPrev: true,
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
      barrierFromPrev: groups.length > 0,
    });
  }

  // Infer barrier vs pipeline from start/finish overlap. A phase is a barrier if its
  // earliest agent started no earlier than the previous phase's latest finish. This is
  // purely a DISPLAY hint (solid vs dashed connector) — the data carries no explicit
  // parallel()/pipeline() flag, so we infer it. MAX_SAFE_INTEGER here is the min-reduce
  // identity ("no real start seen"), distinct from its orphan-index role above.
  // Caveat: a still-RUNNING prev agent has durationMs undefined→0, so prevFinish
  // understates to its startedAt and a mid-run pipeline can momentarily read as a
  // barrier; it self-corrects once durations land. Harmless (display-only, default true).
  for (let i = 1; i < groups.length; i++) {
    const prev = groups[i - 1].agents;
    const cur = groups[i].agents;
    const prevFinish = prev.reduce((m, a) => Math.max(m, (a.startedAt ?? 0) + (a.durationMs ?? 0)), 0);
    const curStart = cur.reduce((m, a) => Math.min(m, a.startedAt ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    // Only override the default when BOTH timestamps are real; else keep barrier=true.
    if (prevFinish > 0 && curStart < Number.MAX_SAFE_INTEGER) {
      groups[i].barrierFromPrev = curStart >= prevFinish;
    }
  }
  return groups.filter(g => g.agents.length > 0);
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
