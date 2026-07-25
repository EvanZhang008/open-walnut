import { useEffect, useRef, useState } from 'react';
import { useEvent } from './useWebSocket';
import { fetchWorkflowProgress } from '@/api/sessions';
import { log } from '@/utils/log';

/** One background task / dynamic-workflow subagent. Mirrors the backend
 *  SessionBackgroundTasksPayload.tasks[] shape (web defines its own copy — no
 *  backend type import, same convention as StreamingBlock). */
export interface BackgroundTask {
  taskId: string;
  description?: string;
  subagentType?: string;
  /** CLI task kind (local_agent | local_shell | in_process_teammate | …) —
   *  lets the panel split background AGENTS from plain background TASKS.
   *  Absent on tasks recovered from disk (recovery only keeps id→status). */
  taskType?: string;
  status: string; // running | completed | failed | stopped | paused
  tokens?: number;
  lastTool?: string;
  summary?: string;
  workflowName?: string;
}

/** A phase in a dynamic workflow (mirrors backend WorkflowPhaseInfo). */
export interface WorkflowPhase {
  index: number;
  title: string;
}

/** One subagent inside a dynamic workflow (mirrors backend WorkflowAgentInfo).
 *  Accumulated server-side by agentId across task_progress snapshots. */
export interface WorkflowAgent {
  agentId: string;
  index: number;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  status: string; // running | completed | failed | stopped | pending
  promptPreview?: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  startedAt?: number;
}

export interface BackgroundTasksState {
  /** Workflow name (when a dynamic workflow is running). */
  workflowName?: string;
  /** Human description of the workflow (from the generated script's meta). */
  workflowDescription?: string;
  /** The workflow script Claude generated — lets the UI show WHAT was created. */
  scriptSource?: string;
  /** Count of tasks still running (server-authoritative in-flight count). */
  inFlight: number;
  /** All background tasks seen this turn (legacy / non-workflow view). */
  tasks: BackgroundTask[];
  /** Workflow phases (dynamic workflows only). */
  phases: WorkflowPhase[];
  /** Per-subagent breakdown, accumulated server-side (dynamic workflows only). */
  agents: WorkflowAgent[];
}

const EMPTY: BackgroundTasksState = { inFlight: 0, tasks: [], phases: [], agents: [] };

/**
 * Live view of a session's background tasks / dynamic-workflow progress.
 *
 * Driven by `session:background-tasks` snapshots the server emits on every
 * task_started/progress/updated/notification. The server sends a full snapshot
 * each time (not deltas) — including the accumulated per-subagent `agents` union
 * for dynamic workflows — so we just replace state; a dropped event self-heals on
 * the next snapshot.
 *
 * `inFlight > 0` means the session is busy with background work even when the
 * main turn has produced its `result` — the UI uses this to keep showing
 * "running". It mirrors the backend's `hasActiveBackgroundWork()` and is
 * intentionally NOT derived from `result` events. The `agents`/`phases` fields
 * are display-only and must never feed completion logic.
 *
 * PERSISTENCE: live events only fire while the session is in memory. On page
 * reload / after server restart, the panel would be empty. So on mount we also
 * fetch the on-disk run manifest (/api/sessions/:id/workflow) as a fallback —
 * but a live event ALWAYS wins over the persisted snapshot (it's fresher), so
 * once any live snapshot arrives the fetch result is ignored.
 */
export function useBackgroundTasks(sessionId: string | undefined): BackgroundTasksState {
  const [state, setState] = useState<BackgroundTasksState>(EMPTY);
  // True once a live event has set state — gates the persisted-manifest fallback
  // so a slow fetch can't clobber fresher live data (race on reload of a live run).
  const sawLiveRef = useRef(false);

  // Reset when switching sessions so a stale workflow panel doesn't leak across.
  useEffect(() => { setState(EMPTY); sawLiveRef.current = false; }, [sessionId]);

  // Reload persistence: pull the on-disk manifest once on mount. Only applied if
  // no live event has arrived yet (live data is authoritative + fresher).
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchWorkflowProgress(sessionId).then((snap) => {
      if (cancelled || !snap || sawLiveRef.current) return;
      log.info('workflow', `restored persisted workflow: agents=${snap.agents?.length ?? 0} phases=${snap.phases?.length ?? 0}`, { sessionId });
      setState({
        workflowName: snap.workflowName,
        workflowDescription: snap.workflowDescription,
        scriptSource: snap.scriptSource,
        inFlight: snap.inFlight ?? 0,
        tasks: [],
        phases: Array.isArray(snap.phases) ? snap.phases : [],
        agents: Array.isArray(snap.agents) ? (snap.agents as WorkflowAgent[]) : [],
      });
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  // On WS reconnect, re-fetch the persisted manifest. A server restart drops the
  // in-memory ClaudeCodeSession (and thus the live event stream) but the daemon
  // keeps running — reattach recovers `_bgTasks` server-side and, once the recovery
  // or reconcile logic corrects it, re-emits a fresh snapshot; but the client may
  // have missed that server-side stream state before this listener existed
  // (inc-1784012867247: no reconnect handler here means the panel kept showing
  // whatever it last got BEFORE the disconnect, forever — every other stream-backed
  // hook in the codebase already re-syncs on reconnect, this one didn't). Setting
  // sawLiveRef back to false lets a still-authoritative manifest fetch apply even
  // though a live snapshot arrived before the disconnect.
  useEvent('_ws:reconnected', () => {
    if (!sessionId) return;
    sawLiveRef.current = false;
    fetchWorkflowProgress(sessionId).then((snap) => {
      if (!snap || sawLiveRef.current) return;
      log.info('workflow', `reconnect: restored persisted workflow: agents=${snap.agents?.length ?? 0} phases=${snap.phases?.length ?? 0}`, { sessionId });
      setState({
        workflowName: snap.workflowName,
        workflowDescription: snap.workflowDescription,
        scriptSource: snap.scriptSource,
        inFlight: snap.inFlight ?? 0,
        tasks: [],
        phases: Array.isArray(snap.phases) ? snap.phases : [],
        agents: Array.isArray(snap.agents) ? (snap.agents as WorkflowAgent[]) : [],
      });
    }).catch(() => {});
  });

  useEvent('session:background-tasks', (data) => {
    const d = data as {
      sessionId?: string;
      workflowName?: string;
      workflowDescription?: string;
      scriptSource?: string;
      inFlight?: number;
      tasks?: BackgroundTask[];
      phases?: WorkflowPhase[];
      agents?: WorkflowAgent[];
    };
    if (!sessionId || d.sessionId !== sessionId) return;
    sawLiveRef.current = true;
    // debug (gated), NOT info: this fires on EVERY task_progress snapshot. During a
    // large fan-out the snapshots are frequent, and log.info routes through the
    // browser-logger forwarder to the server log file — per-snapshot info logging on
    // a streaming hot path is the documented event-loop-starvation pattern. Opt in
    // with localStorage.walnutLogLevel = 'debug' when tracing.
    log.debug('workflow', `background-tasks snapshot: inFlight=${d.inFlight ?? 0} tasks=${d.tasks?.length ?? 0} agents=${d.agents?.length ?? 0}`, { sessionId });
    setState({
      workflowName: d.workflowName,
      workflowDescription: d.workflowDescription,
      scriptSource: d.scriptSource,
      inFlight: d.inFlight ?? 0,
      tasks: Array.isArray(d.tasks) ? d.tasks : [],
      phases: Array.isArray(d.phases) ? d.phases : [],
      agents: Array.isArray(d.agents) ? d.agents : [],
    });
  });

  return state;
}
