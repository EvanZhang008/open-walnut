/**
 * Stage 4d of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE server,
 * the box's half of the chat list and the chat lane (the Mac's half:
 * tests/core/offline-merge/drain-companion-conversations.test.ts).
 *
 * Pinned:
 *   - before the Mac drains `conversation-edit` (an older Mac), a list change makes no
 *     record: git sync carries the box's list, as before;
 *   - a Mac that drains it: a create, rename, pin or delete through the v1 routes and
 *     the console routes is one record, a rename or pin carrying the title or pin the
 *     box showed (the Mac's copy, not the box's own list), and the list shows it at once;
 *   - after the Mac's ack the change still shows until a copy round from after the ack
 *     (a round from before it does not count), and then the copy is the word, also when
 *     the Mac kept its own name; at most ten minutes without such a round;
 *   - one conversation without the Mac: the messages route and the console history never
 *     read the chat history git sync wrote here; with no copy of a chat that has
 *     messages they answer that it needs the Mac, a chat made here is its own turns,
 *     and the console history reads the copy once held;
 *   - a clear or a compaction, console and v1: 503 `chat_changes_need_mac`, nothing changes;
 *   - the companion's lane seeds from the copy (the Mac's summary ahead, the rows it
 *     covers left out), catches up from it, and takes the skills index and the memory
 *     from the Mac's copies, never from this box's disk or git's chat history;
 *   - a record the journal refuses (it is full): the change is not made here either.
 *
 * Real: the server, the v1 and console routes, the journal and its door (machine
 * credential), the copy door, the turn queue and the companion lane. Mocked: constants
 * (temp dirs); the bridge config (the copy round's address); the 'session-runner' bus
 * subscriber (answers like a `claude` CLI, never spawns one); the CLI probe; the relay
 * to the Mac, which never answers.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-conversation-edits-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))
vi.mock('../../../src/web/routes/v1-control-relay.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/web/routes/v1-control-relay.js')>()),
  callPrimaryControl: async () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge for host: __local__', notSent: true } }),
}))

import { CONFIG_FILE, CONVERSATIONS_DIR, GLOBAL_SKILLS_DIR, MEMORY_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudJournal, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { resetCloudExecCache } from '../../../src/core/cloud-owned-session.js'
import { _setCloudChatCliProbeForTesting } from '../../../src/web/routes/cloud-chat-fallback.js'
import { companionJournalRecords, journalConversationEdit, macDrains } from '../../../src/core/companion-journal.js'
import { APPLIED_V2_KINDS } from '../../../src/core/offline-merge/apply-v2.js'
import { listConversations } from '../../../src/core/conversations.js'
import { syncCopyKinds, type CopyKind, type CopyTarget } from '../../../src/core/replication/kinds/copy-kind.js'
import { CONVERSATIONS_KIND, type ConversationRow } from '../../../src/core/replication/kinds/conversations.js'
import { CONVERSATION_BODIES_KIND, bodyRow, type ConversationBodyRow } from '../../../src/core/replication/kinds/conversation-bodies.js'
import { _resetHostReplicaForTesting, syncCompanionHostReplica } from '../../../src/core/host-replica.js'
import { companionCopyHolds } from '../../../src/core/companion-host-replica.js'
import { listCloudTurns } from '../../../src/core/cloud-chat-outbox.js'
import { CATCH_UP_BANNER_OPEN } from '../../../src/core/chat-history.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'
import type { ConversationMeta } from '../../../src/core/types.js'

const EXEC_ROOT = `${WALNUT_HOME}-exec-root`
const MAC_HOME = '/Users/someone/.open-walnut'
let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const starts: SessionStartEvent[] = []
const sends: SessionSendEvent[] = []

const MAIN = 'conv-acme-main', PLAN = 'conv-acme-plan', BUDGET = 'conv-acme-budget', VENDORS = 'conv-acme-vendors', OLD = 'conv-acme-old'
function meta(id: string, title: string, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return { id, agentId: 'general', title, createdAt: ago(600), lastMessageAt: ago(60), messageCount: 2, lastDistilledAt: null, lastDistilledMessageCount: 0, ...extra }
}
// The box's own list, as git sync last wrote it (VENDORS is newer than git).
const boxIndex = { version: 1, activeConversationId: MAIN, conversations: [
  meta(MAIN, 'Main', { isMain: true }), meta(PLAN, 'Acme plan (git title)'), meta(BUDGET, 'Acme budget'), meta(OLD, 'Acme old notes'),
] }
// The chat history git sync wrote for PLAN: never an answer on this box again.
const gitPlan = { version: 2, compactionCount: 0, compactionSummary: null, entries: [
  { tag: 'ai', role: 'user', content: 'the git codeword is plover', timestamp: ago(90) },
  { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'Noted: plover.' }], timestamp: ago(89) },
] }
let macList: ConversationRow[] = [
  { agent: 'general', meta: meta(MAIN, 'Main', { isMain: true }), active: true },
  { agent: 'general', meta: meta(PLAN, 'Acme plan') }, { agent: 'general', meta: meta(BUDGET, 'Acme budget') },
  { agent: 'general', meta: meta(VENDORS, 'Acme vendors') }, { agent: 'general', meta: meta(OLD, 'Acme old notes') },
]
let macBodies: ConversationBodyRow[] = []
const planRows: Array<Record<string, unknown>> = []
const planSummary: { summary: string; summaryAt?: string } = { summary: 'Summary: the Acme kickoff is done.' }

const companion: CopyTarget = { id: 'companion', kind: 'companion', label: 'Cloud companion', available: async () => true, post: (p, o) => postToCloudReplica(p, o) }
const listKind = (): CopyKind<any> => ({ ...CONVERSATIONS_KIND, watch: () => () => {}, rows: async () => macList, keep: () => [] })
const bodiesKind = (): CopyKind<any> => ({ ...CONVERSATION_BODIES_KIND, watch: () => () => {}, rows: async () => macBodies, keep: () => [] })
async function round(kind: CopyKind<any>, now?: () => number): Promise<void> {
  const r = await syncCopyKinds([kind], { targets: () => [companion], ...(now ? { now } : {}) })
  // 'unchanged': the same rows, and the follower holds them as of this round all the same.
  expect(r.map((x) => x.action === 'unchanged' ? 'synced' : x.action)).toEqual(['synced'])
}

async function call(p: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { Authorization: `Bearer ${T.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } })
  return { status: r.status, body: r.status === 204 ? {} : await r.json().catch(() => ({})) }
}
const send = (method: string, p: string, body?: unknown) => call(p, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
const rows = async () => Object.fromEntries((await listConversations('general')).map((c) => [c.id, { title: c.title, pinned: !!c.pinned }]))
const edits = () => companionJournalRecords().filter((r) => r.kind === 'conversation-edit')
const drainAll = (kinds: readonly string[] = APPLIED_V2_KINDS) => postToCloudJournal('offline.drain', { home: MAC_HOME, kinds: [...kinds] })
const editsFile = path.join(WALNUT_HOME, 'cache', 'companion-conversation-edits.json')
const gitPlanFile = path.join(CONVERSATIONS_DIR, 'general', `${PLAN}.json`)
async function until<V>(fn: () => Promise<V | null | undefined | false> | V | null | undefined | false, what: string, ms = 20_000): Promise<V> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v as V
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}
/** The Mac drains and acks every waiting record, its clock `macNow`. */
async function drainAndAck(macNow = Date.now()): Promise<void> {
  const drained = await drainAll()
  const seqs = (drained.records as Array<{ seq: number }>).map((r) => r.seq)
  expect(await postToCloudJournal('offline.ack', { home: MAC_HOME, seqs, now: macNow })).toMatchObject({ ok: true, remaining: 0 })
}

beforeAll(async () => {
  await fs.mkdir(path.join(CONVERSATIONS_DIR, 'general'), { recursive: true })
  await fs.mkdir(EXEC_ROOT, { recursive: true })
  await fs.writeFile(path.join(CONVERSATIONS_DIR, 'general', '_index.json'), JSON.stringify(boxIndex))
  for (const c of boxIndex.conversations) await fs.writeFile(path.join(CONVERSATIONS_DIR, 'general', `${c.id}.json`), JSON.stringify({ version: 2, entries: [] }))
  await fs.writeFile(gitPlanFile, JSON.stringify(gitPlan))
  await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, user: { name: 'Ada' }, cloud: { exec: { enabled: true, cwd_roots: [EXEC_ROOT] } } }))
  resetCloudExecCache()
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
  // Answers like a `claude` CLI would, never spawns one.
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    if (event.name === EventNames.SESSION_START) { starts.push(event.data as SessionStartEvent); sid = (event.data as SessionStartEvent).preassignedSessionId }
    else if (event.name === EventNames.SESSION_SEND) { sends.push(event.data as SessionSendEvent); sid = (event.data as SessionSendEvent).sessionId }
    if (!sid) return
    void (async () => {
      try {
        const batch = await markProcessing(sid!)
        if (batch.length > 0) await removeProcessed(sid!, batch.map((m) => m.id))
      } catch { /* torn down */ }
    })()
    setTimeout(() => bus.emit(EventNames.SESSION_RESULT, { sessionId: sid!, result: 'Two steps are left.', isError: false }, ['main-ai', 'session-runner'], { source: 'session-runner' as const }), 10)
  })
  _setCloudChatCliProbeForTesting(() => true)
  await round(listKind())
}, 90_000)

afterAll(async () => {
  _setCloudChatCliProbeForTesting(null)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(EXEC_ROOT, { recursive: true, force: true }).catch(() => {})
})

describe('an older Mac', () => {
  it('before the Mac drains conversation-edit, a list change makes no record', async () => {
    expect(await drainAll(APPLIED_V2_KINDS.filter((k) => k !== 'conversation-edit'))).toMatchObject({ ok: true })
    expect(macDrains('conversation-edit')).toBe(false)
    expect((await send('PATCH', `/api/v1/conversations/${OLD}`, { pinned: true })).status).toBe(200)
    expect(edits()).toEqual([])
    // Shown from the box's own list, which git sync carries to the Mac (stage 3e).
    expect((await rows())[OLD]).toEqual({ title: 'Acme old notes', pinned: true })
  })
})

describe('a Mac that drains conversation-edit', () => {
  let hiring = '', travel = ''
  it('each route makes one record, with the title or pin the box showed', async () => {
    expect(await drainAll()).toMatchObject({ ok: true })
    expect(macDrains('conversation-edit')).toBe(true)
    hiring = (await send('POST', '/api/v1/conversations', { title: 'Acme hiring' })).body.id
    travel = (await send('POST', '/api/agents/general/conversations', { title: 'Acme travel' })).body.conversation.id
    expect((await send('PATCH', `/api/v1/conversations/${PLAN}`, { title: 'Acme plan, v2' })).status).toBe(200)
    expect((await send('PATCH', `/api/agents/general/conversations/${VENDORS}`, { pinned: true })).status).toBe(200)
    expect((await send('DELETE', `/api/v1/conversations/${BUDGET}`)).status).toBe(204)
    expect((await send('PATCH', `/api/agents/general/conversations/${hiring}`, { title: 'Acme hiring, final' })).status).toBe(200)
    expect(edits().map((r) => [r.op, r.conversationId, r.title, r.pinned, r.base])).toEqual([
      ['create', hiring, 'Acme hiring', undefined, undefined],
      ['create', travel, 'Acme travel', undefined, undefined],
      // The Mac's title from the copy, not the one git left in the box's own list.
      ['rename', PLAN, 'Acme plan, v2', undefined, { title: 'Acme plan' }],
      // A chat only the copy lists (git never brought it) has a row to land on.
      ['pin', VENDORS, undefined, true, { pinned: false }],
      ['delete', BUDGET, undefined, undefined, undefined],
      ['rename', hiring, 'Acme hiring, final', undefined, { title: 'Acme hiring' }],
    ])
    expect(await rows()).toMatchObject({
      [hiring]: { title: 'Acme hiring, final' }, [travel]: { title: 'Acme travel' },
      [PLAN]: { title: 'Acme plan, v2' }, [VENDORS]: { pinned: true },
    })
    expect((await rows())[BUDGET]).toBeUndefined()
  })

  it('after the ack each change shows until a copy round from after it, then the copy is the word', async () => {
    const ackAt = Date.now()
    await drainAndAck(ackAt)
    expect(edits()).toEqual([])
    const shown = await rows()
    expect([shown[PLAN]?.title, shown[hiring]?.title, shown[BUDGET]]).toEqual(['Acme plan, v2', 'Acme hiring, final', undefined])
    // A round the Mac read before it took the changes: still the box's changes.
    await round(listKind(), () => ackAt - 1)
    expect((await rows())[PLAN]?.title).toBe('Acme plan, v2')
    expect((await rows())[hiring]?.title).toBe('Acme hiring, final')
    // The Mac's list after it applied them; it kept its own name for PLAN (a person renamed it there).
    macList = [
      ...macList.filter((r) => r.meta.id !== BUDGET && r.meta.id !== PLAN && r.meta.id !== VENDORS),
      { agent: 'general', meta: meta(PLAN, 'Acme plan, Mac') }, { agent: 'general', meta: meta(VENDORS, 'Acme vendors', { pinned: true }) },
      { agent: 'general', meta: meta(hiring, 'Acme hiring, final', { messageCount: 0 }) }, { agent: 'general', meta: meta(travel, 'Acme trip (titled on the Mac)', { messageCount: 0 }) },
    ]
    await round(listKind())
    // A made chat's title is no rename: the Mac's own title shows once it lists the chat.
    expect(await rows()).toMatchObject({
      [PLAN]: { title: 'Acme plan, Mac' }, [VENDORS]: { pinned: true }, [hiring]: { title: 'Acme hiring, final' }, [travel]: { title: 'Acme trip (titled on the Mac)' },
    })
    expect((await rows())[BUDGET]).toBeUndefined()
    await until(async () => {
      const raw = await fs.readFile(editsFile, 'utf8').catch(() => '{"edits":[]}')
      return !(JSON.parse(raw).edits as Array<{ seq?: number }>).some((e) => e.seq !== undefined)
    }, 'the acked changes to be let go')
  })

  it('a change the Mac took shows at most ten minutes without such a round', async () => {
    expect((await send('PATCH', `/api/v1/conversations/${travel}`, { title: 'Acme travel, Lisbon' })).status).toBe(200)
    await drainAndAck()
    expect((await rows())[travel]?.title).toBe('Acme travel, Lisbon')
    const file = JSON.parse(await fs.readFile(editsFile, 'utf8')) as { edits: Array<{ id: string; ackedAt?: number }> }
    for (const e of file.edits) if (e.id === travel) e.ackedAt = Date.now() - 11 * 60_000
    await fs.writeFile(editsFile, JSON.stringify(file))
    expect((await rows())[travel]?.title).toBe('Acme trip (titled on the Mac)')
  })

  it('a chat made here that the Mac lists already (a turn reached it): its title, while the record waits', async () => {
    const id = (await send('POST', '/api/v1/conversations', { title: 'Acme pending' })).body.id as string
    macList = [...macList, { agent: 'general', meta: meta(id, 'Acme pending, titled on the Mac') }]
    await round(listKind())
    expect(edits().some((r) => r.conversationId === id)).toBe(true)
    // The title it was made with is no rename.
    expect((await rows())[id]?.title).toBe('Acme pending, titled on the Mac')
    await drainAndAck()
  })
})

describe('one conversation while the Mac does not answer', () => {
  it('no copy of a chat with messages: 503 on both readers; a chat made here is its own turns', async () => {
    const made = (await send('POST', '/api/v1/conversations', { title: 'Acme fresh' })).body.id as string
    expect(await call(`/api/v1/conversations/${PLAN}/messages`)).toMatchObject({ status: 503, body: { error: { code: 'primary_unreachable' } } })
    expect(await call(`/api/v1/conversations/${made}/messages`)).toEqual({ status: 200, body: [] })
    const history = await call(`/api/chat/history?agentId=general&conversationId=${PLAN}`)
    expect([history.status, history.body.error?.why]).toEqual([503, 'chat_history_needs_mac'])
    const fresh = await call(`/api/chat/history?agentId=general&conversationId=${made}`)
    expect([fresh.status, fresh.body.messages]).toEqual([200, []])
  })

  it('the console history reads the copy once held, never git\'s chat history', async () => {
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
    planRows.push(
      { id: 'm0', role: 'user', text: 'the covered codeword is wren', createdAt: at(30) },
      { id: 'm1', role: 'assistant', text: 'Noted: wren.', createdAt: at(29) },
      { id: 'm2', role: 'user', text: 'the copy codeword is heron', createdAt: at(20) },
      { id: 'm3', role: 'assistant', text: 'Noted: heron.', createdAt: at(19) },
    )
    // The Mac compacted the first turn: its summary covers the rows up to m1.
    planSummary.summaryAt = planRows[1].createdAt as string
    macBodies = [bodyRow('general', PLAN, planRows, [], planSummary)]
    await round(bodiesKind())
    const r = await call(`/api/chat/history?agentId=general&conversationId=${PLAN}`)
    expect(r.status).toBe(200)
    const text = JSON.stringify(r.body.messages)
    expect(text).toContain('the copy codeword is heron')
    expect(text).not.toContain('plover')
  })

  it('a clear or a compaction needs the Mac, console and v1, and nothing changes', async () => {
    for (const p of ['/api/chat/clear', '/api/chat/compact', '/api/v1/chat/clear', '/api/v1/chat/compact']) {
      const r = await send('POST', `${p}?agentId=general&conversationId=${PLAN}`, {})
      expect({ p, status: r.status, why: r.body.error?.why }).toEqual({ p, status: 503, why: 'chat_changes_need_mac' })
    }
    expect(JSON.parse(await fs.readFile(gitPlanFile, 'utf8')).entries).toHaveLength(2)
  })
})

describe('the companion lane', () => {
  it('seeds from the copy and takes the skills and memory from the Mac\'s copies', async () => {
    await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true })
    await fs.writeFile(MEMORY_FILE, '# Memory\n\n- Acme launch is on Friday\n')
    await fs.mkdir(path.join(GLOBAL_SKILLS_DIR, 'acme-tool'), { recursive: true })
    await fs.writeFile(path.join(GLOBAL_SKILLS_DIR, 'acme-tool', 'SKILL.md'), '---\nname: acme-tool\ndescription: How to run the Acme tool\n---\n# Acme tool\n')
    _resetHostReplicaForTesting()
    await syncCompanionHostReplica()
    expect([companionCopyHolds('skills'), companionCopyHolds('memory')]).toEqual([true, true])
    // The box's disk moves on: the lane reads the copies, not it.
    await fs.writeFile(MEMORY_FILE, '# Memory\n\n- Disk only memory\n')
    await fs.rm(path.join(GLOBAL_SKILLS_DIR, 'acme-tool'), { recursive: true })
    await fs.mkdir(path.join(GLOBAL_SKILLS_DIR, 'box-only-tool'), { recursive: true })
    await fs.writeFile(path.join(GLOBAL_SKILLS_DIR, 'box-only-tool', 'SKILL.md'), '---\nname: box-only-tool\ndescription: Only on this box\n---\n# Box\n')

    const first = await send('POST', `/api/v1/conversations/${PLAN}/messages`, { text: 'what is left?' })
    expect(first.status).toBe(202)
    const start = await until(() => starts[0], 'the lane to start')
    const prompt = start.profile?.systemPrompt ?? ''
    expect(prompt).toContain('Summary: the Acme kickoff is done.')
    expect(prompt).toContain('the copy codeword is heron')
    expect(prompt).not.toContain('wren') // covered by the summary
    expect(prompt).not.toContain('plover') // git's chat history
    expect(prompt).toContain('acme-tool')
    expect(prompt).not.toContain('box-only-tool')
    expect(prompt).toContain('Acme launch is on Friday')
    expect(prompt).not.toContain('Disk only memory')
    await until(async () => companionJournalRecords().some((r) => r.turnId === first.body.turnId)
      || (await listCloudTurns()).some((e) => e.turnId === first.body.turnId && e.state !== 'running'), 'the first turn to end')

    // The Mac answered a turn in between: the next send carries it, from the copy.
    const now = Date.now()
    planRows.push(
      { id: 'm4', role: 'user', text: 'asked on the Mac', createdAt: new Date(now - 2000).toISOString() },
      { id: 'm5', role: 'assistant', text: 'the Mac codeword is ibis', createdAt: new Date(now - 1000).toISOString() },
    )
    macBodies = [bodyRow('general', PLAN, planRows, [], planSummary)]
    await round(bodiesKind())
    const second = await send('POST', `/api/v1/conversations/${PLAN}/messages`, { text: 'and now?' })
    expect(second.status).toBe(202)
    const next = await until(() => sends[0], 'the second send')
    expect(next.message).toContain(CATCH_UP_BANNER_OPEN)
    expect(next.message).toContain('the Mac codeword is ibis')
    expect(next.message).not.toContain('plover')
    expect(next.message.endsWith('and now?')).toBe(true)
    await until(async () => companionJournalRecords().some((r) => r.turnId === second.body.turnId)
      || (await listCloudTurns()).some((e) => e.turnId === second.body.turnId && e.state !== 'running'), 'the second turn to end')
  }, 90_000)
})

describe('a record the journal refuses', () => {
  it('the journal is full: the change is not made here either, and it needs the Mac', async () => {
    while (companionJournalRecords().length < 1000) {
      expect(journalConversationEdit({ agentId: 'general', conversationId: OLD, op: 'pin', pinned: true, base: { pinned: true } })).toMatchObject({ ok: true })
    }
    const before = await rows()
    const renamed = await send('PATCH', `/api/v1/conversations/${VENDORS}`, { title: 'Acme vendors, refused' })
    expect([renamed.status, renamed.body.error?.why]).toEqual([503, 'conversation_edit_queue_full'])
    const made = await send('POST', '/api/agents/general/conversations', { title: 'Acme refused' })
    expect([made.status, made.body.error?.why]).toEqual([503, 'conversation_edit_queue_full'])
    expect(await rows()).toEqual(before)
    const own = JSON.parse(await fs.readFile(path.join(CONVERSATIONS_DIR, 'general', '_index.json'), 'utf8')) as { conversations: ConversationMeta[] }
    expect(own.conversations.map((c) => c.title)).not.toContain('Acme vendors, refused')
    expect(own.conversations.map((c) => c.title)).not.toContain('Acme refused')
  }, 60_000)
})
