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
import { replyTagNow } from './reply-card-switch.js';

const flag = experimentCache('threads_kept_by_walnut');
/** The experiment as last read (user-status-sync.ts sets it on every config change). */
export const setThreadsKept = flag.set;
export const threadsKeptNow = flag.now;
/** The experiment, read from the config now. */
export const threadsKeptOn = flag.on;

/**
 * Whether a line of the status question is the thread's card (its summary, a title for an untitled
 * thread, his reaction to an answer): this switch, or threads_reply_tag (reply-card-switch.ts),
 * whose card line is that same line said in the reply, so the question asks the same of the
 * threads no line named. 2026-11-25: with the tag on and this switch off, nothing asked whether his
 * new message reacted to an earlier answer except a turn end sent back for it.
 */
export const linesAreCards = (): boolean => flag.now() || replyTagNow();
