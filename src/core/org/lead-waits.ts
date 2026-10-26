/**
 * What waits on a lead reaches the lead, programmatically. 2026-10-26: three of a lead's workers
 * read "waiting on its lead" for 21 hours and the lead never heard: an idle parent is not woken
 * for a child's turn end (subtask-notices.ts), and the team note (team-note.ts) only rode the
 * lead's next message.
 *
 * A task whose own status (user-status.ts) says it waits on its leader, kind `lead`, when that
 * leader is an org lead (a VP), is that lead's work. After SETTLE_MS (the lead may be answering
 * already), the lead's team note is delivered to its session, which wakes it, with those tasks
 * under "Waiting on you" and whatever else moved. The note's own state means each wait is told
 * once (a worker that waits again after another turn is a new wait); a lead that reads it
 * mid-turn gets it in that turn. At most one wake per lead per MIN_GAP_MS; a sweep catches waits
 * from before a restart.
 *
 * A wait the task's own turn named (its report of that turn: done, or waiting on its lead) wakes
 * the lead at once. One Walnut read with no report behind it wakes only after UNREPORTED_MS: a
 * turn's report comes a few minutes after its end, and until it does the status may read "its
 * lead" for a turn that only ended. A worker that answered the lead's own request after its wait
 * began never wakes it: the reply was the news, and the wait rides the lead's next message.
 *
 * Not for an ordinary parent: kind `lead` also follows a plain subtask's turn end, and waking
 * every parent for it was the 2026-10-01 incident (a finished parent billed daily). On an
 * ephemeral server only waits that began after boot count: the copied ones are the real
 * Walnut's (task-wait-until.ts and board-reminders.ts pause theirs the same way).
 */

import { createHash } from 'node:crypto';
import { IS_EPHEMERAL } from '../../constants.js';
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';

const SUBSCRIBER = 'org-lead-waits';
const SETTLE_MS = 60_000;
const MIN_GAP_MS = 5 * 60_000;
const SWEEP_MS = 10 * 60_000;
const UNREPORTED_MS = 10 * 60_000;
/** The phase write and the report stamp come from different processes (user-status.ts). */
const CLOCK_SLACK_MS = 5_000;

let settleMs = SETTLE_MS;
let gapMs = MIN_GAP_MS;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastWake = new Map<string, number>();
let sweep: ReturnType<typeof setInterval> | null = null;
let firstSweep: ReturnType<typeof setTimeout> | null = null;
/** Ephemeral only: waits that began before this are copied, not this server's. */
let bootedAt: number | null = null;

const waitsOnItsLead = (t: Pick<Task, 'parent_task_id' | 'phase' | 'user_status'>) =>
  !!t.parent_task_id && t.phase !== 'COMPLETE' && t.user_status?.state === 'waiting' && t.user_status.kind === 'lead';

type WaitFacts = Pick<Task, 'status_report' | 'phase_changed_at' | 'last_session_update' | 'updated_at'>;

/** When the wait began: its phase move, else the last session news. */
function waitBegan(t: WaitFacts): number {
  return Date.parse(t.phase_changed_at ?? t.last_session_update ?? t.updated_at ?? '');
}

/** When a wait on its lead may wake the lead (ms); a report of the turn that began it says so: at once. */
export function wakeAt(t: WaitFacts): number {
  const r = t.status_report;
  const movedAt = Date.parse(t.phase_changed_at ?? '');
  // Only a report of the latest turn speaks for this wait (user-status.ts's rule): an older
  // one's "done" is the turn before.
  const current = !!r && (!Number.isFinite(movedAt) || Date.parse(r.at) >= movedAt - CLOCK_SLACK_MS);
  if (current && (r!.state === 'done' || (r!.state === 'waiting' && r!.waiting_kind === 'lead'))) return 0;
  const since = Date.parse(t.last_session_update ?? t.phase_changed_at ?? t.updated_at ?? '');
  return Number.isFinite(since) ? Math.max(since, Number.isFinite(movedAt) ? movedAt : 0) + UNREPORTED_MS : 0;
}

function schedule(leadId: string, delay = settleMs): void {
  if (timers.has(leadId)) return;
  const timer = setTimeout(() => { timers.delete(leadId); void tellLead(leadId); }, delay);
  timer.unref?.();
  timers.set(leadId, timer);
}

/** Deliver the lead's note now when something new in it waits on the lead. Returns whether it did. */
export async function tellLead(leadId: string, nowMs = Date.now()): Promise<boolean> {
  try {
    const last = lastWake.get(leadId);
    if (last && nowMs - last < gapMs) { schedule(leadId, gapMs - (nowMs - last)); return false; }
    const { role } = await import('../server-role.js');
    if (role() !== 'leader') return false;
    const { getTask, listTasks } = await import('../task-manager.js');
    const lead = await getTask(leadId).catch(() => undefined);
    if (!lead || lead.org_role !== 'lead' || lead.phase === 'COMPLETE') return false;
    const waiting = (await listTasks()).filter((t) => t.parent_task_id === lead.id && waitsOnItsLead(t)
      && (bootedAt === null || waitBegan(t) >= bootedAt));
    if (!waiting.length) return false;
    const { leadSession } = await import('./org-store.js');
    const target = await leadSession(lead.id);
    if (!target) return false; // nothing to wake; its first session's note says where things stand
    const { pendingTeamNote } = await import('./team-note.js');
    const note = await pendingTeamNote(lead, target.claudeSessionId, nowMs);
    if (!note) return false;
    // Only what the lead was not told yet decides the wake; a wait told earlier is its already.
    const fresh = waiting.filter((t) => note.waitIds.includes(t.id));
    const { getSessionsForTask } = await import('../session-tracker.js');
    const { repliedRecently } = await import('../session-requests.js');
    const leadSids = (await getSessionsForTask(lead.id).catch(() => [])).map((s) => s.claudeSessionId);
    const due: number[] = [];
    for (const t of fresh) {
      const began = waitBegan(t);
      // It answered the lead's request after its wait began: the reply was the news.
      const answered = Number.isFinite(began)
        && await repliedRecently(leadSids, t.id, nowMs - began + CLOCK_SLACK_MS, nowMs).catch(() => false);
      due.push(answered ? Infinity : wakeAt(t));
    }
    if (!due.some((at) => at <= nowMs)) {
      note.release(); // the rest rides its next message
      const soonest = Math.min(...due);
      if (Number.isFinite(soonest)) schedule(leadId, soonest - nowMs + 1_000);
      return false;
    }
    // Set first: a slow delivery is still this wake, never a second one from the sweep.
    lastWake.set(leadId, nowMs);
    const { deliverToSession } = await import('../sessions/session-send-core.js');
    // The same waits delivered twice (a retry after a timeout) merge into one queued row.
    const messageId = `lw-${lead.id}-${createHash('sha256').update(fresh.map((t) => `${t.id}@${t.phase_changed_at ?? ''}`).sort().join(',')).digest('hex').slice(0, 12)}`;
    let delivery: string;
    try {
      ({ delivery } = await deliverToSession(target, {
        busText: note.text, enqueueText: note.text, source: 'walnut-notify', taskId: lead.id, messageId,
      }));
    } catch (err) {
      // A timeout abandons the wait, not the enqueue (session-send-core.ts): the row still lands.
      if (!/timed out/.test(err instanceof Error ? err.message : '')) { note.release(); throw err; }
      delivery = 'timed-out';
    }
    await note.markTold();
    log.session.info('lead woken for work that waits on it', { leadTaskId: lead.id, sessionId: target.claudeSessionId, waits: note.waits, delivery, messageId });
    return true;
  } catch (err) {
    log.session.warn('lead not told of work that waits on it', { leadTaskId: leadId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function scan(): Promise<void> {
  try {
    const { listTasks } = await import('../task-manager.js');
    const tasks = await listTasks();
    const leads = new Set(tasks.filter((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE').map((t) => t.id));
    for (const t of tasks) if (waitsOnItsLead(t) && leads.has(t.parent_task_id!)) schedule(t.parent_task_id!);
  } catch (err) {
    log.session.debug('lead waits: sweep failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startLeadWaits(opts: { ephemeral?: boolean } = {}): void {
  bootedAt = (opts.ephemeral ?? IS_EPHEMERAL) ? Date.now() : null;
  bus.subscribe(SUBSCRIBER, (event) => {
    const task = (event.data as { task?: Task } | undefined)?.task;
    if (!task || !waitsOnItsLead(task)) return;
    // Only a VP: checked when the timer fires (the parent may have just become one).
    schedule(task.parent_task_id!);
  }, { global: true, interest: [EventNames.TASK_UPDATED, EventNames.TASK_CREATED] });
  if (!sweep) {
    sweep = setInterval(() => { void scan(); }, SWEEP_MS);
    sweep.unref?.();
    firstSweep = setTimeout(() => { firstSweep = null; void scan(); }, settleMs * 2);
    firstSweep.unref?.();
  }
}

export function stopLeadWaits(): void {
  bus.unsubscribe(SUBSCRIBER);
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  if (sweep) clearInterval(sweep);
  sweep = null;
  if (firstSweep) clearTimeout(firstSweep);
  firstSweep = null;
  lastWake.clear();
}

/** Tests: shorten the clocks (no argument restores them), and forget the wakes. */
export function _setLeadWaitClocksForTesting(settle?: number, gap?: number): void {
  settleMs = settle ?? SETTLE_MS;
  gapMs = gap ?? MIN_GAP_MS;
  lastWake.clear();
}
