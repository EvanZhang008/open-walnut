/**
 * A wait that a turn only interrupted comes back when that turn ends.
 *
 * Any new turn takes a WAITING task to IN_PROGRESS (phase.ts), and its end used
 * to hand the task back as NEED_ACTION with the clock gone. That is right when
 * the turn is what the task waited for (its trigger fired, its wait_until
 * passed, a reply or a subtask's result came in) or when a person wrote to it.
 * It is wrong when a peer task's message, a Walnut status notice or the
 * session's own background work merely ran a turn in between: on 2026-10-25 a
 * worker parked on an armed trigger with its tests still queued flipped to
 * NEED_ACTION seven times in three and a half hours, and every flip put one
 * more item in the user's "needs you" count that did not need them.
 *
 * So when the session machine moves a task out of WAITING for such a turn, the
 * wait is remembered here, and at that turn's clean end (phase.ts) the task goes
 * back to WAITING with the same wait_until, but only while:
 *   - the task still has a trigger delivering to it that is armed, none that the
 *     server stopped after failing checks (a stop needs a look), and none fired
 *     since the wait was left;
 *   - nothing ended the wait on the way: a send that is not an interruption (a
 *     person's, a trigger fire, the clock, a reply, a re-delivery), a prompt for
 *     the human, a session error, or any phase write in between (the task's
 *     phase_changed_at is still the one its exit stamped), which covers the
 *     session or a leader setting its own phase;
 *   - a turn nobody sent ('self') was the CLI's own follow-up for background
 *     work that came back (its result says origin task-notification), never a
 *     ScheduleWakeup or loop turn, which hands back by the 2026-09-01 rule.
 * A wait with only a clock is not brought back: the turn that ends it may well
 * be the reply or the result it waited for, and a hidden result costs the user
 * more than one extra red row. The clock stays exactly what it was; one that
 * passed meanwhile fires at once from the restored wait (task-wait-until.ts).
 *
 * The interrupting message itself carries one line saying so (waitNoteFor), so
 * the session can hand the task back itself when the user is needed after all.
 *
 * In memory on purpose: a server restart in the middle of such a turn only
 * loses the return (the turn ends as NEED_ACTION, the behaviour before this).
 */
import { log } from '../logging/index.js';
import type { Task } from './types.js';
import type { WatchingTrigger } from './task-wait-wake.js';

/** Why the wait was left: a message that is not the awaited event, or a turn the CLI started itself. */
export type WaitExitCause = 'message' | 'self';

interface InterruptedWait {
  /** The task's wait_until when it left WAITING; null = a wait with no clock. */
  waitUntil: string | null;
  /** phase_changed_at the exit wrote: anything that moves the phase after it changes it. */
  leftAt: string;
  sessionId?: string;
  cause: WaitExitCause;
  source: string;
  /** Each trigger's fire count when the wait was left (filled in shortly after). */
  fires?: Record<string, number>;
  notedAtMs: number;
}

const interrupted = new Map<string, InterruptedWait>();
const MAX_AGE_MS = 7 * 86_400_000;

/** Send sources whose turn is an interruption, not the event the task waits on.
 *  An allowlist: a source missing here ends the wait as before. Never in it: a
 *  person (ui, mobile, cli, web-api, api-v1, chat, human-inbox), the wait's own
 *  exits ('wait-until', every 'routine-*' and 'trigger-*' delivery), a start, a
 *  hook (it may forward the very event), and the 'restart' / 'retry' kicks, which
 *  carry a message of any origin (a Retry is a person's click). A reply or a
 *  subtask's completion rides 'peer' / 'walnut-notify' with endsWait. */
const INTERRUPTING_SEND_SOURCES: ReadonlySet<string> = new Set([
  'peer',          // another task's task_send
  'walnut-notify', // a subtask's status notice, a trigger-health note
  'auto-continue', // session-auto-continue.ts AUTO_CONTINUE_SOURCE
  'auto-recover',  // sessions/auto-recover-env.ts AUTO_RECOVER_SOURCE
]);

/** The cause a WAITING → IN_PROGRESS edge records, or null when its turn ends the wait for good. */
export function waitExitCause(trigger: string, sendSource: string | undefined, endsWait = false): WaitExitCause | null {
  if (trigger === 'session:turn-start') return 'self';
  if (trigger !== 'session:input' || !sendSource || endsWait) return null;
  return INTERRUPTING_SEND_SOURCES.has(sendSource) ? 'message' : null;
}

export function noteInterruptedWait(taskId: string, entry: Omit<InterruptedWait, 'notedAtMs' | 'fires'>): void {
  const now = Date.now();
  for (const [id, e] of interrupted) if (now - e.notedAtMs > MAX_AGE_MS) interrupted.delete(id);
  const noted: InterruptedWait = { ...entry, notedAtMs: now };
  interrupted.set(taskId, noted);
  log.session.info('wait interrupted by a turn; it comes back at the turn end while the task has an armed trigger', {
    taskId, sessionId: entry.sessionId, cause: entry.cause, source: entry.source, waitUntil: entry.waitUntil,
  });
  // The fire counts to compare at the turn end: a fire in between (one a host
  // delivered straight into the CLI shows here only as a turn) ends the wait.
  void import('./task-wait-until.js')
    .then(({ triggersWatching }) => triggersWatching(taskId))
    .then((triggers) => { noted.fires = Object.fromEntries(triggers.map((t) => [t.id, t.fires])); })
    .catch(() => {});
}

export function hasInterruptedWait(taskId: string): boolean {
  return interrupted.has(taskId);
}

/** The exit stamp of the remembered wait, for the writer's last check under the row lock. */
export function interruptedWaitLeftAt(taskId: string): string | undefined {
  return interrupted.get(taskId)?.leftAt;
}

/** Forget the wait. With `leftAt`, only the one that exit stamped (a newer exit keeps its own). */
export function dropInterruptedWait(taskId: string, reason: string, leftAt?: string): void {
  const entry = interrupted.get(taskId);
  if (!entry || (leftAt !== undefined && entry.leftAt !== leftAt)) return;
  interrupted.delete(taskId);
  log.session.info('interrupted wait dropped', { taskId, reason });
}

/** An interrupting message into a turn that started on its own: the turn is the message's now. */
export function markInterruptedByMessage(taskId: string, source: string): void {
  const entry = interrupted.get(taskId);
  if (entry && entry.cause === 'self') {
    entry.cause = 'message';
    entry.source = source;
  }
}

/** What a trigger list says about the wait: may it come back? */
export function triggersHoldWait(
  triggers: ReadonlyArray<Pick<WatchingTrigger, 'state'> & Partial<Pick<WatchingTrigger, 'id' | 'fires'>>>,
  firesAtExit?: Readonly<Record<string, number>>,
): boolean {
  if (!triggers.some((t) => t.state === 'armed') || triggers.some((t) => t.state === 'stopped')) return false;
  if (!firesAtExit) return true;
  return !triggers.some((t) => t.id !== undefined && t.fires !== undefined
    && t.id in firesAtExit && t.fires > firesAtExit[t.id]);
}

/**
 * The wait to restore at this turn end, or null for the normal hand-back. Reads
 * the task as the caller fetched it; the caller re-checks phase_changed_at and
 * the entry against the row it writes. Drops a stale entry; a live one stays
 * until the caller's write lands (consumeInterruptedWait).
 */
export async function resumableWait(task: Readonly<Task>, sessionId: string | undefined): Promise<{ waitUntil: string | null } | null> {
  const entry = interrupted.get(task.id);
  if (!entry) return null;
  if (task.phase !== 'IN_PROGRESS' || task.phase_changed_at !== entry.leftAt) {
    dropInterruptedWait(task.id, 'phase-moved', entry.leftAt);
    return null;
  }
  // Another session of the task ending its turn is not the end of this one.
  if (entry.sessionId && sessionId && entry.sessionId !== sessionId) return null;
  if (entry.cause === 'self') {
    const { sessionRunner } = await import('../providers/claude-code-session.js');
    const origin = sessionId ? sessionRunner.findSessionByClaudeId(sessionId)?.lastResultOrigin : undefined;
    if (origin !== 'task-notification') {
      dropInterruptedWait(task.id, 'not-a-background-followup', entry.leftAt);
      return null;
    }
  }
  const { triggersWatching } = await import('./task-wait-until.js');
  const triggers = await triggersWatching(task.id);
  if (!triggersHoldWait(triggers, entry.fires)) {
    dropInterruptedWait(task.id, triggers.length === 0 ? 'no-trigger' : 'trigger-not-armed-or-fired', entry.leftAt);
    return null;
  }
  return { waitUntil: entry.waitUntil };
}

/** Restored waits: the phase_changed_at the restore wrote → when the wait was left. */
const restored = new Map<string, { stamp: string; leftAt: string }>();

/** The wait came back (phase.ts wrote WAITING with `stamp`); forget the exit. */
export function consumeInterruptedWait(taskId: string, stamp?: string): void {
  const entry = interrupted.get(taskId);
  interrupted.delete(taskId);
  if (entry && stamp) {
    if (restored.size > 1000) restored.clear(); // a lost entry only makes a late host fire compare against the restore
    restored.set(taskId, { stamp, leftAt: entry.leftAt });
  }
}

/**
 * When a WAITING task's wait began, as a fire delivered on its host compares it:
 * a wait that came back at the end of an interrupting turn began when it was
 * left, not when it came back (trigger-events.ts wakeParkedTarget).
 */
export function heldSinceOf(task: Readonly<Pick<Task, 'id' | 'phase_changed_at'>>): string | undefined {
  const r = restored.get(task.id);
  if (r && r.stamp !== task.phase_changed_at) restored.delete(task.id);
  return r && r.stamp === task.phase_changed_at ? r.leftAt : task.phase_changed_at;
}

/**
 * The line an interrupting message carries into a WAITING task's session, or
 * null. Never throws (a send must not fail over a note).
 */
export async function waitNoteFor(sessionId: string, source: string | undefined, endsWait: boolean): Promise<string | null> {
  if (waitExitCause('session:input', source, endsWait) === null) return null;
  try {
    const { getSessionByClaudeId } = await import('./session-tracker.js');
    const taskId = (await getSessionByClaudeId(sessionId))?.taskId;
    if (!taskId) return null;
    const { getTask } = await import('./task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    if (task?.phase !== 'WAITING') return null;
    const { triggersWatching } = await import('./task-wait-until.js');
    if (!triggersHoldWait(await triggersWatching(taskId))) return null;
    const { buildWalnutMessage } = await import('./peers/walnut-message-tag.js');
    const until = task.wait_until ? ` until ${task.wait_until}` : '';
    return buildWalnutMessage({
      kind: 'notification',
      attrs: { from: 'Walnut', 'about-task': taskId, outcome: 'waiting', note: 'automated Walnut status notice' },
      body: `Your task is Waiting${until} on its armed trigger, and this message does not end that: when this turn ends `
        + 'the task goes back to Waiting with the same time. If the user is needed now, set it with task_update '
        + 'phase=NEED_ACTION before you end the turn; if the wait is over, set the phase you mean. A status notice, not a request.',
    });
  } catch (err) {
    log.session.warn('wait note skipped', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Test seam. */
export function interruptedWaits(): ReadonlyMap<string, Readonly<InterruptedWait>> {
  return interrupted;
}

export function resetInterruptedWaitsForTest(): void {
  interrupted.clear();
  restored.clear();
}
