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
 * A turn the server did not send itself is still judged by what opened it: the
 * daemon writes every line it delivers into the session's stream (a
 * walnut-injected marker, its host's own same-host deliveries included), and
 * that copy's envelopes say whose it is (classifyInjectedLine). 2026-10-29: a
 * peer's note the host delivered straight into the CLI read as 'self', and its
 * clean end handed a parked task to the user.
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
import { parseWalnutMessage } from './peers/walnut-message-tag.js';

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
  /** The cause came from the stream's copy of a line, not from a send this server made. */
  byLine?: boolean;
  /** Each trigger's fire count when the wait was left (filled in shortly after). */
  fires?: Record<string, number>;
  notedAtMs: number;
}

const interrupted = new Map<string, InterruptedWait>();
const MAX_AGE_MS = 7 * 86_400_000;
/** Task → the session turn in which a line that ends the wait came in before the wait was remembered. */
const endsSeen = new Map<string, { sessionId?: string; turn: number }>();

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

/**
 * The cause a WAITING → IN_PROGRESS edge records, or null when its turn ends the wait for good.
 * `lineSource`: what the lines that opened a turn the server did not send are (classifyInjectedLine,
 * merged by strongerLine); undefined = no line opened it (the CLI's own turn). What the wait
 * waited for ('ends') or a person's words (null) opening it end the wait, as their sends do.
 */
export function waitExitCause(trigger: string, sendSource: string | undefined, endsWait = false, lineSource?: InjectedLineClass): WaitExitCause | null {
  if (trigger === 'session:turn-start') {
    if (lineSource === undefined) return 'self';
    return interruptingLine(lineSource) ? 'message' : null;
  }
  if (trigger !== 'session:input' || !sendSource || endsWait) return null;
  return INTERRUPTING_SEND_SOURCES.has(sendSource) ? 'message' : null;
}

/**
 * What a delivered line is, read from the stream's copy of it (the daemon's
 * walnut-injected marker), the same way the server's send source says it:
 *   - 'peer': another task's note (a peer-note envelope), an interruption;
 *   - 'walnut-notify': only Walnut status notices, an interruption;
 *   - 'ends': what a wait waits for (a reply, a trigger's fire, a request's
 *     settlement, a subtask that completed or failed, a plugin App's state);
 *   - null: anything else, a person's words first among them (no envelope leads).
 * Only the envelopes the line opens with count (hint blocks between them are
 * skipped). Words after a peer's note are Walnut's tail on it (the reply
 * trailer); words after notices alone are someone's message that Walnut put a
 * note in front of (the place or instruction notice rides any line), so null.
 * An envelope body can never hold a tag (walnut-message-tag.ts), so a sender's
 * words cannot make a line read as anything but its own envelope.
 */
export type InjectedLineClass = 'peer' | 'walnut-notify' | 'ends' | null;

/** Notice outcomes a send carries with endsWait (subtask-notices.ts, session-request-notify.ts). */
const WAIT_ENDING_OUTCOMES: ReadonlySet<string> = new Set(['completed', 'error', 'timeout', 'awaiting_human']);
const HINT_OPEN = '<system-reminder>';
const HINT_CLOSE = '</system-reminder>';

export function interruptingLine(line: InjectedLineClass | undefined): line is 'peer' | 'walnut-notify' {
  return line === 'peer' || line === 'walnut-notify';
}

/**
 * Two lines delivered between turns run as ONE turn of the CLI: the turn is what
 * the stronger says. What the wait waited for, or a person's words, wins over an
 * interruption, whichever came last (a reply then a peer's note must not read
 * as the note's turn and hide the reply).
 */
export function strongerLine(prev: InjectedLineClass | undefined, next: InjectedLineClass): InjectedLineClass {
  if (prev === undefined) return next;
  return interruptingLine(prev) ? next : prev;
}

export function classifyInjectedLine(content: string): InjectedLineClass {
  let rest = content.trimStart();
  let peer = false;
  let notice = false;
  for (;;) {
    if (rest.startsWith(HINT_OPEN)) {
      const end = rest.indexOf(HINT_CLOSE);
      if (end < 0) break;
      rest = rest.slice(end + HINT_CLOSE.length).trimStart();
      continue;
    }
    if (!rest.startsWith('<walnut-message ')) {
      if (rest && !peer) return null;
      break;
    }
    const envelope = parseWalnutMessage(rest);
    if (!envelope || !rest.startsWith(envelope.raw)) return peer ? 'peer' : null;
    if (envelope.kind === 'peer-note') peer = true;
    else if (envelope.kind === 'notification' && !envelope.attrs.request && !WAIT_ENDING_OUTCOMES.has(envelope.attrs.outcome ?? '')) notice = true;
    else return 'ends';
    rest = rest.slice(envelope.raw.length).trimStart();
  }
  return peer ? 'peer' : notice ? 'walnut-notify' : null;
}

/**
 * A delivered line, as the session's stream recorded it, inside the turn a
 * remembered wait belongs to: the server hears of a host's own delivery only
 * here. An interruption makes a turn the CLI seemed to start itself the
 * message's; what the wait waited for ends it, as a send of it does; and once
 * the stream said whose turn it is, any other line (a person's) ends it too.
 *
 * `turn`: the session's turn the line came in (the runner's turn count), and
 * whether a line opened that turn. The turn-start edge writes its entry only
 * after its own task read and write, so a line that ends the wait can come in
 * first: it leaves a mark for that turn, and noteInterruptedWait keeps no wait
 * for a turn so marked.
 */
export function noteInjectedLine(
  taskId: string,
  line: InjectedLineClass,
  turn?: { sessionId?: string; turn: number; openedByLine?: boolean },
): void {
  const entry = interrupted.get(taskId);
  if (!entry) {
    if (turn && (line === 'ends' || (line === null && turn.openedByLine))) {
      if (endsSeen.size > 1000) endsSeen.clear();
      endsSeen.set(taskId, { sessionId: turn.sessionId, turn: turn.turn });
    }
    return;
  }
  if (interruptingLine(line)) {
    if (entry.cause === 'self') {
      entry.cause = 'message';
      entry.source = `stream:${line}`;
      entry.byLine = true;
    }
  } else if (line === 'ends') dropInterruptedWait(taskId, 'stream:what-it-waited-for', entry.leftAt);
  else if (entry.byLine) dropInterruptedWait(taskId, 'stream:not-an-interruption', entry.leftAt);
}

/** `turn`: the session turn the edge belongs to (the runner's count), for the marks noteInjectedLine leaves. */
export function noteInterruptedWait(taskId: string, entry: Omit<InterruptedWait, 'notedAtMs' | 'fires'>, turn?: number): void {
  const seen = endsSeen.get(taskId);
  if (seen && turn !== undefined) {
    endsSeen.delete(taskId);
    if (seen.turn === turn && seen.sessionId === entry.sessionId) {
      log.session.info('wait not kept: what it waited for came in this turn before the wait was noted', {
        taskId, sessionId: entry.sessionId, cause: entry.cause, source: entry.source, turn,
      });
      return;
    }
  }
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
  all: ReadonlyArray<Pick<WatchingTrigger, 'state'> & Partial<Pick<WatchingTrigger, 'id' | 'fires' | 'watchesUser'>>>,
  firesAtExit?: Readonly<Record<string, number>>,
): boolean {
  // A trigger on the user's ask is a wait on the user: it never holds a park (sessions/outside-wait.ts).
  const triggers = all.filter((t) => !t.watchesUser);
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
  endsSeen.clear();
  restored.clear();
}

// ── A standing routine's fire turn ──

/** Tasks whose current turn a trigger's fire started (a person's message since clears it), with
 *  the clock the task had when the fire came (the fire's own move out of WAITING clears it). */
const fireTurns = new Map<string, { waitUntil: string | null; at: number }>();
/** A fire turn longer than this is not one the marker still describes (its end went unseen). */
const FIRE_TURN_TTL_MS = 6 * 60 * 60_000;

/** Every send into a task's session: a fire marks the turn as the routine's, a person's unmarks it. */
export function noteTurnSend(taskId: string, fire: boolean, person: boolean, waitUntil?: string | null): void {
  if (fire) {
    if (fireTurns.size > 1000) fireTurns.clear();
    fireTurns.set(taskId, { waitUntil: waitUntil ?? null, at: Date.now() });
  } else if (person) fireTurns.delete(taskId);
}

/** The fire turn ended another way (an error, a prompt for the user): it is no routine's end. */
export function dropFireTurn(taskId: string): void {
  fireTurns.delete(taskId);
}

/** Whether the turn now ending was a fire's, forgetting it (one answer per turn end), and the
 *  clock to go back to (null = none, or one already past). */
export function takeFireTurn(taskId: string, nowMs: number = Date.now()): { waitUntil: string | null } | null {
  const entry = fireTurns.get(taskId);
  fireTurns.delete(taskId);
  if (!entry || nowMs - entry.at > FIRE_TURN_TTL_MS) return null;
  const until = entry.waitUntil && Date.parse(entry.waitUntil) > nowMs ? entry.waitUntil : null;
  return { waitUntil: until };
}

/**
 * The triggers of a standing routine: armed, none stopped, and one of them has fired before this
 * turn (a watch that keeps firing, every 15 minutes say), so its fire turn ends back in WAITING.
 * A trigger that fired once is a one-time watch: the fire is what the task waited for, and the
 * task is handed back as before.
 */
export function triggersStanding(triggers: ReadonlyArray<Pick<WatchingTrigger, 'state'> & Partial<Pick<WatchingTrigger, 'fires' | 'watchesUser'>>>): boolean {
  return triggersHoldWait(triggers) && triggers.some((t) => t.state === 'armed' && !t.watchesUser && (t.fires ?? 0) >= 2);
}

