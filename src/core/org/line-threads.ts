/**
 * A task's lines read as threads in its own Threads (2026-11-19, the user: "let's make all a thread,
 * thread auto open for all task"). Each line of `user_status.lines` (task-lines.ts: what the task
 * asks of the user, does and waits on at once) is one thread there, opened by itself and gone when
 * the line is: projected on every read of the task's Threads, never stored, so nothing migrates and
 * an older client reads the same file it always did.
 *
 * Kept apart from the stored threads on purpose:
 *  - a line asking the user is already his Action needed item (`line.item`, action-needed.ts): the
 *    answer goes there and the counts count it there, never twice;
 *  - a waiting line (a watch, a schedule, a reply from another task) is no thread of a lead's or
 *    Main's, so the VP's Threads (which read only the stored file) never fill with pipeline watches,
 *    while the task's status still counts it.
 * Pure.
 */
import type { TaskLine, LineState } from '../task-lines.js';
import type { UserStatus } from '../user-status.js';
import type { OrgThread, ThreadState } from './threads-model.js';

/** The thread id a line reads under: never a stored thread's id (those are th-...). */
export const LINE_THREAD_PREFIX = 'line:';

/** How each line state reads as a thread state. */
const STATE_OF: Record<LineState, ThreadState> = { needs: 'needs', working: 'working', read: 'answered', waiting: 'pending' };

/** A line as a thread, with the line itself beside it (`line`) for the client to answer through. */
export type LineThread = OrgThread & { line: TaskLine };

export function lineThreads(status: UserStatus | undefined, at: string): LineThread[] {
  return (status?.lines ?? []).map((line) => ({
    id: `${LINE_THREAD_PREFIX}${line.id}`,
    title: line.what,
    titled: true,
    ...(line.state === 'needs' ? { ask: line.what } : {}),
    state: STATE_OF[line.state],
    messages: [],
    opener: { text: line.what, at, from: 'node', ...(line.item ? { ref: line.item } : {}), by: 'agent' },
    createdAt: at,
    updatedAt: at,
    line,
  }));
}

export function isLineThreadId(id: string): boolean {
  return id.startsWith(LINE_THREAD_PREFIX);
}
