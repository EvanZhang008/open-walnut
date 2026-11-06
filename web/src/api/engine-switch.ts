/**
 * A task's sessions over its life, and the engine switch inside a task
 * (server: src/web/routes/engine-switch-v1.ts, core/sessions/engine-switch.ts).
 */
import { ApiError, apiDelete, apiGet, apiPost } from './client';
import { writeRetryable } from './write-retry';
import { mintOpId } from './op-id';

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

/** How long a switch keeps trying while the server is away (a deploy restart takes 10 to 60 s). */
export const SWITCH_RETRY_TOTAL_MS = 90_000;
/** A newer pick for the same task took this one's place before a retry: nothing more is sent. */
export class SwitchSuperseded extends Error {
  constructor() { super('A newer engine pick took the place of this one.'); this.name = 'SwitchSuperseded'; }
}
/** taskId -> the generation of its newest pick in this tab. */
const latestPick = new Map<string, number>();

/** The wait before each new attempt. */
export const SWITCH_RETRY_DELAYS_MS = [1000, 2000, 3000, 5000];

/**
 * Switch the task's engine now (the picker closed on another engine): a running turn is
 * stopped, and the new session starts with the carried conversation alone. Answers once
 * the switch is checked; the task row reports the rest (`engine_switch`).
 *
 * A request cut by a lost connection or a server restart (2026-11-05: "Load failed" during a
 * deploy) is tried again under the same op id until SWITCH_RETRY_TOTAL_MS have passed, each
 * attempt and wait cut to the time left, so the server applies the pick once. A retry that finds
 * the earlier attempt took effect reads as that: the task already on the engine (`same_engine`),
 * or the switch still running (`switch_in_progress`).
 */
export async function switchTaskEngine(
  taskId: string, pick: { engine: string; model?: string; effort?: string; /** The new session's first message. */ text?: string }, opts: { withdraw?: boolean } = {},
): Promise<SwitchEngineAnswer> {
  const deadline = Date.now() + SWITCH_RETRY_TOTAL_MS;
  const opId = mintOpId();
  // A newer pick for the task ends this one's retries (review round 5: a Pi pick still retrying
  // after the user picked Codex could switch the task back to Pi once Walnut was back).
  const generation = (latestPick.get(taskId) ?? 0) + 1;
  latestPick.set(taskId, generation);
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0 && latestPick.get(taskId) !== generation) throw new SwitchSuperseded();
    const left = deadline - Date.now();
    try {
      return await apiPost<SwitchEngineAnswer>(`/api/v1/tasks/${encodeURIComponent(taskId)}/switch-engine`, {
        engine: pick.engine, ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}),
        ...(pick.text ? { text: pick.text } : {}),
        when: 'now', detach: true, wait_ms: 15_000,
      }, { timeoutMs: Math.max(1000, Math.min(30_000, left)), opId });
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: unknown } | undefined)?.code : undefined;
      // A newer pick took this one's place (here, or queued on the server): its answer is not this one's.
      if (code === 'switch_superseded' || latestPick.get(taskId) !== generation) throw new SwitchSuperseded();
      // A withdrawal (the person picked the engine the task is on again): the task staying there is the answer.
      if ((attempt > 0 || opts.withdraw) && code === 'same_engine') return { state: 'done', taskId };
      if (attempt > 0 && code === 'switch_in_progress') return { state: 'switching', taskId };
      const wait = SWITCH_RETRY_DELAYS_MS[Math.min(attempt, SWITCH_RETRY_DELAYS_MS.length - 1)];
      if (!writeRetryable(err) || Date.now() + wait >= deadline) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
