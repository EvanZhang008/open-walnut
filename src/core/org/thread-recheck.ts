/**
 * A thread that sat too long with nothing from the node wakes the node (2026-11-07, the user, on a
 * thread with no reply for hours: "something must be wrong: the AI should go and answer it, and if
 * not, our system reminds"). thread-view.ts threadOverdue decides when a thread is overdue: in the
 * node's hands (new, working) REPLY_DUE_MS after the last thing on it, or waiting on him (needs)
 * NEEDS_QUIET_MS (a day) with nothing new, or once in the day before a linked task's deadline.
 * Each pass sends every Main or lead with an overdue thread ONE note
 * naming those threads, once per overdue stretch (`recheck` on the thread, recorded as pending
 * before the send and as sent after it, so a failed wake is tried again every RETRY_MS, never every
 * pass); the node's next write starts a new stretch, but a needs check keeps the daily gap, and a
 * reply reminder in a row with nothing new from him waits twice as long as the last (repeatGapMs).
 * A working thread he does not see is left alone while the node's own work runs on and wakes it
 * (nodeCarriesOn): its next turn's status line says where it stands.
 * No news needs no write or repeated ask. The card shares this clock (thread-view.ts overdueLine).
 *
 * Primary only, never on an ephemeral server (a copied thread would wake a copied node), and not
 * while the org is off; a node whose team or session the user stopped is not woken. `WALNUT_THREAD_RECHECK=0`
 * turns it off.
 */
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import { agoWords } from '../user-status.js';
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import { REPLY_DUE_MS, hasUnseenAnswer, sharedAnswers, threadDeadline, threadOverdue, type ThreadOverdue } from './thread-view.js';
import type { OrgThread, ThreadRecheck } from './threads-model.js';
import { keepsThreads } from './keeps-threads.js';
import { threadsKeptNow } from './threads-kept.js';
import { ANSWERED_THERE_RECHECK } from '../answered-there.js';

/** The send source of the note (org-enabled.ts ORG_OFF_BLOCKED_SOURCES, task-wait-resume.ts). */
export const THREAD_RECHECK_SOURCE = 'thread-recheck';
/** How often the threads are looked at. */
export const THREAD_RECHECK_SCAN_MS = 5 * 60_000;
/** At most this many threads are named in one note (the rest come in the next pass). */
const MAX_PER_NOTE = 8;
/** A note that did not go in (a failed send, a restart before it) is tried again after this. */
export const RETRY_MS = 10 * 60_000;

/** The user stopped the node's session himself: it is not woken (his view still says the thread is overdue). */
function personStopped(s: { process_status?: string; status_reason?: string; status_changed_by?: string }): boolean {
  if (s.process_status === 'running') return false;
  return s.status_changed_by === 'user' || s.status_reason === 'user_stopped' || s.status_reason === 'user_terminated';
}

export interface DueThread { thread: OrgThread; overdue: ThreadOverdue }

/** The longest gap between two reply reminders of one thread in a row. */
export const MAX_REPEAT_GAP_MS = 8 * 3600_000;

/**
 * How long after the last reminder the `repeats`-th one in a row may come: the reply clock doubled
 * each time (1 h, 2 h, 4 h, at most MAX_REPEAT_GAP_MS). 2026-11-23, the org reflection: a working
 * thread whose node answered each reminder with "still waiting" was reminded every 30 minutes
 * (each answer started a new stretch), 6 times in one night.
 */
export function repeatGapMs(repeats: number): number {
  return Math.min(REPLY_DUE_MS * 2 ** Math.max(0, repeats), MAX_REPEAT_GAP_MS);
}

function lastHisAt(t: OrgThread): string {
  return t.messages.reduce((last, m) => (m.at > last ? m.at : last), '');
}

/**
 * The `repeats` the reminder of this stretch records: one more than the last reply reminder's when
 * the thread is quiet (quietWorking), the last one went in and nothing came from him since; a retry
 * of a reminder not delivered keeps its count; anything else (a first reminder, a needs check, a
 * deadline, his message with no reply, an answer he has not seen, a new message from him) is 0, so
 * a thread with something for him keeps the plain reply clock. Pure.
 */
export function nextRepeats(t: OrgThread, o: ThreadOverdue, shared: ReadonlySet<string>): number {
  const r = t.recheck;
  if (!r || r.why !== 'reply' || !quietWorking({ thread: t, overdue: o }, shared)) return 0;
  if (r.pending || r.since === o.since) return r.repeats ?? 0;
  return lastHisAt(t) > r.at ? 0 : (r.repeats ?? 0) + 1;
}

/**
 * A working thread with nothing for him on it: no message of his without a reply and no answer he
 * has not seen, so he does not see it (thread-view.ts shownToHim). While the node's own work runs on
 * and wakes it (nodeCarriesOn), its next turn's status line says where such a thread stands. Pure.
 */
export function quietWorking(d: DueThread, shared: ReadonlySet<string>): boolean {
  return d.overdue.why === 'reply' && !d.overdue.deadline && d.thread.state === 'working'
    && !d.overdue.unanswered && !hasUnseenAnswer(d.thread, shared);
}

/**
 * The open threads of one node due a wake now: overdue, not woken yet for this stretch, and a quiet
 * repeat only once its gap passed (repeatGapMs). `carriesOn`: the node's own work runs on and wakes
 * it, so its quiet working threads are left to that turn (quietWorking), but never longer than
 * MAX_REPEAT_GAP_MS after the later of its last reminder and the time this stretch fell due: a fact that went stale (a
 * background job whose end was never seen, a trigger that will not fire) cannot silence one for good. Pure.
 */
export function threadsDueRecheck(
  threads: readonly OrgThread[], nowMs: number, tasks: readonly Pick<Task, 'id' | 'due_date' | 'phase'>[] = [],
  opts: { carriesOn?: boolean } = {},
): DueThread[] {
  const out: DueThread[] = [];
  const shared = sharedAnswers(threads);
  for (const t of threads) {
    const o = threadOverdue(t, nowMs, threadDeadline(t, tasks, nowMs));
    const r = t.recheck;
    if (!o || (r?.pending && nowMs - Date.parse(r.at) < RETRY_MS)
      || (!o.deadline && r?.since === o.since && !r.pending)) continue;
    const repeats = nextRepeats(t, o, shared);
    if (repeats > 0 && r && !r.pending && nowMs < Date.parse(r.at) + repeatGapMs(repeats)) continue;
    if (opts.carriesOn && quietWorking({ thread: t, overdue: o }, shared)
      && nowMs - Math.max(Date.parse(r?.at ?? o.dueAt), Date.parse(o.dueAt)) < MAX_REPEAT_GAP_MS) continue;
    out.push({ thread: t, overdue: o });
    if (out.length >= MAX_PER_NOTE) break;
  }
  return out;
}

/**
 * What of the node's own work runs on after its turn and wakes it, or null: a background command or
 * subagent, its agent team, a wakeup or /loop it armed (outliving-work.ts), a trigger that will
 * really wake it (user-status-sync.ts wakingTriggers), or its WAITING clock (wait_until). Pure.
 */
export function nodeCarriesOn(
  node: Pick<Task, 'phase' | 'wait_until'>, facts: { outliving: readonly string[]; triggers: number }, nowMs: number,
): string | null {
  if (facts.outliving.length) return facts.outliving.join(', ');
  if (facts.triggers > 0) return 'trigger';
  if (node.phase === 'WAITING' && node.wait_until && Date.parse(node.wait_until) > nowMs) return 'wait_until';
  return null;
}

function q(s: string): string { return JSON.stringify(s); }

/** The note: each thread, what is wrong with it, and what the node does about it. Pure. */
export function threadRecheckBody(due: readonly DueThread[], nowMs: number): string {
  const lines = due.map(({ thread: t, overdue: o }) => {
    const ago = agoWords(nowMs - Date.parse(o.since));
    if (o.why === 'needs') {
      return `- ${t.id} ${q(t.title)}: waits on him with nothing new since ${ago}${o.deadline ? `; a linked task is due ${o.deadline}` : ''}. Check it still stands without asking him again. If nothing changed, leave the thread unchanged; do not rewrite its summary just to change a checked time. Only update it for real news, or close it when evidence shows it no longer needs him.`;
    }
    // Walnut keeps the threads from the status answer (threads-kept.ts): the line is the write.
    if (threadsKeptNow()) {
      return o.unanswered
        ? `- ${t.id} ${q(t.title)}: his last message (${ago}) has no reply on this thread (state ${t.state}). Answer it now; your status line for it at this turn's end gives it its summary and state (waiting if it only went to a team), and a decision he must make is thread_update into needs.`
        : `- ${t.id} ${q(t.title)}: still ${t.state} with nothing new since ${ago}; he does not see it. Say where it stands in your status line for it at this turn's end: answered with the result, waiting if a team has it, done if finished.`;
    }
    return o.unanswered
      ? `- ${t.id} ${q(t.title)}: his last message (${ago}) has no reply on this thread (state ${t.state}). Answer it now: thread_update with the summary and answered or needs, or pending if it only went to a team.`
      : `- ${t.id} ${q(t.title)}: still ${t.state} with nothing new since ${ago}; he does not see it. Give it its state: answered or needs with the summary, pending if a team has it, or close it if he reacted to it as finished.`;
  });
  const head = 'These threads are due a check. Answer missing replies; an unchanged ask is not a reason to remind him again.';
  // A thread that waits on him may have been answered where it lives (answered-there.ts).
  const there = due.some((d) => d.overdue.why === 'needs') ? `\n${ANSWERED_THERE_RECHECK}` : '';
  return `${head}${there}\n${lines.join('\n')}`;
}

/**
 * The note as it goes in. A notification, not a trigger: the node only gives words, so a wait it is
 * parked on stays (task-wait-resume.ts reads a trigger envelope as what the wait waited for).
 */
export function threadRecheckMessage(due: readonly DueThread[], nowMs: number): string {
  return buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut: threads', outcome: 'threads-overdue', note: 'threads with no reply for too long' },
    body: threadRecheckBody(due, nowMs),
  });
}

/** The live facts nodeCarriesOn reads: the delivery session's outliving work, the triggers that will wake the task. */
async function workFacts(
  node: Task, session: { claudeSessionId: string; process_status?: string }, sessions: readonly SessionRecord[],
): Promise<{ outliving: readonly string[]; triggers: number }> {
  const live = session.process_status === 'running' || session.process_status === 'idle';
  const outliving = live
    ? await import('../../providers/claude-code-session.js').then((m) => m.sessionRunner.outlivingWorkOf(session.claudeSessionId)).catch(() => [])
    : [];
  const triggers = await (async () => {
    const { armedTriggersByTask, wakingTriggers } = await import('../user-status-sync.js');
    const { allEndedAtMs, sessionWorkEndedAtMs } = await import('../task-wait-wake.js');
    const own = sessions.filter((s) => !s.archived);
    const list = (await armedTriggersByTask()).get(node.id) ?? [];
    return wakingTriggers(node, list, {
      anyRunning: own.some((s) => s.process_status === 'running'),
      workEndedMs: allEndedAtMs(own.map((s) => sessionWorkEndedAtMs(s))),
    }).length;
  })().catch(() => 0);
  return { outliving, triggers };
}

let timer: ReturnType<typeof setInterval> | null = null;
let passRunning = false;

/** One pass: each node with a thread due gets one note. Returns the node task ids woken. Exported for tests. */
export async function runThreadRecheck(nowMs = Date.now()): Promise<string[]> {
  const woken: string[] = [];
  // One pass at a time: a slow one (many nodes, a slow host) never overlaps the next tick.
  if (passRunning) return woken;
  passRunning = true;
  try {
    const { isOrgEnabled } = await import('./org-enabled.js');
    if (!(await isOrgEnabled())) return woken;
    const { listTasks } = await import('../task-manager.js');
    const all = await listTasks();
    // A team the user stopped in one step (team-stop.ts): its root and every open task under it, not
    // only the members the record lists (it lists those with something to bring back on resume).
    const { teamOf } = await import('../sessions/team-stop.js');
    const quieted = new Set(all.filter((t) => t.team_stop).flatMap((root) => teamOf(root, all).map((m) => m.id)));
    const nodes = all.filter((t: Task) => keepsThreads(t) && t.phase !== 'COMPLETE' && !t.plugin_only && !quieted.has(t.id));
    const store = await import('./threads-store.js');
    for (const node of nodes) {
      const file = await store.readThreads(node.id).catch(() => null);
      if (!file?.threads.length) continue;
      const threads = await store.withTaskAsks(node.id, file.threads, all);
      let due = threadsDueRecheck(threads, nowMs, all);
      if (!due.length) continue;
      const { getSessionsForTask } = await import('../session-tracker.js');
      const { pickDeliverySession } = await import('../routines/session-target.js');
      const sessions = await getSessionsForTask(node.id).catch(() => [] as SessionRecord[]);
      const target = pickDeliverySession(sessions);
      if (!target || personStopped(target)) continue;
      // Its own work runs on and wakes it (2026-11-23, the org reflection: 48 of 51 reminders in one
      // night made a node run a full turn to say "still waiting" while its subagent or land ran): a
      // working thread he does not see waits for that turn's status line, never a turn of its own.
      const shared = sharedAnswers(threads);
      if (due.some((d) => quietWorking(d, shared))) {
        const carries = nodeCarriesOn(node, await workFacts(node, target, sessions), nowMs);
        if (carries) {
          due = threadsDueRecheck(threads, nowMs, all, { carriesOn: true });
          log.task.info('org threads: quiet working threads left to the node\'s own work', { taskId: node.id, carries });
          if (!due.length) continue;
        }
      }
      const at = new Date(nowMs).toISOString();
      const mark = (pending: boolean) => new Map<string, ThreadRecheck>(due.map((d) => {
        const repeats = nextRepeats(d.thread, d.overdue, shared);
        return [d.thread.id, { since: d.overdue.since, at, why: d.overdue.why, ...(repeats ? { repeats } : {}), ...(pending ? { pending: true } : {}) }];
      }));
      // Recorded first, as on its way: a pass after a failed send (or a restart before it went in)
      // tries again once RETRY_MS passed, never every pass, and the card says "reminded" only once it went in.
      await store.noteThreadsRechecked(node.id, mark(true)).catch(() => {});
      const { sendMessageToSession } = await import('../session-message-queue.js');
      try {
        await sendMessageToSession(target.claudeSessionId, threadRecheckMessage(due, nowMs), { source: THREAD_RECHECK_SOURCE, taskId: node.id });
        await store.noteThreadsRechecked(node.id, mark(false)).catch(() => {});
        woken.push(node.id);
        log.task.info('org threads: overdue threads re-check sent', { taskId: node.id, sessionId: target.claudeSessionId, threads: due.map((d) => d.thread.id) });
      } catch (err) {
        log.task.warn('org threads: overdue re-check not delivered', { taskId: node.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    log.task.warn('org threads: overdue re-check pass failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    passRunning = false;
  }
  return woken;
}

export function startThreadRecheck(): { stop: () => void } {
  if (process.env.WALNUT_THREAD_RECHECK === '0' || timer) return { stop: () => {} };
  timer = setInterval(() => { void runThreadRecheck(); }, THREAD_RECHECK_SCAN_MS);
  timer.unref?.();
  return { stop: () => { if (timer) clearInterval(timer); timer = null; } };
}
