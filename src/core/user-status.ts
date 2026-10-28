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
}

/** 2026-10-27, the user: "If the task is closed, mostly close by me means I already verified ...
 *  this is generic rules". Every agent-facing text that lists or reports tasks says it. */
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
    if (report?.state === 'needs' && !none(report.ask)) return strip({ state: 'needs', source: 'session', ask: clean(report.ask), ...w });
    if (report?.state === 'waiting' && report.waiting_kind === 'you' && !none(report.waiting_on)) {
      return strip({ state: 'needs', source: 'session', ask: clean(report.waiting_on), ...w });
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
    // A worker whose session stopped (Walnut's idle reap, a stop) with no report of its own saying it
    // needs the user: its lead is the one to look (2026-10-27: a worker reaped while its tests ran read
    // Needs you everywhere). The reap still hands it back, so a reply its lead waits for is settled.
    if (input.hasLeader && !input.isLead && !input.isMain && input.processStatus === 'stopped') {
      return strip({ state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to look at it: its session stopped before it said it needs anything', ...w });
    }
    // Its turn just ended and its report is on the way: only that report can say it asks anything.
    if (input.reportPending) {
      return strip({ state: 'waiting', kind: 'other', waitingOn: 'Its report on the turn that just ended', ...w });
    }
    return strip({ state: 'needs', source: 'session', ask: 'Its turn ended and handed the task back to you: read it and reply.', ...w });
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
    return strip({ state: 'waiting', kind: 'stuck', waitingOn: 'It stopped, and nothing will wake it', ...w });
  }

  if (input.phase === 'TODO') return strip({ state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet', ...w });

  // WAITING (and any phase an older writer left): on what, from the facts first, then its words.
  const tasks = (input.waitingOnTasks ?? []).map(clean).filter(Boolean);
  const triggers = (input.triggers ?? []).map(clean).filter(Boolean);
  const schedules = (input.schedules ?? []).filter((r) => clean(r.name));
  const until = input.waitUntil && Date.parse(input.waitUntil) > nowMs ? input.waitUntil : null;
  const reported = report?.state === 'waiting' && !none(report.waiting_on) ? clean(report.waiting_on) : '';
  const reportedKind = report?.state === 'waiting' ? report.waiting_kind : undefined;
  if (machine) return machine;
  if (tasks.length) return strip({ state: 'waiting', kind: 'task', waitingOn: reported || `A reply from ${tasks.join(', ')}`, ...w });
  if (reported && reportedKind && reportedKind !== 'stuck') return strip({ state: 'waiting', kind: reportedKind, waitingOn: reported, ...(until ? { until } : {}), ...w });
  // A standing routine: between fires it waits on the next one.
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

/** "2 need you · 10 working · 16 waiting · 12 done", the one line every surface prints. */
export function userStatusLine(c: UserStatusCounts, opts: { withDone?: boolean } = {}): string {
  const parts = [`${c.needs} ${c.needs === 1 ? 'needs' : 'need'} you`, `${c.working} working`, `${c.waiting} waiting`];
  if (opts.withDone !== false) parts.push(`${c.done} done`);
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

/** The fields the Brief's team and its moves are read from. */
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

/** The team's tasks whose phase moved after `sinceMs` (the Brief's time), newest first. */
export function briefMoves<T extends BriefTask>(owner: BriefTask, tasks: readonly T[], sinceMs: number, limit = 8): Array<{ task: T; at: number }> {
  if (!Number.isFinite(sinceMs)) return [];
  return briefTeam(owner, tasks)
    .map((task) => ({ task, at: task.phase_changed_at ? Date.parse(task.phase_changed_at) : NaN }))
    .filter((m) => Number.isFinite(m.at) && m.at > sinceMs)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}
