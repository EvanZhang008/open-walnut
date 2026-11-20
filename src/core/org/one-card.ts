/**
 * The switch of the experiment `threads_one_card` (experimental.ts): what waits on the user is one
 * card (a thread's choices as buttons, no Acknowledge on a card that waits on him, the one ask card
 * frame), a task's own ask lives on its thread (thread-report-ask.ts), an open answered thread reads
 * To read, the needs_options refusal (thread-options.ts), and his words on a decision letter's thread
 * answer that letter (letter-follow-up.ts) with the short-yes rule (answer-approval.ts). Off keeps
 * the behavior from before it; the fields it stores (options, recommended, a send's clientId) are
 * written either way. No store import here: the stores import this.
 */
import { experimentalEnabled } from '../experimental.js';

let on = false;
/** The experiment as last read (user-status-sync.ts sets it on every config change). */
export function setOneCard(value: boolean): void { on = value; }
export function oneCardNow(): boolean { return on; }

/** The experiment, read from the config now (a route right after Settings changed it agrees). */
export async function oneCardOn(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js');
    on = experimentalEnabled((await getConfig()).experimental, 'threads_one_card');
  } catch { /* the last value read stands */ }
  return on;
}
