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

// ── Limits (every number is a cron-storm lesson; keep them in one place) ──

export const CHECK_TIMEOUT_DEFAULT_S = 30;
export const CHECK_TIMEOUT_MAX_S = 300;
export const CHECK_STDOUT_CAP = 64 * 1024;
export const CHECK_STDERR_TAIL = 8 * 1024;
export const CHECK_INPUT_CAP = 8 * 1024;
export const CHECK_STATE_CAP = 16 * 1024;
export const CHECK_ITEMS_CAP = 200;
export const CHECK_ITEM_ID_MAX = 200;
export const MAX_FIRES_PER_DAY_DEFAULT = 24;
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
/** Unacked fires are re-sent this often until the server acks them. */
export const PENDING_FIRE_REPLAY_MS = 60_000;
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

/** One armed trigger as the server pushes it (`triggers.configure`). */
export interface TriggerDef {
  id: string;
  name: string;
  everyMs: number;
  check: TriggerCheckSpec;
  limits?: TriggerLimits;
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
  /** The script printed more than CHECK_ITEMS_CAP items; the tail was dropped. */
  itemsTruncated?: boolean;
}

/** Per-trigger state the daemon persists at `trigger-state/<id>.json`. */
export interface TriggerHostState {
  version: 1;
  /**
   * Random id minted with the state file. `seq` restarts at 0 whenever the file
   * is recreated (disable then enable, a lost DAEMON_DIR after a reboot), and the
   * server's high-water mark would then swallow the next `seq` fires as replays.
   * Every fire carries (epoch, seq); a new epoch tells the server to start over.
   */
  epoch: string;
  seen: Record<string, number>;
  state: unknown;
  day: { key: string; fires: number };
  pendingFires: PendingFire[];
  consecutiveErrors: number;
  seq: number;
  lastRunAtMs?: number;
  lastFireAtMs?: number;
}

export type CheckDecision =
  | { kind: 'quiet'; reason: 'fire-false' | 'all-seen' | 'rate-limited' }
  | { kind: 'fire'; items: TriggerItem[]; input?: string };

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
  nextRunAtMs: number;
}

export type TriggerEvent = TriggerCheckedEvent | TriggerFiredEvent;

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
    day: { key: dayKey(nowMs), fires: 0 },
    pendingFires: [],
    consecutiveErrors: 0,
    seq: 0,
  };
}

/** Local calendar day on the host that runs the check: the daily cap is a human budget. */
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
  const day = r.day && typeof r.day === 'object' ? (r.day as Record<string, unknown>) : {};
  const pending = Array.isArray(r.pendingFires)
    ? (r.pendingFires as unknown[]).filter((p): p is PendingFire =>
        !!p && typeof p === 'object' && typeof (p as PendingFire).seq === 'number' && Array.isArray((p as PendingFire).items))
    : [];
  return {
    version: 1,
    // A file from before epochs gets one now: the server has no mark for it yet.
    epoch: typeof r.epoch === 'string' && r.epoch ? r.epoch : empty.epoch,
    seen,
    state: 'state' in r ? r.state : null,
    day: {
      key: typeof day.key === 'string' ? day.key : empty.day.key,
      fires: typeof day.fires === 'number' ? day.fires : 0,
    },
    pendingFires: pending.slice(-PENDING_FIRES_MAX),
    consecutiveErrors: typeof r.consecutiveErrors === 'number' ? r.consecutiveErrors : 0,
    seq: typeof r.seq === 'number' ? r.seq : 0,
    ...(typeof r.lastRunAtMs === 'number' ? { lastRunAtMs: r.lastRunAtMs } : {}),
    ...(typeof r.lastFireAtMs === 'number' ? { lastFireAtMs: r.lastFireAtMs } : {}),
  };
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
  if (r.items !== undefined) {
    if (!Array.isArray(r.items)) return { ok: false, error: '"items" must be an array' };
    const byId = new Map<string, TriggerItem>();
    for (let i = 0; i < r.items.length; i++) {
      const it = r.items[i];
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        return { ok: false, error: `items[${i}] must be an object with a string "id"` };
      }
      const id = (it as Record<string, unknown>).id;
      if (typeof id !== 'string' || !id.trim()) {
        return { ok: false, error: `items[${i}].id must be a non-empty string` };
      }
      if (id.length > CHECK_ITEM_ID_MAX) {
        return { ok: false, error: `items[${i}].id is longer than ${CHECK_ITEM_ID_MAX} chars` };
      }
      if (!byId.has(id)) byId.set(id, { ...(it as Record<string, unknown>), id });
    }
    items = [...byId.values()];
    if (items.length > CHECK_ITEMS_CAP) {
      items = items.slice(0, CHECK_ITEMS_CAP);
      itemsTruncated = true;
    }
  }

  let input: string | undefined;
  let inputTruncated = false;
  if (r.input !== undefined && r.input !== null) {
    if (typeof r.input !== 'string') return { ok: false, error: '"input" must be a string' };
    input = r.input;
    if (input.length > CHECK_INPUT_CAP) {
      input = `${input.slice(0, CHECK_INPUT_CAP)}\n[input truncated at ${CHECK_INPUT_CAP} chars]`;
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
    },
    inputTruncated,
    itemsTruncated,
  };
}

// ── Deciding ──

export function newItemsOf(items: TriggerItem[] | undefined, state: TriggerHostState): TriggerItem[] {
  if (!items) return [];
  return items.filter((it) => !(it.id in state.seen));
}

/**
 * fire:false is quiet. fire:true with items fires only for ids not yet seen;
 * fire:true with NO items fires every time (the script did its own judging).
 * The daily cap is checked last so a rate-limited run still reports why.
 */
export function decideCheck(def: TriggerDef, output: TriggerCheckOutput, state: TriggerHostState, nowMs: number): CheckDecision {
  if (!output.fire) return { kind: 'quiet', reason: 'fire-false' };
  let items: TriggerItem[] = [];
  if (output.items) {
    items = newItemsOf(output.items, state);
    if (items.length === 0) return { kind: 'quiet', reason: 'all-seen' };
  }
  const cap = def.limits?.maxFiresPerDay ?? MAX_FIRES_PER_DAY_DEFAULT;
  const firesToday = state.day.key === dayKey(nowMs) ? state.day.fires : 0;
  if (cap > 0 && firesToday >= cap) return { kind: 'quiet', reason: 'rate-limited' };
  return { kind: 'fire', items, ...(output.input !== undefined ? { input: output.input } : {}) };
}

/**
 * Record a completed check. `state` from the script always replaces the stored
 * one when printed (null included); a script that prints no `state` key keeps
 * the previous cursor. Seen ids are written ONLY on a fire, so a rate-limited
 * or quiet run never swallows an item. Returns the queued fire, if any.
 */
export function applyCheckOutcome(
  state: TriggerHostState,
  output: TriggerCheckOutput,
  decision: CheckDecision,
  nowMs: number,
  durationMs: number,
  flags: { itemsTruncated?: boolean } = {},
): PendingFire | null {
  state.lastRunAtMs = nowMs;
  state.consecutiveErrors = 0;
  if (output.hasState) state.state = output.state ?? null;
  const today = dayKey(nowMs);
  if (state.day.key !== today) state.day = { key: today, fires: 0 };
  if (decision.kind !== 'fire') return null;

  for (const it of decision.items) state.seen[it.id] = nowMs;
  pruneSeen(state, nowMs);
  state.day.fires += 1;
  state.lastFireAtMs = nowMs;
  state.seq += 1;
  const fire: PendingFire = {
    seq: state.seq,
    atMs: nowMs,
    items: decision.items,
    ...(decision.input !== undefined ? { input: decision.input } : {}),
    ...(flags.itemsTruncated ? { itemsTruncated: true } : {}),
    durationMs,
  };
  state.pendingFires.push(fire);
  if (state.pendingFires.length > PENDING_FIRES_MAX) {
    state.pendingFires.splice(0, state.pendingFires.length - PENDING_FIRES_MAX);
  }
  return fire;
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
    return `exit ${proc.exitCode ?? proc.signal ?? '?'}${tail ? `: ${tail.slice(0, 300)}` : ''}`;
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
 * Run `sh -c <run>` in its own process group with the stdin payload, a hard
 * deadline, and a stdout cap. The group kill is what makes the deadline real:
 * `sh -c "curl ... | jq"` is three processes, and killing only the shell would
 * leave the pipeline running until it noticed the closed pipe.
 */
export function runCheckProcess(
  spec: TriggerCheckSpec,
  stdinJson: string,
  opts: { env?: NodeJS.ProcessEnv; nowMs?: () => number } = {},
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
    // Pipe reads split at arbitrary byte offsets, so a multi-byte character can
    // straddle two chunks; decoding per chunk would turn it into U+FFFD and fail
    // the JSON parse of an otherwise valid line.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const finish = (partial: Partial<CheckProcessResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderrTail: stderr.slice(-CHECK_STDERR_TAIL),
        timedOut,
        stdoutOverflow,
        durationMs: Math.max(0, now() - startedAt),
        ...partial,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/sh', ['-c', spec.run], {
        cwd: spec.cwd || undefined,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(opts.env ?? {}) },
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
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    // The kill normally produces 'close' within milliseconds; when it does not,
    // this settles the run anyway so the trigger can tick again.
    const settleTimer = setTimeout(() => {
      timedOut = true;
      finish({ exitCode: null, signal: 'SIGKILL' });
    }, timeoutMs + CHECK_SETTLE_GRACE_MS);

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = code === 'ENOENT' && spec.cwd
        ? `cwd does not exist: ${spec.cwd}`
        : `could not start check: ${err.message}`;
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
    d.id, d.name, d.everyMs, d.check.run, d.check.cwd ?? '', d.check.timeoutSeconds ?? 0,
    d.limits?.maxFiresPerDay ?? -1,
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

export function validateTriggerDef(raw: unknown): { ok: true; def: TriggerDef } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'trigger must be an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return { ok: false, error: 'trigger.id is required' };
  if (typeof r.everyMs !== 'number' || !Number.isFinite(r.everyMs) || r.everyMs < MIN_EVERY_MS) {
    return { ok: false, error: `trigger ${r.id}: everyMs must be a number >= ${MIN_EVERY_MS}` };
  }
  const check = r.check && typeof r.check === 'object' ? (r.check as Record<string, unknown>) : null;
  if (!check || typeof check.run !== 'string' || !check.run.trim()) {
    return { ok: false, error: `trigger ${r.id}: check.run is required` };
  }
  const limits = r.limits && typeof r.limits === 'object' ? (r.limits as Record<string, unknown>) : {};
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
        ? { limits: { maxFiresPerDay: Math.max(0, Math.floor(limits.maxFiresPerDay)) } }
        : {}),
    },
  };
}
