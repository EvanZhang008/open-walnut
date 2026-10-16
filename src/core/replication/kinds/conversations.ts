/**
 * The `conversations` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4
 * and WP5): each console agent's conversation list (conversations/<agent>/_index.json,
 * the chat-history index: every chat's title, times, count, pin, main mark and
 * ask link) on each host replica, in the same layout. Index only: the bodies
 * (conversations/<agent>/<id>.json) are not copied; they are read from the Mac
 * by key while it answers, and need it while it is away (replica/route-table.ts).
 *
 * On the host, listConversations, getActiveConversationId and getMainConversationId
 * (core/conversations.ts) read this copy and never migrate, adopt or back-fill
 * (each of those writes the index). An index the Mac lists but cannot read or
 * parse rides in `keep` (the host keeps its copy of it); the conversations dir
 * the Mac cannot list throws, so the round skips the kind.
 *
 * Unordered, floor 50, no digest. Keyed by the agent's path segment.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { CONVERSATIONS_DIR, agentIdFromPathSegment, agentPathSegment } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import type { ConversationIndex, ConversationMeta } from '../../types.js'
import { readJsonFile } from '../../../utils/fs.js'
import { sha12 } from '../kind.js'
import { onStoreWrite } from '../store-writes.js'
import { findSecrets } from '../config-allowlist.js'
import type { CopyKind } from './copy-kind.js'

export const CONVERSATIONS_SCHEMA_VERSION = 1
export const CONVERSATIONS_REMOVAL_FLOOR = 50

export interface ConversationIndexRow { agent: string; index: ConversationIndex }

/** What a host replica shows for a title that holds something secret-shaped (a pasted key in the first message). */
export const WITHHELD_TITLE = 'Untitled chat'

/**
 * The index with every secret-shaped string of a conversation's meta withheld:
 * a title reads as WITHHELD_TITLE, any other string field is left out. Run on
 * the Mac before the row is hashed and on the host before it is written.
 * `withheld` counts the conversations touched (ids only are logged).
 */
export function withholdSecrets(index: ConversationIndex): { index: ConversationIndex; withheld: string[] } {
  const withheld: string[] = []
  const conversations = index.conversations.map((c) => {
    const found = findSecrets(c, 'c')
    if (found.length === 0) return c
    withheld.push(c.id)
    const out: Record<string, unknown> = { ...c }
    for (const f of found) {
      const field = f.path.split('.')[1]
      if (!field || field === 'id' || field === 'agentId' || field === 'createdAt' || field === 'lastMessageAt') continue
      if (field === 'title') out.title = WITHHELD_TITLE
      else delete out[field]
    }
    return out as unknown as ConversationMeta
  })
  return withheld.length === 0 ? { index, withheld } : { index: { ...index, conversations }, withheld }
}

/** An agent dir name the copy may hold: the path segment of a valid agent id, nothing that walks out. */
export function agentSegmentOk(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) return false
  try { return agentPathSegment(agentIdFromPathSegment(segment)) === segment } catch { return false }
}

function metaOk(m: unknown): m is ConversationMeta {
  const c = m as Partial<ConversationMeta> | null
  return !!c && typeof c === 'object' && typeof c.id === 'string' && typeof c.title === 'string'
    && typeof c.createdAt === 'string' && typeof c.lastMessageAt === 'string'
}

export function indexOk(v: unknown): v is ConversationIndex {
  const i = v as Partial<ConversationIndex> | null
  return !!i && typeof i === 'object' && Array.isArray(i.conversations) && i.conversations.every(metaOk)
    && (i.activeConversationId === null || i.activeConversationId === undefined || typeof i.activeConversationId === 'string')
}

const unreadableOf = new WeakMap<object, string[]>()
const warned = new Set<string>()

/** The Mac's conversation lists (tests point it at a Mac dir of their own). */
export async function readConversationRows(root = CONVERSATIONS_DIR): Promise<ConversationIndexRow[]> {
  let dirs: string[]
  try {
    dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }
  const out: ConversationIndexRow[] = []
  const unreadable: string[] = []
  const withheldOf: string[] = []
  for (const agent of dirs) {
    if (!agentSegmentOk(agent)) continue
    try {
      const index = await readJsonFile<unknown>(path.join(root, agent, '_index.json'), null, { readErrors: 'throw' })
      if (index === null) continue // no list yet (migrated lazily on the Mac)
      if (!indexOk(index)) { unreadable.push(agent); continue }
      const clean = withholdSecrets({ version: 1, activeConversationId: index.activeConversationId ?? null, conversations: index.conversations })
      if (clean.withheld.length > 0) withheldOf.push(...clean.withheld.map((id) => `${agent}/${id}`))
      out.push({ agent, index: clean.index })
    } catch {
      unreadable.push(agent)
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
function hashOf(row: ConversationIndexRow): string {
  let h = hashes.get(row)
  if (h === undefined) {
    h = sha12(JSON.stringify(row))
    hashes.set(row, h)
  }
  return h
}


export const CONVERSATIONS_KIND: CopyKind<ConversationIndexRow> = {
  kind: 'conversations',
  schemaVersion: CONVERSATIONS_SCHEMA_VERSION,
  key: (r) => r.agent,
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
