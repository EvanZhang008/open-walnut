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
import type { ImageAttachment } from './chat';
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
  /** CLIENT-ONLY, from the promote response: the folder the new task shares with
   *  the parent's task, so the badge can say "in folder". The list route never
   *  returns it, so it is gone after a refresh (the badge falls back). */
  promotedGroupId?: string;
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
 * The user started typing a new question: run the standby's cache warm-up turn
 * now, so the question itself lands as a cached follow-up (the fork's first API
 * call re-writes the whole prefix no matter when it happens). Cheap no-op on the
 * server when there is no usable standby or it is already warm.
 */
export function warmSideThreadStandby(
  sessionId: string,
): Promise<{ warmed: boolean; reason?: string }> {
  return apiPost(`/api/sessions/${sessionId}/side-threads/standby/warm`, {}, { timeoutMs: 15_000 });
}

/**
 * Open a new thread with its first question. Resolves once the thread record
 * exists (the ANSWER arrives later over the stream, so this is fast) — 409
 * `fork_unsupported` when the parent engine can't fork.
 *
 * Images ride the request body as raw base64 (the `/fork` route's shape, not the
 * WS send's upload-then-ref dance: this is already an HTTP POST, so there is no
 * 4MB frame cap to dodge). The server saves them and annotates the paths into the
 * thread's first message; the stored question stays the user's plain text.
 */
export function createSideThread(
  sessionId: string,
  question: string,
  title?: string,
  images?: ImageAttachment[],
): Promise<{ thread: SideThread }> {
  return apiPost(
    `/api/sessions/${sessionId}/side-threads`,
    {
      question,
      ...(title ? { title } : {}),
      ...(images && images.length > 0 ? { images } : {}),
    },
    { timeoutMs: 40_000 },
  );
}

/**
 * Promote a thread into a task, with the same semantics as session Fork: when the
 * parent session has a task, the new task is its SIBLING (`siblingOfTaskId`) inside
 * a shared folder (`groupId`); a taskless parent yields a top-level Inbox task and
 * neither field comes back.
 */
export function promoteSideThread(
  sessionId: string,
  threadId: string,
): Promise<{ taskId: string; sessionId: string; siblingOfTaskId?: string; groupId?: string }> {
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
