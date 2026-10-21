/**
 * The Mac's side of the `conversation-bodies` copy kind (stage 3e of
 * docs/plan/walnut-companion-unified-replica.md, kinds/conversation-bodies.ts): which
 * conversations it copies, what a row holds, and how often a conversation is read.
 *
 * Pinned:
 *   - per agent: its main conversation and the newest with a message in the last 30
 *     days, at most CONVERSATION_BODIES_PER_AGENT;
 *   - a row is the newest rows that fit CONVERSATION_BODY_MAX_BYTES with `total` keeping
 *     the Mac's ids, every text through the redactor, the adopted cloud turn ids;
 *   - a conversation is read again only when its index row moved (or it is active);
 *     one the Mac cannot read, or not read yet, rides in `keep`; at most RENDER_BUDGET
 *     are read in a round and the next round is asked for at once;
 *   - a put reads the row the manifest named.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-conversation-bodies-leader'))

import { CONVERSATIONS_DIR, WALNUT_HOME } from '../../../../src/constants.js'
import {
  CONVERSATION_BODIES_KIND, CONVERSATION_BODIES_PER_AGENT, CONVERSATION_BODY_MAX_BYTES, RENDER_BUDGET,
  _resetConversationBodiesLeaderForTesting, _setConversationRenderForTesting, bodyRow, leaderConversationBodies,
} from '../../../../src/core/replication/kinds/conversation-bodies.js'
import { buildCopyManifest } from '../../../../src/core/replication/kinds/copy-kind.js'
import type { ConversationMeta } from '../../../../src/core/types.js'

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
function meta(id: string, at: string, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return { id, agentId: 'general', title: id, createdAt: ago(100_000), lastMessageAt: at, messageCount: 2, lastDistilledAt: null, lastDistilledMessageCount: 0, ...extra }
}
async function writeIndex(agent: string, list: ConversationMeta[]): Promise<void> {
  await fs.mkdir(path.join(CONVERSATIONS_DIR, agent), { recursive: true })
  await fs.writeFile(path.join(CONVERSATIONS_DIR, agent, '_index.json'), JSON.stringify({ version: 1, activeConversationId: null, conversations: list }))
}

const reads: string[] = []
let failing = new Set<string>()
const rows = (id: string, n: number, text = 'Acme') => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `${text} ${id} ${i}`, createdAt: ago(10) }))

beforeEach(async () => {
  _resetConversationBodiesLeaderForTesting()
  await fs.rm(CONVERSATIONS_DIR, { recursive: true, force: true })
  reads.length = 0
  failing = new Set()
  _setConversationRenderForTesting(async (agentId, id) => {
    reads.push(`${agentId}/${id}`)
    if (failing.has(id)) return null
    return { messages: rows(id, 3), adoptedTurnIds: id === 'conv-a1' ? ['turn-b', 'turn-a', 'turn-a'] : [] }
  })
})

afterAll(async () => {
  _resetConversationBodiesLeaderForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('which conversations the copy takes', () => {
  it('per agent: the main one whatever its age, and the newest recent ones', async () => {
    await writeIndex('general', [
      meta('conv-main', ago(60 * 24 * 90), { isMain: true }), meta('conv-a1', ago(5)), meta('conv-a2', ago(60)), meta('conv-old', ago(60 * 24 * 40)),
    ])
    await writeIndex('mentor', [meta('conv-m1', ago(1), { agentId: 'mentor' })])
    const out = await leaderConversationBodies()
    expect(out.map((r) => `${r.agent}/${r.id}`).sort()).toEqual(['general/conv-a1', 'general/conv-a2', 'general/conv-main', 'mentor/conv-m1'])
    expect(reads.sort()).toEqual(['general/conv-a1', 'general/conv-a2', 'general/conv-main', 'mentor/conv-m1'])
  })

  it(`at most ${CONVERSATION_BODIES_PER_AGENT} per agent, newest first`, async () => {
    await writeIndex('general', Array.from({ length: CONVERSATION_BODIES_PER_AGENT + 5 }, (_, i) => meta(`conv-n${String(i).padStart(3, '0')}`, ago(i + 1))))
    let soon = 0
    const stop = CONVERSATION_BODIES_KIND.watch(() => { soon++ })
    let out = await leaderConversationBodies()
    // One round reads RENDER_BUDGET of them, the rest wait in `keep` and the next round is asked for.
    expect(out).toHaveLength(RENDER_BUDGET)
    expect(CONVERSATION_BODIES_KIND.keep!(out)).toHaveLength(CONVERSATION_BODIES_PER_AGENT - RENDER_BUDGET)
    expect(soon).toBe(1)
    for (let i = 0; i < 5 && CONVERSATION_BODIES_KIND.keep!(out).length > 0; i++) out = await leaderConversationBodies()
    stop()
    expect(out).toHaveLength(CONVERSATION_BODIES_PER_AGENT)
    expect(out.map((r) => r.id)).not.toContain(`conv-n${String(CONVERSATION_BODIES_PER_AGENT).padStart(3, '0')}`)
  })
})

describe('a row', () => {
  it('holds the newest rows that fit, with the Mac\'s ids and the whole count', () => {
    const big = 'x'.repeat(100_000)
    const all = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: 'assistant', text: `${i} ${big}`, createdAt: ago(1) }))
    const row = bodyRow('general', 'conv-big', all, [])
    expect(row.total).toBe(40)
    expect(row.messages.length).toBeLessThan(40)
    expect(row.messages.at(-1)!.id).toBe('m39')
    expect(row.messages[0].id).toBe(`m${40 - row.messages.length}`)
    expect(Buffer.byteLength(JSON.stringify(row.messages))).toBeLessThanOrEqual(CONVERSATION_BODY_MAX_BYTES + 1024)
  })

  it('runs every text through the redactor, keeps the plain fields, sorts the adopted ids', async () => {
    const row = bodyRow('general', 'conv-s', [
      { id: 'm0', role: 'user', text: 'set password=Zq8vT3mKp2 now', createdAt: ago(1), messageId: 'msg-1' },
      { id: 'm1', role: 'assistant', text: 'ok', kind: 'tool', detail: 'token: 9f3kQ7wLmZ2x', createdAt: ago(1) },
    ], ['turn-b', 'turn-a', 'turn-a'])
    expect(row.messages.map((m) => [m.text, m.detail, m.messageId])).toEqual([['set password=[REDACTED] now', undefined, 'msg-1'], ['ok', 'token: [REDACTED]', undefined]])
    expect(row.adoptedTurnIds).toEqual(['turn-a', 'turn-b'])
  })
})

describe('how often a conversation is read', () => {
  it('again only when its index row moved; one the Mac cannot read rides in keep', async () => {
    // Fixed times: a row whose time moved is a row that moved.
    const old = ago(60 * 5)
    const recent = ago(1)
    await writeIndex('general', [meta('conv-a1', old), meta('conv-a2', old)])
    const first = await leaderConversationBodies()
    expect(reads).toHaveLength(2)
    const m1 = await buildCopyManifest(CONVERSATION_BODIES_KIND)
    expect(reads).toHaveLength(2)
    expect(m1.entries).toHaveLength(2)
    // A turn on conv-a2 moves its row: only it is read again.
    await writeIndex('general', [meta('conv-a1', old), meta('conv-a2', recent, { messageCount: 3 })])
    await leaderConversationBodies()
    expect(reads.slice(2)).toEqual(['general/conv-a2'])
    // A read that fails keeps the last render; a conversation never read rides in `keep`.
    failing = new Set(['conv-a2', 'conv-a3'])
    await writeIndex('general', [meta('conv-a1', old), meta('conv-a2', recent, { messageCount: 4 }), meta('conv-a3', ago(2))])
    const third = await leaderConversationBodies()
    expect(third.map((r) => r.id).sort()).toEqual(['conv-a1', 'conv-a2'])
    expect(CONVERSATION_BODIES_KIND.keep!(third)).toEqual(['general/conv-a3'])
    expect(first).toHaveLength(2)
  })

  it('a put reads the row the manifest named', async () => {
    await writeIndex('general', [meta('conv-a1', ago(60 * 5))])
    const manifest = await buildCopyManifest(CONVERSATION_BODIES_KIND)
    const listed = manifest.byKey.get('general/conv-a1')!
    expect(listed.messages).toBeUndefined()
    const put = await CONVERSATION_BODIES_KIND.loadRow!(listed)
    expect(put).toMatchObject({ agent: 'general', id: 'conv-a1', total: 3, adoptedTurnIds: ['turn-a', 'turn-b'] })
    expect(manifest.entries[0].h).toBe(CONVERSATION_BODIES_KIND.hash(put!))
    expect(put!.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2'])
  })
})
