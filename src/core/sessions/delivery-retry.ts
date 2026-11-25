/**
 * A message that could not be delivered is tried again, by itself, for as long as it fails
 * (2026-11-23, the user: "我们任何时候不应该造成这个 message loss，而且有有 error 的话一直会
 * retry"). Before this a row that a delivery failure parked waited for a person's Retry: a session
 * whose start failed, a line Claude Code dropped or never read, a resume that died, a retry budget
 * spent, a restart's recovery that gave up, a row pending a week. Each park still says why in the
 * panel; now each also goes back in line on a clock, longer after each try (RETRY_BACKOFF_MS, then
 * every hour), with no limit on tries, the way a person's Retry would put it back
 * (session-queue-park.ts unparkMessage rules: a Stop that came after it wins).
 *
 * Never tried again by itself, because a person or the hold decided it waits:
 *  - a row a Stop set aside (STOP_PARKED_REASON), or any row whose stop fence is not the session's
 *    current one: the person's Stop wins until they Retry it;
 *  - a row held for a cold session's next wake (cold-hold.ts), for a running turn
 *    (AFTER_TURN_REASON), for start recovery (START_RECOVERY_HELD_REASON) or for its task's move
 *    (MOVE_HELD_REASON): each has its own clock;
 *  - a row Claude Code read and stopped before answering (NOT_LOST_REASON_PREFIXES): it is in the
 *    session's transcript, so it is not lost, and sending it again would only start a turn again;
 *  - a row whose failure no retry can fix until a person acts (NEEDS_A_PERSON_CODES: its folder or
 *    its session record is gone, it is over the host's frame cap, ...): trying it every hour would
 *    only repeat the same error notices (the 12-day loop session-message-queue.ts tells of). It stays
 *    on disk, in the panel with its reason and Retry, and its asker was told.
 * An archived session's rows are left alone, as a reconnect leaves them, and so are a completed
 * task's: a send would start its session again on finished work.
 *
 * A row parked because its session's folder was gone is not tried on this clock's own rule (its
 * refusal repeats until the folder is back): when one is due, the same lap looks at the folder and
 * puts it back in line once the folder is there, however it came back (folder-wait.ts).
 *
 * A row a failure left pending with nothing to send it (a transient error that set no timer of its
 * own, claude-code-session.ts processNext) is asked for again the same way: a session whose oldest
 * pending row waited STUCK_PENDING_MS with no turn running gets a send, on the same growing clock
 * (kept in memory: a restart sends every pending row anyway).
 */
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import { AFTER_TURN_REASON, COLD_HOLD_REASON, MOVE_HELD_REASON, START_RECOVERY_HELD_REASON, STOP_PARKED_REASON } from '../relay-fates.js';
import { leaveParked } from '../queue-held-spans.js';
import { _resetFolderLooksForTesting, endFolderWaits, FOLDER_WAIT_ENDED, FOLDER_WAIT_MAX_AGE_MS, folderIsBackFor, waitsForFolder } from './folder-wait.js';
import { mutateStore, readQueueFileFresh, type QueuedMessage } from '../session-queue-store.js';

/** The wait before each automatic try, by how many came before it; then RETRY_EVERY_MS for good. */
export const RETRY_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000] as const;
export const RETRY_EVERY_MS = 60 * 60_000;
const SWEEP_MS = 60_000;
/** A pending row this old in a session that runs no turn has nothing sending it. */
export const STUCK_PENDING_MS = 5 * 60_000;

/** Parks a person or a hold decided: never tried again by this clock. */
const HELD_REASONS: ReadonlySet<string> = new Set([STOP_PARKED_REASON, COLD_HOLD_REASON, AFTER_TURN_REASON, START_RECOVERY_HELD_REASON, MOVE_HELD_REASON]);

/**
 * Parks of a line Claude Code read and then stopped before answering: the words are in the session's
 * transcript (not lost), so only a person's Retry starts that turn again. Read from the runner, where
 * the words are written (claude-code-session.ts LINE_NOT_ANSWERED_REASON, LINE_ENDED_UNANSWERED_REASON).
 */
export const NOT_LOST_REASON_PREFIXES: readonly string[] = [
  'Not answered: Claude Code read this message and stopped before answering it',
  'The session ended before Claude Code answered this message',
];

/**
 * Delivery verdicts (providers/delivery-failure.ts codes) whose failure is the same on every try
 * until a person changes something: never tried again by this clock. Every other verdict is (a
 * session held by another process, a paused budget, history that could not be read, Claude Code
 * missing on its host, besides agent-wait-resend.ts sending that one the moment the host can).
 */
export const NEEDS_A_PERSON_CODES: ReadonlySet<string> = new Set([
  'cwd_missing', 'session_missing', 'too_large', 'inherited_session', 'acp_session', 'session_stopped',
]);

/** The wait before the try after `tries` automatic ones. */
export function retryDelayMs(tries: number): number {
  return RETRY_BACKOFF_MS[tries] ?? RETRY_EVERY_MS;
}

/** Is this parked row one the clock tries again (a delivery failure parked it, nobody decided it waits)? */
export function retriesBySelf(
  row: Pick<QueuedMessage, 'status' | 'parkedReason' | 'parkedCode' | 'stopFence'>, stopFence: string | null,
  codeOf: (reason: string) => string | undefined = () => undefined,
): boolean {
  if (row.status !== 'parked') return false;
  const reason = row.parkedReason ?? '';
  if (HELD_REASONS.has(reason)) return false;
  if (NOT_LOST_REASON_PREFIXES.some((p) => reason.startsWith(p))) return false;
  // A row parked before its code was kept: its reason's words say the verdict.
  const code = row.parkedCode ?? codeOf(reason);
  if (code && NEEDS_A_PERSON_CODES.has(code)) return false;
  return (row.stopFence ?? null) === stopFence;
}

/**
 * Whether the clock will try this parked row again by itself (no Stop came after it, its task is
 * open): its asker
 * is told "not delivered yet, still being tried", never "not delivered" (which settles the request
 * and invites a resend that would run twice once the clock delivers it).
 */
export async function parkRetriedByClock(row: Pick<QueuedMessage, 'sessionId' | 'status' | 'parkedReason' | 'parkedCode' | 'stopFence'>): Promise<boolean> {
  const { sessionStops } = await import('./session-stop.js');
  let fence: string | null;
  // A Stop not settled yet: not promised as being tried.
  try { fence = (await sessionStops.fence(row.sessionId)) ?? null; } catch { return false; }
  return retriesBySelf(row, fence, await reasonCode()) && !await leftAlone(row.sessionId);
}

/** The verdict code a stored reason reads as (delivery-failure.ts, by its words alone). */
async function reasonCode(): Promise<(reason: string) => string | undefined> {
  const { classifyDeliveryFailure } = await import('../../providers/delivery-failure.js');
  return (reason) => {
    const v = classifyDeliveryFailure(new Error(reason));
    return v.kind === 'permanent' ? v.code : undefined;
  };
}

/** When the clock tries this row again (epoch ms): its park time plus the wait its tries earned. */
export function nextRetryAt(row: Pick<QueuedMessage, 'parkedAt' | 'enqueuedAt' | 'autoRetries'>): number {
  const at = Date.parse(row.parkedAt ?? row.enqueuedAt);
  return (Number.isFinite(at) ? at : Date.now()) + retryDelayMs(row.autoRetries ?? 0);
}

/** An archived session, or one whose task is complete: a send would start work nobody waits on. */
async function leftAlone(sessionId: string): Promise<boolean> {
  return (await leftAloneWhy(sessionId)) !== null;
}

/**
 * Why a session is left alone (its words for a retired row) and since when it is known to be (its
 * task's completion; null for an archived session, which keeps no time), or null when it is not.
 */
async function leftAloneWhy(sessionId: string): Promise<{ why: string; since: number | null } | null> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(sessionId);
    if (!rec) return null;
    if ((rec as { archived?: boolean }).archived === true) return { why: 'its session is archived', since: null };
    if (!rec.taskId) return null;
    const { listTasksByIds } = await import('../task-manager.js');
    const task = (await listTasksByIds([rec.taskId])).find((t) => t.id === rec.taskId);
    if (task?.phase !== 'COMPLETE') return null;
    const done = Date.parse(task.completed_at ?? '');
    return { why: 'its task is complete', since: Number.isFinite(done) ? done : null };
  } catch {
    // Unreadable records: tried as before, as a reconnect would.
    return null;
  }
}

/**
 * A parked row of a session left alone (archived, or its task complete) waits for nothing: no clock
 * tries it and a send would start work nobody waits on. An agent's row (a peer's note, a routine's,
 * Walnut's) parked this long is retired: taken out, recorded `dropped` with why in the delivery
 * ledger (session-queue-exits.ts). 2026-11-25, the Reflection VP's audit: parked rows to completed
 * tasks waited for weeks with nobody to look at them. A person's own words stay (his Retry or
 * Discard in that task's chat), and so does a row a hold keeps on its own clock.
 */
export const RETIRE_AFTER_MS = 60 * 60_000;
const OWN_CLOCK_REASONS: ReadonlySet<string> = new Set([COLD_HOLD_REASON, AFTER_TURN_REASON, START_RECOVERY_HELD_REASON, MOVE_HELD_REASON]);

/**
 * Is this row one a session left alone retires: an agent's park, not on a hold's own clock, parked
 * and left alone (`since`: its task's completion) for RETIRE_AFTER_MS, so a task reopened soon after
 * it completed still gets it.
 */
export function retiresWhenLeftAlone(
  row: Pick<QueuedMessage, 'status' | 'sentBy' | 'parkedReason' | 'parkedAt' | 'enqueuedAt'>, now: number, since: number | null = null,
): boolean {
  if (row.status !== 'parked' || row.sentBy !== 'agent' || OWN_CLOCK_REASONS.has(row.parkedReason ?? '')) return false;
  const at = Math.max(Date.parse(row.parkedAt ?? row.enqueuedAt), since ?? 0);
  return Number.isFinite(at) && now - at >= RETIRE_AFTER_MS;
}

/** Retire the rows of a session left alone that retiresWhenLeftAlone names; returns their ids. */
async function retireLeftAlone(sessionId: string, rows: QueuedMessage[], now: number): Promise<string[]> {
  const due = rows.filter((r) => retiresWhenLeftAlone(r, now));
  if (due.length === 0) return [];
  const alone = await leftAloneWhy(sessionId);
  if (!alone) return [];
  const { why, since } = alone;
  const { noteQueueExit } = await import('../session-queue-exits.js');
  const { fateOf, setFate } = await import('../relay-fates.js');
  const ids = new Set(due.map((r) => r.id));
  const gone = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return [];
    // Read again under the lock: only a row still parked by an agent and still due goes.
    const out = queue.filter((m) => ids.has(m.id) && retiresWhenLeftAlone(m, now, since)).map((m) => m.id);
    if (out.length === 0) return out;
    for (const m of queue) {
      if (out.includes(m.id)) noteQueueExit(m.id, 'dropped', { why: `not delivered: ${why}, so nothing waits on it (it was parked: ${m.parkedReason ?? 'no reason kept'})` });
    }
    s.queues[sessionId] = queue.filter((m) => !out.includes(m.id));
    if (s.queues[sessionId].length === 0) delete s.queues[sessionId];
    for (const id of out) if (fateOf(s, id)) setFate(s, id, 'removed');
    return out;
  });
  if (gone.length > 0) log.session.info('parked messages retired: their session is left alone', { sessionId, why, messageIds: gone });
  return gone;
}

/**
 * Put the session's due rows back in line and ask the runner to send them; returns their ids.
 * The same write a person's Retry makes (unparkMessage), plus the try counted.
 */
async function retrySession(sessionId: string, rows: QueuedMessage[], now: number): Promise<string[] | null> {
  const { sessionStops } = await import('./session-stop.js');
  // A Stop not confirmed yet has no fence to read: nothing is sent until it settles (null: skip the session).
  let fence: string | null;
  try { fence = (await sessionStops.fence(sessionId)) ?? null; } catch { return null; }
  const codeOf = await reasonCode();
  // A row that waited on its folder longer than the rule allows goes by itself no more: its mark is
  // dropped and its asker hears once that it was not delivered (it was promised it goes by itself).
  const lapsed = rows.filter((r) => r.status === 'parked' && r.folderWait === true && now - (Date.parse(r.enqueuedAt) || now) >= FOLDER_WAIT_MAX_AGE_MS)
  if (lapsed.length > 0) await endFolderWaits(sessionId, FOLDER_WAIT_ENDED.tooOld, lapsed.map((r) => r.id)).catch(() => 0);
  // A row parked on a gone folder is due by the same clock, once its folder is there again however it
  // came back (folder-wait.ts); the clock's growing wait keeps a refusal the folder check contradicts
  // from looping.
  const onFolder = (r: QueuedMessage) => waitsForFolder(r, fence, now);
  const folderDue = rows.filter((r) => onFolder(r) && nextRetryAt(r) <= now);
  const folderBack = folderDue.length > 0 && !await leftAlone(sessionId) && await folderIsBackFor(sessionId, now, { delayMs: retryDelayMs });
  const goes = (r: QueuedMessage) => retriesBySelf(r, fence, codeOf) || (folderBack && onFolder(r));
  const due = new Set(rows.filter((r) => goes(r) && nextRetryAt(r) <= now).map((r) => r.id));
  if (due.size === 0) return [];
  if (await leftAlone(sessionId)) return [];
  if (folderBack) await clearFolderGoneMark(sessionId);
  const { randomUUID } = await import('node:crypto');
  const ids = await mutateStore((s) => {
    const done: string[] = [];
    for (const msg of s.queues[sessionId] ?? []) {
      if (!due.has(msg.id) || !goes(msg)) continue;
      const why = msg.parkedReason;
      msg.status = 'pending';
      delete msg.unansweredResent;
      if (!msg.lineUuid && !msg.userUuid) {
        msg.lineUuid = randomUUID();
        msg.lineTries = 0;
      }
      msg.autoRetries = (msg.autoRetries ?? 0) + 1;
      leaveParked(msg, now);
      done.push(msg.id);
      log.session.info('parked message tried again by itself', { sessionId, messageId: msg.id, tries: msg.autoRetries, parkedFor: why });
    }
    return done;
  });
  if (ids.length > 0) bus.emit(EventNames.SESSION_SEND, { sessionId, message: '' }, ['session-runner'], { source: 'delivery-retry' });
  return ids;
}

/** Sessions asked again for their stuck pending rows: how many times, and when last. */
const kicked = new Map<string, { tries: number; at: number }>();

async function turnRunning(sessionId: string): Promise<boolean> {
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  return sessionRunner.isTurnRunning(sessionId);
}

/** Ask the runner again for a session whose pending rows nothing sends. Returns whether it asked. */
async function kickStuckPending(sessionId: string, rows: QueuedMessage[], now: number): Promise<boolean> {
  const pending = rows.filter((r) => r.status === 'pending');
  if (pending.length === 0 || rows.some((r) => r.status === 'processing')) { kicked.delete(sessionId); return false; }
  // Waiting since it was queued, or since it last left a park (a retry puts it back in line).
  const since = (r: QueuedMessage) => Math.max(Date.parse(r.enqueuedAt) || 0, r.heldSpans?.at(-1)?.end ?? 0);
  const oldest = Math.min(...pending.map(since));
  if (!(now - oldest >= STUCK_PENDING_MS)) return false;
  const k = kicked.get(sessionId);
  if (k && now - k.at < retryDelayMs(k.tries - 1)) return false;
  if (await turnRunning(sessionId) || await leftAlone(sessionId)) return false;
  kicked.set(sessionId, { tries: (k?.tries ?? 0) + 1, at: now });
  log.session.info('pending messages asked for again: nothing was sending them', { sessionId, rows: pending.length, tries: (k?.tries ?? 0) + 1 });
  bus.emit(EventNames.SESSION_SEND, { sessionId, message: '' }, ['session-runner'], { source: 'delivery-retry' });
  return true;
}

let sweep: ReturnType<typeof setInterval> | null = null;
let lap: Promise<string[]> | null = null;
/**
 * A host that runs its own sessions sweeps only the queues of the sessions it judges
 * (sessions/judge-of.ts judgedHere: its own rows), never a copied row's: set by its start.
 */
let ownOnly = false;

/** One look at every queue: each session's due parked rows go back in line. Returns the ids. */
export function sweepDeliveryRetries(now = Date.now()): Promise<string[]> {
  return (lap ??= (async () => {
    const store = await readQueueFileFresh();
    const out: string[] = [];
    for (const sid of kicked.keys()) if (!store.queues[sid]?.some((r) => r.status === 'pending')) kicked.delete(sid);
    const judgedHere = ownOnly ? (await import('./judge-of.js')).judgedHere : null;
    for (const [sid, queued] of Object.entries(store.queues)) {
      if (judgedHere && !judgedHere(sid)) continue;
      let rows = queued;
      try {
        if (rows.some((r) => retiresWhenLeftAlone(r, now))) {
          const retired = new Set(await retireLeftAlone(sid, rows, now));
          if (retired.size > 0) rows = rows.filter((r) => !retired.has(r.id));
        }
        const back = rows.some((r) => r.status === 'parked') ? await retrySession(sid, rows, now) : [];
        if (back === null) continue;
        out.push(...back);
        // Rows just put back in line were sent for; the others may still have nothing sending them.
        if (back.length === 0) await kickStuckPending(sid, rows, now);
      } catch (err) {
        log.session.warn('delivery retry: a session\'s sweep failed', { sessionId: sid, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  })().finally(() => { lap = null; }));
}

/** Trigger fires the server keeps itself go on the same lap (routines/trigger-events.ts sweepOwedFires). */
let firesLap: Promise<unknown> | null = null;
function sweepKeptFires(): void {
  firesLap ??= import('../routines/trigger-events.js')
    .then((m) => m.sweepOwedFires())
    .catch((err) => log.cron.warn('kept trigger fires sweep failed', { error: err instanceof Error ? err.message : String(err) }))
    .finally(() => { firesLap = null; });
}

/**
 * Boot: the clock runs for good; a restart's due rows go at the first lap. The leader sweeps every
 * queue and the trigger fires it keeps. A host that runs its own sessions (session-channel/host-resend.ts)
 * holds their queues, so it runs the same clock for them (`ownOnly`); the kept trigger fires are the
 * leader's (`keptFires: false` there).
 */
export function startDeliveryRetry(o: { ownOnly?: boolean; keptFires?: boolean } = {}): void {
  if (sweep) return;
  ownOnly = o.ownOnly === true;
  const fires = o.keptFires !== false;
  sweep = setInterval(() => { void sweepDeliveryRetries(); if (fires) sweepKeptFires(); }, SWEEP_MS);
  sweep.unref?.();
  void sweepDeliveryRetries();
  if (fires) sweepKeptFires();
}

/** The gone-folder mark of a session whose folder is back (its panel's banner goes). */
async function clearFolderGoneMark(sessionId: string): Promise<void> {
  const { clearFolderGone } = await import('./folder-gone.js');
  await clearFolderGone(sessionId).catch(() => {});
}

/** Test seam. */
export function stopDeliveryRetry(): void {
  if (sweep) clearInterval(sweep);
  _resetFolderLooksForTesting();
  sweep = null;
  ownOnly = false;
  kicked.clear();
}
