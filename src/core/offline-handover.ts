/**
 * Taking back what a host did while this server was away
 * (docs/plan/daemon-first-hosts.md, "Handover").
 *
 * The daemon journals every offline answer that changed something: request rows
 * it created and settled, settles of this server's rows, messages it delivered,
 * task writes it queued. On (re)connect this drains that journal in order:
 *   - rows are imported into session-requests.json (the daemon's state wins
 *     over a pending copy; a row this server settled is never reopened);
 *   - a settle marks this server's row replied, BEFORE any turn-end hook of
 *     ours can call it "finished without replying";
 *   - a peer message into a COMPLETE task reopens it, as the online send does;
 *   - queued writes replay through the op registry with the recorded caller,
 *     unless the task changed after the write was queued (a newer edit wins).
 * Then `offline.ack` lets the daemon drop what was applied. Records written
 * during the handover come back in the next round.
 *
 * notifyRequesterFallback waits on `waitForOfflineHandovers` so a reply the
 * daemon delivered is never followed by our own "no reply" notice.
 */

import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import type { OfflineRecord } from '../providers/offline-host-core.js';
import type { SessionRequest } from './session-requests.js';
import { VALID_SESSION_EFFORT_IDS, VALID_SESSION_MODE_IDS, type SessionEffort, type SessionMode } from './types.js';
import { APPLIED_V2_KINDS, RefusedWrite, applyV2, devicePaired, v2TaskIdOf, type V2Record } from './offline-merge/apply-v2.js';
import { recordRemap } from './offline-merge/ledger.js';

/** What the handover needs from a daemon connection. */
export interface HandoverConnection {
  hostKey: string;
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /**
   * Look at these sessions again as a reconnect does, as if their records did
   * not say stopped: the host started them while this server was away.
   */
  rescue?(sessionIds: string[]): Promise<void>;
  /**
   * The daemon speaks journal v2 (cap `journal-v2`): the drain names the kinds this Mac
   * applies, answers `{now}` (the host clock), and is acked by exact `seqs`.
   */
  journalV2?: boolean;
  /** False once the connection is gone: a scheduled retry of a failed record then waits for the next connect. */
  alive?(): boolean;
}

export interface HandoverResult {
  rounds: number;
  records: number;
  imported: number;
  settled: number;
  replayed: number;
  skipped: number;
  failed: number;
}

/** A queued write that did not land, told to the session that made it. */
interface Unapplied { callerSid: string; op: string; taskId: string; reason: string }


const MAX_ROUNDS = 10;
/** The daemon connection's own command budget: a loaded host answered a 10s drain too late (2026-09-28). */
const RPC_TIMEOUT_MS = 30_000;
/** Longest a fallback notice waits on a running handover. */
const HANDOVER_WAIT_MS = 5_000;

const running = new Map<string, Promise<HandoverResult>>();

/**
 * Hosts that said they journaled something we have not drained yet (the
 * offline-journal nudge). A host delivers messages between its own sessions
 * itself even while we answer, so its reply to a request can be in its journal
 * when the asker's turn-end hook asks "did anyone answer?": that hook waits for
 * the drain, as it waits for a running one.
 */
const due = new Map<string, { at: number; done: Promise<void>; resolve: () => void }>();

export function noteHandoverDue(hostKey: string): void {
  if (due.has(hostKey)) return;
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  due.set(hostKey, { at: Date.now(), done, resolve });
}

/** A nudge nobody drained this long ago (the host went away first) is dropped: its records wait for the next connect. */
const DUE_TTL_MS = 60_000;

function pruneDue(): void {
  const now = Date.now();
  for (const [host, d] of due) {
    if (now - d.at > DUE_TTL_MS) { due.delete(host); d.resolve(); }
  }
}

/** The handover of this host that is running now, if any. */
export function runningHandover(hostKey: string): Promise<HandoverResult> | undefined {
  return running.get(hostKey);
}

/** Resolves when every running or due handover has finished (or after HANDOVER_WAIT_MS). */
export async function waitForOfflineHandovers(maxMs = HANDOVER_WAIT_MS): Promise<void> {
  pruneDue();
  if (running.size === 0 && due.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...running.values(), ...[...due.values()].map((d) => d.done)]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, maxMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** One handover per host at a time; a call while one runs joins it. */
export function runOfflineHandover(conn: HandoverConnection): Promise<HandoverResult> {
  const existing = running.get(conn.hostKey);
  if (existing) return existing;
  // Every drain first letters what an earlier one left unsent (a drain that threw after a
  // conflict was durable, a letter that failed, a crash): its redrain acks from the ledger
  // with nothing new to letter, so waiting for the next boot kept the away text unseen.
  void import('./offline-merge/letter.js').then((m) => m.resendUnsentConflictLetters()).catch((err) => {
    log.session.warn('offline handover: unsent conflict letters were not resent', { error: err instanceof Error ? err.message : String(err) });
  });
  const startedAt = Date.now();
  const job = handover(conn).finally(() => {
    running.delete(conn.hostKey);
    // Only a drain that began after the nudge has seen what the nudge was about.
    const d = due.get(conn.hostKey);
    if (d && d.at <= startedAt) { due.delete(conn.hostKey); d.resolve(); }
  });
  running.set(conn.hostKey, job);
  return job;
}

/** Tests only. */
export function _resetOfflineHandoverForTesting(): void {
  running.clear();
  letterFailing.clear();
  logDiskErrorHosts.clear();
  resumesToRescue.clear();
  for (const d of due.values()) d.resolve();
  due.clear();
}

async function handover(conn: HandoverConnection): Promise<HandoverResult> {
  const result: HandoverResult = { rounds: 0, records: 0, imported: 0, settled: 0, replayed: 0, skipped: 0, failed: 0 };
  // A task's updated_at as it was BEFORE this handover wrote anything: a second
  // queued write for the same task must not lose to the first one's own stamp.
  const baseline = new Map<string, number>();
  const unapplied: Unapplied[] = [];
  const v2 = conn.journalV2 === true;
  const [{ ConflictLog }, { measureHostClock, hostClockOffset }, letters] = await Promise.all([
    import('./offline-merge/conflict-log.js'), import('./offline-merge/host-clock.js'), import('./offline-merge/letter.js'),
  ]);
  const batch: Batch = {
    conn, v2, baseline, result, unapplied,
    conflicts: new ConflictLog(conn.hostKey, WALNUT_HOME),
    remap: new Map(), givenUp: new Set(), offset: 0, retryIn: null,
  };
  // Registered before anything can write the log: a resend never takes a live drain's log.
  letters.openDrainLog(batch.conflicts.drainId);
  try {
    await drainRounds(batch, measureHostClock, hostClockOffset);
  } finally {
    // Also when a round threw after a conflict was durable (the ack's link dropped, a
    // later round's drain failed): the redrain acks from the ledger with nothing to letter.
    if (batch.conflicts.entries.length > 0) await letters.sendConflictLetter(batch.conflicts);
    letters.closeDrainLog(batch.conflicts.drainId);
    // Also here: a refusal is in the ledger before its ack, so the redrain of a drain that
    // threw acks it silently, and this is the only time its session can hear of it.
    if (unapplied.length > 0) {
      await tellCallers(unapplied).catch((err: unknown) => {
        log.session.warn('offline handover: the sessions whose writes did not land were not told', { host: conn.hostKey, error: err instanceof Error ? err.message : String(err) });
      });
    }
  }
  if (batch.retryIn !== null) scheduleRetry(conn, batch.retryIn);
  if (stopsToRun.delete(conn.hostKey)) {
    try {
      await (await import('./sessions/session-stop.js')).sessionStops.flush(conn.hostKey);
    } catch (err) {
      // Each stays pending on its record; the next connect runs it again.
      log.session.warn('offline handover: the stops the companion sent did not run yet', { host: conn.hostKey, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const resumed = resumesToRescue.get(conn.hostKey);
  resumesToRescue.delete(conn.hostKey);
  // Asks the host started while this Mac was away (WP12): adopted by the drain, attached now.
  const { adoptedSessions } = await import('./offline-merge/apply-session.js');
  const adopted = adoptedSessions.get(conn.hostKey);
  adoptedSessions.delete(conn.hostKey);
  if (adopted?.size) {
    try {
      await conn.rescue?.([...adopted]);
    } catch (err) {
      log.session.warn('offline handover: could not look at the asks the host started', { host: conn.hostKey, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (resumed && resumed.size > 0) {
    try {
      await conn.rescue?.([...resumed]);
    } catch (err) {
      // Best effort: the record says stopped until a reconnect looks at the session again.
      log.session.warn('offline handover: could not look at the sessions the host resumed', { host: conn.hostKey, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (result.records > 0) {
    // Section 13 observability: one line per drain, with what it applied, merged and lettered.
    const conflicts = batch.conflicts.entries;
    log.session.info('journal drain', {
      host: conn.hostKey, drainId: batch.conflicts.drainId, ...result,
      applied: result.replayed + result.imported + result.settled,
      merged: new Set(conflicts.map((e) => e.seq)).size,
      conflicts: conflicts.length,
    });
    // The replicas' copies go again now: a host replica lets an "awaiting copy" mark go
    // once a manifest from after the ack stored the key, and a write that changed no row
    // (a duplicate create, a refused one) brings no round of its own.
    void (async () => {
      (await import('./replication/task-replica.js')).resendTaskReplicaSoon();
      (await import('./replication/kinds/copy-kind.js')).resendCopyKindsSoon();
      if (batch.notesAcked) {
        // The companion's copy goes over HTTPS (stage 4), a host's over its daemon link.
        const notes = await import('./host-replica.js');
        if (conn.hostKey === notes.COMPANION_REPLICA_HOST) void notes.syncCompanionHostReplica();
        else (await import('../providers/daemon-connection.js')).getConnectedDaemonConnection(conn.hostKey)?.pushHostReplica();
      }
    })().catch((err) => log.session.warn('offline handover: could not send the copies again', { host: conn.hostKey, error: err instanceof Error ? err.message : String(err) }));
  }
  return result;
}

/** The drain's rounds: take what the host hands over, ack what was taken, until it is empty. */
async function drainRounds(
  batch: Batch,
  measureHostClock: typeof import('./offline-merge/host-clock.js').measureHostClock,
  hostClockOffset: typeof import('./offline-merge/host-clock.js').hostClockOffset,
): Promise<void> {
  const { conn, v2, result } = batch;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const sentAt = Date.now();
    const reply = await conn.send('offline.drain', { home: WALNUT_HOME, ...(v2 ? { kinds: [...APPLIED_V2_KINDS] } : {}) }, RPC_TIMEOUT_MS);
    if (reply.ok === false) throw new Error(String(reply.error ?? 'offline.drain refused'));
    if (v2) measureHostClock(conn.hostKey, sentAt, Date.now(), reply.now);
    batch.offset = hostClockOffset(conn.hostKey) ?? 0;
    const records = ((Array.isArray(reply.records) ? reply.records : []) as OfflineRecord[]).slice().sort((a, b) => a.seq - b.seq);
    if (records.length === 0) break;
    result.rounds++;
    result.records += records.length;
    const acked: number[] = [];
    let stopped = false;
    for (const record of records) {
      const step = await takeRecord(batch, record);
      if (step === 'stop') { stopped = true; break; }
      if (step === 'ack') acked.push(record.seq);
    }
    // Every conflict of what is acked is on disk BEFORE the ack (a write failure throws: no ack).
    batch.conflicts.flush();
    if (v2) {
      // `now`: this server's clock after it applied them, so a host replica can tell a copy
      // manifest built after this ack from one built before it (replica/overlay.ts).
      if (acked.length) await conn.send('offline.ack', { home: WALNUT_HOME, seqs: acked, now: Date.now() }, RPC_TIMEOUT_MS);
      // WP11: the host holds an acked note until a copy round from after the ack: send its notes again.
      if (records.some((r) => ((r.kind as string) === 'note' || (r.kind as string) === 'note-move') && acked.includes(r.seq))) {
        (await import('./host-replica.js')).noteRecordsAcked(conn.hostKey);
        batch.notesAcked = true;
      }
      // Stage 4d: the companion holds an acked memory save the same way.
      if (records.some((r) => (r.kind as string) === 'memory' && acked.includes(r.seq))) {
        (await import('./host-replica.js')).noteRecordsAcked(conn.hostKey, 'memory');
        batch.notesAcked = true;
      }
    } else {
      // An old daemon acks by watermark: only the prefix before the first record that waits.
      let upTo = 0;
      for (const r of records) { if (!acked.includes(r.seq)) break; upTo = r.seq; }
      if (upTo > 0) await conn.send('offline.ack', { home: WALNUT_HOME, upTo }, RPC_TIMEOUT_MS);
    }
    // A stop waits for its backoff; a round that acked nothing (unknown kinds only) ends here.
    if (stopped || acked.length === 0) break;
  }
}

/** One drain's state across its rounds. */
interface Batch {
  conn: HandoverConnection;
  v2: boolean;
  baseline: Map<string, number>;
  result: HandoverResult;
  unapplied: Unapplied[];
  conflicts: import('./offline-merge/conflict-log.js').ConflictLog;
  /** Created-while-away ids this Mac re-minted (a collision), for later records of the batch. */
  remap: Map<string, string>;
  /** Tasks whose earlier record was given up: their later records are given up with it. */
  givenUp: Set<string>;
  /** Host clock offset of this drain (ms to add to a host time). */
  offset: number;
  /** A record waits for its backoff: drain again after this many ms. */
  retryIn: number | null;
  /** Note or memory records were acked (WP11, stage 4d): the host's copy goes again after the drain. */
  notesAcked?: boolean;
}

/** v1 kinds keep their meaning; v2 kinds the Mac applies are APPLIED_V2_KINDS. */
const V1_KINDS = new Set(['row', 'settle', 'delivery', 'settings', 'stop', 'resume', 'op']);
/** Retries of a record that threw, on the same connection, before it is given up (section 5). */
let retryBackoffMs = [5_000, 30_000, 120_000];
/** Thrown records by `${host}|${opId or seq}`: how often they threw, and when the next try is due. */
const failing = new Map<string, { count: number; nextAt: number; reason: string }>();
/**
 * Records whose letter entry could not be written (a full disk), by the same key: they back
 * off like a failed apply, and once the steps are spent the record is acked with its entry
 * kept in that drain's letter only (HEAD acked them), so the host's gateway is not held
 * offline for as long as the disk stays full. A note record is the exception: its text
 * exists only on the host until the ack, so it waits at the last step until the log takes it.
 */
const letterFailing = new Map<string, { count: number; nextAt: number }>();
/** Hosts whose conflict log write failure was logged as an error (once, until a write works). */
const logDiskErrorHosts = new Set<string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** How often a record waits on a running request with its op id before it waits for a retry. */
const RESERVE_TRIES = 5;
/** How long one wait on a running request with the record's op id may take. */
let reservationWaitMs = RPC_TIMEOUT_MS;
/** A record whose op is still running here is drained again after this. */
const RESERVED_RETRY_MS = 2_000;

/** True when `p` settled within `ms` (its value is not needed: the ledger is read after). */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tests only: a shorter bound on one wait for a running request with the record's op id. */
export function _setReservationWaitForTesting(ms: number | null): void {
  reservationWaitMs = ms ?? RPC_TIMEOUT_MS;
}

/** Tests only: shorter backoff steps. */
export function _setHandoverBackoffForTesting(steps: number[] | null): void {
  retryBackoffMs = steps ?? [5_000, 30_000, 120_000];
  failing.clear();
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
}

/** Drain the host again once a record's backoff ran out, on the same connection while it lives. */
function scheduleRetry(conn: HandoverConnection, ms: number): void {
  const prev = retryTimers.get(conn.hostKey);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    retryTimers.delete(conn.hostKey);
    if (conn.alive && !conn.alive()) return;
    runOfflineHandover(conn).catch((err) => {
      log.session.warn('offline handover: retry failed', { host: conn.hostKey, error: err instanceof Error ? err.message : String(err) });
    });
  }, ms);
  t.unref?.();
  retryTimers.set(conn.hostKey, t);
}

function recordOpId(record: OfflineRecord): string | undefined {
  const id = (record as { opId?: unknown }).opId;
  return typeof id === 'string' && id ? id : undefined;
}

/** The task a record writes (v1 op or v2 kinds), for give-up and the letter. */
function recordTask(batch: Batch, record: OfflineRecord): string | undefined {
  if (record.kind === 'op') return record.op.startsWith('trigger_') ? undefined : String(record.args?.id ?? record.args?.task ?? '') || undefined;
  if (V1_KINDS.has(record.kind)) return undefined;
  return v2TaskIdOf(record as unknown as V2Record, batch.remap, batch.conn.hostKey);
}

/**
 * Take one record: 'ack' (applied, a no-op, refused into the letter, or given up),
 * 'stop' (it threw and waits for its backoff; later records wait behind it), or
 * 'leave' (a kind this Mac does not know: never acked, the next Mac takes it).
 */
async function takeRecord(batch: Batch, record: OfflineRecord): Promise<'ack' | 'stop' | 'leave'> {
  const host = batch.conn.hostKey;
  const known = V1_KINDS.has(record.kind) || (APPLIED_V2_KINDS as readonly string[]).includes(record.kind);
  if (!known) {
    log.session.warn('offline handover: a record of a kind this Mac does not know is left on the host', { host, seq: record.seq, kind: record.kind });
    return 'leave';
  }
  const opId = recordOpId(record);
  const taskId = recordTask(batch, record);
  const rev = Number((record as { rev?: unknown }).rev) || 1;
  const key = opId ? { hostKey: host, home: WALNUT_HOME, opId, rev } : null;
  const { lookupJournaled, recordApplied, reserveJournaled } = await import('./offline-merge/ledger.js');
  const actor = (record as { actor?: { kind?: string; deviceId?: string; name?: string } }).actor;
  const callerSid = record.kind === 'op' ? record.callerSid : actor?.kind === 'session' ? String((actor as { sid?: unknown }).sid ?? '') : '';
  // The op a session called, for the notice it gets when its write did not land.
  const opName = record.kind === 'op' ? record.op : (record.kind as string) === 'letter' ? 'human_inbox_send' : record.kind;
  const retryKey = `${host}|${opId ?? `seq:${record.seq}`}`;
  // A record whose letter entry could not be written waits out its backoff first.
  const letterWait = letterFailing.get(retryKey);
  if (letterWait && letterWait.nextAt > Date.now()) {
    batch.retryIn = Math.min(batch.retryIn ?? Infinity, letterWait.nextAt - Date.now());
    return 'stop';
  }
  /** A note record's bodies, read from the host once per take (noteBodies). */
  let bodies: Promise<NoteBodies | null> | undefined;
  /**
   * A letter entry for this record, durable BEFORE the ledger row or the ack that would
   * let a redrain skip it (offline-merge/conflict-log.ts addDurable). False: the log could
   * not be written, nothing is recorded, and the record waits for its backoff
   * (letterNotWritten; true once the steps are spent, the entry kept in memory). A note
   * record's entry carries its bodies in full (the host frees them at the ack); false
   * when they cannot be read from the host.
   */
  const letter = async (kind: import('./offline-merge/conflict-log.js').ConflictKind, reason: string): Promise<boolean> => {
    let attached: NoteBodies | null = {};
    if (isNoteRecord(record)) {
      bodies ??= noteBodies(batch, record);
      attached = await bodies;
      if (!attached) return false;
    }
    const entry = { kind, seq: record.seq, ...(opId ? { opId } : {}), recordKind: record.kind, ...(taskId ? { taskId } : {}), reason, record, ...(actor ? { actor } : {}), ...attached };
    try {
      batch.conflicts.addDurable([entry]);
      letterFailing.delete(retryKey);
      logDiskErrorHosts.delete(host);
      return true;
    } catch (err) {
      return letterNotWritten(batch, record, entry, retryKey, err);
    }
  };
  // The ledger first: a write a forward (or an earlier drain) applied is never lettered as
  // not applied, whoever made it (a device unpaired since) and whatever became of the
  // task's earlier records.
  const early = key ? lookupJournaled(key) : null;
  if (early) return ledgerHit(batch, record, early, { retryKey, taskId, callerSid, opName, letter });
  if (giveUpKeys(record, taskId).some((k) => batch.givenUp.has(k))) {
    const what = (record.kind as string) === 'memory' ? 'memory document' : isNoteRecord(record) || (record.kind as string) === 'note-move' ? 'note'
      : (record.kind as string) === 'conversation-edit' ? 'chat' : 'task';
    if (!(await letter('given-up', `an earlier change to this ${what} could not be applied, so this later one was not applied either`))) return 'stop';
    if (key) recordApplied(key, { outcome: 'given-up', detail: 'earlier record of the task given up', source: 'drain' });
    batch.result.failed++;
    return 'ack';
  }
  if (actor?.kind === 'device' && !(await devicePaired(String(actor.deviceId ?? '')))) {
    // A device that removed itself and is already gone here: nothing is lost, nothing to tell.
    if ((record as { kind: string }).kind === 'device-revoke') {
      if (key) recordApplied(key, { outcome: 'noop', detail: 'device already gone', source: 'drain' });
      batch.result.skipped++;
      log.session.info('offline handover: a device removed while away was already gone', { host, seq: (record as { seq?: number }).seq, opId, deviceId: actor.deviceId });
      return 'ack';
    }
    if (!(await letter('actor-dropped', `${actor.name ?? actor.deviceId} is no longer paired with this Mac`))) return 'stop';
    if (key) recordApplied(key, { outcome: 'refused', detail: 'device no longer paired', source: 'drain' });
    batch.result.skipped++;
    log.session.warn('offline handover: a change from a device no longer paired is dropped', { host, seq: record.seq, opId, deviceId: actor.deviceId });
    return 'ack';
  }
  const fail = failing.get(retryKey);
  if (fail && fail.nextAt > Date.now()) {
    // A rerun before the backoff ran out (a host.slice push) takes no attempt.
    batch.retryIn = Math.max(0, fail.nextAt - Date.now());
    return 'stop';
  }
  // The ledger: a forward (or an earlier drain) that applied this op already wins; one still
  // running here is waited for.
  let held: import('./offline-merge/ledger.js').Reserved | null = null;
  if (key) {
    for (let i = 0; i < RESERVE_TRIES; i++) {
      // Under the host's key or, for a forward on a socket nobody tagged, this server's own.
      const hit = lookupJournaled(key);
      if (hit) return ledgerHit(batch, record, hit, { retryKey, taskId, callerSid, opName, letter });
      const r = reserveJournaled(key);
      if (r.owner) { held = r; break; }
      // Bounded: a write handler that never answers while its client stays connected must
      // not pin this host's handover (every later drain joins this one).
      if (!(await settlesWithin(r.wait, reservationWaitMs))) break;
    }
    if (!held) {
      const hit = lookupJournaled(key);
      if (hit) return ledgerHit(batch, record, hit, { retryKey, taskId, callerSid, opName, letter });
      // The same op is still running here (or kept being taken first): never applied beside
      // it. The record and everything after it wait for a short retry.
      batch.retryIn = Math.min(batch.retryIn ?? Infinity, RESERVED_RETRY_MS);
      log.session.info('offline handover: the same write is still running here; the record waits', { host, seq: record.seq, opId });
      return 'stop';
    }
  }
  return applyTaken(batch, record, { key, held, retryKey, fail, taskId, callerSid, opName, letter });
}

/**
 * The conflict log could not take a record's entry: false (the record waits for its
 * backoff, counted like a failed apply), or true once the steps are spent (the entry is
 * kept for this drain's letter only and the record is acked). One error per host.
 */
function letterNotWritten(
  batch: Batch, record: OfflineRecord, entry: import('./offline-merge/conflict-log.js').ConflictEntry, retryKey: string, err: unknown,
): boolean {
  const host = batch.conn.hostKey;
  const error = err instanceof Error ? err.message : String(err);
  const count = (letterFailing.get(retryKey)?.count ?? 0) + 1;
  if (count > retryBackoffMs.length && isNoteRecord(record)) {
    // A note's text lives only on the host until the ack frees it: an entry kept in this
    // process alone would be gone with it. The record waits at the last step instead.
    const wait = retryBackoffMs[retryBackoffMs.length - 1] ?? RESERVED_RETRY_MS;
    letterFailing.set(retryKey, { count: retryBackoffMs.length, nextAt: Date.now() + wait });
    batch.retryIn = Math.min(batch.retryIn ?? Infinity, wait);
    log.session.warn('offline handover: a note change waits on the host until the conflict log can be written', { host, seq: record.seq, opId: entry.opId, retryInMs: wait, error });
    return false;
  }
  if (count > retryBackoffMs.length) {
    letterFailing.delete(retryKey);
    batch.conflicts.addMemoryOnly(entry);
    log.session.error('offline handover: the conflict log could not be written after every retry; the record is acked and its entry is only in this drain\'s letter', { host, seq: record.seq, opId: entry.opId, error });
    return true;
  }
  const wait = retryBackoffMs[count - 1];
  letterFailing.set(retryKey, { count, nextAt: Date.now() + wait });
  batch.retryIn = Math.min(batch.retryIn ?? Infinity, wait);
  if (!logDiskErrorHosts.has(host)) {
    logDiskErrorHosts.add(host);
    log.session.error('offline handover: the conflict log could not be written; the record waits', { host, seq: record.seq, opId: entry.opId, attempt: count, retryInMs: wait, error });
  } else {
    log.session.warn('offline handover: the conflict log still cannot be written', { host, seq: record.seq, attempt: count, retryInMs: wait });
  }
  return false;
}

interface TakeState {
  retryKey: string;
  taskId: string | undefined;
  callerSid: string | undefined;
  opName: string;
  letter: (kind: import('./offline-merge/conflict-log.js').ConflictKind, reason: string) => Promise<boolean>;
}

/** A note record's texts for its letter entry: the base it was made on and the save itself. */
type NoteBodies = { notePath?: string; base?: string; replica?: string; bodiesLost?: true };

/**
 * A record whose texts live only on the host until its ack (a note, a memory doc saved on
 * the companion): a letter about it carries them in full.
 */
function isNoteRecord(record: OfflineRecord): boolean {
  return (record.kind as string) === 'note' || (record.kind as string) === 'memory';
}

/**
 * What a give-up of this record gives up with it: its task, or for a note record its
 * path and id, so a later save of that note never merges onto a base that went into the
 * letter (a note record names no task).
 */
function giveUpKeys(record: OfflineRecord, taskId: string | undefined): string[] {
  const r = record as { path?: unknown; noteId?: unknown; doc?: unknown; from?: unknown; to?: unknown; agentId?: unknown; conversationId?: unknown };
  // A chat's later list changes wait behind one that could not be applied (4d).
  if ((record.kind as string) === 'conversation-edit') return typeof r.conversationId === 'string' ? [`conversation:${String(r.agentId)}/${r.conversationId}`] : [];
  // A note move (4d) names both of its paths: a save at either waits behind it.
  if ((record.kind as string) === 'note-move') {
    return [
      ...[r.from, r.to].filter((p): p is string => typeof p === 'string' && !!p).map((p) => `note:${p}`),
      ...(typeof r.noteId === 'string' && r.noteId ? [`note-id:${r.noteId}`] : []),
    ];
  }
  if (!isNoteRecord(record)) return taskId ? [taskId] : [];
  if ((record.kind as string) === 'memory') return typeof r.doc === 'string' ? [`memory:${r.doc}`] : [];
  return [
    ...(typeof r.path === 'string' && r.path ? [`note:${r.path}`] : []),
    ...(typeof r.noteId === 'string' && r.noteId ? [`note-id:${r.noteId}`] : []),
  ];
}

/**
 * The texts of a note record acked without being applied (given up, refused, dropped):
 * the daemon frees a record's bodies at its ack (offline-journal-core.ts), so the letter
 * entry carries them in full ("the change is attached"). Null when the host cannot hand
 * one over: the record is not acked and waits for a later drain.
 */
async function noteBodies(batch: Batch, record: OfflineRecord): Promise<NoteBodies | null> {
  const r = record as { path?: unknown; baseBlob?: unknown; oursBlob?: unknown; seq: number; opId?: unknown };
  const { fetchOfflineBlob } = await import('./offline-merge/blob.js');
  const text = async (sha: unknown): Promise<string | undefined> =>
    typeof sha === 'string' && sha ? (await fetchOfflineBlob(batch.conn, sha, RPC_TIMEOUT_MS)).toString('utf8') : undefined;
  /** One body; `lost` when the host answers that it does not hold it (the other may still be there). */
  const each = async (sha: unknown): Promise<string | undefined | 'lost'> => {
    try { return await text(sha) } catch (err) { if ((err as { code?: unknown }).code === 'not_found') return 'lost'; throw err }
  };
  try {
    const base = await each(r.baseBlob);
    const replica = await each(r.oursBlob);
    // The away text is what the letter is for: a lost base never costs it.
    if (replica !== 'lost' || base !== 'lost') {
      if (replica === 'lost' || base === 'lost') {
        log.session.warn('offline handover: a note change that was not applied lost one of its texts on the host; lettered with the other', {
          host: batch.conn.hostKey, seq: r.seq, opId: typeof r.opId === 'string' ? r.opId : undefined, lost: replica === 'lost' ? 'replica' : 'base',
        });
      }
      return {
        ...(typeof r.path === 'string' && r.path ? { notePath: r.path } : {}),
        ...(base !== undefined && base !== 'lost' ? { base } : {}), ...(replica !== undefined && replica !== 'lost' ? { replica } : {}),
        ...(replica === 'lost' ? { bodiesLost: true as const } : {}),
      };
    }
    throw Object.assign(new Error('offline.blob: not on the host'), { code: 'not_found' });
  } catch (err) {
    // The host answered that it does not hold the body (cleaned up, a damaged journal): no
    // later take reads it either, and waiting would hold every later record of the host. The
    // letter says the text is gone; the record is acked.
    if ((err as { code?: unknown }).code === 'not_found') {
      log.session.warn('offline handover: a note change that was not applied has no text left on the host; lettered without it', {
        host: batch.conn.hostKey, seq: r.seq, opId: typeof r.opId === 'string' ? r.opId : undefined,
      });
      return { ...(typeof r.path === 'string' && r.path ? { notePath: r.path } : {}), bodiesLost: true };
    }
    const wait = retryBackoffMs[retryBackoffMs.length - 1] ?? RESERVED_RETRY_MS;
    batch.retryIn = Math.min(batch.retryIn ?? Infinity, wait);
    log.session.warn('offline handover: a note change that was not applied waits on the host: its text could not be read for the letter', {
      host: batch.conn.hostKey, seq: r.seq, opId: typeof r.opId === 'string' ? r.opId : undefined, retryInMs: wait, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The ledger already holds the op: an apply (a forward, an earlier drain) acks silently.
 * A direct write this Mac REFUSED, whose answer the client never got (the stream died,
 * the replica answered 504, the client retried and the replica journaled it), is the
 * user's change that did not land: it is lettered with the Mac's answer, never dropped.
 */
async function ledgerHit(
  batch: Batch, record: OfflineRecord, hit: import('./offline-merge/ledger.js').LedgerEntry, st: TakeState,
): Promise<'ack' | 'stop'> {
  const host = batch.conn.hostKey;
  const opId = recordOpId(record);
  if ((hit.outcome === 'refused' || hit.outcome === 'given-up') && hit.source !== 'drain') {
    const answer = hit.detail ?? (hit.body ? hit.body.slice(0, 500) : '');
    const reason = `the Mac refused this write when it first reached it${hit.status ? ` (HTTP ${hit.status})` : ''}${answer ? `: ${answer}` : ''}`;
    if (!(await st.letter('refused', reason))) return 'stop';
    batch.result.failed++;
    if (st.callerSid) batch.unapplied.push({ callerSid: st.callerSid, op: st.opName, taskId: st.taskId ?? '', reason });
    log.session.warn('offline handover: a journaled retry of a write the Mac refused is lettered', { host, seq: record.seq, opId, status: hit.status });
  } else {
    // Given up by an earlier drain whose ack was lost: the later records of the same task or
    // note in this handover are given up with it, as on that drain.
    if (hit.outcome === 'given-up') for (const k of giveUpKeys(record, st.taskId)) batch.givenUp.add(k);
    if ((record.kind as string) === 'task-create' && hit.source !== 'drain' && (await createdAs(batch, record, hit, st)) === 'stop') return 'stop';
    batch.result.skipped++;
    log.session.info('offline handover: record already applied (ledger)', { host, seq: record.seq, opId });
  }
  failing.delete(st.retryKey);
  return 'ack';
}

/**
 * A create the Mac applied when its forward reached it made the task under the Mac's own
 * id, while the client that got the replica's journaled answer knows only the id the
 * writer minted, and every later record of that task names it. The created id is read
 * from the stored answer (`task.id`, else `id`) and the minted one remapped to it, the
 * way a collision re-mint is, so those records follow it. An answer that was not kept
 * (too large) cannot be followed: it is lettered, never acked in silence.
 */
async function createdAs(
  batch: Batch, record: OfflineRecord, hit: import('./offline-merge/ledger.js').LedgerEntry, st: TakeState,
): Promise<'ok' | 'stop'> {
  const host = batch.conn.hostKey;
  const minted = String((record as { taskId?: unknown }).taskId ?? '');
  if (!minted) return 'ok';
  let created: string | undefined;
  try {
    const body = hit.body === undefined ? undefined : JSON.parse(hit.body) as { task?: { id?: unknown }; id?: unknown };
    const id = body?.task?.id ?? body?.id;
    created = typeof id === 'string' && id ? id : undefined;
  } catch { created = undefined; }
  if (created === undefined) {
    const reason = `the Mac created this task when the write first reached it, under an id it did not keep; changes made while away to ${minted} after it may be missing`;
    return (await st.letter('create-collision', reason)) ? 'ok' : 'stop';
  }
  if (created === minted) return 'ok';
  try {
    recordRemap(host, WALNUT_HOME, minted, created);
  } catch (err) {
    batch.retryIn = Math.min(batch.retryIn ?? Infinity, retryBackoffMs[0] ?? RESERVED_RETRY_MS);
    log.session.warn('offline handover: the id of a forwarded create could not be remembered; the record waits', { host, seq: record.seq, minted, created, error: err instanceof Error ? err.message : String(err) });
    return 'stop';
  }
  batch.remap.set(minted, created);
  log.session.info('offline handover: a create the Mac applied over HTTP: later records of its minted id follow the Mac\'s id', { host, seq: record.seq, minted, created });
  return 'ok';
}

/** The task's updated_at before this drain writes to it (0 for a task not made yet: nothing on it is newer). */
async function keepBaseline(baseline: Map<string, number>, taskId: string): Promise<void> {
  const { getTask } = await import('./task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  baseline.set(task?.id ?? taskId, task ? Date.parse(task.updated_at ?? '') || 0 : 0);
}

/** Apply a record the ledger does not hold, then record it (after its letter entries are on disk). */
async function applyTaken(
  batch: Batch, record: OfflineRecord,
  st: TakeState & {
    key: import('./offline-merge/ledger.js').LedgerKey | null;
    held: import('./offline-merge/ledger.js').Reserved | null;
    fail: { count: number; nextAt: number; reason: string } | undefined;
  },
): Promise<'ack' | 'stop'> {
  const host = batch.conn.hostKey;
  const opId = recordOpId(record);
  const { key, held, retryKey, fail, taskId, callerSid, opName, letter } = st;
  const { recordApplied, lookupJournaled } = await import('./offline-merge/ledger.js');
  const owned = held?.owner ? held : null;
  try {
    if (V1_KINDS.has(record.kind)) {
      await applyRecord(host, record, batch.baseline, batch.result, batch.unapplied);
    } else {
      // A v1 record of this task later in the drain (an old Mac led between the two, R25)
      // judges "a newer edit" against the task as it was before this drain wrote to it:
      // this record was queued before that one, so its write is never the newer edit.
      if (taskId && !batch.baseline.has(taskId)) await keepBaseline(batch.baseline, taskId);
      await applyV2({ hostKey: host, at: record.at + batch.offset, offset: batch.offset, conflicts: batch.conflicts, remap: batch.remap, result: batch.result, conn: batch.conn }, record as unknown as V2Record);
    }
    // Every entry the apply wrote is on disk already (addDurable); this is the round's no-op.
    batch.conflicts.flush();
    if (key) {
      recordApplied(key, { outcome: 'applied', source: 'drain' });
      // A coalesced record carries the op ids of every save folded into it: a client
      // retry of any of them is the same write, answered as applied.
      const saves = (record as { saveOpIds?: unknown }).saveOpIds;
      // A save also applied directly keeps its own row (its route and first answer).
      for (const s of Array.isArray(saves) ? saves : []) {
        if (typeof s !== 'string' || !s || s === opId) continue;
        const saveKey = { hostKey: host, home: WALNUT_HOME, opId: s, rev: 1 };
        if (!lookupJournaled(saveKey)) recordApplied(saveKey, { outcome: 'applied', source: 'drain', detail: `folded into ${opId}` });
      }
    }
    owned?.finish({ outcome: 'applied' });
    failing.delete(retryKey);
    return 'ack';
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof RefusedWrite && await letter((record.kind as string) === 'board' || (record.kind === 'op' && record.op.startsWith('board_')) ? 'board' : 'refused', reason)) {
      // The server's own answer to the write, the one the same call made online gets:
      // lettered (on disk first) and acked at once, and the session that made it is told.
      batch.result.failed++;
      log.session.warn('offline handover: queued write refused', { host, seq: record.seq, kind: record.kind, op: opName, opId, taskId, callerSid, error: reason });
      if (key) recordApplied(key, { outcome: 'refused', detail: reason, source: 'drain' });
      owned?.finish({ outcome: 'refused', detail: reason });
      failing.delete(retryKey);
      if (callerSid) batch.unapplied.push({ callerSid, op: opName, taskId: taskId ?? '', reason });
      return 'ack';
    }
    owned?.finish(null);
    const count = (fail?.count ?? 0) + 1;
    if (count <= retryBackoffMs.length) {
      const wait = retryBackoffMs[count - 1];
      failing.set(retryKey, { count, nextAt: Date.now() + wait, reason });
      batch.retryIn = wait;
      batch.result.failed++;
      // Walnut could not apply its own record: an error named by the session it concerns,
      // so the card retires on that session's next clean turn. Later records wait.
      // Section 13 observability (a warn: the error line below is the notification center's, unchanged).
      log.session.warn('drain record failed', { host, seq: record.seq, kind: record.kind, opId, attempt: count, nextRetryMs: wait, error: reason });
      log.session.error('offline handover: record failed', { host, seq: record.seq, kind: record.kind, opId, attempt: count, retryInMs: wait, error: reason, ...await recordScope(record) });
      return 'stop';
    }
    // Retries spent: given up into the letter with the change attached (a note's texts in
    // full), and every later record of the same task or note with it. A letter that cannot
    // be written, or a note text the host cannot hand over, keeps the record.
    if (!(await letter('given-up', reason))) return 'stop';
    failing.delete(retryKey);
    batch.result.failed++;
    for (const k of giveUpKeys(record, taskId)) batch.givenUp.add(k);
    if (key) recordApplied(key, { outcome: 'given-up', detail: reason, source: 'drain' });
    log.session.warn('drain record failed', { host, seq: record.seq, kind: record.kind, opId, attempt: count, nextRetryMs: null, givenUp: true, error: reason });
    log.session.error('offline handover: record failed', { host, seq: record.seq, kind: record.kind, error: reason, givenUp: true, ...await recordScope(record) });
    if (callerSid) batch.unapplied.push({ callerSid, op: opName, taskId: taskId ?? '', reason });
    return 'ack';
  }
}

/**
 * The host answered "saved, applied when the server reconnects"; when that turns
 * out false, the session that made the write is told, once per session, which
 * changes did not land and why. Best effort: a caller that is gone keeps only
 * the log line.
 */
async function tellCallers(unapplied: Unapplied[]): Promise<void> {
  const bySession = new Map<string, Unapplied[]>();
  for (const u of unapplied) bySession.set(u.callerSid, [...(bySession.get(u.callerSid) ?? []), u]);
  const [{ getSessionByClaudeId }, { buildWalnutMessage }, { deliverToSession }] = await Promise.all([
    import('./session-tracker.js'),
    import('./peers/walnut-message-tag.js'),
    import('./sessions/session-send-core.js'),
  ]);
  for (const [sid, items] of bySession) {
    try {
      const session = await getSessionByClaudeId(sid);
      if (!session) continue;
      const text = buildWalnutMessage({
        kind: 'notification',
        attrs: { from: 'Walnut', note: 'automated Walnut status notice' },
        body: [
          'While the Walnut server was away, this host saved changes you made and said they would be applied later. These were NOT applied:',
          ...items.map((u) => `- ${u.op}${u.taskId ? ` ${u.taskId}` : ''}: ${u.reason}`),
          'Read the task (walnut tools call task_get) and redo the change if it still applies.',
        ].join('\n'),
      });
      await deliverToSession(session, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: session.taskId });
    } catch (err) {
      log.session.warn('offline handover: could not tell the caller about unapplied writes', {
        callerSid: sid, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function toRequest(row: Extract<OfflineRecord, { kind: 'row' }>['row']): SessionRequest {
  return {
    id: row.id,
    fromSessionId: row.fromSessionId,
    toSessionId: row.toSessionId,
    ...(row.toTaskId ? { toTaskId: row.toTaskId } : {}),
    preview: row.preview,
    status: row.status,
    createdAt: row.createdAt,
    deadlineAt: row.deadlineAt,
    ...(row.settledAt ? { settledAt: row.settledAt } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
  };
}

async function applyRecord(
  host: string,
  record: OfflineRecord,
  baseline: Map<string, number>,
  result: HandoverResult,
  unapplied: Unapplied[],
): Promise<void> {
  switch (record.kind) {
    case 'row': {
      const { importOfflineRequest } = await import('./session-requests.js');
      if (await importOfflineRequest(toRequest(record.row))) result.imported++;
      return;
    }
    case 'settle': {
      const { settleReplied } = await import('./session-requests.js');
      if (await settleReplied(record.requestId)) result.settled++;
      return;
    }
    case 'delivery': {
      // The online send reopens a COMPLETE task a peer writes to; the offline
      // delivery did the same work, so the board says the same thing.
      const taskId = record.reply ? await taskOfSession(record.toSessionId) : (record.toTaskId ?? await taskOfSession(record.toSessionId));
      if (!taskId) return;
      const { getTask } = await import('./task-manager.js');
      const task = await getTask(taskId).catch(() => null);
      if (task?.phase !== 'COMPLETE') return;
      const { applySessionPhase } = await import('./phase.js');
      await applySessionPhase(taskId, 'session:input', 'offline-handover', { sessionId: record.toSessionId, reopenTerminal: true });
      return;
    }
    case 'op': {
      // A Board write made on the host (offline-board-core.ts), or a trigger the
      // host paused, resumed or deleted (its checks run there): replayed through
      // the same op, whose own checks decide (an edit whose text moved on is
      // refused, and the writer is told). There is no updated_at race to judge
      // here: nobody writes a board's html, or switches a host's trigger, on this
      // side while that host's sessions are away.
      if (record.op.startsWith('board_') || record.op.startsWith('trigger_')) {
        const { executeOp } = await import('../ops/index.js');
        const { hostOrigin } = await import('../lib/caller-origin.js');
        const r = await executeOp(record.op, record.args, { callerSid: record.callerSid, callerHost: host, origin: hostOrigin(host) });
        if (!r.ok) throw r.unreachable ? new Error(r.message) : new RefusedWrite(r.message);
        result.replayed++;
        if (record.op.startsWith('board_')) {
          log.session.info('offline handover: board write applied', { host, op: record.op, boardTaskId: String(record.args.task ?? ''), callerSid: record.callerSid });
        } else {
          log.session.info('offline handover: trigger change applied', { host, op: record.op, triggerId: String(record.args.id ?? ''), callerSid: record.callerSid });
        }
        return;
      }
      const taskId = String(record.args.id ?? '');
      const { getTask } = await import('./task-manager.js');
      const task = await getTask(taskId).catch(() => null);
      if (!task) {
        result.skipped++;
        log.session.warn('offline handover: queued write skipped, task gone', { host, op: record.op, taskId });
        unapplied.push({ callerSid: record.callerSid, op: record.op, taskId, reason: 'the task no longer exists' });
        return;
      }
      if (!baseline.has(task.id)) baseline.set(task.id, Date.parse(task.updated_at ?? '') || 0);
      // A newer edit wins. "Newer" is judged on BOTH clocks the write carries:
      // the host's own time (`at`) and the server's stamp on the copy the writer
      // read (`base`). A host clock running behind makes `at` look older than a
      // change that came before the copy; `base` is what keeps that write.
      const base = Date.parse(record.base ?? '') || 0;
      if ((baseline.get(task.id) ?? 0) > Math.max(record.at, base)) {
        result.skipped++;
        log.session.warn('offline handover: queued write skipped, the task changed after it was queued', {
          host, op: record.op, taskId: task.id, queuedAt: new Date(record.at).toISOString(), updatedAt: task.updated_at,
          callerSid: record.callerSid,
        });
        unapplied.push({ callerSid: record.callerSid, op: record.op, taskId: task.id, reason: 'the task changed after this change was queued, and the newer change wins' });
        return;
      }
      const { executeOp } = await import('../ops/index.js');
      const { hostOrigin } = await import('../lib/caller-origin.js');
      const r = await executeOp(record.op, record.args, { callerSid: record.callerSid, callerHost: host, origin: hostOrigin(host) });
      // The server's own words; the log line and the caller's notice name the op.
      // A refusal is the server's answer (a 5xx is carded by its route); no
      // answer at all is Walnut failing its own write.
      if (!r.ok) throw r.unreachable ? new Error(r.message) : new RefusedWrite(r.message);
      result.replayed++;
      log.session.info('offline handover: queued write applied', { host, op: record.op, taskId: task.id, callerSid: record.callerSid });
      return;
    }
    case 'settings': {
      // The companion changed a live session's model, effort or permission mode
      // while it led. The CLI already runs with it; the record keeps it for a
      // cold resume.
      const patch: { cliModel?: string; effort?: SessionEffort } = {};
      if (typeof record.cliModel === 'string' && record.cliModel) patch.cliModel = record.cliModel;
      if (typeof record.effort === 'string' && VALID_SESSION_EFFORT_IDS.has(record.effort)) patch.effort = record.effort as SessionEffort;
      const mode = typeof record.mode === 'string' && VALID_SESSION_MODE_IDS.has(record.mode) ? record.mode as SessionMode : undefined;
      if (!patch.cliModel && !patch.effort && !mode) return;
      const { updateSessionRecord, getSessionByClaudeId } = await import('./session-tracker.js');
      if (patch.cliModel || patch.effort) await updateSessionRecord(record.sid, patch);
      if (mode) {
        // The same write as the Mac's own mode change: the task's plan and
        // exec slots follow the mode.
        const existing = await getSessionByClaudeId(record.sid);
        if (existing) await (await import('./sessions/session-lifecycle.js')).persistSessionModeChange(existing, record.sid, mode);
      }
      // A live session object here would write its own (older) values back; it
      // also reads back what the CLI now runs, as the Mac's own change does.
      const { sessionRunner } = await import('../providers/claude-code-session.js');
      const live = sessionRunner.findByClaudeId(record.sid);
      if (live) {
        live.adoptAppliedSettings({ ...patch, ...(mode ? { mode } : {}) });
        if (patch.cliModel || patch.effort) void live.refreshAppliedSettings('companion-settings').catch(() => null);
      }
      result.replayed++;
      log.session.info('offline handover: settings the companion applied are kept', { host, sessionId: record.sid, ...patch, ...(mode ? { mode } : {}) });
      return;
    }
    case 'resume': {
      // The host started a stopped session again to hand it a trigger fire no
      // server claimed (the fire itself is recorded from the trigger's replay).
      // Our record still says stopped; handover() has the connection look at it.
      const set = resumesToRescue.get(host) ?? new Set<string>();
      set.add(record.sid);
      resumesToRescue.set(host, set);
      result.replayed++;
      log.session.info('offline handover: the host resumed a stopped session for a trigger fire', { host, sessionId: record.sid, taskId: record.taskId, messageId: record.messageId });
      return;
    }
    case 'stop': {
      // The user stopped the session through the companion while it led. It
      // becomes this server's own stop request, same id and time, so the phone's
      // next message is fenced by the stop it saw; handover() then runs it
      // through the usual stop path, which parks the queued messages and finds
      // the process already gone.
      const { getSessionByClaudeId, updateSessionRecord } = await import('./session-tracker.js');
      const existing = await getSessionByClaudeId(record.sid);
      if (!existing) return;
      const mine = Date.parse(existing.stopRequest?.requestedAt ?? '');
      if (existing.stopRequest && (existing.stopRequest.id === record.stopRequestId || (Number.isFinite(mine) && mine >= Date.parse(record.requestedAt)))) {
        result.skipped++;
        return;
      }
      await updateSessionRecord(record.sid, { stopRequest: { id: record.stopRequestId, requestedAt: record.requestedAt, state: 'pending' } });
      stopsToRun.add(host);
      result.replayed++;
      log.session.info('offline handover: a stop the companion sent is recorded', { host, sessionId: record.sid, stopRequestId: record.stopRequestId });
      return;
    }
  }
}

/** Hosts whose drained stops this handover still runs (handover()). */
const stopsToRun = new Set<string>();
/** Sessions a host resumed itself, by host, that this handover still looks at (handover()). */
const resumesToRescue = new Map<string, Set<string>>();

/** The session (and task) a record is about, for the log line and the card's lifecycle. */
async function recordScope(record: OfflineRecord): Promise<{ sessionId?: string; taskId?: string }> {
  switch (record.kind) {
    // A trigger's id is a routine's, not a task's.
    case 'op': return { sessionId: record.callerSid, taskId: record.op.startsWith('trigger_') ? undefined : String(record.args?.id ?? record.args?.task ?? '') || undefined };
    case 'row': return { sessionId: record.row.fromSessionId };
    case 'delivery': return { sessionId: record.toSessionId };
    case 'settings': return { sessionId: record.sid };
    case 'stop': return { sessionId: record.sid };
    case 'resume': return { sessionId: record.sid, taskId: record.taskId };
    case 'settle': {
      const { getSessionRequest } = await import('./session-requests.js');
      const row = await getSessionRequest(record.requestId).catch(() => undefined);
      return row ? { sessionId: row.fromSessionId } : {};
    }
  }
  return v2Scope(record as unknown as V2Record);
}

/** Journal v2 kinds: the session that wrote it (a device or trigger names none), and its task. */
function v2Scope(record: V2Record): { sessionId?: string; taskId?: string } {
  const actor = record.actor;
  const sid = actor && actor.kind === 'session' ? actor.sid : undefined;
  const taskId = v2TaskIdOf(record);
  return { ...(sid ? { sessionId: sid } : {}), ...(taskId ? { taskId } : {}) };
}

async function taskOfSession(sid: string): Promise<string | undefined> {
  const { getSessionByClaudeId } = await import('./session-tracker.js');
  return (await getSessionByClaudeId(sid).catch(() => null))?.taskId || undefined;
}
