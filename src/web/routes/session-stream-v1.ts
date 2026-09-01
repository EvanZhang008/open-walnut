/**
 * /api/v1 session talk endpoints — send text INTO a Claude Code session and
 * stream its output back (mobile app conversation page).
 *
 *   POST /sessions/:id/messages  { text } → 202 { messageId }
 *   GET  /sessions/:id/stream    SSE: snapshot / turn-start / text-delta /
 *        thinking / tool / tool-result / status / turn-end / error /
 *        bridge-offline / bridge-online
 *
 * Primary box (!CLOUD_MODE): direct — sendMessageToSession() for sends (full
 * queue + resume fallback semantics), ONE global bus subscriber with an
 * interest set for streaming.
 *
 * Cloud box: proxied over the daemon bridge (ws/bridge-registry.ts). The
 * session's host comes from the git-synced projection. Sends ride the narrow
 * `session.message` relay: daemon → connected walnut server → the SAME
 * durable message queue web sends use (sendMessageToSession + reconnect
 * redelivery), so a daemon/CLI death anywhere mid-flight converts to delayed
 * delivery instead of loss (the 2026-08-13 phone-send data-loss family:
 * the old direct marker→send/bridgeResume sequence had no queue, and a
 * silent daemon death between the steps ate the message while the marker
 * left a ghost user bubble). Old daemons (no session.message) and a
 * primary-down window fall back to the direct sequence — reordered to
 * deliver FIRST and append the transcript marker only after confirmed
 * delivery, so a ghost bubble can no longer outlive its message. No bridge
 * is 503 bridge_offline (retryable); only a genuinely unknown/dead session
 * is 404/409.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import crypto from 'node:crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { bus } from '../../core/event-bus.js'
import { emitSse, attachSse, sseConnCount } from '../sse-channels.js'
import { sessionStreamBuffer, budgetSnapshotBlocks } from '../session-stream-buffer.js'
import { prepareOutputModeSend } from '../../core/sessions/output-mode-send.js'
import { clipTranscriptText } from '../../core/sessions/transcript-clip.js'
import { stripOutputModeWrappers } from '../../core/sessions/output-mode.js'
import { log } from '../../logging/index.js'

export const sessionStreamV1Router = Router()

const SID_RE = /^[A-Za-z0-9_-]+$/

// ── Image attachments (additive) — mirrors session-chat.ts constants ──
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_SESSION_IMAGES = 5
const MAX_IMAGE_BASE64_LENGTH = 14_000_000 // ~10MB binary

interface SessionImage { data: string; mediaType: string }

/**
 * Hard ceiling on how long POST /messages may take to ANSWER (text sends).
 *
 * Sized against the CLIENT, not the relay: the iOS app's URLSession request
 * timeout is 30s, so a server answer arriving after that is indistinguishable
 * from a dead server — and a timed-out POST is not auto-retried (it isn't
 * idempotent from URLSession's point of view). 22s leaves the phone ~8s of
 * margin for TLS + the round trip and still lets a merely SLOW bridge win the
 * race normally. Image sends are exempt (they legitimately take minutes and the
 * client raises its own timeout to 180s for them).
 */
const SEND_ANSWER_DEADLINE_MS = 22_000

/** Extract valid image payloads from a request body (silently drops junk). */
function extractValidImages(raw: unknown): SessionImage[] {
  if (!Array.isArray(raw)) return []
  return (raw as Array<{ data?: unknown; mediaType?: unknown }>)
    .filter((img) =>
      typeof img?.data === 'string'
      && img.data.length > 0
      && img.data.length <= MAX_IMAGE_BASE64_LENGTH
      && typeof img.mediaType === 'string'
      && ALLOWED_MIME.has(img.mediaType),
    )
    .slice(0, MAX_SESSION_IMAGES)
    .map((img) => ({ data: img.data as string, mediaType: img.mediaType as string }))
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

function channelKey(sessionId: string): string {
  return `session:${sessionId}`
}

// ─── Interest set: which sessions have (or recently had) live SSE conns ─────
//
// ONE global bus subscriber serves every session stream. Per-connection
// subscribers would fan out every delta N times and leak on abrupt closes
// (the event-loop-starvation incident class). The 30s linger keeps a briefly
// reconnecting phone (app backgrounded → foregrounded) from missing the gap
// between unsubscribe and resubscribe.

const LINGER_MS = 30_000
const interested = new Map<string, { conns: number; linger?: NodeJS.Timeout }>()
let busSubscribed = false
/** Latched by the first cloud-OWNED stream attach — see ensureBusSubscriber. */
let busAllowedOnCloud = false

function addInterest(sessionId: string, allowOnCloud = false): void {
  if (allowOnCloud) busAllowedOnCloud = true
  const entry = interested.get(sessionId) ?? { conns: 0 }
  if (entry.linger) { clearTimeout(entry.linger); entry.linger = undefined }
  entry.conns += 1
  interested.set(sessionId, entry)
  ensureBusSubscriber()
}

function dropInterest(sessionId: string): void {
  const entry = interested.get(sessionId)
  if (!entry) return
  entry.conns = Math.max(0, entry.conns - 1)
  if (entry.conns === 0) {
    if (entry.linger) clearTimeout(entry.linger)
    entry.linger = setTimeout(() => { interested.delete(sessionId) }, LINGER_MS)
    entry.linger.unref?.()
  }
}

/** Test hook: reset interest state between server instances. */
export function resetSessionStreamInterest(): void {
  for (const entry of interested.values()) {
    if (entry.linger) clearTimeout(entry.linger)
  }
  interested.clear()
}

// ─── Bus → SSE mapping (primary box) ────────────────────────────────────────
//
// Main lane only: deltas/tools carrying parentToolUseId belong to inline
// subagents — the phone conversation page renders the primary lane, same as
// the web UI default.

function ensureBusSubscriber(): void {
  // CLOUD_MODE normally has no local session events to map (they arrive from the
  // bridge as pre-mapped SSE frames). A cloud-exec companion DOES run sessions
  // locally, so the subscriber is needed there — `allowOnCloud` is passed only
  // from the cloud-owned branch, never from the relay branch, so a relay-only box
  // keeps its zero-subscriber behavior.
  if (busSubscribed || (CLOUD_MODE && !busAllowedOnCloud)) return
  busSubscribed = true
  bus.subscribe('session-sse', async (event) => {
    const d = event.data as Record<string, unknown>
    const sid = typeof d.sessionId === 'string' ? d.sessionId : undefined
    if (!sid || !interested.has(sid)) return
    const key = channelKey(sid)
    switch (event.name) {
      case 'session:text-delta': {
        if (d.parentToolUseId) return
        emitSse(key, 'text-delta', { delta: d.delta ?? '' })
        return
      }
      case 'session:thinking-delta': {
        if (d.parentToolUseId) return
        emitSse(key, 'thinking', { delta: d.delta ?? '' })
        return
      }
      case 'session:tool-use': {
        if (d.parentToolUseId) return
        const { toolDetail } = await import('../../core/tool-summary.js')
        const detail = toolDetail(String(d.toolName ?? ''), d.input as Record<string, unknown> | undefined)
        emitSse(key, 'tool', { name: d.toolName ?? '', toolUseId: d.toolUseId ?? '', ...(detail ? { detail } : {}) })
        return
      }
      case 'session:tool-result': {
        if (d.parentToolUseId) return
        emitSse(key, 'tool-result', { toolUseId: d.toolUseId ?? '' })
        return
      }
      case 'session:status-changed': {
        const ps = typeof d.process_status === 'string' ? d.process_status : ''
        if (!ps) return
        // 'running' from session-runner = a real turn is starting → reset the
        // replay window. daemon-reconnect's 'running' is a reconciliation
        // artifact (SSH flap), NOT a turn — treating it as one gave phones
        // phantom turn boundaries (same guard as server.ts markStreaming).
        if (ps === 'running' && event.source !== 'daemon-reconnect') {
          emitSse(key, 'turn-start', {}, { reset: true })
        }
        emitSse(key, 'status', { processStatus: ps })
        return
      }
      case 'session:result': {
        emitSse(key, 'turn-end', {})
        return
      }
      case 'session:error': {
        emitSse(key, 'error', { message: typeof d.error === 'string' ? d.error : 'session error' })
        return
      }
    }
  }, { global: true, interest: ['session:'] })
}

// ─── Cloud path: session → host lookup + bridge send sequence ───────────────

async function projectedSession(sessionId: string): Promise<{ host: string; cwd?: string; model?: string } | null> {
  // OWN-REGISTRY FIRST. A session THIS companion spawned (cloud.exec) never
  // appears in the Mac-authored projection — see core/cloud-owned-session.ts for
  // why the order matters in both directions. Cheap no-op on a relay-only box.
  const { cloudOwnedSession, cloudOwnedHostAlias } = await import('../../core/cloud-owned-session.js')
  const owned = await cloudOwnedSession(sessionId)
  if (owned) {
    return { host: cloudOwnedHostAlias, ...(owned.cwd ? { cwd: owned.cwd } : {}), ...(owned.model ? { model: owned.model } : {}) }
  }
  const { readSessionProjection } = await import('../../core/session-projection.js')
  const projection = await readSessionProjection()
  const s = projection?.sessions.find((p) => p.id === sessionId)
  if (s) {
    // Projection: '' = the primary box; daemons register as '__local__'.
    return { host: s.host === '' ? '__local__' : s.host, cwd: s.cwd, model: s.model }
  }
  // Projection miss ≠ unknown session: a session THIS replica just launched
  // won't appear in the git-synced projection for 1–3 minutes (primary's 60s
  // sweep + 30s git ticks both ways). The launch relay seeded its id→host at
  // 201 time — without this fallback every stream/transcript/send in that
  // window 404'd and the phone showed "Not sent" on a healthy session
  // (2026-08-07). Seeds are TTL'd; once the projection lands it wins above.
  const { getLaunchSeed } = await import('../../core/sessions/launch-seed.js')
  return getLaunchSeed(sessionId)
}

async function projectedHostForSession(sessionId: string): Promise<string | null> {
  return (await projectedSession(sessionId))?.host ?? null
}

/**
 * Cloud path for image attachments: save each image on the SESSION'S HOST via
 * the narrow bridge-allowlisted `image.save` daemon command (mediaType
 * allowlist + size cap + fixed daemon-owned dir — deliberately NOT fs.write),
 * then reference the returned paths in the augmented text exactly like the
 * primary-box path does, so the CLI's Read tool can open them.
 *
 * Throws CloudImageError with a precise code — never silently drops an image:
 * - images_need_daemon_upgrade: pre-image.save daemon (unknown command). The
 *   daemon auto-upgrades on the next Mac reconnect, so this self-heals.
 * - image_upload_failed: the daemon refused (bad mediaType/size) or the save
 *   errored on the host.
 * BridgeOfflineError propagates to cloudSend's 503 handler.
 */
class CloudImageError extends Error {
  constructor(public code: 'images_need_daemon_upgrade' | 'image_upload_failed', message: string) { super(message) }
}

async function saveImagesViaBridge(host: string, sessionId: string, images: SessionImage[]): Promise<string[]> {
  const { bridgeRequest } = await import('../ws/bridge-registry.js')
  const savedPaths: string[] = []
  for (const img of images) {
    // 30s: an image frame is up to ~14MB of base64 over the bridge WS.
    const saved = await bridgeRequest(host, 'image.save', { data: img.data, mediaType: img.mediaType }, 30_000)
    if (saved.ok === true && typeof saved.path === 'string') {
      savedPaths.push(saved.path)
      continue
    }
    const reason = String(saved.error ?? 'unknown')
    if (reason.startsWith('unknown command')) {
      throw new CloudImageError('images_need_daemon_upgrade',
        'This host\'s daemon predates image support — it upgrades automatically on the next primary-box reconnect')
    }
    throw new CloudImageError('image_upload_failed', `Image save failed on ${host}: ${reason}`)
  }
  log.web.info('mobile session images saved via bridge', { sessionId, host, count: savedPaths.length })
  return savedPaths
}

async function cloudSend(
  res: Response,
  sessionId: string,
  text: string,
  images: SessionImage[] = [],
  clientMessageId?: string,
): Promise<void> {
  const projected = await projectedSession(sessionId)
  if (!projected) {
    sendError(res, 404, 'not_found', `Session not found: ${sessionId}`)
    return
  }
  const host = projected.host
  // Stable id: a client-supplied one (phone retry) makes the durable-queue
  // enqueue idempotent end-to-end — the relay dedupes on it, so a retry after a
  // lost ack cannot double-deliver. Declared OUTSIDE the try so the catch can
  // bank the send under the same id the phone already holds.
  const messageId = clientMessageId ?? `qm-mobile-${crypto.randomBytes(6).toString('hex')}`
  const { bridgeRequest, BridgeOfflineError } = await import('../ws/bridge-registry.js')
  try {
    // Images first: if any save fails the send is aborted with a precise error
    // (never a text-only turn that silently dropped the pictures). Augmented
    // text mirrors the primary-box "[Images attached …]" format.
    if (images.length > 0) {
      const savedPaths = await saveImagesViaBridge(host, sessionId, images)
      const pathList = savedPaths.map((p) => `- ${p}`).join('\n')
      text = `[Images attached — use the Read tool to view them]\n${pathList}\n\n${text}`
    }

    // ── Durable path (default): session.message relay → the primary's queue ──
    // The primary enqueues into the SAME persistent store web sends use;
    // session-runner owns delivery (FIFO / mid-turn / --resume) and the
    // reconnect redelivery drains anything a daemon death stranded. 50s so
    // the daemon's own 45s relay timeout surfaces its precise error first.
    const relayPromise = bridgeRequest(host, 'session.message', {
      sessionId, message: text, messageId,
    }, 50_000).catch((err: unknown) => {
      if (err instanceof BridgeOfflineError) throw err
      // Transport-level failure mid-relay (bridge WS died, request timer):
      // the enqueue MAY have committed on the primary. Do NOT fall back to
      // the direct path (double-delivery risk) — report retryable; a retry
      // with the same messageId dedupes at the queue.
      return { ok: false, error: err instanceof Error ? err.message : String(err), transport: true }
    })

    // ANSWER DEADLINE — the real 2026-08-20 bug. This relay is allowed 50s, but
    // the phone's URLSession gives up at 30s (timeoutIntervalForRequest), and a
    // POST that dies on NSURLErrorTimedOut is deliberately NOT auto-retried
    // (WalnutAPI.shouldRetryTransient: only GET / retrySafe). So during the
    // bridge outage the phone abandoned two 30s POSTs, showed the red "Not sent"
    // while the session kept streaming, and the 503 backoff ladder never even
    // engaged — it only reacts to a 503 RESPONSE, and no response ever arrived.
    // A budget the client won't wait for is not a budget; whoever holds the
    // shorter deadline defines the contract. We now always answer inside it, and
    // bank whatever the relay hasn't confirmed by then. Safe because the banked
    // retry rides the SAME idempotent session.message path with the SAME
    // messageId (queue dedupe + the relay ledger), which is exactly why the
    // non-idempotent DIRECT fallback below still refuses this case.
    const raced = await Promise.race([
      relayPromise,
      new Promise<'deadline'>((r) => setTimeout(() => r('deadline'), SEND_ANSWER_DEADLINE_MS).unref?.()),
    ])
    if (raced === 'deadline') {
      const banked = await bankSend(sessionId, host, text, messageId, images.length)
      if (banked) {
        log.web.info('mobile session send banked at the answer deadline (relay still pending)', {
          sessionId, host, messageId, deadlineMs: SEND_ANSWER_DEADLINE_MS,
        })
        res.status(202).json({ messageId, queued: true })
        // A late success means the primary already has it — drop the banked copy
        // so the sweep does no redundant (though harmless) re-relay.
        void relayPromise.then((late) => {
          if (late && (late as Record<string, unknown>).ok === true) void unbankSend(messageId)
        }).catch(() => {})
        return
      }
      // Couldn't bank (image send / queue write failed): let the relay finish on
      // its own budget rather than inventing an outcome.
    }
    const relayed: Record<string, unknown> = raced === 'deadline'
      ? await relayPromise
      : (raced as Record<string, unknown>)
    if (relayed.ok === true) {
      log.web.info('mobile session send enqueued via relay (durable)', {
        sessionId, host, messageId, imageCount: images.length,
      })
      res.status(202).json({ messageId })
      // Opportunistic drain: a live bridge is the only thing anything banked
      // during the last outage was waiting for. After the response, never before.
      void drainBankedSends()
      return
    }
    const relayErr = String(relayed.error ?? 'unknown')
    if (relayed.errorKind === 'not_found') {
      sendError(res, 404, 'not_found', relayErr)
      return
    }
    // Fallback is safe ONLY when the primary provably never saw the message:
    // an old daemon (unknown command) or no connected primary (Mac offline —
    // the direct path is exactly what keeps phone→session working then).
    // Anything else (relay timeout, internal error) might have enqueued.
    const canFallback = relayErr.startsWith('unknown command')
      || relayErr.includes('no primary server connected')
    if (!canFallback) {
      sendError(res, 503, 'bridge_offline', `Send relay failed: ${relayErr}`)
      return
    }
    log.web.info('mobile send falling back to direct bridge sequence', {
      sessionId, host, messageId, reason: relayErr,
    })
    // Deliberately carries NO output-mode directive: the wrapper has to be paired
    // with advancing `output_mode_injected` on the session record, which lives on
    // the primary — and this path exists precisely for when the primary is not
    // reachable. Wrapping here would re-send the full instruction on every send
    // for as long as the outage lasts. The next relayed send fixes the mode.
    await cloudSendDirect(res, host, projected, sessionId, text, messageId)
  } catch (err) {
    if (err instanceof CloudImageError) {
      sendError(res, 400, err.code, err.message)
      return
    }
    if (err instanceof BridgeOfflineError) {
      // FAST-ACCEPT: there is no socket, so the primary provably never saw this
      // message — bank it and answer 202. Durability used to begin one hop too
      // late (only AFTER the relay reached the primary's queue), which made the
      // phone's 120s retry ladder the ONLY thing covering a bridge outage. Real
      // outages are not bounded by that: the 2026-08-20 one ran ~7 minutes
      // (Wi-Fi loss → dial-timeout → redial backoff), so the ladder ran out and
      // the bubble went red on a healthy, still-streaming session. See
      // core/send-queue.ts for why a queued 202 is honest and what stays 503.
      const banked = await bankSend(sessionId, host, text, messageId, images.length)
      if (banked) {
        res.status(202).json({ messageId, queued: true })
        return
      }
      sendError(res, 503, 'bridge_offline', 'No live bridge to this session\'s host')
      return
    }
    sendError(res, 503, 'bridge_offline', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Bank a send for delivery when the host's bridge returns. Returns false when
 * the caller must keep the honest 503: an IMAGE send (the attachments only
 * exist as host-side files created through the bridge — banking the text alone
 * would deliver a turn whose pictures silently vanished) or a failed queue
 * write (never a 202 for something we did not store).
 */
async function bankSend(
  sessionId: string, host: string, text: string, messageId: string, imageCount: number,
): Promise<boolean> {
  if (imageCount > 0) return false
  const { enqueueSessionSend } = await import('../../core/send-queue.js')
  const opId = await enqueueSessionSend(sessionId, host, text, messageId)
  if (!opId) return false
  log.web.info('mobile session send banked for bridge return (fast-accept)', {
    sessionId, host, messageId, opId,
  })
  return true
}

/** Drop a banked row whose relay turned out to have succeeded after all. */
async function unbankSend(messageId: string): Promise<void> {
  try {
    const { dropBankedSend } = await import('../../core/send-queue.js')
    await dropBankedSend(messageId)
  } catch { /* the sweep's idempotent re-relay is the safety net */ }
}

/** Fire-and-forget drain of anything banked during an earlier outage. */
async function drainBankedSends(): Promise<void> {
  try {
    const { flushSendQueue } = await import('../../core/send-queue.js')
    await flushSendQueue()
  } catch { /* the 60s sweep and the reconnect hook remain */ }
}

/**
 * Direct bridge sequence — the pre-queue path, kept for old daemons and for
 * the Mac-offline window (bridgeResume works with no primary connected).
 * REORDERED to be loss-safe: deliver FIRST, append the transcript marker only
 * after the daemon confirmed delivery. The old marker-first order is what
 * produced ghost user bubbles — the daemon died between the marker append and
 * the FIFO write/resume, so the transcript showed a message the CLI never
 * received. The marker may now land milliseconds after the CLI starts the
 * turn (it never echoes stdin, so nothing else marks the turn start); that
 * tiny anchor skew is the price of never showing a bubble for a lost message.
 */
async function cloudSendDirect(
  res: Response,
  host: string,
  projected: { cwd?: string; model?: string },
  sessionId: string,
  text: string,
  messageId: string,
): Promise<void> {
  const { bridgeRequest } = await import('../ws/bridge-registry.js')
  // Liveness precheck — if the CLI is gone (dead record, or the record itself
  // was lost to a daemon restart), attempt a bridgeResume instead of 409.
  let status = await bridgeRequest(host, 'status', { sid: sessionId })
  // Just-launched race (caught by the live suite, 2026-08-07): the 201 is
  // "accepted", the CLI spawn on the primary is ASYNC — a send fired
  // milliseconds later finds status.exists=false, falls into the resume
  // path, and the daemon rightly refuses (no jsonl yet) → 409 on a session
  // that is seconds from being alive. While the launch seed is fresh, poll
  // for the spawn instead of declaring death.
  if (status.exists !== true) {
    const { getLaunchSeed } = await import('../../core/sessions/launch-seed.js')
    if (getLaunchSeed(sessionId)) {
      const SPAWN_POLL_MS = 1_000
      const SPAWN_WAIT_MAX_MS = 20_000
      const deadline = Date.now() + SPAWN_WAIT_MAX_MS
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, SPAWN_POLL_MS))
        status = await bridgeRequest(host, 'status', { sid: sessionId })
        if (status.exists === true) break
      }
      log.web.info('mobile send waited for just-launched spawn', {
        sessionId, host, spawned: status.exists === true,
      })
    }
  }
  if (status.exists === true && status.alive === true) {
    // Live path — FIFO write first, marker only after the confirmed write.
    const sent = await bridgeRequest(host, 'send', { sid: sessionId, message: text })
    if (sent.ok !== true) {
      const reason = String(sent.reason ?? sent.error ?? 'unknown')
      if (reason === 'ENXIO' || reason === 'session_dead' || reason === 'not_found') {
        sendError(res, 409, 'session_dead', 'Session process died mid-send')
      } else {
        sendError(res, 503, 'bridge_offline', `Send failed: ${reason}`)
      }
      return
    }
    await bridgeRequest(host, 'appendUserMarker', { sid: sessionId, message: text, messageId }).catch(() => {})
  } else {
    // Dead/lost path — resume. The daemon rebuilds argv from its stored
    // record when it survived, else from the cwd/model hints we pass from
    // the projection; bridgeResume writes the message as the initial stdin
    // line, same as the Mac's --resume spawn path in session-runner.
    const resumed = await bridgeRequest(host, 'bridgeResume', {
      sid: sessionId, message: text, cwd: projected.cwd, model: projected.model,
    }, 30_000)
    if (!resumed.pid) {
      const reason = String(resumed.error ?? 'resume failed')
      sendError(res, 409, 'session_dead', reason)
      return
    }
    // Marker only after the confirmed respawn (loss-safe order).
    await bridgeRequest(host, 'appendUserMarker', { sid: sessionId, message: text, messageId }).catch(() => {})
    log.web.info('mobile session resumed via bridge', { sessionId, host, messageId, pid: resumed.pid })
  }
  log.web.info('mobile session send via bridge (direct fallback)', { sessionId, host, messageId })
  res.status(202).json({ messageId })
}

// ─── Cloud fresh transcript: raw jsonl over the bridge → slim tail ──────────

const TRANSCRIPT_TAIL_ROWS = 200
// Tail-only read over the bridge: ~200 rendered rows fit comfortably in the
// last 512KB even with tool-result noise. A whale session's full 10MB+ jsonl
// as one bridge frame is exactly the proxy-killing payload class (inc-…925).
const TRANSCRIPT_TAIL_BYTES = 512 * 1024

/**
 * Build a SessionTranscript-shaped payload by reading the session's live
 * jsonl over the daemon bridge (read-history RPC). Returns null when the
 * bridge is down or the session is unknown — caller falls back to the
 * git-synced file. Main lane only, mirroring buildSessionTranscript's shape.
 */
export async function buildTranscriptViaBridge(sessionId: string): Promise<Record<string, unknown> | null> {
  const host = await projectedHostForSession(sessionId)
  if (!host) return null
  const { bridgeRequest, bridgeForHost } = await import('../ws/bridge-registry.js')
  if (!bridgeForHost(host).connected) return null
  const { toolDetail, toolResultPreview, toolResultText } = await import('../../core/tool-summary.js')
  const res = await bridgeRequest(host, 'read-history', { sid: sessionId, tailBytes: TRANSCRIPT_TAIL_BYTES })
  if (res.ok !== true || typeof res.main !== 'string' || res.main === '') return null

  const lines: Array<Record<string, unknown>> = []
  for (const line of res.main.split('\n')) {
    if (!line.trim()) continue
    try { lines.push(JSON.parse(line)) } catch { continue }
  }

  // Pre-scan tool_result carrier lines so tool rows can attach output previews.
  const resultsById = new Map<string, string>()
  for (const parsed of lines) {
    if (parsed.type !== 'user') continue
    const content = (parsed.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown }
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const text = toolResultText(b.content)
        if (text) resultsById.set(b.tool_use_id, text)
      }
    }
  }

  const messages: Array<{ role: string; text: string; timestamp: string; kind?: 'tool' | 'thinking'; detail?: string; resultPreview?: string; agent?: string }> = []
  for (const parsed of lines) {
    if (parsed.parent_tool_use_id) continue // subagent lane
    // CLI-injected user lines (skill dumps, compaction summaries) — same skip
    // as buildSessionTranscript's `m.injected` filter on the primary box.
    // walnut-injected markers are exempt: they ARE the user's words.
    if (parsed.subtype !== 'walnut-injected'
        && (parsed.isMeta === true || parsed.isSynthetic === true
          || parsed.isCompactSummary === true || parsed.isVisibleInTranscriptOnly === true)) continue
    const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString()
    const type = parsed.type as string
    const content = (parsed.message as { content?: unknown } | undefined)?.content

    if (type === 'user') {
      // Real user turns + walnut-injected markers (both ARE the user's words);
      // tool_result carrier lines have array content with tool_result blocks.
      // Drop ONLY the CLI's interrupt markers — the old blanket startsWith('[')
      // filter also swallowed "[Images attached — use the Read tool …]" turns
      // (every phone/web image send), so a cloud fresh=1 read showed a
      // transcript with the user's image messages missing while the primary
      // path (buildSessionTranscript) kept them. Keep parity with primary:
      // everything the human's turn carries survives.
      if (typeof content === 'string') {
        const text = content.trim()
        if (text && !isInterruptMarker(text)) messages.push({ role: 'user', text: clipUserText(text), timestamp })
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string }
          const text = b.type === 'text' ? b.text?.trim() : undefined
          if (text && !isInterruptMarker(text)) {
            messages.push({ role: 'user', text: clipUserText(text), timestamp })
          }
        }
      }
    } else if (type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }
        if (b.type === 'text' && b.text?.trim()) {
          messages.push({ role: 'assistant', text: clip(b.text.trim()), timestamp })
        } else if (b.type === 'tool_use') {
          const detail = toolDetail(b.name ?? '', b.input)
          const result = typeof b.id === 'string' ? resultsById.get(b.id) : undefined
          // Subagent attribution (additive) — parity with the primary path
          // (session-projection.ts buildSessionTranscript): Task/Agent rows
          // carry the subagent's name/subagent_type as `agent`.
          let agent: string | undefined
          if ((b.name === 'Task' || b.name === 'Agent') && b.input) {
            const input = b.input as Record<string, unknown>
            agent = (typeof input.name === 'string' && input.name ? input.name : undefined)
              ?? (typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : undefined)
          }
          messages.push({
            role: 'assistant', text: b.name ?? 'tool', timestamp, kind: 'tool',
            ...(detail ? { detail } : {}),
            ...(result ? { resultPreview: toolResultPreview(result) } : {}),
            ...(agent ? { agent } : {}),
          })
        }
      }
    }
  }

  const truncated = messages.length > TRANSCRIPT_TAIL_ROWS
  return {
    version: 1,
    sessionId,
    exportedAt: new Date().toISOString(),
    truncated,
    messages: truncated ? messages.slice(-TRANSCRIPT_TAIL_ROWS) : messages,
  }
}

/** Same budgets and the same HTML-safe cut as the primary path — a rich reply
 *  must not arrive whole on one route and cut mid-attribute on the other
 *  (core/sessions/transcript-clip.ts). */
function clip(text: string): string {
  return clipTranscriptText(text)
}

/** A USER row, minus the output-mode wrapper the send path appended and the CLI
 *  echoed into its JSONL. The primary path strips it at the history projection
 *  choke point (core/session-history.ts); this route is a SECOND parser of the
 *  same JSONL, so without the same call the phone shows the machine instruction
 *  as part of what the human typed — on every message, since the reminder rides
 *  every send while rich holds. Strip BEFORE clipping so the budget is spent on
 *  the human's words. */
function clipUserText(text: string): string {
  return clipTranscriptText(stripOutputModeWrappers(text))
}

/** The CLI's abort echo ("[Request interrupted by user( for tool use)]") —
 *  plumbing, not the human's words. The only bracket-prefixed user line the
 *  slim tail hides (matches the web console's SessionMessage handling). */
function isInterruptMarker(text: string): boolean {
  return /^\[Request interrupted by user( for tool use)?\]$/.test(text)
}

// ─── POST /sessions/:id/messages ────────────────────────────────────────────

sessionStreamV1Router.post('/sessions/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = String(req.params.id ?? '')
    if (!SID_RE.test(sessionId)) {
      sendError(res, 400, 'bad_request', 'Invalid session id')
      return
    }
    // Additive: `images` allows an otherwise-empty text turn. Old clients that
    // send no images keep the exact 400-on-empty-text behavior.
    const images = extractValidImages(req.body?.images)
    const rawText = req.body?.text
    const text = typeof rawText === 'string' ? rawText : ''
    if (text.trim() === '' && images.length === 0) {
      sendError(res, 400, 'bad_request', 'text (non-empty string) is required')
      return
    }

    // Cloud-owned session (cloud.exec): the CLI is on THIS box, so it takes the
    // primary-box path below — same durable queue, same session-runner delivery,
    // same images-on-local-disk handling. The bridge exists for sessions on
    // OTHER machines; relaying our own session to the Mac would hand it to a
    // machine with no such process.
    const servedLocally = CLOUD_MODE
      ? (await (await import('../../core/cloud-owned-session.js')).cloudOwnedSession(sessionId)) !== null
      : true
    if (CLOUD_MODE && !servedLocally) {
      // The CLI runs on a different machine than this EC2 replica, so images
      // are saved on the SESSION'S HOST via the narrow bridge-allowlisted
      // `image.save` daemon command (deliberately NOT fs.write — see the
      // containment note in daemon-standalone.ts), then referenced by path in
      // the augmented text the same way the primary-box path does below.
      //
      // Additive: `messageId` lets a retrying client reuse its original id so
      // the durable-queue enqueue is idempotent (a retry after a lost ack can
      // never double-deliver). Shape-gated to the queue's own qm- vocabulary.
      const rawMid = req.body?.messageId
      const clientMessageId = typeof rawMid === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(rawMid)
        ? rawMid : undefined
      await cloudSend(res, sessionId, text, images, clientMessageId)
      return
    }

    const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      sendError(res, 404, 'not_found', `Session not found: ${sessionId}`)
      return
    }

    // Save images to disk and reference them by path in the augmented message —
    // the CLI's stdin only takes text, so it reads the files with its Read tool.
    // Same "[Images attached …]" prefix format as the WS session-chat path.
    // Remote sessions: RemoteSessionManager.prepareOutbound() uploads the local
    // files and rewrites the paths on the way to the exec host (no work here).
    let enqueueText: string | undefined
    if (images.length > 0) {
      const { saveImageToDisk } = await import('./images.js')
      const savedPaths: string[] = []
      for (const img of images) {
        try {
          const { filePath } = await saveImageToDisk(img.data, img.mediaType)
          savedPaths.push(filePath)
        } catch (err) {
          log.web.warn('Failed to save mobile session image', { sessionId, error: err instanceof Error ? err.message : String(err) })
        }
      }
      if (savedPaths.length > 0) {
        const pathList = savedPaths.map((p) => `- ${p}`).join('\n')
        enqueueText = `[Images attached — use the Read tool to view them]\n${pathList}\n\n${text}`
      }
    }

    // Additive idempotency (parity with the cloud relay): a retrying phone
    // reuses its original qm- id, so a retry after a lost 202 can't enqueue
    // the same turn twice.
    const rawMid = req.body?.messageId
    const clientMessageId = typeof rawMid === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(rawMid)
      ? rawMid : undefined
    // Output mode rides the phone's sends too. The model only learns its reply
    // STYLE from the conversation, and the instruction/reminder used to be
    // applied by the web RPC alone — so a rich session answered the console in
    // HTML and answered the phone in plain markdown, and a phone turn in the
    // middle of a rich session dropped the standing reminder entirely. Same
    // three steps as the console (core/sessions/output-mode-send.ts): wrap the
    // text the CLI receives, leave what the human sees alone, advance the edge
    // only after the enqueue.
    const outputMode = await prepareOutputModeSend(sessionId, record, enqueueText ?? text)
    const { sendMessageToSession } = await import('../../core/session-message-queue.js')
    const msg = await sendMessageToSession(sessionId, text, {
      source: 'mobile',
      taskId: record.taskId,
      ...(outputMode.enqueueText !== text ? { enqueueMessage: outputMode.enqueueText } : {}),
      ...(clientMessageId ? { messageId: clientMessageId } : {}),
    })
    await outputMode.commit()
    log.web.info('mobile session send accepted', { sessionId, messageId: msg.id, imageCount: images.length })
    res.status(202).json({ messageId: msg.id })
  } catch (err) {
    next(err)
  }
})

// ─── GET /sessions/:id/stream ───────────────────────────────────────────────

sessionStreamV1Router.get('/sessions/:id/stream', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = String(req.params.id ?? '')
    if (!SID_RE.test(sessionId)) {
      sendError(res, 400, 'bad_request', 'Invalid session id')
      return
    }

    // Cloud-owned session: its CLI is on THIS box, so its stream comes from the
    // local event bus exactly like on the primary — there is no bridge to attach
    // (a self-bridge would loop our own frames back at us). Falls through below.
    const ownedLocally = CLOUD_MODE
      ? (await (await import('../../core/cloud-owned-session.js')).cloudOwnedSession(sessionId)) !== null
      : false

    if (CLOUD_MODE && !ownedLocally) {
      // Cloud path: attach the daemon's jsonl stream over the bridge, then
      // hook this response onto the session's SSE channel. Whether the bridge
      // is up or not the response is 200 — the client keys off the
      // bridge-online/offline events (single code path, falls back to polling).
      const host = await projectedHostForSession(sessionId)
      if (!host) {
        sendError(res, 404, 'not_found', `Session not found: ${sessionId}`)
        return
      }
      const { bridgeAttachSession, bridgeDetachSession, bridgeForHost } = await import('../ws/bridge-registry.js')
      let online = bridgeForHost(host).connected
      if (online) {
        try {
          await bridgeAttachSession(host, sessionId)
        } catch (err) {
          // An attach failure is NOT proof the host is down — only the bridge
          // socket's absence is. Two failure shapes land here with a healthy
          // socket: (a) per-session refusal — an ACP/codex session's journal is
          // keyed by its runtimeId, so the daemon tailer finds no <sid>.jsonl
          // and answers ok:false; (b) a transient attach RPC timeout on a busy
          // daemon. Both used to flip this page to bridge-offline, painting
          // "Mac unreachable — read-only" on ONE healthy session while its
          // neighbors streamed over the same bridge (2026-08-16, twice: a
          // codex session and a plain claude session). Sends still work via
          // the durable relay and transcripts via the poll, so stay ONLINE
          // whenever the socket survives; only a genuinely absent bridge
          // reports offline. Cost of the tradeoff: a live tail may be missing
          // (no status/delta frames) — the phone's polling covers that.
          online = bridgeForHost(host).connected
          log.web.info('session stream: bridge attach failed', {
            sessionId, host, stillOnline: online,
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const isOnline = online
      attachSse(channelKey(sessionId), req, res, {
        onAttach: (write) => write(isOnline ? 'bridge-online' : 'bridge-offline', {}),
        onClose: () => {
          if (sseConnCount(channelKey(sessionId)) === 0) bridgeDetachSession(host, sessionId)
        },
      })
      return
    }

    const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      sendError(res, 404, 'not_found', `Session not found: ${sessionId}`)
      return
    }

    // Byte-budget the attach frame: the snapshot rides ONE SSE `data:` line
    // and the phone hard-caps a line at 4MB — an unbounded whale-turn
    // snapshot livelocked the client in a reconnect→same-snapshot loop
    // (audit IO-3). The phone renders only the newest ~96K chars anyway.
    const snapshot = budgetSnapshotBlocks(sessionStreamBuffer.getSnapshot(sessionId))
    // ownedLocally is the ONLY thing that unlatches the bus subscriber on a
    // cloud box: we have already proved this session's CLI is here.
    addInterest(sessionId, ownedLocally)
    attachSse(channelKey(sessionId), req, res, {
      onAttach: (write) => {
        write('snapshot', {
          blocks: snapshot.blocks,
          isStreaming: snapshot.isStreaming,
          completedLen: snapshot.completedLen,
          processStatus: record.process_status ?? '',
        })
      },
      onClose: () => {
        dropInterest(sessionId)
        log.web.debug('session stream closed', { sessionId, remaining: sseConnCount(channelKey(sessionId)) })
      },
    })
  } catch (err) {
    next(err)
  }
})
