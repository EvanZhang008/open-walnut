/**
 * A task's sessions over its life, and the engine switch inside a task
 * (server: src/web/routes/engine-switch-v1.ts, core/sessions/engine-switch.ts).
 */
import { ApiError, apiDelete, apiGet, apiPost } from './client';
import { withWriteRetry } from './write-retry';

export interface TaskSessionRow {
  session_id: string;
  engine: string;
  model: string | null;
  host: string | null;
  cwd: string | null;
  started_at: string | null;
  last_active_at: string | null;
  message_count: number;
  process_status: string;
  active: boolean;
  superseded_by?: string;
  switched_from?: {
    session_id: string; engine: string; model: string | null; at: string;
    carried_turns: number; trimmed_turns: number; compacted: boolean; transcript_path: string | null;
  };
  /** A switch back to this session's engine resumed it with the turns it missed (the latest one). */
  resumed?: { session_id: string; engine: string; at: string; carried_turns: number };
}

export interface TaskSessionsAnswer {
  taskId: string;
  activeSessionId: string | null;
  sessions: TaskSessionRow[];
  legacySessionIds: string[];
}

export function fetchTaskSessions(taskId: string): Promise<TaskSessionsAnswer> {
  return apiGet<TaskSessionsAnswer>(`/api/v1/tasks/${encodeURIComponent(taskId)}/sessions`, undefined, { priority: 'low' });
}

/** Cancel a switch that waits for the running turn; `deliver` sends its message to the current session. */
export function cancelEngineSwitch(taskId: string, deliver: boolean): Promise<{ cancelled: boolean; delivered?: boolean }> {
  return apiDelete(`/api/v1/tasks/${encodeURIComponent(taskId)}/switch-engine${deliver ? '?deliver=1' : ''}`);
}

export interface SwitchEngineAnswer {
  state: 'pending' | 'switching' | 'done';
  taskId: string;
  switchId?: string;
  sessionId?: string;
}

/** How long a switch waits for a server that went away mid-request (a deploy restart takes 10 to 60 s). */
export const SWITCH_RETRY_DELAYS_MS = [1000, 2000, 3000, 5000, 5000, 5000, 8000, 8000, 8000, 10_000, 10_000, 10_000, 15_000];

/**
 * Switch the task's engine now (the picker closed on another engine): a running turn is
 * stopped, and the new session starts with the carried conversation alone. Answers once
 * the switch is checked; the task row reports the rest (`engine_switch`).
 *
 * A request cut by a lost connection or a server restart (2026-11-05: "Load failed" during a
 * deploy) is tried again under the same op id until the server is back, so the server applies
 * the pick once. A retry that finds the earlier attempt took effect reads as that: the task
 * already on the engine (`same_engine`), or the switch still running (`switch_in_progress`).
 */
export async function switchTaskEngine(taskId: string, pick: { engine: string; model?: string; effort?: string }): Promise<SwitchEngineAnswer> {
  let attempts = 0;
  try {
    return await withWriteRetry((opId) => {
      attempts += 1;
      return apiPost<SwitchEngineAnswer>(`/api/v1/tasks/${encodeURIComponent(taskId)}/switch-engine`, {
        engine: pick.engine, ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}),
        when: 'now', detach: true, wait_ms: 15_000,
      }, { timeoutMs: 30_000, opId });
    }, SWITCH_RETRY_DELAYS_MS.length, (i) => SWITCH_RETRY_DELAYS_MS[i] ?? 15_000);
  } catch (err) {
    const code = err instanceof ApiError ? (err.body as { code?: unknown } | undefined)?.code : undefined;
    if (attempts > 1 && code === 'same_engine') return { state: 'done', taskId };
    if (attempts > 1 && code === 'switch_in_progress') return { state: 'switching', taskId };
    throw err;
  }
}
