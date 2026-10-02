/**
 * The clock on a Board's reminders ("remind me later" on a choice or a thread).
 *
 * One server timer for the nearest deadline (re-checked at least hourly, so a
 * Mac that slept past one catches up on wake), fed by a boot scan of the boards
 * dir and by the BOARD_CHANGED every board write emits. Modelled on
 * task-wait-until.ts, and for the same reason a server clock, not a daemon
 * trigger: the host that would have fired a trigger is exactly what may have
 * stopped working, and the reminder belongs to the board, which lives here.
 *
 * When a reminder comes due: `fired_at` is set (the frame shows it due at once),
 * BOARD_CHANGED kind `reminder` goes out, and a message reaches the board task's
 * session the way a human's thread message does. A failed delivery is retried
 * on later sweeps, BOARD_REMINDER_RETRY_MS apart and at most
 * BOARD_REMINDER_MAX_ATTEMPTS times in all (the count is in the board file, so a
 * restart neither loses nor resets it); never a tight loop.
 *
 * An ephemeral test server runs on a COPY of the real boards: the reminders it
 * inherited belong to the real Walnut and never fire there (like its paused
 * cron jobs); the ones set during its own life do.
 */
import { CLOUD_MODE, IS_EPHEMERAL } from '../../constants.js';
import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { own } from './board-html.js';
import type { BoardFile, BoardReminder } from './board-store.js';

export const BOARD_REMINDERS_SUBSCRIBER = 'board-reminders';
export const BOARD_REMINDER_RETRY_MS = 5 * 60_000;
export const BOARD_REMINDER_MAX_ATTEMPTS = 3;
const RECHECK_MS = 3_600_000;

/** taskId → target → deadline (ms). */
const deadlines = new Map<string, Map<string, number>>();
const inFlight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let live = false;
/** On an ephemeral server: reminders set before it started were copied from the real Walnut. */
let inheritedBefore: number | null = null;

/**
 * When the clock must next look at a reminder, or null when it is done with it:
 * its time while it has not fired; after a failed delivery, the next retry slot;
 * null once delivered or out of attempts.
 */
export function reminderDeadline(rem: Pick<BoardReminder, 'at' | 'fired_at' | 'delivered_at' | 'attempts'>): number | null {
  if (rem.delivered_at) return null;
  if (!rem.fired_at) {
    const at = Date.parse(rem.at);
    // A malformed value must not reach the timer: a NaN deadline would re-arm it every millisecond.
    return Number.isFinite(at) ? at : null;
  }
  const attempts = rem.attempts ?? 0;
  if (attempts >= BOARD_REMINDER_MAX_ATTEMPTS) return null;
  const fired = Date.parse(rem.fired_at);
  return Number.isFinite(fired) ? fired + attempts * BOARD_REMINDER_RETRY_MS : null;
}

function trackBoard(taskId: string, board: Pick<BoardFile, 'reminders'> | null): void {
  const mine = new Map<string, number>();
  for (const [target, rem] of Object.entries(board?.reminders ?? {})) {
    if (inheritedBefore !== null && !(Date.parse(rem.set_at) >= inheritedBefore)) continue;
    const at = reminderDeadline(rem);
    if (at !== null) mine.set(target, at);
  }
  if (mine.size) deadlines.set(taskId, mine);
  else deadlines.delete(taskId);
}

function nearest(): number | null {
  let next: number | null = null;
  for (const targets of deadlines.values()) for (const at of targets.values()) if (next === null || at < next) next = at;
  return next;
}

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const next = live ? nearest() : null;
  if (next === null) return;
  const delay = Math.max(1_000, Math.min(next - Date.now(), RECHECK_MS));
  timer = setTimeout(() => {
    timer = null;
    void sweepBoardReminders().catch((err) => log.task.warn('board reminder sweep failed', { error: errText(err) }));
  }, delay);
  timer.unref?.();
}

/**
 * Act on every reminder whose deadline has passed. Exported for tests (a fake
 * `nowMs`); the timer calls it with the real clock. Re-reads each board, so a
 * reminder cleared, answered or re-timed since it was tracked is left alone.
 */
export async function sweepBoardReminders(nowMs = Date.now()): Promise<string[]> {
  const due: Array<[string, string]> = [];
  for (const [taskId, targets] of deadlines) {
    for (const [target, at] of targets) if (at <= nowMs) due.push([taskId, target]);
  }
  const acted: string[] = [];
  for (const [taskId, target] of due) {
    deadlines.get(taskId)?.delete(target);
    try {
      if (await fire(taskId, target, nowMs)) acted.push(`${taskId}/${target}`);
    } catch (err) {
      // A write that keeps failing waits a retry slot, never the timer's 1 s floor.
      log.task.warn('board reminder failed; trying again later', { taskId, target, error: errText(err) });
      setDeadline(taskId, target, nowMs + BOARD_REMINDER_RETRY_MS);
    }
  }
  arm();
  return acted;
}

function setDeadline(taskId: string, target: string, at: number): void {
  const targets = deadlines.get(taskId) ?? new Map<string, number>();
  targets.set(target, at);
  deadlines.set(taskId, targets);
}

async function fire(taskId: string, target: string, nowMs: number): Promise<boolean> {
  const key = `${taskId}\n${target}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    const { getBoard } = await import('./board-store.js');
    const board = await getBoard(taskId).catch(() => null);
    const rem = board ? own(board.reminders, target) : undefined;
    if (!board || !rem) return false;
    const at = reminderDeadline(rem);
    if (at === null || at > nowMs) return false;

    const { patchBoardReminder } = await import('./board-items.js');
    let current: BoardReminder | null = rem;
    if (!rem.fired_at) {
      current = await patchBoardReminder(taskId, target, rem.set_at, { fired_at: new Date(nowMs).toISOString() });
      if (!current) return false; // cleared or replaced meanwhile
      log.task.info('board reminder due', { taskId, target, at: rem.at, setBy: rem.set_by });
    }

    const { buildReminderPrompt, deliverBoardText } = await import('./board-delivery.js');
    const delivery = await deliverBoardText(taskId, await buildReminderPrompt(board.html, target, current), {
      reminder: target, attempt: (current.attempts ?? 0) + 1,
    });
    if (delivery.state !== 'stored') {
      await patchBoardReminder(taskId, target, current.set_at, { delivered_at: new Date(nowMs).toISOString() });
      log.task.info('board reminder delivered', { taskId, target, sessionId: delivery.sessionId });
    } else {
      const attempts = (current.attempts ?? 0) + 1;
      await patchBoardReminder(taskId, target, current.set_at, { attempts });
      log.task.warn('board reminder not delivered', {
        taskId, target, attempts, reason: delivery.reason,
        retry: attempts < BOARD_REMINDER_MAX_ATTEMPTS ? `in ${BOARD_REMINDER_RETRY_MS / 60_000} min` : 'none (gave up)',
      });
    }
    return true;
  } finally {
    inFlight.delete(key);
    // The latest state decides what this reminder needs next.
    const { getBoard } = await import('./board-store.js');
    trackBoard(taskId, await getBoard(taskId).catch(() => null));
  }
}

/** The boot scan: every board's reminders, including one that came due while Walnut was down. Exported for tests. */
export async function loadBoardReminders(): Promise<void> {
  const { getBoard, listBoardTaskIds } = await import('./board-store.js');
  for (const taskId of await listBoardTaskIds()) {
    const board = await getBoard(taskId).catch((err) => {
      log.task.warn('board reminders: unreadable board skipped', { taskId, error: errText(err) });
      return null;
    });
    trackBoard(taskId, board);
  }
  arm();
}

/** The writes that can change a board's reminders: set/clear, an answer, a user's post, a deleted board. */
const REMINDER_KINDS = new Set(['reminder', 'choice', 'thread', 'deleted']);

function onBoardChanged(event: BusEvent): void {
  const data = event.data as { taskId?: string; kind?: string } | undefined;
  const taskId = data?.taskId;
  if (!taskId || !REMINDER_KINDS.has(data?.kind ?? '')) return;
  if (data?.kind === 'deleted') {
    if (deadlines.delete(taskId)) arm();
    return;
  }
  void import('./board-store.js')
    .then(({ getBoard }) => getBoard(taskId))
    .then((board) => { trackBoard(taskId, board); arm(); })
    .catch((err) => log.task.warn('board reminders: re-read failed', { taskId, error: errText(err) }));
}

/** Start the timer and its one subscriber (server boot, primary only). Idempotent: the name is overwritten. */
export function startBoardReminders(opts: { ephemeral?: boolean } = {}): void {
  if (CLOUD_MODE) return;
  live = true;
  inheritedBefore = (opts.ephemeral ?? IS_EPHEMERAL) ? Date.now() : null;
  void loadBoardReminders().catch((err) => log.task.warn('board reminders boot scan failed', { error: errText(err) }));
  bus.subscribe(BOARD_REMINDERS_SUBSCRIBER, onBoardChanged, { global: true, interest: [EventNames.BOARD_CHANGED] });
}

export function stopBoardReminders(): void {
  bus.unsubscribe(BOARD_REMINDERS_SUBSCRIBER);
  live = false;
  inheritedBefore = null;
  deadlines.clear();
  arm();
}

/** Test seam: the deadlines the timer currently knows, as `taskId/target` → ms. */
export function trackedBoardReminders(): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const [taskId, targets] of deadlines) for (const [target, at] of targets) out.set(`${taskId}/${target}`, at);
  return out;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
