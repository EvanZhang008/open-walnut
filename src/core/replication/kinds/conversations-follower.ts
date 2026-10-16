/**
 * The host side of the `conversations` copy kind (conversations.ts): one row per
 * conversation, stored as each agent's conversations/<agent>/_index.json in the
 * Mac's layout, at 0600 in 0700 dirs. Only the index: no conversation body is
 * written here. The half rule counts conversations (the follower's local keys
 * are `<agent>/<id>`), and an agent the Mac could not read keeps all of its
 * rows here (`keptBy`).
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { CONVERSATIONS_DIR, agentPathSegment } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import type { ConversationIndex, ConversationMeta } from '../../types.js'
import { createRowSetFollower, serialChain, writeCopyFile, type RowSetFollower } from '../kind-follower.js'
import {
  CONVERSATIONS_REMOVAL_FLOOR, CONVERSATIONS_SCHEMA_VERSION, agentOfRowKey, agentSegmentOk, conversationIdOk, conversationRowKey,
  indexOk, metaOk, withholdMetaSecrets, type ConversationRow,
} from './conversations.js'
import { copyRefusal, markCopyOff } from './gate.js'
import { copyStateIo } from './state-io.js'

const indexFile = (agent: string) => path.join(CONVERSATIONS_DIR, agent, '_index.json')

async function localAgents(): Promise<string[]> {
  let dirs: string[]
  try { dirs = (await fsp.readdir(CONVERSATIONS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  const out: string[] = []
  for (const d of dirs) if (agentSegmentOk(d) && await fsp.stat(indexFile(d)).then((s) => s.isFile(), () => false)) out.push(d)
  return out.sort()
}

/** This host's copy of one agent's list, or null when it has none. */
async function readLocalIndex(agent: string): Promise<ConversationIndex | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(indexFile(agent), 'utf8')) as unknown
    return indexOk(raw) ? { version: 1, activeConversationId: raw.activeConversationId ?? null, conversations: raw.conversations } : null
  } catch { return null }
}

async function localKeys(): Promise<string[]> {
  const keys: string[] = []
  for (const agent of await localAgents()) {
    const index = await readLocalIndex(agent)
    for (const id of new Set((index?.conversations ?? []).map((c) => c.id))) keys.push(conversationRowKey(agent, id))
  }
  return keys
}

function isRow(v: unknown): v is ConversationRow {
  const r = v as Partial<ConversationRow> | null
  return !!r && typeof r === 'object' && typeof r.agent === 'string' && agentSegmentOk(r.agent) && metaOk(r.meta)
    && conversationIdOk(r.meta.id) && (r.active === undefined || r.active === true)
    && Object.keys(r).every((k) => k === 'agent' || k === 'meta' || k === 'active')
}

let io = copyStateIo('conversations')
let serial = serialChain()
let follower: RowSetFollower | null = null

export function conversationsFollower(): RowSetFollower {
  follower ??= createRowSetFollower<ConversationRow>({
    kind: 'conversations',
    schemaVersion: CONVERSATIONS_SCHEMA_VERSION,
    label: 'conversations copy',
    log: log.agent,
    removalFloor: CONVERSATIONS_REMOVAL_FLOOR,
    ordered: false,
    serial: (fn) => serial(fn),
    refuse: copyRefusal,
    load: () => io.load(),
    save: () => io.save(),
    isRow,
    key: (r) => conversationRowKey(r.agent, r.meta.id),
    localKeys,
    keptBy: (key, keep) => keep.has(agentOfRowKey(key)),
    apply: async ({ rows, removeIds }) => {
      const removing = new Map<string, Set<string>>()
      for (const key of removeIds ?? []) {
        const agent = agentOfRowKey(key)
        if (!agentSegmentOk(agent)) continue
        if (!removing.has(agent)) removing.set(agent, new Set())
        removing.get(agent)!.add(key.slice(agent.length + 1))
      }
      const putting = new Map<string, ConversationRow[]>()
      for (const r of rows ?? []) {
        if (!putting.has(r.agent)) putting.set(r.agent, [])
        putting.get(r.agent)!.push(r)
      }
      for (const agent of new Set([...removing.keys(), ...putting.keys()])) {
        const index = (await readLocalIndex(agent)) ?? { version: 1, activeConversationId: null, conversations: [] }
        const gone = removing.get(agent) ?? new Set<string>()
        let list: ConversationMeta[] = index.conversations.filter((c) => !gone.has(c.id))
        let active = index.activeConversationId && gone.has(index.activeConversationId) ? null : index.activeConversationId
        for (const r of putting.get(agent) ?? []) {
          // A leader that did not withhold a secret-shaped title (an older Mac): withheld here before it is written.
          const meta = withholdMetaSecrets(r.meta).meta
          list = [...list.filter((c) => c.id !== meta.id), meta]
          if (r.active) active = meta.id
          else if (active === meta.id) active = null
        }
        if (list.length === 0) await fsp.rm(indexFile(agent), { force: true })
        else await writeCopyFile(indexFile(agent), { version: 1, activeConversationId: active, conversations: list })
      }
      return { skipped: [] }
    },
    held: async () => (await import('../../../replica/journal-overlay.js')).journalHeld('conversations'),
    changed: () => {},
    purge: async () => {
      const agents = await localAgents()
      let removed = 0
      for (const a of agents) {
        removed += (await readLocalIndex(a))?.conversations.length ?? 0
        await fsp.rm(indexFile(a), { force: true })
      }
      await markCopyOff('conversations')
      io.reset()
      return { removed }
    },
  })
  return follower
}

/** The copied conversation list of `agentId`, or null when this host has none. */
export async function readConversationIndexCopy(agentId: string): Promise<ConversationIndex | null> {
  let segment: string
  try { segment = agentPathSegment(agentId) } catch { return null }
  return readLocalIndex(segment)
}

/** Tests only. */
export function _resetConversationsCopyForTesting(): void {
  io = copyStateIo('conversations')
  serial = serialChain()
  follower = null
}
