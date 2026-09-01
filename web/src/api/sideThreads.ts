/**
 * Side THREADS API — the multi-turn evolution of the one-shot "/btw" side question.
 *
 * A side thread is a HIDDEN FORK of the parent coding session: its own session id,
 * its own transcript, its own streaming. The parent conversation never sees it, so
 * the user can dig at a tangent ("why is this test flaky?") without spending the
 * main thread's context, then either inject the conclusion into the composer or
 * promote it into a task.
 *
 * Backend: src/web/routes/sessions.ts (GET/POST/DELETE /:sid/side-threads*).
 * The old one-shot entries still come back on the GET as `legacy` — rendered
 * read-only by the drawer (see web/src/api/sideQuestions.ts for their client).
 */
import { apiGet, apiPost, apiDelete, ApiError } from './client';
import type { SideQuestion } from './sideQuestions';

export interface SideThread {
  id: string;
  /** Chip label. OPTIONAL server-side (`SideQuestion.title`) — a row stored
   *  without one falls back to `question` at the UI layer (sideThreadLabel). */
  title?: string;
  /** The thread's first question. Present on list rows, absent on the create
   *  response (which returns only the identity fields). */
  question?: string;
  /** The FORKED session id — what SessionChatHistory renders and sends to. */
  threadSessionId: string;
  createdAt: string;
  promotedTaskId?: string;
  /** Its session record is gone or archived — the transcript is history only. */
  archived?: boolean;
}

export interface SideThreadsResponse {
  threads: SideThread[];
  /** Pre-thread one-shot Q&A entries. Read-only in the UI. */
  legacy: SideQuestion[];
}

export function listSideThreads(sessionId: string): Promise<SideThreadsResponse> {
  return apiGet(`/api/sessions/${sessionId}/side-threads`);
}

/**
 * Prewarm a standby fork so the FIRST ask is instant (the fork spawn is the slow
 * part, not the question). Fire-and-forget by contract: the caller must never
 * await this on a UI path, and a failure is a missed optimisation, not an error.
 */
export function prewarmSideThreadStandby(sessionId: string): Promise<{ ok: true }> {
  return apiPost(`/api/sessions/${sessionId}/side-threads/standby`);
}

/**
 * Open a new thread with its first question. Resolves once the thread record
 * exists (the ANSWER arrives later over the stream, so this is fast) — 409
 * `fork_unsupported` when the parent engine can't fork.
 */
export function createSideThread(
  sessionId: string,
  question: string,
  title?: string,
): Promise<{ thread: SideThread }> {
  return apiPost(
    `/api/sessions/${sessionId}/side-threads`,
    title ? { question, title } : { question },
    { timeoutMs: 40_000 },
  );
}

/** Promote a thread into a task (subtask of the parent's task when it has one). */
export function promoteSideThread(
  sessionId: string,
  threadId: string,
): Promise<{ taskId: string; parentTaskId?: string }> {
  return apiPost(`/api/sessions/${sessionId}/side-threads/${threadId}/promote`);
}

export function deleteSideThread(sessionId: string, threadId: string): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`/api/sessions/${sessionId}/side-threads/${threadId}`);
}

/** True for the 409 the server returns when the parent engine can't fork. */
export function isForkUnsupportedError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const body = err.body as { error?: string } | undefined;
  return body?.error === 'fork_unsupported' || err.message === 'fork_unsupported';
}
