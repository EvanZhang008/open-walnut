/**
 * A turn that only made progress does not settle the requests its target owes (2026-11-02, the org
 * reflection: a worker's turn ended with "run 5 is going", Walnut settled the six requests its lead
 * had open as "no reply" at that edge, the worker parked to wait for the nightly build, and the lead
 * read six notices and had to ask again).
 *
 * Two rules, kept here so the Stop hook (unanswered-at-stop.ts) and the turn-end edge
 * (session-hooks/builtins.ts session-request-watch) read the same facts:
 *
 *  - {@link progressReason}: the target's answer comes LATER, so a turn end is not the end of the
 *    request. Its own work runs on after the turn (a detached command, an armed wakeup), it parked
 *    itself (WAITING: a wait outside Walnut), or it waits on another task's answer. The requests
 *    stay open (open_items lists them, the deadline still counts), and the asker is not told.
 *  - {@link settleAfterReport}: a plain stop (NEED_ACTION, nothing running) is judged by the
 *    turn-end self-report, which moves the phase a few seconds later (status-question.ts). Settling
 *    at the bare edge settled requests of a task that then parked. So the settle waits for the report,
 *    then looks again: parked or running again means progress, still handed back means the target
 *    stopped without answering, and its askers are told once each (notifyRequesterGroup).
 */
import { log } from '../../logging/index.js';
import type { NoticeLastMessage, SessionRequest } from '../session-requests.js';
import { STATUS_SETTLE_MS } from './status-question.js';
import { whenReportSettled } from './report-pending.js';

export type ProgressReason = 'work-outlives-turn' | 'parked' | 'waits-on-another-task';

/** Whether the target's own work runs on after its turn (a detached command, an armed wakeup, a team). */
async function workOutlives(sessionId: string): Promise<boolean> {
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    return sessionRunner.hasWorkOutlivingTurn(sessionId);
  } catch {
    return false;
  }
}

/**
 * Why the target's answer to a request comes after this turn, or null when the turn ending is all
 * there is. `phase` is the task's phase at the edge; `rows` the request ledger when the caller read it.
 */
export async function progressReason(input: {
  sessionId?: string;
  taskId?: string;
  phase?: string;
  rows?: readonly SessionRequest[];
}): Promise<ProgressReason | null> {
  let phase = input.phase;
  if (!phase && input.taskId) {
    const { listTasksByIds } = await import('../task-manager.js');
    phase = (await listTasksByIds([input.taskId]).catch(() => []))[0]?.phase;
  }
  // A task parked itself on a wait outside Walnut (a build, a review): it is not abandoning the request.
  if (phase === 'WAITING') return 'parked';
  if (input.sessionId && await workOutlives(input.sessionId)) return 'work-outlives-turn';
  if (input.sessionId) {
    const requests = await import('../session-requests.js');
    const rows = input.rows ?? await requests.listAllSessionRequests().catch(() => [] as SessionRequest[]);
    // It waits on another task's answer itself: its result comes after that one.
    if (rows.some((r) => r.status === 'pending' && r.fromSessionId === input.sessionId)) return 'waits-on-another-task';
  }
  return null;
}

/** A request's turn end is not an unanswered stop while the task's own work continues. */
export async function requestTargetContinues(request: Pick<SessionRequest, 'toTaskId' | 'toSessionId'>): Promise<boolean> {
  const { listTasksByIds } = await import('../task-manager.js');
  const task = request.toTaskId ? (await listTasksByIds([request.toTaskId]).catch(() => []))[0] : undefined;
  if (task?.phase === 'COMPLETE') return false;
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const sid = request.toSessionId ?? task?.session_id ?? undefined;
  const record = sid ? await getSessionByClaudeId(sid).catch(() => null) : null;
  if (record?.process_status === 'error' || record?.pendingPermission) return false;
  if (record?.process_status === 'running') return true;
  const live = task?.user_status;
  if (live?.state === 'needs' || live?.state === 'read' || live?.state === 'done') return false;
  // A running turn's stored Working can outlast the turn during status settling.
  // Between turns, Working names what still carries it (its process, watch or clock).
  if (live?.state === 'working' && live.carriesOn) return true;
  return !!await progressReason({ sessionId: sid, taskId: task?.id, phase: task?.phase });
}

/** Latest deferred pass per session: a newer turn end replaces an older one. */
const deferred = new Map<string, symbol>();

/** The report window the status question uses, plus a little for the answer to land. */
const REPORT_GRACE_MS = STATUS_SETTLE_MS + 1_500;

/** Passes still running, for tests to wait on. */
const inFlight = new Set<Promise<void>>();
export async function flushSettleAfterReport(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/** Test hook: how long a deferred pass waits before it looks at the report. */
let graceMs = REPORT_GRACE_MS;
export function __setReportGraceForTest(ms: number | undefined): void { graceMs = ms ?? REPORT_GRACE_MS; }
export function __resetRequestProgress(): void { deferred.clear(); inFlight.clear(); graceMs = REPORT_GRACE_MS; }

/**
 * A plain stop left these requests unanswered: decide after the turn-end report. Returns at once;
 * the pass runs in the background and never throws.
 */
export function settleAfterReport(input: { sessionId: string; taskId: string; requestIds: readonly string[]; lastWords?: NoticeLastMessage }): Promise<void> {
  const token = Symbol('settle-after-report');
  deferred.set(input.sessionId, token);
  const run = (async () => {
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, graceMs); t.unref?.(); });
    await whenReportSettled(input.sessionId);
    if (deferred.get(input.sessionId) !== token) return; // a later turn end took over
    deferred.delete(input.sessionId);
    await settleStopped(input);
  })().catch((err) => {
    log.session.warn('request settle after the report failed', {
      sessionId: input.sessionId, taskId: input.taskId, error: err instanceof Error ? err.message : String(err),
    });
  }).finally(() => { inFlight.delete(run); });
  inFlight.add(run);
  return run;
}

/** The pass itself: the target is still handed back and still owes these requests. */
async function settleStopped(input: { sessionId: string; taskId: string; requestIds: readonly string[]; lastWords?: NoticeLastMessage }): Promise<void> {
  const { listTasksByIds } = await import('../task-manager.js');
  const task = (await listTasksByIds([input.taskId]).catch(() => []))[0];
  // COMPLETE has its own edge. Anything but a handed-back task is working or parked: not a stop.
  if (!task || task.phase !== 'NEED_ACTION') {
    log.session.info('requests kept open: the turn-end report moved the task on', { taskId: input.taskId, phase: task?.phase, requestIds: input.requestIds });
    return;
  }
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(input.sessionId).catch(() => undefined);
  // A new turn is running: its end is the next edge, and these belong to it.
  if (record?.process_status === 'running') return;
  const why = await progressReason({ sessionId: input.sessionId, taskId: input.taskId, phase: task.phase });
  if (why) {
    log.session.info('requests kept open: the answer comes later', { taskId: input.taskId, why, requestIds: input.requestIds });
    return;
  }
  const requests = await import('../session-requests.js');
  const open = (await Promise.all(input.requestIds.map((id) => requests.getSessionRequest(id).catch(() => undefined))))
    .filter((r): r is SessionRequest => !!r && r.status === 'pending');
  if (open.length === 0) return;
  const { holdHandedOn } = await import('./request-handoff.js');
  const speak = await holdHandedOn(open, { outcome: record?.process_status === 'error' ? 'error' : 'completed', phase: task.phase });
  if (speak.length === 0) return;
  const notify = await import('./session-request-notify.js');
  const lastWords = input.lastWords ?? (await notify.readLastTurn(input.sessionId))?.words;
  await notify.notifyRequesterGroup(speak, record?.process_status === 'error' ? 'error' : 'completed', {
    phase: task.phase, lastWords,
  });
}
