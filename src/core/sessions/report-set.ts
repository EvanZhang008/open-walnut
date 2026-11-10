/**
 * Setting a task's own line from outside its turn (2026-10-31, the user: "each task shoud be giving
 * the what is waiting next other like vp can chaneg it but each task mange it self").
 *
 * A task writes where it stands at every turn end (its self-report, `task.status_report`, read by
 * user-status.ts as the status's `line`). Its lead, VP or Main, or a person, may change it: the change
 * is stored as the task's report with `by`, and it moves the phase the way the task's own report would
 * (report-phase.ts). The task's next own report replaces it. A Needs you line always names the ask:
 * there is no bare Needs you.
 */
import type { Task } from '../types.js';
import { userKindVerdict } from '../org/user-kind.js';
import { ASK_KINDS, ASK_MORE_MAX, ASK_OPTIONS_MAX, type AskKind, type AskOption, type StatusLineBy, type StatusReport, type WaitKind } from '../user-status.js';
import { needsSinceOf, settleCheck, type UserSaid } from './user-spoke.js';
import { stampSaidDecision } from '../ask-decision.js';

export interface ReportChange {
  state: 'needs' | 'working' | 'waiting';
  /** needs: the one thing the user must decide or do. */
  ask?: string;
  /** waiting: on whom or what. */
  waiting_on?: string;
  waiting_kind?: WaitKind;
  /** working (or any state): who does what next. */
  next?: string;
  /** needs: how the user answers (yes_no | single | multi | text), its options and its detail. */
  ask_kind?: AskKind;
  ask_options?: Array<string | AskOption>;
  ask_more?: string;
  /** needs, set by a task (not a person): which of the user's own kinds the ask is, and why (org/user-kind.ts). */
  user_kind?: string;
  user_kind_why?: string;
  /** needs: the decision it is (ask-decision.ts): its id, kept in other words, or "new" for another decision. */
  ask_id?: string;
  /** needs, the same decision: what is really new about it (a fact, an option, a deadline). */
  ask_new?: string;
  /** needs: why it asks what a task in its tree already asks the user (same-ask.ts). Never stored. */
  same_ask_reason?: string;
  /** Set by a task over the task's ask after the user wrote there: his words, passed back (user-spoke.ts). Never stored. */
  user_words?: string;
}

export class ReportChangeError extends Error {
  constructor(message: string, readonly code = 'bad_request', readonly status = 400) {
    super(message);
    this.name = 'ReportChangeError';
  }
}

const WAIT_KINDS: readonly WaitKind[] = ['task', 'time', 'machine', 'outside', 'own', 'you', 'lead', 'other'];
const MAX = 300;
const text = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ReportChangeError('ask, waiting_on and next are strings');
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > MAX) throw new ReportChangeError(`ask, waiting_on and next are at most ${MAX} characters`);
  return t || undefined;
};

/** The change as a report, checked. Pure. */
export function reportOfChange(raw: unknown, by: StatusLineBy, byName: string | undefined, nowMs: number): StatusReport {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (c.state !== 'needs' && c.state !== 'working' && c.state !== 'waiting') {
    throw new ReportChangeError('report.state must be one of: needs, working, waiting');
  }
  const kind = c.waiting_kind;
  if (kind !== undefined && !(typeof kind === 'string' && (WAIT_KINDS as readonly string[]).includes(kind))) {
    throw new ReportChangeError(`report.waiting_kind must be one of: ${WAIT_KINDS.join(', ')}`);
  }
  const ask = text(c.ask);
  const waitingOn = text(c.waiting_on);
  const next = text(c.next);
  // Needs you always carries a concrete ask (2026-10-31, the user: "u need to show what are actually waiting").
  if (c.state === 'needs' && (!ask || ask.length < 3)) throw new ReportChangeError('report.state needs takes the concrete ask: what the user must decide or do');
  if (c.state === 'waiting' && !waitingOn) throw new ReportChangeError('report.state waiting takes waiting_on: on whom or what it waits');
  const shape = c.state === 'needs' ? askShapeOf(c) : {};
  // A Needs you a task or lead puts on the user names which of their kinds it is, as a letter does
  // (org/user-kind.ts); a person's own line is never asked. The task's own turn-end report is judged
  // in readStatusReport (an ask with no kind reads as a report to its lead).
  let own: { kind: string; why: string } | undefined;
  if (c.state === 'needs' && by !== 'human') {
    const verdict = userKindVerdict(c);
    if (!verdict.ok) throw new ReportChangeError(verdict.message.replace(/^Not sent to the user:/, 'Not put on the user:'), 'user_kind', 409);
    own = { kind: verdict.kind, why: verdict.why };
  }
  const at = new Date(nowMs).toISOString();
  return {
    state: c.state,
    ...(ask && c.state === 'needs' ? { ask } : {}),
    ...(own ? { ask_own: own } : {}),
    ...(waitingOn && c.state === 'waiting' ? { waiting_on: waitingOn } : {}),
    ...(kind && c.state === 'waiting' ? { waiting_kind: kind as WaitKind } : {}),
    ...(next ? { next } : {}),
    ...shape,
    ...(c.state === 'needs' ? saidDecisionOf(c) : {}),
    at, turn_ended_at: at,
    ...(by !== 'self' ? { by, ...(byName ? { by_name: byName.slice(0, 120) } : {}) } : {}),
    // `by` comes from the route's own caller resolution (setTaskReport: human only with no caller
    // header), never from the body, so a person's line records the primary; a body's source_host is never read.
    ...(by === 'human' ? { source_host: 'local' as const } : {}),
  };
}

/** What the caller said of the decision (ask-decision.ts): the id it keeps, or "new", and a new fact. */
function saidDecisionOf(c: Record<string, unknown>): Pick<StatusReport, 'ask_id' | 'ask_new'> {
  const id = c.ask_id;
  if (id !== undefined && id !== null && typeof id !== 'string') throw new ReportChangeError('report.ask_id is a string: the decision id the task asks, or "new"');
  const fact = text(c.ask_new);
  return { ...(typeof id === 'string' && id.trim() ? { ask_id: id.trim() } : {}), ...(fact ? { ask_new: fact } : {}) };
}

/** The ask's answer shape from a change, checked: a choice takes 2 to ASK_OPTIONS_MAX options, yes_no and text none. */
function askShapeOf(c: Record<string, unknown>): Pick<StatusReport, 'ask_kind' | 'ask_options' | 'ask_more'> {
  const kind = c.ask_kind;
  if (kind !== undefined && !(typeof kind === 'string' && (ASK_KINDS as readonly string[]).includes(kind))) {
    throw new ReportChangeError(`report.ask_kind must be one of: ${ASK_KINDS.join(', ')}`);
  }
  const raw = c.ask_options;
  if (raw !== undefined && !Array.isArray(raw)) throw new ReportChangeError('report.ask_options is a list of options');
  const options: AskOption[] = (raw ?? []).map((o: unknown, i: number) => {
    const obj = typeof o === 'string' ? { label: o } : (o ?? {}) as Record<string, unknown>;
    const label = typeof obj.label === 'string' ? obj.label.replace(/\s+/g, ' ').trim() : '';
    if (!label || label.length > 80) throw new ReportChangeError('each report.ask_options entry has a label of 1 to 80 characters');
    const id = typeof obj.id === 'string' && /^[\w-]{1,40}$/.test(obj.id) ? obj.id : `o${i + 1}`;
    return { id, label, ...(obj.recommended === true ? { recommended: true } : {}) };
  });
  const choice = kind === 'single' || kind === 'multi';
  if (choice && (options.length < 2 || options.length > ASK_OPTIONS_MAX)) {
    throw new ReportChangeError(`report.ask_kind ${kind} takes 2 to ${ASK_OPTIONS_MAX} ask_options`);
  }
  if (!choice && options.length) throw new ReportChangeError('report.ask_options go only with ask_kind single or multi');
  if (new Set(options.map((o) => o.id)).size !== options.length) throw new ReportChangeError('report.ask_options ids are unique');
  const more = c.ask_more;
  if (more !== undefined && more !== null && typeof more !== 'string') throw new ReportChangeError('report.ask_more is a string');
  const detail = typeof more === 'string' ? more.trim() : '';
  if (detail.length > ASK_MORE_MAX) throw new ReportChangeError(`report.ask_more is at most ${ASK_MORE_MAX} characters`);
  return {
    ...(kind ? { ask_kind: kind as AskKind } : {}),
    ...(choice ? { ask_options: options } : {}),
    ...(detail ? { ask_more: detail } : {}),
  };
}

/** Who sets a report: a resolved caller task (with the session it called from), or a session
 *  caller Walnut could not resolve (`unknown`: never stored as a person). */
export type ReportSetter = { taskId: string; title?: string; sessionId?: string } | { unknown: true };

/**
 * Store the change as the task's report and move its phase as its own report would. `setter`: the
 * caller's task (its id, title and session), an unresolved session caller, or null for a person;
 * the task's own session is `self`.
 */
export async function setTaskReport(
  taskId: string, raw: unknown, setter: ReportSetter | null, nowMs = Date.now(),
): Promise<{ task: Task; phase: string | null; userSaid?: UserSaid }> {
  const { getTask, updateTask, updateTaskRaw } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  if (!task) throw new ReportChangeError(`task ${taskId} not found`, 'not_found', 404);
  if (task.phase === 'COMPLETE' || task.status === 'done') throw new ReportChangeError('the task is complete: reopen it first', 'conflict', 409);
  const known = setter && 'taskId' in setter ? setter : null;
  const by: StatusLineBy = !setter ? 'human' : !known ? 'unknown' : known.taskId === task.id ? 'self' : `task:${known.taskId}`;
  const parsed = reportOfChange(raw, by, known && by !== 'self' ? known.title : undefined, nowMs);
  // The writer's session comes from the resolved caller only, never from the request body.
  const { session_id: _fromBody, ...rest } = parsed;
  const sid = known?.sessionId?.trim();
  const changed: StatusReport = sid ? { ...rest, session_id: sid } : rest;
  const needsSince = needsSinceOf(changed, task.status_report);
  // The decision it asks keeps its id across rewordings, unless the caller says it is new (ask-decision.ts).
  const report: StatusReport = stampSaidDecision(needsSince ? { ...changed, needs_since: needsSince } : changed, task.status_report);
  // Another task taking the ask off the user's Needs you (any line but the same ask) reads his words
  // in the task first, and passes back any he wrote since it asked (user-spoke.ts).
  let userSaid: UserSaid | undefined;
  if (known && by.startsWith('task:')) {
    const { openAskOf } = await import('./ask-answer.js');
    const { askKey } = await import('../same-ask.js');
    const open = openAskOf(task);
    // Only the same words leave his ask as it was: a reworded ask is checked against what he wrote
    // there too (the decision id only keeps it from being news, ask-decision.ts).
    if ('ask' in open && !(report.state === 'needs' && askKey(report.ask) === askKey(open.ask))) {
      const { listTasks } = await import('../task-manager.js');
      const userWords = typeof (raw as ReportChange | null)?.user_words === 'string' ? (raw as ReportChange).user_words : undefined;
      const check = await settleCheck(task, known.taskId, userWords, 'changed', await listTasks().catch(() => []));
      if (check?.refusal) throw new ReportChangeError(check.refusal, 'user_spoke_since', 409);
      userSaid = check?.said;
    }
  }
  // A Needs you its tree already asks the user is not put on them twice (same-ask.ts); a person's own line is never asked.
  if (report.state === 'needs' && by !== 'human') {
    const { refuseSameAsk } = await import('../same-ask-tree.js');
    const { SameAskError } = await import('../same-ask.js');
    const { reportDecision } = await import('../ask-decision.js');
    await refuseSameAsk(task.id, report.ask, 'report', raw as Record<string, unknown>, [], reportDecision(report, task.due_date)).catch((err) => {
      throw err instanceof SameAskError ? new ReportChangeError(err.message, err.code, err.status) : err;
    });
  }
  await updateTaskRaw(task.id, { status_report: report }, { emitEvent: true, source: 'report-set' });
  // The phase follows as the task's own report would move it (report-phase.ts), written as the
  // deliberate change it is (a lead or a person set it), so a parked task moves too. Not inside a
  // running turn: that turn's own report decides.
  const { phaseForReport, reportNeedsEvidence } = await import('./report-phase.js');
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = task.session_id ? await getSessionByClaudeId(task.session_id).catch(() => null) : null;
  let phase: string | null = null;
  if (rec?.process_status !== 'running' && !rec?.pendingPermission) {
    let next = phaseForReport(report, task, rec?.process_status === 'idle', 'unknown');
    if (next === 'WAITING' && reportNeedsEvidence(report, task)) {
      const { outsideWaitEvidence } = await import('./outside-wait.js');
      next = phaseForReport(report, task, rec?.process_status === 'idle', !!(await outsideWaitEvidence(task).catch(() => null)));
    }
    if (next && next !== task.phase) {
      await updateTask(task.id, { phase: next }, { source: 'api' });
      phase = next;
    }
  }
  const { log } = await import('../../logging/index.js');
  log.task.info('task report set', { taskId: task.id, by, state: report.state, phase });
  return { task: (await getTask(task.id).catch(() => task)) ?? task, phase, ...(userSaid ? { userSaid } : {}) };
}
