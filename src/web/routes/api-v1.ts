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
import type { MessageParam } from '../../model/model.js'
import type { ProjectedTranscriptMessage } from '../../core/session-projection.js'
import { VALID_PRIORITIES, type ChatEntry, type TaskPhase, type TaskPriority } from '../../core/types.js'
import { focusTierMatches } from '../../core/task-query.js'
import { parseSearchPromptMessage } from '../../core/task-search-transcript.js'
import { VALID_PHASES } from '../../core/phase.js'
import { CLOUD_MODE, LOG_DIR, NOTES_DIR } from '../../constants.js'
import * as chatHistory from '../../core/chat-history.js'
import { listConversations, createConversation } from '../../core/conversations.js'
import { enqueueAgentTurn, getQueueStatus } from '../agent-turn-queue.js'
import { broadcastEvent } from '../ws/handler.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { getLastSyncAtAsync } from '../../integrations/git-sync.js'
import { setDeviceInfo } from '../../core/device-auth.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { parseFrontmatter, readId, generateNoteId, stampId } from '../../core/parse-frontmatter.js'
import {
  toolDetail, toolResultPreview, toolResultText, toolInputPreview, thinkingLine, thinkingExcerpt,
} from '../../core/tool-summary.js'
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
import { mirrorRelayedChatFrame, relayChatTurnToPrimary } from './chat-turn-relay.js'
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
  return AGENT_ID_RE.test(raw) ? raw : null
}

/** The agent-id shape this router accepts. Shared with the relay handler, which
 *  must not accept an input the direct route would refuse. */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

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
  // The ASYNC twin: the phone polls this route, and the sync variant spawns two
  // blocking `git` children whenever its 30s cache is cold — one of those freezes
  // every other route with it.
  try { lastSyncAt = await getLastSyncAtAsync() } catch { /* git unavailable — omit */ }
  let bridgeHostsList: Array<{ hostAlias: string; since: number }> | undefined
  if (CLOUD_MODE) {
    try {
      const { bridgeHosts } = await import('../ws/bridge-registry.js')
      bridgeHostsList = bridgeHosts().map((b) => ({ hostAlias: b.hostAlias, since: b.since }))
    } catch { /* registry unavailable — omit */ }
  }
  // Can this companion RUN sessions itself (cloud.exec), and if not, why? A
  // feature that is off because nobody configured it and one that is off because
  // its config is unusable are different problems, and only the box knows which.
  let cloudExec: Record<string, unknown> | undefined
  if (CLOUD_MODE) {
    try {
      const { cloudExecStatus } = await import('../../core/cloud-exec.js')
      const { getConfig } = await import('../../core/config-manager.js')
      cloudExec = cloudExecStatus(await getConfig(), true) as unknown as Record<string, unknown>
    } catch { /* config unreadable — omit rather than claim a posture */ }
  }
  res.json({
    mode: CLOUD_MODE ? 'REPLICA' : 'LIVE',
    cloud: CLOUD_MODE,
    version: getVersion(),
    serverTime: new Date().toISOString(),
    ...(lastSyncAt ? { lastSyncAt } : {}),
    ...(bridgeHostsList ? { bridgeHosts: bridgeHostsList } : {}),
    ...(cloudExec ? { cloudExec } : {}),
  })
})

// GET /api/v1/canary — "would a phone send work right now, and if not, why?"
// Evaluates the exact gates a real send passes (disk-guard 507, bridge
// sockets, banked queue) — see core/send-path-canary.ts. `?fresh=1` forces an
// immediate re-poll instead of the last timer tick. Additive; REPLICA-only
// content (a LIVE box answers healthy with a note).
apiV1Router.get('/canary', async (req: Request, res: Response) => {
  if (!CLOUD_MODE) {
    res.json({ healthy: true, note: 'primary box — sends are local, no relay path to monitor' })
    return
  }
  const { getSendPathCanaryState } = await import('../../core/send-path-canary.js')
  const { getCanaryHandle } = await import('../server.js')
  const handle = getCanaryHandle()
  const state = req.query.fresh === '1' && handle ? await handle.poll() : getSendPathCanaryState()
  res.status(state.healthy ? 200 : 503).json(state)
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
//
// The kind-row caps (collapsed line ≤160, expanded excerpts ≤2000) live in ONE
// place, core/tool-summary.ts, because THREE surfaces build these rows and the
// documented caps have to be the same number in all of them.

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
  /** kind:'tool' only (additive) — the tool INPUT for the expanded card's Input
   *  section (`key: value` lines, ≤2000 chars, secrets masked). `detail` stays
   *  the collapsed ≤160 one-liner, so a Bash command that `detail` never carried
   *  (it prefers `description`) is reachable here. */
  inputPreview?: string
  /** kind:'thinking' only (additive) — fuller reasoning excerpt (≤2000 chars)
   *  for the expanded card; `text` stays the collapsed ≤160 line. */
  thinkingText?: string
  /** kind:'tool' on a Task/Agent row only (additive) — the delegated subagent's
   *  label, so the phone can say WHICH agent a delegation belongs to. */
  agent?: string
  /** kind:'tool' | kind:'thinking' (additive) — opaque handle on this row's FULL
   *  text (`GET /api/v1/activity/detail?ref=…`), present only when the excerpts
   *  above had to cut something. See core/activity-detail.ts for the identity
   *  scheme and why a row's position could not be it. Rows read out of the
   *  chat-history STORE (legacy in-process-agent turns) carry none: the store has
   *  no per-entry id to address, and the current engine writes every turn into a
   *  CLI session, so this only affects conversations that predate it. */
  detailRef?: string
  /** Additive, and TRUE only while this row's turn is still running (see
   *  {@link stampInFlight}). The phone's watchdog refetches this list when the
   *  stream goes quiet and used to read "an assistant row after my message" as
   *  "the turn is over", which a lane transcript makes false: the model's
   *  intermediate text ("I will run the first command...") lands as a row mid-turn.
   *  Absent means "not in flight", including on a server that predates the field. */
  inFlight?: true
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
 * A user turn as the phone should read it.
 *
 * The ✦ AI search's prompt is machine text too — Walnut's question plus a ~2.5KB
 * seed-row dump — and it reaches a conversation because the search's session is
 * adoptable ("Open as session"). The console folds it into a disclosure row; the
 * phone has no room for one, so it shows the QUESTION. Same parser as the console
 * (core/task-search-transcript), so the two surfaces cannot disagree about what
 * that message is.
 */
function userTurnText(raw: string): string {
  return parseSearchPromptMessage(raw)?.query ?? stripLeadingBanners(raw)
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
      text = userTurnText(text)
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
        // Same two fields the lane branch produces (see laneTranscriptToApiV1):
        // the two sources must look identical to the client, which is why the
        // collapsed line comes from the shared thinkingLine and not shortText.
        const excerpt = thinkingExcerpt(block.thinking)
        push({
          role: 'assistant', text: thinkingLine(block.thinking), createdAt, kind: 'thinking',
          ...(excerpt ? { thinkingText: excerpt } : {}),
        })
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const detail = toolDetail(block.name, block.input as Record<string, unknown> | undefined)
        const inputPreview = toolInputPreview(block.input as Record<string, unknown> | undefined)
        const result = typeof block.id === 'string' ? resultsById.get(block.id) : undefined
        push({
          role: 'assistant', text: block.name, createdAt, kind: 'tool',
          ...(detail ? { detail } : {}),
          ...(inputPreview ? { inputPreview } : {}),
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

/**
 * The window one /messages read answers with: cut everything at/after the
 * `before` cursor, then keep the most recent `limit` messages, oldest-first.
 * The client pages back by passing the first message's id as `before`.
 *
 * Positional ids ("m<index>") make this the cursor space, so BOTH sources this
 * route can serve (chat history, lane transcript) must go through this one
 * function — the iOS ChatStore derives `hasOlder` from `count >= pageSize` and
 * would double or skip a page if the two branches paged differently.
 */
/**
 * Mark the rows of the turn that is running RIGHT NOW on this conversation.
 *
 * The client half of the contract: the phone's turn watchdog refetches this list
 * when the SSE channel has been quiet for 30s (an ordinary `sleep 45` does it) and
 * decided the turn was over as soon as it saw an assistant text row after the
 * user's message. On a lane conversation that verdict is wrong, because the
 * transcript carries the model's INTERMEDIATE text: the phone cleared its live
 * state, unlocked the composer, and re-rendered the still-running tool from this
 * list, where a tool that has not returned yet has no `resultPreview`. So a
 * finished-looking row said "No output".
 *
 * The boundary is the LAST user row: everything after it is this turn's own
 * output, and the user row itself is not marked (it is the phone's own message,
 * already delivered). A conversation with no user row at all stamps nothing:
 * without the boundary there is no honest way to say which rows belong to the
 * running turn, and the client's heuristic needs the same anchor.
 *
 * Runs BEFORE paging, on the whole list, so a page is stamped identically no
 * matter which window of it the phone asked for.
 */
function stampInFlight(rows: ApiV1Message[], conversationId: string): ApiV1Message[] {
  // `activeTurns` covers a turn that is running OR still queued behind another
  // one, which is exactly the window in which "is it over?" must answer no.
  if (!activeTurns.has(conversationId)) return rows
  let lastUser = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') { lastUser = i; break }
  }
  if (lastUser === -1 || lastUser === rows.length - 1) return rows
  return rows.map((row, i) => (i > lastUser ? { ...row, inFlight: true as const } : row))
}

/**
 * One page of a conversation's rows, stamped with the in-flight marker.
 *
 * `conversationId` is a required parameter rather than something the callers stamp
 * themselves: this is the ONE function both read paths go through (the local GET
 * handler and the primary's `server.chat.messages` relay answer), so a phone
 * reading through a cloud replica gets byte-identical rows. Two call sites doing
 * it by hand is how one of them silently stops.
 */
function pageApiV1Messages(
  all: ApiV1Message[],
  limit: number,
  before: string | undefined,
  conversationId: string,
): ApiV1Message[] {
  let windowed = stampInFlight(all, conversationId)
  if (before) {
    const idx = Number(before.replace(/^m/, ''))
    if (Number.isFinite(idx)) windowed = windowed.slice(0, Math.max(0, idx))
  }
  return windowed.slice(-limit)
}

// ── Lane-bound conversations: the CLI sessions own the transcript ──
//
// A Personal AI turn sent from the WEB console runs inside a lane-bound `claude`
// CLI session, and that session's JSONL — not Walnut's chat-history store — is
// where the FULL transcript lands (tools, thinking, every assistant block). The
// store is not empty for such a conversation, though: both lane senders write a
// COMPAT COPY of each turn into it — the eager user row before the turn starts
// (chat.ts:894, api-v1.ts:1521) and the final answer after it ends (chat.ts:1058,
// runApiV1LaneTurn). So the real invariant is:
//
//   chat-history holds a compat COPY of lane turns; the prefix cutoff and the
//   leading-row dedupe below exist to render each turn exactly ONCE.
//
// The index's `messageCount` is a send counter bumped by touchLaneConversation,
// not a row count: the phone opened one of these and got `[]` next to "11
// messages" (measured on a live box: 24 of 64 non-empty conversations) until this
// route learned to read the lane.
//
// The conversation is assembled APPEND-ONLY, in this exact order:
//
//   [chat-history rows older than where lane content BEGINS] ++ [lane #1 transcript]
//   ++ [lane #2 transcript] ++ …          (lane sessions ordered by started_at)
//
// Three things this shape buys, each of which a simpler design lost:
//
//  1. STABLE POSITIONAL IDS. `m<n>` is an index, and the iOS client pages back
//     with `before=<the oldest id it holds>` and inserts the reply WITHOUT
//     deduping (ChatStore.loadOlder). Every segment above is closed and ordered,
//     and new content can only be appended at the END, so `m<n>` keeps meaning
//     the same message across builds. The earlier version read only the newest
//     lane and only its last 100 rows — a sliding window, in which one new turn
//     re-pointed every id and "load older" handed the phone rows it was already
//     showing. That is also why the lane transcript is read with `full: true`.
//  2. THE HISTORY BEFORE THE FIRST LANE. A conversation that predates the lane
//     engine has real chat-history rows; they are included by TIME, not merged,
//     so no row can ever appear twice.
//  3. THE HISTORY BEFORE A LANE BREAK. A `--resume` that fails with "No
//     conversation found" auto-archives the record (claude-code-session.ts) and
//     the next turn mints a fresh lane, so reading only the live lane silently
//     dropped every turn before the break. ALL lane sessions are read, archived
//     included (session-tracker.listSessionsByLane).
//
// Why the two sources cannot simply be merged by timestamp: a phone turn runs in
// the lane too and ALSO persists a copy to chat-history (runApiV1LaneTurn), so an
// interleave would render those turns twice; and a row that lands late would
// insert in the middle, shifting every id after it. The time gate at the start of
// the first CONTRIBUTING lane segment is the one cut that both de-duplicates and
// stays append-only (why "contributing": see the cutoff note in the assembly).
//
// A time gate alone is NOT enough, which is what `dropLeadingOverlap` is for: the
// eager user row is persisted BEFORE createSessionRecord stamps the lane's
// startedAt, so the very first message of every lane conversation is older than
// the cutoff, is kept in the prefix, AND is the first row of the CLI's own
// transcript — it rendered twice on every lane conversation, on both surfaces.
// The fix is in the assembler rather than at the two write sites because weeks of
// such rows are already on disk.
//
// ── Residuals (known, declared, not engineered around) ──
// All three are id shifts, and an id shift only reaches the user when it happens
// BETWEEN an open and a scroll-up: `before=<oldest id held>` is resolved against
// whatever the list is at that moment, so a shift makes "load older" re-serve or
// skip rows. A shift between two full opens is invisible.
//  R1. A segment that threw in the read below is skipped; when it later becomes
//      readable it both re-cuts the prefix and prepends rows, so every id moves.
//      The "+∞ when nothing contributed" rule is itself such a discontinuity: the
//      first transcript row to land flips the cutoff from +∞ to finite, which can
//      drop prefix rows and renumber from m0.
//  R2. An in-place rewind (getInPlaceRewinds, core/session-history.ts) deletes
//      rows out of the MIDDLE of a segment, so everything after the rewind point
//      shifts down. Nothing positional can survive that.
//  R3. A JSONL over the reader's 4 MB ceiling degrades to a bounded sliding
//      window, so the oldest rows of a whale lane are not addressable at all.
// Fixing any of them properly means a content-addressed cursor, i.e. a change to
// the frozen v1 contract.

/** Budget for the whole assembly — it can touch daemon-owned JSONLs. */
const LANE_TRANSCRIPT_DEADLINE_MS = 5_000

/** A cancellable timeout — Promise.race never cancels its loser on its own. */
function deadline(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
  return { promise, cancel: () => { if (timer) clearTimeout(timer) } }
}

/**
 * Degradation warns on this route are per-POLL, and the phone re-reads the open
 * conversation every 15s (its turn watchdog) — so an unthrottled warn turns one
 * unreachable lane into ~5,700 identical log lines a day. Throttled per
 * (reason, agent, conversation) with the same 10-minute cooldown the conversation
 * index's duplicate warn uses: a cooldown rather than a latch, so a condition
 * that is still broken an hour later still says so.
 */
const DEGRADE_WARN_COOLDOWN_MS = 10 * 60 * 1000
const lastDegradeWarn = new Map<string, number>()

function warnOncePerConversation(
  reason: string,
  agentId: string,
  conversationId: string,
  emit: () => void,
): void {
  const key = `${reason}|${agentId}|${conversationId}`
  const at = lastDegradeWarn.get(key)
  if (at !== undefined && Date.now() - at < DEGRADE_WARN_COOLDOWN_MS) return
  lastDegradeWarn.set(key, Date.now())
  emit()
}

/** Spawn-grace window for a just-seeded record — see isPreSpawnSession. */
const SPAWN_GRACE_MS = 2 * 60 * 1000

/**
 * "The record exists but the CLI was never up, so there is nothing to read yet."
 *
 * Why ALL THREE record conditions: a successful spawn writes pid/outputFile but
 * NEVER rewrites status_reason — 'awaiting_spawn' lingers on the record until the
 * first turn completes. Gating on status_reason alone would keep reporting
 * "nothing yet" over a live, growing transcript for the whole first turn;
 * pid==null && !outputFile is the earliest visible spawn signal and the real
 * disengage latch.
 *
 * Why the grace window: the persist that records pid/outputFile can fail (logged
 * as CRITICAL in claude-code-session) with the CLI alive and writing JSONL — an
 * unbounded short-circuit would mask that real transcript forever. After the
 * window callers fall through to the real read paths; the health monitor's orphan
 * sweep also flips a truly dead pid-less row to 'stopped' on the same clock
 * (ORPHAN_GRACE_MS), so a wedged record stops matching either way.
 */
function isPreSpawnSession(record: {
  status_reason?: string
  pid?: number | null
  outputFile?: string
  process_status?: string
  last_status_change?: string
  startedAt?: string
}): boolean {
  return record.status_reason === 'awaiting_spawn'
    && record.pid == null
    && !record.outputFile
    && record.process_status === 'idle' // seed value; a died-before-spawn record is 'stopped'
    && Date.now() - new Date(record.last_status_change ?? record.startedAt ?? 0).getTime() < SPAWN_GRACE_MS
}

/**
 * Map lane transcript rows onto the frozen mobile shape, WITHOUT ids (the
 * assembly stamps those once, over the whole list — see assembleLaneConversation).
 *
 * Content policy matches the chat-history branch (normalizeEntries) so the two
 * sources look the same to the client: entity refs resolve to their labels,
 * machine banners come off user turns, and the CLI's abort marker renders as a
 * card rather than a user bubble that misattributes an idle reap to the human.
 * What it does NOT do is clip or cap: the rows arrive from
 * buildSessionTranscript(…, { full: true }), so a long answer reaches the phone
 * whole, exactly as the chat-history branch delivers one.
 */
function laneTranscriptToApiV1(rows: ProjectedTranscriptMessage[]): Array<Omit<ApiV1Message, 'id'>> {
  const out: Array<Omit<ApiV1Message, 'id'>> = []
  for (const row of rows) {
    const role: 'user' | 'assistant' = row.role === 'user' ? 'user' : 'assistant'
    const createdAt = row.timestamp
    const raw = row.text ?? ''
    // kind rows carry a tool name / a thinking excerpt, not prose — pass through.
    if (row.kind) {
      out.push({
        role, text: raw, ...(createdAt ? { createdAt } : {}),
        kind: row.kind,
        ...(row.detail ? { detail: row.detail } : {}),
        ...(row.inputPreview ? { inputPreview: row.inputPreview } : {}),
        ...(row.resultPreview ? { resultPreview: row.resultPreview } : {}),
        ...(row.thinkingText ? { thinkingText: row.thinkingText } : {}),
        // The lane read builds with `full: true` (which implies `rich`), so its
        // clipped rows carry the drawer's handle on the text they cut. Dropping it
        // here would leave the chat surface with excerpt-only drawers while the
        // session surface expanded — the two-surfaces-disagree shape this batch
        // exists to end.
        ...(row.detailRef ? { detailRef: row.detailRef } : {}),
        // The projection has carried `agent` since Task/Agent rows learned their
        // subagent label; this mapping dropped it, so the phone could never say
        // which agent a delegation belonged to even though it decodes the field.
        ...(row.agent ? { agent: row.agent } : {}),
      })
      continue
    }
    // The CLI writes this marker on any AbortController fire (incl. idle reaps) —
    // a user bubble would misattribute it. Card, like the chat-history branch.
    if (role === 'user' && raw.trim() === '[Request interrupted by user]') {
      out.push({
        role: 'user', text: 'Turn interrupted',
        ...(createdAt ? { createdAt } : {}), kind: 'notification', source: 'interrupt',
      })
      continue
    }
    const text = stripEntityRefs(role === 'user' ? userTurnText(raw) : raw)
    if (!text) continue
    out.push({ role, text, ...(createdAt ? { createdAt } : {}) })
  }
  return out
}

/**
 * Stamp positional ids and guarantee every row carries `createdAt`.
 *
 * `createdAt` is NON-OPTIONAL in the iOS model (Models.swift `ChatMessage`), and
 * the response is decoded as one array — so a single row missing the key fails
 * the whole decode and the conversation renders EMPTY. A transcript row can
 * legitimately have no usable timestamp (a hand-written or truncated JSONL line),
 * so the value is carried forward from the previous row, falling back to the
 * assembly time. Never omitted.
 */
function stampApiV1Ids(rows: Array<Omit<ApiV1Message, 'id'>>, fallbackAt: string): ApiV1Message[] {
  let last = fallbackAt
  return rows.map((row, i) => {
    const createdAt = row.createdAt || last
    last = createdAt
    return { ...row, id: `m${i}`, createdAt }
  })
}

/**
 * The whole lane-bound conversation, oldest first, or null when this box cannot
 * answer (no lane session at all, or the read blew its budget) — in which case
 * the caller serves chat history as it always did.
 *
 * An EMPTY array is a real answer, not a fallback signal: a conversation whose
 * lane exists but has not spawned yet genuinely has nothing after its pre-lane
 * prefix, and returning null there would serve chat-history rows that the lane
 * will render again the moment it comes up (the duplicate-render bug).
 *
 * Assembly order and why it is append-only: see the block comment above.
 */
async function laneMessagesForConversation(
  agentId: string,
  conversationId: string,
): Promise<ApiV1Message[] | null> {
  // A REPLICA has no registry of the primary's lane sessions (session records are
  // machine-local) and no way to reach the JSONL, so it must never try to answer
  // this question locally — it relays the whole read instead
  // (relayMessagesToPrimary). Structural guard, not just a caller convention: a
  // replica answering here would report "no lane" for every web-sent
  // conversation, which is exactly the empty-history bug.
  if (CLOUD_MODE) return null
  const bail = deadline(LANE_TRANSCRIPT_DEADLINE_MS)
  try {
    const { personalAiLaneKey } = await import('../../core/sessions/personal-ai-lane.js')
    const { listSessionsByLane } = await import('../../core/session-tracker.js')
    // Archived rows INCLUDED and oldest-first: a lane that lost its CLI
    // conversation is archived, and its turns are the older half of this chat.
    const records = await listSessionsByLane(personalAiLaneKey(agentId, conversationId))
    if (records.length === 0) return null
    const outcome = await Promise.race([
      assembleLaneConversation(agentId, conversationId, records),
      bail.promise,
    ])
    if (outcome === 'timeout') {
      warnOncePerConversation('lane-timeout', agentId, conversationId, () => {
        log.web.warn('api-v1 messages: lane assembly timed out — serving chat history', {
          agentId, conversationId, lanes: records.length, budgetMs: LANE_TRANSCRIPT_DEADLINE_MS,
        })
      })
      return null
    }
    return outcome
  } catch (err) {
    warnOncePerConversation('lane-unavailable', agentId, conversationId, () => {
      log.web.warn('api-v1 messages: lane transcript unavailable — serving chat history', {
        agentId, conversationId, error: err instanceof Error ? err.message : String(err),
      })
    })
    return null
  } finally {
    bail.cancel()
  }
}

/**
 * Rows of `entries` inside (`floor`, `cutoff`) — the conversation's pre-lane prefix.
 * `floor` is the "Clear conversation" boundary (0 when the chat was never cleared).
 */
function chatHistoryPrefix(
  entries: ChatEntry[],
  cutoff: number,
  floor: number,
): Array<Omit<ApiV1Message, 'id'>> {
  return normalizeEntries(entries)
    .filter((m) => {
      const at = m.createdAt ? Date.parse(m.createdAt) : NaN
      if (!Number.isFinite(at)) {
        // No parseable timestamp = legacy row with nothing to place it by. Keep it
        // as pre-lane (dropping it loses real conversation, and every writer since
        // the store's v2 shape stamps a timestamp, so this is the migration tail)
        // — UNLESS the chat was cleared, in which case an unplaceable row cannot
        // be shown to have survived the clear, and "forget this" wins over "show
        // everything".
        return floor === 0
      }
      return at > floor && at < cutoff
    })
    .map(({ id: _id, ...rest }) => rest)
}

/** True when two rows are the same message seen through two writers. */
function sameRow(a: Omit<ApiV1Message, 'id'>, b: Omit<ApiV1Message, 'id'>): boolean {
  // Timestamps deliberately ignored: the two copies are minted seconds apart by
  // different writers, which is the whole reason a time-based cut cannot see them.
  // `kind` rows (tool/thinking) exist only in the transcript, so they can never be
  // half of a duplicate pair.
  if (a.kind || b.kind) return false
  return a.role === b.role && a.text.trim() === b.text.trim()
}

/**
 * Drop the prefix rows that the first lane segment repeats verbatim at its head.
 *
 * Why this exists: the eager `chatHistory.addUserMessage` on both lane senders
 * (api-v1.ts:1521, chat.ts:894) runs BEFORE createSessionRecord stamps the lane's
 * startedAt, so the first user message of every lane conversation lands on the
 * pre-lane side of the cutoff — and the CLI, spawned WITH that same text, writes
 * it as the first row of its transcript. Result before this: the opening message
 * of every lane conversation rendered twice, on the phone and in the console.
 *
 * Matched on (role, trimmed text), longest run first, so a genuine multi-row
 * overlap collapses too; in production the run is exactly one row.
 */
function dropLeadingOverlap(
  prefix: Array<Omit<ApiV1Message, 'id'>>,
  laneRows: Array<Omit<ApiV1Message, 'id'>>,
): Array<Omit<ApiV1Message, 'id'>> {
  for (let m = Math.min(prefix.length, laneRows.length); m > 0; m--) {
    const tail = prefix.slice(-m)
    if (tail.every((row, i) => sameRow(row, laneRows[i]))) return prefix.slice(0, prefix.length - m)
  }
  return prefix
}

/**
 * "Clear conversation" wipes chat-history and archives the lane with
 * `archive_reason: 'chat_cleared'` — but never touches the CLI's JSONL, so a
 * reader that takes every lane record serves the cleared transcript straight back.
 * Everything at or before the NEWEST cleared record is dropped here.
 *
 * Only this one reason is honoured, and that is deliberate:
 *  - `chat_cleared` (personal-ai-lane.archiveLaneForConversation, both clear
 *    routes) is the user saying "forget this". Drop it.
 *  - `remote_conversation_lost` (claude-code-session.ts) is a `--resume` that
 *    failed and re-minted the lane. Those turns really happened and the user never
 *    asked to lose them — this is exactly the history the old single-lane read was
 *    dropping, so it MUST stay included.
 *  - every other reason on a lane record ('retry', a rewind's message, a manual
 *    session_archive) means "this session continues elsewhere", not "forget it".
 * deleteConversation is not a hazard of this kind: it removes the conversation
 * file and its index row, so there is no id left to open.
 */
const LANE_CLEARED_REASON = 'chat_cleared'

interface LaneSegmentRecord {
  claudeSessionId: string
  startedAt: string
  lastActiveAt?: string
  archived?: boolean
  archive_reason?: string
}

function afterLastClear(records: LaneSegmentRecord[]): { records: LaneSegmentRecord[]; floor: number } {
  let cut = -1
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].archive_reason === LANE_CLEARED_REASON) { cut = i; break }
  }
  if (cut < 0) return { records, floor: 0 }
  // The archive stamps NO timestamp of its own (updateSessionRecord writes only
  // archived/archive_reason), so the clear's instant is not recorded anywhere. The
  // latest instant the dropped records can vouch for is the best available floor,
  // and it is sound in the normal case because `chatHistory.clear` empties the
  // store synchronously before the archive — a row after this floor can only be
  // post-clear content.
  let floor = 0
  for (const dropped of records.slice(0, cut + 1)) {
    for (const stamp of [dropped.startedAt, dropped.lastActiveAt]) {
      const at = stamp ? Date.parse(stamp) : NaN
      if (Number.isFinite(at) && at > floor) floor = at
    }
  }
  return { records: records.slice(cut + 1), floor }
}

/** The assembly itself (see the block comment). Ordered, append-only, renumbered once. */
async function assembleLaneConversation(
  agentId: string,
  conversationId: string,
  allRecords: LaneSegmentRecord[],
): Promise<ApiV1Message[]> {
  const { buildSessionTranscript } = await import('../../core/session-projection.js')

  // Anything the user cleared is gone, JSONL or not (see afterLastClear).
  const { records, floor } = afterLastClear(allRecords)

  // ── Lane segments first, oldest session first ──
  // Read before the prefix because WHERE the prefix ends is decided by where lane
  // content actually begins (see the cutoff note below), not by which records exist.
  const laneRows: Array<Omit<ApiV1Message, 'id'>> = []
  let cutoff = Number.POSITIVE_INFINITY
  for (const record of records) {
    // Same short-circuit GET /sessions/:id/transcript takes, for the same reason:
    // the phone polls this route, and a scan for a JSONL that cannot exist yet
    // costs a daemon round trip per poll.
    if (isPreSpawnSession(record as Parameters<typeof isPreSpawnSession>[0])) continue
    try {
      // full: no 100-row tail and no text clipping — this consumer pages to the
      // conversation's start and must not lose the tail of a long answer.
      const transcript = await buildSessionTranscript(record.claudeSessionId, { full: true })
      const mapped = laneTranscriptToApiV1(transcript.messages)
      if (mapped.length === 0) continue
      // The record's creation time is strictly before any row its CLI can write,
      // so it is the safe cut. If it is unreadable, fall back to this segment's
      // own earliest row — derived from the same bytes, so it cannot drift.
      let at = Date.parse(record.startedAt)
      if (!Number.isFinite(at)) {
        at = Math.min(...mapped.map((m) => (m.createdAt ? Date.parse(m.createdAt) : NaN))
          .filter((n) => Number.isFinite(n)))
      }
      if (Number.isFinite(at) && at < cutoff) cutoff = at
      laneRows.push(...mapped)
    } catch (err) {
      // One unreadable segment (purged JSONL, host unreachable) must not blank the
      // rest of the conversation. It leaves a HOLE, which shifts the ids after it
      // — unavoidable, and far better than serving nothing.
      warnOncePerConversation('lane-segment', agentId, conversationId, () => {
        log.web.warn('api-v1 messages: a lane segment could not be read — serving the rest', {
          agentId, conversationId, sessionId: record.claudeSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }

  // ── Then the prefix: chat history from BEFORE lane content begins ──
  // The cutoff is the start of the first lane session that actually CONTRIBUTED
  // rows, not merely the first record that exists. Two cases it has to get right,
  // and both are about not losing real conversation:
  //  - a lane minted seconds ago whose CLI has not written a transcript yet: no
  //    lane content exists, so nothing can be duplicated, so the phone's own
  //    chat-history copies ARE the conversation (cutoff stays +∞);
  //  - an archived segment whose JSONL is gone: its era's chat-history copies fill
  //    part of the hole instead of being cut away with it.
  // A cutoff of +∞ is NOT "throw the assembly away and serve chat history" — that
  // switch discarded a non-empty assembly's ids on the strength of one failed read.
  // Here there is simply no lane content, and one rule ("history before lane
  // content, then lane content") produces both answers.
  const { messages: entries } = await chatHistory.getDisplayEntries(
    1, Number.MAX_SAFE_INTEGER, agentId, conversationId,
  )
  // …minus the rows the first segment repeats verbatim (the eager user message).
  const rows = dropLeadingOverlap(chatHistoryPrefix(entries, cutoff, floor), laneRows)
  rows.push(...laneRows)
  return stampApiV1Ids(rows, new Date().toISOString())
}

// ── The REPLICA's half: relay the whole read to the primary ──
//
// The phone is paired to the cloud companion, so "serve chat history locally"
// meant every web-sent conversation opened empty THERE too — the box the user's
// phone actually talks to. This is the same box-level control action shape the
// push registry and the human inbox use (`server.*`, host '__local__',
// sessionId '__server__', see core/push/relay.ts): the primary answers with the
// SAME handler code its own route runs, already paged, and this box hands the
// body back untouched. Deliberately NOT a lane-aware bridge lookup — a replica
// cannot resolve a lane session's host at all (the projection excludes lane
// records), so the only honest owner of the answer is the primary.
//
// Nothing is persisted here: this is a read, and the primary stays the single
// writer for a relayed conversation.

/**
 * Relay budget. It must exceed the primary's OWN transcript bound
 * (LANE_TRANSCRIPT_DEADLINE_MS) or this timer wins the race and the phone gets
 * chat history for a conversation whose lane the primary was about to read
 * successfully — the inner deadline is the one that should degrade, not this one.
 */
const MESSAGES_RELAY_TIMEOUT_MS = LANE_TRANSCRIPT_DEADLINE_MS + 3_000

/**
 * One page of this conversation's messages as the PRIMARY sees it, or null when
 * this box has to answer for itself (bridge down/timeout, a primary that predates
 * the action, a malformed reply, or a conversation the primary has never heard of
 * — a phone-created one that has not been relayed yet, whose history really is
 * local here).
 */
async function relayMessagesToPrimary(
  agentId: string,
  conversationId: string,
  limit: number,
  before: string | undefined,
): Promise<ApiV1Message[] | null> {
  const { callPrimaryControl } = await import('./v1-control-relay.js')
  const outcome = await callPrimaryControl(
    'server.chat.messages',
    '__server__',
    { agentId, conversationId, limit, ...(before !== undefined ? { before } : {}) },
    MESSAGES_RELAY_TIMEOUT_MS,
  )
  if (!outcome.ok) {
    // git-sync mirrors the conversation files here, so the local read is a real
    // (if possibly stale, and empty for a lane conversation) answer — better than
    // an error on the surface the phone opens first. When it turns out to be empty
    // for a conversation the index says has messages, the route answers 503
    // instead of a false empty (see the handler).
    warnOncePerConversation('relay-failed', agentId, conversationId, () => {
      log.web.warn('api-v1 messages: relay to the primary failed — serving this box\'s chat history', {
        agentId, conversationId, failureKind: outcome.failure.kind, reason: outcome.failure.message,
      })
    })
    return null
  }
  const result = outcome.result
  if (!Array.isArray(result.messages)) {
    warnOncePerConversation('relay-malformed', agentId, conversationId, () => {
      log.web.warn('api-v1 messages: malformed relay reply — serving this box\'s chat history', {
        agentId, conversationId,
      })
    })
    return null
  }
  if (result.known === false) {
    // The primary has no lane AND no index row for this conversation, so its
    // empty answer describes nothing. Local history is the real one.
    warnOncePerConversation('relay-unknown-conv', agentId, conversationId, () => {
      log.web.info('api-v1 messages: the primary does not know this conversation — serving local chat history', {
        agentId, conversationId,
      })
    })
    return null
  }
  return result.messages as ApiV1Message[]
}

/**
 * PRIMARY side of `server.chat.messages` — the same read the local route does,
 * paged, plus the two facts the replica needs to decide whether this answer is
 * meaningful: which source it came from, and whether this box knows the
 * conversation at all.
 *
 * Both ids are validated with the ROUTE's own patterns: the relay must not accept
 * inputs the direct route would refuse (same rule as `server.search` in
 * session-controls.ts). A rejected id answers `known: false`, which sends the
 * replica back to its own history rather than reporting an empty conversation.
 */
export async function handlePrimaryChatMessagesRelay(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agentId = typeof params.agentId === 'string' && params.agentId ? params.agentId : DEFAULT_AGENT_ID
  const conversationId = typeof params.conversationId === 'string' ? params.conversationId : ''
  const limit = Math.max(1, Math.min(200, Number(params.limit) || 50))
  const before = typeof params.before === 'string' ? params.before : undefined
  if (!AGENT_ID_RE.test(agentId) || !/^conv-[A-Za-z0-9-]+$/.test(conversationId)) {
    return { messages: [], source: 'chat-history', known: false }
  }
  const laneMessages = await laneMessagesForConversation(agentId, conversationId)
  if (laneMessages) {
    return {
      messages: pageApiV1Messages(laneMessages, limit, before, conversationId),
      source: 'lane', known: true,
    }
  }
  const known = (await listConversations(agentId)).some((c) => c.id === conversationId)
  if (!known) return { messages: [], source: 'chat-history', known: false }
  const { messages: entries } = await chatHistory.getDisplayEntries(
    1, Number.MAX_SAFE_INTEGER, agentId, conversationId,
  )
  return {
    messages: pageApiV1Messages(normalizeEntries(entries), limit, before, conversationId),
    source: 'chat-history',
    known: true,
  }
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
    const before = typeof req.query.before === 'string' ? req.query.before : undefined
    let relayFailed = false
    if (CLOUD_MODE) {
      // The reply is ALREADY a page — do not re-page it here; the cursor space
      // belongs to the primary, which is the box that read the source.
      const relayed = await relayMessagesToPrimary(agentId, conversationId, limit, before)
      if (relayed) {
        res.json(relayed)
        return
      }
      relayFailed = true
      // else: fall through to this box's chat history (git-synced mirror).
    } else {
      // A lane-bound conversation's transcript belongs to its CLI sessions, so its
      // chat-history file is empty by design — read the lane, not [].
      const laneMessages = await laneMessagesForConversation(agentId, conversationId)
      if (laneMessages) {
        res.json(pageApiV1Messages(laneMessages, limit, before, conversationId))
        return
      }
    }
    const { messages: entries } = await chatHistory.getDisplayEntries(
      1, Number.MAX_SAFE_INTEGER, agentId, conversationId,
    )
    const local = pageApiV1Messages(normalizeEntries(entries), limit, before, conversationId)
    // A replica whose relay failed and whose own copy is EMPTY for a conversation
    // the index says has messages must not answer 200-[]: the iOS client REPLACES
    // its rows with a 200 body (ChatStore.loadMessages), so a false empty wipes a
    // conversation the phone was correctly showing a second ago. On a thrown error
    // it keeps what it has and reports reachability instead, which is the truthful
    // outcome here — the history exists, this box just cannot reach it yet.
    if (relayFailed && local.length === 0 && !before) {
      const meta = (await listConversations(agentId)).find((c) => c.id === conversationId)
      if ((meta?.messageCount ?? 0) > 0) {
        sendError(res, 503, 'primary_unreachable',
          'Your primary box is unreachable, so this conversation could not be loaded yet',
          { retry: true })
        return
      }
    }
    res.json(local)
  } catch (err) {
    next(err)
  }
})

// ─── SSE stream: per-conversation ring buffer + replay ────────────────────
// Machinery lives in ../sse-channels.ts (shared with session streams). The
// conversation channel resets its replay window on 'message-start' (a new
// turn); seq stays monotonic across turns.

/** The two frames that END a turn: after either one the client treats it as over. */
const TURN_TERMINAL_EVENTS = new Set(['message-end', 'error'])

function emitSse(conversationId: string, event: string, data: unknown): void {
  // Release the turn BEFORE its terminal frame goes out, never after. iOS reacts to
  // `message-end` by refetching GET /messages, and the release used to happen in the
  // POST handler's `.finally()`, i.e. after the frame: the refetch that the frame
  // triggered still saw `inFlight` rows for a turn the client had just been told was
  // finished. Exactly one terminal frame is emitted per turn, so an unconditional
  // delete here cannot take a later turn's entry, and the `.finally()` release stays
  // as the backstop for a turn that dies without emitting one.
  if (TURN_TERMINAL_EVENTS.has(event)) activeTurns.delete(conversationId)
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

// ── No recovery emitter lives here, deliberately ──
// A turn recovered from disk (core/sessions/lane-orphan-recovery.ts) must NEVER
// be announced with this channel's terminal frames. `emitSse` passes every frame
// to mirrorRelayedChatFrame, which re-stamps it with whichever turnId is armed
// for the conversation right now — so a `message-end` carrying an OLD answer
// settles the LIVE relayed turn on the replica and the real terminal frame is
// then dropped. iOS's `message-end` handler ignores turnId altogether and
// finalizes whatever is streaming. The recovery path emits an advisory bus event
// instead (RECOVERED_TURN_EVENT); clients read the adopted message from the
// store like any other history. Do not add an SSE emit back here.

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

/**
 * One turn's image attachments as they travel through the engine router.
 *
 * `savedImages`/`imageContentBlocks` are the on-disk + model-facing forms the
 * turn path consumes. `images` keeps the ORIGINAL request payloads, which only
 * the cloud relay needs: the primary has to receive bytes to stage, and a
 * replica-local file path is meaningless there. On a replica the two saved
 * fields start EMPTY and are filled in only if the turn falls back locally.
 */
interface TurnImageData {
  savedImages: Array<{ filePath: string; filename: string; mediaType: string }>
  imageContentBlocks: unknown[] | null
  images?: ImagePayload[]
}

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
    //
    // A CLOUD REPLICA saves NOTHING here: the turn is about to be relayed, and
    // the primary is the single owner of both the bytes and the history for a
    // relayed turn (a file on this box also means nothing over there). A relay it
    // cannot use ends the turn with an error, so there is nothing to save later.
    let imageData: TurnImageData | undefined
    if (images.length > 0) {
      imageData = { savedImages: [], imageContentBlocks: null, images }
      if (!CLOUD_MODE) {
        const processed = await processAndSaveImages(images)
        if (processed) imageData = { ...processed, images }
      }
    }

    const turnId = crypto.randomUUID()
    activeTurns.set(conversationId, turnId)
    log.web.info('api-v1 message accepted', { conversationId, turnId, agentId, messageLength: text.length, imageCount: images.length })

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
    // On a CLOUD REPLICA the turn is relayed to the primary, which is the only
    // box that can run it — see routes/chat-turn-relay.ts.
    void runApiV1TurnRouted(agentId, conversationId, text, turnId, imageData)
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

/** What a replica tells the phone when it cannot reach the box that answers. */
const PRIMARY_UNREACHABLE_MESSAGE =
  "Walnut's primary is unreachable; the replica cannot answer on its own. Try again when the primary is back."

/**
 * Turn router for one accepted REST turn.
 *
 * On the PRIMARY this is just runApiV1Turn. On a CLOUD REPLICA the turn is handed
 * to the primary, because a turn runs in a `claude` CLI session and the replica
 * has neither a session runner nor the CLI. There is no second engine to degrade
 * to, so a relay the replica cannot use is a turn it cannot answer: the phone
 * gets the SSE `error` frame it already unlocks its composer on, and nothing is
 * written here (the replica is never a writer for a relayed turn).
 *
 * IMAGE turns relay too, but their bytes take a different lane: the ORIGINAL
 * base64 payloads (not this box's saved paths, which mean nothing over there)
 * are staged on the primary via the daemon's narrow `image.save`, and only the
 * returned host paths ride the control RPC — base64 in a 45s RPC is the
 * oversized-frame failure mode that closes the shared bridge socket. An image
 * that will not stage takes the whole turn down the same unreachable path: a
 * "what is this?" answered without the picture would be confidently wrong.
 */
async function runApiV1TurnRouted(
  agentId: string,
  conversationId: string,
  text: string,
  turnId: string,
  imageData?: TurnImageData,
): Promise<void> {
  if (!CLOUD_MODE) {
    await runApiV1Turn(agentId, conversationId, text, turnId, imageData)
    return
  }

  const outcome = await relayChatTurnToPrimary(
    agentId, conversationId, text, turnId, imageData?.images ?? [],
  )

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

  log.web.warn('api-v1 turn refused — the replica cannot reach the primary', {
    conversationId, turnId, agentId, reason: outcome.reason,
  })
  emitSse(conversationId, 'error', { message: PRIMARY_UNREACHABLE_MESSAGE })
}

/**
 * Entry point for a chat turn RELAYED here from a cloud replica (the primary
 * side of routes/chat-turn-relay.ts). Deliberately the ordinary turn path: this
 * box owns the lane session, persistence, and the SSE contract, so there is no
 * second turn implementation to keep in sync.
 */
export async function runRelayedApiV1Turn(
  agentId: string,
  conversationId: string,
  text: string,
  turnId: string,
  /** Images the replica staged on this box, already adopted into THIS box's
   *  image store by the relay (adoptRelayedImagePaths). Same shape a local
   *  attachment produces, so the turn path needs no relay-specific branch. */
  imageData?: {
    savedImages: Array<{ filePath: string; filename: string; mediaType: string }>
    imageContentBlocks: unknown[] | null
  },
): Promise<void> {
  // Register in `activeTurns` like the local POST path does. chat-turn-relay.ts
  // keeps its OWN map (`primaryTurns`) for its duplicate/turn_active gates, and
  // that map is invisible to the read side: without this line a replica-initiated
  // turn ran on this box with nothing marking its rows in flight, which is the one
  // topology where the phone reads its rows THROUGH this box. Released in the
  // `finally` below, plus early by the terminal frame (see emitSse).
  activeTurns.set(conversationId, turnId)
  try {
    await runApiV1Turn(agentId, conversationId, text, turnId, imageData)
  } finally {
    if (activeTurns.get(conversationId) === turnId) activeTurns.delete(conversationId)
  }
}

/**
 * Persist + publish a failed turn: the disk entry, the SSE `error` the mobile
 * client unlocks its composer on, and the two WS broadcasts the web console
 * needs (live error card + agent:error). One helper so the prelude catch and the
 * lane turn below cannot drift into two different failure shapes.
 */
async function persistAndEmitTurnError(
  agentId: string,
  conversationId: string,
  errMsg: string,
  /** The user's own text, when the caller knows the turn may have died BEFORE
   *  the eager persist. See `rescueUserMessage`. */
  rescue?: { text: string; turnId: string },
): Promise<void> {
  if (rescue) await rescueUserMessage(agentId, conversationId, rescue.text, rescue.turnId)
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

/**
 * Write the user's message if the turn died before the eager persist did.
 *
 * A turn normally persists the user message early precisely so it survives a
 * mid-turn crash. But everything between "the turn was accepted" and that
 * persist — engine resolution, the console-agent profile load, the history read
 * — can still throw, and then the message is gone: the conversation file is left
 * with `entries: []` while the phone shows the bubble it typed and an error
 * under it. Refreshing makes the bubble vanish, so the user's words are lost
 * with no way to retry them (observed 2026-08-27 23:03 on a relayed turn: the
 * conversation file carried 134 bytes and an empty `entries` array).
 *
 * Idempotent by turnId: the ordinary path already wrote this message, so a
 * second copy would double it. Best-effort — an error handler must never throw.
 */
async function rescueUserMessage(
  agentId: string,
  conversationId: string,
  text: string,
  turnId: string,
): Promise<void> {
  try {
    // `onlyIfTurnAbsent` does the check INSIDE chat-history's write lock — a
    // read here followed by a write would race the ordinary persist and could
    // double the message (see chat-history.addUserMessage).
    await chatHistory.addUserMessage(text, {
      displayText: text, turnId, agentId, conversationId, onlyIfTurnAbsent: true,
    })
  } catch (err) {
    // The store itself is what refused the write — which is also one of the
    // things that can crash a prelude (a corrupt conversation file makes the
    // history read throw, and then the rescue's own write throws the same way).
    // Say so with the text INCLUDED, so the words exist in the log even when
    // they cannot exist on disk. A log line is a poor place for a user's message
    // and still better than nowhere.
    log.web.error('api-v1: could not rescue the user message of a failed turn', {
      conversationId, turnId, agentId,
      error: err instanceof Error ? err.message : String(err),
      lostText: text,
    })
  }
}

/**
 * Run one REST turn on the conversation's Personal AI lane and keep the frozen
 * SSE contract.
 *
 * Why this exists at all, when chat.ts's lane turn is fire-and-forget: the web
 * client subscribes to the LANE SESSION's own stream, so the RPC there can return
 * the moment the message is delivered. The mobile client has exactly one channel —
 * this conversation's SSE — and unlocks its composer on `message-end`. So a lane
 * turn fired from mobile has to be AWAITED and translated back onto that channel:
 *
 *   - `session:text-delta` for the lane session → SSE `text-delta`. This is what
 *     feeds the client's inactivity watchdog and paints the live bubble during a
 *     multi-minute turn; the SSE channel's own 25s comment ping is transport-level
 *     only and carries no event.
 *   - `session:tool-use` → SSE `tool`, `session:tool-result` → SSE `tool-result`,
 *     `session:thinking-delta` → SSE `thinking`. Relaying only text is what made a
 *     lane turn look like a blinking "Thinking…" with no tool ever named: the
 *     client's activity line is driven by these frames and it had none, so a
 *     five-minute turn of real work was indistinguishable from a hang.
 *   - turn answer → SSE `message-end` + a normal assistant entry on disk.
 *   - timeout / `session:error` → SSE `error` + the failure persisted on disk.
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

  // ── Thinking coalescer ──
  // Thinking deltas arrive at TOKEN rate with urgency:'urgent', and this channel
  // fans out to every open client (plus the bridge mirror, and the 512-event
  // replay ring, which a raw token stream would blow through — evicting this
  // turn's own message-start from what a reconnect replays). The client buffers
  // deltas at the same cadence anyway (ChatStore.appendDelta), so batching here
  // is invisible to it and cheap for everyone: one trailing 120ms window per
  // burst, flushed on turn end so the tail is never lost.
  const THINKING_FLUSH_MS = 120
  let thinkingBuf = ''
  let thinkingTimer: NodeJS.Timeout | null = null
  const flushThinking = (): void => {
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null }
    if (!thinkingBuf) return
    const delta = thinkingBuf
    thinkingBuf = ''
    emitSse(conversationId, 'thinking', { delta })
  }

  // Set just before this turn's terminal frame. Nothing may be relayed after it:
  // iOS finalizes the turn on `message-end`, so a later frame would leave its
  // activity line lit on a finished turn — and it would also sit in the replay
  // ring AFTER the terminal frame, which is the shape that once re-materialized a
  // previous answer as a permanent duplicate on reconnect. One rule for all four
  // kinds on purpose: two rules in one handler is how the next person reintroduces
  // this. (A trailing delta after the CLI's result line is normal, not rare.)
  let turnSettled = false

  // toolUseIds whose `tool` frame this turn actually put on the wire. A
  // `tool-result` means "clear the activity line for THIS id", so one whose `tool`
  // frame was dropped (a subagent's, a replayed one, one that arrived before the
  // lane id resolved) is an instruction about a line the client never drew: iOS
  // looks the id up, misses, and is left holding a frame it cannot place. Relaying
  // only known ids makes the pair symmetric — every drop rule above now
  // automatically applies to the result too, instead of each one having to
  // remember to.
  const relayedToolUseIds = new Set<string>()

  // Live relay. Interest-scoped global subscription (the pattern every session-event
  // consumer uses): session events are addressed to 'main-ai'/'session-runner', and
  // without `interest` this handler would wake on every event in the process.
  // The lane id is only known once the lane resolves, hence the onSessionId hook —
  // subscribing FIRST means no delta of this turn can slip through the gap.
  bus.subscribe(subName, (event) => {
    const d = event.data as {
      sessionId?: string; delta?: string; parentToolUseId?: string; replayed?: boolean
      toolName?: string; toolUseId?: string; input?: unknown; result?: string
    }
    if (turnSettled) return
    // Own lane only, and never a `replayed` event (JSONL history being re-read,
    // not this turn happening). Identical gate for all four event kinds.
    if (laneSessionId === null || d.sessionId !== laneSessionId || d.replayed) return
    // `parentToolUseId` = a SUBAGENT's nested activity. Dropped for every kind,
    // for the same reason the text path drops it: this channel drives ONE activity
    // line for the main turn, and a subagent's tools would overwrite "Task —
    // investigate the crash" with whatever the delegate happens to be reading —
    // hiding the one fact the human needs (the main agent is inside a delegation).
    // The subagent's own transcript is its own surface. Note thinking deltas never
    // carry the field at all (stream_event lines have no parent_tool_use_id), so
    // that kind is unaffected by this rule today.
    if (d.parentToolUseId) return
    switch (event.name) {
      case EventNames.SESSION_TEXT_DELTA: {
        if (!d.delta) return
        // Subagent text never reaches the turn's result text
        // (claude-code-session.ts keeps it out of fullText) — see the gate above.
        emitSse(conversationId, 'text-delta', { delta: d.delta })
        return
      }
      case EventNames.SESSION_THINKING_DELTA: {
        if (!d.delta) return
        thinkingBuf += d.delta
        if (!thinkingTimer) {
          thinkingTimer = setTimeout(flushThinking, THINKING_FLUSH_MS)
          thinkingTimer.unref?.()
        }
        return
      }
      case EventNames.SESSION_TOOL_USE: {
        if (!d.toolName) return
        // A tool starting ENDS the reasoning burst it followed: flush first so the
        // frames stay in causal order on a channel the client reads as a sequence.
        flushThinking()
        const input = d.input as Record<string, unknown> | undefined
        const detail = toolDetail(d.toolName, input)
        // `detail` is the collapsed one-liner (Bash prefers `description`, so the
        // command itself never reached the phone). `inputPreview` is the same
        // bounded, masked `key: value` render the history row carries, so an
        // expanded live row shows what the tool was actually called with.
        const inputPreview = toolInputPreview(input)
        if (d.toolUseId) relayedToolUseIds.add(d.toolUseId)
        emitSse(conversationId, 'tool', {
          name: d.toolName,
          ...(d.toolUseId ? { toolUseId: d.toolUseId } : {}),
          ...(detail ? { detail } : {}),
          ...(inputPreview ? { inputPreview } : {}),
        })
        return
      }
      case EventNames.SESSION_TOOL_RESULT: {
        if (!d.toolUseId) return
        // Only an id this turn announced (see relayedToolUseIds). `delete` rather
        // than `has`: it also makes a repeated result frame a no-op, and keeps the
        // set from outliving the tools it describes.
        if (!relayedToolUseIds.delete(d.toolUseId)) return
        // The id clears the activity line; `resultPreview` is what a FINISHED live
        // row can show before the transcript lands. Without it the phone's drawer
        // said "No output" for a tool that had output, because a live frame carried
        // no text at all and the row that does only exists once the JSONL is read.
        //
        // Bounded three times over, which is why shipping it here is cheap: the
        // emitter already caps the bus event at 2000 characters
        // (claude-code-session.ts), `toolResultPreview` clips to 700 plus an
        // ellipsis, and it masks the excerpt with the same rule the history row
        // uses. The FULL text still never rides this channel: it is only reachable
        // through the row's `detailRef` read.
        const resultPreview = toolResultPreview(d.result)
        emitSse(conversationId, 'tool-result', {
          toolUseId: d.toolUseId,
          ...(resultPreview ? { resultPreview } : {}),
        })
        return
      }
      default:
        return
    }
  }, {
    global: true,
    interest: [
      EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_THINKING_DELTA,
      EventNames.SESSION_TOOL_USE, EventNames.SESSION_TOOL_RESULT,
    ],
  })

  try {
    const { sessionId, resultText } = await runLaneTurn(agentId, conversationId, message, {
      source: 'api-v1',
      onSessionId: (sid) => { laneSessionId = sid },
    })

    // The turn is over: hand the client the reasoning tail BEFORE any terminal
    // frame, then stop relaying (see `turnSettled`).
    flushThinking()
    turnSettled = true

    if (resultText === null) {
      // runLaneTurn degrades instead of rejecting: null is a timeout, a
      // session:error, or a failed send. All three are "this turn has no answer",
      // which the client must be told about or its composer stays locked.
      const errMsg = 'The main AI did not answer this turn (timed out or errored).'
      log.web.error('api-v1 lane turn failed', { conversationId, turnId, agentId, sessionId })
      await persistAndEmitTurnError(agentId, conversationId, errMsg)
      return
    }

    // Persist the answer as an ORDINARY assistant message. Deliberate duplication
    // with the lane session's own transcript: mobile has no session-stream
    // surface, so GET /messages is the only place the phone can read the answer
    // back after a reload.
    await chatHistory.addAIMessages(
      [{ role: 'assistant', content: [{ type: 'text', text: resultText }] }] as MessageParam[],
      // Stamp WHICH lane answered. The catch-up detector reads this to tell a turn
      // this lane never saw from one of its own, and it is the only provenance
      // that survives on disk.
      {
        agentId,
        conversationId,
        ...(laneSessionId ? { engine: chatHistory.laneEngineLabel(laneSessionId) } : {}),
      },
    )

    // Strip entity refs so the frame's text matches GET /messages byte-wise.
    // A client that dedups its provisional bubble against canonical rows
    // breaks when the two texts differ (2026-08-23: an SSE ring replay after
    // reconnect re-materialized the previous reply as a permanent duplicate).
    emitSse(conversationId, 'message-end', { turnId, fullText: stripEntityRefs(resultText) })
    // source:'session' marks a lane turn: the context inspector must not refetch
    // per-turn stats the lane never fed.
    broadcastEvent(EventNames.AGENT_RESPONSE, { text: resultText, agentId, conversationId, source: 'session' })
    log.web.info('api-v1 lane turn completed', {
      conversationId, turnId, agentId, sessionId, resultLength: resultText.length,
    })
  } catch (err) {
    // getOrCreateLaneSession can still throw (no config, record write failure) —
    // without this the client would only learn of it from its own watchdog.
    flushThinking()
    turnSettled = true
    const errMsg = err instanceof Error ? err.message : String(err)
    log.web.error('api-v1 lane turn error', { conversationId, turnId, agentId, error: errMsg })
    await persistAndEmitTurnError(agentId, conversationId, errMsg)
  } finally {
    // Discard, never emit: by here the terminal frame is already out (see
    // `turnSettled`). Clearing the timer matters on its own — a pending one would
    // otherwise keep a reference to this closure past the turn.
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null }
    thinkingBuf = ''
    bus.unsubscribe(subName)
  }
}

/**
 * Run one REST-initiated turn. Mirrors the canonical WS chat flow
 * (src/web/routes/chat.ts) minus web-only extras: enqueue → eager-persist user
 * msg → deliver into the conversation's lane session → persist the answer.
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
    let userContent: string | unknown[]
    let savedImages: Array<{ filePath: string; filename: string; mediaType: string }>
    // Everything from here to `message-start` is the PRELUDE, and it needs its own
    // catch. It used to have none, so a throw in any of it — a lazy import, the
    // image rewrite, the eager persist itself — escaped the queue callback
    // entirely: the error handler never ran, and the user's message was simply
    // GONE (the conversation file left at `entries: []`) while the phone showed
    // its own bubble plus an error it could not retry. Observed 2026-08-27 23:03
    // on a relayed turn.
    try {
    // Build the user content: images (if any) become base64 content blocks
    // followed by a text block prefixed with the <attached-images> annotation.
    // Persist the path-based form so chat-history.json stays small (base64 →
    // { type:'image', path } refs).
    savedImages = imageData?.savedImages ?? []
    const imageContentBlocks = imageData?.imageContentBlocks ?? null
    userContent = text
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
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.web.error('api-v1 turn failed before it started', {
        conversationId, turnId, agentId, error: errMsg,
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      })
      // `rescue` writes the user's text, since the persist above is exactly what
      // may not have run. `message-start` was never emitted, so the client sees
      // one terminal `error` frame — enough to unlock its composer.
      await persistAndEmitTurnError(agentId, conversationId, errMsg, { text, turnId })
      return
    }

    emitSse(conversationId, 'message-start', { turnId })

    // The turn runs in the conversation's lane session. EVERY console agent rides
    // it (per-agent persona via consoleAgentProfile — see
    // personal-ai-lane.resolveLane), mirroring chat.ts. The POST handler's
    // `activeTurns` entry is released in its `.finally()`, i.e. when the promise
    // this callback belongs to settles: awaiting the lane turn here means the 409
    // guard covers it for its whole duration, with no second bookkeeping path to
    // keep in sync.
    //
    // The CLI takes plain text on stdin, not content blocks — images ride as
    // readable file paths (the shape session chat uses), never base64.
    const sessionMessage = savedImages.length > 0
      ? buildSessionImageContext(savedImages) + text
      : text
    await runApiV1LaneTurn(agentId, conversationId, sessionMessage, turnId)
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

// The calendar date pair (start_date/end_date) shares ONE gate across POST and
// PATCH: an ISO-8601 value passes isValidIsoDate, and '' or null is the explicit
// "no value" marker. '' mirrors due_date's established clear input; null is
// accepted too because a calendar client that models "no date" as null would
// otherwise get a 400 it can't act on. due_date's own gate is deliberately
// untouched (frozen contract) — it keeps rejecting null.
function isClearMarker(v: unknown): boolean {
  return v === '' || v === null
}
/** Exported for the validation-matrix unit test (tests/web/routes/api-v1-task-dates.test.ts). */
export function isDateFieldValid(v: unknown): boolean {
  return isClearMarker(v) || (typeof v === 'string' && isValidIsoDate(v))
}
/** Clear markers normalize to '', the clear input updateTask/addTask understand. */
function normalizeDateField(v: unknown): string {
  return isClearMarker(v) ? '' : (v as string)
}

/**
 * Coherence of the working block, checked against the EFFECTIVE final state
 * (request values overlaid on the stored row) rather than the request alone.
 * end_date is the END of a start_date block, so two shapes are junk and get a
 * 400: an end with no start (PATCH end_date onto a task with no start_date),
 * and an end that precedes its start. Returns the error message or null.
 */
export function validateDateWindow(start: string | undefined, end: string | undefined): string | null {
  if (!end) return null
  if (!start) return 'end_date requires a start_date (it is the end of a start_date working block)'
  if (Date.parse(end) < Date.parse(start)) return 'end_date must be greater than or equal to start_date'
  return null
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
    // Additive working-set filters — same semantics as GET /api/tasks:
    // pinned equality; focus_tier matches pinned rows only, with 'satellite'
    // meaning "pinned with no stored tier"; working_set = the whole pinned
    // board sorted by pin_order.
    if (typeof req.query.pinned === 'string' && req.query.pinned) {
      if (req.query.pinned !== 'true' && req.query.pinned !== 'false') {
        sendError(res, 400, 'bad_request', 'pinned must be "true" or "false"')
        return
      }
      const want = req.query.pinned === 'true'
      tasks = tasks.filter((t) => Boolean(t.pinned) === want)
    }
    if (typeof req.query.focus_tier === 'string' && req.query.focus_tier) {
      const tiers = req.query.focus_tier.split(',').map((s) => s.trim()).filter(Boolean)
      // Shared predicate with GET /api/tasks (focusTierMatches in
      // task-query.ts) so the two surfaces can't drift on what 'satellite'
      // means. The projection carries the registered custom tiers.
      const customTierIds = new Set((projection.custom_tiers ?? []).map((c) => c.id))
      tasks = tasks.filter((t) =>
        Boolean(t.pinned) && focusTierMatches(t.focus_tier, tiers, customTierIds))
    }
    if (typeof req.query.working_set === 'string' && req.query.working_set) {
      if (req.query.working_set !== 'true' && req.query.working_set !== 'false') {
        sendError(res, 400, 'bad_request', 'working_set must be "true" or "false"')
        return
      }
      if (req.query.working_set === 'true') {
        // Mirror GET /api/tasks: working_set IS pinned=true, so an explicit
        // pinned=false alongside it is a caller bug, not a filter to override.
        if (req.query.pinned === 'false') {
          sendError(res, 400, 'bad_request', 'working_set implies pinned=true and cannot combine with pinned=false')
          return
        }
        tasks = tasks
          .filter((t) => t.pinned)
          .sort((a, b) => (typeof a.pin_order === 'number' ? a.pin_order : Number.POSITIVE_INFINITY)
            - (typeof b.pin_order === 'number' ? b.pin_order : Number.POSITIVE_INFINITY))
      }
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
    const { title, project, priority, due_date: dueDate, start_date: startDate,
      end_date: endDate, description, pinned, focus_tier: focusTier } = (req.body ?? {}) as {
      title?: unknown
      project?: unknown
      priority?: unknown
      due_date?: unknown
      start_date?: unknown
      end_date?: unknown
      description?: unknown
      pinned?: unknown
      focus_tier?: unknown
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
    // Calendar dates (additive, 2026-08): the pair that gives a task a block on
    // the calendar surfaces. '' / null are accepted as "not set" so a client can
    // send the whole shape unconditionally.
    if (startDate !== undefined && !isDateFieldValid(startDate)) {
      sendError(res, 400, 'bad_request', 'start_date must be an ISO-8601 date string (YYYY-MM-DD or full datetime), or "" / null for none')
      return
    }
    if (endDate !== undefined && !isDateFieldValid(endDate)) {
      sendError(res, 400, 'bad_request', 'end_date must be an ISO-8601 date string (YYYY-MM-DD or full datetime), or "" / null for none')
      return
    }
    const windowError = validateDateWindow(
      startDate === undefined ? undefined : normalizeDateField(startDate) || undefined,
      endDate === undefined ? undefined : normalizeDateField(endDate) || undefined,
    )
    if (windowError) {
      sendError(res, 400, 'bad_request', windowError)
      return
    }
    if (description !== undefined && typeof description !== 'string') {
      sendError(res, 400, 'bad_request', 'description must be a string')
      return
    }
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      sendError(res, 400, 'bad_request', 'pinned must be a boolean')
      return
    }
    // focus_tier (additive, 2026-08): which pin tier the task is BORN into, in
    // the same store write as the pin. Built-ins 'focus' | 'satellite' |
    // 'backlog' | 'wait', or a registered custom tier id ('ct_*'); '' means
    // "not specified". addTask (resolveNewTaskTier) owns the value rules — an
    // unknown tier is a 400, never a silent Satellite fall-through, and
    // 'satellite' normalizes to pinned-with-no-stored-tier.
    // null joins '' as "not specified" so a client can send its whole create
    // shape unconditionally (same tolerance the date fields have).
    if (focusTier !== undefined && focusTier !== null && typeof focusTier !== 'string') {
      sendError(res, 400, 'bad_request', 'focus_tier must be a string ("" / null = not specified)')
      return
    }

    const { addTask, newTaskPinDefault, ProjectSourceConflictError, InvalidFocusTierError } =
      await import('../../core/task-manager.js')
    const { projectTask } = await import('../../core/task-projection.js')
    try {
      // asyncPush like the web create path: the client renders the task
      // immediately, so don't block the response on an external sync push.
      const { task } = await addTask({
        title: title.trim(),
        ...(project !== undefined ? { project } : {}),
        ...(priority !== undefined ? { priority: priority as TaskPriority } : {}),
        ...(dueDate !== undefined ? { due_date: dueDate } : {}),
        // addTask drops falsy dates, so a clear marker on CREATE is simply "no
        // date" — no need for a separate branch.
        ...(startDate !== undefined ? { start_date: normalizeDateField(startDate) } : {}),
        ...(endDate !== undefined ? { end_date: normalizeDateField(endDate) } : {}),
        ...(description !== undefined ? { description } : {}),
        // Human/AI create surface (phone Quick Add, `walnut add`, the
        // task_create op) — lands on the board in Satellite unless the caller
        // passed an explicit `pinned`. See newTaskPinDefault.
        pinned: newTaskPinDefault(pinned),
        ...(typeof focusTier === 'string' ? { focus_tier: focusTier } : {}),
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
      if (err instanceof InvalidFocusTierError) {
        sendError(res, 400, 'bad_request', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/tasks/:id — update task fields from mobile (additive).
// Allowed fields: { status?, priority?, due_date?, start_date?, end_date?,
// project?, title?, description?, tags?, unread? }.
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
    const { status, phase, priority, due_date: dueDate, start_date: startDate, end_date: endDateRaw,
      project, title, description, tags,
      unread } = (req.body ?? {}) as {
      status?: unknown
      phase?: unknown
      priority?: unknown
      due_date?: unknown
      start_date?: unknown
      end_date?: unknown
      project?: unknown
      title?: unknown
      description?: unknown
      tags?: unknown
      unread?: unknown
    }
    // Reassignable: clearing start_date cascades an end_date clear (below).
    let endDate = endDateRaw

    if (status !== undefined && !(typeof status === 'string' && V1_TASK_STATUSES.has(status))) {
      sendError(res, 400, 'bad_request', 'status must be one of: todo, in_progress, done')
      return
    }
    if (phase !== undefined && !(typeof phase === 'string' && VALID_PHASES.has(phase))) {
      sendError(res, 400, 'bad_request', `phase must be one of: ${[...VALID_PHASES].join(', ')}`)
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
    // and tags (full replace — mirrors updateTask's set_tags). end_date joined
    // in 2026-08 for the calendar surfaces; both accept null as a clear marker
    // alongside '' (see isClearMarker). Cross-field coherence (end needs a
    // start, end >= start) is checked below against the EFFECTIVE row, since a
    // PATCH may set only one half of the pair.
    if (startDate !== undefined && !isDateFieldValid(startDate)) {
      sendError(res, 400, 'bad_request', 'start_date must be an ISO-8601 date string (YYYY-MM-DD or full datetime), or "" / null to clear')
      return
    }
    if (endDate !== undefined && !isDateFieldValid(endDate)) {
      sendError(res, 400, 'bad_request', 'end_date must be an ISO-8601 date string (YYYY-MM-DD or full datetime), or "" / null to clear')
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
        && startDate === undefined && endDate === undefined && project === undefined && title === undefined
        && description === undefined && tags === undefined && unread === undefined) {
      sendError(res, 400, 'bad_request', 'at least one updatable field is required (status/phase/priority/due_date/start_date/end_date/project/title/description/tags/unread)')
      return
    }

    const tm = await import('../../core/task-manager.js')
    const { projectTask } = await import('../../core/task-projection.js')
    // Window coherence on the EFFECTIVE row: a PATCH touching one half of the
    // pair must be judged against the stored other half, otherwise
    // `{ end_date: <before the stored start> }` would sail through. Only read
    // the row when a date field is actually in play (one extra read on a
    // date PATCH, none on any other). A resolution failure here is left to the
    // mutation below, which owns the 404/400-ambiguous mapping.
    if (startDate !== undefined || endDate !== undefined) {
      const current = await tm.getTask(id).catch(() => undefined)
      if (current) {
        const effectiveStart = startDate !== undefined
          ? (normalizeDateField(startDate) || undefined) : current.start_date
        const effectiveEnd = endDate !== undefined
          ? (normalizeDateField(endDate) || undefined) : current.end_date
        // Clearing the start also clears a now-orphaned end (rather than 400ing
        // a legitimate "remove this task from the calendar" intent).
        if (startDate !== undefined && !effectiveStart && effectiveEnd && endDate === undefined) {
          endDate = ''
        } else {
          const windowError = validateDateWindow(effectiveStart, effectiveEnd)
          if (windowError) {
            sendError(res, 400, 'bad_request', windowError)
            return
          }
        }
      }
    }
    try {
      let updated
      const patch = {
        ...(status !== undefined ? { status: status as import('../../core/types.js').TaskStatus } : {}),
        ...(phase !== undefined ? { phase: phase as TaskPhase } : {}),
        ...(priority !== undefined ? { priority: priority as TaskPriority } : {}),
        ...(dueDate !== undefined ? { due_date: dueDate as string } : {}),
        // updateTask treats '' as the clear, so a null marker rides as ''.
        ...(startDate !== undefined ? { start_date: normalizeDateField(startDate) } : {}),
        ...(endDate !== undefined ? { end_date: normalizeDateField(endDate) } : {}),
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
        const result = await tm.updateTask(id, patch, { source: 'api', extraTargets: ['main-agent'], asyncPush: true })
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

/** How far GET /sessions looks, nearest ring first. */
type SessionScope = 'folder' | 'project' | 'all'

/** One string field off a projected row, whichever half of the cloud union it
 *  came from (own rows are untyped records). '' = absent. */
function rowField(row: unknown, key: string): string {
  const v = (row as Record<string, unknown> | null | undefined)?.[key]
  return typeof v === 'string' ? v : ''
}

/**
 * Where the CALLING session stands, as one projected row (`you`).
 *
 * The caller is normally in its own list, so the cheap answer is a lookup. It is
 * not always: a lane-bound conversation session, an environment session
 * (triage/cron/hook) and a row a projection budget dropped are all real callers
 * that the list itself excludes, and telling one of them "you are nowhere" would
 * make the folder/project rings unusable from exactly the sessions that want
 * them. The registry still knows, so fall back to it — on the primary only, since
 * a cloud replica has no session registry to consult.
 */
async function resolveCallerSessionRow(
  sid: string,
  rows: ReadonlyArray<{ id: string }>,
): Promise<Record<string, unknown> | null> {
  const listed = rows.find((r) => r.id === sid)
  if (listed) return listed as unknown as Record<string, unknown>
  if (CLOUD_MODE) return null
  const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
  const caller = await resolveCaller(sid).catch(() => null)
  if (caller?.kind !== 'session') return null
  const { projectSession } = await import('../../core/session-projection.js')
  const { getTask, listFolderLabels } = await import('../../core/task-manager.js')
  const task = caller.record.taskId
    ? await getTask(caller.record.taskId).catch(() => undefined)
    : undefined
  const labels = await listFolderLabels().catch(() => new Map<string, string>())
  return projectSession(caller.record, task, labels) as unknown as Record<string, unknown>
}

// GET /api/v1/sessions — slim session list for mobile (read-only, additive).
// Same projection pattern as /tasks: primary refreshes inline, cloud serves
// the git-synced sessions/projection.json. Opening/steering a session from
// the companion is Phase 2 (reverse-WS bridge to the primary).
//
// `scope` + `you` (additive 2026-09-10) answer "which sessions are NEAR me".
// An agent that cannot find the session it should talk to reaches for its
// harness's own cross-session messaging instead, so the list has to be able to
// narrow itself: `scope=folder` is the sessions whose task sits in the caller's
// folder, `scope=project` the same project, `all` (the default, so every
// existing client is untouched) the whole list. The caller is identified by the
// `x-walnut-caller-sid` header the ops executor stamps from WALNUT_SESSION_ID.
apiV1Router.get('/sessions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { readSessionProjection, exportSessionProjection } = await import('../../core/session-projection.js')
    if (!CLOUD_MODE) {
      await exportSessionProjection().catch(() => { /* serve last good file below */ })
    }
    const projection = await readSessionProjection()
    // Sessions THIS cloud box owns (cloud.exec) never enter the Mac-authored
    // projection — the exporter is primary-only and that file must keep exactly
    // ONE writer (no content clock: two writers would let git-sync's commit-time
    // LWW replace the whole list). So the union happens HERE, at read time,
    // on the box that holds both halves. Own rows are re-tagged to the cloud host
    // alias by unionOwnedSessions: their stored host is '', which downstream
    // means "the primary box" and would route their sends to the wrong machine.
    let ownRows: Array<Record<string, unknown> & { id: string }> = []
    if (CLOUD_MODE) {
      try {
        const { cloudExecActive } = await import('../../core/cloud-owned-session.js')
        if (await cloudExecActive()) {
          const { buildSessionProjection } = await import('../../core/session-projection.js')
          ownRows = (await buildSessionProjection()).sessions as unknown as typeof ownRows
        }
      } catch (err) {
        // A failed own-session read degrades to the projection-only list rather
        // than 500ing a read-only endpoint the phone polls.
        log.web.warn('cloud exec: own session list unavailable', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (!projection && ownRows.length === 0) {
      sendError(res, 503, 'unavailable', 'Session projection not synced yet')
      return
    }
    const { unionOwnedSessions } = await import('../../core/cloud-exec.js')
    const all = unionOwnedSessions(projection?.sessions ?? [], ownRows)

    const asked = typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : 'all'
    if (asked !== 'all' && asked !== 'project' && asked !== 'folder') {
      sendError(res, 400, 'bad_request', `Unknown scope "${asked}": use folder, project, or all`)
      return
    }
    // Resolved against the UNFILTERED list: `you` is orientation, not a result
    // row, so a `status` the caller itself does not match must not erase it.
    const rawSid = req.headers['x-walnut-caller-sid']
    const callerSid = (Array.isArray(rawSid) ? rawSid[0] : rawSid ?? '').trim()
    const you = callerSid ? await resolveCallerSessionRow(callerSid, all) : null

    let sessions = all
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    if (status) sessions = sessions.filter((s) => (s as { process_status?: string }).process_status === status)
    if (asked !== 'all' && !you) {
      // A caller Walnut cannot place gets an error, never a silently unfiltered
      // list: "here is everything" read as "here is your folder" is the confident
      // wrong answer this feature exists to remove.
      sendError(res, 400, 'bad_request',
        `scope=${asked} needs a session caller: this request carries no session id Walnut recognises `
        + '(x-walnut-caller-sid), so there is no folder or project to measure from. Call it with scope=all.')
      return
    }
    // A caller whose task sits in no folder has nothing narrower than its
    // project, so the folder ring degrades to the project one instead of
    // answering "no sessions" to a question that had an answer. `scope` in the
    // response is therefore the ring actually APPLIED, not the one asked for.
    const youGroup = rowField(you, 'group_id')
    const scope: SessionScope = asked === 'folder' && !youGroup ? 'project' : asked
    if (you && scope !== 'all') {
      const youProject = rowField(you, 'project').toLowerCase()
      sessions = sessions.filter((s) => scope === 'folder'
        ? rowField(s, 'group_id') === youGroup
        : rowField(s, 'project').toLowerCase() === youProject)
    }
    res.json({
      sessions,
      ...(you ? { you } : {}),
      scope,
      syncedAt: projection?.exportedAt ?? new Date().toISOString(),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/sessions/:id/transcript?fresh=1&rich=1 — the "open session"
// payload: a slim transcript tail. Default: the sweep-exported file (synced to
// the cloud companion). `fresh=1` (additive) makes the PRIMARY box read the
// session's history right now — this powers the mobile live session view, which
// polls with fresh=1 while open; sweeps alone are 60s-throttled. Cloud boxes
// have no disk/SSH access to sessions and always serve the synced file.
//
// `rich=1` (additive) adds the expanded-card fields (`inputPreview`,
// `thinkingText`, `detailRef`) to the rows. The sweep and the bridge push stay
// slim because neither passes the option; `rich` gates only those fields, so it
// can never move the tail slice, the clip, or `truncated`.
//
// A RICH REQUEST IS NEVER ANSWERED WITH SLIM ROWS. That is a fix, not a
// simplification, and the version it replaces is worth stating because the
// reasoning sounded right: `rich=1` used to decorate only a tail this route
// BUILT, so a request that hit the sweep-exported file answered without the
// fields — the sweep writes the slim shape and cannot carry them. Measured on a
// live box, the same URL modulo `fresh` answered `?rich=1` with 0 of 102 rows
// carrying `thinkingText` and `?fresh=1&rich=1` with 39 of 106. Whether a
// client's drawer had any content at all therefore depended on cache warmth,
// which is not a behaviour anyone can code against: it sent a careful reviewer
// off to file two defects about fields the primary "does not produce".
//
// So on the primary, `rich=1` implies the same live build `fresh=1` does. What
// that costs, exactly: the phone never asks for one, because it drops `rich`
// unless it is already sending `fresh` (WalnutAPI.sessionTranscriptPath) — its
// two-phase open still opens on a plain disk read. And the build itself is 3.1ms
// p50 under the reader's 4 MB ceiling; the real cost is a remote session's daemon
// read, which `fresh=1` was already paying on the very next call.
//
// Two paths still cannot produce the fields — a build that throws (unreachable
// session, so the exported file is served instead) and a cloud replica, whose
// bridge builder is a separate slim implementation. Neither may lie about it, so
// the response carries `rich: true|false` saying whether these rows actually have
// the fields. A client reads that instead of inferring from cache warmth.
apiV1Router.get('/sessions/:id/transcript', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { readSessionTranscript, exportSessionTranscripts, buildSessionTranscript } = await import('../../core/session-projection.js')
    const sessionId = paramStr(req.params.id)
    const wantFresh = req.query.fresh === '1'
    const wantRich = req.query.rich === '1'
    // Passed to BOTH inline builds below, so a tail is never rich on one path and
    // slim on the other. `{ rich: false }` is byte-for-byte the bare
    // buildSessionTranscript(sessionId) both sites called before: `rich` gates
    // only the two fields, never the tail slice, the clip, or `truncated`.
    //
    // ONE build per request, and that is load-bearing rather than tidy. The first
    // version of this route got the fields by ALSO building with `{ full: true }`
    // and harvesting from it, because `full` was the only flag that produced them.
    // Measured end to end over HTTP (n=40, real session JSONLs): fine under the
    // reader's 4 MB ceiling (3.1 → 5.2 ms p50, zero extra reads — the mtime parse
    // cache serves the second call), but OVER it the reads double (19.9 → 29.7 ms
    // p50, 3.99 → 7.98 MiB per request) because readSessionHistoryTailWindow
    // deliberately writes no cache entry. Those are DAEMON reads, so on a remote
    // whale it shipped the same 4 MB across the tunnel twice per phone refetch.
    // `rich` exists so this route never has to do that; keep it at one build.
    const buildOpts = { rich: wantRich }
    // Same safe-id alphabet readSessionTranscript enforces (ids land in filenames).
    const safeId = /^[A-Za-z0-9_-]+$/.test(sessionId)
    /**
     * Answer, saying whether these rows carry the rich fields.
     *
     * The flag rides ONLY a rich request, which keeps the default answer
     * byte-for-byte what the bare builder produces (a property this route's tests
     * pin, and the thing that makes the sweep, the bridge push and this read one
     * shape). A client that did not ask has nothing to learn from it.
     */
    const answer = (body: object, rich: boolean): void => {
      res.json(wantRich ? { ...body, rich } : body)
    }
    // Just-created session (record seeded, CLI not spawned yet — no pid, no
    // outputFile): there is nothing to read, so answer 200-empty immediately.
    // Without this, the non-fresh read 404s AND triggers a pointless full
    // transcript sweep (~350ms), and fresh=1 burns ~400ms scanning for a JSONL
    // that doesn't exist — the mobile app polls this exact window right after
    // POST /sessions. The predicate (and the reasoning behind each of its
    // conditions) lives in isPreSpawnSession, shared with the lane read above.
    // NOT gated to primary-only by accident: CLOUD_MODE replicas have no session
    // DB to consult and can't create sessions, so the window doesn't exist there.
    if (!CLOUD_MODE && safeId) {
      const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
      const record = await getSessionByClaudeId(sessionId)
      if (record && isPreSpawnSession(record)) {
        // Keep this shape in sync with buildSessionTranscript's SessionTranscript
        // output — the iOS client decodes it strictly. `rich: true` on an empty
        // list is not a claim about fields; it says no row is missing them.
        answer({ version: 1, sessionId, exportedAt: new Date().toISOString(), truncated: false, messages: [] }, true)
        return
      }
    }
    // `fresh=1` ASKS for a live read; `rich=1` NEEDS one, because the exported file
    // is written in the slim shape and can never carry the fields. Answering a rich
    // request from it is what made the response depend on cache warmth.
    if ((wantFresh || wantRich) && !CLOUD_MODE && safeId) {
      try {
        const built = await buildSessionTranscript(sessionId, buildOpts)
        // A rich request must never cost the caller the ARCHIVE. The builder answers
        // an EMPTY transcript rather than throwing for a session it cannot read (a
        // stopped one whose JSONL is gone), and for those the exported file is the
        // only copy of the conversation left. `fresh=1` keeps its existing meaning —
        // the caller asked for live, and empty is live — but the build that `rich=1`
        // implies falls through to the file, which then answers `rich: false`.
        if (wantFresh || built.messages.length > 0) {
          answer(built, wantRich)
          return
        }
      } catch { /* unreachable session — fall back to the exported file */ }
    }
    if (wantFresh && CLOUD_MODE && safeId) {
      // Cloud fresh path: read the live jsonl over the daemon bridge. Falls
      // back to the git-synced file on any failure (bridge down, unknown sid).
      try {
        const { buildTranscriptViaBridge } = await import('./session-stream-v1.js')
        const viaBridge = await buildTranscriptViaBridge(sessionId)
        if (viaBridge) {
          // A replica's bridge builder is a separate slim implementation, so a rich
          // request gets a truthful `rich: false` here rather than a silent slim
          // answer. The row's `detailRef` is what the drawer falls back to (the
          // detail read relays to the primary), and absent that, the excerpt.
          answer(viaBridge, false)
          return
        }
      } catch { /* fall back to the exported file */ }
    }
    let transcript = await readSessionTranscript(sessionId)
    /** The sweep file is slim by definition; only an inline build can be rich. */
    let builtRich = false
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
          transcript = await buildSessionTranscript(sessionId, buildOpts)
          builtRich = wantRich
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
        answer({ version: 1, sessionId, exportedAt: new Date().toISOString(), truncated: false, messages: [] }, true)
        return
      }
    }
    if (!transcript) {
      sendError(res, 404, 'not_found', `No transcript for session: ${sessionId}`)
      return
    }
    answer(transcript, builtRich)
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/v1/activity/detail?ref=…&part=…&offset=… (additive) ───────────
//
// The whole text behind ONE expanded `kind:'tool'` / `kind:'thinking'` row, on
// demand. The rows themselves stay excerpts on both list reads
// (`/sessions/:id/transcript`, `/conversations/:id/messages`) because they ride a
// ~100-row page a phone refetches at every turn end — inlining full reasoning
// blocks measured ~150KB per read, per turn, over cellular. A drawer that opens
// to "see everything" is one tap, once, so it fetches instead.
//
// `ref` is the row's own `detailRef` and nothing else: it names a session, a
// message id, and the slot inside that message (core/activity-detail.ts explains
// why those three survive a re-read and why a row's position does not). No agent
// or conversation id is needed, which is what lets ONE route serve both surfaces.
//
// Degradation, in the order a client meets them, and one of them is deliberately
// NOT a 404: `410 detail_gone` says the row can no longer be resolved (rewound,
// compacted, or aged out of a whale's bounded read window). 404 on this path can
// only mean "this server has no such route", i.e. a box older than this feature —
// and those two need different client behaviour (hide the affordance vs. tell the
// user the text is gone), which a shared 404 would make indistinguishable, since an
// unknown route answers 404 with a DIFFERENT body shape nobody should have to sniff.
// The rest: 400 for a ref this box did not mint, 503 when the source could not be
// read in time. All of them leave the client on the excerpt it already has.
//
// THIS ROUTE NEVER ANSWERS 404. Keep it that way.
const ACTIVITY_DETAIL_DEADLINE_MS = 10_000
/** The read can cross the bridge to the primary; give it the local budget + slack. */
const ACTIVITY_DETAIL_RELAY_TIMEOUT_MS = ACTIVITY_DETAIL_DEADLINE_MS + 5_000

/** Query → resolver options, or an error message for a 400. */
function parseActivityDetailQuery(
  query: Request['query'],
): { part?: 'reasoning' | 'input' | 'result'; offset: number } | string {
  const partRaw = typeof query.part === 'string' ? query.part : ''
  if (partRaw && partRaw !== 'reasoning' && partRaw !== 'input' && partRaw !== 'result') {
    return `Unknown part: ${partRaw} (expected reasoning, input or result)`
  }
  const part = partRaw ? partRaw as 'reasoning' | 'input' | 'result' : undefined
  if (query.offset === undefined) return { ...(part ? { part } : {}), offset: 0 }
  const offset = Number(query.offset)
  if (!Number.isSafeInteger(offset) || offset < 0) return 'offset must be a non-negative integer'
  // A paging read must say WHICH section it is paging: the same offset means a
  // different place in a tool row's input than in its result, and answering both
  // from one cursor would silently interleave two streams.
  if (!part) return 'offset requires part=reasoning|input|result'
  return { part, offset }
}

apiV1Router.get('/activity/detail', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { parseActivityRef, resolveActivityDetail } = await import('../../core/activity-detail.js')
    const ref = parseActivityRef(typeof req.query.ref === 'string' ? req.query.ref : '')
    if (!ref) {
      sendError(res, 400, 'bad_request', 'ref must be a row detailRef minted by this server')
      return
    }
    const opts = parseActivityDetailQuery(req.query)
    if (typeof opts === 'string') {
      sendError(res, 400, 'bad_request', opts)
      return
    }
    if (CLOUD_MODE) {
      // A replica has no session record and no way to reach the JSONL, exactly as
      // for the lane message read — so it relays rather than inventing an answer.
      // An older primary that does not know the action answers needs_upgrade,
      // which lands here as 503: retryable, and the client keeps its excerpt.
      const { callPrimaryControl } = await import('./v1-control-relay.js')
      const outcome = await callPrimaryControl(
        'server.activity.detail', '__server__',
        { ref: typeof req.query.ref === 'string' ? req.query.ref : '', ...opts },
        ACTIVITY_DETAIL_RELAY_TIMEOUT_MS,
      )
      if (!outcome.ok) {
        sendError(res, 503, 'unavailable', `The primary could not be reached: ${outcome.failure.kind}`)
        return
      }
      if (outcome.result.found !== true) {
        sendError(res, 410, 'detail_gone', 'This row is no longer in the session transcript')
        return
      }
      res.json(outcome.result.detail)
      return
    }
    const bail = deadline(ACTIVITY_DETAIL_DEADLINE_MS)
    try {
      // A read that THROWS is a reachability failure, not a server fault: the host is
      // unknown or its daemon is down, and the honest answer is the same 503 a timeout
      // gets (retryable, client keeps its excerpt). A 500 told the client "this server
      // is broken" for a session that is merely unreachable — the errno-as-answer
      // mistake this codebase has a rule against. Logged at error level so a genuine
      // bug in the resolver is still loud for us rather than hidden behind the 503.
      let detail: Awaited<ReturnType<typeof resolveActivityDetail>> | 'timeout' | 'unreadable'
      try {
        detail = await Promise.race([resolveActivityDetail(ref, opts), bail.promise])
      } catch (err) {
        log.web.error('api-v1 activity detail: reading the transcript failed', {
          sessionId: ref.sessionId, msgId: ref.msgId,
          error: err instanceof Error ? err.message : String(err),
        })
        detail = 'unreadable'
      }
      if (detail === 'timeout' || detail === 'unreadable') {
        sendError(res, 503, 'unavailable', detail === 'timeout'
          ? 'Reading the session transcript timed out — try again'
          : 'The session transcript could not be read — try again')
        return
      }
      if (!detail) {
        sendError(res, 410, 'detail_gone', 'This row is no longer in the session transcript')
        return
      }
      res.json(detail)
    } finally {
      bail.cancel()
    }
  } catch (err) {
    next(err)
  }
})

/**
 * PRIMARY side of `server.activity.detail` — the same resolve the local route
 * does, so the two boxes can never answer one drawer differently.
 *
 * `found: false` rather than a thrown error: a missing row is an ordinary outcome
 * (the transcript was rewound or compacted) and the replica has to tell it apart
 * from "the relay failed", which is the difference between the client dropping the
 * fetch and retrying it.
 */
export async function handlePrimaryActivityDetailRelay(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { parseActivityRef, resolveActivityDetail } = await import('../../core/activity-detail.js')
  const ref = parseActivityRef(typeof params.ref === 'string' ? params.ref : '')
  if (!ref) return { found: false }
  const part = params.part === 'reasoning' || params.part === 'input' || params.part === 'result'
    ? params.part
    : undefined
  const offset = Number.isSafeInteger(params.offset) && (params.offset as number) >= 0
    ? params.offset as number
    : 0
  const detail = await resolveActivityDetail(ref, { ...(part ? { part } : {}), offset })
  return detail ? { found: true, detail: detail as unknown as Record<string, unknown> } : { found: false }
}

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

// ─── Human inbox (letters from agents to the human) ────────────────────────
// Its own router file, mounted here rather than in server.ts: the whole
// /api/v1/human-inbox family is one feature, and this keeps the mount next to
// the rest of the v1 surface it is additive to.

import { humanInboxV1Router } from './human-inbox-v1.js'

apiV1Router.use(humanInboxV1Router)

// ─── Action cards (one clicked registry op) ────────────────────────────────
// Same reason as above: /api/v1/actions/* is one feature, mounted next to the
// v1 surface it is additive to.

import { actionsV1Router } from './actions-v1.js'

apiV1Router.use(actionsV1Router)

// ─── Time tracking (the phone banks human time into the shared store) ──────
// Same reason as above, plus one of its own: it must sit behind the SAME device
// auth as the rest of /api/v1, and mounting it here makes that structural.

import { timeV1Router } from './time-v1.js'

apiV1Router.use(timeV1Router)

// ─── Router-level error handler: frozen error shape ────────────────────────

apiV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err)
  log.web.error('api-v1 unhandled error', { error: message })
  if (res.headersSent) { res.end(); return }
  sendError(res, 500, 'internal', message)
})
