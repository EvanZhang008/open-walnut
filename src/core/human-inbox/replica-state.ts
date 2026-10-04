/**
 * The Human Inbox on a cloud REPLICA while the primary is out of reach.
 *
 * Letters live on the primary (an answer has to reach the origin session, and
 * only the primary has the daemons), so every inbox route on a replica relays
 * there first. But the inbox directory also rides git-sync: the replica holds a
 * read-only copy of the index and of every body. Before this module that copy
 * was never read, so whenever the Mac slept or lost its network the phone's
 * inbox answered `bridge_offline`, new letters never showed, and every read the
 * human made was taken back (2026-10-03: 29 list loads and 13 read marks failed
 * on the replica in one day). Now:
 *
 *   reads   the relay first (it is the freshest), the git-synced copy when the
 *           primary cannot be reached (`servedFrom: 'mirror'`);
 *   writes  read / pin / archive relay first; when the primary cannot be
 *           reached they are QUEUED here and answered at once, and replayed on
 *           the next primary bridge connect (plus a 60s sweep). Answers and
 *           replies still need the primary: they are a delivery to a session.
 *
 * One file per (letter, flag) under HUMAN_INBOX_QUEUE_DIR (cache/, never git),
 * so a newer change to the same flag replaces the older one in place. An entry
 * has two lives:
 *
 *   pending  the primary has not taken it yet. Overlaid on every mirror read,
 *            replayed oldest-first with `since` = when the human made it, so a
 *            newer change on the primary (an agent reply that flipped the letter
 *            unread) wins over a late replay instead of being hidden by it.
 *   applied  the primary took it and answered with the index clock it stamped.
 *            Still overlaid until the mirror's own clock (`lastUpdated`, the
 *            primary's stamp, carried by git) reaches that stamp: the Mac can
 *            sleep inside its 30s git tick, and without this the copy would show
 *            the letter unread again although the primary has it read.
 *
 * The replica never writes into human-inbox/ itself (git-sync restores that
 * directory from HEAD on this box, see CLOUD_NEVER_STAGE_DIRS); the overlay
 * lives only in what these functions return.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_MODE, HUMAN_INBOX_QUEUE_DIR } from '../../constants.js';
import { writeJsonFile } from '../../utils/fs.js';
import { log } from '../../logging/index.js';
import { normalizeStore, LETTER_ID_RE, type LetterStoreFile } from './normalize.js';
import type { LetterStateField } from './store.js';
import type { LetterDetail, LetterList, LetterRecord } from './types.js';

export interface LetterStateEntry {
  letterId: string;
  field: LetterStateField;
  value: boolean;
  /** When the human made the change (this box's clock, epoch ms). */
  at: number;
  state: 'pending' | 'applied';
  /** applied only: the primary's index clock right after it took the change (ISO). */
  storeUpdatedAt?: string;
  /** applied only: when the primary answered (this box's clock), for the TTL. */
  appliedAt?: number;
}

/** A list answered from the git-synced copy. Additive to the v1 shape. */
export interface MirrorLetterList extends LetterList {
  servedFrom: 'mirror';
  /** The copy's content clock (the primary's stamp of its last write that reached here). */
  mirrorUpdatedAt?: string;
}

const FIELDS: readonly LetterStateField[] = ['read', 'pinned', 'archived'];

/** The relay action and body key for each flag (the route names, not the field names). */
export const STATE_ACTIONS: Record<LetterStateField, { action: 'read' | 'pin' | 'archive'; key: string }> = {
  read: { action: 'read', key: 'read' },
  pinned: { action: 'pin', key: 'pinned' },
  archived: { action: 'archive', key: 'archived' },
};

const SERVER_RELAY_SID = '__server__';
const FLUSH_INTERVAL_MS = 60_000;
/** One replayed flag is a tiny write on the primary. */
const REPLAY_RPC_TIMEOUT_MS = 15_000;
/**
 * An applied entry whose stamp the copy never reaches (the primary stopped
 * syncing the inbox, or its clock jumped back) must not override the copy
 * forever. Two weeks outlasts any sleep this exists for.
 */
const APPLIED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** A git checkout rewrites index.json in place, so one read can catch it half written. */
const MIRROR_READ_ATTEMPTS = 3;
const MIRROR_RETRY_MS = 150;

const ENTRY_FILE_RE = /^(lt-[0-9a-z]{1,12}-[0-9a-z]{4,12})\.(read|pinned|archived)\.json$/;

function entryFile(letterId: string, field: LetterStateField): string {
  return path.join(HUMAN_INBOX_QUEUE_DIR, `${letterId}.${field}.json`);
}

// ── One lock for every queue mutation (single process: the replica server) ──

let queueLock: Promise<void> = Promise.resolve();

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = queueLock;
  let release: () => void;
  queueLock = new Promise<void>(r => { release = r; });
  return prev.then(fn).finally(() => release!());
}

function isEntry(v: unknown): v is LetterStateEntry {
  const e = v as LetterStateEntry | null;
  return !!e && typeof e.letterId === 'string' && LETTER_ID_RE.test(e.letterId)
    && FIELDS.includes(e.field) && typeof e.value === 'boolean'
    && typeof e.at === 'number' && Number.isFinite(e.at)
    && (e.state === 'pending' || e.state === 'applied');
}

async function readEntry(letterId: string, field: LetterStateField): Promise<LetterStateEntry | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(entryFile(letterId, field), 'utf-8'));
    return isEntry(parsed) && parsed.letterId === letterId && parsed.field === field ? parsed : null;
  } catch {
    return null;
  }
}

/** Every valid entry, oldest change first. An unreadable file is removed. */
export async function readStateEntries(): Promise<LetterStateEntry[]> {
  let names: string[];
  try {
    names = await fsp.readdir(HUMAN_INBOX_QUEUE_DIR);
  } catch {
    return [];
  }
  const out: LetterStateEntry[] = [];
  for (const name of names) {
    const m = ENTRY_FILE_RE.exec(name);
    if (!m) continue;
    const entry = await readEntry(m[1], m[2] as LetterStateField);
    if (entry) {
      out.push(entry);
    } else {
      log.notif.warn('human-inbox replica: unreadable queued state change, removing', { file: name });
      await fsp.rm(path.join(HUMAN_INBOX_QUEUE_DIR, name), { force: true }).catch(() => {});
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Write `entry` unless the file already holds a NEWER change to the same flag:
 * two taps whose relays answer out of order must still leave the later tap.
 */
async function putEntry(entry: LetterStateEntry): Promise<boolean> {
  // The id names a file: never let a request-supplied string reach the path.
  if (!LETTER_ID_RE.test(entry.letterId)) throw new Error(`not a letter id: ${entry.letterId}`);
  return withQueueLock(async () => {
    const existing = await readEntry(entry.letterId, entry.field);
    if (existing && existing.at > entry.at) return false;
    await writeJsonFile(entryFile(entry.letterId, entry.field), entry);
    return true;
  });
}

/** Rewrite or remove an entry, but only while it is still the one we read (`at` unchanged). */
async function settleEntry(seen: LetterStateEntry, next: LetterStateEntry | null): Promise<void> {
  await withQueueLock(async () => {
    const current = await readEntry(seen.letterId, seen.field);
    if (!current || current.at !== seen.at || current.state !== seen.state) return;
    if (next) await writeJsonFile(entryFile(seen.letterId, seen.field), next);
    else await fsp.rm(entryFile(seen.letterId, seen.field), { force: true });
  });
}

/**
 * The primary took a change this box relayed. Kept (as applied) only when the
 * primary said which index clock it stamped; an older primary does not, and then
 * there is no way to tell when the copy has caught up, so nothing is kept.
 */
export async function noteStateApplied(
  letterId: string, field: LetterStateField, value: boolean, at: number, storeUpdatedAt: unknown,
): Promise<void> {
  if (typeof storeUpdatedAt !== 'string' || !Number.isFinite(Date.parse(storeUpdatedAt))) {
    // A newer pending entry for this flag stays; an older one is now settled.
    const existing = await readEntry(letterId, field);
    if (existing && existing.at <= at) await settleEntry(existing, null);
    return;
  }
  try {
    await putEntry({ letterId, field, value, at, state: 'applied', storeUpdatedAt, appliedAt: Date.now() });
  } catch (err) {
    log.notif.warn('human-inbox replica: could not record an applied state change', {
      letterId, field, err: String(err),
    });
  }
}

/** Queue a change the primary could not take. False when it could not be stored. */
export async function queueStateChange(
  letterId: string, field: LetterStateField, value: boolean, at: number,
): Promise<boolean> {
  try {
    await putEntry({ letterId, field, value, at, state: 'pending' });
    log.notif.info('human-inbox replica: state change queued (primary unreachable)', { letterId, field, value });
    return true;
  } catch (err) {
    log.notif.error('human-inbox replica: FAILED to queue a state change', { letterId, field, err: String(err) });
    return false;
  }
}

export async function pendingStateCount(): Promise<number> {
  return (await readStateEntries()).filter(e => e.state === 'pending').length;
}

// ── The git-synced copy ──

/**
 * The replica's copy of the index, or null when there is none (a box that never
 * received the inbox) or it cannot be parsed after a few tries.
 */
export async function readMirrorIndex(): Promise<LetterStoreFile | null> {
  const { humanInboxPaths } = await import('./store.js');
  for (let attempt = 1; attempt <= MIRROR_READ_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await fsp.readFile(humanInboxPaths.indexFile, 'utf-8');
    } catch {
      return null;
    }
    try {
      if (raw.trim()) return normalizeStore(JSON.parse(raw));
    } catch { /* half written by a checkout: read again */ }
    if (attempt < MIRROR_READ_ATTEMPTS) await new Promise(r => setTimeout(r, MIRROR_RETRY_MS));
  }
  log.notif.warn('human-inbox replica: the synced index could not be read');
  return null;
}

/**
 * The entries still to show on top of a copy stamped `mirrorUpdatedAt`, after
 * dropping the applied ones the copy has caught up with (or that outlived the TTL).
 */
async function liveEntries(mirrorUpdatedAt: string | undefined): Promise<LetterStateEntry[]> {
  const mirrorMs = mirrorUpdatedAt ? Date.parse(mirrorUpdatedAt) : NaN;
  const now = Date.now();
  const live: LetterStateEntry[] = [];
  for (const entry of await readStateEntries()) {
    if (entry.state === 'applied') {
      const stampMs = entry.storeUpdatedAt ? Date.parse(entry.storeUpdatedAt) : NaN;
      const caughtUp = Number.isFinite(mirrorMs) && Number.isFinite(stampMs) && mirrorMs >= stampMs;
      const expired = now - (entry.appliedAt ?? entry.at) > APPLIED_TTL_MS;
      if (caughtUp || expired) {
        await settleEntry(entry, null);
        continue;
      }
    }
    live.push(entry);
  }
  return live;
}

/** Apply the changes this box took on top of a letter from the copy. */
function overlay<T extends LetterRecord>(letter: T, entries: LetterStateEntry[]): T {
  let out = letter;
  for (const entry of entries) {
    if (entry.letterId !== letter.id) continue;
    if (entry.field === 'read') {
      if (out.read !== entry.value) out = { ...out, read: entry.value, readAt: entry.at };
    } else if (out[entry.field] !== entry.value) {
      out = { ...out, [entry.field]: entry.value };
    }
  }
  return out;
}

/** The live or archived list from the copy, with this box's changes on top. Null = no copy. */
export async function mirrorList(opts: { archived?: boolean } = {}): Promise<MirrorLetterList | null> {
  const index = await readMirrorIndex();
  if (!index) return null;
  const entries = await liveEntries(index.lastUpdated);
  const letters = index.letters.map(l => overlay(l, entries));
  const { sortLetters } = await import('./store.js');
  const wantArchived = opts.archived === true;
  return {
    letters: sortLetters(letters.filter(l => l.archived === wantArchived)),
    unreadCount: letters.filter(l => !l.archived && !l.read).length,
    servedFrom: 'mirror',
    ...(index.lastUpdated ? { mirrorUpdatedAt: index.lastUpdated } : {}),
  };
}

/**
 * The primary's own answer for one letter, with the changes still queued here
 * on top (the ones it has taken are already in it).
 */
export async function overlayQueued<T extends LetterRecord>(letter: T): Promise<T> {
  return overlay(letter, (await readStateEntries()).filter(e => e.state === 'pending'));
}

/** One index record from the copy with this box's changes on top, or null. */
export async function mirrorRecord(id: string): Promise<LetterRecord | null> {
  const index = await readMirrorIndex();
  const record = index?.letters.find(l => l.id === id);
  if (!index || !record) return null;
  return overlay(record, await liveEntries(index.lastUpdated));
}

/** One letter from the copy (bodies included, as the primary would send it), or null. */
export async function mirrorLetter(id: string): Promise<LetterDetail | null> {
  const index = await readMirrorIndex();
  if (!index || !index.letters.some(l => l.id === id)) return null;
  const { getLetter } = await import('./store.js');
  // getLetter reads the index again; a checkout landing between the two reads
  // can hand it a half-written file, so one miss is retried.
  let detail = await getLetter(id);
  if (!detail) {
    await new Promise(r => setTimeout(r, MIRROR_RETRY_MS));
    detail = await getLetter(id);
  }
  if (!detail) return null;
  return overlay(detail, await liveEntries(index.lastUpdated));
}

// ── Replay ──

let running: Promise<number> | null = null;

/**
 * Replay the pending changes to the primary, oldest first. Single-flight; a
 * caller that asks while a replay runs waits for it (up to `budgetMs`). Stops
 * at the first sign the primary is unreachable; a refusal (the letter is gone,
 * a bad value) drops that change loudly. Resolves with how many were settled.
 */
export async function flushStateQueue(opts: { budgetMs?: number } = {}): Promise<number> {
  if (!CLOUD_MODE) return 0;
  const budgetMs = opts.budgetMs ?? FLUSH_INTERVAL_MS;
  if (!running) {
    running = replayPending(budgetMs).finally(() => { running = null; });
  }
  const current = running;
  return Promise.race([
    current,
    new Promise<number>(r => { setTimeout(() => r(0), budgetMs).unref?.(); }),
  ]);
}

async function replayPending(budgetMs: number): Promise<number> {
  const startedAt = Date.now();
  const pending = (await readStateEntries()).filter(e => e.state === 'pending');
  if (pending.length === 0) return 0;
  const { callPrimaryControl } = await import('../../web/routes/v1-control-relay.js');
  let settled = 0;
  for (const entry of pending) {
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    const { action, key } = STATE_ACTIONS[entry.field];
    const reply = await callPrimaryControl(`server.human-inbox.${action}`, SERVER_RELAY_SID, {
      id: entry.letterId, [key]: entry.value, since: entry.at,
    }, Math.min(REPLAY_RPC_TIMEOUT_MS, remaining));
    if (!reply.ok && (reply.failure.kind === 'bridge_offline' || reply.failure.kind === 'needs_upgrade')) break;
    // A 5xx is the primary failing (a lock, the disk), not the primary refusing:
    // keep the change and try again on the next trigger.
    if (!reply.ok && reply.failure.kind === 'error' && reply.failure.status >= 500) {
      log.notif.warn('human-inbox replica: the primary failed a queued state change, keeping it', {
        letterId: entry.letterId, field: entry.field, status: reply.failure.status, err: reply.failure.message,
      });
      break;
    }
    if (!reply.ok) {
      log.notif.warn('human-inbox replica: the primary refused a queued state change, dropping it', {
        letterId: entry.letterId, field: entry.field, value: entry.value,
        code: reply.failure.kind === 'error' ? reply.failure.code : reply.failure.kind,
        err: reply.failure.message,
      });
      await settleEntry(entry, null);
      settled++;
      continue;
    }
    const result = reply.result;
    const stamp = typeof result.storeUpdatedAt === 'string' ? result.storeUpdatedAt : undefined;
    if (result.superseded === true || !stamp) {
      // Superseded: the primary's newer state is the truth, and the copy shows it
      // once it syncs. No stamp: an older primary, nothing to wait for.
      log.notif.info('human-inbox replica: queued state change replayed', {
        letterId: entry.letterId, field: entry.field, value: entry.value,
        superseded: result.superseded === true,
      });
      await settleEntry(entry, null);
    } else {
      log.notif.info('human-inbox replica: queued state change applied on the primary', {
        letterId: entry.letterId, field: entry.field, value: entry.value,
      });
      await settleEntry(entry, { ...entry, state: 'applied', storeUpdatedAt: stamp, appliedAt: Date.now() });
    }
    settled++;
  }
  return settled;
}

/** Drop the applied entries the copy has caught up with (the sweep's other half). */
async function pruneApplied(): Promise<void> {
  const index = await readMirrorIndex();
  if (index) await liveEntries(index.lastUpdated);
}

/**
 * CLOUD box: replay on every primary bridge (re)connect, and sweep every 60s
 * (replay what is still pending, prune what the copy has caught up with).
 */
export function startHumanInboxQueueFlush(): { stop: () => void } {
  const sweep = (): void => {
    void flushStateQueue()
      .then(() => pruneApplied())
      .catch(err => log.notif.warn('human-inbox replica: sweep failed', { err: String(err) }));
  };
  const timer = setInterval(sweep, FLUSH_INTERVAL_MS);
  timer.unref?.();
  let unhook: (() => void) | null = null;
  let stopped = false;
  void (async () => {
    try {
      const { addPrimaryBridgeConnectedHandler } = await import('../../web/ws/bridge-registry.js');
      // A stop() that ran during the import must not be followed by a hook nobody can remove.
      if (stopped) return;
      unhook = addPrimaryBridgeConnectedHandler(() => {
        void pendingStateCount().then((n) => {
          if (n === 0) return;
          log.notif.info('human-inbox replica: primary bridge connected, replaying queued state changes', { pending: n });
          void flushStateQueue();
        });
      });
    } catch (err) {
      log.notif.warn('human-inbox replica: could not hook the bridge-connected trigger', { err: String(err) });
    }
  })();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      unhook?.();
    },
  };
}
