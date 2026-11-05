/**
 * A task's sessions over its life, and the engine switch inside a task
 * (server: src/web/routes/engine-switch-v1.ts, core/sessions/engine-switch.ts).
 */
import { apiDelete, apiGet, apiPost } from './client';

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

/**
 * Switch the task's engine now (the picker closed on another engine): a running turn is
 * stopped, and the new session starts with the carried conversation alone. Answers once
 * the switch is checked; the task row reports the rest (`engine_switch`).
 */
export function switchTaskEngine(taskId: string, pick: { engine: string; model?: string; effort?: string }): Promise<SwitchEngineAnswer> {
  return apiPost<SwitchEngineAnswer>(`/api/v1/tasks/${encodeURIComponent(taskId)}/switch-engine`, {
    engine: pick.engine, ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}),
    when: 'now', detach: true, wait_ms: 15_000,
  }, { timeoutMs: 30_000 });
}
