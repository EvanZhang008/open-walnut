/**
 * The follower side of the `conversation-bodies` copy kind (conversation-bodies.ts):
 * one file per conversation, `conversation-bodies/<agent>/<id>.json` through
 * `copyPath` (on the companion `cache/replica/home/conversation-bodies/...`, apart from
 * the chat history git sync writes), at 0600 in 0700 dirs. Every text is run through the
 * redactor again before it is written (a leader that did not, an older Mac). The half
 * rule counts conversations. The box's reader is companion-conversations.ts
 * copiedConversation.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import { NOTHING_HELD, createRowSetFollower, serialChain, writeCopyFile, type RowSetFollower } from '../kind-follower.js'
import { agentOfRowKey, agentSegmentOk, conversationIdOk, conversationRowKey } from './conversations.js'
import {
  CONVERSATION_BODIES_REMOVAL_FLOOR, CONVERSATION_BODIES_SCHEMA_VERSION, CONVERSATION_BODY_MAX_BYTES, messageOk, redactMessage,
  type ConversationBodyRow,
} from './conversation-bodies.js'
import { copyPath, copyRefusal, markCopyOff } from './gate.js'
import { copyStateIo } from './state-io.js'

const bodiesDir = (): string => copyPath(path.join(WALNUT_HOME, 'conversation-bodies'))
const bodyFile = (agent: string, id: string): string => path.join(bodiesDir(), agent, `${id}.json`)

async function localKeys(): Promise<string[]> {
  let agents: string[]
  try { agents = (await fsp.readdir(bodiesDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  const keys: string[] = []
  for (const agent of agents.filter(agentSegmentOk).sort()) {
    const names = await fsp.readdir(path.join(bodiesDir(), agent)).catch(() => [] as string[])
    for (const n of names) {
      const id = n.endsWith('.json') ? n.slice(0, -5) : ''
      if (conversationIdOk(id)) keys.push(conversationRowKey(agent, id))
    }
  }
  return keys
}

function isRow(v: unknown): v is ConversationBodyRow {
  const r = v as Partial<ConversationBodyRow> | null
  return !!r && typeof r === 'object' && typeof r.agent === 'string' && agentSegmentOk(r.agent) && conversationIdOk(r.id)
    && Number.isInteger(r.total) && Array.isArray(r.messages) && (r.total as number) >= r.messages.length
    && r.messages.every(messageOk) && Array.isArray(r.adoptedTurnIds) && r.adoptedTurnIds.every((x) => typeof x === 'string')
}

let io = copyStateIo('conversation-bodies')
let serial = serialChain()
let follower: RowSetFollower | null = null

export function conversationBodiesFollower(): RowSetFollower {
  follower ??= createRowSetFollower<ConversationBodyRow>({
    kind: 'conversation-bodies',
    schemaVersion: CONVERSATION_BODIES_SCHEMA_VERSION,
    label: 'conversation bodies copy',
    log: log.agent,
    removalFloor: CONVERSATION_BODIES_REMOVAL_FLOOR,
    ordered: false,
    serial: (fn) => serial(fn),
    refuse: copyRefusal,
    load: () => io.load(),
    save: () => io.save(),
    isRow,
    key: (r) => conversationRowKey(r.agent, r.id),
    localKeys,
    apply: async ({ rows, removeIds }) => {
      for (const key of removeIds ?? []) {
        const agent = agentOfRowKey(key)
        const id = key.slice(agent.length + 1)
        if (agentSegmentOk(agent) && conversationIdOk(id)) await fsp.rm(bodyFile(agent, id), { force: true })
      }
      const skipped: string[] = []
      for (const r of rows ?? []) {
        const messages = r.messages.map((m) => redactMessage(m))
        const body = { v: 1, agent: r.agent, id: r.id, total: r.total, messages, adoptedTurnIds: r.adoptedTurnIds }
        if (Buffer.byteLength(JSON.stringify(body)) > CONVERSATION_BODY_MAX_BYTES * 2) { skipped.push(conversationRowKey(r.agent, r.id)); continue }
        await writeCopyFile(bodyFile(r.agent, r.id), body)
      }
      return { skipped }
    },
    // Nothing on a box writes these: the copy is the one source its reader sees.
    held: async () => NOTHING_HELD,
    changed: () => {},
    purge: async () => {
      const keys = await localKeys()
      await fsp.rm(bodiesDir(), { recursive: true, force: true })
      await markCopyOff('conversation-bodies')
      io.reset()
      return { removed: keys.length }
    },
  })
  return follower
}

/** Tests only. */
export function _resetConversationBodiesCopyForTesting(): void {
  io = copyStateIo('conversation-bodies')
  serial = serialChain()
  follower = null
}
