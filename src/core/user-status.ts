/**
 * The ONE status the user sees for a task (2026-10-25, the user: "I don't even know what
 * needs me, what not, and what exactly it is waiting for"). Four states, the same on the
 * Board, the Org page, the task list and the phone:
 *
 *   needs    Needs you: the task's phase is NEED_ACTION (or a live prompt blocks on the user).
 *            Always says what to do: the prompt, the letter, the Board choice, the failure, or
 *            the session's own ask.
 *   working  Working: IN_PROGRESS with its session running a turn (or worked by hand).
 *   waiting  Waiting: WAITING or TODO, or IN_PROGRESS with nothing running, and says on whom or
 *            what (another task, a time, a watch, this machine, its lead, not started yet);
 *            `stuck` when it was in progress and nothing will wake it.
 *   done     Done: COMPLETE.
 *
 * The state is the task's own phase, never a guess that can contradict it (2026-10-26: one
 * surface counted 5 "need you" while the tasks' phases said 1, from letters, Board choices and
 * reports read on their own). The task keeps its phase right itself: its turn's own report moves
 * it (session-hooks/builtins.ts), a standing routine goes back to WAITING at its turn's end
 * (phase.ts), its leader or the user may set it, and an answer is a message, which starts a turn.
 * The facts and the session's report (`task.status_report`) only give the words.
 *
 * Pure and browser-safe: the server (org counts, API payloads) and the web app import it.
 */

import { infraStopCause } from './session-error-kind.js';
import { startDateMs } from './snooze.js';

export type UserState = 'needs' | 'working' | 'waiting' | 'done';

/** On what a waiting task waits. `outside`: a pipeline, a build, a deploy, a review, a reply from outside Walnut. */
export type WaitKind = 'task' | 'time' | 'machine' | 'outside' | 'you' | 'lead' | 'not-started' | 'stuck' | 'other';

export const USER_STATES: readonly UserState[] = ['needs', 'working', 'waiting', 'done'];

/** The report kinds that name a wait outside the user by themselves (sessions/outside-wait.ts). */
export const OUTSIDE_WAIT_KINDS: ReadonlySet<WaitKind> = new Set<WaitKind>(['task', 'lead', 'machine', 'outside']);

/** The words a wait on the user starts with: "you: ...", "the user to paste ...", "your call". */
const ON_USER_RE = /^\s*(?:(?:waiting\s+)?(?:on|for)\s+)?(?:you|your|user|the user)(?:'s)?(?![\w-])/i;
/** The kind prefix alone ("you: ...", "user: ..."): what overrides a kind that names an outside wait. */
const ON_USER_PREFIX_RE = /^\s*(?:you|user|the user)\s*[:\uff1a]/i;

/**
 * Whether wait words say the wait is on the user. Pure. `strict`: only the "you:" / "user:"
 * prefix counts, for words under a kind that names an outside wait ("outside: your PR's CI run").
 */
export function waitWordsNameUser(words: string | null | undefined, strict = false): boolean {
  return (strict ? ON_USER_PREFIX_RE : ON_USER_RE).test(words ?? '');
}

/** A waiting report whose wait is the user's to end: on them, or on nothing it names outside. */
function waitIsUsers(report: StatusReport | null | undefined): boolean {
  if (report?.state !== 'waiting') return false;
  const kind = report.waiting_kind;
  if (kind && OUTSIDE_WAIT_KINDS.has(kind)) return waitWordsNameUser(report.waiting_on, true);
  return true;
}

/** The four names a person reads, the same on every surface (2026-10-30, the user: "we make the
 *  whole system's naming clear ... the same everywhere ... four small tabs"). No other words for them:
 *  not "need you", "needs me", "handed back" or "stuck" as a state. */
export const USER_STATE_LABELS: Record<UserState, string> = {
  needs: 'Needs you', working: 'Working', waiting: 'Waiting / snoozed', done: 'Completed',
};

/**
 * The one word for a state in text an agent reads about one task (a status push, the subtask
 * count): "Snoozed" or "Waiting", never the people's tab name "Waiting / snoozed".
 */
export function stateWord(state: UserState, snoozed = false): string {
  if (state !== 'waiting') return USER_STATE_LABELS[state];
  return snoozed ? 'Snoozed' : 'Waiting';
}

/** What each name means, in one plain line (shown where a surface explains its tabs). */
export const USER_STATE_MEANINGS: Record<UserState, string> = {
  needs: 'The next move is yours (an answer, a review, a decision), and it is not snoozed.',
  working: 'A turn is running, or it carries on by itself.',
  waiting: 'It waits on something outside you (a build, a review, another task, a time), or you snoozed it; until when is shown.',
  done: 'Finished.',
};

/** A count in those names: "3 Needs you", "8 Working", "2 Waiting / snoozed", "5 Completed". */
export function stateCountLabel(state: UserState, n: number): string {
  return `${n} ${USER_STATE_LABELS[state]}`;
}

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
  /** When the turn it reports on ended (ISO); absent on a report an older Walnut stored. */
  turn_ended_at?: string;
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
  /** Its session's error class (SessionRecord.errorKind): 'infra' = the machine's, not the work's. */
  errorKind?: string | null;
  /** A restart killed its session (SessionRecord.restartLoss): only a loss of its current death
   *  that recovery still holds (queued, sent) or gave up on; the sync drops every other. */
  restartLoss?: { state: string; cause?: string } | null;
  /** Its project has an open lead (a VP), who restarts what Walnut could not. */
  projectLead?: boolean;
  /** A message to its session was parked, never delivered, since the phase last moved: the reason. */
  undeliveredMessage?: string | null;
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
  /** A lead (org_role 'lead'): like Main, never closed. */
  isLead?: boolean;
  /** When the phase last moved (a turn's end, a park). A report older than this was written
   *  before the latest turn and only lends its words, never the state. */
  phaseChangedAt?: string | null;
  report?: StatusReport | null;
  /** Its session's turn-end report is still to come (sessions/report-pending.ts). */
  reportPending?: boolean;
  /** Task.due_date: a date (YYYY-MM-DD, the end of that day here) or a full ISO time. */
  dueDate?: string | null;
  /** When its team was stopped in one step, not resumed since (Task.team_stop on its team's root). */
  teamStoppedAt?: string | null;
  /** When an armed trigger of the task last ran its check (ISO): shown, never counted as a check. */
  checkRanAt?: string | null;
  /** The start date it is snoozed until, while that is still to come (snooze.ts snoozedUntil). */
  snoozedUntil?: string | null;
}

/** 2026-10-27, the user: "If the task is closed, mostly close by me means I already verified ...
 *  this is generic rules". Every agent-facing text that lists or reports tasks says it. */
/** The ask of a task handed back only because its turn ended, with nothing asked of its own
 *  (user-status-sync.ts holds it a moment: the next turn often starts within seconds). */
export const HANDED_BACK_ASK = 'Its turn ended and handed the task back to you: read it and reply.';
export const COMPLETE_IS_VERIFIED = 'A COMPLETE task counts as verified by the user: write it as done, never as waiting on their check or test, and never remind them of it.';

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
  /** The machine stopped it (a lost host, a restart, a dead process), not its work: Walnut
   *  resumes it, its lead restarts it when Walnut cannot (machineStop). */
  stoppedBy?: 'machine';
  /** Its due date has passed (`overdue`) or comes within a day (`soon`); absent otherwise
   *  (2026-10-28, the Grok Bot study: deadlines in the status). `at` is the due date as set. */
  due?: { at: string; state: 'overdue' | 'soon' };
  /** needs from its own session: when the session last confirmed the ask (ISO), at a turn end.
   *  Every other needs is Walnut's live record (a prompt, a letter, a choice, an error) and
   *  carries none. `checkedBy` is always `session` (kept for a client that reads it). */
  checkedAt?: string;
  checkedBy?: 'session' | 'check';
  /** When an armed trigger of the task last ran (ISO, to 10 minutes): it watches the task, which
   *  is not proof this ask still holds, so it never counts as a check. */
  watchedAt?: string;
  /** needs from its session, confirmed by the session longer ago than UNVERIFIED_AFTER_MS:
   *  the user may have done it outside Walnut, so it reads "not verified", never as fact
   *  (2026-10-28, the user: "I've already resolved some of these. You should at least verify"). */
  unverified?: boolean;
  /** Between a turn's end and its report (sessions/report-pending.ts): the report decides the
   *  status in a moment, so a change into this is no news (sessions/status-push.ts). */
  transient?: boolean;
  /** Snoozed by its start date (snooze.ts): `until` as set, and the ask it would make of the user
   *  now, which no surface raises until then. Absent on a task that is not snoozed. */
  snoozed?: { until: string; ask?: string };
}

/** "2 hours ago", "3 days ago". */
export function agoWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.round(h / 24)} days ago`;
}

/** The words every surface prints under a session's "needs you": when it was last checked, or
 *  that it is not verified. Null for Walnut's own live records (a prompt, a letter, a choice). */
export function checkedLine(s: Pick<UserStatus, 'state' | 'source' | 'checkedAt' | 'watchedAt' | 'unverified'> | null | undefined, nowMs: number = Date.now()): { text: string; unverified: boolean } | null {
  if (s?.state !== 'needs' || s.source !== 'session') return null;
  const at = Date.parse(s.checkedAt ?? '');
  if (!Number.isFinite(at)) return null;
  const ran = Date.parse(s.watchedAt ?? '');
  const watched = Number.isFinite(ran) ? `; its trigger ran ${agoWords(nowMs - ran)}` : '';
  if (s.unverified) return { text: `Not verified: last checked ${agoWords(nowMs - at)}, may be done already${watched}`, unverified: true };
  return { text: `Checked ${agoWords(nowMs - at)}${watched}`, unverified: false };
}

/** A session's "needs you" is asked again after this (sessions/needs-recheck.ts). A test server
 *  shortens it with WALNUT_NEEDS_RECHECK_MS (a minute at least); the browser reads none. */
const recheckEnv = typeof process !== 'undefined' ? Number(process.env?.WALNUT_NEEDS_RECHECK_MS) : NaN;
export const NEEDS_RECHECK_MS = Number.isFinite(recheckEnv) && recheckEnv >= 60_000 ? recheckEnv : 4 * 60 * 60_000;
/** ...and reads as not verified once it went this long unconfirmed (the re-check had its turn). */
export const UNVERIFIED_AFTER_MS = NEEDS_RECHECK_MS + Math.min(30 * 60_000, NEEDS_RECHECK_MS / 8);

/** A due date's deadline in ms: a bare date means the end of that day, in this process's zone. */
export function dueAtMs(due: string | null | undefined): number {
  const v = (due ?? '').trim();
  if (!v) return NaN;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T23:59:59.999`) : Date.parse(v);
}

/** Within this much of its due date a task reads "due soon". */
export const DUE_SOON_MS = 24 * 60 * 60_000;

/** Overdue, due soon, or nothing to say. */
export function dueStatus(due: string | null | undefined, nowMs: number): UserStatus['due'] | undefined {
  const at = dueAtMs(due);
  if (!Number.isFinite(at)) return undefined;
  if (at < nowMs) return { at: due!.trim(), state: 'overdue' };
  if (at - nowMs <= DUE_SOON_MS) return { at: due!.trim(), state: 'soon' };
  return undefined;
}

/** What a restart that killed a session was, in words. */
const RESTART_WORDS: Record<string, string> = {
  machine_reboot: 'this computer restarted', server_restart: 'Walnut restarted', host_restart: 'its host restarted',
};

/**
 * Stopped by the machine, not by the work (2026-10-28: a full disk, a restart and an SSH drop put
 * tasks under "Needs the user now"). Walnut resumes such a task itself once the cause clears, and
 * its lead restarts it when Walnut cannot; only what neither can fix reaches the user. Read from
 * the session record's structured facts only (errorKind, status_reason, restartLoss), never text.
 */
function machineStop(input: UserStatusInput, w: ReturnType<typeof words>, nowMs: number): UserStatus | null {
  // The sync passes only a loss of the session's CURRENT death (user-status-sync.ts liveRestartLoss).
  const loss = input.restartLoss;
  const live = input.processStatus === 'running' || input.processStatus === 'idle';
  const owner = input.hasLeader || input.projectLead;
  const parked = input.phase === 'WAITING';
  if (loss && !live) {
    const after = RESTART_WORDS[loss.cause ?? ''] ?? 'a restart';
    if (loss.state === 'queued' || loss.state === 'sent') {
      return strip<UserStatus>({ state: 'waiting', kind: 'machine', waitingOn: `Walnut, resuming it after ${after}`, ...w, stoppedBy: 'machine' });
    }
    if (loss.state === 'gave_up') {
      return owner
        ? strip<UserStatus>({ state: 'waiting', kind: 'lead', waitingOn: `Its lead, to restart it: Walnut could not resume it after ${after}`, ...w, stoppedBy: 'machine' })
        : strip<UserStatus>({ state: 'needs', source: 'error', ask: `Walnut could not resume it after ${after}. Restart it or open it.`, ...w, stoppedBy: 'machine' });
    }
  }
  const cause = infraStopCause(input);
  // A parked task needs no process: only a lost host (whose daemon runs its watches) stops its wait.
  if (!cause || (parked && cause !== 'host')) return null;
  // A day gone is no longer a blip Walnut rides out: its lead, else the user, looks at it.
  const since = input.statusSince ? Date.parse(input.statusSince) : NaN;
  if (Number.isFinite(since) && nowMs - since >= MACHINE_STOP_ESCALATE_MS) {
    const what = cause === 'host' ? 'Its host has been unreachable' : 'It has been stopped by the machine';
    return owner
      ? strip<UserStatus>({ state: 'waiting', kind: 'lead', waitingOn: `Its lead, to check it: ${what.toLowerCase()} for a day`, ...w, stoppedBy: 'machine' })
      : strip<UserStatus>({ state: 'needs', source: 'error', ask: `${what} for a day. Check the host, or restart it elsewhere.`, ...w, stoppedBy: 'machine' });
  }
  const who = owner ? ', and its lead restarts it if that fails' : '';
  const waitingOn = cause === 'host' ? `Its host to come back: Walnut reconnects and resumes it by itself${who}`
    : cause === 'restart' ? `Walnut, resuming it after Walnut restarted${who}`
      : `Walnut, resuming it after its process stopped under it${who}`;
  return strip<UserStatus>({ state: 'waiting', kind: 'machine', waitingOn, ...w, stoppedBy: 'machine' });
}

/** A machine stop standing this long goes to its lead (or the user when it has none). */
export const MACHINE_STOP_ESCALATE_MS = 24 * 60 * 60_000;

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

/** Whether the stored report is of the latest turn: written after the phase last moved. */
export function reportIsCurrent(input: Pick<UserStatusInput, 'report' | 'phaseChangedAt'>): boolean {
  const r = input.report;
  if (!r) return false;
  const movedAt = input.phaseChangedAt ? Date.parse(input.phaseChangedAt) : NaN;
  return !Number.isFinite(movedAt) || Date.parse(r.at) >= movedAt - REPORT_CLOCK_SLACK_MS;
}

export function deriveUserStatus(input: UserStatusInput, nowMs: number = Date.now()): UserStatus {
  const derived = derive(input, nowMs);
  const out = snoozeOf(input, derived, nowMs) ?? derived;
  if (out.state !== 'done' && !out.snoozed) {
    const due = dueStatus(input.dueDate, nowMs);
    if (due) out.due = due;
  }
  // A waiting task names when it checks again by itself, whatever it waits on.
  if (out.state === 'waiting' && !out.until && input.waitUntil && Date.parse(input.waitUntil) > nowMs) out.until = input.waitUntil;
  // Only an ask the session itself wrote can be checked again; Walnut's own "its turn ended and
  // handed it back" is no claim about the world.
  if (out.state === 'needs' && out.source === 'session' && out.ask && out.ask === reportAsk(input.report)) stampChecked(out, input, nowMs);
  return out;
}

/**
 * A snoozed task asks nothing of the user until its start date (snooze.ts, 2026-10-30): a status that
 * would ask them (Needs you, or a wait on them) reads Waiting until that date, keeping the ask for the
 * Brief's snoozed list; any other status only carries the mark. Working, Done and a live prompt are
 * as they are, and Main is never snoozed (its Needs you is the user's turn to talk). A session's own
 * report cannot undo it; only a letter with a stated reason raises the task (letter-ops.ts). Null
 * when not snoozed.
 */
function snoozeOf(input: UserStatusInput, s: UserStatus, nowMs: number): UserStatus | null {
  const until = clean(input.snoozedUntil);
  if (!until || s.state === 'done' || s.state === 'working' || input.isMain) return null;
  const startMs = startDateMs(until);
  if (!Number.isFinite(startMs) || startMs <= nowMs) return null;
  // A live prompt blocks a turn someone started now: the user answers it, snoozed or not.
  const onUser = (s.state === 'needs' && s.source !== 'prompt') || (s.state === 'waiting' && s.kind === 'you');
  if (!onUser) return { ...s, snoozed: { until } };
  const ask = s.state === 'needs' ? s.ask : s.waitingOn;
  return strip<UserStatus>({
    state: 'waiting', kind: 'time', waitingOn: `Snoozed until ${until}`, until: new Date(startMs).toISOString(),
    now: s.now, next: s.next, at: s.at, stale: s.stale,
    snoozed: { until, ...(ask && ask !== HANDED_BACK_ASK ? { ask } : {}) },
  });
}

/** The ask a report makes of the user, in the words derive() shows. */
function reportAsk(report: StatusReport | null | undefined): string | undefined {
  if (report?.state === 'needs' && !none(report.ask)) return clean(report.ask);
  if (waitIsUsers(report) && !none(report!.waiting_on)) return clean(report!.waiting_on);
  return undefined;
}

/** When a session's ask was last confirmed, by whom, and whether that is too long ago to be fact. */
function stampChecked(out: UserStatus, input: UserStatusInput, nowMs: number): void {
  // Its last word on it: the newest of its report and its last phase move (a turn's end).
  const at = Math.max(...[input.report?.at, input.phaseChangedAt].map((v) => Date.parse(v ?? '')).filter(Number.isFinite));
  if (!Number.isFinite(at)) return;
  out.checkedAt = new Date(at).toISOString();
  out.checkedBy = 'session';
  // A trigger of the task watches the task, not necessarily this ask (2026-10-28: a reminder to
  // call someone carried a mail trigger): shown beside it, never a check of its own.
  const ran = Date.parse(input.checkRanAt ?? '');
  if (Number.isFinite(ran)) out.watchedAt = new Date(ran).toISOString();
  if (nowMs - at > UNVERIFIED_AFTER_MS) out.unverified = true;
}

/**
 * What will wake a task whose turn is over: an armed trigger of its own (a fire resumes a stopped
 * session), else, with `schedules`, a scheduled routine that runs in its session. Null when
 * nothing will. 2026-10-29: a task parked on two armed triggers read "stuck, nothing will wake
 * it" in the seconds between its turn's end and the phase write, and was pushed to Main so.
 */
function wakeSource(input: UserStatusInput, w: ReturnType<typeof words>, nowMs: number, schedules: boolean): UserStatus | null {
  const triggers = (input.triggers ?? []).map(clean).filter(Boolean);
  if (triggers.length) return strip<UserStatus>({ state: 'waiting', kind: 'other', waitingOn: `A watch: ${triggers.join(', ')}`, ...w });
  const runs = schedules ? (input.schedules ?? []).filter((r) => clean(r.name)) : [];
  if (!runs.length) return null;
  const next = runs.map((r) => r.nextAt).filter((t): t is string => !!t && Date.parse(t) > nowMs).sort()[0];
  return strip<UserStatus>({ state: 'waiting', kind: 'time', waitingOn: `Its next scheduled run (${runs.map((r) => clean(r.name)).join(', ')})`, ...(next ? { until: next } : {}), ...w });
}

function derive(input: UserStatusInput, nowMs: number): UserStatus {
  const anyReport = input.report ?? null;
  if (input.phase === 'COMPLETE' || input.status === 'done') return { state: 'done' };

  const running = input.processStatus === 'running' && !input.pendingPermissionTool;
  const w = words(anyReport, nowMs, running);
  // Only a report of the latest turn says what it is waiting on or asking.
  const report = reportIsCurrent(input) ? anyReport : null;
  // The machine stopped it: unless its own latest report asks the user something, it is Walnut's
  // and its lead's to bring back, not the user's.
  const asksUser = report?.state === 'needs' || (report?.state === 'waiting' && report.waiting_kind === 'you');
  const machine = asksUser ? null : machineStop(input, w, nowMs);

  // A live prompt blocks on the user (the session machine moves the phase to NEED_ACTION with it).
  if (input.pendingPermissionTool) {
    return strip({ state: 'needs', source: 'prompt', ask: `Answer the ${input.pendingPermissionTool} prompt in its session.`, ...w, stale: undefined });
  }

  // The state is the task's own phase (2026-10-26, the user: "this status need to be self updated
  // by task, can also be updated by leader ... task has status, we already have good task system").
  // The task sets it (its turn's own report moves it, session-hooks/builtins.ts), its leader or the
  // user may set it, and nothing here overrides it: what follows only says why, in words.
  if (input.phase === 'NEED_ACTION') {
    if (!none(input.openLetter)) return strip({ state: 'needs', source: 'letter', ask: clean(input.openLetter), ...w });
    if (!none(input.openChoice)) return strip({ state: 'needs', source: 'choice', ask: clean(input.openChoice), ...w });
    // A message that never reached the session: the cause is what the user fixes,
    // not a session that "failed" or a turn that ended (2026-10-28).
    if (!none(input.undeliveredMessage)) {
      const raw = clean(input.undeliveredMessage);
      // The user's own terminal holds the session: say that, not "failed" (2026-10-28).
      const terminal = /has this session open in a terminal right now \(([^)]*)\)/.exec(raw);
      if (terminal) {
        return strip({ state: 'needs', source: 'error', ask: `The user (or someone) has its session open in a terminal right now (${terminal[1].slice(0, 80)}), so a message to it waits. The task is fine; Retry it once that terminal is closed.`, ...w });
      }
      const why = raw.replace(/^Not delivered( yet)?:\s*/i, '');
      return strip({ state: 'needs', source: 'error', ask: `A message to it was not delivered: ${why.slice(0, 220)}`, ...w });
    }
    if (machine) return machine;
    // A machine stop under a turn that asked the user something: the ask is what they answer.
    if (input.processStatus === 'error' && !infraStopCause(input)) {
    const why = clean(input.errorMessage);
    return strip({ state: 'needs', source: 'error', ask: why ? `Its session failed (${why.slice(0, 140)}). Retry it or open it.` : 'Its session failed. Retry it or open it.', ...w });
  }
    // Its team was stopped in one step (sessions/team-stop.ts) and it ran no turn since: it waits
    // for the resume or a message, and says so, rather than reading as a session that stopped for
    // no reason. A report written after the stop is a turn of its own and speaks for itself.
    const stoppedAt = Date.parse(input.teamStoppedAt ?? '');
    if (Number.isFinite(stoppedAt) && !running && !asksUser && !(anyReport && Date.parse(anyReport.at) > stoppedAt)) {
      return strip({ state: 'waiting', kind: input.hasLeader ? 'lead' : 'you', waitingOn: 'Its team was stopped: Resume the team, or a message to it, starts it again', ...w });
    }
    if (report?.state === 'needs' && !none(report.ask)) return strip({ state: 'needs', source: 'session', ask: clean(report.ask), ...w });
    // A wait that is the user's (2026-10-30: "other: the meeting notes") is their ask, in its words.
    if (waitIsUsers(report) && !none(report!.waiting_on)) {
      return strip({ state: 'needs', source: 'session', ask: clean(report!.waiting_on), ...w });
    }
    // Handed back only because its turn ended (2026-10-27, the lead on the user's demo: a turn that
    // answered the user's question and only confirmed the plan read Needs you everywhere). Its own
    // report says done: nothing to answer, the user reads it and closes it when they like. A task
    // with a leader moves to WAITING on that report instead (report-phase.ts).
    if (report?.state === 'done') {
      // Main and a lead are never closed: they wait on the user's next message.
      if (input.isMain || input.isLead) return strip({ state: 'waiting', kind: 'you', waitingOn: 'Your next message, or news from its teams', ...w });
      return strip({
        state: 'waiting', kind: input.hasLeader ? 'lead' : 'you',
        waitingOn: input.hasLeader ? 'Its lead, to check the result and close it' : 'You, to read the result and close it (no rush)',
        ...w,
      });
    }
    // Its own armed trigger wakes it (a fire resumes a stopped session): with no ask of its own and no
    // turn running (a NEED_ACTION set inside a turn waits for that turn's report), it waits on the watch.
    // Not Main or a lead: they are never closed, and their NEED_ACTION is the user's turn to talk.
    const watch = running || input.isMain || input.isLead ? null : wakeSource(input, w, nowMs, false);
    // A worker whose session stopped (Walnut's idle reap, a stop) with no report of its own saying it
    // needs the user: its lead is the one to look (2026-10-27: a worker reaped while its tests ran read
    // Needs you everywhere). The reap still hands it back, so a reply its lead waits for is settled.
    if (!watch && input.hasLeader && !input.isLead && !input.isMain && input.processStatus === 'stopped') {
      return strip({ state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to look at it: its session stopped before it said it needs anything', ...w });
    }
    // Its turn just ended and its report is on the way: only that report can say it asks anything.
    if (input.reportPending) {
      return strip({ state: 'waiting', kind: 'other', waitingOn: 'Its report on the turn that just ended', ...w, transient: true });
    }
    if (watch) return watch;
    // No ask of its own (2026-10-31, the user on the CEO node's list: "u can show VP sure, but u need
    // to show what are actually waiting"): Needs you always carries a concrete ask. A worker whose
    // turn ended without one waits on its lead, idle or stopped; Main and a lead wait on the user's
    // next message (or their teams' news), and their node lists its tasks' asks, not itself.
    if (input.isMain || input.isLead) return strip({ state: 'waiting', kind: 'you', waitingOn: 'Your next message, or news from its teams', ...w });
    if (input.hasLeader) return strip({ state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to look at it: its turn ended without asking you anything', ...w });
    return strip({ state: 'needs', source: 'session', ask: HANDED_BACK_ASK, ...w });
  }

  if (input.phase === 'IN_PROGRESS') {
    if (running || !input.hasSession) return strip({ state: 'working', ...w });
    if (machine) return machine;
    // It said it carries on by itself (a background job it started will wake it) and its process is there.
    if (report?.state === 'working' && input.processStatus === 'idle') return strip({ state: 'working', ...w });
    // In progress with nothing running: on whom it waits, so no one reads "working" on an idle session.
    if (input.isMain) return strip({ state: 'waiting', kind: 'you', waitingOn: 'Your next message, or news from its teams', ...w });
    if ((input.openWorkers ?? 0) > 0) {
      const n = input.openWorkers!;
      return strip({ state: 'waiting', kind: 'task', waitingOn: n === 1 ? 'Its worker (1 open)' : `Its workers (${n} open)`, ...w });
    }
    // Not stuck while its own armed trigger or scheduled routine will wake it; a failed session
    // is still read as stuck, a watch never hides it.
    const wake = input.processStatus === 'error' ? null : wakeSource(input, w, nowMs, true);
    if (wake) return wake;
    return strip({ state: 'waiting', kind: 'stuck', waitingOn: 'It stopped, and nothing will wake it', ...w });
  }

  if (input.phase === 'TODO') return strip({ state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet', ...w });

  // WAITING (and any phase an older writer left): on what, from the facts first, then its words.
  const tasks = (input.waitingOnTasks ?? []).map(clean).filter(Boolean);
  const until = input.waitUntil && Date.parse(input.waitUntil) > nowMs ? input.waitUntil : null;
  const reported = report?.state === 'waiting' && !none(report.waiting_on) ? clean(report.waiting_on) : '';
  const reportedKind = report?.state === 'waiting' ? report.waiting_kind : undefined;
  if (machine) return machine;
  if (tasks.length) return strip({ state: 'waiting', kind: 'task', waitingOn: reported || `A reply from ${tasks.join(', ')}`, ...w });
  if (reported && reportedKind && reportedKind !== 'stuck') return strip({ state: 'waiting', kind: reportedKind, waitingOn: reported, ...(until ? { until } : {}), ...w });
  // A standing routine: between fires it waits on the next one.
  const wake = wakeSource(input, w, nowMs, true);
  if (wake) return wake;
  if (report?.state === 'done') {
    return strip({
      state: 'waiting', kind: input.hasLeader ? 'lead' : 'you',
      waitingOn: input.hasLeader ? 'Its lead, to check the result and close it' : 'You, to read the result and close it (no rush)',
      ...w,
    });
  }
  if (until) return strip({ state: 'waiting', kind: 'time', waitingOn: 'Its next check', until, ...w });
  if (input.phase === 'WAITING') return strip({ state: 'waiting', kind: 'other', waitingOn: 'A message (parked with no clock or watch)', ...w });
  return strip({ state: fallbackUserState(input.phase), ...w });
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

/** "2 Needs you · 10 Working · 16 Waiting / snoozed · 12 Completed", the one line every surface prints. */
export function userStatusLine(c: UserStatusCounts, opts: { withDone?: boolean } = {}): string {
  const parts = [stateCountLabel('needs', c.needs), stateCountLabel('working', c.working), stateCountLabel('waiting', c.waiting)];
  if (opts.withDone !== false) parts.push(stateCountLabel('done', c.done));
  return parts.join(' · ');
}

// ── The Brief (FOR_USER_BRIEF): Main's or a lead's short letter to the user ──

/** What the session wrote, and when (Task.brief). */
export interface TaskBrief {
  text: string;
  at: string;
  /** The lines that break the Brief's rules (sessions/brief-rules.ts), as Walnut found them. */
  issues?: Array<{ kind: 'no_task' | 'no_vp' | 'several_things'; line: string; vp?: { id: string; title: string } }>;
}

/** The longest Brief kept: a dozen lines, not a document (Main's lines carry two task refs). */
export const BRIEF_MAX_CHARS = 4000;

/** The fields the Brief's team is read from. */
export interface BriefTask {
  id: string;
  title: string;
  phase: string;
  project?: string;
  parent_task_id?: string;
  org_role?: string;
  org_leads?: readonly string[];
  /** Kept to a plugin's own view (Task.plugin_only): never part of a team. */
  plugin_only?: string;
  phase_changed_at?: string;
}

/**
 * The work a Brief is about. A lead's: every task in the projects it leads and every task below
 * it. Main's: the leads and every task below Main. Never the owner itself.
 */
export function briefTeam<T extends BriefTask>(owner: BriefTask, tasks: readonly T[]): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const below = (t: T): boolean => {
    let cur: T | undefined = t;
    for (let hops = 0; cur?.parent_task_id && hops < 12; hops++) {
      if (cur.parent_task_id === owner.id) return true;
      cur = byId.get(cur.parent_task_id);
    }
    return false;
  };
  // Keyed as the Org tree keys projects (org-tree.ts projectKey); the Inbox ('') is no one's team.
  const key = (p: string | undefined) => (p ?? '').trim().toLowerCase();
  const projects = owner.org_role === 'lead'
    ? new Set([owner.project, ...(owner.org_leads ?? [])].map(key).filter(Boolean)) : null;
  // A plugin's own task (Task.plugin_only) is no one's team: the Brief never names it.
  return tasks.filter((t) => t.id !== owner.id && !t.plugin_only && (
    below(t)
    || (owner.org_role === 'main' ? t.org_role === 'lead' : !!projects && projects.has(key(t.project)) && t.org_role !== 'main')
  ));
}

// ── The Brief's three sections: what needs the user, what works, what waits ──

/**
 * Every Brief has these three sections, in this order, under these headings (2026-10-30, the user:
 * "what is being done, what does not need me, what needs me ... this task itself actually has this
 * status ... we must put this whole structure in"). A task's line goes in the section of its own
 * live status (Task.user_status), whose Waiting covers a snoozed or parked task. Done work has no
 * section: it leaves the Brief. sessions/brief-structure.ts keeps every stored Brief in this shape.
 */
export const BRIEF_SECTIONS: ReadonlyArray<{ state: Exclude<UserState, 'done'>; heading: string }> = [
  { state: 'needs', heading: 'Needs you' },
  { state: 'working', heading: 'Working' },
  { state: 'waiting', heading: 'Waiting / snoozed' },
];

/** A team task as the Brief's section lists read it. */
export interface BriefSectionTask extends BriefTask {
  status?: string;
  user_status?: UserStatus;
  /** Its latest result (peers/structured-reply.ts): Partial while not_done is set and unsettled. */
  result_report?: { not_done?: readonly string[]; settled?: unknown; at?: string };
}

export function resultIsPartial(r: BriefSectionTask['result_report']): boolean {
  return !!r?.not_done?.length && !r.settled;
}
