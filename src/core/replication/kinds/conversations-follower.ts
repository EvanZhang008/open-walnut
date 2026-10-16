/**
 * The host side of the `conversations` copy kind (conversations.ts): each
 * agent's conversations/<agent>/_index.json, written as the Mac sent it, at
 * 0600 in 0700 dirs. Only the index: no conversation body is written here.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { CONVERSATIONS_DIR, agentPathSegment } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import type { ConversationIndex } from '../../types.js'
import { createRowSetFollower, serialChain, writeCopyFile, type RowSetFollower } from '../kind-follower.js'
import { CONVERSATIONS_REMOVAL_FLOOR, CONVERSATIONS_SCHEMA_VERSION, agentSegmentOk, indexOk, withholdSecrets, type ConversationIndexRow } from './conversations.js'
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

function isRow(v: unknown): v is ConversationIndexRow {
  const r = v as Partial<ConversationIndexRow> | null
  return !!r && typeof r === 'object' && typeof r.agent === 'string' && agentSegmentOk(r.agent) && indexOk(r.index)
}

let io = copyStateIo('conversations')
let serial = serialChain()
let follower: RowSetFollower | null = null

export function conversationsFollower(): RowSetFollower {
  follower ??= createRowSetFollower<ConversationIndexRow>({
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
    key: (r) => r.agent,
    localKeys: localAgents,
    apply: async ({ rows, removeIds }) => {
      for (const agent of removeIds ?? []) if (agentSegmentOk(agent)) await fsp.rm(indexFile(agent), { force: true })
      // A leader that did not withhold a secret-shaped title (an older Mac): withheld here before it is written.
      for (const r of rows ?? []) await writeCopyFile(indexFile(r.agent), withholdSecrets(r.index).index)
      return { skipped: [] }
    },
    held: async () => (await import('../../../replica/journal-overlay.js')).journalHeld('conversations'),
    changed: () => {},
    purge: async () => {
      const agents = await localAgents()
      for (const a of agents) await fsp.rm(indexFile(a), { force: true })
      await markCopyOff('conversations')
      io.reset()
      return { removed: agents.length }
    },
  })
  return follower
}

/** The copied conversation list of `agentId`, or null when this host has none. */
export async function readConversationIndexCopy(agentId: string): Promise<ConversationIndex | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(indexFile(agentPathSegment(agentId)), 'utf8')) as unknown
    return indexOk(raw) ? { version: 1, activeConversationId: raw.activeConversationId ?? null, conversations: raw.conversations } : null
  } catch { return null }
}

/** Tests only. */
export function _resetConversationsCopyForTesting(): void {
  io = copyStateIo('conversations')
  serial = serialChain()
  follower = null
}
