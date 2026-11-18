/**
 * A turn's own report moves its task's phase (2026-10-26, the user: the status is "self updated by
 * task ... task has status, we already have good task system"). The session answers FOR_USER_STATE
 * in its turn-end self-report (session-hooks/builtins.ts); the phase it implies is written when the
 * task still stands where that turn left it, so every surface that counts phases counts what the
 * task itself said:
 *
 *   needs-you    NEED_ACTION  stopped on something only the user can give
 *   waiting you  NEED_ACTION  the user's move, even with no rush (WAITING would hide it from their list)
 *   waiting      WAITING      only for a wait outside Walnut and the user (outside-wait.ts): one it
 *                             names (outside, task, lead, machine), or one the task has armed (a
 *                             trigger of its own, a request out, an open subtask); else NEED_ACTION
 *   working      IN_PROGRESS  it carries on by itself, and its process is still there
 *   waiting own  IN_PROGRESS  its own build, test run, CI run, deploy or land runs: its work going on,
 *                             never a wait (2026-11-18, the user: Waiting only when "he really waits for
 *                             something external", and the task itself puts it there)
 *   done         unchanged    handed back; with a leader its status reads that the lead checks and
 *                             closes it (user-status.ts LEAD_CLOSE_WAIT), never parked for that lead
 *
 * Main and a lead never move to NEED_ACTION (Needs you is only ever an individual task, 2026-10-31):
 * a turn of theirs that asks the user keeps its question in their chat, and Main otherwise stays as it
 * is (waiting on the user's next message or its teams' news). A WAITING it is moved to gets the default clock
 * (prepareRawUpdate), so a task its leader never picks up still comes back.
 *
 * Never over a move made after the turn ended (a person's pick, its leader's, a new turn), never
 * while its session runs a turn, never on a finished task. A parked task moves only when its report
 * asks the user something concrete (FOR_USER_ASK): a standing routine's fire turn ends back in
 * WAITING (phase.ts), and when that turn found something only the user can give, its report is how
 * the user hears it. A park Walnut brought back at the turn end (an interrupted wait, a routine's fire
 * turn: task-wait-resume.ts isRestoredPark) is not the turn's own word, so a report naming its own
 * work as what runs ("waiting own") takes it out to IN_PROGRESS. A turn that parked its task on a wait of its own and only answered the user
 * (needs-you with no ask: their answer to read) stays parked (2026-11-18, the user: "if this task
 * already ahve a trigger and just wating wh not it self mark it as snoozed, waiting"): the park is
 * its own word that nothing else is left for them, and its answer stays unread on its row.
 */
import { log } from '../../logging/index.js';
import type { Task, TaskPhase } from '../types.js';
import { reportAsksUser, type StatusReport } from '../user-status.js';
import { openOwed } from '../peers/structured-reply.js';
import { OUTSIDE_WAIT_KINDS, outsideWaitEvidence, parksOnlyOnTrigger, reportNamesOutsideWait, waitWordsNameUser } from './outside-wait.js';

/** Clock slack between the turn's end (this process) and the phase write (the same process, later). */
const SLACK_MS = 5_000;
/** How long after its turn's end a stored report may have been written (applyStoredReports). */
const STORED_REPORT_WINDOW_MS = 10 * 60_000;

/**
 * The phase a report implies. `armed`: whether the task has an outside wait armed
 * (outsideWaitEvidence), read only by a waiting report that names none of its own. Left out it
 * counts as none; 'unknown' returns WAITING provisionally, for a caller that looks it up before
 * writing (applyReportPhase).
 */
export function phaseForReport(
  report: Pick<StatusReport, 'state' | 'waiting_kind' | 'waiting_on' | 'answered_person'>, task: Pick<Task, 'parent_task_id' | 'org_role'> & Partial<Pick<Task, 'result_report'>>, alive: boolean,
  armed: boolean | 'unknown' = false,
): TaskPhase | null {
  const onUser = report.state === 'needs' || (report.state === 'waiting' && (report.waiting_kind === 'you'
    || waitWordsNameUser(report.waiting_on, !!report.waiting_kind && OUTSIDE_WAIT_KINDS.has(report.waiting_kind))));
  // Needs you is only ever an individual task (2026-10-31, the user): Main or a lead whose turn asks
  // the user something keeps its question in its chat and waits on its teams; it never moves to
  // NEED_ACTION. Main's turn ends on the user's next message as a rule: nothing else moves it.
  if (task.org_role === 'main') return null;
  // A close its session tried left something for the user (owed-to-user.ts): it stays on their
  // list until that is settled, whatever a later turn says, except while its own work runs.
  if (!task.org_role && openOwed(task.result_report) && !task.result_report?.owed?.toCloser) return report.state === 'working' && alive ? 'IN_PROGRESS' : 'NEED_ACTION';
  const phase = individualPhase(report, task, alive, armed, onUser);
  // A lead parks only on a trigger of its own (outside-wait.ts parksOnlyOnTrigger): with none, its
  // turn's wait leaves the phase as it is, so no clock wakes it for nothing.
  if (phase === 'WAITING' && parksOnlyOnTrigger(task) && armed === false) return null;
  return task.org_role && phase === 'NEED_ACTION' ? null : phase;
}

function individualPhase(
  report: Pick<StatusReport, 'state' | 'waiting_kind' | 'waiting_on' | 'answered_person'>, task: Pick<Task, 'parent_task_id' | 'org_role'>, alive: boolean,
  armed: boolean | 'unknown', onUser: boolean,
): TaskPhase | null {
  if (onUser) return 'NEED_ACTION';
  // Its own build, test run, CI run, deploy or land is its work going on, never a wait (2026-11-18,
  // the user: Waiting only when "he really waits for something external").
  if (report.state === 'waiting' && report.waiting_kind === 'own') return alive ? 'IN_PROGRESS' : null;
  switch (report.state) {
    case 'working': return alive ? 'IN_PROGRESS' : null;
    // A turn that answered the user's message is theirs to read first, whatever the task waits on
    // next (2026-10-31, the user: "wait should be wait external"; a walkthrough he had asked for
    // left his list while he read it, because the task also waited on a CR approval).
    case 'waiting': if (report.answered_person) return 'NEED_ACTION';
      // A wait it cannot show is outside is the user's (2026-10-30: "the meeting notes" read as "other").
      return reportNamesOutsideWait(report, task) || armed !== false ? 'WAITING' : 'NEED_ACTION';
    // Finished: it stays where its turn left it (handed back), and its status reads that its lead
    // checks and closes it (user-status.ts LEAD_CLOSE_WAIT). Walnut never parks it for that lead.
    case 'done': return null;
    default: return null;
  }
}

/**
 * Whether the turn a report covers answered a message a person sent: one reached the session
 * (`humanInputAt`, stamped at the send) after the turn the task's previous report covered ended,
 * and no later than this turn's end. With no previous turn's report (none, or one a person or a
 * lead set with task_report_set, which covers no turn), any message before this turn's end
 * counts, so an unknown reads as answered and the task stays on the user's list. A report asked
 * again for the same turn (status-reconcile.ts) keeps what the first one found. A message sent
 * while an earlier turn ran that the CLI then answers in a turn of its own counts for the earlier
 * turn only (the stamp is the send's).
 */
export function turnAnsweredPerson(
  humanInputAt: string | undefined, turnEndedAt: number, prev?: Pick<StatusReport, 'turn_ended_at' | 'answered_person'> | null,
): boolean {
  const sent = Date.parse(humanInputAt ?? '');
  if (!Number.isFinite(sent) || sent > turnEndedAt + SLACK_MS) return false;
  const prevEnd = Date.parse(prev?.turn_ended_at ?? '');
  if (Number.isFinite(prevEnd) && Math.abs(prevEnd - turnEndedAt) <= SLACK_MS) return !!prev?.answered_person;
  return !Number.isFinite(prevEnd) || sent > prevEnd;
}

/** Whether a report's WAITING rests on facts the task must have (the caller looks them up). */
export function reportNeedsEvidence(report: Pick<StatusReport, 'state' | 'waiting_kind' | 'waiting_on'>, task: Pick<Task, 'parent_task_id'> & Partial<Pick<Task, 'org_role'>>): boolean {
  // A lead's park always rests on its own trigger, whatever its report names (parksOnlyOnTrigger).
  if (parksOnlyOnTrigger(task)) return report.state === 'waiting' || report.state === 'done';
  return report.state === 'waiting' && !reportNamesOutsideWait(report, task);
}

/** Whether a phase write to `next` may follow the report of the turn that ended at `turnEndedAt`. */
/** The report names its own work as what runs: "waiting own" (FOR_USER_WAITING_ON own:). A bare
 *  "working" does not lift a restored park: a task parked on a review may say it while that review
 *  is what it waits on, and its trigger still holds the park (2026-11-18 review). */
function saysOwnWork(report: Pick<StatusReport, 'state' | 'ask'> & Partial<Pick<StatusReport, 'waiting_kind'>> | null | undefined): boolean {
  return report?.state === 'waiting' && report.waiting_kind === 'own';
}

export function reportMayMovePhase(
  task: Pick<Task, 'phase' | 'phase_changed_at'>, turnEndedAt: number, next?: TaskPhase | null, report?: Pick<StatusReport, 'state' | 'ask'> & Partial<Pick<StatusReport, 'waiting_kind'>> | null,
  /** The task's WAITING is one Walnut restored at this turn end (task-wait-resume.ts isRestoredPark). */
  restored = false,
): boolean {
  // A parked task only for a real ask of the user: a routine whose turn left something for the user
  // to read "when you have time", or a turn that answered them and parked, stays waiting. A park
  // Walnut restored also leaves when the turn names its own work as what runs.
  const from = task.phase === 'NEED_ACTION' || task.phase === 'IN_PROGRESS'
    || (task.phase === 'WAITING' && ((next === 'NEED_ACTION' && reportAsksUser(report)) || (restored && next === 'IN_PROGRESS' && saysOwnWork(report))));
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
  let next = phaseForReport(report, task, alive, 'unknown');
  if (next === 'WAITING' && reportNeedsEvidence(report, task)) {
    const evidence = await outsideWaitEvidence(task, { sessionIds: [sessionId] });
    next = phaseForReport(report, task, alive, !!evidence);
    if (!evidence) log.session.info('status report waits on nothing outside: handed back to the user', { taskId, sessionId, waitingKind: report.waiting_kind });
  }
  if (next === 'WAITING' && await clockWakeOnlyAcked(task, sessionId, turnEndedAt)) {
    log.session.info('a wait_until wake answered with only an ack: not parked again', { taskId, sessionId });
    next = task.org_role ? null : 'NEED_ACTION';
  }
  const { isRestoredPark } = await import('../task-wait-resume.js');
  const restored = isRestoredPark(task);
  if (!next || next === task.phase || !reportMayMovePhase(task, turnEndedAt, next, report, restored)) return null;
  const { readMarkerForPhase } = await import('../phase.js');
  // leaveHeld: the turn's own report is the session machine's exit from a wait (reportMayMovePhase
  // lets a parked task out only for a stop on the user). Without it the raw write's held-phase
  // guard, which keeps a sync pull from waking a WAITING task, dropped the phase and kept the rest,
  // so the call read as moved while the ask stayed under Waiting (2026-11-16: a lead's review of
  // three draft CRs sat there for hours). The stored phase is what counts, not `changed`.
  const res = await updateTaskRaw(taskId, { phase: next, ...readMarkerForPhase(next) }, {
    emitEvent: true, push: true, source: 'status-report', leaveHeld: true,
    shouldUpdate: (cur) => reportMayMovePhase(cur, turnEndedAt, next, report, restored && isRestoredPark(cur)) && cur.phase === task.phase,
  });
  if (!res?.changed || res.task?.phase !== next) return null;
  log.session.info('status report moved the phase', { taskId, sessionId, from: task.phase, to: next, state: report.state });
  return next;
}

/**
 * The turn that just ended was the wait_until clock's wake (task-wait-until.ts), the task has no
 * trigger of its own armed, and the turn's whole answer was the agent-ack line: parking it again
 * would only set the next 4-hour clock to the same empty wake (2026-11-13, the org reflection: 19
 * clock wakes in one night, 7 answered with only an ack, each parked again). It goes back to its
 * lead or the user instead, who see that nothing will move it. Never throws: unknown reads as no.
 */
export async function clockWakeOnlyAcked(task: Pick<Task, 'id'>, sessionId: string, turnEndedAt: number): Promise<boolean> {
  try {
    const { clockWokeAt, triggersWatching, WAIT_WAKE_FROM } = await import('../task-wait-until.js');
    if (clockWokeAt(task.id, turnEndedAt + SLACK_MS, sessionId) === null) return false;
    const { triggerHoldsPark } = await import('../task-wait-wake.js');
    if ((await triggersWatching(task.id)).some((t) => t.state === 'armed' && triggerHoldsPark(t))) return false;
    const { readLastTurn } = await import('./session-request-notify.js');
    const turn = await readLastTurn(sessionId);
    if (!turn?.openedBy?.text.includes(`from="${WAIT_WAKE_FROM}"`)) return false;
    return turn.words?.ack === true && !turn.words.text.trim();
  } catch {
    return false;
  }
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
    // The move guard is against the turn's end, not the report's later write: a person's park in
    // between is a later move, which the live path refuses and this pass must too.
    const ended = Date.parse(report.turn_ended_at ?? '');
    const turnEndedAt = Number.isFinite(ended) ? ended : at;
    const next = phaseForReport(report, task, false, 'unknown');
    if (!next || next === task.phase || !reportMayMovePhase(task, turnEndedAt, next, report)) continue;
    if (await applyReportPhase(task.id, task.session_id ?? '', report, turnEndedAt).catch(() => null)) moved++;
  }
  if (moved) log.task.info('status reports moved phases at start', { moved });
  return moved;
}

/** How long ago a turn the start asks about again may have ended. */
const MISSED_REPORT_WINDOW_MS = 2 * 60 * 60_000;

/**
 * At start, the turns whose report a restart lost: the quiet timer and the ask live in the old
 * process (session-hooks/builtins.ts), so a deploy in those minutes left the task handed back
 * with no report, reading "its turn handed it back to you" until its next turn (2026-10-27). Each
 * such turn is announced again as settled, which re-arms its report. Only a task handed back by a
 * recent turn with no report of it, whose session is alive between turns: a dead one cannot answer.
 */
export async function askMissedReports(nowMs = Date.now()): Promise<number> {
  const { listTasks } = await import('../task-manager.js');
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const { reportIsCurrent } = await import('../user-status.js');
  const { bus, EventNames } = await import('../event-bus.js');
  const tasks = await listTasks().catch(() => [] as Task[]);
  let asked = 0;
  for (const task of tasks) {
    if (task.phase !== 'NEED_ACTION' || !task.session_id || !task.phase_changed_at) continue;
    const endedAt = Date.parse(task.phase_changed_at);
    if (!Number.isFinite(endedAt) || nowMs - endedAt > MISSED_REPORT_WINDOW_MS) continue;
    if (task.status_report && reportIsCurrent({ report: task.status_report, phaseChangedAt: task.phase_changed_at })) continue;
    const rec = await getSessionByClaudeId(task.session_id).catch(() => null);
    if (rec?.process_status !== 'idle' || rec.pendingPermission) continue;
    bus.emit(EventNames.SESSION_TURN_SETTLED, { sessionId: task.session_id, taskId: task.id, source: 'restart' }, ['*'], { source: 'report-phase' });
    asked++;
  }
  if (asked) log.task.info('status reports a restart lost: asked again', { asked });
  return asked;
}
