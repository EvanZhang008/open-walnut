/**
 * The ONE status the user sees for a task (2026-10-25, the user: "I don't even know what
 * needs me, what not, and what exactly it is waiting for"). Four states, the same on the
 * Board, the Org page, the task list and the phone:
 *
 *   needs    Needs you: only something the user alone can give (a decision, an approval,
 *            an answer). Always says what to do.
 *   working  Working: its session is running a turn right now.
 *   waiting  Waiting: not running, and says on whom or what (another task, a time, this
 *            machine, the user with no rush, its lead, not started yet). Nothing to wait
 *            on while it says it would carry on is `stuck`, still a kind of waiting.
 *   done     Done: the task is complete.
 *
 * Internal states stay as they are (phase, process status, tiers, board project status);
 * only this is shown. NEED_ACTION is NOT "needs you": every turn end sets it.
 *
 * Inputs are facts first (the phase, a live prompt, an unanswered letter or board choice,
 * the running flag, pending reply requests, armed triggers, `wait_until`), then the
 * session's own plain-words report from its last turn (`task.status_report`, written by
 * the turn-complete self-report). Facts win over the report: a report that says
 * "working" on a session that has stopped and that nothing will wake is `stuck`.
 *
 * Pure and browser-safe: the server (org counts, API payloads) and the web app import it.
 */

export type UserState = 'needs' | 'working' | 'waiting' | 'done';

/** On what a waiting task waits. */
export type WaitKind = 'task' | 'time' | 'machine' | 'you' | 'lead' | 'not-started' | 'stuck' | 'other';

export const USER_STATES: readonly UserState[] = ['needs', 'working', 'waiting', 'done'];

export const USER_STATE_LABELS: Record<UserState, string> = {
  needs: 'Needs you', working: 'Working', waiting: 'Waiting', done: 'Done',
};

/** The session's own report of its last turn, in the user's words (self-report FOR_USER_*). */
export interface StatusReport {
  state?: UserState;
  /** needs: the one thing the user must decide or do. */
  ask?: string;
  waiting_kind?: WaitKind;
  /** waiting: on what exactly. */
  waiting_on?: string;
  /** Where the work stands, one sentence. */
  now?: string;
  /** Who does what next, one sentence. */
  next?: string;
  /** When the session wrote it (ISO). */
  at: string;
}

/** The facts a status is derived from. Everything optional: a missing fact never invents a state. */
export interface UserStatusInput {
  phase?: string;
  /** Legacy `status: 'done'` rows. */
  status?: string;
  /** The task has (or had) a session. */
  hasSession?: boolean;
  /** Its session's process status (running / idle / stopped / error). */
  processStatus?: string;
  errorMessage?: string | null;
  /** Why its session stopped (SessionRecord.status_reason): a lost host is Walnut's to recover. */
  errorReason?: string | null;
  /** When its session's status last moved (ISO). */
  statusSince?: string | null;
  /** A live permission prompt or question the session is blocked on. */
  pendingPermissionTool?: string | null;
  /** An unanswered action_required letter this task sent (its subject). */
  openLetter?: string | null;
  /** An unanswered Board choice about this task (its title). */
  openChoice?: string | null;
  /** Titles of tasks this task's session waits on for a reply. */
  waitingOnTasks?: readonly string[];
  /** Armed triggers that will wake this task (their names). */
  triggers?: readonly string[];
  /** Enabled scheduled routines that run in this task's session, with their next run (ISO). */
  schedules?: readonly { name: string; nextAt?: string | null }[];
  waitUntil?: string | null;
  /** The task has a leader (a parent task). */
  hasLeader?: boolean;
  /** Its open subtasks: their news (a completion, an error) wakes it. */
  openWorkers?: number;
  /** Main (org_role 'main'): the user's next message or a team's news wakes it, never a timer. */
  isMain?: boolean;
  /** When the phase last moved (a turn's end, a park). A report older than this was written
   *  before the latest turn and only lends its words, never the state. */
  phaseChangedAt?: string | null;
  report?: StatusReport | null;
}

export interface UserStatus {
  state: UserState;
  /** waiting only. */
  kind?: WaitKind;
  /** needs: what the user must do. */
  ask?: string;
  /** needs: where the ask lives, so a surface can take the user there: a prompt in the
   *  session, a letter in the inbox, a choice on the Board, a failed session, or the
   *  session's own question at the end of its turn. */
  source?: 'prompt' | 'letter' | 'choice' | 'error' | 'session';
  /** waiting: on whom or what, in words. */
  waitingOn?: string;
  now?: string;
  next?: string;
  /** waiting: when it next checks by itself (its wait_until, ISO), for the UI to format. */
  until?: string;
  /** When `now`/`next` were written (ISO). */
  at?: string;
  /** The words are a day or more old while the task is not running. */
  stale?: boolean;
}

/** Session stops a host outage causes; Walnut resumes those itself. */
const HOST_LOST_REASONS = new Set(['remote_unreachable', 'spawn_outcome_unknown', 'liveness_check_failed']);
/** How long a lost host stays Walnut's to recover before it is the user's (the Org digest's rule). */
const HOST_LOST_GRACE_MS = 20 * 60_000;

/** A report older than this, on a task that is not running, is flagged as old. */
export const STALE_REPORT_MS = 24 * 60 * 60_000;

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const none = (s: string | null | undefined): boolean => {
  const v = clean(s).toLowerCase();
  return !v || v === 'none' || v === 'n/a' || v === '-' || v === 'unchanged';
};

function words(report: StatusReport | null | undefined, nowMs: number, running: boolean) {
  if (!report) return {};
  const at = report.at;
  const age = nowMs - Date.parse(at);
  return {
    now: none(report.now) ? undefined : clean(report.now),
    next: none(report.next) ? undefined : clean(report.next),
    at,
    stale: !running && Number.isFinite(age) && age >= STALE_REPORT_MS ? true : undefined,
  };
}

function strip<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** Slack for clocks: the phase write and the report stamp come from different processes. */
const REPORT_CLOCK_SLACK_MS = 5_000;

export function deriveUserStatus(input: UserStatusInput, nowMs: number = Date.now()): UserStatus {
  const out = derive(input, nowMs);
  // A waiting task names when it checks again by itself, whatever it waits on.
  if (out.state === 'waiting' && !out.until && input.waitUntil && Date.parse(input.waitUntil) > nowMs) out.until = input.waitUntil;
  return out;
}

function derive(input: UserStatusInput, nowMs: number): UserStatus {
  const anyReport = input.report ?? null;
  if (input.phase === 'COMPLETE' || input.status === 'done') return { state: 'done' };

  const running = input.processStatus === 'running' && !input.pendingPermissionTool;
  const w = words(anyReport, nowMs, running);
  const movedAt = input.phaseChangedAt ? Date.parse(input.phaseChangedAt) : NaN;
  const current = !!anyReport && (!Number.isFinite(movedAt) || Date.parse(anyReport.at) >= movedAt - REPORT_CLOCK_SLACK_MS);
  // Only a report of the latest turn says what state the task is in.
  const report = current ? anyReport : null;

  // Facts that mean the user alone can move it.
  if (input.pendingPermissionTool) {
    return strip({ state: 'needs', source: 'prompt', ask: `Answer the ${input.pendingPermissionTool} prompt in its session.`, ...w, stale: undefined });
  }
  if (!none(input.openLetter)) return strip({ state: 'needs', source: 'letter', ask: clean(input.openLetter), ...w });
  if (!none(input.openChoice)) return strip({ state: 'needs', source: 'choice', ask: clean(input.openChoice), ...w });

  if (running) return strip({ state: 'working', ...w });

  // Something named will move it (computed before an old error: a trigger or a clock outlives one).
  const tasks = (input.waitingOnTasks ?? []).map(clean).filter(Boolean);
  const triggers = (input.triggers ?? []).map(clean).filter(Boolean);
  const schedules = (input.schedules ?? []).filter((r) => clean(r.name));
  const until = input.waitUntil && Date.parse(input.waitUntil) > nowMs ? input.waitUntil : null;
  const wakes = triggers.length > 0 || schedules.length > 0 || !!until;

  if (input.processStatus === 'error' && !wakes) {
    // A lost host is Walnut's to recover (auto-resume) for a while, then the user's.
    const since = input.statusSince ? Date.parse(input.statusSince) : NaN;
    const lostFor = Number.isFinite(since) ? nowMs - since : 0;
    if (input.errorReason && HOST_LOST_REASONS.has(input.errorReason) && lostFor < HOST_LOST_GRACE_MS) {
      return strip({ state: 'waiting', kind: 'machine', waitingOn: 'Its host to come back (Walnut reconnects by itself)', ...w });
    }
    const why = clean(input.errorMessage);
    return strip({ state: 'needs', source: 'error', ask: why ? `Its session failed (${why.slice(0, 140)}). Retry it or open it.` : 'Its session failed. Retry it or open it.', ...w });
  }

  // The session's own words: an ask only the user can answer. Not on a standing routine (a watch
  // or a schedule keeps it alive): it asks people where it works, and its turn's end is never the
  // user's to pick up (2026-10-26, the user on a pipeline watch: "put it as working").
  if (report?.state === 'needs' && !none(report.ask) && !(triggers.length || schedules.length)) {
    return strip({ state: 'needs', source: 'session', ask: clean(report.ask), ...w });
  }
  // It said it carries on by itself (a background job it started will wake it) and its process is still there.
  if (report?.state === 'working' && input.processStatus === 'idle') return strip({ state: 'working', ...w });

  // No session: a person works it by hand (in progress) or it has not started.
  if (input.phase === 'IN_PROGRESS' && !input.hasSession) return strip({ state: 'working', ...w });
  if (input.phase === 'TODO' && !input.hasSession) {
    return strip({ state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet', ...w });
  }

  const reported = report?.state === 'waiting' && !none(report.waiting_on) ? clean(report.waiting_on) : '';
  const reportedKind = report?.state === 'waiting' ? report.waiting_kind : undefined;

  if (tasks.length) {
    return strip({ state: 'waiting', kind: 'task', waitingOn: reported || `A reply from ${tasks.join(', ')}`, ...w });
  }
  if (reported && reportedKind && reportedKind !== 'stuck') {
    // A report naming a wait counts only while something can still end it, or it waits on a person.
    const person = reportedKind === 'you' || reportedKind === 'lead' || reportedKind === 'task';
    if (person || wakes) return strip({ state: 'waiting', kind: reportedKind, waitingOn: reported, ...(until ? { until } : {}), ...w });
  }
  // A standing routine: between fires it waits on the next one, whatever its last turn said.
  if (triggers.length) return strip({ state: 'waiting', kind: 'other', waitingOn: `A watch: ${triggers.join(', ')}`, ...w });
  if (schedules.length) {
    const next = schedules.map((r) => r.nextAt).filter((t): t is string => !!t && Date.parse(t) > nowMs).sort()[0];
    return strip({ state: 'waiting', kind: 'time', waitingOn: `Its next scheduled run (${schedules.map((r) => clean(r.name)).join(', ')})`, ...(next ? { until: next } : {}), ...w });
  }
  if (report?.state === 'done') {
    return strip({
      state: 'waiting', kind: input.hasLeader ? 'lead' : 'you',
      waitingOn: input.hasLeader ? 'Its lead, to check the result and close it' : 'You, to read the result and close it (no rush)',
      ...w,
    });
  }
  if (until) return strip({ state: 'waiting', kind: 'time', waitingOn: 'Its next check', until, ...w });

  if (input.phase === 'WAITING' && !report) {
    return strip({ state: 'waiting', kind: 'other', waitingOn: 'A message (parked with no clock or watch)', ...w });
  }

  // Something outside will wake it: Main hears the user and its teams, a lead hears its workers.
  if (input.isMain) return strip({ state: 'waiting', kind: 'you', waitingOn: 'Your next message, or news from its teams', ...w });
  if ((input.openWorkers ?? 0) > 0) {
    const n = input.openWorkers!;
    return strip({ state: 'waiting', kind: 'task', waitingOn: n === 1 ? 'Its worker (1 open)' : `Its workers (${n} open)`, ...w });
  }

  // Nothing will wake it. Stuck when it meant to carry on itself; otherwise its turn simply ended.
  const meantToContinue = report ? report.state === 'working' || reportedKind === 'stuck' || (report.state === 'waiting' && !!reported) : input.phase === 'IN_PROGRESS';
  if (meantToContinue && input.hasSession) {
    return strip({ state: 'waiting', kind: 'stuck', waitingOn: 'It stopped, and nothing will wake it', ...w });
  }
  return strip({
    state: 'waiting', kind: input.hasLeader ? 'lead' : 'you',
    waitingOn: input.hasLeader ? 'Its lead, to read the latest turn' : 'You, to read the latest turn (no rush)',
    ...w,
  });
}

/** The state of a task the server has not derived yet (an older server, a row before the
 *  first pass): the phase alone, as an older Walnut meant it (NEED_ACTION was "handed back
 *  to you"), the same on every surface: the web task rows (taskNeedsAction), the Board's
 *  chips, the Org counts and iOS (TeamStatusModel.state, BoardModel.needsHuman). The
 *  server derives every open task within seconds of boot, so this rarely shows. */
export function fallbackUserState(phase: string | undefined, status?: string): UserState {
  if (phase === 'COMPLETE' || status === 'done') return 'done';
  if (phase === 'NEED_ACTION') return 'needs';
  return phase === 'IN_PROGRESS' ? 'working' : 'waiting';
}

export interface UserStatusCounts { needs: number; working: number; waiting: number; done: number }

export function countUserStates(statuses: Iterable<Pick<UserStatus, 'state'>>): UserStatusCounts {
  const c: UserStatusCounts = { needs: 0, working: 0, waiting: 0, done: 0 };
  for (const s of statuses) c[s.state] += 1;
  return c;
}

/** "2 need you · 10 working · 16 waiting · 12 done", the one line every surface prints. */
export function userStatusLine(c: UserStatusCounts, opts: { withDone?: boolean } = {}): string {
  const parts = [`${c.needs} ${c.needs === 1 ? 'needs' : 'need'} you`, `${c.working} working`, `${c.waiting} waiting`];
  if (opts.withDone !== false) parts.push(`${c.done} done`);
  return parts.join(' · ');
}
