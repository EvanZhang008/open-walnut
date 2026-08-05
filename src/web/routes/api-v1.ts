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
import type { ChatEntry } from '../../core/types.js'
import { CLOUD_MODE, NOTES_DIR } from '../../constants.js'
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
import { processAndSaveImages, buildImageAnnotation, type ImagePayload } from './images.js'
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
    void runApiV1Turn(agentId, conversationId, text, turnId, { savedImages, imageContentBlocks })
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
): Promise<void> {
  await enqueueAgentTurn(agentId, 'api-v1', async () => {
    // Lazy import to avoid loading the agent at server startup (same as chat.ts).
    const { runAgentLoop } = await import('../../agent/loop.js')

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

      emitSse(conversationId, 'message-end', { turnId, fullText: result.response })
      broadcastEvent(EventNames.AGENT_RESPONSE, { text: result.response, agentId, conversationId })
      log.web.info('api-v1 turn completed', { conversationId, turnId, agentId })

      // Same post-turn hygiene as WS chat — fire-and-forget.
      triggerBackgroundCompaction('api-v1', { agentId, conversationId })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.web.error('api-v1 turn error', { conversationId, turnId, agentId, error: errMsg })
      await chatHistory.addAIMessages(
        [{ role: 'assistant', content: [{ type: 'text', text: `[Error: ${errMsg}]` }] }] as MessageParam[],
        { source: 'agent-error', agentId, conversationId },
      ).catch(() => { /* best-effort */ })
      emitSse(conversationId, 'error', { message: errMsg })
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
  })
}

// ─── Tasks (read-only v1) ──────────────────────────────────────────────────

// GET /api/v1/tasks — slim task list for mobile.
// Cloud box: serves the git-synced tasks/projection.json (the replica).
// Primary box: exports a fresh projection from SQLite and serves that, so
// both modes return the identical shape (+ syncedAt provenance).
apiV1Router.get('/tasks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { readTaskProjection, exportTaskProjection } = await import('../../core/task-projection.js')
    if (!CLOUD_MODE) {
      // Live box — refresh the projection inline (cheap: one SELECT + write).
      await exportTaskProjection().catch(() => { /* serve last good file below */ })
    }
    const projection = await readTaskProjection()
    if (!projection) {
      sendError(res, 503, 'unavailable', 'Task projection not synced yet')
      return
    }
    let tasks = projection.tasks
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    if (status) tasks = tasks.filter((t) => t.status === status)
    res.json({ tasks, syncedAt: projection.exportedAt })
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

const CLIENT_LOG_DIR = '/tmp/open-walnut/ios-client'
const CLIENT_LOG_MAX_LINES = 5000
const CLIENT_LOG_MAX_FILE_BYTES = 20 * 1024 * 1024 // rotate guard per device+day

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
    await fsp.appendFile(file, out, 'utf-8')
    log.web.info('api-v1 client logs received', { device: safeDevice, count: accepted.length, appVersion })
    res.json({ ok: true, received: accepted.length })
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
