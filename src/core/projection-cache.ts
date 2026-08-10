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

export type ProjectionKind = 'sessions' | 'tasks';

/** Same safe-id alphabet the transcript seam enforces (ids land in filenames). */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Bridge frame budget. The ws maxPayload is 32MB, but one oversized frame
 *  (1009 close) kills every in-flight RPC on the shared bridge socket
 *  (2026-08-09 incident) — cap far below it. Transcripts are pre-clipped
 *  (TRANSCRIPT_TAIL rows × TEXT_MAX chars) so this should never fire. */
const PUSH_MAX_BYTES = 1_048_576; // 1MB

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


/**
 * Push a cache payload to the cloud companion over the existing mobile-event
 * lane: local daemon `mobile-event` command → daemon's dialed-out /bridge WS →
 * cloud bridge-registry (hard-filtered to hostAlias '__local__') →
 * events-v1 handleBridgeMobileEvent → the cache writers above.
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
  if (CLOUD_MODE) return; // cloud is the receiver, never the pusher
  void (async () => {
    try {
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      } catch {
        return; // unserializable payload — nothing sane to send
      }
      if (size > PUSH_MAX_BYTES) {
        log.session.warn('projection-cache: push skipped — payload exceeds frame cap', {
          kind, size, cap: PUSH_MAX_BYTES,
        });
        return;
      }
      const { getConnectedDaemonConnection } = await import('../providers/daemon-connection.js');
      const conn = getConnectedDaemonConnection('__local__');
      if (!conn || !conn.hasCapability('mobile-event')) {
        if (kind === 'transcript-upsert') notePendingTranscriptPush(payload);
        return;
      }
      await conn.send('mobile-event', { kind, data: payload });
      if (kind === 'transcript-upsert') {
        const sid = payloadSid(payload);
        if (sid) pendingTranscriptPushSids.delete(sid);
      }
    } catch (err) {
      if (kind === 'transcript-upsert') notePendingTranscriptPush(payload);
      // Non-fatal by design — the periodic sweep heals any gap.
      log.session.debug('projection-cache: bridge push failed', {
        kind, error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

// ── Periodic self-heal (primary only) ───────────────────────────────────────

/** Re-push cadence. Bounds cloud staleness after a bridge outage without
 *  needing a bridge-reconnected hook: worst case the cloud cache lags by one
 *  sweep interval once the link is back. */
const SELF_HEAL_INTERVAL_MS = 5 * 60_000;

/**
 * Every 5 minutes, re-push both projections and the transcript tails of
 * currently-alive sessions from the LOCAL CACHE FILES (cheap — no session
 * registry / task store / SSH reads; the debounced exporters keep those files
 * fresh). Fire-and-forget pushes; a down bridge just means the next sweep
 * retries. Primary only, interval unref'd (never holds the process open).
 */
export function startProjectionCacheSelfHeal(): { stop: () => void } {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const sessions = await readProjectionCache('sessions');
        if (sessions != null) {
          pushProjectionToCloud('projection-upsert', { which: 'sessions', data: sessions });
        }
        const tasks = await readProjectionCache('tasks');
        if (tasks != null) {
          pushProjectionToCloud('projection-upsert', { which: 'tasks', data: tasks });
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
              pushProjectionToCloud('transcript-upsert', { sid: s.id, data: tail });
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
          pushProjectionToCloud('transcript-upsert', { sid, data: tail });
        }
      } catch (err) {
        log.session.debug('projection-cache: self-heal sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, SELF_HEAL_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
