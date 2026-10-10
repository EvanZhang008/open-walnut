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
 * session's host comes from core/sessions/cloud-session-host.ts (synced
 * projection first, the primary asked directly when the projection's bounded
 * list does not carry the session). Sends ride the narrow
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
 * is 404/409, and "unknown" here means the PRIMARY said so — a primary that
 * cannot be reached is 503 bridge_offline like every other unreachable hop.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { bus } from '../../core/event-bus.js'
import { emitSse, attachSse, sseConnCount } from '../sse-channels.js'
import { sessionStreamBuffer, budgetSnapshotBlocks } from '../session-stream-buffer.js'
import { resolveCloudSessionHost, PrimaryUnreachableError } from '../../core/sessions/cloud-session-host.js'
import { resolveHostOrAnswer } from './cloud-session-send.js'
import { postSessionMessage, getSessionMessageStatus } from './session-send-v1.js'
import { transcriptFromJsonl, TRANSCRIPT_TAIL_BYTES } from '../../core/sessions/transcript-from-jsonl.js'
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
const interested = new Map<string, {
  conns: number
  linger?: NodeJS.Timeout
  /** Highest statusRevision relayed for this session (see the status case). */
  statusRevision?: number
}>()
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
        const { toolDetail, toolInputPreview } = await import('../../core/tool-summary.js')
        const input = d.input as Record<string, unknown> | undefined
        const detail = toolDetail(String(d.toolName ?? ''), input)
        // Additive: `detail` is the collapsed one-liner (Bash prefers `description`,
        // so the command itself never reached the phone), `inputPreview` is the same
        // bounded, masked `key: value` render the history row carries.
        const inputPreview = toolInputPreview(input)
        emitSse(key, 'tool', {
          name: d.toolName ?? '', toolUseId: d.toolUseId ?? '',
          ...(detail ? { detail } : {}),
          ...(inputPreview ? { inputPreview } : {}),
        })
        return
      }
      case 'session:tool-result': {
        if (d.parentToolUseId) return
        // Additive: the same bounded, masked <=700-character excerpt the history row
        // carries, so a finished live row can show its output before the transcript
        // lands (the phone's drawer used to say "No output" for a tool that had
        // output). The emitter already caps the bus event at 2000 characters; the
        // FULL text still only travels via the row's `detailRef` read.
        const { toolResultPreview } = await import('../../core/tool-summary.js')
        const resultPreview = toolResultPreview(typeof d.result === 'string' ? d.result : undefined)
        emitSse(key, 'tool-result', {
          toolUseId: d.toolUseId ?? '',
          ...(resultPreview ? { resultPreview } : {}),
        })
        return
      }
      case 'session:status-changed': {
        const ps = typeof d.process_status === 'string' ? d.process_status : ''
        if (!ps) return
        // Every status event is a whole record stamped with its statusRevision,
        // and two writers' events can reach the bus out of order (the runner's
        // echo of an older record landing after the snapshot's newer one). The
        // web console drops the older one by revision; the phone's frame has no
        // revision to sort by, so the older one is dropped here.
        const entry = interested.get(sid)
        const rev = typeof d.statusRevision === 'number' ? d.statusRevision : undefined
        if (entry && rev !== undefined) {
          if (entry.statusRevision !== undefined && rev < entry.statusRevision) return
          entry.statusRevision = rev
        }
        // 'running' from session-runner = a real turn is starting → reset the
        // replay window. daemon-reconnect's 'running' is a reconciliation
        // artifact (SSH flap), NOT a turn — treating it as one gave phones
        // phantom turn boundaries (same guard as server.ts markStreaming).
        if (ps === 'running' && event.source !== 'daemon-reconnect' && event.source !== 'session-tracker') {
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

// Host lookup lives in core/sessions/cloud-session-host.ts: own registry →
// projection → launch seed → ask the PRIMARY over the existing `detail` control
// relay. Every cloud branch below goes through it, because the projection is a
// bounded LIST projection ("what to show") and was being used as an EXISTENCE
// oracle ("does it exist") — existence is the primary's to answer. A session
// stopped for more than STOPPED_RETENTION_DAYS is not in the list, and the send
// answered its own local 404 for a session the primary knew about.
//
// The send itself (relay, hold, direct path, deadline): cloud-session-send.ts.

// ─── Cloud fresh transcript: raw jsonl over the bridge → slim tail ──────────
// (the parse: core/sessions/transcript-from-jsonl.ts)

/**
 * Build a SessionTranscript-shaped payload by reading the session's live
 * jsonl over the daemon bridge (read-history RPC). Returns null when the
 * bridge is down or the session is unknown — caller falls back to the
 * git-synced file. Main lane only, mirroring buildSessionTranscript's shape.
 */
export async function buildTranscriptViaBridge(sessionId: string): Promise<Record<string, unknown> | null> {
  // A session outside the projection's retention window resolves through the
  // primary; an unreachable primary is just another "no live read available
  // right now", and this caller already degrades to the synced file.
  const resolved = await resolveCloudSessionHost(sessionId).catch((err: unknown) => {
    if (err instanceof PrimaryUnreachableError) return null
    throw err
  })
  const host = resolved?.host
  if (!host) return null
  const { bridgeForHost } = await import('../ws/bridge-registry.js')
  if (!bridgeForHost(host).connected) return null
  // One read per session however many phones (or retries) ask at once, reused
  // while nothing new reached the session (ws/bridge-read-history.ts).
  const { coalescedSessionRead } = await import('../ws/bridge-read-history.js')
  return coalescedSessionRead(host, sessionId, () => readTranscriptViaBridge(host, sessionId))
}

async function readTranscriptViaBridge(host: string, sessionId: string): Promise<Record<string, unknown> | null> {
  const { bridgeRequest } = await import('../ws/bridge-registry.js')
  const res = await bridgeRequest(host, 'read-history', { sid: sessionId, tailBytes: TRANSCRIPT_TAIL_BYTES })
  if (res.ok !== true || typeof res.main !== 'string' || res.main === '') return null
  return transcriptFromJsonl(sessionId, res.main)
}

// ─── POST /sessions/:id/messages and GET /sessions/:id/messages/:messageId ──
//
// The send endpoints live in session-send-v1.ts (the cloud half in
// cloud-session-send.ts); they stay on this router, so the API is unchanged.

sessionStreamV1Router.post('/sessions/:id/messages', postSessionMessage)
sessionStreamV1Router.get('/sessions/:id/messages/:messageId', getSessionMessageStatus)

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
      const resolved = await resolveHostOrAnswer(res, sessionId)
      if (!resolved) return
      const host = resolved.host
      const {
        bridgeAttachSession, bridgeDetachSession, bridgeForHost, bridgePhoneState, noteStreamWithoutBridge,
      } = await import('../ws/bridge-registry.js')
      const phoneState = bridgePhoneState(host)
      let online = phoneState !== 'offline'
      if (phoneState === 'connected') {
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
      if (phoneState !== 'connected' || !online) {
        // No socket to attach through (or it died mid-attach). The redial
        // re-attaches this page, and one told offline is owed a `bridge-online`
        // then. Inside the grace window a routine redial hole is not news
        // (ws/bridge-presence.ts).
        noteStreamWithoutBridge(host, sessionId, online ? 'online' : 'offline')
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
