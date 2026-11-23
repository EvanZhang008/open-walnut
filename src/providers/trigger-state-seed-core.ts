/**
 * triggers.state.seed (trigger-state-seed-v1): the receiving half of a state move.
 * Why: a service set move takes this Walnut's triggers from another Walnut's shared
 * daemon to its own set daemon on the same host; there a check trigger would start
 * with an empty `seen` set and cursor and re-fire every item its script reports. The
 * leader takes the exact state with triggers.state.snapshot on the old daemon and
 * hands it here BEFORE it pushes the set, so the first configure arms the trigger with
 * that state (readTriggerState reads this Walnut's own file first).
 *
 * The state is written only into a place nothing holds: never over an existing file,
 * never for a trigger this daemon arms, drains, runs, delivers or has configured. Every
 * refusal is an ok reply `{seeded: false, reason}`, so the caller moves on. A second
 * seed of the same state (a reply lost in a swap) finds its own file and answers
 * `{seeded: true, already: true}`. Both twins call seedTriggerState.
 */

import {
  parseSnapshotState, readFileBounded, triggerStateDigest, validSnapshotTriggerId,
  TRIGGER_STATE_SNAPSHOT_MAX_BYTES, type SnapshotFsLike,
} from './trigger-state-snapshot-core.js';

export const TRIGGER_STATE_SEED_CAPABILITY = 'trigger-state-seed-v1';
export const TRIGGER_STATE_SEED_COMMAND = 'triggers.state.seed';

export type TriggerStateSeedReason =
  | 'sidecar_missing'
  | 'home_required'
  | 'trigger_id_invalid'
  | 'state_too_large'
  | 'state_corrupt'
  | 'state_unknown_field'
  | 'pending_fires'
  | 'digest_mismatch'
  | 'still_configured'
  | 'armed'
  | 'draining'
  | 'check_running'
  | 'host_delivery_in_flight'
  | 'state_exists'
  | 'write_failed';

export interface TriggerStateSeedRefused {
  seeded: false;
  reason: TriggerStateSeedReason;
  detail?: string;
}

export interface TriggerStateSeedOk {
  seeded: true;
  /** The file was already there with exactly this state (a resend). */
  already?: true;
  triggerId: string;
  digest: string;
  seq: number;
  seenCount: number;
}

export type TriggerStateSeedReply = TriggerStateSeedOk | TriggerStateSeedRefused;

function refuse(reason: TriggerStateSeedReason, detail?: string): TriggerStateSeedRefused {
  return detail ? { seeded: false, reason, detail } : { seeded: false, reason };
}

/** What holds (home, id) on this daemon right now. */
export interface SeedLiveFacts {
  /** The home's latest pushed (or kept) set carries this id. */
  configured: boolean;
  armed: boolean;
  draining: boolean;
  /** A check of this (home, id) is running, armed or not. */
  checkRunning: boolean;
  /** A host delivery or host start of this (home, id)'s fires is in flight. */
  hostDeliveryInFlight: boolean;
}

export type SeedFsLike = SnapshotFsLike & Pick<typeof import('node:fs'), 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'unlinkSync'>;

export interface TriggerStateSeedDeps {
  fs: SeedFsLike;
  /** walnutScope.askedHome(cmd): '' when the command names no Walnut. */
  askedHome: string;
  triggerId: unknown;
  /** A snapshot reply's `state` and `digest`, as sent. */
  state: unknown;
  digest: unknown;
  liveFacts: (home: string, triggerId: string) => SeedLiveFacts;
  /** triggerStateDirOf(home) and triggerStatePath(home, id): this Walnut's own scope only. */
  stateDir: (home: string) => string;
  statePath: (home: string, triggerId: string) => string;
  /** Makes the temp file's name unique (pid and a random tag). */
  tempTag: string;
}

export function checkSeedLive(f: SeedLiveFacts): { ok: true } | TriggerStateSeedRefused {
  if (f.configured) return refuse('still_configured', 'seed before the set that carries this trigger is pushed');
  if (f.armed) return refuse('armed');
  if (f.draining) return refuse('draining');
  if (f.checkRunning) return refuse('check_running');
  if (f.hostDeliveryInFlight) return refuse('host_delivery_in_flight');
  return { ok: true };
}

/**
 * The state as the bytes this daemon will write, read back with the snapshot's own
 * strict parser, and its digest proven equal to the one sent. Pure.
 */
export function validateSeedState(state: unknown, digest: unknown):
  { ok: true; text: string; digest: string; seq: number; seenCount: number } | TriggerStateSeedRefused {
  let raw: string;
  try {
    raw = JSON.stringify(state) ?? '';
  } catch {
    return refuse('state_corrupt', 'not JSON');
  }
  if (Buffer.byteLength(raw) > TRIGGER_STATE_SNAPSHOT_MAX_BYTES) return refuse('state_too_large', `${Buffer.byteLength(raw)} bytes`);
  const parsed = parseSnapshotState(Buffer.from(raw));
  if (!('ok' in parsed)) {
    const reason = parsed.reason === 'state_unknown_field' || parsed.reason === 'pending_fires' ? parsed.reason : 'state_corrupt';
    return refuse(reason, parsed.detail);
  }
  const own = triggerStateDigest(parsed.state);
  if (typeof digest !== 'string' || digest !== own) return refuse('digest_mismatch');
  return { ok: true, text: JSON.stringify(parsed.state), digest: own, seq: parsed.state.seq, seenCount: Object.keys(parsed.state.seen).length };
}

/**
 * Everything between the command and its reply, synchronous so nothing on the event
 * loop interleaves: the checks, the no-overwrite check, the temp write and rename.
 */
export function seedTriggerState(deps: TriggerStateSeedDeps): TriggerStateSeedReply {
  const home = deps.askedHome;
  if (!home) return refuse('home_required', 'the command must name its Walnut (home)');
  if (!validSnapshotTriggerId(deps.triggerId)) return refuse('trigger_id_invalid');
  const triggerId = deps.triggerId;
  const valid = validateSeedState(deps.state, deps.digest);
  if (!('ok' in valid)) return valid;
  const live = checkSeedLive(deps.liveFacts(home, triggerId));
  if (!('ok' in live)) return live;
  const done: TriggerStateSeedOk = { seeded: true, triggerId, digest: valid.digest, seq: valid.seq, seenCount: valid.seenCount };
  const file = deps.statePath(home, triggerId);
  const fs = deps.fs;
  let exists = true;
  try { fs.lstatSync(file); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return refuse('write_failed', (err as Error).message);
    exists = false;
  }
  if (exists) {
    // Never overwritten (a symlink neither). The same state already there is a resend.
    const read = readFileBounded(fs, file, TRIGGER_STATE_SNAPSHOT_MAX_BYTES);
    const there = read.kind === 'ok' ? parseSnapshotState(read.bytes) : null;
    if (there && 'ok' in there && triggerStateDigest(there.state) === valid.digest) return { ...done, already: true };
    return refuse('state_exists', 'a state file is already there; it is never overwritten');
  }
  const tmp = `${file}.seed-${deps.tempTag}.tmp`;
  try {
    fs.mkdirSync(deps.stateDir(home), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, valid.text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    return refuse('write_failed', (err as Error).message);
  }
  return done;
}
