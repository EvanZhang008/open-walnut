/**
 * Routines API — canonical /api/routines surface.
 *
 * A routine is a cron job + an `executor` ref (which decides where the
 * instructions run; `claude-code` is the one the UI offers). A stored job may
 * still name a retired executor type, and legacy sessionTarget/payload fields
 * still exist on the wire for back-compat, but the UI reads/writes `executor`.
 */

import { apiGet, apiPost, apiPatch, apiDelete } from './client';

export type RoutineSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

export type RoutineExecutorRef = {
  type: string;
  config: Record<string, unknown> & {
    instructions?: string;
    cwd?: string;
    host?: string;
    model?: string;
    taskTitle?: string;
    timeoutSeconds?: number;
  };
};

/**
 * walnut-trigger: a shell command the daemon on `host` runs every tick. Its
 * last stdout line decides whether the routine fires (docs/plan/walnut-trigger.md).
 */
export type RoutineCheck = {
  run: string;
  cwd?: string;
  host: string;
  timeoutSeconds?: number;
  maxFiresPerDay?: number;
};

/**
 * The counter half of a routine's trigger: it also runs once this many counted
 * events have arrived (server: src/core/cron/types.ts CronWake). Read-only in
 * the UI — the form shows it and must never erase it, which is why a save omits
 * the field entirely rather than sending it back.
 */
export type RoutineWake = {
  events: string[];
  countField?: string;
  threshold: number;
  skipWhenIdle?: boolean;
};

export type RoutineLastCheck = {
  atMs: number;
  outcome: 'fired' | 'quiet' | 'error';
  reason?: 'fire-false' | 'all-seen' | 'rate-limited';
  items?: number;
  error?: string;
  durationMs?: number;
  /** A fire whose delivery failed transiently; the daemon will replay it. */
  retryPending?: boolean;
  /** The daemon killed the check at its time limit. */
  killedAtLimit?: boolean;
  /** The time limit this check ran under, in seconds. */
  limitSeconds?: number;
};

/** Where a fire ended up. `retrying` = the daemon still owns it, not a failure. */
export type RoutineAuditDelivery = {
  status: 'ok' | 'error' | 'retrying';
  summary?: string;
  sessionId?: string;
  error?: string;
};

/**
 * One line of a trigger's audit trail (server: src/core/cron/trigger-audit.ts).
 * A quiet or failed check carries the verdict; a fire also carries where it went
 * and a preview of the exact text the session received.
 */
export type RoutineAuditEntry = {
  atMs: number;
  outcome: 'fired' | 'quiet' | 'error';
  reason?: 'fire-false' | 'all-seen' | 'rate-limited';
  items?: number;
  durationMs?: number;
  error?: string;
  /** Check errors only: the daemon killed the check at its time limit. */
  killedAtLimit?: boolean;
  /** The time limit this run ran under, in seconds. */
  limitSeconds?: number;
  seq?: number;
  epoch?: string;
  attempts?: number;
  /** A backlog delivered as ONE envelope: how many fires, and the oldest one's time. */
  coalesced?: number;
  firstAtMs?: number;
  /** Set only when the delivery landed late (long after the oldest fire). */
  deliveredAtMs?: number;
  delivery?: RoutineAuditDelivery;
  injected?: { chars: number; preview: string };
  /** What the daemon repaired in what the check printed (an over-long id, a dropped item). */
  warnings?: string[];
  /** A run someone asked for (Run now), not one the schedule made. */
  manual?: true;
};

export type RoutineState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  /** When someone paused it (switched it off); absent while on, and on a trigger the server stopped. */
  pausedAtMs?: number;
  lastCheck?: RoutineLastCheck;
  /** Trigger audit trail, newest first: recent checks of any outcome. */
  checkLog?: RoutineAuditEntry[];
  /** Trigger audit trail, newest first: the fires with their delivery. */
  fireLog?: RoutineAuditEntry[];
  /** Total fires ever — the bounded fireLog cannot report it. */
  fireCount?: number;
  /** The daemon's highest processed fire seq: a floor on the count for a trigger
   *  that was already firing before the audit trail existed. */
  lastFireSeq?: number;
  /** Wake routines: counted events waiting for the next run. */
  wakeCount?: number;
  wakeLastAtMs?: number;
  /** A routine whose work runs on a host keeps its clock in that host's daemon (clock-routine-v1). */
  clockHost?: string;
  clockFromMs?: number;
  /** The host starts a claude-code routine's runs itself while this Mac is away (clock-host-start-v1). */
  clockStarts?: boolean;
  /** Routines without a check: every run, newest first (server: src/core/cron/run-log.ts). */
  runLog?: RoutineRunEntry[];
};

/** One run of a routine (server: RoutineRunEntry in src/core/cron/types.ts). */
export interface RoutineRunEntry {
  atMs: number;
  status: 'ok' | 'error' | 'skipped';
  durationMs: number;
  slotMs?: number;
  error?: string;
  summary?: string;
  sessionId?: string;
  manual?: true;
  catchUpMs?: number;
  attempt?: number;
  willRetryAtMs?: number;
  repeats?: number;
  firstAtMs?: number;
}

/** A slot the routine should have run and has no good run for (server: MissedRun in run-log.ts). */
export interface RoutineMissedRun {
  slotMs: number;
  reason: string;
  failedAtMs?: number;
}

/**
 * The task a routine delivers into, and that task's project (server:
 * src/core/routines/routine-owner.ts). Absent for one that files its own work;
 * `project: ''` is the Inbox. Both read as global on the Routines page.
 */
export type RoutineOwner = { taskId: string; title: string; project: string };

export interface Routine {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: RoutineSchedule;
  wakeMode: 'now' | 'next-cycle';
  executor?: RoutineExecutorRef;
  check?: RoutineCheck;
  wake?: RoutineWake;
  /** The task told when it misses a run. */
  ownerTaskId?: string;
  state: RoutineState;
  /** Its missed runs, newest first; absent when none. */
  missed?: RoutineMissedRun[];
  owner?: RoutineOwner;
}

export interface RoutineCheckTestResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  parsed: { fire: boolean; items?: Array<{ id: string }>; input?: string } | null;
  error: string | null;
  wouldFire: boolean;
  newItemCount: number;
}

export interface ExecutorFieldSpec {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'number' | 'path';
  required?: boolean;
  placeholder?: string;
  optionsKey?: 'hosts' | 'models';
  /** `number` fields only; defaults to 1. 0 where zero is a real setting. */
  min?: number;
}

export interface ExecutorInfo {
  type: string;
  label: string;
  description: string;
  configSchema: ExecutorFieldSpec[];
  /** Walnut makes these routines itself: shown on a routine of it, never offered for a new one. */
  internal?: boolean;
}

export interface ExecutorOptions {
  hosts: Array<{ value: string; label: string }>;
  models: Array<{ value: string; label: string }>;
}

export type CreateRoutineInput = {
  name: string;
  description?: string;
  schedule: RoutineSchedule;
  executor: RoutineExecutorRef;
  /** `null` on update clears an existing check. */
  check?: RoutineCheck | null;
  /**
   * `null` on update clears the counter trigger. OMIT it to leave a stored one
   * alone: the server merges by key presence, so an absent `wake` is what lets
   * the form save a routine whose counter it does not render.
   */
  wake?: RoutineWake | null;
  wakeMode?: 'now' | 'next-cycle';
  enabled?: boolean;
};

export type UpdateRoutineInput = Partial<CreateRoutineInput>;

export async function fetchRoutines(includeDisabled = true): Promise<Routine[]> {
  const params = includeDisabled ? { includeDisabled: 'true' } : undefined;
  const res = await apiGet<{ jobs: Routine[] }>('/api/routines', params);
  return res.jobs;
}

export async function fetchRoutine(id: string): Promise<Routine> {
  const res = await apiGet<{ job: Routine }>(`/api/routines/${encodeURIComponent(id)}`);
  return res.job;
}

export async function createRoutine(input: CreateRoutineInput): Promise<Routine> {
  const res = await apiPost<{ job: Routine }>('/api/routines', input);
  return res.job;
}

export async function updateRoutine(id: string, input: UpdateRoutineInput): Promise<Routine> {
  const res = await apiPatch<{ job: Routine }>(`/api/routines/${id}`, input);
  return res.job;
}

export async function deleteRoutine(id: string): Promise<void> {
  await apiDelete(`/api/routines/${id}`);
}

export async function toggleRoutine(id: string): Promise<Routine> {
  const res = await apiPost<{ job: Routine }>(`/api/routines/${id}/toggle`);
  return res.job;
}

/** Run now; `catchUpMs` names the missed slot this run is made for. */
export async function runRoutine(id: string, catchUpMs?: number): Promise<unknown> {
  const res = await apiPost<{ result: unknown }>(`/api/routines/${id}/run`, catchUpMs !== undefined ? { catchUpMs } : undefined);
  return res.result;
}

/** Set a missed run aside: nothing runs for it, and it no longer shows. */
export async function dismissMissedRun(id: string, slotMs: number): Promise<Routine> {
  const res = await apiPost<{ job: Routine }>(`/api/routines/${id}/missed/dismiss`, { slotMs });
  return res.job;
}

/** A test run's time against its limit (server: TestTimeLimit in src/core/routines/trigger-api.ts). */
export interface RoutineCheckTimeLimit {
  seconds: number;
  durationMs?: number;
  share?: number;
  killed?: boolean;
  /** "ran 34 s of its 120 s limit". */
  line?: string;
  /** Set when the run took over half the limit or was killed by it. */
  warning?: string;
}

type CheckTestAnswer =
  | { result: RoutineCheckTestResult; timeLimit?: RoutineCheckTimeLimit; pending?: undefined }
  | { pending: { testId: string; limitSeconds: number; runningForMs: number }; result?: undefined };

/** Each call waits this long for the run, then reads it again by its id: a check may run 300 s. */
const TEST_WAIT_PER_CALL_MS = 10_000;

/**
 * Run a check once on its host, writing no state. Throws with the server's reason (cold or old
 * daemon). A run longer than one call's wait answers `pending`, and the same run is read again by
 * its id until it ends, so no request holds a browser connection for minutes.
 */
export async function testRoutineCheck(
  check: Pick<RoutineCheck, 'run'> & Partial<RoutineCheck>,
  id?: string,
): Promise<RoutineCheckTestResult & { timeLimit?: RoutineCheckTimeLimit }> {
  const opts = { timeoutMs: TEST_WAIT_PER_CALL_MS + 15_000 };
  let res = await apiPost<CheckTestAnswer>('/api/routines/check-test', {
    check, ...(id ? { id } : {}), answerWithinMs: TEST_WAIT_PER_CALL_MS,
  }, opts);
  const limitS = Math.min(300, Math.max(1, Math.floor(check.timeoutSeconds ?? 30)));
  const giveUpAt = Date.now() + 2 * (limitS + 20) * 1000 + 15_000;
  while (res.pending && Date.now() < giveUpAt) {
    res = await apiPost<CheckTestAnswer>('/api/routines/check-test', {
      testId: res.pending.testId, answerWithinMs: TEST_WAIT_PER_CALL_MS,
    }, opts);
  }
  if (res.pending) throw new Error(`The check is still running after ${Math.round(res.pending.runningForMs / 1000)} s; test it again`);
  return { ...res.result, ...(res.timeLimit ? { timeLimit: res.timeLimit } : {}) };
}

export async function fetchExecutors(): Promise<{ executors: ExecutorInfo[]; options: ExecutorOptions }> {
  return apiGet<{ executors: ExecutorInfo[]; options: ExecutorOptions }>('/api/routines/executors');
}

/** NL → populated draft. Throws with the server's error message on 422. */
export async function draftRoutine(text: string): Promise<CreateRoutineInput> {
  const res = await apiPost<{ draft: CreateRoutineInput }>('/api/routines/draft', { text });
  return res.draft;
}
