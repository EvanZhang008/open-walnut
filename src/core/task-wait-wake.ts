/**
 * What the `wait_until` clock says when it wakes a parked task's session.
 *
 * The clock running out means nothing brought the task back in time, and from
 * inside the session that reads the same whether the thing has not happened yet
 * or the trigger watching it missed it (a wrong check, a paused trigger, the
 * event landing somewhere the check does not look). So the note names every
 * trigger on the task with its state and its last check, and asks the session
 * to look at the thing itself before it parks again. 2026-10-05, the user: keep
 * the clock short, because nobody knows yet whether a new trigger works, and
 * re-check each time it runs out.
 *
 * Pure (no imports): task-wait-until.ts reads the triggers and sends the note.
 */

export interface WatchingTrigger {
  id: string;
  name?: string;
  everyMs?: number;
  /** triggerRunState: armed | paused | stopped. */
  state: string;
  fires: number;
  lastCheck?: { atMs?: number; outcome?: string; reason?: string; items?: number; error?: string };
}

const MAX_LISTED = 5;

function every(ms: number | undefined): string {
  if (!ms || ms <= 0) return 'on an unknown interval';
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `every ${ms / 60_000}m`;
  return `every ${Math.round(ms / 1000)}s`;
}

function ago(atMs: number, nowMs: number): string {
  const min = Math.max(0, Math.round((nowMs - atMs) / 60_000));
  if (min < 1) return 'just now';
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)} days ago`;
}

function lastCheckText(check: WatchingTrigger['lastCheck'], nowMs: number): string {
  if (!check || typeof check.atMs !== 'number') return 'it has not reported a single check yet';
  const when = `last check ${ago(check.atMs, nowMs)}`;
  if (check.outcome === 'error') return `${when}: error (${(check.error ?? 'unknown').slice(0, 200)})`;
  if (check.outcome === 'fired') return `${when}: fired with ${check.items ?? 0} new item(s)`;
  if (check.reason === 'rate-limited') return `${when}: a fire held back by its fire budget`;
  if (check.reason === 'all-seen') return `${when}: quiet (only items it had already delivered)`;
  return `${when}: quiet (the check found nothing to fire on)`;
}

function stateText(t: WatchingTrigger): string {
  if (t.state === 'paused') return 'PAUSED, so it is not checking at all';
  if (t.state === 'stopped') return 'STOPPED after its check kept failing, so it is not checking at all';
  return 'armed';
}

export function describeWatchingTrigger(t: WatchingTrigger, nowMs: number): string {
  const name = t.name ? `"${t.name}" (${t.id})` : t.id;
  const fired = `fired ${t.fires} time${t.fires === 1 ? '' : 's'}`;
  return `- ${name}: ${stateText(t)}, ${every(t.everyMs)}, ${fired}; ${lastCheckText(t.lastCheck, nowMs)}.`;
}

export function buildWaitWakeBody(opts: { until: string; nowMs: number; triggers: readonly WatchingTrigger[] }): string {
  const head = `The wait on this task ran until ${opts.until}, and nothing brought it back before then.`;
  if (opts.triggers.length === 0) {
    return `${head} No trigger watches it. Take it from here: check what it was waiting for, do what is next, `
      + 'and tell the user where things stand.';
  }
  const listed = opts.triggers.slice(0, MAX_LISTED).map((t) => describeWatchingTrigger(t, opts.nowMs));
  const more = opts.triggers.length > MAX_LISTED ? [`- and ${opts.triggers.length - MAX_LISTED} more (trigger_list)`] : [];
  return [
    `${head} Either the thing it waits on has not happened yet, or the trigger missed it, and only a look at `
      + 'the thing itself tells which.',
    ['Triggers on this task:', ...listed, ...more].join('\n'),
    [
      'Check now, carefully:',
      '1. Look at the thing itself (the PR, the build, the page, the reply): has it happened, or changed in a way that matters?',
      '2. If it happened and no fire came, the trigger is wrong. Find out why (run its check with trigger_test, read its '
        + 'recent checks in trigger_list), replace it with a check that would have caught it (trigger_delete, then '
        + 'trigger_create), and act on what happened.',
      '3. If it has not happened, is the trigger still sound: armed, checking without errors, and watching everything '
        + 'that would count (another place the answer could land, a state the check does not know)? Fix what is not.',
    ].join('\n'),
    'Then act on what you found. If it is still to come and the trigger is sound, park again (task_update '
      + 'phase=WAITING) with a wait_until for when you now expect it, kept short; that needs no word to the user. '
      + 'If the wait no longer makes sense (long overdue, the plan changed), tell the user in one line and leave it with them.',
  ].join('\n\n');
}
