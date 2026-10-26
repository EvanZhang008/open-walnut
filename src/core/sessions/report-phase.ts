/**
 * A turn's own report moves its task's phase (2026-10-26, the user: the status is "self updated by
 * task ... task has status, we already have good task system"). The session answers FOR_USER_STATE
 * in its turn-end self-report (session-hooks/builtins.ts); the phase it implies is written when the
 * task still stands where that turn left it, so every surface that counts phases counts what the
 * task itself said:
 *
 *   needs-you    NEED_ACTION  stopped on something only the user can give
 *   waiting you  NEED_ACTION  the user's move, even with no rush (WAITING would hide it from their list)
 *   waiting      WAITING      the next move is another task's, a time's, a watch's, its lead's
 *   working      IN_PROGRESS  it carries on by itself, and its process is still there
 *   done         WAITING      with a leader, which checks and closes it; without one it stays handed back
 *
 * Main moves only to NEED_ACTION, when it is stopped on the user: otherwise it stays as it is (in
 * progress, waiting on the user's next message). A WAITING it is moved to gets the default clock
 * (prepareRawUpdate), so a task its leader never picks up still comes back.
 *
 * Never over a move made after the turn ended (a person's pick, its leader's, a new turn), never
 * while its session runs a turn, never on a finished task. A parked task moves only when its report
 * says it is stopped on the user: a standing routine's fire turn ends back in WAITING (phase.ts),
 * and when that turn found something only the user can give, its report is how the user hears it.
 */
import { log } from '../../logging/index.js';
import type { Task, TaskPhase } from '../types.js';
import type { StatusReport } from '../user-status.js';

/** Clock slack between the turn's end (this process) and the phase write (the same process, later). */
const SLACK_MS = 5_000;
/** How long after its turn's end a stored report may have been written (applyStoredReports). */
const STORED_REPORT_WINDOW_MS = 10 * 60_000;

export function phaseForReport(
  report: Pick<StatusReport, 'state' | 'waiting_kind'>, task: Pick<Task, 'parent_task_id' | 'org_role'>, alive: boolean,
): TaskPhase | null {
  const onUser = report.state === 'needs' || (report.state === 'waiting' && report.waiting_kind === 'you');
  // Main's turn ends on the user's next message as a rule: only a real stop on them moves it.
  if (task.org_role === 'main') return report.state === 'needs' ? 'NEED_ACTION' : null;
  if (onUser) return 'NEED_ACTION';
  switch (report.state) {
    case 'working': return alive ? 'IN_PROGRESS' : null;
    case 'waiting': return 'WAITING';
    case 'done': return task.parent_task_id ? 'WAITING' : null;
    default: return null;
  }
}

/** Whether a phase write to `next` may follow the report of the turn that ended at `turnEndedAt`. */
export function reportMayMovePhase(
  task: Pick<Task, 'phase' | 'phase_changed_at'>, turnEndedAt: number, next?: TaskPhase | null, state?: StatusReport['state'],
): boolean {
  // A parked task only for a real stop on the user: a routine whose turn left something for the
  // user to read "when you have time" stays waiting on its next run.
  const from = task.phase === 'NEED_ACTION' || task.phase === 'IN_PROGRESS' || (task.phase === 'WAITING' && next === 'NEED_ACTION' && state === 'needs');
  if (!from) return false;
  const moved = task.phase_changed_at ? Date.parse(task.phase_changed_at) : NaN;
  return !Number.isFinite(moved) || moved <= turnEndedAt + SLACK_MS;
}

export async function applyReportPhase(
  taskId: string, sessionId: string, report: StatusReport, turnEndedAt: number,
): Promise<TaskPhase | null> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(sessionId).catch(() => null);
  // A new turn is running: its own end decides.
  if (rec?.process_status === 'running' || rec?.pendingPermission) return null;
  const alive = rec?.process_status === 'idle';
  const { getTask, updateTaskRaw } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  if (!task) return null;
  const next = phaseForReport(report, task, alive);
  if (!next || next === task.phase || !reportMayMovePhase(task, turnEndedAt, next, report.state)) return null;
  const { readMarkerForPhase } = await import('../phase.js');
  const res = await updateTaskRaw(taskId, { phase: next, ...readMarkerForPhase(next) }, {
    emitEvent: true, push: true, source: 'status-report',
    shouldUpdate: (cur) => reportMayMovePhase(cur, turnEndedAt, next, report.state) && cur.phase === task.phase,
  });
  if (!res?.changed) return null;
  log.session.info('status report moved the phase', { taskId, sessionId, from: task.phase, to: next, state: report.state });
  return next;
}

/**
 * At start, each open task's stored report moves its phase the way a fresh one would, when nothing
 * moved the task since. Reports written before reports moved phases (2026-10-26) left tasks handed
 * back that their sessions said wait on another task or carry on. No process counts as alive here,
 * so a "working" report moves nothing. Safe to run on every start: a task already at its report's
 * phase, or moved after it, is left alone.
 */
export async function applyStoredReports(): Promise<number> {
  const { listTasks } = await import('../task-manager.js');
  const tasks = await listTasks().catch(() => [] as Task[]);
  let moved = 0;
  for (const task of tasks) {
    const report = task.status_report;
    if (!report?.at || task.phase === 'COMPLETE' || task.status === 'done') continue;
    const at = Date.parse(report.at);
    const phaseAt = task.phase_changed_at ? Date.parse(task.phase_changed_at) : NaN;
    // Only the move the report followed: a report comes some minutes after its turn ends (the
    // debounce plus the ask), so a phase set earlier than that is an older turn's, and one set
    // later is someone else's.
    if (!Number.isFinite(at) || !Number.isFinite(phaseAt) || phaseAt < at - STORED_REPORT_WINDOW_MS) continue;
    const next = phaseForReport(report, task, false);
    if (!next || next === task.phase || !reportMayMovePhase(task, at, next, report.state)) continue;
    if (await applyReportPhase(task.id, task.session_id ?? '', report, at).catch(() => null)) moved++;
  }
  if (moved) log.task.info('status reports moved phases at start', { moved });
  return moved;
}
