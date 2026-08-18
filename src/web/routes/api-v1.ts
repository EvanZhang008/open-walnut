/**
 * /api/v1 — frozen REST+SSE facade for mobile clients (iOS app).
 *
 * Design goals:
 * - FROZEN CONTRACT: additive-only changes; see docs/reference/api-v1.md.
 * - Reuses the exact same per-agent turn queue as the WebSocket chat
 *   (enqueueAgentTurn('general', …)) so a REST turn and a WS turn on the same
 *   conversation can never interleave — one serialization path, not two.
 * - SSE streaming with a per-conversation ring buffer of the CURRENT turn's
 *   events (monotonic seq ids) so late joiners and reconnects (Last-Event-ID)
 *   replay what they missed.
 * - Notes endpoints reuse the notes-v2 service helpers (path safety, hashing,
 *   id stamping, index reconcile) — same vault semantics, simpler shapes.
 * - Errors: { error: { code, message } } + proper HTTP status.
 *
 * Auth is inherited from the global /api authMiddleware (device Bearer tokens
 * in cloud mode, LAN bypass otherwise). This router implements none.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Router, type Request, type Response, type NextFunction } from 'express'
import type { MessageParam } from '../../agent/model.js'
import { VALID_PRIORITIES, type ChatEntry, type TaskPhase, type TaskPriority } from '../../core/types.js'
import { VALID_PHASES } from '../../core/phase.js'
import { CLOUD_MODE, LOG_DIR, NOTES_DIR } from '../../constants.js'
import * as chatHistory from '../../core/chat-history.js'
import { listConversations, createConversation } from '../../core/conversations.js'
import { enqueueAgentTurn, recordLastTurnTokens, getQueueStatus } from '../agent-turn-queue.js'
import { triggerBackgroundCompaction } from '../background-compaction.js'
import { broadcastEvent } from '../ws/handler.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { usageTracker } from '../../core/usage/index.js'
import { getLastSyncAt } from '../../integrations/git-sync.js'
import { setDeviceInfo } from '../../core/device-auth.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { parseFrontmatter, readId, generateNoteId, stampId } from '../../core/parse-frontmatter.js'
import { toolDetail, toolResultPreview, toolResultText } from '../../core/tool-summary.js'
import { scheduleNotesIndexUpdate } from '../../core/notes-indexer.js'
import {
  ensureIndexBootstrap,
  ensureNotesDir,
  resolveSafePath,
  toRelPath,
  getWildcardPath,
  scanDir,
  MAX_NOTE_SIZE,
} from './notes-v2.js'
import { emitSse as emitChannelSse, attachSse, closeAllSseChannels } from '../sse-channels.js'
import { mirrorRelayedChatFrame, relayChatTurnToPrimary, FALLBACK_ENGINE_LABEL } from './chat-turn-relay.js'
import { processAndSaveImages, buildImageAnnotation, buildSessionImageContext, type ImagePayload } from './images.js'
import { stripEntityRefs } from '../../utils/entity-refs.js'
import { log } from '../../logging/index.js'

export const apiV1Router = Router()

/** Default agent when the client doesn't pass ?agentId= (frozen v1 behavior). */
const DEFAULT_AGENT_ID = 'general'

/**
 * Resolve the agentId for a request (additive: absent → 'general'). Returns
 * null for a malformed id; existence is checked by the caller against the
 * console-agent registry.
 */
function requestAgentId(req: Request): string | null {
  const raw = (typeof req.query.agentId === 'string' && req.query.agentId)
    || (typeof req.body?.agentId === 'string' && req.body.agentId)
    || DEFAULT_AGENT_ID
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw) ? raw : null
}

/** 404-checked console-agent lookup — non-console agents are invisible to v1. */
async function consoleAgentExists(agentId: string): Promise<boolean> {
  if (agentId === DEFAULT_AGENT_ID) return true
  const { getConsoleAgent } = await import('../../core/agent-registry.js')
  return !!(await getConsoleAgent(agentId))
}

// ── Error shape helper — frozen: { error: { code, message } } ──

function sendError(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message }, ...(extra ?? {}) })
}

/** Express 5 types params as string | string[] once a router has *wildcard routes. */
function paramStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join('/')
  return v ?? ''
}

// ── Router-level middleware: version marker on every v1 response ──

apiV1Router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Walnut-API', '1')
  next()
})

// ── Version (moved to core/version.ts so the bug-report bundler can share it) ──

import { getVersion } from '../../core/version.js'

// ─── POST /api/v1/devices/self ─────────────────────────────────────────────

/**
 * A paired client reports its own hardware/app identity so the console can show
 * "iPhone17,1 · iOS 26.1" instead of just the name typed at pairing time.
 *
 * The device is identified by its BEARER TOKEN (req.deviceName, set by
 * authMiddleware) — never by a name in the body, which would let any paired
 * device overwrite another's record.
 *
 * Clients call this on every launch, which makes it the backfill path too:
 * phones paired before this endpoint existed populate themselves on next open.
 * Trusted-LAN requests carry no device identity, so there is nothing to attach
 * the report to — those get 400 rather than a silent no-op.
 */
apiV1Router.post('/devices/self', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceName = (req as Request & { deviceName?: string }).deviceName
    if (!deviceName) {
      res.status(400).json({ error: 'This endpoint requires a device Bearer token' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const updated = await setDeviceInfo(deviceName, {
      model: body.model as string | undefined,
      os: body.os as string | undefined,
      deviceName: body.deviceName as string | undefined,
      appVersion: body.appVersion as string | undefined,
    })
    if (!updated) {
      res.status(404).json({ error: 'Device not found' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/v1/status ────────────────────────────────────────────────────

apiV1Router.get('/status', async (_req: Request, res: Response) => {
  // mode: LIVE = talking to the primary (Mac at home); REPLICA = the cloud
  // companion serving synced data. Per-session talk capability is signalled by
  // bridgeHosts (additive) — daemons dial the cloud box directly, so a REPLICA
  // can still relay sends/streams for hosts listed there.
  let lastSyncAt: string | null = null
  try { lastSyncAt = getLastSyncAt() } catch { /* git unavailable — omit */ }
  let bridgeHostsList: Array<{ hostAlias: string; since: number }> | undefined
  if (CLOUD_MODE) {
    try {
      const { bridgeHosts } = await import('../ws/bridge-registry.js')
      bridgeHostsList = bridgeHosts().map((b) => ({ hostAlias: b.hostAlias, since: b.since }))
    } catch { /* registry unavailable — omit */ }
  }
  res.json({
    mode: CLOUD_MODE ? 'REPLICA' : 'LIVE',
    cloud: CLOUD_MODE,
    version: getVersion(),
    serverTime: new Date().toISOString(),
    ...(lastSyncAt ? { lastSyncAt } : {}),
    ...(bridgeHostsList ? { bridgeHosts: bridgeHostsList } : {}),
  })
})

// ─── Agents (additive) ─────────────────────────────────────────────────────

// GET /api/v1/agents — console agents the mobile client can chat with.
apiV1Router.get('/agents', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getConsoleAgents } = await import('../../core/agent-registry.js')
    const agents = await getConsoleAgents()
    res.json(agents.map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.description ? { description: a.description } : {}),
      isMain: a.id === DEFAULT_AGENT_ID,
    })))
  } catch (err) {
    next(err)
  }
})

// ─── Conversations ─────────────────────────────────────────────────────────

// GET /api/v1/conversations?limit=&agentId= — most-recent first
apiV1Router.get('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = requestAgentId(req)
    if (!agentId || !(await consoleAgentExists(agentId))) {
      sendError(res, 404, 'not_found', `Agent not found: ${req.query.agentId}`)
      return
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
    const list = await listConversations(agentId)
    const sorted = [...list].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    // Legacy stored titles can be a machine banner ("[Current: Sun, Jun 7…]")
    // derived before the title heuristic learned to skip them — treat those
    // as untitled rather than serving garbage to the client.
    const isBannerTitle = (t: string) => /^\[[^\]]*\]$/.test(t.trim())
    res.json(sorted.slice(0, limit).map((c) => ({
      id: c.id,
      ...(c.title && !isBannerTitle(c.title) ? { title: c.title } : {}),
      updatedAt: c.lastMessageAt,
      messageCount: c.messageCount,
    })))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/conversations — create a new conversation { title?, agentId? }
apiV1Router.post('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = requestAgentId(req)
    if (!agentId || !(await consoleAgentExists(agentId))) {
      sendError(res, 404, 'not_found', `Agent not found: ${req.body?.agentId}`)
      return
    }
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined
    const meta = await createConversation(agentId, title)
    res.status(201).json({ id: meta.id })
  } catch (err) {
    next(err)
  }
})

/** 404-checked conversation lookup shared by the message/stream endpoints. */
async function conversationExists(agentId: string, conversationId: string): Promise<boolean> {
  if (!/^conv-[A-Za-z0-9-]+$/.test(conversationId)) return false
  const list = await listConversations(agentId)
  return list.some((c) => c.id === conversationId)
}

// ── Message normalization (mobile-friendly flat shape) ──

const KIND_TEXT_MAX = 160

interface ApiV1Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt?: string
  kind?: 'tool' | 'thinking' | 'notification'
  /** notification provenance, e.g. 'session-error' | 'cron' — drives card styling. */
  source?: string
  /** kind:'tool' only (additive) — one-line input summary, e.g. "ls docs/". */
  detail?: string
  /** kind:'tool' only (additive) — clipped tool output for the expanded card. */
  resultPreview?: string
}

function shortText(s: string): string {
  return s.length > KIND_TEXT_MAX ? s.slice(0, KIND_TEXT_MAX) + '…' : s
}

/**
 * UI-only notification categories hidden from the mobile feed by default —
 * mirrors the web console: background diagnostics and runtime errors do not
 * belong in the conversation timeline. Errors live in Notifications.
 */
// NOTE: 'session-error'/'agent-error' entries are dropped EARLIER by
// chatHistory.isNotificationOnlyError() in normalizeEntries — they never
// reach this set, so don't list them here.
const HIDDEN_NOTIFICATION_SOURCES = new Set([
  'triage',
  'session',
  'subagent',
  'heartbeat',
])

/**
 * Drop machine banners prefixed onto user turns before the real message:
 * closed context blocks ("[Task Context]…[/Task Context]") and standalone
 * bracketed lines ("[Current: Sun, Jun 7…]", "[Pending Cron Notifications]").
 * Same policy as the console title derivation (src/core/conversations.ts).
 */
function stripLeadingBanners(text: string): string {
  let t = text
  const closeIdx = t.lastIndexOf('[/')
  if (closeIdx !== -1) {
    const after = t.slice(closeIdx)
    const nl = after.indexOf('\n')
    if (nl !== -1) t = after.slice(nl)
  }
  const lines = t.split('\n')
  let start = 0
  while (start < lines.length) {
    const s = lines[start].trim()
    if (s.length === 0 || /^\[[^\]]*\]$/.test(s)) { start++; continue }
    break
  }
  return lines.slice(start).join('\n').trim()
}

/**
 * Flatten chat entries into simple mobile messages. Assistant entries expand
 * in block order: thinking → kind:'thinking', tool_use → kind:'tool', and all
 * text blocks of one entry join into a single plain assistant message.
 * Tool-result-only user entries are skipped (they ride with the tool call).
 * UI-tagged notification entries become kind:'notification' + source (rendered
 * as cards); background diagnostics and errors are dropped entirely, matching
 * the web console and leaving errors to the notification API.
 * ids are positional ("m<index>") — stable for a given read, used as the
 * `before` cursor. Compaction can rewrite history, so treat cursors as
 * ephemeral: on a cursor miss, re-fetch from the tail.
 */
export function normalizeEntries(entries: ChatEntry[]): ApiV1Message[] {
  const out: ApiV1Message[] = []
  const push = (m: Omit<ApiV1Message, 'id'>) => {
    out.push({ id: `m${out.length}`, ...m })
  }

  // Pre-scan tool_result carriers (user entries skipped below) so tool rows
  // can carry a clipped output preview alongside the input summary.
  const resultsById = new Map<string, string>()
  for (const entry of entries) {
    if (entry.role !== 'user' || !Array.isArray(entry.content)) continue
    for (const block of entry.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const text = toolResultText(block.content)
        if (text) resultsById.set(block.tool_use_id, text)
      }
    }
  }

  for (const entry of entries) {
    const createdAt = entry.timestamp
    // Legacy runtime errors may be either ui-tagged cards or ai-tagged
    // synthetic responses. Neither belongs in the conversation feed.
    if (chatHistory.isNotificationOnlyError(entry)) continue
    // Machine-generated Quick Start banners ("[Quick Start] Session created…
    // Please update the task…") are agent instructions, not conversation —
    // the web console hides them entirely (ChatMessage.tsx); so do we. They
    // appear BOTH as ui echoes and as ai-tagged user turns. New launches no
    // longer send this message (titling + placement moved server-side,
    // 2026-07-31) — the filter stays for replaying OLD chat history.
    if (entry.role === 'user' && entry.source === 'quick-start') continue
    if (entry.tag === 'ui') {
      if (entry.notification && entry.source && HIDDEN_NOTIFICATION_SOURCES.has(entry.source)) continue
      const raw = typeof entry.content === 'string' ? entry.content : ''
      const text = stripEntityRefs(raw)
      if (!text) continue
      // System-generated notifications render as cards; plain ui echoes stay
      // ordinary bubbles.
      if (entry.notification || entry.source) {
        push({ role: entry.role, text, createdAt, kind: 'notification', source: entry.source ?? 'notification' })
      } else {
        push({ role: entry.role, text, createdAt })
      }
      continue
    }
    if (entry.role === 'user') {
      if (!chatHistory.isLogicalMessage(entry)) continue // tool_result carrier
      let text = entry.displayText ?? ''
      if (!text) {
        if (typeof entry.content === 'string') text = entry.content
        else if (Array.isArray(entry.content)) {
          text = (entry.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text!)
            .join('')
        }
      }
      // The CLI writes this marker on any AbortController fire (incl. idle
      // reaps) — a user bubble would misattribute it. Card, like the web.
      if (text.trim() === '[Request interrupted by user]') {
        push({ role: 'user', text: 'Turn interrupted', createdAt, kind: 'notification', source: 'interrupt' })
        continue
      }
      text = stripLeadingBanners(text)
      if (text) push({ role: 'user', text: stripEntityRefs(text), createdAt })
      continue
    }
    // assistant
    if (typeof entry.content === 'string') {
      if (entry.content) push({ role: 'assistant', text: stripEntityRefs(entry.content), createdAt })
      continue
    }
    if (!Array.isArray(entry.content)) continue
    const textParts: string[] = []
    for (const block of entry.content as Array<Record<string, unknown>>) {
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        push({ role: 'assistant', text: shortText(block.thinking), createdAt, kind: 'thinking' })
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const detail = toolDetail(block.name, block.input as Record<string, unknown> | undefined)
        const result = typeof block.id === 'string' ? resultsById.get(block.id) : undefined
        push({
          role: 'assistant', text: block.name, createdAt, kind: 'tool',
          ...(detail ? { detail } : {}),
          ...(result ? { resultPreview: toolResultPreview(result) } : {}),
        })
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        textParts.push(block.text)
      }
    }
    if (textParts.length > 0) push({ role: 'assistant', text: stripEntityRefs(textParts.join('')), createdAt })
  }
  return out
}

// GET /api/v1/conversations/:id/messages?limit=50&before=<cursor>&agentId=
apiV1Router.get('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = requestAgentId(req)
    if (!agentId || !(await consoleAgentExists(agentId))) {
      sendError(res, 404, 'not_found', `Agent not found: ${req.query.agentId}`)
      return
    }
    const conversationId = paramStr(req.params.id)
    if (!(await conversationExists(agentId, conversationId))) {
      sendError(res, 404, 'not_found', `Conversation not found: ${conversationId}`)
      return
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
    const { messages: entries } = await chatHistory.getDisplayEntries(
      1, Number.MAX_SAFE_INTEGER, agentId, conversationId,
    )
    let all = normalizeEntries(entries)
    const before = typeof req.query.before === 'string' ? req.query.before : undefined
    if (before) {
      const idx = Number(before.replace(/^m/, ''))
      if (Number.isFinite(idx)) all = all.slice(0, Math.max(0, idx))
    }
    // Tail window: the most recent `limit` messages, oldest-first. Client pages
    // back by passing the first message's id as `before`.
    res.json(all.slice(-limit))
  } catch (err) {
    next(err)
  }
})

// ─── SSE stream: per-conversation ring buffer + replay ────────────────────
// Machinery lives in ../sse-channels.ts (shared with session streams). The
// conversation channel resets its replay window on 'message-start' (a new
// turn); seq stays monotonic across turns.

function emitSse(conversationId: string, event: string, data: unknown): void {
  emitChannelSse(conversationId, event, data, { reset: event === 'message-start' })
  // Primary box only, and only while a CLOUD-RELAYED turn is armed on this
  // conversation (one Map lookup otherwise): mirror the frame down the bridge
  // so the phone attached to the replica sees the same live stream a phone
  // attached here does. See routes/chat-turn-relay.ts.
  mirrorRelayedChatFrame(conversationId, event, data)
}

/** Close all live SSE connections (server shutdown / tests). */
export function closeApiV1Streams(): void {
  closeAllSseChannels()
}

// GET /api/v1/conversations/:id/stream?agentId=
apiV1Router.get('/conversations/:id/stream', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = requestAgentId(req)
    if (!agentId || !(await consoleAgentExists(agentId))) {
      sendError(res, 404, 'not_found', `Agent not found: ${req.query.agentId}`)
      return
    }
    const conversationId = paramStr(req.params.id)
    if (!(await conversationExists(agentId, conversationId))) {
      sendError(res, 404, 'not_found', `Conversation not found: ${conversationId}`)
      return
    }
    attachSse(conversationId, req, res)
  } catch (err) {
    next(err)
  }
})

// ─── POST message → agent turn (shared queue with WS chat) ────────────────

/** REST-initiated turns currently running or queued, keyed by conversation. */
const activeTurns = new Map<string, string>()

// ── Image attachments (additive) ──
// Frozen-contract note: `images` is optional. Absent → identical to today.
// Mirrors the WS chat pipeline (chat.ts): candidate entries are filtered here
// (allowed type + string data, capped at 5) exactly like processAndSaveImages
// filters, so we can decide "empty text is OK because an image is present"
// before doing the disk I/O. processAndSaveImages does the same filtering
// again + compression when it actually saves.

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGES_PER_MESSAGE = 5

/** Extract the valid image payloads from a request body (silently drops junk). */
function extractValidImages(raw: unknown): ImagePayload[] {
  if (!Array.isArray(raw)) return []
  return (raw as Array<{ data?: unknown; mediaType?: unknown }>)
    .filter((img) =>
      typeof img?.data === 'string'
      && img.data.length > 0
      && typeof img.mediaType === 'string'
      && ALLOWED_IMAGE_TYPES.has(img.mediaType),
    )
    .slice(0, MAX_IMAGES_PER_MESSAGE)
    .map((img) => ({ data: img.data as string, mediaType: img.mediaType as string }))
}

/**
 * Replace base64 image blocks in a user message with lightweight path-based
 * blocks for persistence. Mirror of the private helper in chat.ts (that file
 * is off-limits to this change) — only the first user message carries images.
 */
function replaceImagesWithPaths(
  msgs: MessageParam[],
  savedImages: Array<{ filePath: string; filename: string; mediaType: string }>,
): MessageParam[] {
  if (savedImages.length === 0) return msgs
  return msgs.map((msg) => {
    const { role, content } = msg as { role: string; content: unknown }
    if (role !== 'user' || !Array.isArray(content)) return msg
    if (!(content as Array<{ type: string }>).some((b) => b.type === 'image')) return msg
    let imageIdx = 0
    const newContent = (content as Array<Record<string, unknown>>).map((block) => {
      if (block.type === 'image' && imageIdx < savedImages.length) {
        const saved = savedImages[imageIdx++]
        return { type: 'image', path: saved.filePath, media_type: saved.mediaType }
      }
      return block
    })
    return { role, content: newContent } as unknown as MessageParam
  })
}

apiV1Router.post('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = requestAgentId(req)
    if (!agentId || !(await consoleAgentExists(agentId))) {
      sendError(res, 404, 'not_found', `Agent not found: ${req.body?.agentId}`)
      return
    }
    const conversationId = paramStr(req.params.id)
    if (!(await conversationExists(agentId, conversationId))) {
      sendError(res, 404, 'not_found', `Conversation not found: ${conversationId}`)
      return
    }
    // Additive: `images` allows an otherwise-empty text turn. Old clients that
    // send no images keep the exact 400-on-empty-text behavior.
    const images = extractValidImages(req.body?.images)
    const rawText = req.body?.text
    const text = typeof rawText === 'string' ? rawText : ''
    if (text.trim().length === 0 && images.length === 0) {
      sendError(res, 400, 'bad_request', 'text (non-empty string) is required')
      return
    }
    if (activeTurns.has(conversationId)) {
      sendError(res, 409, 'turn_active', 'A turn is already active on this conversation')
      return
    }

    // Save + compress images OUTSIDE the queue (disk I/O) — same as chat.ts, so
    // the per-agent queue isn't held during uploads.
    let savedImages: Array<{ filePath: string; filename: string; mediaType: string }> = []
    let imageContentBlocks: unknown[] | null = null
    if (images.length > 0) {
      const processed = await processAndSaveImages(images)
      if (processed) {
        savedImages = processed.savedImages
        imageContentBlocks = processed.imageContentBlocks
      }
    }

    const turnId = crypto.randomUUID()
    activeTurns.set(conversationId, turnId)
    log.web.info('api-v1 message accepted', { conversationId, turnId, agentId, messageLength: text.length, imageCount: savedImages.length })

    // Additive SSE event: if another turn currently holds the agent queue
    // (possibly a long one on a DIFFERENT conversation), this turn will wait.
    // Without a signal the client sees dead air between 202 and message-start
    // and reads it as a freeze. `queued` is fired only when a wait is certain.
    const qs = getQueueStatus(agentId)
    if (qs.active > 0 || qs.queued > 0) {
      emitSse(conversationId, 'queued', { turnId, position: qs.queued + 1 })
    }

    // Fire the turn through the SAME per-agent queue the WS chat uses — one
    // serialization path. The 202 returns immediately; progress streams on SSE.
    // On a CLOUD REPLICA the turn is relayed to the primary first, so the
    // phone gets the Mac's configured engine (claude-code) rather than this
    // box's in-process fallback loop — see routes/chat-turn-relay.ts.
    void runApiV1TurnRouted(agentId, conversationId, text, turnId, { savedImages, imageContentBlocks })
      .catch((err) => {
        log.web.error('api-v1 turn failed', {
          conversationId, turnId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        if (activeTurns.get(conversationId) === turnId) activeTurns.delete(conversationId)
      })

    res.status(202).json({ turnId })
  } catch (err) {
    next(err)
  }
})

/**
 * Engine router for one accepted REST turn.
 *
 * On the PRIMARY this is just runApiV1Turn. On a CLOUD REPLICA it first tries to
 * hand the turn to the primary, because the replica cannot run the lane engine
 * at all (no session runner, no `claude` CLI) and would otherwise answer with a
 * different engine than the same question gets when the phone talks to the Mac
 * directly.
 *
 * Two deliberate exclusions from the relay, both falling back to the local loop:
 *
 *  - IMAGE turns. The saved files live on THIS box's disk, so their paths mean
 *    nothing on the primary, and shipping base64 through a 45s control RPC is
 *    exactly the oversized-frame failure mode that kills every in-flight request
 *    on the shared bridge socket. Cloud image attachments already have their own
 *    host-side lane for SESSION sends (`image.save`); wiring that into chat is a
 *    separate change.
 *  - Anything the relay reports `unavailable` for (bridge down, primary's server
 *    down, old primary, relay error). The user gets a real answer from the local
 *    loop instead of an error, with the terminal frame marked
 *    `engine:'walnut-agent-fallback'` so the degradation is observable.
 *
 * `turn_active` is NOT a fallback case: the primary already has a turn on this
 * conversation, and running a second one here would produce two answers and two
 * history writers. It is reported to the client as an SSE error.
 */
async function runApiV1TurnRouted(
  agentId: string,
  conversationId: string,
  text: string,
  turnId: string,
  imageData?: {
    savedImages: Array<{ filePath: string; filename: string; mediaType: string }>
    imageContentBlocks: unknown[] | null
  },
): Promise<void> {
  const hasImages = (imageData?.savedImages.length ?? 0) > 0
  if (!CLOUD_MODE || hasImages) {
    await runApiV1Turn(agentId, conversationId, text, turnId, imageData)
    return
  }

  const outcome = await relayChatTurnToPrimary(agentId, conversationId, text, turnId)

  if (outcome.kind === 'accepted') {
    // The primary owns this turn end to end: it runs the engine, persists the
    // user message AND the answer, and streams every frame back down the bridge
    // (handleBridgeChatTurnFrame fans them out on this conversation's channel).
    // This box persists NOTHING — two writers would double every message once
    // git-sync converged. Awaiting `settled` keeps the POST handler's 409 guard
    // held for the turn's real duration, exactly as the local path does.
    await outcome.settled
    return
  }

  if (outcome.kind === 'turn_active') {
    log.web.warn('api-v1 turn rejected — the primary already has a turn on this conversation', {
      conversationId, turnId, agentId,
    })
    emitSse(conversationId, 'error', { message: outcome.message })
    return
  }

  log.web.warn('api-v1 turn falling back to this replica\'s in-process loop', {
    conversationId, turnId, agentId, reason: outcome.reason,
  })
  await runApiV1Turn(agentId, conversationId, text, turnId, imageData, { engine: FALLBACK_ENGINE_LABEL })
}

/**
 * Entry point for a chat turn RELAYED here from a cloud replica (the primary
 * side of routes/chat-turn-relay.ts). Deliberately the ordinary turn path: this
 * box resolves its own `agent.provider`, owns persistence, and owns the SSE
 * contract, so there is no second turn implementation to keep in sync.
 */
export async function runRelayedApiV1Turn(
  agentId: string,
  conversationId: string,
  text: string,
  turnId: string,
): Promise<void> {
  await runApiV1Turn(agentId, conversationId, text, turnId)
}

/**
 * Persist + publish a failed turn: the disk entry, the SSE `error` the mobile
 * client unlocks its composer on, and the two WS broadcasts the web console
 * needs (live error card + agent:error). One helper so the in-process catch and
 * the lane branch below cannot drift into two different failure shapes.
 */
async function persistAndEmitTurnError(
  agentId: string,
  conversationId: string,
  errMsg: string,
  /** Additive engine marker for the terminal frame (see runApiV1Turn). */
  engineMark: Record<string, string> = {},
): Promise<void> {
  await chatHistory.addAIMessages(
    [{ role: 'assistant', content: [{ type: 'text', text: `[Error: ${errMsg}]` }] }] as MessageParam[],
    { source: 'agent-error', agentId, conversationId },
  ).catch(() => { /* best-effort */ })
  emitSse(conversationId, 'error', { message: errMsg, ...engineMark })
  // Mirror the WS path: push the error entry live, not disk-only (see chat.ts).
  broadcastEvent(EventNames.CHAT_HISTORY_UPDATED, {
    entry: {
      role: 'assistant',
      content: `[Error: ${errMsg}]`,
      source: 'agent-error',
      notification: true,
      timestamp: new Date().toISOString(),
    },
    agentId,
    conversationId,
  })
  broadcastEvent(EventNames.AGENT_ERROR, { error: errMsg, agentId, conversationId })
}

/**
 * Run one REST turn on the conversation's Personal AI lane
 * (`config.agent.provider === 'claude-code'`) and keep the frozen SSE contract.
 *
 * Why this exists at all, when chat.ts's lane branch is fire-and-forget: the web
 * client subscribes to the LANE SESSION's own stream, so the RPC there can return
 * the moment the message is delivered. The mobile client has exactly one channel —
 * this conversation's SSE — and unlocks its composer on `message-end`. So a lane
 * turn fired from mobile has to be AWAITED and translated back onto that channel:
 *
 *   - `session:text-delta` for the lane session → SSE `text-delta` (the same shape
 *     the in-process path emits). This is what feeds the client's inactivity
 *     watchdog and paints the live bubble during a multi-minute turn; the SSE
 *     channel's own 25s comment ping is transport-level only and carries no event.
 *   - turn answer → SSE `message-end` + a normal assistant entry on disk.
 *   - timeout / `session:error` → SSE `error` + the same failure the in-process
 *     catch persists.
 */
async function runApiV1LaneTurn(
  agentId: string,
  conversationId: string,
  message: string,
  turnId: string,
): Promise<void> {
  const { runLaneTurn } = await import('../../core/sessions/lane-turn.js')

  // Live relay. Interest-scoped global subscription (the pattern every session-event
  // consumer uses): session events are addressed to 'main-ai'/'session-runner', and
  // without `interest` this handler would wake on every event in the process.
  // The lane id is only known once the lane resolves, hence the onSessionId hook —
  // subscribing FIRST means no delta of this turn can slip through the gap.
  const subName = `api-v1-lane-relay-${turnId}`
  let laneSessionId: string | null = null
  bus.subscribe(subName, (event) => {
    if (event.name !== EventNames.SESSION_TEXT_DELTA) return
    const d = event.data as {
      sessionId?: string; delta?: string; parentToolUseId?: string; replayed?: boolean
    }
    if (laneSessionId === null || d.sessionId !== laneSessionId || !d.delta) return
    // Subagent text never reaches the turn's result text (claude-code-session.ts
    // keeps it out of fullText), and a `replayed` delta is JSONL history being
    // re-read — neither belongs in the phone's live bubble for THIS turn.
    if (d.parentToolUseId || d.replayed) return
    emitSse(conversationId, 'text-delta', { delta: d.delta })
  }, { global: true, interest: [EventNames.SESSION_TEXT_DELTA] })

  try {
    const { sessionId, resultText } = await runLaneTurn(agentId, conversationId, message, {
      source: 'api-v1',
      onSessionId: (sid) => { laneSessionId = sid },
    })

    if (resultText === null) {
      // runLaneTurn degrades instead of rejecting: null is a timeout, a
      // session:error, or a failed send. All three are "this turn has no answer",
      // which the client must be told about or its composer stays locked.
      const errMsg = 'The main AI did not answer this turn (timed out or errored).'
      log.web.error('api-v1 lane turn failed', { conversationId, turnId, agentId, sessionId })
      await persistAndEmitTurnError(agentId, conversationId, errMsg)
      return
    }

    // Persist the answer as an ORDINARY assistant message — the same call the
    // in-process path makes. Deliberate duplication with the lane session's own
    // transcript: mobile has no session-stream surface, so GET /messages is the
    // only place the phone can read the answer back after a reload.
    await chatHistory.addAIMessages(
      [{ role: 'assistant', content: [{ type: 'text', text: resultText }] }] as MessageParam[],
      { agentId, conversationId },
    )

    emitSse(conversationId, 'message-end', { turnId, fullText: resultText })
    // source:'session' marks a lane turn, exactly as chat.ts's branch does: the
    // context inspector must not refetch in-process stats the lane never fed.
    broadcastEvent(EventNames.AGENT_RESPONSE, { text: resultText, agentId, conversationId, source: 'session' })
    log.web.info('api-v1 lane turn completed', {
      conversationId, turnId, agentId, sessionId, resultLength: resultText.length,
    })
  } catch (err) {
    // getOrCreateLaneSession can still throw (no config, record write failure) —
    // without this the client would only learn of it from its own watchdog.
    const errMsg = err instanceof Error ? err.message : String(err)
    log.web.error('api-v1 lane turn error', { conversationId, turnId, agentId, error: errMsg })
    await persistAndEmitTurnError(agentId, conversationId, errMsg)
  } finally {
    bus.unsubscribe(subName)
  }
}

/**
 * Run one REST-initiated turn. Mirrors the canonical WS chat flow
 * (src/web/routes/chat.ts) minus web-only extras: enqueue → load history →
 * eager-persist user msg → runAgentLoop → persist AI messages → compaction.
 * Emits SSE events AND the same WS broadcast events, so the web UI mirrors
 * turns fired from mobile.
 */
async function runApiV1Turn(
  agentId: string,
  conversationId: string,
  text: string,
  turnId: string,
  imageData?: {
    savedImages: Array<{ filePath: string; filename: string; mediaType: string }>
    imageContentBlocks: unknown[] | null
  },
  /** Additive marker stamped on the terminal SSE frame. Set only on a cloud
   *  replica's fallback turn, so a degraded answer is observable without any
   *  client change (unknown fields are ignored by the frozen v1 contract). */
  opts?: { engine?: string },
): Promise<void> {
  const engineMark: Record<string, string> = opts?.engine ? { engine: opts.engine } : {}
  await enqueueAgentTurn(agentId, 'api-v1', async () => {
    // ── Engine selection (config.agent.provider) ──
    // 'claude-code' delivers the turn into the conversation's lane session instead
    // of running the in-process loop. EVERY console agent rides the lane engine
    // (per-agent persona via consoleAgentProfile — see personal-ai-lane.resolveLane),
    // mirroring chat.ts. A failure to read config degrades to the in-process
    // loop — never "no engine".
    let useLaneEngine = false
    try {
      const { getConfig, resolveAgentEngineProvider } = await import('../../core/config-manager.js')
      useLaneEngine = resolveAgentEngineProvider(await getConfig()) === 'claude-code'
    } catch (err) {
      log.web.warn('api-v1 engine resolution failed; using the in-process loop', {
        conversationId, turnId, agentId, error: err instanceof Error ? err.message : String(err),
      })
    }

    // Agent-level abort registration so POST /v1/conversations/:id/stop can
    // cancel this turn (REST clients have no per-socket AbortController).
    const { registerAgentTurnAbort } = await import('../../core/agent-abort-registry.js')
    const abortController = new AbortController()
    const unregisterAbort = registerAgentTurnAbort(agentId, abortController)

    // Non-General console agents get their own system prompt + filtered tool
    // set — the same construction the WS chat performs (chat.ts).
    let agentSystem: string | undefined
    let agentTools: import('../../agent/tools.js').ToolDefinition[] | undefined
    if (agentId !== DEFAULT_AGENT_ID) {
      const { getConsoleAgent } = await import('../../core/agent-registry.js')
      const { buildSubagentToolSet } = await import('../../agent/subagent-context.js')
      const { loadContextSources } = await import('../../agent/context-sources.js')
      const agentDef = await getConsoleAgent(agentId)
      if (!agentDef) throw new Error(`Console agent '${agentId}' not found`)
      const now = new Date()
      const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      const contextXml = await loadContextSources(agentDef, {})
      const sections = [
        agentDef.system_prompt ?? `You are ${agentDef.name}.`,
        `\nCurrent date/time: ${dateStr}, ${timeStr}`,
      ]
      if (contextXml) sections.push('\n' + contextXml)
      agentSystem = sections.join('\n')
      agentTools = await buildSubagentToolSet(agentDef)
    }

    const history = await chatHistory.getApiMessages(agentId, conversationId)

    // Build the user content: images (if any) become base64 content blocks
    // followed by a text block prefixed with the <attached-images> annotation
    // — same shape chat.ts feeds runAgentLoop. Persist the path-based form so
    // chat-history.json stays small (base64 → { type:'image', path } refs).
    const savedImages = imageData?.savedImages ?? []
    const imageContentBlocks = imageData?.imageContentBlocks ?? null
    let userContent: string | unknown[] = text
    if (imageContentBlocks) {
      const blocks = [...imageContentBlocks]
      blocks.push({ type: 'text', text: buildImageAnnotation(savedImages) + text })
      userContent = blocks
    }

    // Eager persist: the user message survives crashes mid-turn.
    const userContentForPersist: string | unknown[] = savedImages.length > 0 && Array.isArray(userContent)
      ? (replaceImagesWithPaths(
          [{ role: 'user', content: userContent } as MessageParam],
          savedImages,
        )[0] as { content: unknown[] }).content
      : userContent
    await chatHistory.addUserMessage(userContentForPersist, {
      displayText: text,
      turnId,
      agentId,
      conversationId,
    })

    emitSse(conversationId, 'message-start', { turnId })

    // ── Engine branch: Personal AI lane (config.agent.provider='claude-code') ──
    // Everything above ran for BOTH engines (engine resolution, history load, image
    // save, eager user-message persist, message-start) — only the engine differs.
    // The POST handler's `activeTurns` entry is released in its `.finally()`, i.e.
    // when the promise this callback belongs to settles: awaiting the lane turn here
    // means the 409 guard covers the lane turn for its whole duration, same as the
    // in-process path, with no second bookkeeping path to keep in sync.
    if (useLaneEngine) {
      // The lane's CLI process is not this controller's to cancel (stopping a lane
      // turn is a session-level interrupt), so drop the registration rather than
      // leave a no-op abort target that would make /stop report a false success.
      unregisterAbort()
      // The CLI takes plain text on stdin, not content blocks — images ride as
      // readable file paths (the shape session chat uses), never base64.
      const sessionMessage = savedImages.length > 0
        ? buildSessionImageContext(savedImages) + text
        : text
      await runApiV1LaneTurn(agentId, conversationId, sessionMessage, turnId)
      return
    }

    // Lazy import to avoid loading the agent at server startup (same as chat.ts);
    // skipped entirely on the lane path above, which never runs the in-process loop.
    const { runAgentLoop } = await import('../../agent/loop.js')

    try {
      const result = await runAgentLoop(userContent, history, {
        onTextDelta: (delta) => {
          emitSse(conversationId, 'text-delta', { delta })
          broadcastEvent(EventNames.AGENT_TEXT_DELTA, { delta, agentId, conversationId })
        },
        onThinking: (thinkingText) => {
          emitSse(conversationId, 'thinking', {})
          broadcastEvent(EventNames.AGENT_THINKING, { text: thinkingText, agentId, conversationId })
        },
        onToolCall: (toolName, input, toolUseId) => {
          const detail = toolDetail(toolName, input as Record<string, unknown> | undefined)
          emitSse(conversationId, 'tool', { name: toolName, ...(detail ? { detail } : {}) })
          broadcastEvent(EventNames.AGENT_TOOL_CALL, { toolName, input, toolUseId, agentId, conversationId })
        },
        onUsage: (usage) => {
          bus.emit('agent:usage', { usage }, ['web-ui'], { source: 'agent' })
          try {
            usageTracker.record({
              source: 'agent',
              model: usage.model ?? 'unknown',
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
              agentId,
            })
          } catch { /* non-critical */ }
          // Feed the compaction/triage token-truth gate (see token-truth.ts).
          try {
            recordLastTurnTokens(conversationId, (usage.input_tokens ?? 0)
              + (usage.cache_read_input_tokens ?? 0)
              + (usage.cache_creation_input_tokens ?? 0))
          } catch { /* non-critical */ }
        },
      }, {
        signal: abortController.signal,
        source: agentId === DEFAULT_AGENT_ID ? 'api-v1' : `api-v1:${agentId}`,
        agentId,
        conversationId,
        ...(agentSystem && { system: agentSystem }),
        ...(agentTools && { tools: agentTools }),
      })

      // newMessages = [userPrompt, ...ai]; the user prompt is already persisted.
      const allNew = result.newMessages as MessageParam[]
      const afterUser = allNew.length > 0 && (allNew[0] as { role: string }).role === 'user'
        ? allNew.slice(1)
        : allNew
      if (afterUser.length > 0) {
        await chatHistory.addAIMessages(afterUser, { agentId, conversationId })
      }

      emitSse(conversationId, 'message-end', { turnId, fullText: result.response, ...engineMark })
      broadcastEvent(EventNames.AGENT_RESPONSE, { text: result.response, agentId, conversationId })
      log.web.info('api-v1 turn completed', { conversationId, turnId, agentId })

      // Same post-turn hygiene as WS chat — fire-and-forget.
      triggerBackgroundCompaction('api-v1', { agentId, conversationId })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.web.error('api-v1 turn error', { conversationId, turnId, agentId, error: errMsg })
      await persistAndEmitTurnError(agentId, conversationId, errMsg, engineMark)
    } finally {
      unregisterAbort()
    }
  })
}

// ─── Tasks ─────────────────────────────────────────────────────────────────

// Real ISO-8601 only: YYYY-MM-DD or a full datetime. Bare Date.parse is
// too lax — it accepts junk like '12345' (parsed as a year) AND silently
// rolls calendar-invalid dates over ('2030-02-30' → Mar 2). Regex gates
// the shape; the round-trip check catches rollover: parse the date part
// as UTC and require the re-serialized day to match. Shared by POST /tasks
// and PATCH /tasks/:id.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/
function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s) || Number.isNaN(Date.parse(s))) return false
  // Round-trip the DATE PART in UTC (a date-only string parses as UTC
  // midnight; for datetimes the calendar day must survive re-serialization
  // of its own date component regardless of the time/offset suffix).
  const datePart = s.slice(0, 10)
  return new Date(`${datePart}T00:00:00Z`).toISOString().slice(0, 10) === datePart
}

// GET /api/v1/tasks — slim task list for mobile.
// Primary box: exports a fresh projection from SQLite and serves that.
// Cloud box: builds the same shape from the replica's OWN task store (which
// the projection import seeds and every replica-local write updates), so a
// phone edit is visible on the very next list fetch — serving only the pushed
// projection file made every write appear to REVERT until the outbox→primary→
// projection round trip landed (minutes; unbounded with the Mac asleep). The
// pushed projection still rides along as a bootstrap/coverage overlay: rows
// the local store doesn't know yet (first 5s after boot, import races) are
// appended, minus anything with a queued local delete.
apiV1Router.get('/tasks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { readTaskProjection, exportTaskProjection, buildTaskProjection } = await import('../../core/task-projection.js')
    let projection = null
    if (!CLOUD_MODE) {
      // Live box — refresh the projection inline (cheap: one SELECT + write).
      await exportTaskProjection().catch(() => { /* serve last good file below */ })
      projection = await readTaskProjection()
    } else {
      const [local, synced] = await Promise.all([
        buildTaskProjection().catch(() => null),
        readTaskProjection(),
      ])
      if (local && local.tasks.length > 0) {
        const seen = new Set(local.tasks.map((t) => t.id))
        let extras = (synced?.tasks ?? []).filter((t) => !seen.has(t.id))
        if (extras.length > 0) {
          // Rows only the synced projection has: keep them UNLESS this replica
          // deleted them (tombstone, or a still-queued delete op after a
          // restart wiped the in-memory tombstones) — the projection-lag echo
          // must never resurrect a phone-side delete in the response.
          const tq = await import('../../core/task-queue.js')
          const queuedDeletes = new Set(
            (await tq.listQueuedOps()).filter((o) => o.type === 'delete').map((o) => (o as { id: string }).id),
          )
          extras = extras.filter((t) => !tq.hasDeleteTombstone(t.id) && !queuedDeletes.has(t.id))
        }
        // syncedAt keeps its provenance meaning (when the MAC's data last
        // arrived) — the locally-built envelope's exportedAt is "now" and
        // would hide real staleness while the Mac is asleep.
        projection = {
          ...local,
          ...(synced?.exportedAt ? { exportedAt: synced.exportedAt } : {}),
          tasks: [...local.tasks, ...extras],
        }
      } else {
        // Empty/unavailable local store (fresh boot, pre-seed) — the pushed
        // projection is the only truth we have.
        projection = synced ?? local
      }
    }
    if (!projection) {
      sendError(res, 503, 'unavailable', 'Task projection not synced yet')
      return
    }
    let tasks = projection.tasks
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    if (status) tasks = tasks.filter((t) => t.status === status)
    // Additive filters (Wave 1): project ('' = Inbox, case-insensitive like the
    // registry), tag (exact), q (substring on title, case-insensitive).
    if (typeof req.query.project === 'string') {
      const p = req.query.project.toLowerCase()
      tasks = tasks.filter((t) => (t.project ?? '').toLowerCase() === p)
    }
    if (typeof req.query.tag === 'string' && req.query.tag) {
      const tag = req.query.tag
      tasks = tasks.filter((t) => Array.isArray(t.tags) && t.tags.includes(tag))
    }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const q = req.query.q.trim().toLowerCase()
      tasks = tasks.filter((t) => t.title.toLowerCase().includes(q))
    }
    // The projection is project-only (v2): `project` is the single grouping
    // field, with NO `category` alias. The iOS app — v1's only consumer —
    // decodes `project` and ships in the same release as this projection.
    res.json({ tasks, syncedAt: projection.exportedAt })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks — quick task creation from mobile (additive).
// Same creation path as the web quick-add (addTask in task-manager): project
// defaults to config default / Inbox, a missing project registry row is
// auto-created, source resolution is identical. Answers 201 with the created
// task in the slim ProjectedTask shape GET /tasks serves.
//
// Works on BOTH boxes. A REPLICA has a real local task store (the projection
// import seeds it — task-outbox.ts importProjectionOnCloud), and the
// TASK_CREATED emit below is what the cloud outbox subscriber (server.ts)
// listens for to dispatch the op to the primary (bridge RPC, offline queue
// fallback — core/task-queue.ts). GET /api/v1/tasks on a replica serves the
// LOCAL store (projection as overlay), so the new task is visible on the
// very next list read — no round-trip wait.
apiV1Router.post('/tasks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, project, priority, due_date: dueDate, description } = (req.body ?? {}) as {
      title?: unknown
      project?: unknown
      priority?: unknown
      due_date?: unknown
      description?: unknown
    }
    if (typeof title !== 'string' || !title.trim()) {
      sendError(res, 400, 'bad_request', 'title must be a non-empty string')
      return
    }
    if (title.length > 500) {
      sendError(res, 400, 'bad_request', 'title too long (max 500 chars)')
      return
    }
    if (project !== undefined && typeof project !== 'string') {
      sendError(res, 400, 'bad_request', 'project must be a string')
      return
    }
    if (priority !== undefined
        && !(typeof priority === 'string' && (VALID_PRIORITIES as readonly string[]).includes(priority))) {
      sendError(res, 400, 'bad_request', `priority must be one of: ${VALID_PRIORITIES.join(', ')}`)
      return
    }
    if (dueDate !== undefined && !(typeof dueDate === 'string' && isValidIsoDate(dueDate))) {
      sendError(res, 400, 'bad_request', 'due_date must be an ISO-8601 date string (YYYY-MM-DD or full datetime)')
      return
    }
    if (description !== undefined && typeof description !== 'string') {
      sendError(res, 400, 'bad_request', 'description must be a string')
      return
    }

    const { addTask, ProjectSourceConflictError } = await import('../../core/task-manager.js')
    const { projectTask } = await import('../../core/task-projection.js')
    try {
      // asyncPush like the web create path: the client renders the task
      // immediately, so don't block the response on an external sync push.
      const { task } = await addTask({
        title: title.trim(),
        ...(project !== undefined ? { project } : {}),
        ...(priority !== undefined ? { priority: priority as TaskPriority } : {}),
        ...(dueDate !== undefined ? { due_date: dueDate } : {}),
        ...(description !== undefined ? { description } : {}),
        asyncPush: true,
      })
      log.web.info('task created via api-v1', { taskId: task.id, project: task.project })
      bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui', 'main-agent'], { source: 'api-v1' })
      // Project-only projection, same as GET /tasks (see the note there).
      res.status(201).json({ task: projectTask(task) })
    } catch (err) {
      if (err instanceof ProjectSourceConflictError) {
        sendError(res, 409, 'conflict', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/tasks/:id — update task fields from mobile (additive).
// Allowed fields: { status?, priority?, due_date?, start_date?, project?, title?,
// description?, tags?, unread? }.
// Same core path as the web PATCH (updateTask with source 'api' + asyncPush) so
// hooks/emits/terminal-phase-guard semantics are identical — updateTask emits
// TASK_UPDATED internally, which on a REPLICA also feeds the task outbox (the
// op file rides git-sync back to the primary; see task-outbox.ts). Answers 200
// with the slim ProjectedTask shape GET /tasks serves.
//
// Works on BOTH boxes: a REPLICA has a real local task store (projection
// import seeds it — NEVER 503 here), and the response is the locally-updated
// row served optimistically while the outbox round-trips.
const V1_TASK_STATUSES = new Set(['todo', 'in_progress', 'done'])

apiV1Router.patch('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    // PATCH /v1/tasks/reorder lives in task-v1.ts (mounted after this router);
    // without this forward the :id param would swallow it as a task id. Task
    // ids are hex-ish and can never be the literal word "reorder".
    if (id === 'reorder') { next(); return }
    const { status, phase, priority, due_date: dueDate, start_date: startDate, project, title, description, tags,
      unread } = (req.body ?? {}) as {
      status?: unknown
      phase?: unknown
      priority?: unknown
      due_date?: unknown
      start_date?: unknown
      project?: unknown
      title?: unknown
      description?: unknown
      tags?: unknown
      unread?: unknown
    }

    if (status !== undefined && !(typeof status === 'string' && V1_TASK_STATUSES.has(status))) {
      sendError(res, 400, 'bad_request', 'status must be one of: todo, in_progress, done')
      return
    }
    if (phase !== undefined && !(typeof phase === 'string' && VALID_PHASES.has(phase) && phase !== 'COMPLETE')) {
      sendError(res, 400, 'bad_request', 'phase must be a non-COMPLETE task phase')
      return
    }
    if (status !== undefined && phase !== undefined) {
      sendError(res, 400, 'bad_request', 'provide status or phase, not both')
      return
    }
    if (priority !== undefined
        && !(typeof priority === 'string' && (VALID_PRIORITIES as readonly string[]).includes(priority))) {
      sendError(res, 400, 'bad_request', `priority must be one of: ${VALID_PRIORITIES.join(', ')}`)
      return
    }
    // '' = explicit clear (same as the web PATCH — updateTask normalizes '' to undefined).
    if (dueDate !== undefined && !(typeof dueDate === 'string' && (dueDate === '' || isValidIsoDate(dueDate)))) {
      sendError(res, 400, 'bad_request', 'due_date must be an ISO-8601 date string (YYYY-MM-DD or full datetime) or "" to clear')
      return
    }
    if (project !== undefined && typeof project !== 'string') {
      sendError(res, 400, 'bad_request', 'project must be a string ("" = Inbox)')
      return
    }
    if (title !== undefined && !(typeof title === 'string' && title.trim())) {
      sendError(res, 400, 'bad_request', 'title must be a non-empty string')
      return
    }
    if (typeof title === 'string' && title.length > 500) {
      sendError(res, 400, 'bad_request', 'title too long (max 500 chars)')
      return
    }
    if (description !== undefined && typeof description !== 'string') {
      sendError(res, 400, 'bad_request', 'description must be a string')
      return
    }
    // Additive (Wave 1): start_date (same clear-with-'' semantics as due_date)
    // and tags (full replace — mirrors updateTask's set_tags).
    if (startDate !== undefined && !(typeof startDate === 'string' && (startDate === '' || isValidIsoDate(startDate)))) {
      sendError(res, 400, 'bad_request', 'start_date must be an ISO-8601 date string (YYYY-MM-DD or full datetime) or "" to clear')
      return
    }
    if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === 'string'))) {
      sendError(res, 400, 'bad_request', 'tags must be an array of strings')
      return
    }
    // Read marker: the phone marks a task read after showing its output.
    if (unread !== undefined && typeof unread !== 'boolean') {
      sendError(res, 400, 'bad_request', 'unread must be a boolean')
      return
    }
    if (status === undefined && phase === undefined && priority === undefined && dueDate === undefined
        && startDate === undefined && project === undefined && title === undefined
        && description === undefined && tags === undefined && unread === undefined) {
      sendError(res, 400, 'bad_request', 'at least one updatable field is required (status/phase/priority/due_date/start_date/project/title/description/tags/unread)')
      return
    }

    const tm = await import('../../core/task-manager.js')
    const { projectTask } = await import('../../core/task-projection.js')
    const opCaller = req.get('X-Walnut-Op-Caller')
    const updateSource = opCaller === 'agent' || opCaller === 'gateway' ? 'agent' : 'api'
    try {
      let updated
      const patch = {
        ...(status !== undefined ? { status: status as import('../../core/types.js').TaskStatus } : {}),
        ...(phase !== undefined ? { phase: phase as TaskPhase } : {}),
        ...(priority !== undefined ? { priority: priority as TaskPriority } : {}),
        ...(dueDate !== undefined ? { due_date: dueDate as string } : {}),
        ...(startDate !== undefined ? { start_date: startDate as string } : {}),
        ...(project !== undefined ? { project: project as string } : {}),
        ...(title !== undefined ? { title: (title as string).trim() } : {}),
        ...(tags !== undefined ? { set_tags: tags as string[] } : {}),
        ...(unread !== undefined ? { unread: unread as boolean } : {}),
      }
      // description FIRST (not atomic with the main patch — two separate
      // writes). Ordering rationale: updateDescription resolves the same task
      // id and runs plugin content validation, so its likeliest failures
      // (not found / validation) reject BEFORE the main patch touches
      // anything — the error response then truthfully means "nothing was
      // applied", instead of a 500 that silently half-applied the patch.
      if (description !== undefined) {
        // description is not an UpdateTaskInput field — it has its own setter
        // (plugin content validation + push + TASK_UPDATED emit).
        const result = await tm.updateDescription(id, description as string)
        updated = result.task
      }
      if (Object.keys(patch).length > 0) {
        const result = await tm.updateTask(id, patch, { source: updateSource, extraTargets: ['main-agent'], asyncPush: true })
        updated = result.task
      }
      if (!updated) {
        // Unreachable given the "at least one field" validation above, but
        // never let a non-null assertion turn a logic slip into a crash.
        sendError(res, 500, 'internal', 'update produced no task row')
        return
      }
      log.web.info('task updated via api-v1', { taskId: updated.id, fields: Object.keys(req.body ?? {}) })
      res.json({ task: projectTask(updated) })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/No task found matching/i.test(msg)) {
        sendError(res, 404, 'not_found', `Task not found: ${id}`)
        return
      }
      if (/Ambiguous ID prefix/i.test(msg)) {
        sendError(res, 400, 'bad_request', msg)
        return
      }
      if (err instanceof tm.ProjectSourceConflictError || err instanceof tm.ActiveChildrenError) {
        sendError(res, 409, 'conflict', msg)
        return
      }
      if (err instanceof tm.InvalidProjectNameError) {
        sendError(res, 400, 'bad_request', msg)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/sessions — slim session list for mobile (read-only, additive).
// Same projection pattern as /tasks: primary refreshes inline, cloud serves
// the git-synced sessions/projection.json. Opening/steering a session from
// the companion is Phase 2 (reverse-WS bridge to the primary).
apiV1Router.get('/sessions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { readSessionProjection, exportSessionProjection } = await import('../../core/session-projection.js')
    if (!CLOUD_MODE) {
      await exportSessionProjection().catch(() => { /* serve last good file below */ })
    }
    const projection = await readSessionProjection()
    if (!projection) {
      sendError(res, 503, 'unavailable', 'Session projection not synced yet')
      return
    }
    let sessions = projection.sessions
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    if (status) sessions = sessions.filter((s) => s.process_status === status)
    res.json({ sessions, syncedAt: projection.exportedAt })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/sessions/:id/transcript?fresh=1 — the "open session" payload: a
// slim transcript tail. Default: the sweep-exported file (synced to the cloud
// companion). `fresh=1` (additive) makes the PRIMARY box read the session's
// history right now — this powers the mobile live session view, which polls
// with fresh=1 while open; sweeps alone are 60s-throttled. Cloud boxes have no
// disk/SSH access to sessions and always serve the synced file.
apiV1Router.get('/sessions/:id/transcript', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { readSessionTranscript, exportSessionTranscripts, buildSessionTranscript } = await import('../../core/session-projection.js')
    const sessionId = paramStr(req.params.id)
    const wantFresh = req.query.fresh === '1'
    // Same safe-id alphabet readSessionTranscript enforces (ids land in filenames).
    const safeId = /^[A-Za-z0-9_-]+$/.test(sessionId)
    // Just-created session (record seeded, CLI not spawned yet — no pid, no
    // outputFile): there is nothing to read, so answer 200-empty immediately.
    // Without this, the non-fresh read 404s AND triggers a pointless full
    // transcript sweep (~350ms), and fresh=1 burns ~400ms scanning for a JSONL
    // that doesn't exist — the mobile app polls this exact window right after
    // POST /sessions.
    //
    // Why ALL THREE record conditions: a successful spawn writes pid/outputFile
    // but NEVER rewrites status_reason — 'awaiting_spawn' lingers on the record
    // until the first turn completes. Gating on status_reason alone would keep
    // serving 200-empty over a live, growing transcript for the whole first
    // turn; pid==null && !outputFile is the earliest visible spawn signal and
    // the real disengage latch.
    //
    // Why the grace window: the persist that records pid/outputFile can fail
    // (logged as CRITICAL in claude-code-session) with the CLI alive and
    // writing JSONL — an unbounded short-circuit would mask that real
    // transcript forever. After the window we fall through to the real read
    // paths; the health monitor's orphan sweep also flips a truly dead pid-less
    // row to 'stopped' on the same clock (ORPHAN_GRACE_MS), so a wedged record
    // stops matching either way. NOT gated to primary-only by accident:
    // CLOUD_MODE replicas have no session DB to consult and can't create
    // sessions, so the pre-spawn window doesn't exist there.
    if (!CLOUD_MODE && safeId) {
      const SPAWN_GRACE_MS = 2 * 60 * 1000
      const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
      const record = await getSessionByClaudeId(sessionId)
      if (record && record.status_reason === 'awaiting_spawn' && record.pid == null && !record.outputFile
          && record.process_status === 'idle' // seed value; a died-before-spawn record is 'stopped'
          && Date.now() - new Date(record.last_status_change ?? record.startedAt ?? 0).getTime() < SPAWN_GRACE_MS) {
        // Keep this shape in sync with buildSessionTranscript's SessionTranscript
        // output — the iOS client decodes it strictly.
        res.json({ version: 1, sessionId, exportedAt: new Date().toISOString(), truncated: false, messages: [] })
        return
      }
    }
    if (wantFresh && !CLOUD_MODE && safeId) {
      try {
        res.json(await buildSessionTranscript(sessionId))
        return
      } catch { /* unreachable session — fall back to the exported file */ }
    }
    if (wantFresh && CLOUD_MODE && safeId) {
      // Cloud fresh path: read the live jsonl over the daemon bridge. Falls
      // back to the git-synced file on any failure (bridge down, unknown sid).
      try {
        const { buildTranscriptViaBridge } = await import('./session-stream-v1.js')
        const viaBridge = await buildTranscriptViaBridge(sessionId)
        if (viaBridge) {
          res.json(viaBridge)
          return
        }
      } catch { /* fall back to the exported file */ }
    }
    let transcript = await readSessionTranscript(sessionId)
    if (!transcript && !CLOUD_MODE) {
      // Primary box: the sweep may simply not have run yet. Build just THIS
      // session inline (one read) and kick the full sweep in the background —
      // awaiting the sweep here meant one iOS poll waited out N serial daemon
      // reads (one per alive session, tens of seconds with several remotes).
      // Gated on an ALIVE tracker record (the sweep's own predicate):
      // buildSessionTranscript returns an EMPTY transcript (not an error) for
      // ids it can't read, but the v1 contract keeps unknown ids AND dead
      // sessions without an exported file at 404.
      const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
      const record = await getSessionByClaudeId(sessionId)
      if (record && (record.process_status === 'running' || record.process_status === 'idle')) {
        try {
          transcript = await buildSessionTranscript(sessionId)
        } catch { /* unreachable session — serve 404 below */ }
      }
      exportSessionTranscripts().catch(() => { /* background; throttled internally */ })
    }
    if (!transcript && CLOUD_MODE && safeId) {
      // Replica just launched this session itself (launch-seed hit): the
      // synced transcript file and the projection both lag the launch by
      // minutes, and the bridge jsonl may not exist yet either. Serve the
      // same 200-empty the primary serves for its awaiting_spawn window —
      // a 404 here made the phone's just-opened conversation view error out
      // on a perfectly healthy session (2026-08-07).
      const { getLaunchSeed } = await import('../../core/sessions/launch-seed.js')
      if (getLaunchSeed(sessionId)) {
        res.json({ version: 1, sessionId, exportedAt: new Date().toISOString(), truncated: false, messages: [] })
        return
      }
    }
    if (!transcript) {
      sendError(res, 404, 'not_found', `No transcript for session: ${sessionId}`)
      return
    }
    res.json(transcript)
  } catch (err) {
    next(err)
  }
})

// ─── Client logs (additive) — mobile apps upload diagnostic logs ───────────
//
// TestFlight builds can't be attached to with a debugger; this lets the app
// push its structured log buffer so issues can be diagnosed server-side.
// Files land in /tmp/open-walnut/ios-client/<device>-<localdate>.log as
// JSON-lines — same directory family the log toolkit already greps.
//
// The iOS app runs in FULL-DUMP mode (every level, every subsystem, batched
// every ~45s, gzipped), so this route is a firehose by design and the caps
// below are the only thing bounding it. Two consequences worth knowing:
//
//  - Bodies arrive `Content-Encoding: gzip`. express.json() inflates those
//    transparently, so nothing here needs to change — but the size limit that
//    matters is the DECOMPRESSED one (express.json({ limit: '15mb' })).
//  - Any line from the `freeze` / `crash` subsystem is an INCIDENT: it raises a
//    bus event + a deduped notification so it surfaces on the console bell
//    instead of waiting for someone to grep the file (see
//    core/notifications/client-incidents.ts). Ingest still succeeds if that
//    fails — losing the client's log to a bell failure would be worse.

// DERIVED FROM LOG_DIR, never hardcoded. A literal '/tmp/open-walnut/ios-client'
// escaped the per-worker runtime-dir isolation (tests/setup/runtime-dir-isolation.ts
// redirects WALNUT_DAEMON_DIR → LOG_DIR), so every ingest test appended its
// fixtures to the PRODUCTION forensics dir — which is what made a real device's
// logs impossible to tell apart from test debris. It also disagreed with the
// READER (core/observability/bug-report.ts uses path.join(LOG_DIR,'ios-client')),
// so under any override the bundler looked in a dir nothing wrote to.
const CLIENT_LOG_DIR = path.join(LOG_DIR, 'ios-client')
const CLIENT_LOG_MAX_LINES = 5000
/** Per device+day rotate guard. Full-dump traffic is ~2-6 MB/day gzipped-on-wire
 *  but lands expanded on disk, so this holds several heavy days. */
const CLIENT_LOG_MAX_FILE_BYTES = 64 * 1024 * 1024

apiV1Router.post('/client-logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const device = typeof req.body?.device === 'string' ? req.body.device : 'unknown'
    const appVersion = typeof req.body?.appVersion === 'string' ? req.body.appVersion : ''
    const os = typeof req.body?.os === 'string' ? req.body.os : ''
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : null
    if (!lines || lines.length === 0) {
      sendError(res, 400, 'bad_request', 'lines (non-empty array) is required')
      return
    }
    // Sanitize the device name into a safe filename fragment.
    const safeDevice = device.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'unknown'
    const day = new Date().toISOString().slice(0, 10)
    const file = path.join(CLIENT_LOG_DIR, `${safeDevice}-${day}.log`)

    await fsp.mkdir(CLIENT_LOG_DIR, { recursive: true })
    try {
      const stat = await fsp.stat(file)
      if (stat.size > CLIENT_LOG_MAX_FILE_BYTES) {
        sendError(res, 413, 'too_large', 'Log file quota for this device/day exhausted')
        return
      }
    } catch { /* file doesn't exist yet — fine */ }

    const accepted = lines.slice(0, CLIENT_LOG_MAX_LINES)
    const out = accepted
      .map((l: unknown) => JSON.stringify({
        device, appVersion, os,
        ...(typeof l === 'object' && l !== null ? l : { message: String(l) }),
      }))
      .join('\n') + '\n'
    // Persist BEFORE flagging: the file is the source of truth for forensics,
    // and a notification pointing at a line that failed to land is a lie.
    await fsp.appendFile(file, out, 'utf-8')
    log.web.info('api-v1 client logs received', { device: safeDevice, count: accepted.length, appVersion })
    res.json({ ok: true, received: accepted.length })

    // After the response — incident flagging must never add latency to the
    // phone's upload (a slow ack shrinks the OS background-task budget the
    // critical freeze upload depends on).
    const structured = accepted.filter(
      (l: unknown): l is Record<string, unknown> => typeof l === 'object' && l !== null,
    )
    if (structured.length > 0) {
      const { flagClientIncidents } = await import('../../core/notifications/client-incidents.js')
      flagClientIncidents(safeDevice, structured, { broadcast: broadcastEvent }).catch((err) => {
        log.web.warn('api-v1 client incident flagging failed', {
          device: safeDevice, error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  } catch (err) {
    next(err)
  }
})

// ─── Notes (thin adapters over the notes-v2 vault semantics) ───────────────

// GET /api/v1/notes — file tree
apiV1Router.get('/notes', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    await ensureNotesDir()
    const tree = await scanDir(NOTES_DIR, '')
    res.json({ tree })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/notes/content/*path — read note
apiV1Router.get('/notes/content/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notePath = getWildcardPath(req)
    if (!notePath) { sendError(res, 400, 'bad_request', 'path required'); return }
    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { sendError(res, 400, 'bad_request', 'invalid path'); return }
    const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

    let content: string
    let updatedAt: string
    try {
      content = await fsp.readFile(filePath, 'utf-8')
      const stat = await fsp.stat(filePath)
      updatedAt = stat.mtime.toISOString()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        sendError(res, 404, 'not_found', 'Note not found')
        return
      }
      throw err
    }
    res.json({ content, contentHash: computeContentHash(content), updatedAt })
  } catch (err) {
    next(err)
  }
})

/**
 * Shared write path for PUT (update) and POST (create). Stamps a frontmatter
 * id at create time (same invariant as notes-v2 — the returned contentHash
 * always reflects the bytes on disk) and fires the NOTES_UPDATED reconcile.
 */
async function writeNote(filePath: string, notePath: string, content: string): Promise<{ contentHash: string; updatedAt: string }> {
  const { data } = parseFrontmatter(content)
  let finalContent = content
  if (!readId(data)) {
    finalContent = stampId(content, generateNoteId())
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, finalContent, 'utf-8')
  const stat = await fsp.stat(filePath)
  const contentHash = computeContentHash(finalContent)
  const normalizedPath = notePath.replace(/\.md$/, '')
  // source format `notes/{path}` is a shared contract with files-tools.ts / useNoteContent.ts
  bus.emit(EventNames.NOTES_UPDATED, { source: `notes/${normalizedPath}`, contentHash }, ['web-ui'])
  scheduleNotesIndexUpdate(toRelPath(filePath))
  return { contentHash, updatedAt: stat.mtime.toISOString() }
}

// PUT /api/v1/notes/content/*path — update with optimistic locking
apiV1Router.put('/notes/content/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const notePath = getWildcardPath(req)
    if (!notePath) { sendError(res, 400, 'bad_request', 'path required'); return }
    const { content, expectedHash } = req.body ?? {}
    if (typeof content !== 'string') {
      sendError(res, 400, 'bad_request', 'content (string) is required')
      return
    }
    if (content.length > MAX_NOTE_SIZE) {
      sendError(res, 413, 'too_large', `Content too large (max ${MAX_NOTE_SIZE} bytes)`)
      return
    }
    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { sendError(res, 400, 'bad_request', 'invalid path'); return }
    const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

    // Optimistic locking: on mismatch return the server's copy so the client
    // can merge locally without a second round trip.
    if (typeof expectedHash === 'string' && expectedHash) {
      try {
        const serverContent = await fsp.readFile(filePath, 'utf-8')
        const serverHash = computeContentHash(serverContent)
        if (serverHash !== expectedHash) {
          sendError(res, 409, 'conflict', 'Note was modified externally', { serverHash, serverContent })
          return
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        // File doesn't exist — no conflict possible.
      }
    }

    const { contentHash, updatedAt } = await writeNote(filePath, notePath, content)
    log.memory.info('Note updated via api-v1', { path: notePath, size: content.length })
    res.json({ contentHash, updatedAt })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/notes — create a new note { path, content? }
apiV1Router.post('/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const { path: notePath, content } = req.body ?? {}
    if (typeof notePath !== 'string' || !notePath) {
      sendError(res, 400, 'bad_request', 'path (string) is required')
      return
    }
    if (content !== undefined && typeof content !== 'string') {
      sendError(res, 400, 'bad_request', 'content must be a string')
      return
    }
    const body = typeof content === 'string' ? content : ''
    if (body.length > MAX_NOTE_SIZE) {
      sendError(res, 413, 'too_large', `Content too large (max ${MAX_NOTE_SIZE} bytes)`)
      return
    }
    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { sendError(res, 400, 'bad_request', 'invalid path'); return }
    const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

    // Create-only: never silently overwrite (use PUT for updates).
    try {
      await fsp.stat(filePath)
      sendError(res, 409, 'conflict', 'Note already exists')
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    const { contentHash, updatedAt } = await writeNote(filePath, notePath, body)
    log.memory.info('Note created via api-v1', { path: notePath })
    res.status(201).json({ path: toRelPath(filePath), contentHash, updatedAt })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/notes/*path — delete note
apiV1Router.delete('/notes/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const notePath = getWildcardPath(req)
    if (!notePath) { sendError(res, 400, 'bad_request', 'path required'); return }
    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { sendError(res, 400, 'bad_request', 'invalid path'); return }
    const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

    try {
      await fsp.unlink(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        sendError(res, 404, 'not_found', 'Note not found')
        return
      }
      throw err
    }
    scheduleNotesIndexUpdate(toRelPath(filePath))
    log.memory.info('Note deleted via api-v1', { path: notePath })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ─── Router-level error handler: frozen error shape ────────────────────────

apiV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err)
  log.web.error('api-v1 unhandled error', { error: message })
  if (res.headersSent) { res.end(); return }
  sendError(res, 500, 'internal', message)
})
