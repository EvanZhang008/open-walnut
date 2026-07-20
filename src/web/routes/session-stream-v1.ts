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
 * session's host comes from the git-synced projection; sends run the same
 * three-step sequence the Mac uses (status precheck → appendUserMarker →
 * FIFO send), so the Mac's byte-offset replay absorbs phone turns with zero
 * coordination. A dead CLI is 409 session_dead (resume/respawn stays a
 * Mac-side responsibility); no bridge is 503 bridge_offline.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import crypto from 'node:crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { bus } from '../../core/event-bus.js'
import { emitSse, attachSse, sseConnCount } from '../sse-channels.js'
import { sessionStreamBuffer } from '../session-stream-buffer.js'
import { log } from '../../logging/index.js'

export const sessionStreamV1Router = Router()

const SID_RE = /^[A-Za-z0-9_-]+$/

// ── Image attachments (additive) — mirrors session-chat.ts constants ──
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_SESSION_IMAGES = 5
const MAX_IMAGE_BASE64_LENGTH = 14_000_000 // ~10MB binary

interface SessionImage { data: string; mediaType: string }

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

function addInterest(sessionId: string): void {
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
  if (busSubscribed || CLOUD_MODE) return
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
        emitSse(key, 'tool', { name: d.toolName ?? '', toolUseId: d.toolUseId ?? '' })
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
  const { readSessionProjection } = await import('../../core/session-projection.js')
  const projection = await readSessionProjection()
  const s = projection?.sessions.find((p) => p.id === sessionId)
  if (!s) return null
  // Projection: '' = the primary box; daemons register as '__local__'.
  return { host: s.host === '' ? '__local__' : s.host, cwd: s.cwd, model: s.model }
}

async function projectedHostForSession(sessionId: string): Promise<string | null> {
  return (await projectedSession(sessionId))?.host ?? null
}

async function cloudSend(res: Response, sessionId: string, text: string): Promise<void> {
  const projected = await projectedSession(sessionId)
  if (!projected) {
    sendError(res, 404, 'not_found', `Session not found: ${sessionId}`)
    return
  }
  const host = projected.host
  const { bridgeRequest, BridgeOfflineError } = await import('../ws/bridge-registry.js')
  try {
    // Liveness precheck — if the CLI is gone (dead record, or the record
    // itself was lost to a daemon restart), attempt a bridgeResume instead
    // of 409. This lets the phone send to idle/stopped/error sessions
    // without the Mac being online. The daemon gates the resume on the
    // session's jsonl existing on that host.
    const status = await bridgeRequest(host, 'status', { sid: sessionId })
    const messageId = `qm-mobile-${crypto.randomBytes(6).toString('hex')}`
    if (status.exists === true && status.alive === true) {
      // Live path — append marker + FIFO write (same as before).
      await bridgeRequest(host, 'appendUserMarker', { sid: sessionId, message: text, messageId })
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
    } else {
      // Dead/lost path — resume. The daemon rebuilds argv from its stored
      // record when it survived, else from the cwd/model hints we pass from
      // the projection. Marker first (best-effort — it needs a record, and
      // the jsonl survives death) so the transcript shows the user's
      // message; bridgeResume then writes it as the initial stdin line,
      // same as the Mac's --resume spawn path in session-runner.
      if (status.exists === true) {
        await bridgeRequest(host, 'appendUserMarker', { sid: sessionId, message: text, messageId }).catch(() => {})
      }
      const resumed = await bridgeRequest(host, 'bridgeResume', {
        sid: sessionId, message: text, cwd: projected.cwd, model: projected.model,
      }, 30_000)
      if (!resumed.pid) {
        const reason = String(resumed.error ?? 'resume failed')
        sendError(res, 409, 'session_dead', reason)
        return
      }
      log.web.info('mobile session resumed via bridge', { sessionId, host, messageId, pid: resumed.pid })
    }
    log.web.info('mobile session send via bridge', { sessionId, host, messageId })
    res.status(202).json({ messageId })
  } catch (err) {
    if (err instanceof BridgeOfflineError) {
      sendError(res, 503, 'bridge_offline', 'No live bridge to this session\'s host')
      return
    }
    sendError(res, 503, 'bridge_offline', err instanceof Error ? err.message : String(err))
  }
}

// ─── Cloud fresh transcript: raw jsonl over the bridge → slim tail ──────────

const TRANSCRIPT_TAIL_ROWS = 200
const TRANSCRIPT_TEXT_MAX = 4_000
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
  const res = await bridgeRequest(host, 'read-history', { sid: sessionId, tailBytes: TRANSCRIPT_TAIL_BYTES })
  if (res.ok !== true || typeof res.main !== 'string' || res.main === '') return null

  const messages: Array<{ role: string; text: string; timestamp: string; kind?: 'tool' | 'thinking' }> = []
  for (const line of res.main.split('\n')) {
    if (!line.trim()) continue
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed.parent_tool_use_id) continue // subagent lane
    const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString()
    const type = parsed.type as string
    const content = (parsed.message as { content?: unknown } | undefined)?.content

    if (type === 'user') {
      // Real user turns + walnut-injected markers (both ARE the user's words);
      // tool_result carrier lines have array content with tool_result blocks.
      if (typeof content === 'string') {
        const text = content.trim()
        if (text && !text.startsWith('[')) messages.push({ role: 'user', text: clip(text), timestamp })
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string }
          if (b.type === 'text' && b.text?.trim() && !b.text.trim().startsWith('[')) {
            messages.push({ role: 'user', text: clip(b.text.trim()), timestamp })
          }
        }
      }
    } else if (type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; text?: string; name?: string }
        if (b.type === 'text' && b.text?.trim()) {
          messages.push({ role: 'assistant', text: clip(b.text.trim()), timestamp })
        } else if (b.type === 'tool_use') {
          messages.push({ role: 'assistant', text: b.name ?? 'tool', timestamp, kind: 'tool' })
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

function clip(text: string): string {
  return text.length > TRANSCRIPT_TEXT_MAX ? text.slice(0, TRANSCRIPT_TEXT_MAX) + '…' : text
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

    if (CLOUD_MODE) {
      // The CLI runs on a different machine than this EC2 replica, so images
      // saved here are unreadable by the session's Read tool. Uploading base64
      // over the bridge needs the privileged fs.write (not in the bridge
      // allowlist) — out of scope. Reject clearly instead of silently dropping.
      if (images.length > 0) {
        sendError(res, 400, 'images_not_supported_cloud', 'Images can only be sent to sessions from the primary box')
        return
      }
      await cloudSend(res, sessionId, text)
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

    const { sendMessageToSession } = await import('../../core/session-message-queue.js')
    const msg = await sendMessageToSession(sessionId, text, {
      source: 'mobile',
      taskId: record.taskId,
      ...(enqueueText ? { enqueueMessage: enqueueText } : {}),
    })
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

    if (CLOUD_MODE) {
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
        try { await bridgeAttachSession(host, sessionId) } catch { online = false }
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

    const snapshot = sessionStreamBuffer.getSnapshot(sessionId)
    addInterest(sessionId)
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
