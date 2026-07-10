/**
 * /api/v1 — frozen REST+SSE facade for mobile clients (iOS app).
 *
 * Design goals:
 * - FROZEN CONTRACT: additive-only changes; see docs/api-v1.md.
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
import { fileURLToPath } from 'node:url'
import { Router, type Request, type Response, type NextFunction } from 'express'
import type { MessageParam } from '../../agent/model.js'
import type { ChatEntry } from '../../core/types.js'
import { CLOUD_MODE, NOTES_DIR } from '../../constants.js'
import * as chatHistory from '../../core/chat-history.js'
import { listConversations, createConversation } from '../../core/conversations.js'
import { enqueueAgentTurn, recordLastTurnTokens } from '../agent-turn-queue.js'
import { triggerBackgroundCompaction } from '../background-compaction.js'
import { broadcastEvent } from '../ws/handler.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { usageTracker } from '../../core/usage/index.js'
import { getLastSyncAt } from '../../integrations/git-sync.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { parseFrontmatter, readId, generateNoteId, stampId } from '../../core/parse-frontmatter.js'
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
import { log } from '../../logging/index.js'

export const apiV1Router = Router()

/** The v1 facade only exposes the General butler agent. */
const AGENT_ID = 'general'

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

// ── Version (from the repo/package root package.json, cached) ──

let cachedVersion: string | null = null
function getVersion(): string {
  if (cachedVersion) return cachedVersion
  try {
    // Walk up from this module (works from both src/ under tsx and dist/ bundles).
    let dir = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'package.json')
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { version?: string }
        if (pkg.version) { cachedVersion = pkg.version; return cachedVersion }
      }
      dir = path.dirname(dir)
    }
  } catch { /* fall through */ }
  cachedVersion = '0.0.0'
  return cachedVersion
}

// ─── GET /api/v1/status ────────────────────────────────────────────────────

apiV1Router.get('/status', (_req: Request, res: Response) => {
  // mode: LIVE = talking to the primary (Mac at home); REPLICA = the cloud
  // companion serving synced data. TODO(Phase 2): when the reverse-WS bridge to
  // the primary lands, a cloud box with a live bridge reports LIVE.
  let lastSyncAt: string | null = null
  try { lastSyncAt = getLastSyncAt() } catch { /* git unavailable — omit */ }
  res.json({
    mode: CLOUD_MODE ? 'REPLICA' : 'LIVE',
    cloud: CLOUD_MODE,
    version: getVersion(),
    serverTime: new Date().toISOString(),
    ...(lastSyncAt ? { lastSyncAt } : {}),
  })
})

// ─── Conversations ─────────────────────────────────────────────────────────

// GET /api/v1/conversations?limit= — most-recent first
apiV1Router.get('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
    const list = await listConversations(AGENT_ID)
    const sorted = [...list].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    res.json(sorted.slice(0, limit).map((c) => ({
      id: c.id,
      ...(c.title ? { title: c.title } : {}),
      updatedAt: c.lastMessageAt,
      messageCount: c.messageCount,
    })))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/conversations — create a new conversation
apiV1Router.post('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined
    const meta = await createConversation(AGENT_ID, title)
    res.status(201).json({ id: meta.id })
  } catch (err) {
    next(err)
  }
})

/** 404-checked conversation lookup shared by the message/stream endpoints. */
async function conversationExists(conversationId: string): Promise<boolean> {
  if (!/^conv-[A-Za-z0-9-]+$/.test(conversationId)) return false
  const list = await listConversations(AGENT_ID)
  return list.some((c) => c.id === conversationId)
}

// ── Message normalization (mobile-friendly flat shape) ──

const KIND_TEXT_MAX = 160

interface ApiV1Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt?: string
  kind?: 'tool' | 'thinking'
}

function shortText(s: string): string {
  return s.length > KIND_TEXT_MAX ? s.slice(0, KIND_TEXT_MAX) + '…' : s
}

/**
 * Flatten chat entries into simple mobile messages. Assistant entries expand
 * in block order: thinking → kind:'thinking', tool_use → kind:'tool', and all
 * text blocks of one entry join into a single plain assistant message.
 * Tool-result-only user entries are skipped (they ride with the tool call).
 * ids are positional ("m<index>") — stable for a given read, used as the
 * `before` cursor. Compaction can rewrite history, so treat cursors as
 * ephemeral: on a cursor miss, re-fetch from the tail.
 */
export function normalizeEntries(entries: ChatEntry[]): ApiV1Message[] {
  const out: ApiV1Message[] = []
  const push = (m: Omit<ApiV1Message, 'id'>) => {
    out.push({ id: `m${out.length}`, ...m })
  }

  for (const entry of entries) {
    const createdAt = entry.timestamp
    if (entry.tag === 'ui') {
      const text = typeof entry.content === 'string' ? entry.content : ''
      if (text) push({ role: entry.role, text, createdAt })
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
      if (text) push({ role: 'user', text, createdAt })
      continue
    }
    // assistant
    if (typeof entry.content === 'string') {
      if (entry.content) push({ role: 'assistant', text: entry.content, createdAt })
      continue
    }
    if (!Array.isArray(entry.content)) continue
    const textParts: string[] = []
    for (const block of entry.content as Array<Record<string, unknown>>) {
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        push({ role: 'assistant', text: shortText(block.thinking), createdAt, kind: 'thinking' })
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        push({ role: 'assistant', text: block.name, createdAt, kind: 'tool' })
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        textParts.push(block.text)
      }
    }
    if (textParts.length > 0) push({ role: 'assistant', text: textParts.join(''), createdAt })
  }
  return out
}

// GET /api/v1/conversations/:id/messages?limit=50&before=<cursor>
apiV1Router.get('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = paramStr(req.params.id)
    if (!(await conversationExists(conversationId))) {
      sendError(res, 404, 'not_found', `Conversation not found: ${conversationId}`)
      return
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))
    const { messages: entries } = await chatHistory.getDisplayEntries(
      1, Number.MAX_SAFE_INTEGER, AGENT_ID, conversationId,
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

interface SseEvent { seq: number; event: string; data: unknown }
interface SseConn { res: Response; ping: NodeJS.Timeout }
interface ConvBuffer { events: SseEvent[]; nextSeq: number; conns: Set<SseConn> }

/** Ring cap per conversation — a turn rarely exceeds a few hundred events. */
const RING_MAX = 512
const PING_INTERVAL_MS = 25_000

const sseBuffers = new Map<string, ConvBuffer>()

function getBuffer(conversationId: string): ConvBuffer {
  let buf = sseBuffers.get(conversationId)
  if (!buf) {
    buf = { events: [], nextSeq: 0, conns: new Set() }
    sseBuffers.set(conversationId, buf)
  }
  return buf
}

function writeSseEvent(res: Response, ev: SseEvent): void {
  res.write(`id: ${ev.seq}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`)
  // compression() buffers responses — flush after every event or SSE stalls.
  ;(res as Response & { flush?: () => void }).flush?.()
}

/** Emit an event into the conversation's ring buffer + all live SSE conns. */
function emitSse(conversationId: string, event: string, data: unknown): void {
  const buf = getBuffer(conversationId)
  // A new turn starts a fresh window — seq stays monotonic across turns so
  // Last-Event-ID from a previous turn never replays stale events.
  if (event === 'message-start') buf.events = []
  const ev: SseEvent = { seq: buf.nextSeq++, event, data }
  buf.events.push(ev)
  if (buf.events.length > RING_MAX) buf.events.splice(0, buf.events.length - RING_MAX)
  for (const conn of buf.conns) {
    try { writeSseEvent(conn.res, ev) } catch { /* dead conn — close handler cleans up */ }
  }
}

/** Close all live SSE connections (server shutdown / tests). */
export function closeApiV1Streams(): void {
  for (const buf of sseBuffers.values()) {
    for (const conn of buf.conns) {
      clearInterval(conn.ping)
      try { conn.res.end() } catch { /* already closed */ }
    }
    buf.conns.clear()
  }
}

// GET /api/v1/conversations/:id/stream
apiV1Router.get('/conversations/:id/stream', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = paramStr(req.params.id)
    if (!(await conversationExists(conversationId))) {
      sendError(res, 404, 'not_found', `Conversation not found: ${conversationId}`)
      return
    }

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    // no-transform keeps proxies AND the compression middleware from buffering.
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    res.write(': connected\n\n')
    ;(res as Response & { flush?: () => void }).flush?.()

    const buf = getBuffer(conversationId)

    // Replay: with Last-Event-ID → events after it; without → the whole
    // current-turn window (late joiners see the in-flight turn from the top).
    const lastIdRaw = req.header('Last-Event-ID')
      ?? (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined)
    const lastSeq = lastIdRaw != null && lastIdRaw !== '' ? Number(lastIdRaw) : null
    for (const ev of buf.events) {
      if (lastSeq != null && Number.isFinite(lastSeq) && ev.seq <= lastSeq) continue
      writeSseEvent(res, ev)
    }

    const conn: SseConn = {
      res,
      ping: setInterval(() => {
        try {
          res.write(': ping\n\n')
          ;(res as Response & { flush?: () => void }).flush?.()
        } catch { /* close handler cleans up */ }
      }, PING_INTERVAL_MS),
    }
    buf.conns.add(conn)

    req.on('close', () => {
      clearInterval(conn.ping)
      buf.conns.delete(conn)
    })
  } catch (err) {
    next(err)
  }
})

// ─── POST message → agent turn (shared queue with WS chat) ────────────────

/** REST-initiated turns currently running or queued, keyed by conversation. */
const activeTurns = new Map<string, string>()

apiV1Router.post('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = paramStr(req.params.id)
    if (!(await conversationExists(conversationId))) {
      sendError(res, 404, 'not_found', `Conversation not found: ${conversationId}`)
      return
    }
    const text = req.body?.text
    if (typeof text !== 'string' || text.trim().length === 0) {
      sendError(res, 400, 'bad_request', 'text (non-empty string) is required')
      return
    }
    if (activeTurns.has(conversationId)) {
      sendError(res, 409, 'turn_active', 'A turn is already active on this conversation')
      return
    }

    const turnId = crypto.randomUUID()
    activeTurns.set(conversationId, turnId)
    log.web.info('api-v1 message accepted', { conversationId, turnId, messageLength: text.length })

    // Fire the turn through the SAME per-agent queue the WS chat uses — one
    // serialization path. The 202 returns immediately; progress streams on SSE.
    void runApiV1Turn(conversationId, text, turnId)
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
async function runApiV1Turn(conversationId: string, text: string, turnId: string): Promise<void> {
  await enqueueAgentTurn(AGENT_ID, 'api-v1', async () => {
    // Lazy import to avoid loading the agent at server startup (same as chat.ts).
    const { runAgentLoop } = await import('../../agent/loop.js')

    const history = await chatHistory.getApiMessages(AGENT_ID, conversationId)

    // Eager persist: the user message survives crashes mid-turn.
    await chatHistory.addUserMessage(text, {
      displayText: text,
      turnId,
      agentId: AGENT_ID,
      conversationId,
    })

    emitSse(conversationId, 'message-start', { turnId })

    try {
      const result = await runAgentLoop(text, history, {
        onTextDelta: (delta) => {
          emitSse(conversationId, 'text-delta', { delta })
          broadcastEvent(EventNames.AGENT_TEXT_DELTA, { delta, agentId: AGENT_ID, conversationId })
        },
        onThinking: (thinkingText) => {
          emitSse(conversationId, 'thinking', {})
          broadcastEvent(EventNames.AGENT_THINKING, { text: thinkingText, agentId: AGENT_ID, conversationId })
        },
        onToolCall: (toolName, input, toolUseId) => {
          emitSse(conversationId, 'tool', { name: toolName })
          broadcastEvent(EventNames.AGENT_TOOL_CALL, { toolName, input, toolUseId, agentId: AGENT_ID, conversationId })
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
              agentId: AGENT_ID,
            })
          } catch { /* non-critical */ }
          // Feed the compaction/triage token-truth gate (see token-truth.ts).
          try {
            recordLastTurnTokens(conversationId, (usage.input_tokens ?? 0)
              + (usage.cache_read_input_tokens ?? 0)
              + (usage.cache_creation_input_tokens ?? 0))
          } catch { /* non-critical */ }
        },
      }, { source: 'api-v1', agentId: AGENT_ID, conversationId })

      // newMessages = [userPrompt, ...ai]; the user prompt is already persisted.
      const allNew = result.newMessages as MessageParam[]
      const afterUser = allNew.length > 0 && (allNew[0] as { role: string }).role === 'user'
        ? allNew.slice(1)
        : allNew
      if (afterUser.length > 0) {
        await chatHistory.addAIMessages(afterUser, { agentId: AGENT_ID, conversationId })
      }

      emitSse(conversationId, 'message-end', { turnId, fullText: result.response })
      broadcastEvent(EventNames.AGENT_RESPONSE, { text: result.response, agentId: AGENT_ID, conversationId })
      log.web.info('api-v1 turn completed', { conversationId, turnId })

      // Same post-turn hygiene as WS chat — fire-and-forget.
      triggerBackgroundCompaction('api-v1', { agentId: AGENT_ID, conversationId })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.web.error('api-v1 turn error', { conversationId, turnId, error: errMsg })
      await chatHistory.addAIMessages(
        [{ role: 'assistant', content: [{ type: 'text', text: `[Error: ${errMsg}]` }] }] as MessageParam[],
        { agentId: AGENT_ID, conversationId },
      ).catch(() => { /* best-effort */ })
      emitSse(conversationId, 'error', { message: errMsg })
      broadcastEvent(EventNames.AGENT_ERROR, { error: errMsg, agentId: AGENT_ID, conversationId })
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
