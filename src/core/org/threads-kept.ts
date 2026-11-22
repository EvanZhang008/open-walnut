/**
 * The switch of the experiment `threads_kept_by_walnut` (experimental.ts; 2026-11-22, the user, on
 * a VP that wrote a thread before each reply: "every thread is being updated, every question has to
 * do this ... that's unbelievable, and very wasteful"). On: a node that keeps Threads answers him in
 * the chat and writes no thread for each message; the status question at its turn's end asks where
 * each open thread stands, Main and the leads included (sessions/status-threads.ts asksThreads), and
 * Walnut writes the answer (state, summary, a title for an untitled one, a known mark he earned).
 * Its prompt says so (session-context.ts THREADS_KEPT_LINE), the `threads` hint no longer asks for a
 * title (thread-capture.ts threadHintText), and neither the `threads-tidy` hint nor the Stop hook
 * (thread-summary-stop.ts) asks for a thread write. Off keeps the behavior from before it.
 * No store import here: the stores import this.
 */
import { experimentCache } from '../experimental-cache.js';

const flag = experimentCache('threads_kept_by_walnut');
/** The experiment as last read (user-status-sync.ts sets it on every config change). */
export const setThreadsKept = flag.set;
export const threadsKeptNow = flag.now;
/** The experiment, read from the config now. */
export const threadsKeptOn = flag.on;
