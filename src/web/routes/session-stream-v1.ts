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
 * Frozen-contract note: everything here is additive (docs/api-v1.md).
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

async function projectedHostForSession(sessionId: string): Promise<string | null> {
  const { readSessionProjection } = await import('../../core/session-projection.js')
  const projection = await readSessionProjection()
  const s = projection?.sessions.find((p) => p.id === sessionId)
  if (!s) return null
  // Projection: '' = the primary box; daemons register as '__local__'.
  return s.host === '' ? '__local__' : s.host
}

async function cloudSend(res: Response, sessionId: string, text: string): Promise<void> {
  const host = await projectedHostForSession(sessionId)
  if (!host) {
    sendError(res, 404, 'not_found', `Session not found: ${sessionId}`)
    return
  }
  const { bridgeRequest, BridgeOfflineError } = await import('../ws/bridge-registry.js')
  try {
    // Mirror the Mac's send sequence: liveness precheck → turn-start marker
    // (walnutMessageId dedup rides the jsonl) → FIFO write.
    const status = await bridgeRequest(host, 'status', { sid: sessionId })
    if (status.exists !== true || status.alive !== true) {
      sendError(res, 409, 'session_dead', 'Session process is not running — wake it from your desktop')
      return
    }
    const messageId = `qm-mobile-${crypto.randomBytes(6).toString('hex')}`
    await bridgeRequest(host, 'appendUserMarker', { sid: sessionId, message: text, messageId })
    const sent = await bridgeRequest(host, 'send', { sid: sessionId, message: text })
    if (sent.ok !== true) {
      const reason = String(sent.reason ?? sent.error ?? 'unknown')
      if (reason === 'ENXIO' || reason === 'session_dead' || reason === 'not_found') {
        sendError(res, 409, 'session_dead', 'Session process is not running — wake it from your desktop')
      } else {
        sendError(res, 503, 'bridge_offline', `Send failed: ${reason}`)
      }
      return
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
    const text = req.body?.text
    if (typeof text !== 'string' || text.trim() === '') {
      sendError(res, 400, 'bad_request', 'text (non-empty string) is required')
      return
    }

    if (CLOUD_MODE) {
      await cloudSend(res, sessionId, text)
      return
    }

    const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      sendError(res, 404, 'not_found', `Session not found: ${sessionId}`)
      return
    }
    const { sendMessageToSession } = await import('../../core/session-message-queue.js')
    const msg = await sendMessageToSession(sessionId, text, {
      source: 'mobile',
      taskId: record.taskId,
    })
    log.web.info('mobile session send accepted', { sessionId, messageId: msg.id })
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
