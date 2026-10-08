/**
 * Projection cache — the NON-git home for the "cache trio" (session projection,
 * task projection, transcript tails) plus the Mac→cloud bridge push that keeps
 * the cloud copy warm. Phase 3 of the data-architecture plan: these snapshots
 * used to be git-tracked files whose 3s-debounced rewrites made up ~87% of all
 * data-repo commits — git was acting as a message bus. Now the payloads live
 * under WALNUT_HOME/cache/ (gitignored) on BOTH boxes and travel over the
 * daemon's dialed-out /bridge websocket instead of git-sync.
 *
 * Files (same layout on primary and cloud):
 *   cache/projections/sessions.json   — SessionProjection envelope
 *   cache/projections/tasks.json      — TaskProjection envelope
 *   cache/transcripts/<sid>.json      — SessionTranscript tail per session
 *
 * Writers:
 *   Primary: session-projection.ts / task-projection.ts exporters (debounced),
 *     which also call pushProjectionToCloud() after each write.
 *   Cloud: events-v1.ts handleBridgeMobileEvent routes the pushed
 *     'projection-upsert' / 'transcript-upsert' frames here.
 *
 * Readers: ONLY via the three seam functions (readSessionProjection /
 * readSessionTranscript / readTaskProjection), which try these cache paths
 * first and fall back to the legacy git-synced files during the transition.
 *
 * Modeled on history-disk-cache.ts: local-disk persistence (survives restarts —
 * the pushed data is authoritative on the cloud box), null on missing/corrupt.
 * Writes are atomic via writeJsonFile (which also mkdir -p's the parent).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECTION_CACHE_DIR, TRANSCRIPT_CACHE_DIR, CLOUD_MODE } from '../constants.js';
import { writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';
import * as ingest from './cloud-ingest.js';
import {
  INGEST_LANE, SELF_HEAL_INTERVAL_MS, alreadyHeld, forgetDelivery, preparePush, rememberDelivery,
  _resetProjectionPushStateForTesting,
} from './projection-push-state.js';

export { preparePush } from './projection-push-state.js';

export type ProjectionKind = 'sessions' | 'tasks';

/** Same safe-id alphabet the transcript seam enforces (ids land in filenames). */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Bridge frame budget. The ws maxPayload is 32MB, but one oversized frame
 *  (1009 close) kills every in-flight RPC on the shared bridge socket
 *  (2026-08-09 incident) — cap far below it. Transcripts are pre-clipped
 *  (TRANSCRIPT_TAIL rows × TEXT_MAX chars) so this should never fire.
 *
 *  Exported because a LIST projection can genuinely reach it: a payload past
 *  this cap is skipped outright below, so the cloud replica keeps serving its
 *  previous copy forever (silent staleness, not an error). The session exporter
 *  therefore sizes its own row budget against this number instead of guessing —
 *  see PROJECTION_BYTE_BUDGET in session-projection.ts.
 *
 *  This is the budget for the TRANSCRIPT lane, whose content is user-shaped
 *  (message text) and therefore the thing a tight guard is actually for. */
export const PUSH_MAX_BYTES = 1_048_576; // 1MB

/**
 * Frame budget for the two LIST projections ('projection-upsert'). Deliberately
 * larger than PUSH_MAX_BYTES, because sizing them off the transcript guard was
 * itself a bug: the task projection reached 1,152,724 bytes at 3,079 rows and
 * every export since has been SKIPPED, freezing the cloud replica's task list
 * on its last-pushed copy. Trimming rows to fit 1MB was the wrong trade — the
 * same projection is what GET /api/v1/tasks serves to the LOCAL phone, and that
 * route filters (q/project/tag/status) over these rows with no paging, so a
 * dropped row is a task the phone cannot list OR find.
 *
 * 4MB is sized against the REAL limits on the path, all verified: the cloud's
 * WebSocketServer answers a frame past `maxPayload` with a 1009 close at 32MB
 * (src/web/ws/handler.ts), the daemon's own send queue closes a slow client at
 * 256MB (SEND_QUEUE_MAX_BYTES in daemon-standalone.ts), and daemon-connection
 * keeps the ws default 100MB. So this sits 8x below the nearest kill line while
 * carrying today's payload with 3.5x headroom. The list builders still enforce
 * their own byte budget beneath it (80% of this) so the frame can never be the
 * thing that discovers the ceiling — see PROJECTION_BYTE_BUDGET in
 * task-projection.ts / session-projection.ts.
 */
export const PROJECTION_PUSH_MAX_BYTES = 4 * 1_048_576; // 4MB

export function projectionCachePath(which: ProjectionKind): string {
  return path.join(PROJECTION_CACHE_DIR, `${which}.json`);
}

export function transcriptCachePath(sessionId: string): string {
  return path.join(TRANSCRIPT_CACHE_DIR, `${sessionId}.json`);
}

/** Atomic write of a projection envelope. Throws on I/O failure (callers on
 *  the export path treat a failed cache write as a failed export). */
export async function writeProjectionCache(which: ProjectionKind, payload: unknown): Promise<void> {
  await writeJsonFile(projectionCachePath(which), payload);
}

/** Parsed cache content or null (missing/corrupt/empty). Validation of the
 *  envelope (version gate etc.) stays with the seam functions. */
export async function readProjectionCache(which: ProjectionKind): Promise<unknown | null> {
  try {
    return JSON.parse(await fsp.readFile(projectionCachePath(which), 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

/** Atomic write of one session's transcript tail. Rejects unsafe ids. */
export async function writeTranscriptCache(sessionId: string, payload: unknown): Promise<void> {
  if (!SAFE_ID_RE.test(sessionId)) return;
  await writeJsonFile(transcriptCachePath(sessionId), payload);
}

export async function readTranscriptCache(sessionId: string): Promise<unknown | null> {
  if (!SAFE_ID_RE.test(sessionId)) return null;
  try {
    return JSON.parse(await fsp.readFile(transcriptCachePath(sessionId), 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

// ── Transition arbitration ──────────────────────────────────────────────────

/** Prefer the envelope with the newer exportedAt (ties → cache). Blind
 *  cache-first would serve a stale cache over a fresher git-synced legacy
 *  file during a long bridge outage while `sync.legacy_projection_files` is
 *  still on; once the legacy files are untracked this degenerates to
 *  cache-only. */
export function pickFresherEnvelope<T extends { exportedAt?: string }>(cache: T | null, legacy: T | null): T | null {
  if (!cache) return legacy;
  if (!legacy) return cache;
  const cacheAt = Date.parse(cache.exportedAt ?? '') || 0;
  const legacyAt = Date.parse(legacy.exportedAt ?? '') || 0;
  return legacyAt > cacheAt ? legacy : cache;
}

// ── Legacy git-file dual-write knob ─────────────────────────────────────────

let legacyFlagCache: { value: boolean; at: number } | null = null;
const LEGACY_FLAG_TTL_MS = 30_000;

/**
 * config `sync.legacy_projection_files` — while TRUE (the default), the
 * exporters ALSO write the legacy git-tracked files (sessions/projection.json,
 * tasks/projection.json, sessions/transcripts/) so a cloud box still running
 * pre-cache code keeps working off git-sync. Flip to false AFTER the cloud
 * deploy to kill the git churn (then untrack + gitignore the legacy paths).
 * TTL-cached: the flag is read on every debounced export and on inline
 * exports (GET /tasks, GET /sessions on the primary).
 */
export async function legacyProjectionFilesEnabled(): Promise<boolean> {
  if (legacyFlagCache && Date.now() - legacyFlagCache.at < LEGACY_FLAG_TTL_MS) {
    return legacyFlagCache.value;
  }
  let value = true; // fail-open to legacy: worst case is churn, never data loss
  try {
    const { getConfig } = await import('./config-manager.js');
    const config = await getConfig();
    value = config.sync?.legacy_projection_files !== false;
  } catch { /* unreadable config → default true */ }
  legacyFlagCache = { value, at: Date.now() };
  return value;
}

/** Tests only — drop the TTL'd flag and the pending-push retry set. */
export function _resetProjectionCacheForTesting(): void {
  legacyFlagCache = null;
  pendingTranscriptPushSids.clear();
  _resetProjectionPushStateForTesting();
}

// ── Mac → cloud push (the git-sync replacement) ─────────────────────────────

/** Transcript sids whose push was skipped or failed (bridge down at write
 *  time). The self-heal sweep re-pushes these from cache — without this, a
 *  session that STOPS during a bridge outage would never deliver its frozen
 *  final tail (alive sessions get re-swept every cycle; a stopped one is
 *  written exactly once). Bounded: past PENDING_PUSH_MAX the oldest entry is
 *  dropped (the cloud keeps its previous tail — stale, not absent). */
const pendingTranscriptPushSids = new Set<string>();
const PENDING_PUSH_MAX = 500;

function payloadSid(payload: unknown): string | null {
  const sid = (payload as { sid?: unknown } | null)?.sid;
  return typeof sid === 'string' && sid ? sid : null;
}

function notePendingTranscriptPush(payload: unknown): void {
  const sid = payloadSid(payload);
  if (!sid) return;
  if (pendingTranscriptPushSids.size >= PENDING_PUSH_MAX && !pendingTranscriptPushSids.has(sid)) {
    const oldest = pendingTranscriptPushSids.values().next().value;
    if (oldest !== undefined) pendingTranscriptPushSids.delete(oldest);
  }
  pendingTranscriptPushSids.add(sid);
}

/** Tests only. */
export function _pendingTranscriptPushSidsForTesting(): ReadonlySet<string> {
  return pendingTranscriptPushSids;
}

function pushKey(kind: 'projection-upsert' | 'transcript-upsert', payload: unknown): string | null {
  if (kind === 'projection-upsert') {
    const which = (payload as { which?: unknown } | null)?.which;
    return typeof which === 'string' ? `projection:${which}` : null;
  }
  const sid = payloadSid(payload);
  return sid ? `transcript:${sid}` : null;
}

export type ProjectionPushOutcome = 'sent' | 'unchanged' | 'skipped' | 'failed';


/**
 * Push a cache payload to the cloud companion: POST /bridge/ingest first, else
 * the legacy mobile-event lane (local daemon → its dialed-out /bridge WS → cloud
 * bridge-registry, hard-filtered to '__local__'). Both end in events-v1
 * applyBridgeCacheFrame → the cache writers above.
 *
 * Kinds (additive to the feed-event kinds, but routed to DISK, never to
 * phone SSE):
 *   'projection-upsert' → { which: 'sessions' | 'tasks', data: <envelope> }
 *   'transcript-upsert' → { sid, data: <SessionTranscript> }
 *
 * Fire-and-forget, and deliberately UNCONDITIONAL — unlike the feed events
 * this is NOT gated on hasFeedConsumers(): the cloud cache must stay warm
 * with no phone connected, otherwise the first phone attach after a quiet
 * period reads a stale cache. Bridge down / old daemon → silently skipped;
 * the 5-minute self-heal sweep (session/task-projection) re-pushes, bounding
 * staleness after an outage.
 */
export function pushProjectionToCloud(
  kind: 'projection-upsert' | 'transcript-upsert',
  payload: unknown,
): void {
  void pushProjectionToCloudNow(kind, payload);
}

/**
 * The awaitable form. Never rejects. Lanes, in order:
 *   1. POST /bridge/ingest (core/cloud-ingest.ts), one request in flight per
 *      key with only the newest payload waiting. A failure there is 'failed',
 *      and deliberately NOT retried on the bridge (see that file).
 *   2. The daemon's bridge `mobile-event`, when the replica has no ingest route
 *      or no companion is configured.
 * `bridgeConnId` lets the sweep ask the daemon which bridge connection is up
 * once instead of per push.
 */
export async function pushProjectionToCloudNow(
  kind: 'projection-upsert' | 'transcript-upsert',
  payload: unknown,
  opts?: { bridgeConnId?: () => Promise<string | null> },
): Promise<ProjectionPushOutcome> {
  if (CLOUD_MODE) return 'skipped'; // cloud is the receiver, never the pusher
  try {
    let prepared: { wire: string; hash: string } | null;
    try {
      prepared = preparePush(payload);
    } catch {
      prepared = null;
    }
    if (!prepared) return 'skipped'; // unserializable payload: nothing sane to send
    const size = Buffer.byteLength(prepared.wire, 'utf8');
    // Per-kind budget: the list lane is bounded and essential, the transcript
    // lane carries user-shaped text. See the two constants above.
    const cap = kind === 'projection-upsert' ? PROJECTION_PUSH_MAX_BYTES : PUSH_MAX_BYTES;
    if (size > cap) {
      log.session.warn('projection-cache: push skipped — payload exceeds frame cap', {
        kind, size, cap,
      });
      return 'skipped';
    }
    const key = pushKey(kind, payload);
    const bridge = (): Promise<ProjectionPushOutcome> =>
      pushViaBridge(kind, key, prepared.hash, payload, opts?.bridgeConnId ?? currentBridgeConnId);
    if (!key) return await bridge();
    // BOTH lanes run inside the key's order, so a push that finds the lane
    // resting cannot overtake an ingest request of the same key still in flight.
    return await ingest.runLatestPerKey(key, async (): Promise<ProjectionPushOutcome> => {
      if (ingest.cloudIngestResting()) return bridge();
      if (alreadyHeld(kind, key, prepared.hash, INGEST_LANE)) {
        settleTranscript(kind, payload);
        return 'unchanged';
      }
      const outcome = await ingest.postToCloudIngest(kind, prepared.wire);
      if (outcome === 'sent') {
        rememberDelivery(key, prepared.hash, INGEST_LANE);
        settleTranscript(kind, payload);
        return 'sent';
      }
      if (outcome === 'failed') {
        forgetDelivery(key); // it may have landed anyway: what the replica holds is unknown
        if (kind === 'transcript-upsert') notePendingTranscriptPush(payload);
        return 'failed';
      }
      return bridge(); // this replica has no ingest route (or no companion is set up)
    });
  } catch (err) {
    forgetDelivery(pushKey(kind, payload));
    if (kind === 'transcript-upsert') notePendingTranscriptPush(payload);
    // Non-fatal by design — the periodic sweep heals any gap.
    log.session.debug('projection-cache: cloud push failed', {
      kind, error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

function settleTranscript(kind: 'projection-upsert' | 'transcript-upsert', payload: unknown): void {
  if (kind !== 'transcript-upsert') return;
  const sid = payloadSid(payload);
  if (sid) pendingTranscriptPushSids.delete(sid);
}

/** The legacy lane: local daemon `mobile-event` → its dialed-out /bridge WS. */
async function pushViaBridge(
  kind: 'projection-upsert' | 'transcript-upsert',
  key: string | null,
  hash: string,
  payload: unknown,
  bridgeConnId: () => Promise<string | null>,
): Promise<ProjectionPushOutcome> {
  const { getConnectedDaemonConnection } = await import('../providers/daemon-connection.js');
  const conn = getConnectedDaemonConnection('__local__');
  if (!conn || !conn.hasCapability('mobile-event')) {
    forgetDelivery(key);
    if (kind === 'transcript-upsert') notePendingTranscriptPush(payload);
    return 'skipped';
  }
  if (alreadyHeld(kind, key, hash, await bridgeConnId())) {
    settleTranscript(kind, payload);
    return 'unchanged';
  }
  const res = await conn.send('mobile-event', { kind, data: payload });
  // An older daemon acks without `relayed`; `relayed: false` means its bridge
  // was down (or the uplink refused the frame), so nothing reached the replica.
  if (res?.relayed === false) {
    forgetDelivery(key);
    if (kind === 'transcript-upsert') notePendingTranscriptPush(payload);
    return 'failed';
  }
  // An ack without a connId (older daemon) cannot be matched to a connection
  // later, so it proves nothing a skip could use.
  if (typeof res?.connId === 'string' && res.connId) rememberDelivery(key, hash, res.connId);
  else forgetDelivery(key);
  settleTranscript(kind, payload);
  return 'sent';
}

/**
 * The daemon's live bridge connection id, or null when the daemon cannot say
 * (no bridge-uplink-v1) or its bridge is down. Asked once per sweep, and per
 * write-time push that takes the bridge lane (a local RPC).
 */
async function currentBridgeConnId(): Promise<string | null> {
  try {
    const { getConnectedDaemonConnection } = await import('../providers/daemon-connection.js');
    const conn = getConnectedDaemonConnection('__local__');
    if (!conn || !conn.hasCapability('bridge-uplink-v1')) return null;
    const res = await conn.send('bridge.status', {});
    return res?.connected === true && typeof res.connId === 'string' ? res.connId : null;
  } catch {
    return null;
  }
}

// ── Periodic self-heal (primary only) ───────────────────────────────────────

// Re-push cadence: SELF_HEAL_INTERVAL_MS (projection-push-state.ts, 5 minutes).
// Bounds cloud staleness after a bridge outage without needing a
// bridge-reconnected hook: worst case the cloud cache lags by one sweep interval
// once the link is back. The skip windows are derived from it.

/**
 * Every 5 minutes, re-push both projections and the transcript tails of
 * currently-alive sessions from the LOCAL CACHE FILES (cheap — no session
 * registry / task store / SSH reads; the debounced exporters keep those files
 * fresh). Fire-and-forget pushes; a down bridge just means the next sweep
 * retries. Primary only, interval unref'd (never holds the process open).
 */
export function startProjectionCacheSelfHeal(): { stop: () => void } {
  const timer = setInterval(() => { void runProjectionSelfHealSweep(); }, SELF_HEAL_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * One sweep, pushes awaited one after another (not a burst), each skipped when
 * the replica already holds that content on the lane it would take.
 * Exported for tests.
 */
export async function runProjectionSelfHealSweep(): Promise<Record<ProjectionPushOutcome, number>> {
  const counts: Record<ProjectionPushOutcome, number> = { sent: 0, unchanged: 0, skipped: 0, failed: 0 };
  // Asked at most once per sweep, and only if a push actually takes the bridge.
  let connIdAsked: Promise<string | null> | undefined;
  let bridgeConnId: string | null | undefined;
  const askConnId = (): Promise<string | null> => (connIdAsked ??= currentBridgeConnId().then((id) => (bridgeConnId = id)));
  const push = async (kind: 'projection-upsert' | 'transcript-upsert', payload: unknown): Promise<void> => {
    counts[await pushProjectionToCloudNow(kind, payload, { bridgeConnId: askConnId })]++;
  };
  try {
    const sessions = await readProjectionCache('sessions');
    if (sessions != null) {
      // The companion's copy carries the host model catalogs, which the cache
      // file does not (session-projection.ts sessionsPushPayload).
      const data = typeof sessions === 'object'
        ? await import('./session-projection.js').then((m) => m.sessionsPushPayload(sessions), () => sessions)
        : sessions;
      await push('projection-upsert', { which: 'sessions', data });
    }
    const tasks = await readProjectionCache('tasks');
    if (tasks != null) {
      await push('projection-upsert', { which: 'tasks', data: tasks });
    }
    // Alive sessions' tails only — stopped sessions' frozen tails were
    // pushed when written; re-sending hundreds of archives every sweep
    // would be pure bridge noise.
    const pushedThisSweep = new Set<string>();
    const rows = (sessions as { sessions?: Array<{ id?: string; process_status?: string }> } | null)?.sessions;
    if (Array.isArray(rows)) {
      for (const s of rows) {
        if (!s?.id || (s.process_status !== 'running' && s.process_status !== 'idle')) continue;
        const tail = await readTranscriptCache(s.id);
        if (tail != null) {
          await push('transcript-upsert', { sid: s.id, data: tail });
          pushedThisSweep.add(s.id);
        }
      }
    }
    // …plus tails whose write-time push was lost to a bridge outage —
    // typically sessions that STOPPED during it (their frozen tail is
    // written exactly once, so no later sweep would carry it). Success
    // removes the sid inside pushProjectionToCloud; failure re-notes it.
    for (const sid of [...pendingTranscriptPushSids]) {
      if (pushedThisSweep.has(sid)) continue;
      const tail = await readTranscriptCache(sid);
      if (tail == null) { pendingTranscriptPushSids.delete(sid); continue; }
      await push('transcript-upsert', { sid, data: tail });
    }
  } catch (err) {
    log.session.debug('projection-cache: self-heal sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (counts.sent > 0 || counts.failed > 0) {
    log.session.debug('projection-cache: self-heal sweep', { ...counts, bridgeConnId });
  }
  return counts;
}
