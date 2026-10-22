/**
 * The Personal AI's conversations on the cloud companion (stages 3e and 4d of
 * docs/plan/walnut-companion-unified-replica.md).
 *
 *   the list      `listConversations` on the box takes the Mac's copy of each agent's
 *                 list (the `conversations` copy kind, `cache/replica/home/conversations/`)
 *                 once it is held, with the box's own list changes on top: a chat made,
 *                 renamed, pinned or deleted here. Each such change is noted here
 *                 (`cache/companion-conversation-edits.json`) and shown over the copy:
 *   4d            once the Mac drains `conversation-edit`, a change is a record in the
 *                 companion's journal, written before the box's own list (a refused
 *                 record makes no change). It shows while the record waits and, once
 *                 the Mac acked it, until a copy round from after the ack (or 10
 *                 minutes); the box's own list plays no part
 *   older Mac     a change still reaches the Mac through the box's own list and git
 *                 sync: shown while the box's list carries it and the copy does not
 *                 yet; it goes when the copy shows it, or when the box's list lost it
 *   one chat      `GET /api/v1/conversations/:id/messages` when the Mac does not answer:
 *                 the Mac's copy of that conversation's messages (the
 *                 `conversation-bodies` kind), paged in the Mac's own positional ids
 *
 * An agent whose list the copy does not hold reads the box's own list, as before.
 *
 * Cloud companion only: anywhere else every function answers "no copy".
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME, agentPathSegment } from '../constants.js'
import { log } from '../logging/index.js'
import type { ConversationIndex, ConversationMeta } from './types.js'
import { followerKind } from './server-role.js'
import { writeJsonFile } from '../utils/fs.js'
import { companionJournalRecords, journalConversationEdit } from './companion-journal.js'
import type { JournalRecord } from '../providers/offline-journal-core.js'
import { NeedsLeaderError } from './replication/needs-leader.js'

const EDITS_FILE = (): string => path.join(WALNUT_HOME, 'cache', 'companion-conversation-edits.json')
/** A change the copy never showed and the box's list still carries is let go after this. */
const EDIT_TTL_MS = 7 * 24 * 60 * 60_000
/** A change the Mac took is shown at most this long without a copy round from after the ack. */
export const CONVERSATION_EDIT_AWAIT_MS = 10 * 60_000

/** One conversation's list change made on this box, the latest of each field. */
export interface BoxConversationEdit {
  agentId: string
  id: string
  /** This box's clock at the latest change. */
  at: number
  created?: true
  deleted?: true
  /** A rename made here (never the title a chat was made with: that is `createdTitle`). */
  title?: string
  pinned?: boolean
  /** The title of a chat made here, for its row while no list holds it. */
  createdTitle?: string
  /** 4d: the latest `conversation-edit` record of these changes (none: git sync carries them). */
  seq?: number
  /** The Mac's clock when it acked `seq`, and this box's clock then. */
  ackAt?: number
  ackedAt?: number
}

type EditChange = Partial<Pick<BoxConversationEdit, 'created' | 'deleted' | 'title' | 'pinned'>>

const onCompanion = (): boolean => followerKind() === 'companion'
const editKey = (agentId: string, id: string): string => `${agentId}/${id}`

let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

function isEdit(v: unknown): v is BoxConversationEdit {
  const e = v as Partial<BoxConversationEdit> | null
  return !!e && typeof e === 'object' && typeof e.agentId === 'string' && typeof e.id === 'string'
    && /^conv-[a-z0-9-]{1,64}$/i.test(e.id) && typeof e.at === 'number'
}

async function readEdits(): Promise<Map<string, BoxConversationEdit>> {
  try {
    const raw = JSON.parse(await fsp.readFile(EDITS_FILE(), 'utf8')) as { edits?: unknown }
    const list = Array.isArray(raw?.edits) ? raw.edits.filter(isEdit) : []
    return new Map(list.map((e) => [editKey(e.agentId, e.id), e]))
  } catch {
    return new Map()
  }
}

async function writeEdits(edits: Map<string, BoxConversationEdit>): Promise<void> {
  if (edits.size === 0) {
    await fsp.rm(EDITS_FILE(), { force: true })
    return
  }
  await fsp.mkdir(path.dirname(EDITS_FILE()), { recursive: true, mode: 0o700 })
  await writeJsonFile(EDITS_FILE(), { v: 1, edits: [...edits.values()] }, { mode: 0o600 })
}

async function copiedList(agentId: string): Promise<ConversationIndex | null> {
  const { copyKindHeld } = await import('./replication/kinds/gate.js')
  if (!(await copyKindHeld('conversations'))) return null
  const { readConversationIndexCopy } = await import('./replication/kinds/conversations-follower.js')
  return readConversationIndexCopy(agentId)
}

/** The seqs of the `conversation-edit` records the Mac has not acked. */
function pendingSeqs(): Set<number> {
  const out = new Set<number>()
  for (const r of companionJournalRecords()) if (r.kind === 'conversation-edit') out.add(r.seq)
  return out
}

interface ShowState { pending: Set<number>; asOf: number; now: number }

async function showState(): Promise<ShowState> {
  const { copyKindAsOf } = await import('./replication/kinds/gate.js')
  return { pending: pendingSeqs(), asOf: (await copyKindAsOf('conversations')) ?? 0, now: Date.now() }
}

/** True when the copy row already shows every part of the change. */
function copyShows(e: BoxConversationEdit, copy: ConversationMeta | undefined): boolean {
  if (e.deleted) return !copy
  if (!copy) return false
  return (e.title === undefined || copy.title === e.title) && (e.pinned === undefined || !!copy.pinned === e.pinned)
}

/** What of an edit still shows (null: nothing; the copy, or the box's own list, is the truth). */
function liveEdit(e: BoxConversationEdit, copy: ConversationMeta | undefined, own: ConversationMeta | undefined, st: ShowState): BoxConversationEdit | null {
  if (e.seq !== undefined) {
    // 4d: the journal record and the Mac's ack decide, never the box's own list.
    if (!st.pending.has(e.seq)) {
      if (e.ackAt === undefined) return null
      if (st.asOf > e.ackAt || st.now - (e.ackedAt ?? e.at) > CONVERSATION_EDIT_AWAIT_MS || copyShows(e, copy)) return null
    }
    if (e.deleted) return copy || own ? e : null
    return copy || own || e.created ? e : null
  }
  if (st.now - e.at > EDIT_TTL_MS) return null
  if (e.deleted) return !own && copy ? e : null
  if (!own) return null
  const out: BoxConversationEdit = { agentId: e.agentId, id: e.id, at: e.at }
  if (e.created && !copy) out.created = true
  if (e.title !== undefined && own.title === e.title && copy?.title !== e.title) out.title = e.title
  if (e.pinned !== undefined && !!own.pinned === e.pinned && !!copy?.pinned !== e.pinned) out.pinned = e.pinned
  return out.created || out.title !== undefined || out.pinned !== undefined ? out : null
}

/** A chat made here that neither the copy nor the box's own list holds, as the list shows it. */
function madeRow(e: BoxConversationEdit): ConversationMeta {
  const at = new Date(e.at).toISOString()
  return { id: e.id, agentId: e.agentId, title: e.title ?? e.createdTitle ?? 'New Conversation', createdAt: at, lastMessageAt: at, messageCount: 0, lastDistilledAt: null, lastDistilledMessageCount: 0 }
}

/**
 * The box changed its own conversation list (core/conversations.ts calls this BEFORE its
 * own write). Once the Mac drains `conversation-edit` the change is a record for it, and a
 * refused record throws NeedsLeaderError; noting it for the reads never throws (a
 * change that could not be noted shows once the copy has it). `own`: the box's row before.
 */
export async function noteBoxConversationEdit(agentId: string, id: string, change: EditChange, own?: ConversationMeta): Promise<void> {
  if (!onCompanion()) return
  await serial(async () => {
    const edits = await readEdits()
    const k = editKey(agentId, id)
    const prev = edits.get(k)
    // What this box showed before the change: the Mac judges a rename against it.
    const copy = (await copiedList(agentId))?.conversations.find((c) => c.id === id)
    const shown = prev ? liveEdit(prev, copy, own, await showState()) : null
    const base = {
      title: shown?.title ?? copy?.title ?? own?.title,
      pinned: shown?.pinned ?? !!(copy?.pinned ?? own?.pinned),
    }
    const op = change.created ? 'create' : change.deleted ? 'delete' : change.title !== undefined ? 'rename' : 'pin'
    const r = journalConversationEdit({
      agentId, conversationId: id, op,
      ...(op === 'create' || op === 'rename' ? { title: change.title } : {}),
      ...(op === 'pin' ? { pinned: change.pinned } : {}),
      ...(op === 'rename' || op === 'pin' ? { base: op === 'rename' ? { title: base.title } : { pinned: base.pinned } } : {}),
    })
    // Refused (the journal is full or cannot be written): the change is not made here
    // either, and the route answers that it needs the Mac.
    if (r && !r.ok) throw new NeedsLeaderError(`conversation_edit_${r.code}`, r.message)
    try {
      const at = Date.now()
      const kept = prev && !prev.deleted ? { ...prev } : { agentId, id }
      delete (kept as BoxConversationEdit).ackAt
      delete (kept as BoxConversationEdit).ackedAt
      delete (kept as BoxConversationEdit).seq
      // A made chat's title is no rename: the copy's title wins over it once it lists the chat.
      const noted = change.created ? { created: true as const, ...(change.title !== undefined ? { createdTitle: change.title } : {}) } : change
      const next: BoxConversationEdit = change.deleted
        ? { agentId, id, at, deleted: true }
        : { ...kept, ...noted, at } as BoxConversationEdit
      if (r?.ok) next.seq = r.seq
      edits.set(k, next)
      await writeEdits(edits)
    } catch (err) {
      log.agent.warn('companion conversations: a list change made here was not noted', { agentId, conversationId: id, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

/**
 * The Mac acked these `conversation-edit` records (its clock `macNow` after it applied
 * them), before the journal lets them go: each change shows until a copy round from after
 * the ack. Kept on disk, so a restart in between keeps showing it. Never throws.
 */
export async function companionConversationEditsAcked(records: JournalRecord[], macNow: number): Promise<void> {
  try {
    await serial(async () => {
      const edits = await readEdits()
      let n = 0
      for (const r of records) {
        if (r.kind !== 'conversation-edit' || typeof r.agentId !== 'string' || typeof r.conversationId !== 'string') continue
        const e = edits.get(editKey(r.agentId, r.conversationId))
        // Only the latest record of a chat decides what shows.
        if (!e || e.seq !== r.seq) continue
        e.ackAt = macNow
        e.ackedAt = Date.now()
        n++
      }
      if (n) {
        await writeEdits(edits)
        log.agent.info('companion conversations: the Mac took the list changes; they show until its copy does', { changes: n })
      }
    })
  } catch (err) {
    log.agent.warn('companion conversations: noting the Mac\'s ack failed; the changes show until the copy has them', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * One agent's list on the companion: the Mac's copy with this box's own changes on top,
 * or null when the copy holds no list of that agent (the caller reads the box's own).
 * `ownIndex` reads the box's own list (never migrated or back-filled here).
 */
export async function companionConversationList(
  agentId: string,
  ownIndex: () => Promise<ConversationIndex>,
): Promise<ConversationMeta[] | null> {
  if (!onCompanion()) return null
  const copied = await copiedList(agentId)
  if (!copied) return null
  const rows = new Map<string, ConversationMeta>()
  for (const c of copied.conversations) if (!rows.has(c.id)) rows.set(c.id, c)
  const edits = await readEdits()
  const mine = [...edits.values()].filter((e) => e.agentId === agentId)
  if (mine.length === 0) return [...rows.values()]
  const own = new Map<string, ConversationMeta>()
  for (const c of (await ownIndex()).conversations ?? []) if (!own.has(c.id)) own.set(c.id, c)
  const st = await showState()
  let pruned = false
  for (const e of mine) {
    const live = liveEdit(e, rows.get(e.id), own.get(e.id), st)
    if (!live) { edits.delete(editKey(e.agentId, e.id)); pruned = true; continue }
    if (live.deleted) { rows.delete(e.id); continue }
    const base = rows.get(e.id) ?? own.get(e.id) ?? madeRow(live)
    rows.set(e.id, { ...base, ...(live.title !== undefined ? { title: live.title } : {}), ...(live.pinned !== undefined ? { pinned: live.pinned } : {}) })
  }
  // Changes the copy shows now (or the box's list lost) go; never awaited by the read.
  if (pruned) void serial(async () => {
    const fresh = await readEdits()
    for (const e of mine) {
      const k = editKey(e.agentId, e.id)
      if (!edits.has(k) && fresh.get(k)?.at === e.at) fresh.delete(k)
    }
    await writeEdits(fresh)
  }).catch(() => {})
  return [...rows.values()]
}

// --- one conversation's messages from the copy ---

/** The Mac's copy of one conversation's messages (kinds/conversation-bodies.ts). */
export interface CopiedConversation {
  /** The Mac's rows, oldest first, ids `m<start>` and up (the newest that fit the copy). */
  messages: Array<Record<string, unknown> & { id: string; createdAt?: string }>
  /** The id number of the first row held: older rows need the Mac. */
  start: number
  /** Cloud turns the Mac adopted into this conversation. */
  adoptedTurnIds: Set<string>
  /** The leader clock of the copy's last round (ms). */
  asOf: number
  /** 4d: the Mac's compaction summary of the turns up to `summaryAt` (ISO), when it has one. */
  summary?: string
  summaryAt?: string
}

/** The file the companion keeps one conversation's messages in (the follower writes it). */
export function conversationBodyFile(agentSegment: string, id: string): string {
  return path.join(WALNUT_HOME, 'conversation-bodies', agentSegment, `${id}.json`)
}

/** One conversation's messages from the Mac's copy, or null when the copy holds none of it. */
export async function copiedConversation(agentId: string, conversationId: string): Promise<CopiedConversation | null> {
  if (!onCompanion()) return null
  const { copyKindAsOf, copyPath } = await import('./replication/kinds/gate.js')
  const asOf = await copyKindAsOf('conversation-bodies')
  if (asOf === null) return null
  let segment: string
  try { segment = agentPathSegment(agentId) } catch { return null }
  try {
    const raw = JSON.parse(await fsp.readFile(copyPath(conversationBodyFile(segment, conversationId)), 'utf8')) as {
      v?: unknown; id?: unknown; total?: unknown; messages?: unknown; adoptedTurnIds?: unknown; summary?: unknown; summaryAt?: unknown
    }
    if (raw?.v !== 1 || raw.id !== conversationId || !Array.isArray(raw.messages)) return null
    const messages = raw.messages as CopiedConversation['messages']
    const total = Number(raw.total)
    if (!Number.isInteger(total) || total < messages.length) return null
    return {
      messages, start: total - messages.length, asOf,
      adoptedTurnIds: new Set(Array.isArray(raw.adoptedTurnIds) ? raw.adoptedTurnIds.filter((x): x is string => typeof x === 'string') : []),
      ...(typeof raw.summary === 'string' && raw.summary ? { summary: raw.summary, ...(typeof raw.summaryAt === 'string' ? { summaryAt: raw.summaryAt } : {}) } : {}),
    }
  } catch {
    return null
  }
}

/** Tests only. */
export async function _resetCompanionConversationsForTesting(): Promise<void> {
  await fsp.rm(EDITS_FILE(), { force: true })
}
