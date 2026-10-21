/**
 * Stage 3e of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE
 * server, the write half: a chat turn the companion answers itself while the Mac does
 * not answer (routes/cloud-chat-fallback.ts) is a `chat-turn` record in its journal
 * once the Mac drains that kind (core/companion-chat-turns.ts), and the box's reads
 * show it until the Mac's copy names it.
 *
 * Pinned:
 *   - before the Mac ever drained, and for an older Mac whose drain names no `chat-turn`,
 *     the turn stays in the outbox (cloud-chat-outbox.ts), as before;
 *   - a Mac that drains the kind: the turn is one record (op id `chat-<turnId>`, its words
 *     and answer as bodies), its outbox file is gone, and an outbox file already there
 *     stays for the old hand-over;
 *   - the conversation read shows the journaled turn, the list moves the conversation up;
 *   - after the Mac's ack the turn still shows, until a copy round whose conversation
 *     names its turn id, and then once.
 *
 * Real: the server, the api-v1 routes, the turn queue, runLaneTurn, the companion lane,
 * the journal and its door (machine credential), the copy door. Mocked: constants (temp
 * dirs); the 'session-runner' bus subscriber (answers like a `claude` CLI, never spawns
 * one); the CLI probe; the relay to the Mac, which never answers.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-chat-journal-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))
// The Mac never answers: every relay is provably not sent.
vi.mock('../../../src/web/routes/v1-control-relay.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/web/routes/v1-control-relay.js')>()),
  callPrimaryControl: async () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge for host: __local__', notSent: true } }),
}))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudJournal, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { resetCloudExecCache } from '../../../src/core/cloud-owned-session.js'
import { _setCloudChatCliProbeForTesting } from '../../../src/web/routes/cloud-chat-fallback.js'
import { listCloudTurns } from '../../../src/core/cloud-chat-outbox.js'
import { companionJournalRecords, macDrains } from '../../../src/core/companion-journal.js'
import { APPLIED_V2_KINDS } from '../../../src/core/offline-merge/apply-v2.js'
import { createConversation } from '../../../src/core/conversations.js'
import { syncCopyKinds, type CopyTarget } from '../../../src/core/replication/kinds/copy-kind.js'
import { CONVERSATION_BODIES_KIND, bodyRow, type ConversationBodyRow } from '../../../src/core/replication/kinds/conversation-bodies.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'

const EXEC_ROOT = `${WALNUT_HOME}-exec-root`
let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const MAC_HOME = '/Users/someone/.open-walnut'

/** Answers like a `claude` CLI would, never spawns one (as api-v1-chat-cloud-fallback.test.ts). */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    if (event.name === EventNames.SESSION_START) sid = (event.data as SessionStartEvent).preassignedSessionId
    else if (event.name === EventNames.SESSION_SEND) sid = (event.data as SessionSendEvent).sessionId
    if (!sid) return
    void (async () => {
      try {
        const batch = await markProcessing(sid!)
        if (batch.length > 0) await removeProcessed(sid!, batch.map((m) => m.id))
      } catch { /* torn down */ }
    })()
    setTimeout(() => {
      bus.emit(EventNames.SESSION_RESULT, { sessionId: sid!, result: 'Two steps are left.', isError: false }, ['main-ai', 'session-runner'], { source: 'session-runner' as const })
    }, 10)
  })
}

async function call(p: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { Authorization: `Bearer ${T.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function until<V>(fn: () => Promise<V | null | undefined | false> | V | null | undefined | false, what: string, ms = 20_000): Promise<V> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v as V
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** One phone turn the companion answers itself; resolves with its turn id once it ended. */
async function awayTurn(conversationId: string, text: string): Promise<string> {
  const posted = await call(`/api/v1/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ text }) })
  expect(posted.status).toBe(202)
  const turnId = posted.body.turnId as string
  await until(async () => companionJournalRecords().some((r) => r.turnId === turnId)
    || (await listCloudTurns()).some((e) => e.turnId === turnId && e.state !== 'running'), `turn ${turnId} to end`)
  return turnId
}
const messages = async (conversationId: string) => (await call(`/api/v1/conversations/${conversationId}/messages`)).body as Array<{ role: string; text: string; answeredBy?: string }>
const drainKinds = (kinds: readonly string[]) => postToCloudJournal('offline.drain', { home: MAC_HOME, kinds: [...kinds] })

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.mkdir(EXEC_ROOT, { recursive: true })
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
  installFakeRunner()
  _setCloudChatCliProbeForTesting(() => true)
}, 90_000)

afterAll(async () => {
  _setCloudChatCliProbeForTesting(null)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(EXEC_ROOT, { recursive: true, force: true }).catch(() => {})
})

let older = ''
let conv = ''

describe('a Mac that does not drain chat turns', () => {
  it('before any drain, the turn stays in the outbox', async () => {
    conv = (await createConversation('general', 'Acme launch')).id
    expect(macDrains('chat-turn')).toBe(false)
    older = await awayTurn(conv, 'what is left for acme?')
    expect((await listCloudTurns()).find((e) => e.turnId === older)).toMatchObject({ state: 'answered', answerText: 'Two steps are left.' })
    expect(companionJournalRecords().filter((r) => r.kind === 'chat-turn')).toEqual([])
  }, 60_000)

  it('an older Mac, whose drain names no chat-turn: the outbox too', async () => {
    expect(await drainKinds(APPLIED_V2_KINDS.filter((k) => k !== 'chat-turn'))).toMatchObject({ ok: true })
    expect(macDrains('chat-turn')).toBe(false)
    const t = await awayTurn(conv, 'and the vendor?')
    expect((await listCloudTurns()).some((e) => e.turnId === t)).toBe(true)
    expect(companionJournalRecords().filter((r) => r.kind === 'chat-turn')).toEqual([])
  }, 60_000)
})

describe('a Mac that drains chat turns', () => {
  let turnId = ''
  it('the turn is one record with its texts as bodies; its outbox file goes, the older ones stay', async () => {
    expect(await drainKinds(APPLIED_V2_KINDS)).toMatchObject({ ok: true })
    expect(macDrains('chat-turn')).toBe(true)
    const listedBefore = (await call('/api/v1/conversations?limit=200')).body.find((c: { id: string }) => c.id === conv).updatedAt as string
    turnId = await awayTurn(conv, 'and the budget?')
    const recs = companionJournalRecords().filter((r) => r.kind === 'chat-turn')
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ turnId, opId: `chat-${turnId}`, agentId: 'general', conversationId: conv })
    expect(recs[0].blobs).toEqual([recs[0].userBlob, recs[0].answerBlob])
    expect(JSON.stringify(recs[0])).not.toContain('budget')
    const outbox = (await listCloudTurns()).map((e) => e.turnId)
    expect(outbox).not.toContain(turnId)
    expect(outbox).toContain(older)
    // Every read shows it; the list moves the conversation up.
    const rows = await messages(conv)
    expect(rows.slice(-2).map((m) => [m.role, m.text, m.answeredBy])).toEqual([['user', 'and the budget?', undefined], ['assistant', 'Two steps are left.', 'cloud']])
    expect(rows.filter((m) => m.text === 'what is left for acme?')).toHaveLength(1)
    const listed = (await call('/api/v1/conversations?limit=200')).body.find((c: { id: string }) => c.id === conv).updatedAt as string
    expect(listed > listedBefore).toBe(true)
  }, 60_000)

  it('after the Mac\'s ack it still shows, until a copy round names it, then once', async () => {
    const drained = await drainKinds(APPLIED_V2_KINDS)
    const seqs = (drained.records as Array<{ seq: number; kind: string }>).filter((r) => r.kind === 'chat-turn').map((r) => r.seq)
    expect(seqs).toHaveLength(1)
    expect(await postToCloudJournal('offline.ack', { home: MAC_HOME, seqs, now: Date.now() })).toMatchObject({ ok: true, remaining: 0 })
    expect(companionJournalRecords()).toEqual([])
    expect((await messages(conv)).filter((m) => m.text === 'and the budget?')).toHaveLength(1)
    // The Mac's copy of the conversation, with the adopted turn and its id.
    const at = new Date().toISOString()
    const macRows = [
      { id: 'm0', role: 'user', text: 'and the budget?', createdAt: at }, { id: 'm1', role: 'assistant', text: 'Two steps are left.', createdAt: at, answeredBy: 'cloud' },
    ]
    const body: ConversationBodyRow = bodyRow('general', conv, macRows, [turnId])
    const target: CopyTarget = { id: 'companion', kind: 'companion', label: 'Cloud companion', available: async () => true, post: (p, o) => postToCloudReplica(p, o) }
    const results = await syncCopyKinds([{ ...CONVERSATION_BODIES_KIND, watch: () => () => {}, rows: async () => [body], keep: () => [] }], { targets: () => [target] })
    expect(results.map((r) => r.action)).toEqual(['synced'])
    const rows = await messages(conv)
    expect(rows.filter((m) => m.text === 'and the budget?')).toHaveLength(1)
    // The older outbox turns are not in the Mac's copy yet: they still show, from the outbox.
    expect(rows.filter((m) => m.text === 'what is left for acme?')).toHaveLength(1)
  }, 60_000)
})
