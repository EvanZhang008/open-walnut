/**
 * The Personal AI's conversations on the cloud companion (stage 3e of
 * docs/plan/walnut-companion-unified-replica.md).
 *
 *   the list      `listConversations` on the box takes the Mac's copy of each agent's
 *                 list (the `conversations` copy kind, `cache/replica/home/conversations/`)
 *                 once it is held, with the box's own list changes on top: a chat made,
 *                 renamed, pinned or deleted here still reaches the Mac through the box's
 *                 own list and git sync, so the copy shows it only later. Each such
 *                 change is noted here and shown while the box's list still carries it
 *                 and the copy does not yet; it goes when the copy shows it, or when the
 *                 box's list lost it (git sync gave the box the Mac's list without it:
 *                 the Mac never took it, and the box then shows the Mac's truth)
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

const EDITS_FILE = (): string => path.join(WALNUT_HOME, 'cache', 'companion-conversation-edits.json')
/** A change the copy never showed and the box's list still carries is let go after this. */
const EDIT_TTL_MS = 7 * 24 * 60 * 60_000

/** One conversation's list change made on this box, the latest of each field. */
export interface BoxConversationEdit {
  agentId: string
  id: string
  /** This box's clock at the latest change. */
  at: number
  created?: true
  deleted?: true
  title?: string
  pinned?: boolean
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

/**
 * The box changed its own conversation list (core/conversations.ts calls this after the
 * write). Never throws: a change that could not be noted shows once the copy has it.
 */
export async function noteBoxConversationEdit(agentId: string, id: string, change: EditChange): Promise<void> {
  if (!onCompanion()) return
  try {
    await serial(async () => {
      const edits = await readEdits()
      const k = editKey(agentId, id)
      const prev = edits.get(k)
      const next: BoxConversationEdit = change.deleted
        ? { agentId, id, at: Date.now(), deleted: true }
        : { ...(prev && !prev.deleted ? prev : { agentId, id }), ...change, at: Date.now() } as BoxConversationEdit
      edits.set(k, next)
      await writeEdits(edits)
    })
  } catch (err) {
    log.agent.warn('companion conversations: a list change made here was not noted', { agentId, conversationId: id, error: err instanceof Error ? err.message : String(err) })
  }
}

/** What of an edit still differs from the copy and is still on the box's own list (null: nothing). */
function liveEdit(e: BoxConversationEdit, copy: ConversationMeta | undefined, own: ConversationMeta | undefined, now: number): BoxConversationEdit | null {
  if (now - e.at > EDIT_TTL_MS) return null
  if (e.deleted) return !own && copy ? e : null
  if (!own) return null
  const out: BoxConversationEdit = { agentId: e.agentId, id: e.id, at: e.at }
  if (e.created && !copy) out.created = true
  if (e.title !== undefined && own.title === e.title && copy?.title !== e.title) out.title = e.title
  if (e.pinned !== undefined && !!own.pinned === e.pinned && !!copy?.pinned !== e.pinned) out.pinned = e.pinned
  return out.created || out.title !== undefined || out.pinned !== undefined ? out : null
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
  const { copyKindHeld } = await import('./replication/kinds/gate.js')
  if (!(await copyKindHeld('conversations'))) return null
  const { readConversationIndexCopy } = await import('./replication/kinds/conversations-follower.js')
  const copied = await readConversationIndexCopy(agentId)
  if (!copied) return null
  const rows = new Map<string, ConversationMeta>()
  for (const c of copied.conversations) if (!rows.has(c.id)) rows.set(c.id, c)
  const edits = await readEdits()
  const mine = [...edits.values()].filter((e) => e.agentId === agentId)
  if (mine.length === 0) return [...rows.values()]
  const own = new Map<string, ConversationMeta>()
  for (const c of (await ownIndex()).conversations ?? []) if (!own.has(c.id)) own.set(c.id, c)
  const now = Date.now()
  let pruned = false
  for (const e of mine) {
    const live = liveEdit(e, rows.get(e.id), own.get(e.id), now)
    if (!live) { edits.delete(editKey(e.agentId, e.id)); pruned = true; continue }
    if (live.deleted) { rows.delete(e.id); continue }
    const base = rows.get(e.id) ?? own.get(e.id)!
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
      v?: unknown; id?: unknown; total?: unknown; messages?: unknown; adoptedTurnIds?: unknown
    }
    if (raw?.v !== 1 || raw.id !== conversationId || !Array.isArray(raw.messages)) return null
    const messages = raw.messages as CopiedConversation['messages']
    const total = Number(raw.total)
    if (!Number.isInteger(total) || total < messages.length) return null
    return {
      messages, start: total - messages.length, asOf,
      adoptedTurnIds: new Set(Array.isArray(raw.adoptedTurnIds) ? raw.adoptedTurnIds.filter((x): x is string => typeof x === 'string') : []),
    }
  } catch {
    return null
  }
}

/** Tests only. */
export async function _resetCompanionConversationsForTesting(): Promise<void> {
  await fsp.rm(EDITS_FILE(), { force: true })
}
