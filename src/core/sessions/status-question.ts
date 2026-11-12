/**
 * The task's status words, asked right at its turn end (2026-10-31, the user: the state is the
 * task's own phase, and its words come from "one light status-only side question" when the turn
 * ends, never a four-minute quiet wait). One short side question asks only the FOR_USER_* lines
 * (session-hooks/builtins.ts FOR_USER_PROMPT); its answer is the task's latest status
 * (task.status_report), moves the phase as the task's own report (report-phase.ts), and is the
 * status part of the turn's summary: the debounced summary self-report no longer asks it.
 *
 * Native Claude Code sessions: a side question there is answered between turns from the
 * session's own context, cheaply and invisibly. An ACP engine answers a hidden request with a turn
 * of its own, so its status rides the debounced summary, except an engine whose registry entry
 * asks for this question (statusQuestion: pi, 2026-11-02: a pi task read "its report on the turn
 * that just ended" for four and a half minutes after every turn).
 *
 * A turn the CLI follows with another within STATUS_SETTLE_MS (a background command coming back)
 * is not the end: the ask waits for that turn's end. One ask per session at a time; its answer
 * covers every turn that ended meanwhile. Until it comes the task reads Waiting on its report
 * (report-pending.ts). A stale answer is asked again by the reconcile loop (status-reconcile.ts).
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { STATUS_RULE_VERSION, type StatusReport } from '../user-status.js';
import { setReportPending } from './report-pending.js';

/** A turn end this quiet is the end (the CLI's own follow-up turn starts within ~3 s). */
export const STATUS_SETTLE_MS = 5_000;
/** The side question's own deadline: the CLI answers it between turns. */
const STATUS_TIMEOUT_MS = 3 * 60_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
/** The end of the question in flight per session, for a switch that must not stop a session mid-question. */
const flightEnds = new Map<string, Promise<void>>();
/** A turn end that came while an ask was in flight: asked again once that one settles. */
const rerun = new Map<string, { taskId: string; turnEndedMs: number }>();
/**
 * Sessions whose status the side question owns for their latest turn: the summary neither asks
 * the status lines nor holds the report pending for them. 'failed' (no answer, or none it could
 * read) hands that turn's status back to the summary, which asks the lines itself.
 */
const owned = new Map<string, 'armed' | 'answered' | 'failed'>();

export function statusQuestionOwns(sessionId: string): boolean {
  const s = owned.get(sessionId);
  return s === 'armed' || s === 'answered';
}

/** The ask: only the status lines, in the user's language where the user reads them. */
export function buildStatusPrompt(forUserPrompt: string, title: string, uiLanguageName?: string): string {
  const lines = forUserPrompt.replace(/^Then these lines/, 'Answer with only these lines');
  const lang = uiLanguageName
    ? `\nFOR_USER_ASK, FOR_USER_ASK_OWN, FOR_USER_ASK_OPTIONS, FOR_USER_ASK_MORE, FOR_USER_WAITING_ON, FOR_USER_NOW and FOR_USER_NEXT are shown to the user: write them in ${uiLanguageName}, keeping identifiers and technical terms in their original form; the kind word that starts FOR_USER_WAITING_ON (outside, task, lead, machine, own) and the kind word that starts FOR_USER_ASK_OWN stay in English, followed by ":".`
    : '';
  return `Walnut asks where this task${title ? ` ("${title.replace(/\s+/g, ' ').slice(0, 120)}")` : ''} stands now, for the user's board. Do not use any tool and do not continue the work. ${lines}${lang}`;
}

/** The task's own words on where it stands: stored, and moving its phase as its report. */
export async function applyStatusAnswer(
  taskId: string, sessionId: string, report: StatusReport, turnEndedMs: number, opts: { midTurn?: boolean } = {},
): Promise<boolean> {
  const { getTask, updateTaskRaw } = await import('../task-manager.js');
  // A finished task reads Done whatever its session said, and a write to a COMPLETE row would
  // announce it as completed again (updateTaskRaw names the event by phase).
  const current = await getTask(taskId).catch(() => null);
  if (!current || current.phase === 'COMPLETE' || current.status === 'done') return false;
  // Whether this turn answered a person's message: such a turn never parks the task (report-phase.ts).
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const { turnAnsweredPerson } = await import('./report-phase.js');
  const rec = await getSessionByClaudeId(sessionId).catch(() => null);
  // Asked inside a running turn (a watch, task-watch.ts): no turn ended, so the last turn's end
  // stays the boundary, and that turn's end asks again.
  const prev = current.status_report;
  const answered = opts.midTurn ? !!prev?.answered_person : turnAnsweredPerson(rec?.humanInputAt, turnEndedMs, prev);
  const endedAt = opts.midTurn ? prev?.turn_ended_at : new Date(turnEndedMs).toISOString();
  // The writer is the session asked, recorded here; a session_id the parsed answer carried is dropped.
  report = { ...report, rule: STATUS_RULE_VERSION, ...(endedAt ? { turn_ended_at: endedAt } : {}), ...(answered ? { answered_person: true } : {}), session_id: sessionId };
  // When it began asking, kept across asks in a row: a caller settling the ask reads the user's words since (user-spoke.ts).
  const { needsSinceOf } = await import('./user-spoke.js');
  const needsSince = needsSinceOf(report, prev);
  if (needsSince) report = { ...report, needs_since: needsSince };
  // The decision it asks keeps its id across rewordings (ask-decision.ts).
  const { stampSaidDecision } = await import('../ask-decision.js');
  report = stampSaidDecision(report, prev);
  await updateTaskRaw(taskId, { status_report: report }, {
    emitEvent: true, source: 'status-report', shouldUpdate: (cur) => cur.phase !== 'COMPLETE' && cur.status !== 'done',
  });
  const { applyReportPhase } = await import('./report-phase.js');
  if (!opts.midTurn) await applyReportPhase(taskId, sessionId, report, turnEndedMs);
  // A lead's or Main's promise with nothing to bring it back gets a follow-up (promise-alarm.ts).
  const { notePromise } = await import('./promise-alarm.js');
  await notePromise(taskId, report);
  return true;
}

/** Whether a status ask of this session is waiting for its quiet time or on its way (a respawn would cut it). */
export function statusQuestionPending(sessionId: string): boolean {
  return timers.has(sessionId) || inFlight.has(sessionId);
}

/** Whether a status ask of this session is on its way now (its answer comes; a watch need not ask). */
export function statusAskInFlight(sessionId: string): boolean {
  return inFlight.has(sessionId);
}

export async function routerScopedStatus(taskId: string, sessionId: string): Promise<boolean> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const profile = (await getSessionByClaudeId(sessionId))?.profile;
    if (profile?.areaId || profile?.areaRole) return true;
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(taskId);
    if (!task || task.router_area_id || task.org_role === 'router') return true;
    const { WALNUT_HOME } = await import('../../constants.js');
    const { readRouterAreas, taskArea } = await import('../router/areas.js');
    const file = await readRouterAreas(WALNUT_HOME);
    return !!taskArea(file, taskId) || file.routers.some((r) => r.taskId === taskId);
  } catch {
    return true;
  }
}

/** A session Walnut can ask now: a native Claude Code one, or a live ACP one whose engine takes the question. */
async function askableSession(sessionId: string): Promise<boolean> {
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  if (sessionRunner.findSessionByClaudeId(sessionId)) return true;
  const acp = sessionRunner.findAcpSession(sessionId);
  if (!acp) return false;
  const { engineCaps } = await import('../agents/engine-registry.js');
  return engineCaps(acp.engineId).statusQuestion === true;
}

/** Ask the status now. Never throws; answers whether a status was stored. */
export async function askStatus(taskId: string, sessionId: string, turnEndedMs: number, why: 'turn-end' | 'reconcile' | 'watch' = 'turn-end'): Promise<boolean> {
  if (await routerScopedStatus(taskId, sessionId)) {
    cancelStatusQuestion(sessionId);
    owned.set(sessionId, 'answered');
    return false;
  }
  if (inFlight.has(sessionId)) {
    // Its answer may describe the turn before this one: ask again when it settles.
    if (why === 'turn-end') rerun.set(sessionId, { taskId, turnEndedMs });
    return false;
  }
  inFlight.add(sessionId);
  let ended!: () => void;
  flightEnds.set(sessionId, new Promise<void>((r) => { ended = r; }));
  const askedAt = Date.now();
  let stored = false;
  try {
    // A session an engine switch replaced is history: its task's status comes from the new session.
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const { isSupersededSession } = await import('./engine-switch-marker.js');
    if (isSupersededSession(await getSessionByClaudeId(sessionId).catch(() => null))) return false;
    const { getTask } = await import('../task-manager.js');
    const task: Task | null = await getTask(taskId).catch(() => null);
    if (!task || task.phase === 'COMPLETE' || task.status === 'done') return false;
    const { FOR_USER_PROMPT, readStatusReport } = await import('../session-hooks/builtins.js');
    const { configuredUiLanguage, nonEnglishUiLanguage, uiLanguageName } = await import('../ui-language.js');
    const lang = nonEnglishUiLanguage(await configuredUiLanguage().catch(() => undefined));
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    // The user's messages it may still owe an answer: the same question judges them (user-asks.ts).
    const { owedQuestionFor, applyOwedAnswer } = await import('./user-asks.js');
    const owed = await owedQuestionFor(taskId, Date.now(), why === 'watch' ? Date.now() : turnEndedMs);
    // The asks its tree already holds, so it does not ask the user the same again (same-ask.ts).
    const { sameAskQuestionFor } = await import('../same-ask-tree.js');
    const sameAsk = await sameAskQuestionFor(taskId);
    const answer = (await sessionRunner.requestTurnCompleteSelfReport(
      sessionId, buildStatusPrompt(FOR_USER_PROMPT, task.title, lang ? uiLanguageName(lang) : undefined) + sameAsk + owed.block, STATUS_TIMEOUT_MS,
    )).trim();
    if (owed.listed.length) await applyOwedAnswer(taskId, owed.listed, answer);
    const report = readStatusReport(answer);
    if (!report) {
      log.session.warn('status question: no status in the answer', { sessionId, taskId, why, head: answer.slice(0, 200) });
      return false;
    }
    stored = await applyStatusAnswer(taskId, sessionId, report, turnEndedMs, { midTurn: why === 'watch' && sessionRunner.isTurnRunning(sessionId) });
    log.session.info('status question answered', { sessionId, taskId, why, state: report.state, elapsedMs: Date.now() - askedAt });
    return stored;
  } catch (err) {
    log.session.warn('status question failed', { sessionId, taskId, why, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - askedAt });
    return false;
  } finally {
    inFlight.delete(sessionId);
    flightEnds.delete(sessionId);
    ended();
    const next = rerun.get(sessionId);
    rerun.delete(sessionId);
    if (next && !timers.has(sessionId)) {
      void askStatus(next.taskId, sessionId, next.turnEndedMs);
    } else if (!timers.has(sessionId)) {
      // A turn-end ask that stored nothing hands the status back to the summary.
      if (why === 'turn-end' && owned.get(sessionId) === 'armed') owned.set(sessionId, stored ? 'answered' : 'failed');
      setReportPending(sessionId, false);
    }
  }
}

/** A turn ended: ask once it stays quiet. Returns false when this session's status is not ours. */
export async function armStatusQuestion(taskId: string, sessionId: string, turnEndedMs = Date.now()): Promise<boolean> {
  if (await routerScopedStatus(taskId, sessionId)) {
    cancelStatusQuestion(sessionId);
    if (owned.size > 2000) owned.clear();
    owned.set(sessionId, 'answered');
    return true;
  }
  if (!(await askableSession(sessionId).catch(() => false))) {
    // Not askable this turn (an ACP engine, or a runner that lost it): the summary asks.
    owned.delete(sessionId);
    return false;
  }
  if (owned.size > 2000) owned.clear();
  owned.set(sessionId, 'armed');
  cancelStatusQuestion(sessionId, false);
  const fire = (): void => {
    timers.delete(sessionId);
    void (async () => {
      // A turn started since (a peer's message, a trigger, the CLI's follow-up): its own end
      // arms the ask again, and this one would read words from the middle of it.
      const { sessionRunner } = await import('../../providers/claude-code-session.js');
      if (sessionRunner.isTurnRunning(sessionId)) {
        if (!timers.has(sessionId) && !inFlight.has(sessionId)) setReportPending(sessionId, false);
        return;
      }
      await askStatus(taskId, sessionId, turnEndedMs);
    })().catch(() => {});
  };
  const timer = setTimeout(fire, STATUS_SETTLE_MS);
  timer.unref?.();
  timers.set(sessionId, timer);
  setReportPending(sessionId, true);
  return true;
}

/** A new turn started (or a person wrote): this turn end was not the end. */
export function cancelStatusQuestion(sessionId: string, clearPending = true): void {
  const t = timers.get(sessionId);
  if (t) clearTimeout(t);
  timers.delete(sessionId);
  if (clearPending && !inFlight.has(sessionId)) setReportPending(sessionId, false);
}

/**
 * An engine switch is about to stop `sessionId`: no question is asked of it any more, and one in
 * flight is let finish first (bounded). An ACP engine asks in the provider's own thread, so a
 * question cut by the stop stayed there unanswered, and the session resumed on a switch back
 * answered it into the chat (2026-11-05: FOR_USER lines in a Pi reply).
 */
export async function settleStatusQuestion(sessionId: string, maxMs = 20_000): Promise<void> {
  cancelStatusQuestion(sessionId);
  rerun.delete(sessionId);
  const flight = flightEnds.get(sessionId);
  if (!flight) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([flight, new Promise<void>((r) => { timer = setTimeout(r, maxMs); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
}

/** Test-only. */
export function __resetStatusQuestion(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  inFlight.clear();
  flightEnds.clear();
  rerun.clear();
  owned.clear();
}
