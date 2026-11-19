/**
 * walnut-trigger check contract, shared by both daemon twins (bundled into the
 * standalone binary, shipped as the `trigger-check-core.cjs` sidecar for the
 * source-deployed daemon) and by the server's tests.
 *
 * A trigger is a routine whose `check` is a shell command the daemon runs on a
 * cadence. The command reads `{state, lastFireAt, now}` on stdin and prints ONE
 * JSON object as the last line of stdout: `{"fire": bool, "items"?: [{id,...}],
 * "input"?: string, "state"?: any}`. `state` is the script talking to its next
 * run; `input` is the script talking to the AI this run. They are never merged.
 *
 * Everything here is pure except `runCheckProcess`, and nothing here knows about
 * WebSockets, files, or the server: the daemon wires persistence and events
 * around it, the tests drive it directly. Design: docs/plan/walnut-trigger.md.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  clockSpecKey, clockStartKey, validateClockSpec, validateClockStartSpec, type ClockHostState, type ClockStartSpec, type TriggerClockSpec,
} from './trigger-clock-core.js';
import type { GatewayErrorCode } from './gateway-core.js';

// ── Limits (every number is a cron-storm lesson; keep them in one place) ──

export const CHECK_TIMEOUT_DEFAULT_S = 30;
export const CHECK_TIMEOUT_MAX_S = 300;
export const CHECK_STDOUT_CAP = 64 * 1024;
export const CHECK_STDERR_TAIL = 8 * 1024;
export const CHECK_INPUT_CAP = 8 * 1024;
export const CHECK_STATE_CAP = 16 * 1024;
/** Most NEW items one fire carries; the rest come on the next check (the cursor is kept). */
export const CHECK_ITEMS_CAP = 200;
/**
 * Most items one run may print at all. Items are deduped BEFORE the per-fire cap,
 * so a backlog longer than one fire can still be walked: the delivered ones are
 * seen, and the next run's first new ones are the ones that did not fit.
 */
export const CHECK_ITEMS_PARSE_MAX = 2000;
/**
 * Longest item id the daemon keeps (seen set, wire, state file). A longer one is
 * shortened (shortItemId), never an error: on 2026-10-09 one 490-char id failed
 * five runs in a row and turned a 15-minute watch off for 20 hours.
 */
export const CHECK_ITEM_ID_MAX = 200;
/** Most warnings one run reports; the rest are counted in the last one. */
export const CHECK_WARNINGS_MAX = 5;
/**
 * The fire budget: a trigger may fire this many times in a burst, and the budget
 * refills at the same number per 24 hours (one fire back every 24h / cap). It
 * used to be a calendar-day counter, which held a busy trigger for the rest of
 * the host's day once spent (a 5-minute chat monitor on a UTC host went dark at
 * 17:00 Pacific until midnight UTC).
 */
export const MAX_FIRES_PER_DAY_DEFAULT = 24;
export const FIRE_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * What a stored 0 ("no limit") is sent as. Every daemon refuses a cap below 1,
 * and no trigger fires a million times a day, so this never holds a fire.
 */
export const FIRE_BUDGET_UNLIMITED = 1_000_000;
export const SEEN_MAX = 2000;
export const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PENDING_FIRES_MAX = 50;
export const MAX_CONSECUTIVE_CHECK_ERRORS = 5;
export const MIN_EVERY_MS = 10_000;
/**
 * Cadence floor once a trigger has hit MAX_CONSECUTIVE_CHECK_ERRORS. The server
 * disables such a routine, but the daemon must survive the window before that
 * push arrives: a script that errors in 20ms on a 10s cadence would otherwise
 * spin at full rate for as long as the server is unreachable.
 */
export const CHECK_ERROR_BACKOFF_MS = 5 * 60 * 1000;
/**
 * Grace after the deadline before a check that would not die is given up on.
 * SIGKILL to the group normally ends it within milliseconds; a process stuck in
 * the kernel (a hung network mount) or a grandchild that left the group while
 * holding our stdout would otherwise keep the promise open forever, and with it
 * the trigger's `running` flag, so the trigger would never tick again.
 */
export const CHECK_SETTLE_GRACE_MS = 5_000;
/** The check deadline ticks this often and counts what it saw awake. */
export const AWAKE_TICK_MS = 1_000;
/** A tick later than this was asleep (or the process was stopped): it counts as one tick. */
export const AWAKE_MAX_GAP_MS = 5_000;

/**
 * A deadline that counts the time the machine was awake, not the time it slept.
 * A Mac that closes its lid in a dark wake freezes a check minutes long; a plain
 * setTimeout then fires the moment it wakes and reports a timeout the script never
 * ran into (2026-10-12..14, the release watch: "timed out after 434s", 7 minutes
 * of sleep and 8 s awake). Returns the stop function.
 */
export function startAwakeDeadline(ms: number, onExpire: () => void, now: () => number = Date.now): () => void {
  let counted = 0;
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    const gap = Math.max(0, t - last);
    last = t;
    counted += gap > AWAKE_MAX_GAP_MS ? AWAKE_TICK_MS : gap;
    if (counted >= ms) {
      clearInterval(timer);
      onExpire();
    }
  }, AWAKE_TICK_MS);
  return () => clearInterval(timer);
}
/** Unacked fires are re-sent this often until the server acks them. */
export const PENDING_FIRE_REPLAY_MS = 60_000;
/**
 * A fire no server claimed (`triggers.claim`) this long after it was made, or
 * after this daemon armed its trigger, is delivered by the host itself when the
 * target task has a live session here. A connected server claims within a second;
 * one that is asleep, gone, or behind a dead socket never does.
 */
export const HOST_DELIVERY_GRACE_MS = 30_000;
/** A host delivery that failed (or found no live session) is tried again this often. */
export const HOST_DELIVERY_RETRY_MS = 60_000;
/** Longest routine prompt a def carries for host delivery; a longer one stays server-only. */
export const DELIVER_PROMPT_MAX = 32 * 1024;
/** A state file untouched this long belongs to a trigger nobody re-armed; prune it. */
export const TRIGGER_STATE_TTL_MS = SEEN_TTL_MS;

// ── Types ──

export interface TriggerCheckSpec {
  run: string;
  cwd?: string;
  timeoutSeconds?: number;
}

export interface TriggerLimits {
  maxFiresPerDay?: number;
}

/**
 * Where a fire goes when no server claims it: a live session of the task on this
 * host, which the daemon finds in that Walnut's host copy (offline-host-core.ts).
 * Only a server that claims its fires sends this, so a def without it is never
 * delivered by the host (a daemon cannot tell an older server's delivery apart).
 */
export interface TriggerDeliverSpec {
  /** The owning Walnut's data dir: the tenant key of its host copy. */
  home: string;
  taskId: string;
  /** The routine's instruction text, the first part of the envelope. */
  prompt: string;
}

/**
 * One armed trigger as the server pushes it (`triggers.configure`). Exactly one of
 * `check` (a script decides) and `clock` (a clock routine, clock-routine-v1: the
 * schedule decides; trigger-clock-core.ts) is set.
 */
export interface TriggerDef {
  id: string;
  name: string;
  everyMs: number;
  check?: TriggerCheckSpec;
  clock?: TriggerClockSpec;
  limits?: TriggerLimits;
  deliver?: TriggerDeliverSpec;
  /**
   * A clock routine whose run starts a NEW session on this host (a claude-code
   * routine, clock-host-start-v1): what that run is, so the host starts it itself
   * when no server took it in time (clock-host-start-core.ts).
   */
  start?: ClockStartSpec;
}

/** The host delivered a fire itself; the server records it and never delivers it again. */
export interface HostDelivery {
  atMs: number;
  sessionId: string;
  messageId: string;
  /** Every seq that rode the same message (a backlog is one envelope). */
  seqs: number[];
  /** The session was stopped and the host started it again with this message (trigger-host-resume-v1). */
  resumed?: true;
  /** The run started a NEW session here, on a task the host made for it (clock-host-start-v1). */
  started?: true;
  /** That task (journaled for the server as a `task-create`). */
  taskId?: string;
}

export interface TriggerItem {
  id: string;
  [key: string]: unknown;
}

export interface TriggerCheckOutput {
  fire: boolean;
  items?: TriggerItem[];
  input?: string;
  /** Present only when the script printed a `state` key (null counts). */
  state?: unknown;
  hasState: boolean;
  /**
   * Contract slips the daemon repaired instead of failing the run: an over-long
   * id it shortened, an item it dropped. The run still counts as a good one.
   */
  warnings?: string[];
}

export type ParsedCheck =
  | { ok: true; output: TriggerCheckOutput; inputTruncated: boolean; itemsTruncated: boolean }
  | { ok: false; error: string };

export interface PendingFire {
  seq: number;
  atMs: number;
  items: TriggerItem[];
  input?: string;
  durationMs: number;
  /** There were more new items than CHECK_ITEMS_CAP; the rest come on a later check. */
  itemsTruncated?: boolean;
  /**
   * Made while the def carried `deliver`, so its server claims what it takes.
   * Only such a fire may be delivered by the host: an older fire may already
   * have reached a server that never claimed anything.
   */
  arbitrated?: true;
  /** A server claimed it: from then on only a server delivers it (replays go on until the ack). */
  claimedAt?: number;
  /** The host delivered it; replays carry this so the server only records it. */
  host?: HostDelivery;
  /** The last host delivery attempt that did not land (no live session, a failed write). */
  hostTriedAt?: number;
  /** What the daemon repaired in the run that made this fire (TriggerCheckOutput.warnings). */
  warnings?: string[];
  /**
   * A clock routine's run: the slot it stands for (the oldest, when slots waited
   * behind it) and the handover it was made under (TriggerClockSpec.fromMs).
   */
  clock?: { slotMs: number; fromMs: number };
}

/** Per-trigger state the daemon persists at `trigger-state/<id>.json`. */
export interface TriggerHostState {
  version: 1;
  /**
   * Random id minted with the state file. `seq` restarts at 0 whenever the file
   * is recreated (a pruned or deleted file, an isolated daemon dir thrown away), and the
   * server's high-water mark would then swallow the next `seq` fires as replays.
   * Every fire carries (epoch, seq); a new epoch tells the server to start over.
   */
  epoch: string;
  seen: Record<string, number>;
  state: unknown;
  /**
   * Fires spent from the budget as of `atMs`. It drains at cap per 24h, so the
   * value now is `used - elapsed * cap / 24h` (never below 0). Keeping the spend
   * rather than the tokens left means a raised cap takes effect at once.
   */
  budget: { used: number; atMs: number };
  pendingFires: PendingFire[];
  consecutiveErrors: number;
  seq: number;
  lastRunAtMs?: number;
  lastFireAtMs?: number;
  /** Latest non-firing check, replayed on reconnect so quiet hosts do not look stalled. */
  lastCheck?: TriggerCheckedEvent;
  /** A clock routine's place in its schedule (trigger-clock-core.ts). */
  clock?: ClockHostState;
  /**
   * A named Walnut took this trigger over from the set an older daemon left, so it
   * also keeps the shared copy an older daemon reads current (a downgrade then
   * goes on from here, not from the upgrade).
   */
  sharedCopy?: true;
}

export type CheckDecision =
  | { kind: 'quiet'; reason: 'fire-false' | 'all-seen' | 'rate-limited' }
  /**
   * `budgetCap` is the cap decideCheck judged by, so the fire is charged to the
   * same budget. `truncated`: more new items than one fire carries.
   */
  | { kind: 'fire'; items: TriggerItem[]; input?: string; budgetCap?: number; truncated?: boolean };

// ── Wire shapes between server and daemon (docs/plan/walnut-trigger.md) ──

/** `triggers.configure` payload: the authoritative armed set for ONE host. */
export interface TriggersConfigurePayload {
  version: 1;
  triggers: TriggerDef[];
}

/**
 * `triggers.test` payload: run once, read and write no state.
 *
 * The trigger id rides `triggerId`, never `id`: DaemonConnection.send spreads
 * the params into the frame `{id, cmd, ...params}`, so an `id` param would
 * overwrite the numeric RPC correlation id and the reply would be dropped as
 * unmatched (a silent timeout, no log). Same rule for triggers.run / .ack.
 */
export interface TriggersTestPayload {
  check: TriggerCheckSpec;
  /** When set, `newItemCount` is measured against that trigger's seen set. */
  triggerId?: string;
  /**
   * The server's id for this one test run (trigger-caller.ts), when a task's session asked it:
   * the check's `walnut` calls then act for that task (checkCallers below). An older daemon
   * ignores it and the check's calls stay `external`.
   */
  checkCaller?: string;
}

export interface TriggersTestResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  parsed: TriggerCheckOutput | null;
  error: string | null;
  wouldFire: boolean;
  newItemCount: number;
}

/** daemon → server after a run that did not fire. */
export interface TriggerCheckedEvent {
  type: 'trigger.checked';
  id: string;
  atMs: number;
  outcome: 'quiet' | 'error';
  reason?: 'fire-false' | 'all-seen' | 'rate-limited';
  error?: string;
  durationMs: number;
  nextRunAtMs: number;
  consecutiveErrors: number;
  /** A quiet run the daemon had to repair (TriggerCheckOutput.warnings). */
  warnings?: string[];
  /**
   * An error the machine caused, not the script (machineFaultOf): counted by no one, told to no
   * one. Sent on the event only, never kept in the host's state file (an older daemon's snapshot
   * check would call a field it does not know corrupt).
   */
  fault?: MachineFaultKind;
  /** Latest host status sent again at configure, not a new check. */
  replay?: true;
}

/**
 * daemon → server for a fire. At-least-once: the daemon keeps it in
 * `pendingFires` and re-sends it until `triggers.ack`; the server dedups on
 * (id, epoch, seq). `epoch` is absent only from a daemon older than this field.
 */
export interface TriggerFiredEvent {
  type: 'trigger.fired';
  id: string;
  epoch?: string;
  seq: number;
  atMs: number;
  items: TriggerItem[];
  input?: string;
  itemsTruncated?: boolean;
  durationMs: number;
  /** The daemon's next check, or a clock's next slot while it holds the clock (absent for a released one). */
  nextRunAtMs?: number;
  /** Set when the host already delivered this fire: record it, deliver nothing. */
  host?: HostDelivery;
  /** What the daemon repaired in the run that made this fire. */
  warnings?: string[];
  /** A clock routine's run (clock-routine-v1): the slot it stands for and its handover. */
  clock?: { slotMs: number; fromMs: number };
}

export type TriggerEvent = TriggerCheckedEvent | TriggerFiredEvent;

/**
 * `triggers.claim` reply. A claimed (or unknown) seq is the server's to deliver;
 * a `host` seq was delivered here already; a `busy` one is being delivered here
 * right now, so the server neither delivers nor acks it and waits for the replay.
 * `foreign`: the claiming socket belongs to another Walnut than the trigger's.
 */
export interface TriggerClaimReply {
  claimed: number[];
  unknown: number[];
  host: Array<{ seq: number; host: HostDelivery }>;
  busy: number[];
  foreign?: boolean;
}

export interface CheckProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderrTail: string;
  timedOut: boolean;
  stdoutOverflow: boolean;
  durationMs: number;
  spawnError?: string;
}

// ── State ──

export function newEpoch(): string {
  return randomBytes(6).toString('hex');
}

export function emptyHostState(nowMs: number): TriggerHostState {
  return {
    version: 1,
    epoch: newEpoch(),
    seen: {},
    state: null,
    budget: { used: 0, atMs: nowMs },
    pendingFires: [],
    consecutiveErrors: 0,
    seq: 0,
  };
}

/** Local calendar day on the host: the key of the old per-day counter, read only to migrate it. */
export function dayKey(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Accept whatever is on disk and fill in the shape; a corrupt file becomes an empty state. */
export function coerceHostState(raw: unknown, nowMs: number): TriggerHostState {
  const empty = emptyHostState(nowMs);
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const seen: Record<string, number> = {};
  if (r.seen && typeof r.seen === 'object') {
    for (const [k, v] of Object.entries(r.seen as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) seen[k] = v;
    }
  }
  const pending = Array.isArray(r.pendingFires)
    ? (r.pendingFires as unknown[]).filter((p): p is PendingFire =>
        !!p && typeof p === 'object' && typeof (p as PendingFire).seq === 'number' && Array.isArray((p as PendingFire).items))
    : [];
  const lastCheck = coerceCheckedEvent(r.lastCheck);
  return {
    version: 1,
    // A file from before epochs gets one now: the server has no mark for it yet.
    epoch: typeof r.epoch === 'string' && r.epoch ? r.epoch : empty.epoch,
    seen,
    state: 'state' in r ? r.state : null,
    budget: coerceBudget(r, nowMs),
    pendingFires: pending.slice(-PENDING_FIRES_MAX),
    consecutiveErrors: typeof r.consecutiveErrors === 'number' ? r.consecutiveErrors : 0,
    seq: typeof r.seq === 'number' ? r.seq : 0,
    ...(typeof r.lastRunAtMs === 'number' ? { lastRunAtMs: r.lastRunAtMs } : {}),
    ...(typeof r.lastFireAtMs === 'number' ? { lastFireAtMs: r.lastFireAtMs } : {}),
    ...(coerceClock(r.clock) ? { clock: coerceClock(r.clock) } : {}),
    ...(r.sharedCopy === true ? { sharedCopy: true as const } : {}),
    ...(lastCheck ? { lastCheck } : {}),
  };
}

/** A bounded check report read from disk. Older daemons simply ignore this optional field. */
export function coerceCheckedEvent(raw: unknown): TriggerCheckedEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'trigger.checked' || typeof r.id !== 'string' || !r.id || r.id.length > 200
    || (r.outcome !== 'quiet' && r.outcome !== 'error')
    || !['atMs', 'durationMs', 'nextRunAtMs', 'consecutiveErrors'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))) return undefined;
  if ((r.durationMs as number) < 0 || !Number.isInteger(r.consecutiveErrors) || (r.consecutiveErrors as number) < 0) return undefined;
  if (r.reason !== undefined && !['fire-false', 'all-seen', 'rate-limited'].includes(String(r.reason))) return undefined;
  if (r.error !== undefined && (typeof r.error !== 'string' || r.error.length > 1024)) return undefined;
  if (r.warnings !== undefined && (!Array.isArray(r.warnings) || r.warnings.length > CHECK_WARNINGS_MAX
    || r.warnings.some((w) => typeof w !== 'string' || w.length > 1024))) return undefined;
  return {
    type: 'trigger.checked', id: r.id, outcome: r.outcome,
    atMs: r.atMs as number, durationMs: r.durationMs as number,
    nextRunAtMs: r.nextRunAtMs as number, consecutiveErrors: r.consecutiveErrors as number,
    ...(r.reason ? { reason: r.reason as TriggerCheckedEvent['reason'] } : {}),
    ...(typeof r.error === 'string' ? { error: r.error } : {}),
    ...(r.warnings ? { warnings: r.warnings as string[] } : {}),
  };
}

function coerceClock(raw: unknown): ClockHostState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.fromMs !== 'number' || !Number.isFinite(c.fromMs)) return undefined;
  return { fromMs: c.fromMs, ...(typeof c.nextRunAtMs === 'number' && Number.isFinite(c.nextRunAtMs) ? { nextRunAtMs: c.nextRunAtMs } : {}) };
}

/**
 * The budget from disk. A file written before the budget carries the old
 * `day: {key, fires}` counter: today's fires carry over as spent from now, so an
 * upgrade neither hands a spent trigger a fresh burst nor holds it longer than
 * the new rule would; another day's count is simply gone.
 */
function coerceBudget(r: Record<string, unknown>, nowMs: number): TriggerHostState['budget'] {
  const b = r.budget && typeof r.budget === 'object' ? (r.budget as Record<string, unknown>) : null;
  if (b && typeof b.used === 'number' && Number.isFinite(b.used) && typeof b.atMs === 'number' && Number.isFinite(b.atMs)) {
    return { used: Math.max(0, b.used), atMs: b.atMs };
  }
  const day = r.day && typeof r.day === 'object' ? (r.day as Record<string, unknown>) : null;
  const fires = day && day.key === dayKey(nowMs) && typeof day.fires === 'number' && Number.isFinite(day.fires)
    ? Math.max(0, day.fires)
    : 0;
  return { used: fires, atMs: nowMs };
}

/** The cap a def runs under; 0 (never pushed, but harmless) means no budget at all. */
export function fireBudgetCap(def: TriggerDef): number {
  return def.limits?.maxFiresPerDay ?? MAX_FIRES_PER_DAY_DEFAULT;
}

/**
 * Fires spent as of `nowMs`, after the drain since the last fire. Never above
 * the cap: a cap lowered after a busy spell holds the trigger for one refill
 * (24h / cap), not for the days the old spend would take to drain at the new rate.
 */
export function fireBudgetUsed(cap: number, budget: TriggerHostState['budget'], nowMs: number): number {
  if (cap <= 0) return 0;
  const elapsed = Math.max(0, nowMs - budget.atMs);
  // Clamp BEFORE draining: clamping after would report a full budget for as long
  // as the old spend takes to drain at the new, slower rate.
  return Math.max(0, Math.min(cap, budget.used) - (elapsed * cap) / FIRE_BUDGET_WINDOW_MS);
}

/** Float slack, so a budget that drained to exactly one free fire is not held by rounding. */
const BUDGET_EPSILON = 1e-9;

/**
 * When the next fire is allowed: `nowMs` when one is allowed now. The daemon
 * checks on its own cadence, so the fire lands on the first check at or after it.
 */
export function fireBudgetNextAtMs(def: TriggerDef, state: TriggerHostState, nowMs: number): number {
  const cap = fireBudgetCap(def);
  if (cap <= 0) return nowMs;
  const over = fireBudgetUsed(cap, state.budget, nowMs) - (cap - 1);
  if (over <= BUDGET_EPSILON) return nowMs;
  return nowMs + Math.ceil((over * FIRE_BUDGET_WINDOW_MS) / cap);
}

/**
 * An id the script still reports stays remembered. A seen id was stamped only when it was first
 * delivered, so an item a script reports on every run (a standing alert, an open issue it lists
 * each time) aged out after SEEN_TTL_MS, or fell out of the SEEN_MAX newest, while the script
 * still printed it, and was delivered again as if new (2026-11-16, a pipeline watch with 1,013
 * seen ids, several of them reported on every run for weeks). Every run that reads the script's
 * items stamps the ones already seen with its own time, whatever it decides; only an id the
 * script stopped reporting ages out.
 */
export function refreshSeen(state: TriggerHostState, items: readonly TriggerItem[] | undefined, nowMs: number): void {
  if (!items) return;
  // Always this run's time, a stamp from a clock that ran ahead included: left in the future it
  // would never age out, and would head the SEEN_MAX newest for as long as the clock was ahead.
  for (const it of items) if (it.id in state.seen) state.seen[it.id] = nowMs;
}

export function pruneSeen(state: TriggerHostState, nowMs: number): void {
  const entries = Object.entries(state.seen).filter(([, at]) => nowMs - at <= SEEN_TTL_MS);
  entries.sort((a, b) => b[1] - a[1]);
  state.seen = Object.fromEntries(entries.slice(0, SEEN_MAX));
}

/**
 * What the script reads on stdin: one JSON line, newline-terminated. The newline
 * is part of the contract: `read -r STDIN` under `set -e` returns 1 at EOF on an
 * unterminated line and aborts the script before it prints anything, which is
 * exactly what the skill's bash template used to do on every run.
 */
export function buildCheckStdin(state: TriggerHostState, nowMs: number): string {
  return `${JSON.stringify({
    state: state.state ?? null,
    lastFireAt: typeof state.lastFireAtMs === 'number' ? new Date(state.lastFireAtMs).toISOString() : null,
    now: new Date(nowMs).toISOString(),
  })}\n`;
}

// ── Parsing ──

/**
 * The contract is "the LAST line of stdout is the JSON", so a script may log
 * freely above it. Nothing is guessed from a broken line: an overflowed or
 * unparseable stdout is an error, because a trigger that fires on a guess is
 * worse than one that reports it could not read its own script.
 */
export function parseCheckStdout(stdout: string): ParsedCheck {
  if (stdout.length > CHECK_STDOUT_CAP) {
    return { ok: false, error: `stdout exceeded ${CHECK_STDOUT_CAP} bytes; print one JSON line, not the data` };
  }
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return { ok: false, error: 'stdout was empty; the last line must be {"fire": true|false, ...}' };
  let raw: unknown;
  try {
    raw = JSON.parse(last);
  } catch {
    return { ok: false, error: `last stdout line is not JSON: ${last.slice(0, 120)}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'last stdout line must be a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.fire !== 'boolean') {
    return { ok: false, error: '"fire" must be true or false' };
  }

  let items: TriggerItem[] | undefined;
  let itemsTruncated = false;
  // One bad item never fails the run: the daemon repairs what it can (an
  // over-long id) and drops what it cannot (an item with no usable id), and the
  // rest of the run, its state included, goes through. Only a list with nothing
  // usable left in it is an error, because then the script is broken, not one item.
  const warnings: string[] = [];
  const warn = (text: string) => { warnings.push(text); };
  if (r.items !== undefined) {
    if (!Array.isArray(r.items)) return { ok: false, error: '"items" must be an array' };
    const byId = new Map<string, TriggerItem>();
    let dropped = 0;
    let firstDrop = '';
    for (let i = 0; i < r.items.length; i++) {
      const it = r.items[i];
      const bad = !it || typeof it !== 'object' || Array.isArray(it)
        ? `items[${i}] must be an object with a string "id"`
        : typeof (it as Record<string, unknown>).id !== 'string' || !((it as Record<string, unknown>).id as string).trim()
          ? `items[${i}].id must be a non-empty string`
          : null;
      if (bad) {
        dropped += 1;
        if (!firstDrop) firstDrop = bad;
        continue;
      }
      const raw = (it as Record<string, unknown>).id as string;
      const id = shortItemId(raw);
      if (id !== raw) {
        warn(`items[${i}].id was ${raw.length} chars (over ${CHECK_ITEM_ID_MAX}); the daemon shortened it to a stable id and kept the original in "fullId"`);
      }
      if (!byId.has(id)) byId.set(id, { ...(it as Record<string, unknown>), id, ...(id !== raw ? { fullId: raw } : {}) });
    }
    if (dropped > 0 && byId.size === 0) return { ok: false, error: `no usable item: ${firstDrop}` };
    if (dropped > 0) warn(`${dropped} item${dropped === 1 ? '' : 's'} dropped, the first because ${firstDrop}`);
    items = [...byId.values()];
    if (items.length > CHECK_ITEMS_PARSE_MAX) {
      items = items.slice(0, CHECK_ITEMS_PARSE_MAX);
      itemsTruncated = true;
    }
  }

  let input: string | undefined;
  let inputTruncated = false;
  if (r.input !== undefined && r.input !== null) {
    if (typeof r.input !== 'string') return { ok: false, error: '"input" must be a string' };
    input = r.input;
    if (input.length > CHECK_INPUT_CAP) {
      input = `${headChars(input, CHECK_INPUT_CAP)}\n[input truncated at ${CHECK_INPUT_CAP} chars]`;
      inputTruncated = true;
    }
  }

  const hasState = Object.prototype.hasOwnProperty.call(r, 'state');
  if (hasState) {
    let size = 0;
    try {
      size = JSON.stringify(r.state ?? null).length;
    } catch {
      return { ok: false, error: '"state" must be JSON-serializable' };
    }
    if (size > CHECK_STATE_CAP) {
      return { ok: false, error: `"state" exceeded ${CHECK_STATE_CAP} bytes; keep a cursor, not the data` };
    }
  }

  return {
    ok: true,
    output: {
      fire: r.fire,
      ...(items ? { items } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(hasState ? { state: r.state ?? null } : {}),
      hasState,
      ...(warnings.length ? { warnings: boundedWarnings(warnings) } : {}),
    },
    inputTruncated,
    itemsTruncated,
  };
}

/** The tail an over-long id keeps: a hash of the WHOLE id, so ids sharing a long prefix stay apart. */
const ITEM_ID_HASH_CHARS = 16;

/**
 * An item id the daemon can keep: unchanged up to CHECK_ITEM_ID_MAX, else its head
 * plus `~` plus a hash of the whole id. Stable across runs (same id in, same id
 * out), so the seen set still dedups it, and never cut inside a surrogate pair.
 */
export function shortItemId(id: string): string {
  if (id.length <= CHECK_ITEM_ID_MAX) return id;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, ITEM_ID_HASH_CHARS);
  return `${headChars(id, CHECK_ITEM_ID_MAX - ITEM_ID_HASH_CHARS - 1)}~${hash}`;
}

/** At most CHECK_WARNINGS_MAX lines, each one line and bounded: they travel to the session and the History row. */
export function boundedWarnings(warnings: readonly string[]): string[] {
  const flat = warnings.map((w) => headChars(w.replace(/\s+/g, ' ').trim(), 300)).filter(Boolean);
  if (flat.length <= CHECK_WARNINGS_MAX) return flat;
  const kept = flat.slice(0, CHECK_WARNINGS_MAX - 1);
  kept.push(`and ${flat.length - kept.length} more warnings like these`);
  return kept;
}

// ── Deciding ──

/** The shortest seen item id that marks an input line as already told (inputForNewItems). */
export const SEEN_ID_MATCH_MIN = 6;
/**
 * The shortest item title (its leading "[tag]" aside) that marks an input line as about that
 * item: long enough that it is the item's own words, not a phrase any line may hold.
 */
export const SEEN_TITLE_MATCH_MIN = 24;

/** Does `line` name `id` as a whole token (not inside a longer id)? */
function namesId(line: string, id: string): boolean {
  if (!id) return false;
  let at = line.indexOf(id);
  while (at !== -1) {
    const before = at === 0 ? '' : line[at - 1];
    const after = line[at + id.length] ?? '';
    if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) return true;
    at = line.indexOf(id, at + 1);
  }
  return false;
}

/**
 * The words of an item's title a line about it carries: the title without one leading
 * "[tag]", since a script often writes its own line as "[tag] <its short id> <title>".
 * Too short to be the item's own words: none.
 */
function titleWords(item: TriggerItem, min: number): string | undefined {
  if (typeof item.title !== 'string') return undefined;
  const words = item.title.replace(/^\s*\[[^\]\n]{1,40}\]\s*/, '').trim();
  return words.length >= min ? words : undefined;
}

interface ItemNames { id?: string; title?: string }

function namesOf(items: readonly TriggerItem[], minId: number, minTitle: number): ItemNames[] {
  return items.map((it) => {
    const title = titleWords(it, minTitle);
    return { ...(it.id && it.id.length >= minId ? { id: it.id } : {}), ...(title ? { title } : {}) };
  });
}

function namesItem(line: string, n: ItemNames): boolean {
  return (!!n.id && namesId(line, n.id)) || (!!n.title && line.includes(n.title));
}

/**
 * A fire's `input` without what an earlier fire already told (2026-11-12, the org reflection: a
 * queue-result watch printed every result it still saw, newest first, so a fire for 1 new item
 * carried 13 results, three of them delivered hours before; 5 fires, 39.7K chars). The daemon
 * already drops seen items from `items`; the script's own words about them went out again in full.
 * A line naming an item the session was already given, and no new one, is dropped, with the
 * indented lines under it; a line naming no item (the script's own words) stays. Nothing left: no
 * input. A line names an item by its id (SEEN_ID_MATCH_MIN chars or more) or by its title
 * (titleWords): 2026-11-16, a pipeline watch wrote each item's line as "[clear] <short id>
 * <title>", never the item's id, so three issues it had reported days before came back in the
 * text of every fire for a day and read as delivered again.
 */
export function inputForNewItems(input: string, newItems: readonly TriggerItem[], seenItems: readonly TriggerItem[]): string | undefined {
  const freshIds = new Set(newItems.map((it) => it.id));
  // Keeping a line is the safe side, so a new item claims its line on less: any id, and a title
  // of SEEN_ID_MATCH_MIN chars. Only a longer seen id or title drops a line ("12" is too likely to
  // be some other number in the text).
  const fresh = namesOf(newItems, 1, SEEN_ID_MATCH_MIN);
  const freshTitles = fresh.flatMap((n) => (n.title ? [n.title] : []));
  const seen = namesOf(seenItems.filter((it) => !freshIds.has(it.id)), SEEN_ID_MATCH_MIN, SEEN_TITLE_MATCH_MIN)
    // An old title inside a new one ("X blocked" and "X blocked: rollback failed") is no proof:
    // the line may be the new item's, its title cut short by the script.
    .map((n) => (n.title && freshTitles.some((t) => t.includes(n.title!)) ? { ...n, title: undefined } : n))
    .filter((n) => n.id || n.title);
  if (seen.length === 0) return input;
  const kept: string[] = [];
  let dropping = false;
  for (const line of input.split('\n')) {
    const isNew = fresh.some((n) => namesItem(line, n));
    const isOld = !isNew && seen.some((n) => namesItem(line, n));
    if (isOld) { dropping = true; continue; }
    // An indented line under a dropped one belongs to it ("  read it: ..."), unless it names a new item.
    if (dropping && !isNew && /^\s+\S/.test(line)) continue;
    dropping = false;
    kept.push(line);
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out ? out : undefined;
}

export function newItemsOf(items: TriggerItem[] | undefined, state: TriggerHostState): TriggerItem[] {
  if (!items) return [];
  return items.filter((it) => !(it.id in state.seen));
}

/**
 * fire:false is quiet. fire:true with items fires only for ids not yet seen;
 * fire:true with NO items fires every time (the script did its own judging).
 * The fire budget is checked last so a held run still reports why
 * (`rate-limited` on the wire: a fire the budget holds back for a later check).
 */
export function decideCheck(def: TriggerDef, output: TriggerCheckOutput, state: TriggerHostState, nowMs: number): CheckDecision {
  if (!output.fire) return { kind: 'quiet', reason: 'fire-false' };
  let items: TriggerItem[] = [];
  let truncated = false;
  if (output.items) {
    items = newItemsOf(output.items, state);
    if (items.length === 0) return { kind: 'quiet', reason: 'all-seen' };
    if (items.length > CHECK_ITEMS_CAP) {
      items = items.slice(0, CHECK_ITEMS_CAP);
      truncated = true;
    }
  }
  if (fireBudgetNextAtMs(def, state, nowMs) > nowMs) return { kind: 'quiet', reason: 'rate-limited' };
  const seenItems = output.items ? output.items.filter((it) => it.id in state.seen) : [];
  const input = output.input !== undefined && seenItems.length > 0
    ? inputForNewItems(output.input, items, seenItems)
    : output.input;
  return {
    kind: 'fire', items,
    ...(input !== undefined ? { input } : {}),
    budgetCap: fireBudgetCap(def),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Record a completed check. `state` from the script replaces the stored one
 * when printed (null included); a script that prints no `state` key keeps the
 * previous cursor. New ids join the seen set ONLY on a fire; an id already seen that
 * the script still reports is stamped again on every run (refreshSeen).
 *
 * A fire the budget held back keeps the previous cursor too: the script moved
 * its cursor past the items it just reported, and saving that would lose them
 * for good, since the next run reads on from the new cursor. Keeping the old one
 * makes the next allowed check report the same items again (plus anything newer),
 * so a held fire is late, never lost. A fire that could not carry every new item
 * keeps it as well, so the next check reports the rest (the delivered ones are
 * seen by then). Returns the queued fire, if any.
 */
export function applyCheckOutcome(
  state: TriggerHostState,
  output: TriggerCheckOutput,
  decision: CheckDecision,
  nowMs: number,
  durationMs: number,
  flags: { itemsTruncated?: boolean; arbitrated?: boolean } = {},
): PendingFire | null {
  state.lastRunAtMs = nowMs;
  state.consecutiveErrors = 0;
  const held = decision.kind === 'quiet' && decision.reason === 'rate-limited';
  const partial = decision.kind === 'fire' && (decision.truncated === true || flags.itemsTruncated === true);
  if (output.hasState && !held && !partial) state.state = output.state ?? null;
  // A clock that jumped ahead and came back would otherwise freeze the drain
  // (elapsed stays 0) until it catches up with the stamp.
  if (state.budget.atMs > nowMs) state.budget = { used: state.budget.used, atMs: nowMs };
  // Before the fire's new ids: refreshSeen only moves ids that were already seen.
  refreshSeen(state, output.items, nowMs);
  if (decision.kind !== 'fire') return null;

  for (const it of decision.items) state.seen[it.id] = nowMs;
  pruneSeen(state, nowMs);
  const cap = decision.budgetCap ?? MAX_FIRES_PER_DAY_DEFAULT;
  state.budget = cap > 0 ? { used: fireBudgetUsed(cap, state.budget, nowMs) + 1, atMs: nowMs } : { used: 0, atMs: nowMs };
  state.lastFireAtMs = nowMs;
  delete state.lastCheck;
  state.seq += 1;
  const fire: PendingFire = {
    seq: state.seq,
    atMs: nowMs,
    items: decision.items,
    ...(decision.input !== undefined ? { input: decision.input } : {}),
    ...(flags.itemsTruncated || decision.truncated ? { itemsTruncated: true } : {}),
    durationMs,
    ...(flags.arbitrated ? { arbitrated: true as const } : {}),
    ...(output.warnings?.length ? { warnings: output.warnings } : {}),
  };
  state.pendingFires.push(fire);
  trimPendingFires(state);
  return fire;
}

/**
 * A clock routine's slot came (clock-routine-v1): queue its run as a fire with no
 * items, the way applyCheckOutcome queues a check's. `slotMs` is the slot it
 * stands for, `fromMs` the handover it runs under; `arbitrated` as for a check
 * (the def carries `deliver`).
 */
export function applyClockFire(state: TriggerHostState, nowMs: number, slotMs: number, arbitrated: boolean, fromMs: number): PendingFire {
  state.lastRunAtMs = nowMs;
  state.lastFireAtMs = nowMs;
  state.consecutiveErrors = 0;
  state.seq += 1;
  const fire: PendingFire = {
    seq: state.seq, atMs: nowMs, items: [], durationMs: 0,
    ...(arbitrated ? { arbitrated: true as const } : {}),
    clock: { slotMs, fromMs },
  };
  state.pendingFires.push(fire);
  trimPendingFires(state);
  return fire;
}

/**
 * Keep at most PENDING_FIRES_MAX. A fire the host already delivered goes first:
 * only its history line is lost, while an undelivered one would lose its items.
 */
export function trimPendingFires(state: TriggerHostState): void {
  while (state.pendingFires.length > PENDING_FIRES_MAX) {
    const delivered = state.pendingFires.findIndex((f) => !!f.host);
    state.pendingFires.splice(delivered >= 0 ? delivered : 0, 1);
  }
}

// ── Who delivers a fire: the daemon arbitrates (docs/plan/walnut-trigger.md) ──

export function isHostDelivery(v: unknown): v is HostDelivery {
  if (!v || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  return typeof h.atMs === 'number' && Number.isFinite(h.atMs)
    && typeof h.sessionId === 'string' && h.sessionId.length > 0
    && typeof h.messageId === 'string' && h.messageId.length > 0
    && Array.isArray(h.seqs) && h.seqs.every((s) => typeof s === 'number');
}

/**
 * A server claims the fires it received. `inFlight`: seqs the host is writing
 * right now, which nobody may claim until that write ends. Returns the verdict
 * per seq and whether the state changed (a new claim must be persisted, or a
 * restart would let the host deliver a fire the server already owns).
 */
export function claimFires(
  state: TriggerHostState,
  seqs: readonly number[],
  nowMs: number,
  inFlight: ReadonlySet<number> = new Set(),
): { reply: TriggerClaimReply; changed: boolean } {
  const reply: TriggerClaimReply = { claimed: [], unknown: [], host: [], busy: [] };
  let changed = false;
  for (const seq of seqs) {
    const fire = state.pendingFires.find((f) => f.seq === seq);
    if (!fire) reply.unknown.push(seq);
    else if (fire.host) reply.host.push({ seq, host: fire.host });
    else if (inFlight.has(seq)) reply.busy.push(seq);
    else {
      if (fire.claimedAt === undefined) { fire.claimedAt = nowMs; changed = true; }
      reply.claimed.push(seq);
    }
  }
  return { reply, changed };
}

/**
 * Whether the host should deliver this fire now. `armedAtMs` is when this daemon
 * armed the trigger: a fire left over from before a restart gives the returning
 * server the same grace a new fire does.
 */
export function fireDueOnHost(
  fire: PendingFire,
  nowMs: number,
  armedAtMs: number,
  graceMs: number = HOST_DELIVERY_GRACE_MS,
  retryMs: number = HOST_DELIVERY_RETRY_MS,
): boolean {
  if (!fire.arbitrated || fire.claimedAt !== undefined || fire.host) return false;
  if (nowMs - Math.max(fire.atMs, armedAtMs) < graceMs) return false;
  if (fire.hostTriedAt !== undefined && nowMs - fire.hostTriedAt < retryMs) return false;
  return true;
}

/** Record a host delivery on every fire it carried. */
export function markHostDelivered(state: TriggerHostState, delivery: HostDelivery): void {
  for (const fire of state.pendingFires) {
    if (!delivery.seqs.includes(fire.seq)) continue;
    fire.host = delivery;
    delete fire.hostTriedAt;
  }
}

export function applyCheckError(state: TriggerHostState, nowMs: number): void {
  state.lastRunAtMs = nowMs;
  state.consecutiveErrors += 1;
}

export function ackFire(state: TriggerHostState, seq: number): boolean {
  const before = state.pendingFires.length;
  state.pendingFires = state.pendingFires.filter((f) => f.seq !== seq);
  return state.pendingFires.length !== before;
}

/**
 * Blot out the credential shapes a failing `curl -v` or a shell trace echoes on
 * stderr. The error string travels far (job state, every WS client, a
 * notification body, the structured log), so the tail is redacted before it
 * becomes one, at the cost of occasionally hiding a harmless word.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/((?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/((?:authorization|x-api-key|api[-_]?key|private[-_]?token)\s*[:=]\s*)[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:token|api[-_]?key|secret|password|passwd|access[-_]?key)=)[^\s&"']+/gi, '$1[redacted]')
    .replace(/(sk-|ghp_|gho_|github_pat_|xox[abprs]-|AKIA)[A-Za-z0-9_-]{8,}/g, '$1[redacted]');
}

/** Fold a process result and its parse into one human-readable error, or null when clean. */
export function checkErrorOf(proc: CheckProcessResult, parsed: ParsedCheck | null): string | null {
  if (proc.spawnError) return proc.spawnError;
  if (proc.timedOut) return `check timed out after ${Math.round(proc.durationMs / 1000)}s`;
  if (proc.stdoutOverflow) return `stdout exceeded ${CHECK_STDOUT_CAP} bytes`;
  if (proc.exitCode !== 0) {
    const tail = redactSecrets(proc.stderrTail.trim().split('\n').slice(-3).join(' | '));
    return `exit ${proc.exitCode ?? proc.signal ?? '?'}${tail ? `: ${headChars(tail, 300)}` : ''}`;
  }
  if (parsed && !parsed.ok) return parsed.error;
  return null;
}

// ── Running ──

export function clampTimeoutSeconds(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : CHECK_TIMEOUT_DEFAULT_S;
  return Math.min(CHECK_TIMEOUT_MAX_S, Math.max(1, n));
}

/**
 * A plugin template's command (`walnut trigger-check …`) runs the daemon's own
 * `walnut`, which ships with the daemon and so always knows `trigger-check`,
 * instead of whatever `walnut` the user's PATH finds first (none, or an older
 * install). Every other check keeps the PATH it had.
 */
export function templateCheckEnv(run: string, env: NodeJS.ProcessEnv, shimDir: string | undefined): NodeJS.ProcessEnv {
  if (!shimDir || !/^\s*walnut trigger-check /.test(run)) return env;
  return { ...env, PATH: env.PATH ? `${shimDir}:${env.PATH}` : shimDir };
}

// ── Who a check's `walnut` calls act for (trigger-caller-v1) ──
//
// A check runs for no session, so its `walnut` calls reached the server as `external`, and the
// ops that run only for a task (host_exec, host_copy, host_http, host_mcp_*) refused every one
// with 403 session_only. The scripts swallowed the refusal as `fire: false`, so a trigger watching
// a job on another host never fired (2026-11-14: ~50 refusals an hour from 10+ triggers).
//
// Now the daemon gives each check run a token in WALNUT_CHECK_TOKEN and its gateway socket in
// WALNUT_CHECK_SOCKET, names nothing else reads: the CLI sends a task-only host op through that
// socket with the token as its caller id (wn-cli.ts, commands/tools.ts), and every other call of
// the check goes as it always did (a session id in the env would have changed how the installed
// CLI labels and routes all of them, and what git hooks and guards think it is). A call carrying a live
// token still goes up as `external`, so every other op answers it as before, and the daemon adds
// what it vouches for: `triggerCaller`, the trigger (or the server's test run) it started that
// process for. The server reads it only from a daemon that says trigger-caller-v1 and acts for
// that trigger's task, with that task's own grants (src/core/hosts/trigger-caller.ts).

export const TRIGGER_CALLER_CAPABILITY = 'trigger-caller-v1';
export const CHECK_CALLER_SID_PREFIX = 'trigger-check:';
/** The server's id of one test run (trigger-caller.ts mints them). */
export const CHECK_TEST_RUN_RE = /^tt-[A-Za-z0-9_-]{8,64}$/;

/** What a daemon vouches a check's call came from: an armed trigger, or one test run. */
export interface CheckCaller { kind: 'armed' | 'test'; id: string }

export function isCheckCaller(v: unknown): v is CheckCaller {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  if (typeof c.id !== 'string' || !c.id || c.id.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(c.id)) return false;
  return c.kind === 'armed' || (c.kind === 'test' && CHECK_TEST_RUN_RE.test(c.id));
}

/** The checkCaller of a triggers.test command, or undefined when it names none or a malformed one. */
export function testCheckCaller(raw: unknown): CheckCaller | undefined {
  return typeof raw === 'string' && CHECK_TEST_RUN_RE.test(raw) ? { kind: 'test', id: raw } : undefined;
}

export interface CheckCallers {
  /**
   * A token for one run; `release` once the run's process closed. `fault` is the machine fault of
   * the run's last answer (noteAnswer, noteFault), still readable after the release.
   */
  mint(caller: CheckCaller): { sid: string; release(): void; fault(): MachineFaultKind | undefined };
  /**
   * undefined: `sid` is no check's (handle it as before). null: a check's, but its run is over
   * (a child it left behind), so it vouches for nothing. Else what the daemon started it for.
   */
  resolve(sid: unknown): CheckCaller | null | undefined;
  /**
   * The gateway answered a call of a live run: the run's fault is its LAST answer's (machineFaultOf),
   * so a call that worked after a fault clears it (a script that went on and failed on its own is its own).
   */
  noteAnswer(sid: unknown, resp: unknown): void;
  /** The run's own `walnut` reached Walnut over HTTP: the fault it met there, or null for a real answer (CHECK_FAULT_OP). */
  noteFault(sid: unknown, fault: MachineFaultKind | null): void;
  /** Live runs, for tests. */
  size(): number;
}

export function createCheckCallers(token: () => string = () => randomBytes(18).toString('hex')): CheckCallers {
  const live = new Map<string, { caller: CheckCaller; fault?: MachineFaultKind }>();
  return {
    mint(caller) {
      const sid = CHECK_CALLER_SID_PREFIX + token();
      const run: { caller: CheckCaller; fault?: MachineFaultKind } = { caller: { kind: caller.kind, id: caller.id } };
      live.set(sid, run);
      return { sid, release: () => { live.delete(sid); }, fault: () => run.fault };
    },
    resolve(sid) {
      if (typeof sid !== 'string' || !sid.startsWith(CHECK_CALLER_SID_PREFIX)) return undefined;
      return live.get(sid)?.caller ?? null;
    },
    noteAnswer(sid, resp) {
      const run = typeof sid === 'string' ? live.get(sid) : undefined;
      if (!run) return;
      const fault = machineFaultOf(resp);
      if (fault) run.fault = fault;
      else delete run.fault;
    },
    noteFault(sid, fault) {
      const run = typeof sid === 'string' ? live.get(sid) : undefined;
      if (!run) return;
      if (fault === null) delete run.fault;
      else if (isMachineFaultKind(fault)) run.fault = fault;
    },
    size: () => live.size,
  };
}

// ── Machine faults: a failed check that is the machine's doing, not its script's ──
//
// 2026-11-16 11:36Z: the Mac's data disk reached 99%, the Walnut API answered 507 to every write,
// and nine triggers' checks (mail watches through `walnut trigger-check`) failed at the same second.
// Each one woke its task's session with "Trigger check failed", every session answered with one
// line, and the failures counted toward the five that switch a trigger off. None of those scripts
// was wrong, and the disk already has its owner (the disk alarm files its own repair task).
//
// So the daemon remembers, per run, whether one of the run's `walnut` calls was answered with a
// fault of the machine: read from the answer's structured fields (the gateway's own error code,
// the HTTP status and error code Walnut's API answered with), never from the words of an error.
// A failed run with one is reported with `fault`, and neither the daemon nor the server counts it
// or tells anyone: the trigger stays armed at its cadence, keeps the items it has not reported
// (a failed run moves no cursor and marks nothing seen), and the next run after the machine is
// back reports them. A run that failed with no such answer (a non-zero exit, output that breaks
// the contract, its own time limit) is the script's, and goes to its owner as before.

/** Every fault of the machine a check's failure can be put down to. A new one needs its source in machineFaultOf. */
export const MACHINE_FAULT_KINDS = [
  /** Walnut's API answered 507: its data disk is critically full and writes are paused (disk-guard.ts). */
  'disk_full',
  /** No Walnut server took the call: none is connected to this daemon, the daemon is restarting, or the leader is away. */
  'server_away',
  /** The call needs another host, and that host's link is down (it is reconnecting, or did not answer). */
  'host_offline',
] as const;
export type MachineFaultKind = (typeof MACHINE_FAULT_KINDS)[number];

export function isMachineFaultKind(v: unknown): v is MachineFaultKind {
  return typeof v === 'string' && (MACHINE_FAULT_KINDS as readonly string[]).includes(v);
}

/**
 * The gateway's own error codes: which are the machine (typed, so a new code must be placed here).
 * hub_timeout is not: it also means one slow op (a plugin whose upstream hangs, a long host
 * command), which is the check's to hear about.
 */
export const GATEWAY_CODE_FAULT: Readonly<Record<GatewayErrorCode, MachineFaultKind | null>> = {
  hub_unreachable: 'server_away',
  hub_timeout: null,
  unknown_peer: null,
  ambiguous_peer: null,
  self_send: null,
  throttled: null,
  queue_full: null,
  target_awaiting_permission: null,
  target_archived: null,
  unknown_caller: null,
  bad_request: null,
  unsupported_version: null,
  unsupported_replica: null,
  needs_leader: 'server_away',
  internal: null,
};

/**
 * The error codes Walnut's API answers a 503 or 504 with that say a machine is away: the leader
 * (replication/needs-leader.ts, the primary-only routes) or another host's link
 * (link-failure-answer.ts, the host routes). Any other 503 is the route's own answer.
 */
export const API_CODE_FAULT: Readonly<Record<string, MachineFaultKind>> = {
  needs_leader: 'server_away',
  primary_unreachable: 'server_away',
  host_reconnecting: 'host_offline',
  host_no_answer: 'host_offline',
  bridge_offline: 'host_offline',
  bridge_unconfirmed: 'host_offline',
  bridge_unavailable: 'host_offline',
};

/** A Walnut API answer (its HTTP status, its error code) that is a fault of the machine, or null. */
export function apiAnswerFault(status: unknown, code: unknown): MachineFaultKind | null {
  if (status === 507) return 'disk_full';
  if (status !== 503 && status !== 504) return null;
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(API_CODE_FAULT, code) ? API_CODE_FAULT[code]! : null;
}

/** The machine fault a gateway answer carries, or null (an ok answer, or the op's own refusal). */
export function machineFaultOf(resp: unknown): MachineFaultKind | null {
  if (!resp || typeof resp !== 'object' || (resp as { ok?: unknown }).ok !== false) return null;
  const error = (resp as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const e = error as { code?: unknown; api?: unknown };
  const byCode = typeof e.code === 'string' && Object.prototype.hasOwnProperty.call(GATEWAY_CODE_FAULT, e.code)
    ? GATEWAY_CODE_FAULT[e.code as GatewayErrorCode] : null;
  if (byCode) return byCode;
  const api = e.api && typeof e.api === 'object' ? e.api as { status?: unknown; code?: unknown } : null;
  return api ? apiAnswerFault(api.status, api.code) : null;
}

/**
 * A Walnut API answer as the executor reads it (ops/executor.ts OpOutcome): its machine fault, or
 * null. No answer at all (the server is not running) is the server away; an answer that was lost
 * (a timeout) is not, for the reason hub_timeout is not (GATEWAY_CODE_FAULT).
 */
export function opOutcomeFault(r: { ok: boolean; status?: number; code?: string; unreachable?: boolean }): MachineFaultKind | null {
  if (r.ok) return null;
  if (r.unreachable) return 'server_away';
  return apiAnswerFault(r.status, r.code);
}

/**
 * The op a check's own `walnut` sends its daemon after each call it made over HTTP (the Mac's CLI
 * calls the API directly, so the daemon never saw that answer): `kind` names the machine fault it
 * met, `kind: null` says the call got a real answer (which clears the run's fault, as an answer
 * through the gateway does). Answered by the daemon, never relayed; an older daemon relays it and
 * the server refuses an op it does not know.
 */
export const CHECK_FAULT_OP = 'trigger_check_fault';

/** A failed run whose fault was the machine's: it ran, and it is no strike against the script. */
export function applyMachineFault(state: TriggerHostState, nowMs: number): void {
  state.lastRunAtMs = nowMs;
}

export const CHECK_TOKEN_ENV = 'WALNUT_CHECK_TOKEN';
export const CHECK_SOCKET_ENV = 'WALNUT_CHECK_SOCKET';

/** The env a check run gets so its `walnut` calls carry its token to this daemon. */
export function checkCallerEnv(sid: string, gatewaySocket: string | undefined): Record<string, string> {
  return { [CHECK_TOKEN_ENV]: sid, ...(gatewaySocket ? { [CHECK_SOCKET_ENV]: gatewaySocket } : {}) };
}

/**
 * A check's gateway call as the daemon relays it: `external`, with `triggerCaller` on a
 * tools.call when the run is live. Anything the caller itself wrote there is dropped.
 * `local`: answered here, never relayed (op_card_record: a chat card for a session, and a
 * check is none; the server refuses it, which only made noise).
 */
export function checkGatewayCall(
  op: string, args: Record<string, unknown>, caller: CheckCaller | null,
): { local: true; fault?: MachineFaultKind | null } | { local: false; args: Record<string, unknown> } {
  const { triggerCaller: _forged, ...rest } = args;
  if (op === 'tools.call' && rest.name === 'op_card_record') return { local: true };
  if (op === 'tools.call' && rest.name === CHECK_FAULT_OP) {
    const kind = rest.args && typeof rest.args === 'object' ? (rest.args as { kind?: unknown }).kind : undefined;
    return { local: true, ...(isMachineFaultKind(kind) ? { fault: kind } : kind === null ? { fault: null } : {}) };
  }
  if (op !== 'tools.call' || !caller) return { local: false, args: rest };
  return { local: false, args: { ...rest, triggerCaller: { kind: caller.kind, id: caller.id } } };
}

/** Every gateway call: the caller may never write `triggerCaller` itself. */
export function withoutTriggerCaller(args: Record<string, unknown>): Record<string, unknown> {
  if (!('triggerCaller' in args)) return args;
  const { triggerCaller: _forged, ...rest } = args;
  return rest;
}

/**
 * Run `sh -c <run>` in its own process group with the stdin payload, a hard
 * deadline, and a stdout cap. The group kill is what makes the deadline real:
 * `sh -c "curl ... | jq"` is three processes, and killing only the shell would
 * leave the pipeline running until it noticed the closed pipe.
 */
export function runCheckProcess(
  spec: TriggerCheckSpec,
  stdinJson: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    nowMs?: () => number;
    /** The daemon's own `walnut` dir, put first on PATH for a plugin template's command (templateCheckPath). */
    templateShimDir?: string;
    /** Final spawn gate, read synchronously right before the spawn: false = nothing starts. */
    maySpawn?: () => boolean;
    /** Aborting it ends this check's own process group the way its deadline does (killGroup). */
    signal?: AbortSignal;
    /** The live check pids: each joins at its spawn and leaves only at its real 'close', never at the settle timer. */
    children?: Set<number>;
  } = {},
): Promise<CheckProcessResult> {
  const now = opts.nowMs ?? Date.now;
  const startedAt = now();
  const timeoutMs = clampTimeoutSeconds(spec.timeoutSeconds) * 1000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutOverflow = false;
    let timedOut = false;
    let settled = false;
    let stopTimer: () => void = () => {};
    let stopSettleTimer: () => void = () => {};
    // Pipe reads split at arbitrary byte offsets, so a multi-byte character can
    // straddle two chunks; decoding per chunk would turn it into U+FFFD and fail
    // the JSON parse of an otherwise valid line.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const finish = (partial: Partial<CheckProcessResult>) => {
      if (settled) return;
      settled = true;
      stopTimer();
      stopSettleTimer();
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderrTail: tailChars(stderr, CHECK_STDERR_TAIL),
        timedOut,
        stdoutOverflow,
        durationMs: Math.max(0, now() - startedAt),
        ...partial,
      });
    };

    // Nothing between this gate and the spawn awaits.
    if ((opts.maySpawn && !opts.maySpawn()) || opts.signal?.aborted) {
      resolve({
        exitCode: null, signal: null, stdout: '', stderrTail: '', timedOut: false, stdoutOverflow: false,
        durationMs: 0, spawnError: 'check not started: this daemon is stopping',
      });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/sh', ['-c', spec.run], {
        cwd: spec.cwd || undefined,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: templateCheckEnv(spec.run, { ...process.env, ...(opts.env ?? {}) }, opts.templateShimDir),
      });
    } catch (err) {
      resolve({
        exitCode: null, signal: null, stdout: '', stderrTail: '', timedOut: false, stdoutOverflow: false,
        durationMs: 0, spawnError: `could not start check: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    // Only ever the child's own group: a pid of 0/-1/1 would broadcast.
    const killGroup = () => {
      const pid = child.pid;
      if (typeof pid !== 'number' || pid <= 1) return;
      try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const childPid = typeof child.pid === 'number' && child.pid > 1 ? child.pid : null;
    if (childPid !== null) opts.children?.add(childPid);
    const onAbort = () => { killGroup(); };
    if (opts.signal && childPid !== null) opts.signal.addEventListener('abort', onAbort, { once: true });
    const gone = () => {
      if (childPid !== null) opts.children?.delete(childPid);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    // Awake time, not wall time: a sleep mid-check is not the script's slowness.
    stopTimer = startAwakeDeadline(timeoutMs, () => {
      timedOut = true;
      killGroup();
    });
    // The kill normally produces 'close' within milliseconds; when it does not,
    // this settles the run anyway so the trigger can tick again.
    stopSettleTimer = startAwakeDeadline(timeoutMs + CHECK_SETTLE_GRACE_MS, () => {
      timedOut = true;
      finish({ exitCode: null, signal: 'SIGKILL' });
    });

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = code === 'ENOENT' && spec.cwd
        ? `cwd does not exist: ${spec.cwd}`
        : `could not start check: ${err.message}`;
      // A spawn that failed has no process; one that started leaves at its 'close'.
      if (childPid === null) gone();
      finish({ spawnError: msg });
    });
    child.stdout?.on('data', (buf: Buffer) => {
      if (stdoutOverflow) return;
      stdout += outDecoder.write(buf);
      if (stdout.length > CHECK_STDOUT_CAP) {
        stdoutOverflow = true;
        stdout = stdout.slice(0, CHECK_STDOUT_CAP);
        killGroup();
      }
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr = (stderr + errDecoder.write(buf)).slice(-CHECK_STDERR_TAIL * 2);
    });
    child.on('close', (code, signal) => {
      gone();
      if (!stdoutOverflow) stdout += outDecoder.end();
      stderr = (stderr + errDecoder.end()).slice(-CHECK_STDERR_TAIL * 2);
      finish({ exitCode: code, signal });
    });

    if (child.stdin) {
      child.stdin.on('error', () => { /* script closed stdin early; harmless */ });
      child.stdin.end(stdinJson);
    }
  });
}

// ── Validation of a pushed set (the daemon trusts nothing it did not check) ──

/**
 * Fingerprint of an armed set, sorted by id so a reordered push is not a change.
 * The daemon persists `triggers.json` only when this moves (the `hooks.configure`
 * hash-skip precedent), except the server sends no hash for triggers, so the
 * daemon computes its own over the VALIDATED defs (what it would actually write).
 */
export function triggersSetHash(defs: TriggerDef[]): string {
  const sorted = [...defs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const canonical = sorted.map((d) => [
    d.id, d.name, d.everyMs,
    ...(d.check ? [d.check.run, d.check.cwd ?? '', d.check.timeoutSeconds ?? 0] : ['clock', d.clock ? clockSpecKey(d.clock) : '', 0]),
    d.limits?.maxFiresPerDay ?? -1,
    // Appended only when present, so a set without host delivery keeps the hash
    // it always had and an upgrade does not rewrite every triggers.json.
    ...(d.deliver ? [d.deliver.home, d.deliver.taskId, d.deliver.prompt] : []),
    ...(d.start ? ['start', clockStartKey(d.start)] : []),
  ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
}

/**
 * The state file name for a trigger id. Ids are server-generated, so a `/` or a
 * `..` in one must never reach the filesystem: unsafe characters collapse to `_`
 * and a hash tail keeps two different ids from colliding on one file.
 */
export function triggerStateFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 100);
  if (safe === id) return `${id}.json`;
  return `${safe}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}.json`;
}

/**
 * Head/tail slices that never keep half an astral character.
 *
 * All three call sites below persist their result: the truncated `input` rides a
 * PendingFire into the daemon's trigger-state JSON and across the wire, and the
 * stderr tail lands in the job state, a notification body and the logs. A lone
 * surrogate in a JSON file is what makes a strict reader reject the WHOLE file,
 * which has cost this repo an incident before.
 */
export function headChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The tail, which can instead START on the low half of a pair. */
export function tailChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const first = cut.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut;
}

export function validateTriggerDef(raw: unknown): { ok: true; def: TriggerDef } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'trigger must be an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return { ok: false, error: 'trigger.id is required' };
  if (r.clock !== undefined) return validateClockDef(r as Record<string, unknown> & { id: string });
  if (typeof r.everyMs !== 'number' || !Number.isFinite(r.everyMs) || r.everyMs < MIN_EVERY_MS) {
    return { ok: false, error: `trigger ${r.id}: everyMs must be a number >= ${MIN_EVERY_MS}` };
  }
  const check = r.check && typeof r.check === 'object' ? (r.check as Record<string, unknown>) : null;
  if (!check || typeof check.run !== 'string' || !check.run.trim()) {
    return { ok: false, error: `trigger ${r.id}: check.run is required` };
  }
  const limits = r.limits && typeof r.limits === 'object' ? (r.limits as Record<string, unknown>) : {};
  // A cap of 0 never crosses the wire: it reads as either "no fires" or "no
  // limit", and daemons before the budget refuse it. The server sends a stored 0
  // ("no limit") as FIRE_BUDGET_UNLIMITED (trigger-push.ts) and omits the field
  // for the default. Refused here so a bad push fails loudly instead of guessing.
  if (typeof limits.maxFiresPerDay === 'number' && Math.floor(limits.maxFiresPerDay) < 1) {
    return { ok: false, error: `trigger ${r.id}: limits.maxFiresPerDay must be at least 1 (omit it for the default of ${MAX_FIRES_PER_DAY_DEFAULT})` };
  }
  // A malformed `deliver` only costs host delivery for this trigger, never the
  // whole push: polling and server delivery work without it.
  const deliver = deliverSpecOf(r.deliver);
  return {
    ok: true,
    def: {
      id: r.id,
      name: typeof r.name === 'string' && r.name.trim() ? r.name : r.id,
      everyMs: Math.floor(r.everyMs),
      check: {
        run: check.run,
        ...(typeof check.cwd === 'string' && check.cwd ? { cwd: check.cwd } : {}),
        timeoutSeconds: clampTimeoutSeconds(check.timeoutSeconds),
      },
      ...(typeof limits.maxFiresPerDay === 'number'
        ? { limits: { maxFiresPerDay: Math.floor(limits.maxFiresPerDay) } }
        : {}),
      ...(deliver ? { deliver } : {}),
    },
  };
}

/** A def of a pushed set the daemon could not take: the rest of the set is armed without it. */
export interface RefusedTriggerDef {
  id?: string;
  error: string;
}

/**
 * Every def of a pushed set, one by one: a def this daemon cannot take is refused
 * alone (named in the configure reply), so one bad routine never keeps the rest
 * of a host's triggers and clocks from landing. A repeated id keeps its first def.
 */
export function validateTriggerSet(raw: readonly unknown[]): { defs: TriggerDef[]; refused: RefusedTriggerDef[] } {
  const defs: TriggerDef[] = [];
  const refused: RefusedTriggerDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const id = entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
      ? (entry as { id: string }).id : undefined;
    const parsed = validateTriggerDef(entry);
    if (!parsed.ok) { refused.push({ ...(id ? { id } : {}), error: parsed.error }); continue; }
    if (seen.has(parsed.def.id)) { refused.push({ id: parsed.def.id, error: `duplicate trigger id ${parsed.def.id}` }); continue; }
    seen.add(parsed.def.id);
    defs.push(parsed.def);
  }
  return { defs, refused };
}

/** A clock routine's def: no check, and no fire budget (its schedule is its limit). */
function validateClockDef(r: Record<string, unknown> & { id: string }): { ok: true; def: TriggerDef } | { ok: false; error: string } {
  if (r.check !== undefined) return { ok: false, error: `trigger ${r.id}: a def carries a check or a clock, not both` };
  const clock = validateClockSpec(r.clock);
  if (!clock.ok) return { ok: false, error: `trigger ${r.id}: ${clock.error}` };
  const deliver = deliverSpecOf(r.deliver);
  // A malformed start only costs the host start (the run waits for the server, as
  // before), never the clock. A routine that delivers into a session starts none.
  const start = !deliver && r.start !== undefined ? validateClockStartSpec(r.start) : null;
  return {
    ok: true,
    def: {
      id: r.id,
      name: typeof r.name === 'string' && r.name.trim() ? r.name : r.id,
      everyMs: typeof r.everyMs === 'number' && Number.isFinite(r.everyMs) ? Math.floor(r.everyMs) : 0,
      clock: clock.spec,
      ...(deliver ? { deliver } : {}),
      ...(start && start.ok ? { start: start.spec } : {}),
    },
  };
}

function deliverSpecOf(raw: unknown): TriggerDeliverSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.home !== 'string' || !d.home || typeof d.taskId !== 'string' || !d.taskId.trim()) return undefined;
  if (typeof d.prompt !== 'string' || !d.prompt.trim() || d.prompt.length > DELIVER_PROMPT_MAX) return undefined;
  return { home: d.home, taskId: d.taskId.trim(), prompt: d.prompt };
}

// ── `walnut trigger-check`: the stored command of a plugin trigger template ──
//
// Both CLIs run it: the hub CLI (gateway first, HTTP when there is no daemon
// socket) and the daemon's own `walnut` (a host with no installed CLI). They
// share the input, the reading of a failure and the answer to it, so the same
// failure means the same thing whichever ran.

/** The key that marks a cursor kept while Walnut could not run the check. */
const PENDING_KEY = '__walnutPending';

/**
 * How long a check may go unanswered before it counts as an error. Walnut being
 * down (a deploy, a restart) or a companion leading is long; a template that is
 * not registered (its plugin still loading, or reloading after an account
 * change) is shorter, since a removed plugin should reach the user soon.
 */
export const TEMPLATE_WAIT_GRACE_MS = { unreachable: 2 * 3_600_000, missing: 30 * 60_000 } as const;

export type TemplateCheckFailure = 'unreachable' | 'missing' | 'error';

interface PendingMark { since: string; reason: string }

export interface TemplateCheckInput {
  state: unknown;
  lastFireAt: string | null;
  now: string;
  /** Set while earlier runs could not reach the check: since when, and why. */
  pending?: PendingMark;
}

/** The trigger input the daemon wrote on stdin (an empty one when it is not JSON), the plugin's own cursor unwrapped. */
export function templateCheckInput(text: string, nowIso: string): TemplateCheckInput {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text || '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch { /* an empty input below */ }
  let state: unknown = raw.state ?? null;
  let pending: PendingMark | undefined;
  if (state && typeof state === 'object' && PENDING_KEY in (state as Record<string, unknown>)) {
    const mark = (state as Record<string, unknown>)[PENDING_KEY] as Partial<PendingMark> | null;
    if (mark && typeof mark.since === 'string') pending = { since: mark.since, reason: String(mark.reason ?? '') };
    state = (state as Record<string, unknown>).state ?? null;
  }
  return {
    state,
    lastFireAt: typeof raw.lastFireAt === 'string' ? raw.lastFireAt : null,
    now: typeof raw.now === 'string' ? raw.now : nowIso,
    ...(pending ? { pending } : {}),
  };
}

/** The input as the plugin's check sees it: no Walnut bookkeeping. */
export function templateCheckRequestInput(input: TemplateCheckInput): { state: unknown; lastFireAt: string | null; now: string } {
  return { state: input.state, lastFireAt: input.lastFireAt, now: input.now };
}

/** What a failed HTTP answer from the check route means. */
export function classifyTemplateHttp(status: number, code: string): TemplateCheckFailure {
  if (status === 503 || (status === 502 && code !== 'plugin_error')) return 'unreachable';
  if (status === 404 && code === 'not_found') return 'missing';
  return 'error';
}

/** What a failed gateway answer means (the op executor writes "Walnut API error (<code>): …"). */
export function classifyTemplateGateway(code: string, message: string): TemplateCheckFailure {
  if (code === 'hub_unreachable' || code === 'hub_timeout') return 'unreachable';
  if (/Walnut server not running/.test(message)) return 'unreachable';
  const api = /Walnut API error \(([a-z_0-9]+)\)/.exec(message)?.[1];
  if (api === 'unavailable' || api === 'bridge_offline' || api === '503' || api === '502') return 'unreachable';
  if (api === 'not_found') return 'missing';
  return 'error';
}

/**
 * The run's answer when Walnut could not run the check: a quiet line that keeps
 * the plugin's cursor and remembers since when, so the next check picks up where
 * this one would have. Five errors in a row stop a trigger, and a deploy restarts
 * Walnut for a minute, so a short gap must not count. A gap past its grace is an
 * error from then on, so a trigger that cannot work does not look healthy forever.
 */
export function templateCheckGap(
  input: TemplateCheckInput,
  failure: 'unreachable' | 'missing',
  reason: string,
  nowMs = Date.now(),
): { line: string } | { error: string } {
  const since = input.pending?.since ?? new Date(nowMs).toISOString();
  const waited = nowMs - (Date.parse(since) || nowMs);
  if (waited > TEMPLATE_WAIT_GRACE_MS[failure]) {
    const minutes = Math.round(waited / 60_000);
    return { error: `this check has not run for ${minutes} minutes: ${reason}` };
  }
  return { line: JSON.stringify({ fire: false, state: { [PENDING_KEY]: { since, reason: reason.slice(0, 300) }, state: input.state } }) };
}

/**
 * How long the CLI waits for the check's answer: the daemon kills the whole
 * command at 30s, and starting this process already took part of that.
 */
export function templateCheckReplyMs(sinceStartMs: number): number {
  // An integer: AbortSignal.timeout and setTimeout refuse a fraction (performance.now() is one).
  return Math.max(5_000, 27_000 - Math.ceil(Math.max(0, sinceStartMs)));
}
