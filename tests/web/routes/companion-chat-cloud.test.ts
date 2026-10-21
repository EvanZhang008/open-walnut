/**
 * Stage 3e of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE
 * server, the copy half: the Mac's copy scheduler (kinds/copy-kind.ts syncCopyKinds)
 * sends the companion its conversation lists (`conversations`) and each recent
 * conversation's messages (`conversation-bodies`) over the real client (cloud-ingest.ts
 * postToCloudReplica, machine token), and the box's chat reads take them
 * (core/companion-conversations.ts).
 *
 * Pinned:
 *   - before any round: the list is the one the box holds (git sync's), and a lane chat
 *     the Mac does not answer for is 503 (git's chat history has none of its turns);
 *   - a round lands both kinds in the copy store (`cache/replica/home/...`) and leaves the
 *     box's own conversations dir byte for byte as it was;
 *   - the list is the Mac's copy (a chat git has not brought shows, one the Mac deleted
 *     does not, the Mac's title), with the box's own changes on top: a chat made, renamed,
 *     pinned or deleted here shows until the copy carries it, and goes when the copy does,
 *     or when the box's own list lost it;
 *   - one conversation while the Mac does not answer: the Mac's rows and ids from the copy,
 *     with `x-walnut-copy-as-of`, a turn the box answered itself merged on the tail until
 *     the copy names it, an older page the copy holds whole, and 503 past what it holds;
 *     while the Mac answers, the Mac's own answer.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-chat-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

// The relay to the Mac: the Mac away (provably not sent) unless a case answers for it.
const { relay } = vi.hoisted(() => ({ relay: { fn: null as null | ((action: string, params: Record<string, unknown>) => unknown) } }))
vi.mock('../../../src/web/routes/v1-control-relay.js', async (orig) => {
  const real = await orig<typeof import('../../../src/web/routes/v1-control-relay.js')>()
  return {
    ...real,
    callPrimaryControl: async (action: string, sid: string, params: Record<string, unknown> | undefined, timeoutMs?: number) => {
      const forced = relay.fn?.(action, params ?? {})
      if (forced !== undefined) return forced
      return { ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge for host: __local__', notSent: true } }
      void real; void sid; void timeoutMs
    },
  }
})

import { CONVERSATIONS_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { syncCopyKinds, type CopyKind, type CopyTarget } from '../../../src/core/replication/kinds/copy-kind.js'
import { CONVERSATIONS_KIND, type ConversationRow } from '../../../src/core/replication/kinds/conversations.js'
import { CONVERSATION_BODIES_KIND, bodyRow, type ConversationBodyRow } from '../../../src/core/replication/kinds/conversation-bodies.js'
import { COPY_AS_OF_HEADER } from '../../../src/core/replication/kinds/gate.js'
import { CLOUD_CHAT_OUTBOX_DIR } from '../../../src/core/cloud-chat-outbox.js'
import { listConversations } from '../../../src/core/conversations.js'
import type { ConversationMeta } from '../../../src/core/types.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const MAIN = 'conv-acme-main'
const LANE = 'conv-acme-lane'
const STALE = 'conv-acme-stale'
const MAC_ONLY = 'conv-acme-maconly'
function meta(id: string, title: string, at: string, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return { id, agentId: 'general', title, createdAt: ago(600), lastMessageAt: at, messageCount: 2, lastDistilledAt: null, lastDistilledMessageCount: 0, ...extra }
}

// The box's own list, as git sync wrote it: the Mac deleted STALE since, and MAC_ONLY is newer than git.
const boxIndex = { version: 1, activeConversationId: MAIN, conversations: [
  meta(MAIN, 'Main', ago(30), { isMain: true }), meta(LANE, 'Acme launch plan (git title)', ago(20)), meta(STALE, 'Acme old notes', ago(300)),
] }
let macConversations: ConversationRow[] = []
let macBodies: ConversationBodyRow[] = []

/** The Mac's whole list for the lane chat: 120 rows, ids m0..m119 (git's chat history has none of them). */
const laneRows = Array.from({ length: 120 }, (_, i) => ({
  id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', text: i === 119 ? 'Done: password=Zq8vT3mKp2 is set' : `Acme step ${i}`, createdAt: new Date(Date.parse('2026-10-20T10:00:00.000Z') + i * 1000).toISOString(),
}))

function macKinds(): CopyKind<any>[] {
  return [
    { ...CONVERSATIONS_KIND, watch: () => () => {}, rows: async () => macConversations, keep: () => [] },
    { ...CONVERSATION_BODIES_KIND, watch: () => () => {}, rows: async () => macBodies, keep: () => [] },
  ]
}
const companion: CopyTarget = { id: 'companion', kind: 'companion', label: 'Cloud companion', available: async () => true, post: (p, o) => postToCloudReplica(p, o) }
const round = () => syncCopyKinds(macKinds(), { targets: () => [companion] })

async function call(p: string, init: RequestInit = {}): Promise<{ status: number; body: any; asOf: string | null }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { Authorization: `Bearer ${T.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } })
  return { status: r.status, body: await r.json().catch(() => ({})), asOf: r.headers.get(COPY_AS_OF_HEADER) }
}
const list = async (): Promise<Array<{ id: string; title?: string }>> => (await call('/api/v1/conversations?limit=200')).body
const titles = async () => Object.fromEntries((await list()).map((c) => [c.id, c.title]))
const liveIndexFile = path.join(CONVERSATIONS_DIR, 'general', '_index.json')
const editsFile = path.join(WALNUT_HOME, 'cache', 'companion-conversation-edits.json')

beforeAll(async () => {
  await fs.mkdir(path.join(CONVERSATIONS_DIR, 'general'), { recursive: true })
  await fs.writeFile(liveIndexFile, JSON.stringify(boxIndex))
  for (const c of boxIndex.conversations) await fs.writeFile(path.join(CONVERSATIONS_DIR, 'general', `${c.id}.json`), JSON.stringify({ version: 2, entries: [] }))
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => { relay.fn = null })

describe('before any round', () => {
  it('the list is the box\'s own, and a lane chat the Mac does not answer for is 503', async () => {
    expect(Object.keys(await titles()).sort()).toEqual([LANE, MAIN, STALE].sort())
    const r = await call(`/api/v1/conversations/${LANE}/messages`)
    expect([r.status, r.body.error?.code, r.asOf]).toEqual([503, 'primary_unreachable', null])
  })
})

describe('a round of the conversation kinds', () => {
  it('lands both in the copy store and leaves the box\'s own conversations as they were', async () => {
    macConversations = [
      { agent: 'general', meta: meta(MAIN, 'Main', ago(30), { isMain: true }), active: true },
      { agent: 'general', meta: meta(LANE, 'Acme launch plan', ago(20)) },
      { agent: 'general', meta: meta(MAC_ONLY, 'Acme budget, from the Mac', ago(5)) },
    ]
    macBodies = [bodyRow('general', LANE, laneRows, ['turn-adopted-1']), bodyRow('general', MAIN, laneRows.slice(0, 4), [])]
    const before = await fs.readFile(liveIndexFile, 'utf8')
    const results = await round()
    expect(results.map((r) => `${r.kind}:${r.action}`).sort()).toEqual(['conversation-bodies:synced', 'conversations:synced'])
    expect(await fs.readFile(liveIndexFile, 'utf8')).toBe(before)
    const home = path.join(WALNUT_HOME, 'cache', 'replica', 'home')
    const copied = JSON.parse(await fs.readFile(path.join(home, 'conversations', 'general', '_index.json'), 'utf8'))
    expect(copied.conversations.map((c: ConversationMeta) => c.id).sort()).toEqual([LANE, MAC_ONLY, MAIN].sort())
    const body = JSON.parse(await fs.readFile(path.join(home, 'conversation-bodies', 'general', `${LANE}.json`), 'utf8'))
    expect([body.total, body.messages.length]).toEqual([120, 120])
    // A secret-shaped text never rests on the box as it was.
    expect(body.messages[119].text).toBe('Done: password=[REDACTED] is set')
    expect((await fs.stat(path.join(home, 'conversation-bodies', 'general', `${LANE}.json`))).mode & 0o777).toBe(0o600)
  })
})

describe('the list from the copy, with the box\'s own changes on top', () => {
  it('is the Mac\'s list: its new chat, without the one it deleted, with its titles', async () => {
    expect(await titles()).toEqual({ [MAIN]: 'Main', [LANE]: 'Acme launch plan', [MAC_ONLY]: 'Acme budget, from the Mac' })
  })

  it('a chat made here shows until the copy carries it, then the copy\'s row', async () => {
    const made = await call('/api/v1/conversations', { method: 'POST', body: JSON.stringify({ title: 'Acme from the phone' }) })
    expect(made.status).toBe(201)
    const id = made.body.id as string
    expect((await titles())[id]).toBe('Acme from the phone')
    // Messages of it are read too (it exists for the box while the copy lacks it).
    expect((await call(`/api/v1/conversations/${id}/messages`)).status).toBe(200)
    macConversations = [...macConversations, { agent: 'general', meta: meta(id, 'Acme from the phone, as the Mac titled it', ago(1)) }]
    await round()
    expect((await titles())[id]).toBe('Acme from the phone, as the Mac titled it')
    await new Promise((r) => setTimeout(r, 100))
    const edits = JSON.parse(await fs.readFile(editsFile, 'utf8').catch(() => '{"edits":[]}')).edits as Array<{ id: string }>
    expect(edits.map((e) => e.id)).not.toContain(id)
  })

  it('a rename and a pin made here show over the copy; a delete hides the copy\'s row', async () => {
    expect((await call(`/api/v1/conversations/${LANE}`, { method: 'PATCH', body: JSON.stringify({ title: 'Acme launch, renamed on the phone' }) })).status).toBe(200)
    expect((await call(`/api/v1/conversations/${LANE}`, { method: 'PATCH', body: JSON.stringify({ pinned: true }) })).status).toBe(200)
    // A chat the box lists from the copy only (git has not brought it): its own list takes the row first.
    expect((await call(`/api/v1/conversations/${MAC_ONLY}`, { method: 'DELETE' })).status).toBe(204)
    await round()
    const now = await titles()
    expect(now[LANE]).toBe('Acme launch, renamed on the phone')
    expect(now[MAC_ONLY]).toBeUndefined()
    // The v1 list carries no pin: the box's own reader does, main first, then the pin.
    const rows = await listConversations('general')
    expect(rows.find((c) => c.id === LANE)?.pinned).toBe(true)
    expect(rows.map((c) => c.id).slice(0, 2)).toEqual([MAIN, LANE])
  })

  it('the copy carrying the rename lets it go; the box\'s list losing the delete lets that go', async () => {
    macConversations = macConversations.map((r) => (r.meta.id === LANE ? { ...r, meta: { ...r.meta, title: 'Acme launch, renamed on the phone', pinned: true } } : r))
    await round()
    // Git sync gave the box the Mac's list, which still has MAC_ONLY: the Mac never took the delete.
    const live = JSON.parse(await fs.readFile(liveIndexFile, 'utf8'))
    live.conversations.push(meta(MAC_ONLY, 'Acme budget, from the Mac', ago(5)))
    await fs.writeFile(liveIndexFile, JSON.stringify(live))
    const now = await titles()
    expect(now[LANE]).toBe('Acme launch, renamed on the phone')
    expect(now[MAC_ONLY]).toBe('Acme budget, from the Mac')
    await new Promise((r) => setTimeout(r, 100))
    expect(await fs.readFile(editsFile, 'utf8').catch(() => null)).toBeNull()
  })
})

describe('one conversation while the Mac does not answer', () => {
  it('the Mac\'s rows and ids from the copy, with its age', async () => {
    const r = await call(`/api/v1/conversations/${LANE}/messages?limit=50`)
    expect(r.status).toBe(200)
    expect(Number(r.asOf)).toBeGreaterThan(0)
    expect(r.body.map((m: { id: string }) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => `m${70 + i}`))
    expect(r.body[0]).toMatchObject({ role: 'user', text: 'Acme step 70' })
    const older = await call(`/api/v1/conversations/${LANE}/messages?limit=50&before=m70`)
    expect(older.body.map((m: { id: string }) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => `m${20 + i}`))
  })

  it('a copy holding only the newest rows answers a page it holds whole, and 503 past them', async () => {
    // As a body over the size cap arrives: `total` names the whole list, the copy holds m60..m119.
    const full = bodyRow('general', LANE, laneRows, ['turn-adopted-1'])
    macBodies = [{ ...full, messages: full.messages.slice(60) }]
    await round()
    const held = await call(`/api/v1/conversations/${LANE}/messages?limit=50&before=m115`)
    expect(held.body.map((m: { id: string }) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => `m${65 + i}`))
    const past = await call(`/api/v1/conversations/${LANE}/messages?limit=50&before=m100`)
    expect([past.status, past.body.error?.code]).toEqual([503, 'primary_unreachable'])
  })

  it('a turn the box answered itself joins the tail until the copy names it', async () => {
    const turnId = crypto.randomUUID()
    await fs.mkdir(CLOUD_CHAT_OUTBOX_DIR, { recursive: true })
    const at = '2026-10-20T11:00:00.000Z'
    await fs.writeFile(path.join(CLOUD_CHAT_OUTBOX_DIR, `${turnId}.json`), JSON.stringify({
      v: 1, turnId, agentId: 'general', conversationId: LANE, userText: 'what is left for acme?', userAt: at,
      state: 'answered', answerText: 'Two steps are left.', answeredAt: at, bootId: 'b-other', updatedAt: at,
    }))
    const tail = (await call(`/api/v1/conversations/${LANE}/messages?limit=5`)).body as Array<{ id: string; text: string; answeredBy?: string }>
    expect(tail.slice(-2).map((m) => [m.text, m.answeredBy])).toEqual([['what is left for acme?', undefined], ['Two steps are left.', 'cloud']])
    expect(tail.map((m) => m.id)).toEqual(['m115', 'm116', 'm117', 'm118', 'm119', 'm120', 'm121'])
    // The Mac adopted it: its copy names the turn, which then shows once.
    const adopted = [...laneRows, { id: 'm120', role: 'user', text: 'what is left for acme?', createdAt: at }, { id: 'm121', role: 'assistant', text: 'Two steps are left.', createdAt: at, answeredBy: 'cloud' }]
    macBodies = [bodyRow('general', LANE, adopted, [turnId])]
    await round()
    const after = (await call(`/api/v1/conversations/${LANE}/messages?limit=5`)).body as Array<{ text: string }>
    expect(after.filter((m) => m.text === 'Two steps are left.')).toHaveLength(1)
    await fs.rm(CLOUD_CHAT_OUTBOX_DIR, { recursive: true, force: true })
  })

  it('while the Mac answers, its own answer, not the copy', async () => {
    relay.fn = (action) => (action === 'server.chat.messages' ? { ok: true, result: { messages: [{ id: 'm0', role: 'user', text: 'from the Mac, live', createdAt: ago(1) }], source: 'lane', known: true } } : undefined)
    const r = await call(`/api/v1/conversations/${LANE}/messages`)
    expect([r.status, r.asOf, r.body.map((m: { text: string }) => m.text)]).toEqual([200, null, ['from the Mac, live']])
  })
})
