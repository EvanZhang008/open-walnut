/**
 * A thread that sat too long with nothing from the node wakes the node (2026-11-07, the user, on a
 * thread with no reply for hours: "something must be wrong: the AI should go and answer it, and if
 * not, our system reminds"). thread-view.ts threadOverdue decides when a thread is overdue: in the
 * node's hands (new, working) REPLY_DUE_MS after the last thing on it, or waiting on him (needs)
 * NEEDS_QUIET_MS (a day) with nothing new, or once in the day before a linked task's deadline.
 * Each pass sends every Main or lead with an overdue thread ONE note
 * naming those threads, once per overdue stretch (`recheck` on the thread, recorded as pending
 * before the send and as sent after it, so a failed wake is tried again every RETRY_MS, never every
 * pass); the node's next write starts a new stretch, but a needs check keeps the daily gap.
 * No news needs no write or repeated ask. The card shares this clock (thread-view.ts overdueLine).
 *
 * Primary only, never on an ephemeral server (a copied thread would wake a copied node), and not
 * while the org is off; a node whose team or session the user stopped is not woken. `WALNUT_THREAD_RECHECK=0`
 * turns it off.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { agoWords } from '../user-status.js';
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import { threadDeadline, threadOverdue, type ThreadOverdue } from './thread-view.js';
import type { OrgThread, ThreadRecheck } from './threads-model.js';

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

/** The open threads of one node due a wake now: overdue, and not woken yet for this stretch. Pure. */
export function threadsDueRecheck(threads: readonly OrgThread[], nowMs: number, tasks: readonly Pick<Task, 'id' | 'due_date' | 'phase'>[] = []): DueThread[] {
  const out: DueThread[] = [];
  for (const t of threads) {
    const o = threadOverdue(t, nowMs, threadDeadline(t, tasks, nowMs));
    const r = t.recheck;
    if (!o || (r?.pending && nowMs - Date.parse(r.at) < RETRY_MS)
      || (!o.deadline && r?.since === o.since && !r.pending)) continue;
    out.push({ thread: t, overdue: o });
    if (out.length >= MAX_PER_NOTE) break;
  }
  return out;
}

function q(s: string): string { return JSON.stringify(s); }

/** The note: each thread, what is wrong with it, and what the node does about it. Pure. */
export function threadRecheckBody(due: readonly DueThread[], nowMs: number): string {
  const lines = due.map(({ thread: t, overdue: o }) => {
    const ago = agoWords(nowMs - Date.parse(o.since));
    if (o.why === 'needs') {
      return `- ${t.id} ${q(t.title)}: waits on him with nothing new since ${ago}${o.deadline ? `; a linked task is due ${o.deadline}` : ''}. Check it still stands without asking him again. If nothing changed, leave the thread unchanged; do not rewrite its summary just to change a checked time. Only update it for real news, or close it when evidence shows it no longer needs him.`;
    }
    return o.unanswered
      ? `- ${t.id} ${q(t.title)}: his last message (${ago}) has no reply on this thread (state ${t.state}). Answer it now: thread_update with the summary and answered or needs, or pending if it only went to a team.`
      : `- ${t.id} ${q(t.title)}: still ${t.state} with nothing new since ${ago}; he does not see it. Give it its state: answered or needs with the summary, pending if a team has it, or close it if he reacted to it as finished.`;
  });
  return `These threads are due a check. Answer missing replies; an unchanged ask is not a reason to remind him again.\n${lines.join('\n')}`;
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
    const nodes = all.filter((t: Task) => (t.org_role === 'main' || t.org_role === 'lead') && t.phase !== 'COMPLETE' && !t.plugin_only && !quieted.has(t.id));
    const store = await import('./threads-store.js');
    for (const node of nodes) {
      const file = await store.readThreads(node.id).catch(() => null);
      if (!file?.threads.length) continue;
      const due = threadsDueRecheck(file.threads, nowMs, all);
      if (!due.length) continue;
      const { getSessionsForTask } = await import('../session-tracker.js');
      const { pickDeliverySession } = await import('../routines/session-target.js');
      const target = pickDeliverySession(await getSessionsForTask(node.id).catch(() => []));
      if (!target || personStopped(target)) continue;
      const at = new Date(nowMs).toISOString();
      const mark = (pending: boolean) => new Map<string, ThreadRecheck>(due.map((d) => [d.thread.id, { since: d.overdue.since, at, why: d.overdue.why, ...(pending ? { pending: true } : {}) }]));
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
