/**
 * Shared dynamic-workflow progress accumulator.
 *
 * The Claude Code `Workflow` tool fans out N parallel background subagents and
 * reports their state via a `workflow_progress[]` array carried on each
 * `task_progress` system event. Two consumers need to parse that array into the
 * same { phases, agents } shape:
 *
 *   1. LIVE — ClaudeCodeSession ingests it from the event stream as the workflow
 *      runs (each snapshot carries only the currently-active agents).
 *   2. PERSISTED — on page reload / server restart the live state is gone, so we
 *      reconstruct it from the on-disk `workflows/wf_*.json` manifest, which
 *      stores the full accumulated `workflowProgress[]` in the identical format.
 *
 * Both go through THIS module so the parse/normalize/merge rules live in one
 * place (no parallel copy that can drift). The accumulator is intentionally
 * stateful-by-reference: callers own the Maps and call accumulate() repeatedly.
 */

import type { WorkflowPhaseInfo, WorkflowAgentInfo } from './event-types.js';

/** Normalize the CLI's workflow_agent `state` into our status vocabulary.
 *  Only `start` and `done` have been OBSERVED from the live CLI; every other arm
 *  (running/active, result/completed/success, error/failed, stopped/killed/…,
 *  queued/pending) is a defensive synonym in case the CLI vocabulary grows — they
 *  are speculative, not confirmed. Unknown values fall back to 'running' on
 *  purpose: a display-only panel should show "still working" for a state it can't
 *  classify rather than falsely claim completion. (If a future CLI emits an
 *  unrecognized TERMINAL state, the agent would stay visually "running" until the
 *  run ends — acceptable for a non-authoritative view; completion is still driven
 *  solely by session_state_changed{idle}, never by this status.) */
export function normalizeWorkflowState(state: unknown): string {
  switch (String(state ?? '').toLowerCase()) {
    case 'start': case 'running': case 'active': return 'running';
    case 'done': case 'result': case 'completed': case 'success': return 'completed';
    case 'error': case 'failed': return 'failed';
    case 'stopped': case 'killed': case 'cancelled': case 'canceled': return 'stopped';
    case 'queued': case 'pending': return 'pending';
    default: return 'running';
  }
}

/**
 * Ingest a `workflow_progress[]` array into the caller-owned phases + agents Maps.
 *
 * - `workflow_phase` entries upsert into `phases` by index.
 * - `workflow_agent` entries merge into `agents` by agentId (latest-wins, but a
 *   later sparse snapshot never clobbers a known promptPreview/resultPreview/etc).
 * - "Ghost" placeholder entries (no agentId — queued, no id assigned yet) are
 *   skipped so they don't double-count against the real agents.
 *
 * Mutates the passed Maps in place; safe to call repeatedly across snapshots.
 */
export function accumulateWorkflowProgress(
  wp: unknown[],
  phases: Map<number, WorkflowPhaseInfo>,
  agents: Map<string, WorkflowAgentInfo>,
): void {
  for (const raw of wp) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (e.type === 'workflow_phase') {
      const index = typeof e.index === 'number' ? e.index : undefined;
      const title = typeof e.title === 'string' ? e.title : undefined;
      if (index != null && title) phases.set(index, { index, title });
    } else if (e.type === 'workflow_agent') {
      const agentId = typeof e.agentId === 'string' ? e.agentId : undefined;
      if (!agentId) continue; // ghost placeholder (queued, no id yet)
      const prev = agents.get(agentId);
      const usage = e.usage as { total_tokens?: number } | undefined;
      // Merge: keep prior values when this snapshot omits a field (don't clobber).
      agents.set(agentId, {
        agentId,
        index: typeof e.index === 'number' ? e.index : (prev?.index ?? 0),
        label: (e.label as string | undefined) ?? prev?.label,
        phaseIndex: (e.phaseIndex as number | undefined) ?? prev?.phaseIndex,
        phaseTitle: (e.phaseTitle as string | undefined) ?? prev?.phaseTitle,
        model: (e.model as string | undefined) ?? prev?.model,
        // Merge-preserve like every other field: a sparse re-emit that carries an
        // agentId but omits `state` (e.g. a metrics-only update) must NOT downgrade a
        // previously-`completed` agent back to the `running` default.
        status: e.state != null ? normalizeWorkflowState(e.state) : (prev?.status ?? 'running'),
        promptPreview: (e.promptPreview as string | undefined) ?? prev?.promptPreview,
        resultPreview: (e.resultPreview as string | undefined) ?? prev?.resultPreview,
        tokens: (typeof e.tokens === 'number' ? e.tokens : usage?.total_tokens) ?? prev?.tokens,
        toolCalls: (e.toolCalls as number | undefined) ?? prev?.toolCalls,
        durationMs: (e.durationMs as number | undefined) ?? prev?.durationMs,
        startedAt: (e.startedAt as number | undefined) ?? prev?.startedAt,
        queuedAt: (typeof e.queuedAt === 'number' ? e.queuedAt : undefined) ?? prev?.queuedAt,
        error: (typeof e.error === 'string' ? e.error : undefined) ?? prev?.error,
      });
    }
  }
}

/** Sort accumulated phases by index (ascending). */
export function sortedPhases(phases: Map<number, WorkflowPhaseInfo>): WorkflowPhaseInfo[] {
  return [...phases.values()].sort((a, b) => a.index - b.index);
}

/** Sort accumulated agents by index (the fan-out order). */
export function sortedAgents(agents: Map<string, WorkflowAgentInfo>): WorkflowAgentInfo[] {
  return [...agents.values()].sort((a, b) => a.index - b.index);
}
