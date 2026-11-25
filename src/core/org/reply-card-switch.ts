/**
 * The switch of the experiment `threads_reply_tag` (experimental.ts; 2026-11-25, the user,
 * translated: "it can do two things at once: in what it returns, it adds this tag. Then it is both
 * its reply to me and its reply to the thread"). On: a session that keeps Threads ends its reply
 * with one hidden line per thread it spoke for (lib/card-tag.ts), Walnut writes the card from it at
 * the turn's end (reply-card.ts), sends a wrong or missing one back in the same turn
 * (reply-card-stop.ts), and the status question asks only about the threads no line named. Off:
 * nothing reads the line, and no text asks for it; a line a session still writes stays hidden.
 * No store import here: the prompt builder and the stores read it.
 */
import { experimentCache } from '../experimental-cache.js';

const flag = experimentCache('threads_reply_tag');
/** The experiment as last read (user-status-sync.ts and sessions/prompt-inputs.ts set it). */
export const setReplyTag = flag.set;
export const replyTagNow = flag.now;
/** The experiment, read from the config now. */
export const replyTagOn = flag.on;
