/**
 * /api/v1 events feed (additive) — one SSE stream that pushes slim task +
 * session updates to mobile clients, replacing "poll the projection and hope".
 *
 *   GET /api/v1/events (SSE)
 *     on attach → one `snapshot` frame { sessions: [ProjectedSession],
 *       tasks: [ProjectedTask] } (no SSE id — never disturbs replay)
 *     then live events:
 *       session-upsert  → ProjectedSession (same field names as GET /sessions)
 *       task-upsert     → ProjectedTask    (same shape as GET /tasks rows)
 *       task-delete     → { id }
 *     `: ping` comment every ~25s keeps middleboxes from reaping the socket.
 *
 * Data flow, primary box: ONE module-level bus subscription (lifecycle +
 * status events only — never the per-token streaming deltas) maps each event
 * to an authoritative slim row and fans out to every SSE connection via the
 * shared sse-channels machinery (single channel key). Per-connection bus
 * subscriptions are deliberately avoided — they'd multiply bus fan-out per
 * phone (the busstorm failure mode).
 *
 * Cloud companion (REPLICA): the primary's same subscription ALSO forwards
 * each slim event to its local daemon (`mobile-event` command, trusted
 * clients only), which relays it over the /bridge WS to the cloud box, where
 * bridge-registry hands it to this module → same SSE fan-out. The same lane
 * additionally carries CACHE frames ('projection-upsert'/'transcript-upsert',
 * pushed by core/projection-cache.ts) that are persisted to WALNUT_HOME/cache/
 * and never fanned out. The snapshot frame on cloud comes from the pushed
 * session projection cache (legacy git-synced file as transition fallback) +
 * the local task store. Bridge down / old daemon → the stream degrades to
 * snapshot + heartbeats (no error; the phone's pull paths still work).
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { attachSse, emitSse, sseConnCount } from '../sse-channels.js'
import { log } from '../../logging/index.js'
import type { Task } from '../../core/types.js'

export const eventsV1Router = Router()

/** All events-feed connections share one SSE channel. */
const EVENTS_CHANNEL = 'mobile-events'

const BUS_SUBSCRIBER = 'mobile-events-feed'
/** Same lifecycle-only interest set as the projection exporters — NEVER add
 *  the per-token streaming events (text-delta/thinking-delta) here. */
const FEED_INTEREST = [
  'session:started', 'session:ended', 'session:status-changed',
  'session:result', 'session:error',
  'task:created', 'task:updated', 'task:completed', 'task:deleted',
]

// ── Slim-row mapping (authoritative reads, best-effort) ─────────────────────

async function projectSessionRow(sessionId: string): Promise<Record<string, unknown> | null> {
  const { getSessionByClaudeId, isEnvironmentSession } = await import('../../core/session-tracker.js')
  const { projectSession } = await import('../../core/session-projection.js')
  const record = await getSessionByClaudeId(sessionId)
  if (!record || record.archived || isEnvironmentSession(record)) return null
  let task: Task | undefined
  if (record.taskId) {
    const { getTask } = await import('../../core/task-manager.js')
    task = await getTask(record.taskId).catch(() => undefined)
  }
  return projectSession(record, task) as unknown as Record<string, unknown>
}

/** Push one slim event to all local SSE subscribers.
 *  `buffer: false`: this channel must NOT keep a replay ring — every
 *  connection gets a fresh snapshot on attach, and replaying pre-snapshot
 *  history would overwrite that newer snapshot on the phone (completed tasks
 *  flipping back to todo, ended sessions showing running). */
function fanOut(event: string, data: unknown): void {
  emitSse(EVENTS_CHANNEL, event, data, { buffer: false })
}

/**
 * Forward one slim event to the LOCAL daemon so its /bridge socket relays it
 * to the cloud companion (which fans out to phones connected there).
 * Fire-and-forget and gated: never dials, and skips daemons that predate the
 * `mobile-event` command (the cloud feed just degrades to snapshot+poll).
 */
function forwardToBridge(event: string, data: unknown): void {
  void (async () => {
    try {
      const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
      const conn = getConnectedDaemonConnection('__local__')
      if (!conn || !conn.hasCapability('mobile-event')) return
      await conn.send('mobile-event', { kind: event, data })
    } catch (err) {
      // Non-fatal by design — the snapshot frame heals any gap.
      log.web.debug('mobile-events: bridge forward failed', {
        event, error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}

function emitFeedEvent(event: string, data: unknown): void {
  fanOut(event, data)
  if (!CLOUD_MODE) forwardToBridge(event, data)
}

/**
 * True when someone can consume a feed event right now: a local SSE
 * subscriber, or (primary only) a bridge-connected daemon that relays to the
 * cloud companion. When false, the projection read behind a session-upsert is
 * pure waste — the next snapshot covers any gap.
 */
async function hasFeedConsumers(): Promise<boolean> {
  if (sseConnCount(EVENTS_CHANNEL) > 0) return true
  if (CLOUD_MODE) return false
  try {
    const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
    const conn = getConnectedDaemonConnection('__local__')
    return conn != null && conn.hasCapability('mobile-event')
  } catch {
    return false
  }
}

// ── session:* coalescing (P1-1) ─────────────────────────────────────────────
//
// A busy turn emits session:status-changed many times per second; each one
// used to cost a SQLite read + projection + SSE/bridge frame. Coalesce per
// sessionId: the FIRST event in a window arms a timer, later ones ride it,
// and the single projection at fire time reads the authoritative record — by
// definition the latest state, so "keep only the last" comes for free. The
// bridge forward shares the same coalesced emit.
const SESSION_UPSERT_COALESCE_MS = 250
const pendingSessionUpserts = new Map<string, NodeJS.Timeout>()

function scheduleSessionUpsert(sessionId: string): void {
  if (pendingSessionUpserts.has(sessionId)) return
  const timer = setTimeout(() => {
    pendingSessionUpserts.delete(sessionId)
    void (async () => {
      // No local subscribers and no bridge relay → skip the read entirely.
      if (!(await hasFeedConsumers())) return
      const row = await projectSessionRow(sessionId)
      if (row) emitFeedEvent('session-upsert', row)
    })().catch(() => {})
  }, SESSION_UPSERT_COALESCE_MS)
  timer.unref?.()
  pendingSessionUpserts.set(sessionId, timer)
}

function clearPendingSessionUpserts(): void {
  for (const timer of pendingSessionUpserts.values()) clearTimeout(timer)
  pendingSessionUpserts.clear()
}

// ── Bus subscription (primary box) ──────────────────────────────────────────

async function handleBusEvent(name: string, data: unknown): Promise<void> {
  if (name.startsWith('task:')) {
    const d = (data ?? {}) as { task?: Task | null; id?: string }
    if (name === EventNames.TASK_DELETED) {
      const id = d.id ?? d.task?.id
      if (id) emitFeedEvent('task-delete', { id })
      return
    }
    // TASK_UPDATED bulk signals carry { task: null } — nothing to project.
    if (!d.task || !d.task.id) return
    const { projectTask } = await import('../../core/task-projection.js')
    emitFeedEvent('task-upsert', projectTask(d.task))
    return
  }
  // session:* — re-read the authoritative record (event payloads vary by
  // emitter; the tracker row is the single truth). Coalesced per sessionId —
  // rapid status flaps produce ONE projection read + frame per window.
  const sessionId = (data as { sessionId?: string } | undefined)?.sessionId
  if (!sessionId) return
  scheduleSessionUpsert(sessionId)
}

// ── Cloud inbound (bridge → this box) ───────────────────────────────────────

/** Persist a pushed projection/transcript payload into the local cache
 *  (WALNUT_HOME/cache/…) — these are CACHE frames, not feed events, so they
 *  must NEVER fan out to phone SSE. A tasks projection additionally triggers
 *  the outbox's projection import (mtime-gated internally) so the replica's
 *  sqlite learns Mac-side tasks without waiting for a git pull. */
function handleBridgeCacheFrame(kind: 'projection-upsert' | 'transcript-upsert', data: unknown): void {
  void (async () => {
    try {
      const cache = await import('../../core/projection-cache.js')
      if (kind === 'projection-upsert') {
        const d = data as { which?: unknown; data?: unknown } | null
        if (!d || (d.which !== 'sessions' && d.which !== 'tasks') || d.data == null) return
        await cache.writeProjectionCache(d.which, d.data)
        if (d.which === 'tasks') {
          const { importProjectionOnCloud } = await import('../../core/task-outbox.js')
          await importProjectionOnCloud()
        }
      } else {
        const d = data as { sid?: unknown; data?: unknown } | null
        if (!d || typeof d.sid !== 'string' || !d.sid || d.data == null) return
        await cache.writeTranscriptCache(d.sid, d.data)
      }
    } catch (err) {
      log.web.warn('mobile-events: cache frame write failed', {
        kind, error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}

/** Called by bridge-registry when a `mobile-event` frame arrives from the
 *  primary's daemon. Feed kinds fan out verbatim (shape is already slim);
 *  cache kinds are persisted to disk only. */
export function handleBridgeMobileEvent(kind: unknown, data: unknown): void {
  if (typeof kind !== 'string' || !kind) return
  // Projection/transcript pushes → local cache, never the SSE feed.
  if (kind === 'projection-upsert' || kind === 'transcript-upsert') {
    handleBridgeCacheFrame(kind, data)
    return
  }
  // Only the three known event kinds — a compromised/buggy sender must not
  // inject arbitrary SSE event names into phones.
  if (kind !== 'session-upsert' && kind !== 'task-upsert' && kind !== 'task-delete') return
  fanOut(kind, data)
}

// ── Lifecycle (wired from server.ts) ────────────────────────────────────────

let started = false

export function startMobileEventsFeed(): { stop: () => void } {
  if (started) return { stop: stopMobileEventsFeed }
  started = true
  if (CLOUD_MODE) {
    // Cloud: session events arrive from the bridge (registered sink below),
    // not the local bus — but the replica's own task writes DO emit task:*
    // locally, so subscribe for those; a phone talking to the cloud sees its
    // own mutations instantly instead of waiting for the primary's echo.
    bus.subscribe(BUS_SUBSCRIBER, (event) => {
      void handleBusEvent(event.name, event.data).catch(() => {})
    }, { global: true, interest: ['task:created', 'task:updated', 'task:completed', 'task:deleted'] })
    // Optional-chained + caught: tests mock bridge-registry at its module
    // seam and may not stub this export; the feed must not crash startup.
    void (async () => {
      try {
        const { setMobileEventHandler } = await import('../ws/bridge-registry.js')
        setMobileEventHandler?.(handleBridgeMobileEvent)
      } catch { /* bridge registry unavailable — feed degrades to snapshot */ }
    })()
  } else {
    bus.subscribe(BUS_SUBSCRIBER, (event) => {
      void handleBusEvent(event.name, event.data).catch(() => {})
    }, { global: true, interest: FEED_INTEREST })
  }
  return { stop: stopMobileEventsFeed }
}

export function stopMobileEventsFeed(): void {
  if (!started) return
  started = false
  bus.unsubscribe(BUS_SUBSCRIBER)
  clearPendingSessionUpserts()
  if (CLOUD_MODE) {
    void (async () => {
      try {
        const { setMobileEventHandler } = await import('../ws/bridge-registry.js')
        setMobileEventHandler?.(null)
      } catch { /* already torn down */ }
    })()
  }
}

// ── Snapshot builders ───────────────────────────────────────────────────────

async function buildSnapshot(): Promise<{ sessions: unknown[]; tasks: unknown[] }> {
  let sessions: unknown[] = []
  let tasks: unknown[] = []
  try {
    if (CLOUD_MODE) {
      // Sessions: the bridge-pushed projection cache (legacy git-synced file
      // as transition fallback) is the replica's best truth.
      const { readSessionProjection } = await import('../../core/session-projection.js')
      sessions = (await readSessionProjection())?.sessions ?? []
    } else {
      const { buildSessionProjection } = await import('../../core/session-projection.js')
      sessions = (await buildSessionProjection()).sessions
    }
  } catch (err) {
    log.web.warn('mobile-events: session snapshot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    // Tasks: both boxes have a real local task store.
    const { buildTaskProjection } = await import('../../core/task-projection.js')
    tasks = (await buildTaskProjection()).tasks
  } catch (err) {
    log.web.warn('mobile-events: task snapshot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return { sessions, tasks }
}

// ── Route ───────────────────────────────────────────────────────────────────

// GET /api/v1/events — the live feed. Auth rides the standard /api/v1
// middleware; this handler only attaches the SSE subscriber.
eventsV1Router.get('/events', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const snapshot = await buildSnapshot()
    // replay: false — the snapshot above IS the state; ring replay would
    // deliver stale pre-snapshot events on top of it (P0-2/P0-3).
    attachSse(EVENTS_CHANNEL, _req, res, {
      onAttach: (write) => write('snapshot', snapshot),
      replay: false,
    })
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — frozen error shape (same as the other v1 routers).
eventsV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 events error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) { res.end(); return }
  res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } })
})
