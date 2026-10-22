/**
 * The `conversation-bodies` copy kind (stage 3e of
 * docs/plan/walnut-companion-unified-replica.md): each recent conversation's messages
 * as the phone reads them, for the cloud companion, whose away read of one
 * conversation (`GET /api/v1/conversations/:id/messages` when the Mac does not answer)
 * otherwise has only the chat history git sync wrote, which is empty for a chat that
 * runs in a lane (its turns are in the lane's CLI transcript on the Mac).
 *
 * One row per conversation (`<agent segment>/<conversation id>`): the Mac's whole list
 * as `server.chat.messages` pages it (web/routes/api-v1.ts conversationMessagesForCopy,
 * ids m0 and up), cut to the newest rows that fit CONVERSATION_BODY_MAX_BYTES (`total`
 * keeps the ids right), every text run through the log redactor, and the turn ids of
 * the cloud turns the Mac adopted into it. Stage 4d adds the chat history's compaction
 * summary and the time of the newest turn it covers (`summary`, `summaryAt`), so the
 * companion's chat lane seeds from this copy as it did from git's chat history.
 *
 * Which conversations: per agent, its main one and the CONVERSATION_BODIES_PER_AGENT
 * newest with a message in the last 30 days (the ones a phone opens while the Mac
 * sleeps). Rendering one is the work of one phone read (the lane read included), so it
 * is done again only when the conversation's index row moved (a turn), or every few
 * minutes while it is active (a lane turn writes its answer to the transcript only),
 * at most RENDER_BUDGET per round with the rest in the next round soon after; a row not
 * rendered yet, or whose read failed, rides in `keep` (the companion keeps its copy).
 *
 * On by default for every replica, like every kind (`hosts.<key>.server.copies.
 * conversation_bodies` turns it off for a host). Unordered, no digest.
 */

import { agentIdFromPathSegment } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import { redactSensitiveText } from '../../../logging/redact.js'
import { sha12 } from '../kind.js'
import { onStoreWrite } from '../store-writes.js'
import type { CopyKind } from './copy-kind.js'
import { agentSegmentOk, conversationIdOk, conversationRowKey, readConversationRows } from './conversations.js'

export const CONVERSATION_BODIES_SCHEMA_VERSION = 1
/** Conversations, as the conversations kind counts them. */
export const CONVERSATION_BODIES_REMOVAL_FLOOR = 50
export const CONVERSATION_BODIES_PER_AGENT = 50
export const CONVERSATION_BODIES_MAX_AGE_MS = 30 * 24 * 60 * 60_000
/** One conversation's rows in the copy, as JSON: the newest that fit. */
export const CONVERSATION_BODY_MAX_BYTES = 2 * 1024 * 1024
/** The compaction summary kept in a row, at most (it counts toward the row's size). */
export const CONVERSATION_SUMMARY_MAX_BYTES = 64 * 1024
/** Conversations rendered in one round, and the time they may take; the rest go in the next one. */
export const RENDER_BUDGET = 20
const RENDER_TIME_MS = 3_000
/** A conversation the Mac could not read is tried again after this. */
const FAILED_RETRY_MS = 10 * 60_000
/** A conversation with a message this recent is read again this often, its index row unchanged. */
const ACTIVE_MS = 2 * 60 * 60_000
const ACTIVE_RENDER_EVERY_MS = 2 * 60_000
/** Rendered rows kept for the round's puts, by bytes (the hashes are always kept). */
const KEPT_ROW_BYTES = 32 * 1024 * 1024

/** One message as the copy holds it: the phone's v1 row. */
export type CopiedMessage = Record<string, unknown> & { id: string; role: 'user' | 'assistant'; text: string; createdAt?: string }

export interface ConversationBodyRow {
  agent: string
  id: string
  /** Rows in the Mac's whole list: the copy's first row is `m<total - messages.length>`. */
  total: number
  messages: CopiedMessage[]
  adoptedTurnIds: string[]
  /** 4d: the chat history's compaction summary, and the newest turn time it covers (ISO). */
  summary?: string
  summaryAt?: string
}

/** The compaction summary of a conversation (its text, and the newest turn time it covers). */
export interface ConversationSummary { summary: string; summaryAt?: string }

/** What a render answers: the whole list, or null when the Mac cannot read it now. */
export type RenderConversation = (agentId: string, conversationId: string) => Promise<{ messages: Array<Record<string, unknown>>; adoptedTurnIds: string[]; summary?: ConversationSummary } | null>

/** Fields that carry no text of the user's: never run through the redactor. */
const PLAIN_FIELDS = new Set(['id', 'role', 'createdAt', 'kind', 'source', 'messageId', 'detailRef', 'answeredBy', 'isError', 'inFlight'])

/** A row with every text field run through the log redactor (a pasted key never rests on the box). */
export function redactMessage(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(m)) out[k] = typeof v === 'string' && !PLAIN_FIELDS.has(k) ? redactSensitiveText(v) : v
  return out
}

export function messageOk(m: unknown): m is CopiedMessage {
  const r = m as Partial<CopiedMessage> | null
  return !!r && typeof r === 'object' && typeof r.id === 'string' && /^m\d{1,9}$/.test(r.id)
    && (r.role === 'user' || r.role === 'assistant') && typeof r.text === 'string'
    && (r.createdAt === undefined || typeof r.createdAt === 'string')
}

/** A summary as a row keeps it: redacted and cut to its byte share. */
export function rowSummary(s: ConversationSummary | undefined): Pick<ConversationBodyRow, 'summary' | 'summaryAt'> {
  if (!s || typeof s.summary !== 'string' || !s.summary.trim()) return {}
  let text = redactSensitiveText(s.summary)
  if (Buffer.byteLength(text) > CONVERSATION_SUMMARY_MAX_BYTES) {
    text = Buffer.from(text, 'utf8').subarray(0, CONVERSATION_SUMMARY_MAX_BYTES).toString('utf8').replace(/\uFFFD+$/, '')
  }
  return { summary: text, ...(typeof s.summaryAt === 'string' && s.summaryAt ? { summaryAt: s.summaryAt } : {}) }
}

/** The body row of one whole list: redacted, cut to the newest rows that fit. */
export function bodyRow(agent: string, id: string, all: Array<Record<string, unknown>>, adoptedTurnIds: string[], summary?: ConversationSummary): ConversationBodyRow {
  const kept = rowSummary(summary)
  const messages: CopiedMessage[] = []
  // The summary's bytes come out of the row's budget.
  let bytes = kept.summary ? Buffer.byteLength(kept.summary) : 0
  for (let i = all.length - 1; i >= 0; i--) {
    const m = redactMessage(all[i])
    if (!messageOk(m)) continue
    const size = Buffer.byteLength(JSON.stringify(m)) + 1
    if (bytes + size > CONVERSATION_BODY_MAX_BYTES) break
    bytes += size
    messages.push(m)
  }
  messages.reverse()
  // `total` names the whole list; a row the cut skipped as malformed never shifts the ids.
  const first = messages.length ? Number(messages[0].id.slice(1)) : all.length
  return { agent, id, total: first + messages.length, messages, adoptedTurnIds: [...new Set(adoptedTurnIds)].sort(), ...kept }
}

interface Cached { sig: string; hash: string; renderedAt: number; row?: ConversationBodyRow; bytes: number }
const cache = new Map<string, Cached>()
/** When a conversation's read last failed (the next try waits FAILED_RETRY_MS). */
const failedAt = new Map<string, number>()
let keptBytes = 0
/** Manifest rows hold no messages: their hash and their key, for loadRow. */
const manifestHashes = new WeakMap<object, string>()
const unreadOf = new WeakMap<object, string[]>()
let again: (() => void) | null = null

function keepRow(key: string, c: Cached, row: ConversationBodyRow, bytes: number): void {
  if (c.row) keptBytes -= c.bytes
  c.row = row
  c.bytes = bytes
  keptBytes += bytes
  // The oldest renders give back their rows first; their hashes stay.
  for (const [k, x] of cache) {
    if (keptBytes <= KEPT_ROW_BYTES) break
    if (k === key || !x.row) continue
    keptBytes -= x.bytes
    x.row = undefined
    x.bytes = 0
  }
}

let renderImpl: RenderConversation | null = null
async function render(agentId: string, id: string): ReturnType<RenderConversation> {
  if (renderImpl) return renderImpl(agentId, id)
  const { conversationMessagesForCopy } = await import('../../../web/routes/api-v1.js')
  return conversationMessagesForCopy(agentId, id) as unknown as ReturnType<RenderConversation>
}

/** Render one conversation into the cache. False when the Mac could not read it now. */
async function renderInto(key: string, agent: string, id: string, sig: string): Promise<boolean> {
  let out: Awaited<ReturnType<typeof render>>
  try { out = await render(agentIdFromPathSegment(agent), id) } catch { out = null }
  if (!out) { failedAt.set(key, Date.now()); return false }
  failedAt.delete(key)
  const row = bodyRow(agent, id, out.messages, out.adoptedTurnIds, out.summary)
  const json = JSON.stringify(row)
  const c = cache.get(key) ?? { sig, hash: '', renderedAt: 0, bytes: 0 }
  c.sig = sig
  c.hash = sha12(json)
  c.renderedAt = Date.now()
  cache.set(key, c)
  keepRow(key, c, row, Buffer.byteLength(json))
  return true
}

/** The conversations the copy takes: per agent its main one and the newest recent ones. */
async function chosen(): Promise<Array<{ key: string; agent: string; id: string; sig: string; lastAt: number }>> {
  const rows = await readConversationRows()
  const now = Date.now()
  const byAgent = new Map<string, typeof rows>()
  for (const r of rows) {
    if (!agentSegmentOk(r.agent) || !conversationIdOk(r.meta.id)) continue
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, [])
    byAgent.get(r.agent)!.push(r)
  }
  const out: Array<{ key: string; agent: string; id: string; sig: string; lastAt: number }> = []
  for (const [agent, list] of byAgent) {
    const at = (m: { lastMessageAt: string }): number => Date.parse(m.lastMessageAt) || 0
    const recent = list.filter((r) => now - at(r.meta) <= CONVERSATION_BODIES_MAX_AGE_MS)
      .sort((a, b) => at(b.meta) - at(a.meta)).slice(0, CONVERSATION_BODIES_PER_AGENT)
    const main = list.find((r) => r.meta.isMain)
    if (main && !recent.includes(main)) recent.push(main)
    for (const r of recent) out.push({ key: conversationRowKey(agent, r.meta.id), agent, id: r.meta.id, sig: `${r.meta.lastMessageAt}|${r.meta.messageCount}`, lastAt: at(r.meta) })
  }
  return out
}

/** The Mac's rows for a round: a manifest row per conversation it holds a render of. */
export async function leaderConversationBodies(): Promise<ConversationBodyRow[]> {
  const now = Date.now()
  const want = await chosen()
  const stale = want.filter((w) => {
    if (now - (failedAt.get(w.key) ?? 0) < FAILED_RETRY_MS) return false
    const c = cache.get(w.key)
    return !c || c.sig !== w.sig || (now - w.lastAt <= ACTIVE_MS && now - c.renderedAt >= ACTIVE_RENDER_EVERY_MS)
  })
  // The ones never rendered first, then the newest.
  stale.sort((a, b) => Number(cache.has(a.key)) - Number(cache.has(b.key)) || b.lastAt - a.lastAt)
  let rendered = 0
  const failed = new Set<string>()
  for (const w of stale) {
    if (rendered >= RENDER_BUDGET || Date.now() - now >= RENDER_TIME_MS) break
    if (!(await renderInto(w.key, w.agent, w.id, w.sig))) failed.add(w.key)
    rendered++
    await new Promise((r) => setImmediate(r))
  }
  const wanted = new Set(want.map((w) => w.key))
  for (const k of [...cache.keys()]) {
    if (wanted.has(k)) continue
    const c = cache.get(k)!
    if (c.row) keptBytes -= c.bytes
    cache.delete(k)
  }
  for (const k of [...failedAt.keys()]) if (!wanted.has(k)) failedAt.delete(k)
  const out: ConversationBodyRow[] = []
  const unread: string[] = []
  for (const w of want) {
    const c = cache.get(w.key)
    if (!c) { unread.push(w.key); continue }
    const row = { agent: w.agent, id: w.id } as ConversationBodyRow
    manifestHashes.set(row, c.hash)
    out.push(row)
  }
  if (unread.length) unreadOf.set(out, unread)
  if (stale.length > rendered) {
    log.session.info('conversation bodies copy: more conversations to read, in the next round', { rendered, left: stale.length - rendered })
    again?.()
  } else if (failed.size) {
    log.session.warn('conversation bodies copy: a conversation could not be read; the companion keeps its copy of it', { conversations: [...failed] })
  }
  return out
}

/** The row a put sends: the render the manifest named, or a new one. */
async function loadBody(row: ConversationBodyRow): Promise<ConversationBodyRow | undefined> {
  if (Array.isArray(row.messages)) return row
  const key = conversationRowKey(row.agent, row.id)
  const c = cache.get(key)
  if (c?.row && c.hash === manifestHashes.get(row)) return c.row
  if (!(await renderInto(key, row.agent, row.id, c?.sig ?? ''))) return undefined
  return cache.get(key)?.row
}

export const CONVERSATION_BODIES_KIND: CopyKind<ConversationBodyRow> = {
  kind: 'conversation-bodies',
  schemaVersion: CONVERSATION_BODIES_SCHEMA_VERSION,
  key: (r) => conversationRowKey(r.agent, r.id),
  hash: (r) => manifestHashes.get(r) ?? sha12(JSON.stringify(r)),
  loadRow: loadBody,
  ordered: false,
  digest: false,
  choice: 'conversation_bodies',
  rows: () => leaderConversationBodies(),
  keep: (rows) => unreadOf.get(rows) ?? [],
  // An index write is a turn (or a list change); the sweep reads the active ones again.
  watch: (soon) => {
    again = soon
    const stop = onStoreWrite('conversations', soon)
    return () => { if (again === soon) again = null; stop() }
  },
}

/** Tests only: render with `fn` (null: the Mac's own read). */
export function _setConversationRenderForTesting(fn: RenderConversation | null): void {
  renderImpl = fn
}

/** Tests only. */
export function _resetConversationBodiesLeaderForTesting(): void {
  cache.clear()
  failedAt.clear()
  keptBytes = 0
  again = null
  renderImpl = null
}
