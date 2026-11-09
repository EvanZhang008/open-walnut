/**
 * triggers.state.snapshot (trigger-state-snapshot-v1). Why: moving a legacy watcher to
 * a new definition must keep its dedup set and cursor, so the daemon hands back the
 * EXACT state file of the asking Walnut's own scope, only once nothing can move it,
 * and answers {supported: false, reason} otherwise: never a fresh or coerced state,
 * never another scope's copy, never a write. Both twins call takeTriggerStateSnapshot.
 */

import { createHash } from 'node:crypto';
import { TRIGGER_STATE_TTL_MS, type TriggerHostState } from './trigger-check-core.js';

export const TRIGGER_STATE_SNAPSHOT_CAPABILITY = 'trigger-state-snapshot-v1';
export const TRIGGER_STATE_SNAPSHOT_COMMAND = 'triggers.state.snapshot';
/** A state file holds at most SEEN_MAX ids of CHECK_ITEM_ID_MAX chars plus a 16 KB cursor; far below this. */
export const TRIGGER_STATE_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const TRIGGER_STATE_SNAPSHOT_ID_MAX = 200;
/** A file written this far past the host's clock is not trusted to be a finished write. */
export const TRIGGER_STATE_SNAPSHOT_MTIME_SKEW_MS = 5 * 60 * 1000;
export const TRIGGER_STATE_SNAPSHOT_DIGEST_ALG = 'sha256:canonical-json-v1';

export type TriggerStateSnapshotReason =
  | 'sidecar_missing'
  | 'home_required'
  | 'trigger_id_invalid'
  | 'socket_not_owner'
  | 'scope_unknown'
  | 'still_configured'
  | 'armed'
  | 'draining'
  | 'held_in_unnamed_scope'
  | 'check_running'
  | 'host_delivery_in_flight'
  | 'state_missing'
  | 'state_not_regular_file'
  | 'state_too_large'
  | 'state_unreadable'
  | 'state_changed_during_read'
  | 'state_corrupt'
  | 'state_unknown_field'
  | 'pending_fires'
  | 'shared_copy_newer'
  | 'state_stale'
  | 'mtime_in_future';

export interface TriggerStateSnapshotUnsupported {
  supported: false;
  reason: TriggerStateSnapshotReason;
  detail?: string;
}

export interface TriggerStateSnapshotOk {
  supported: true;
  complete: true;
  frozen: true;
  triggerId: string;
  state: TriggerHostState;
  /** sha256 hex over canonicalTriggerStateJson(state). */
  digest: string;
  digestAlg: typeof TRIGGER_STATE_SNAPSHOT_DIGEST_ALG;
  /** sha256 hex over the state file's raw bytes. */
  fileSha256: string;
  stateBytes: number;
  stateMtimeMs: number;
  seenCount: number;
  /**
   * Until when every seen entry still blocks a replay: the earliest of each entry's
   * own expiry (at + TTL), the file's prune (mtime + TTL) and now + TTL. At or before
   * now, an entry has already expired: the snapshot is exact, but a rollback from it
   * could re-fire that item, so the caller must not restore it.
   */
  seenReliableUntil: number;
}

export type TriggerStateSnapshotReply = TriggerStateSnapshotOk | TriggerStateSnapshotUnsupported;

function refuse(reason: TriggerStateSnapshotReason, detail?: string): TriggerStateSnapshotUnsupported {
  return detail ? { supported: false, reason, detail } : { supported: false, reason };
}

// ── Request and scope ──

export interface SnapshotRequestFacts {
  /** walnutScope.askedHome(cmd): '' when the command names no Walnut (or an invalid one). */
  askedHome: string;
  /** cmd.triggerId as sent. */
  triggerId: unknown;
  /** The Walnut whose trigger set THIS socket last pushed (configure), if any. */
  socketTriggerScope: string | undefined;
  /** The Walnut this socket is bound to for gateway calls, if any. */
  socketGatewayHome: string | undefined;
  /** The ids of that Walnut's latest pushed (or kept) set; undefined when this daemon has no set for it. */
  configuredIds: readonly string[] | undefined;
  /** The ids the unnamed scope's set carries. */
  unnamedConfiguredIds: readonly string[];
}

export function validSnapshotTriggerId(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= TRIGGER_STATE_SNAPSHOT_ID_MAX
    && raw.trim() === raw && !/[\u0000-\u001f\u007f]/.test(raw);
}

/** Who may ask, and whether the latest set already dropped the trigger. */
export function checkSnapshotRequest(f: SnapshotRequestFacts): { ok: true; home: string; triggerId: string } | TriggerStateSnapshotUnsupported {
  const home = f.askedHome;
  if (!home) return refuse('home_required', 'the command must name its Walnut (home)');
  if (!validSnapshotTriggerId(f.triggerId)) return refuse('trigger_id_invalid');
  const triggerId = f.triggerId;
  // The socket must be the one that pushed this Walnut's set, and bound to no other.
  if (f.socketTriggerScope !== home) return refuse('socket_not_owner', 'this socket did not push this Walnut\'s trigger set');
  if (f.socketGatewayHome !== undefined && f.socketGatewayHome !== home) return refuse('socket_not_owner', 'this socket speaks for another Walnut');
  if (!f.configuredIds) return refuse('scope_unknown');
  if (f.configuredIds.includes(triggerId)) return refuse('still_configured', 'push the set without this trigger first');
  if (f.unnamedConfiguredIds.includes(triggerId)) return refuse('held_in_unnamed_scope');
  return { ok: true, home, triggerId };
}

// ── Liveness ──

export interface SnapshotLiveFacts {
  armed: boolean;
  draining: boolean;
  /** The unnamed scope arms or drains an entry of this id. */
  heldUnnamed: boolean;
  /** A check of this id (this Walnut's or the unnamed scope's) is running, armed or not. */
  checkRunning: boolean;
  /** A host delivery or host start of this id's fires is in flight. */
  hostDeliveryInFlight: boolean;
}

export function checkSnapshotLive(f: SnapshotLiveFacts): { ok: true } | TriggerStateSnapshotUnsupported {
  if (f.armed) return refuse('armed');
  if (f.draining) return refuse('draining');
  if (f.heldUnnamed) return refuse('held_in_unnamed_scope');
  if (f.checkRunning) return refuse('check_running');
  if (f.hostDeliveryInFlight) return refuse('host_delivery_in_flight');
  return { ok: true };
}

// ── Bounded read of one daemon-local file ──

export type SnapshotFsLike = Pick<typeof import('node:fs'), 'lstatSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync' | 'constants'>;

export type BoundedRead =
  | { kind: 'ok'; bytes: Buffer; mtimeMs: number; size: number }
  | { kind: 'missing' }
  | { kind: 'not_regular' }
  | { kind: 'too_large'; size: number }
  | { kind: 'unreadable'; error: string }
  | { kind: 'changed' };

/**
 * Read a regular file of at most `maxBytes`, and prove it did not change while read:
 * no symlink is followed, the open file is the one stat saw, and its size and mtime
 * are the same after the read. The path is always one the daemon built itself.
 */
export function readFileBounded(fs: SnapshotFsLike, file: string, maxBytes: number): BoundedRead {
  let before: import('node:fs').Stats;
  try {
    before = fs.lstatSync(file);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error: (err as Error).message };
  }
  if (!before.isFile()) return { kind: 'not_regular' };
  if (before.size > maxBytes) return { kind: 'too_large', size: before.size };
  const noFollow = typeof fs.constants?.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'changed' };
    if (code === 'ELOOP') return { kind: 'not_regular' };
    return { kind: 'unreadable', error: (err as Error).message };
  }
  let total = 0;
  let opened: import('node:fs').Stats | undefined;
  let buf: Buffer | undefined;
  try {
    opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) return { kind: 'changed' };
    if (opened.size > maxBytes) return { kind: 'too_large', size: opened.size };
    // One byte past the bound: a file that grew past it after the stat is caught.
    buf = Buffer.alloc(Math.min(opened.size, maxBytes) + 1);
    for (;;) {
      const n = fs.readSync(fd, buf, total, buf.length - total, total);
      if (n <= 0) break;
      total += n;
      if (total >= buf.length) break;
    }
  } catch (err) {
    return { kind: 'unreadable', error: (err as Error).message };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  if (!opened || !buf) return { kind: 'unreadable', error: 'no read' };
  if (total > maxBytes) return { kind: 'too_large', size: total };
  if (total !== opened.size) return { kind: 'changed' };
  let after: import('node:fs').Stats;
  try { after = fs.lstatSync(file); } catch { return { kind: 'changed' }; }
  if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
    return { kind: 'changed' };
  }
  return { kind: 'ok', bytes: buf.subarray(0, total), mtimeMs: opened.mtimeMs, size: total };
}

// ── Strict parse ──

const STATE_KEYS = new Set([
  'version', 'epoch', 'seen', 'state', 'budget', 'pendingFires', 'consecutiveErrors', 'seq',
  'lastRunAtMs', 'lastFireAtMs', 'clock', 'sharedCopy',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function nonNegInt(v: unknown): v is number {
  return finite(v) && Number.isInteger(v) && v >= 0;
}

/**
 * The file's bytes as the TriggerHostState the daemon would run with, or why not.
 * Unlike coerceHostState, nothing is filled in or dropped: a field missing, of the
 * wrong type or unknown is a refusal. The one default taken is the daemon's own: a
 * missing `state` (the script's cursor, dropped by JSON.stringify when undefined)
 * reads as null, exactly as coerceHostState reads it.
 */
export function parseSnapshotState(bytes: Uint8Array): { ok: true; state: TriggerHostState } | TriggerStateSnapshotUnsupported {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('state_corrupt', 'not UTF-8');
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return refuse('state_corrupt', 'not JSON'); }
  if (!isPlainObject(raw)) return refuse('state_corrupt', 'not an object');
  for (const key of Object.keys(raw)) if (!STATE_KEYS.has(key)) return refuse('state_unknown_field', key);
  if (raw.version !== 1) return refuse('state_corrupt', 'version');
  if (typeof raw.epoch !== 'string' || !raw.epoch) return refuse('state_corrupt', 'epoch');
  if (!isPlainObject(raw.seen)) return refuse('state_corrupt', 'seen');
  const seenEntries = Object.entries(raw.seen);
  for (const [, v] of seenEntries) if (!finite(v)) return refuse('state_corrupt', 'seen entry');
  // fromEntries defines own keys, so an item id like "__proto__" survives (assignment would drop it).
  const seen = Object.fromEntries(seenEntries) as Record<string, number>;
  const budget = raw.budget;
  if (!isPlainObject(budget) || Object.keys(budget).some((k) => k !== 'used' && k !== 'atMs')
    || !finite(budget.used) || budget.used < 0 || !finite(budget.atMs)) {
    return refuse('state_corrupt', 'budget');
  }
  if (!Array.isArray(raw.pendingFires)) return refuse('state_corrupt', 'pendingFires');
  if (raw.pendingFires.length > 0) return refuse('pending_fires', `${raw.pendingFires.length} unacked`);
  if (!nonNegInt(raw.consecutiveErrors)) return refuse('state_corrupt', 'consecutiveErrors');
  if (!nonNegInt(raw.seq)) return refuse('state_corrupt', 'seq');
  if (raw.lastRunAtMs !== undefined && !finite(raw.lastRunAtMs)) return refuse('state_corrupt', 'lastRunAtMs');
  if (raw.lastFireAtMs !== undefined && !finite(raw.lastFireAtMs)) return refuse('state_corrupt', 'lastFireAtMs');
  let clock: TriggerHostState['clock'];
  if (raw.clock !== undefined) {
    const c = raw.clock;
    if (!isPlainObject(c) || Object.keys(c).some((k) => k !== 'fromMs' && k !== 'nextRunAtMs')
      || !finite(c.fromMs) || (c.nextRunAtMs !== undefined && !finite(c.nextRunAtMs))) {
      return refuse('state_corrupt', 'clock');
    }
    clock = { fromMs: c.fromMs, ...(c.nextRunAtMs !== undefined ? { nextRunAtMs: c.nextRunAtMs as number } : {}) };
  }
  if (raw.sharedCopy !== undefined && raw.sharedCopy !== true) return refuse('state_corrupt', 'sharedCopy');
  const state: TriggerHostState = {
    version: 1,
    epoch: raw.epoch,
    seen,
    state: 'state' in raw ? raw.state : null,
    budget: { used: budget.used, atMs: budget.atMs },
    pendingFires: [],
    consecutiveErrors: raw.consecutiveErrors,
    seq: raw.seq,
    ...(raw.lastRunAtMs !== undefined ? { lastRunAtMs: raw.lastRunAtMs as number } : {}),
    ...(raw.lastFireAtMs !== undefined ? { lastFireAtMs: raw.lastFireAtMs as number } : {}),
    ...(clock ? { clock } : {}),
    ...(raw.sharedCopy === true ? { sharedCopy: true as const } : {}),
  };
  return { ok: true, state };
}

/** Keys sorted at every level, arrays in order, no whitespace. Input is JSON.parse output. */
export function canonicalTriggerStateJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonical JSON: non-finite number');
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalTriggerStateJson(v)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalTriggerStateJson(obj[k])).join(',') + '}';
}

export function triggerStateDigest(state: TriggerHostState): string {
  return createHash('sha256').update(canonicalTriggerStateJson(state)).digest('hex');
}

// ── Selecting the snapshot ──

export interface SnapshotSelectInput {
  triggerId: string;
  read: BoundedRead;
  nowMs: number;
  /**
   * mtime of the shared copy (the unnamed dir's file an older daemon reads), or
   * undefined when it does not exist. The daemon would read that copy instead when
   * it is newer, so a snapshot of the own file would not be what it runs with.
   */
  sharedCopyMtimeMs: number | undefined;
}

/** See TriggerStateSnapshotOk.seenReliableUntil. */
export function seenReliableUntil(seen: Record<string, number>, mtimeMs: number, nowMs: number): number {
  let until = Math.min(mtimeMs, nowMs) + TRIGGER_STATE_TTL_MS;
  for (const at of Object.values(seen)) until = Math.min(until, at + TRIGGER_STATE_TTL_MS);
  return until;
}

export function selectSnapshotState(input: SnapshotSelectInput): TriggerStateSnapshotReply {
  const r = input.read;
  if (r.kind === 'missing') return refuse('state_missing');
  if (r.kind === 'not_regular') return refuse('state_not_regular_file');
  if (r.kind === 'too_large') return refuse('state_too_large', `${r.size} bytes`);
  if (r.kind === 'unreadable') return refuse('state_unreadable', r.error);
  if (r.kind === 'changed') return refuse('state_changed_during_read');
  const parsed = parseSnapshotState(r.bytes);
  if (!('ok' in parsed)) return parsed;
  const state = parsed.state;
  if (r.mtimeMs > input.nowMs + TRIGGER_STATE_SNAPSHOT_MTIME_SKEW_MS) return refuse('mtime_in_future');
  if (input.nowMs - r.mtimeMs > TRIGGER_STATE_TTL_MS) return refuse('state_stale', 'past the state TTL; the daemon may prune it');
  // Same rule as readTriggerState: a newer shared copy (an older daemon ran it there) wins.
  if (state.sharedCopy && input.sharedCopyMtimeMs !== undefined && input.sharedCopyMtimeMs > r.mtimeMs + 1) {
    return refuse('shared_copy_newer');
  }
  return {
    supported: true,
    complete: true,
    frozen: true,
    triggerId: input.triggerId,
    state,
    digest: triggerStateDigest(state),
    digestAlg: TRIGGER_STATE_SNAPSHOT_DIGEST_ALG,
    fileSha256: createHash('sha256').update(r.bytes).digest('hex'),
    stateBytes: r.size,
    stateMtimeMs: r.mtimeMs,
    seenCount: Object.keys(state.seen).length,
    seenReliableUntil: seenReliableUntil(state.seen, r.mtimeMs, input.nowMs),
  };
}

// ── The whole command, for both twins ──

export interface TriggerStateSnapshotDeps {
  fs: SnapshotFsLike;
  nowMs: number;
  request: SnapshotRequestFacts;
  /** Facts about (home, id) right now; called only once the request is accepted. */
  liveFacts: (home: string, triggerId: string) => SnapshotLiveFacts;
  /** The exact state file of (home, id): triggerStatePath. Never another scope's. */
  statePath: (home: string, triggerId: string) => string;
  /** The shared copy's mtime (undefined when absent). Read only, never moved. */
  sharedCopyMtimeMs: (triggerId: string) => number | undefined;
}

/**
 * Everything between the command and its reply, synchronous so nothing on the event
 * loop interleaves: the checks, the bounded read, the strict parse, the digest.
 */
export function takeTriggerStateSnapshot(deps: TriggerStateSnapshotDeps): TriggerStateSnapshotReply {
  const req = checkSnapshotRequest(deps.request);
  if (!('ok' in req)) return req;
  const live = checkSnapshotLive(deps.liveFacts(req.home, req.triggerId));
  if (!('ok' in live)) return live;
  const read = readFileBounded(deps.fs, deps.statePath(req.home, req.triggerId), TRIGGER_STATE_SNAPSHOT_MAX_BYTES);
  return selectSnapshotState({
    triggerId: req.triggerId,
    read,
    nowMs: deps.nowMs,
    sharedCopyMtimeMs: deps.sharedCopyMtimeMs(req.triggerId),
  });
}
