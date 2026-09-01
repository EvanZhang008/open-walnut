/**
 * Side-question ("/btw") API — the native Claude Code side_question run inside a
 * live coding session. Answer stays out of the main transcript; we persist a
 * traceable history that can be promoted into a task.
 *
 * Backend: src/web/routes/sessions.ts (POST/GET/DELETE /:sid/side-question*).
 */
import { apiGet, apiPost, apiDelete } from './client';

export interface SideQuestion {
  id: string;
  sessionId: string;
  question: string;
  /** Optional since side threads: a thread entry stores the question only (the
   *  answer lives in its session transcript). Legacy one-shot rows always have
   *  one, but render defensively. */
  answer?: string;
  createdAt: string;
  promotedTaskId?: string;
  /** UI-only: set after promote to label "subtask" vs "task" (not persisted). */
  promotedAsSubtask?: boolean;
}

export function listSideQuestions(sessionId: string): Promise<{ sideQuestions: SideQuestion[] }> {
  return apiGet(`/api/sessions/${sessionId}/side-questions`);
}

/** Ask a side question. Single-shot — resolves with the persisted entry once the
 *  CLI's control_response arrives (no token streaming). Allow generous timeout. */
export function askSideQuestion(sessionId: string, question: string): Promise<{ sideQuestion: SideQuestion }> {
  return apiPost(`/api/sessions/${sessionId}/side-question`, { question }, { timeoutMs: 70_000 });
}

/** Promote a Q&A into a task. If the session is working on a task, the new task
 *  is filed as its SUBTASK (parentTaskId set); otherwise a top-level task.
 *
 *  Server-side this is fast (p50 ~750ms, no CLI round-trip). The drawer promotes
 *  OPTIMISTICALLY (marks done immediately, reconciles in the background) so a
 *  transient event-loop stall never makes the user wait — hence the plain
 *  default timeout, not an inflated one. */
export function promoteSideQuestion(sessionId: string, id: string): Promise<{ taskId: string; parentTaskId?: string }> {
  return apiPost(`/api/sessions/${sessionId}/side-question/${id}/promote`);
}

export function deleteSideQuestion(sessionId: string, id: string): Promise<void> {
  return apiDelete(`/api/sessions/${sessionId}/side-question/${id}`);
}
