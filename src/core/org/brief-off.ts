/**
 * The switch of the experiment `brief_off` (experimental.ts; step 5 of "Only Threads"): the Brief,
 * a hand-written retelling of Needs you / Working / Waiting that was often stale, is gone. A
 * node's Threads grouped by state take its place on the Org page (web OrgThreadsByState), its
 * agents are no longer asked to write it (the prompt's Brief rules, the `brief` hint, the refresh
 * turn and the start note drop it), and a brief_write answers BRIEF_OFF_NOTE instead of writing.
 * Stored Briefs are kept as they are, so an older release still starts on them and brief_read
 * still reads them. A Board choice waits on him as a thread of its leader (boards/choice-threads.ts).
 *
 * Off keeps every path as before it. No store import here: the prompt builder imports this.
 */
import { experimentCache } from '../experimental-cache.js';
import { threadsKeptNow } from './threads-kept.js';
import { STATUS_QUESTION } from '../../lib/internal-lines.js';

/** The switch itself, for the runtime that follows it (boards/choice-threads.ts). */
export const briefOffFlag = experimentCache('brief_off');
const flag = briefOffFlag;
/** The experiment as last read: user-status-sync.ts sets it on every config change, and every
 *  briefOffOn() call (buildSessionContext reads it before each prompt) refreshes it. */
export const setBriefOff = flag.set;
export const briefOffNow = flag.now;
/** The experiment, read from the config now (a route right after Settings changed it agrees). */
export const briefOffOn = flag.on;

/** What a brief_write hears while the Brief is off: a success that wrote nothing, so an older prompt never retries it. */
export const BRIEF_OFF_NOTE = 'The Brief is turned off here (experiment brief_off): nothing was written and nothing needs to be. '
  + 'The user reads your Threads grouped by state instead: keep each thread current with thread_update. Do not call brief_write again.';
/** The same with threads_kept_by_walnut on (threads-kept.ts): Walnut writes the threads from the status answer. */
export const BRIEF_OFF_KEPT_NOTE = 'The Brief is turned off here (experiment brief_off): nothing was written or needs to be. '
  + `The user reads your Threads by state instead; Walnut keeps them from your lines in ${STATUS_QUESTION}. Do not call brief_write again.`;
export const briefOffNote = (): string => (threadsKeptNow() ? BRIEF_OFF_KEPT_NOTE : BRIEF_OFF_NOTE);
