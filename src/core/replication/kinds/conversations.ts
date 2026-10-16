/**
 * The `conversations` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4
 * and WP5): each console agent's conversation list (conversations/<agent>/_index.json,
 * the chat-history index: every chat's title, times, count, pin, main mark and
 * ask link) on each host replica, in the same layout. Index only: the bodies
 * (conversations/<agent>/<id>.json) are not copied; they are read from the Mac
 * by key while it answers, and need it while it is away (replica/route-table.ts).
 *
 * One row per conversation (`<agent segment>/<conversation id>`), the list's
 * active one marked, so the half rule counts conversations: once a host holds
 * CONVERSATIONS_REMOVAL_FLOOR of them, a manifest that would remove more than
 * half is refused until the user confirms it (an index the Mac emptied by
 * accident, a list it lost). Schema 1 was one row per agent's whole list, where
 * the half rule could never apply (a few agents, floor 50).
 *
 * What the Mac cannot read never removes the host's copy: a conversations dir it
 * cannot list (missing included) throws, so the round skips the kind; an agent
 * whose index does not open, does not parse, is empty or is missing from its dir
 * rides in `keep` (by its agent segment), and the host keeps every conversation
 * of that agent (kind-follower.ts keptBy).
 *
 * On the host, listConversations, getActiveConversationId and getMainConversationId
 * (core/conversations.ts) read this copy and never migrate, adopt or back-fill
 * (each of those writes the index). The host side is conversations-follower.ts.
 *
 * Unordered, no digest.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { CONVERSATIONS_DIR, agentIdFromPathSegment, agentPathSegment, validateConversationId } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import type { ConversationIndex, ConversationMeta } from '../../types.js'
import { readJsonFile } from '../../../utils/fs.js'
import { dedupeConversations } from '../../conversations.js'
import { sha12 } from '../kind.js'
import { onStoreWrite } from '../store-writes.js'
import { findSecrets } from '../config-allowlist.js'
import type { CopyKind } from './copy-kind.js'

export const CONVERSATIONS_SCHEMA_VERSION = 2
/** Conversations, as the requests and letters kinds count theirs. */
export const CONVERSATIONS_REMOVAL_FLOOR = 50

/** One conversation of one agent's list; `active` marks the list's active conversation. */
export interface ConversationRow { agent: string; meta: ConversationMeta; active?: true }

export function conversationRowKey(agent: string, id: string): string {
  return `${agent}/${id}`
}

/** The agent segment a row key names (the keep key of that agent's list). */
export function agentOfRowKey(key: string): string {
  const i = key.indexOf('/')
  return i < 0 ? key : key.slice(0, i)
}

/** What a host replica shows for a title that holds something secret-shaped (a pasted key in the first message). */
export const WITHHELD_TITLE = 'Untitled chat'

/**
 * A conversation's meta with every secret-shaped string withheld: the title
 * reads as WITHHELD_TITLE, any other string field is left out. Run on the Mac
 * before the row is hashed and on the host before it is written.
 */
export function withholdMetaSecrets(meta: ConversationMeta): { meta: ConversationMeta; withheld: boolean } {
  const found = findSecrets(meta, 'c')
  if (found.length === 0) return { meta, withheld: false }
  const out: Record<string, unknown> = { ...meta }
  for (const f of found) {
    const field = f.path.split('.')[1]
    if (!field || field === 'id' || field === 'agentId' || field === 'createdAt' || field === 'lastMessageAt') continue
    if (field === 'title') out.title = WITHHELD_TITLE
    else delete out[field]
  }
  return { meta: out as unknown as ConversationMeta, withheld: true }
}

/** An agent dir name the copy may hold: the path segment of a valid agent id, nothing that walks out. */
export function agentSegmentOk(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) return false
  try { return agentPathSegment(agentIdFromPathSegment(segment)) === segment } catch { return false }
}

/** A conversation id the copy may key a row by (the Mac's own file-name rule). */
export function conversationIdOk(id: unknown): id is string {
  if (typeof id !== 'string') return false
  try { validateConversationId(id); return true } catch { return false }
}

export function metaOk(m: unknown): m is ConversationMeta {
  const c = m as Partial<ConversationMeta> | null
  return !!c && typeof c === 'object' && typeof c.id === 'string' && typeof c.title === 'string'
    && typeof c.createdAt === 'string' && typeof c.lastMessageAt === 'string'
}

export function indexOk(v: unknown): v is ConversationIndex {
  const i = v as Partial<ConversationIndex> | null
  return !!i && typeof i === 'object' && Array.isArray(i.conversations) && i.conversations.every(metaOk)
    && (i.activeConversationId === null || i.activeConversationId === undefined || typeof i.activeConversationId === 'string')
}

/**
 * One agent's index as the Mac holds it, or null when it cannot be told: it
 * does not open or parse (thrown), it is not an index, it is empty, or the
 * agent's dir has none (readJsonFile answers the fallback, null, for those
 * two). Each of those is a list the Mac lost for now, never an empty list.
 */
async function readAgentIndex(root: string, agent: string): Promise<ConversationIndex | null> {
  const raw = await readJsonFile<unknown>(path.join(root, agent, '_index.json'), null, { readErrors: 'throw' })
  return indexOk(raw) ? raw : null
}

const unreadableOf = new WeakMap<object, string[]>()
const warned = new Set<string>()

/** The Mac's conversations, one row each (tests point it at a Mac dir of their own). */
export async function readConversationRows(root = CONVERSATIONS_DIR): Promise<ConversationRow[]> {
  // A dir that does not list (missing included) throws: the round skips the kind.
  const dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  const out: ConversationRow[] = []
  const unreadable: string[] = []
  const withheldOf: string[] = []
  for (const agent of dirs) {
    if (!agentSegmentOk(agent)) continue
    let index: ConversationIndex | null
    try { index = await readAgentIndex(root, agent) } catch { index = null }
    if (!index) { unreadable.push(agent); continue }
    const active = index.activeConversationId ?? null
    const seen = new Set<string>()
    for (const c of dedupeConversations(agentIdFromPathSegment(agent), index.conversations)) {
      if (!conversationIdOk(c.id) || seen.has(c.id)) continue
      seen.add(c.id)
      const clean = withholdMetaSecrets(c)
      if (clean.withheld) withheldOf.push(`${agent}/${c.id}`)
      out.push({ agent, meta: clean.meta, ...(c.id === active ? { active: true as const } : {}) })
    }
  }
  if (unreadable.length > 0) unreadableOf.set(out, unreadable)
  const fresh = unreadable.filter((a) => !warned.has(a))
  for (const a of unreadable) warned.add(a)
  if (fresh.length > 0) log.session.warn('conversations copy: a conversation list could not be read, the host keeps its copy of it', { agents: fresh })
  const freshWithheld = withheldOf.filter((k) => !warned.has(`w:${k}`))
  for (const k of withheldOf) warned.add(`w:${k}`)
  if (freshWithheld.length > 0) log.session.warn('conversations copy: a title looked like a secret, the host shows it as untitled', { conversations: freshWithheld })
  return out
}

const hashes = new WeakMap<object, string>()
function hashOf(row: ConversationRow): string {
  let h = hashes.get(row)
  if (h === undefined) {
    h = sha12(JSON.stringify(row))
    hashes.set(row, h)
  }
  return h
}

export const CONVERSATIONS_KIND: CopyKind<ConversationRow> = {
  kind: 'conversations',
  schemaVersion: CONVERSATIONS_SCHEMA_VERSION,
  key: (r) => conversationRowKey(r.agent, r.meta.id),
  hash: hashOf,
  ordered: false,
  digest: false,
  choice: 'conversations',
  rows: () => readConversationRows(),
  keep: (rows) => unreadableOf.get(rows) ?? [],
  // The store's one write point, not the bus: its writers tell the browser sockets only (store-writes.ts).
  watch: (soon) => onStoreWrite('conversations', soon),
}

/** Tests only. */
export function _resetConversationsLeaderForTesting(): void {
  warned.clear()
}
