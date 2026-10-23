/**
 * Stage 4d of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE server:
 * the box's reads that still looked at what git sync wrote into its data dir take the
 * Mac's copy, or answer needs-the-Mac, so git sync can stop writing there.
 *
 * Pinned, with the Mac away (no bridge: the box answers every call itself):
 *   - a letter body (`GET /api/v1/human-inbox/:id/body`, its Range and its framed form)
 *     comes from the `inbox-bodies` copy once it is held, and a body the copy lacks is
 *     relayed (here: 503 bridge_offline), never read from the folder git sync wrote;
 *     before the first round, that folder, as before;
 *   - a plugin's `letters.get` reads the Mac's copy of the inbox the same way;
 *   - the speech vocabulary: the `stt-vocab` copy kind lands in `cache/replica/`; then
 *     the transcriber's prompt, `GET /api/v1/stt/vocab` and `GET /api/stt/vocab` answer
 *     the Mac's words (with `x-walnut-copy-as-of`) and a word added there needs the Mac,
 *     the box's own file untouched; before the first round, the box's own file;
 *   - a board read with no boards copy (before the first round, and after the user
 *     turned boards off for the box) needs the Mac, never the board file git sync wrote;
 *   - a drain's conflict log needs the Mac (no copy of it exists).
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-away-reads', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { STT_VOCAB_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { copyKinds } from '../../../src/core/replication/kinds/index.js'
import { syncCopyKinds, type CopyKind, type CopyTarget } from '../../../src/core/replication/kinds/copy-kind.js'
import { COPY_AS_OF_HEADER } from '../../../src/core/replication/kinds/gate.js'
import { syncTaskReplica } from '../../../src/core/replication/task-replica.js'
import { sendLetter } from '../../../src/core/human-inbox/store.js'
import type { LetterRecord } from '../../../src/core/human-inbox/types.js'
import type { BoardFile } from '../../../src/core/boards/board-store.js'
import type { Task } from '../../../src/core/types.js'
import { loadVocabPrompt } from '../../../src/core/stt/index.js'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import { PluginContext, type PluginLogger } from '../../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../../src/core/plugins/server-api.js'
import { createTestPluginApi } from '../../core/plugin-test-utils.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const NOW = '2026-10-21T08:00:00.000Z'
const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

const BOARD_TASK = 'mbrd02-aaaa'
const board = (html: string, version: number) => ({
  task_id: BOARD_TASK, html, version, updated_at: NOW, updated_by: 'human', threads: {}, marks: {}, projects: {}, checks: {},
  choices: {}, reminders: {}, section_seen: {}, lanes: null, cards: {}, kanban_seen: null,
}) as BoardFile
const GIT_BOARD = JSON.stringify(board('<p>Acme plan, from git sync</p>', 1))
const BOX_VOCAB = '# box words\nBoxWord\n'

// The inbox git sync wrote (the box's own folder), and the Mac's copy of it.
const box: Record<'digest' | 'deploy' | 'only', LetterRecord> = {} as never
const BOX_BODY = { digest: 'Box digest body, from git sync', deploy: 'Box deploy body, from git sync', only: 'Box only body, from git sync' }
const MAC_BODY = { digest: 'Acme digest body, from the Mac', launch: 'Acme launch notes body, from the Mac' }
let macLetters: LetterRecord[] = []
let launchId = ''

const rowsOf: Record<string, () => Promise<unknown[]>> = {
  'stt-vocab': async () => [{ key: 'vocab', words: ['Acme', 'Kubernetes'] }],
  boards: async () => [board('<p>Acme plan, from the Mac</p>', 3)],
  inbox: async () => macLetters,
  // The deploy letter's body is not in the copy (as one over the copy's cap would not be).
  'inbox-bodies': async () => [{ name: `${box.digest.id}.md`, body: MAC_BODY.digest }, { name: `${launchId}.md`, body: MAC_BODY.launch }],
}
function macKinds(only: string[]): CopyKind<any>[] {
  return copyKinds().filter((k) => only.includes(k.kind)).map((k) => ({ ...k, watch: () => () => {}, rows: rowsOf[k.kind]! }))
}
const companion: CopyTarget = {
  id: 'companion', kind: 'companion', label: 'Cloud companion', available: async () => true,
  post: (payload, opts) => postToCloudReplica(payload, opts),
}

async function call(p: string, init: RequestInit = {}): Promise<{ status: number; text: string; body: Record<string, unknown>; headers: Headers }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    signal: AbortSignal.timeout(10_000),
    ...init,
    headers: { Authorization: `Bearer ${T.phone}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  const text = await r.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { /* a body document */ }
  return { status: r.status, text, body, headers: r.headers }
}
const post = (p: string, json: unknown) => call(p, { method: 'POST', body: JSON.stringify(json) })
const why = (r: { body: Record<string, unknown> }) => (r.body.error as { code?: string; why?: string } | undefined)

const logger: PluginLogger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn(() => logger) }
let plugin: ReturnType<typeof createServerPluginApi>
let pluginContext: PluginContext

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000e5', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000f6', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await fs.mkdir(path.join(WALNUT_HOME, 'boards'), { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'boards', `${BOARD_TASK}.json`), GIT_BOARD)
  await fs.mkdir(path.dirname(STT_VOCAB_FILE), { recursive: true })
  await fs.writeFile(STT_VOCAB_FILE, BOX_VOCAB)
  // A drain's conflict log, as git sync once brought it.
  await fs.mkdir(path.join(WALNUT_HOME, 'offline-conflicts'), { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'offline-conflicts', 'd-acme-1.json'), JSON.stringify({ v: 2, drainId: 'd-acme-1', hostKey: 'devbox', home: '/home/acme', startedAt: NOW }))
  const sender = { sessionId: 'sess-box', host: 'workstation' }
  box.digest = await sendLetter({ subject: 'Box digest', type: 'review', markdown: BOX_BODY.digest, sender })
  box.deploy = await sendLetter({ subject: 'Box deploy', type: 'completion', markdown: BOX_BODY.deploy, sender })
  box.only = await sendLetter({ subject: 'Box only', type: 'completion', markdown: BOX_BODY.only, sender })
  launchId = box.only.id.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))
  macLetters = [
    { ...box.digest, subject: 'Acme digest, from the Mac', bodyBytes: bytes(MAC_BODY.digest) },
    { ...box.deploy, subject: 'Acme deploy, from the Mac' },
    { ...box.only, id: launchId, subject: 'Acme launch notes, from the Mac', bodyBytes: bytes(MAC_BODY.launch) },
  ]
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
  const task = { id: BOARD_TASK, title: 'Acme launch', status: 'todo', phase: 'TODO', priority: 'none', project: 'Acme', source: 'local', session_ids: [], description: '', summary: '', note: '', created_at: NOW, updated_at: NOW } as Task
  await syncTaskReplica({ view: async () => ({ tasks: [task], registry: { projects: { Acme: { source: 'local' as const, order_index: 0 } }, task_groups: {}, custom_tiers: [] } }), post: postToCloudReplica })
  pluginContext = new PluginContext({ id: 'mail', dataDir: path.join(WALNUT_HOME, 'plugin-data', 'mail'), logger })
  const { api: legacyApi, collected } = createTestPluginApi({ id: 'mail', name: 'mail' })
  plugin = createServerPluginApi({ context: pluginContext, pluginName: 'mail', legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
}, 60_000)

afterAll(async () => {
  await pluginContext?.dispose().catch(() => {})
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('before any round (an older Mac): the box\'s own files where it keeps them', () => {
  it('a letter body and a plugin\'s letter come from the folder git sync wrote', async () => {
    const body = await call(`/api/v1/human-inbox/${box.digest.id}/body`)
    expect([body.status, body.text]).toEqual([200, BOX_BODY.digest])
    expect((await plugin.letters.get(box.only.id))?.subject).toBe('Box only')
  })

  it('the vocabulary is the box\'s own file, and a word added goes there', async () => {
    const v = await call('/api/v1/stt/vocab')
    expect([v.status, v.body]).toEqual([200, { words: ['BoxWord'] }])
    expect(v.headers.get(COPY_AS_OF_HEADER)).toBeNull()
    expect(await loadVocabPrompt()).toBe('BoxWord')
    expect((await post('/api/v1/stt/vocab', { word: 'BoxTwo' })).body).toMatchObject({ added: true, word: 'BoxTwo' })
    expect(await fs.readFile(STT_VOCAB_FILE, 'utf8')).toBe(`${BOX_VOCAB}BoxTwo\n`)
  })

  it('a board needs the Mac: no copy, and the git file is not read instead', async () => {
    const b = await call(`/api/v1/tasks/${BOARD_TASK}/board`)
    expect([b.status, why(b)?.code, why(b)?.why]).toEqual([503, 'needs_leader', 'kind_not_copied'])
    expect((await call(`/api/v1/tasks/${BOARD_TASK}/board/owner`)).status).toBe(503)
  })

  it('a conflict log needs the Mac, though git sync once brought it here', async () => {
    const c = await call('/api/v1/offline-conflicts/d-acme-1')
    expect([c.status, why(c)?.code, why(c)?.why]).toEqual([503, 'needs_leader', 'conflict_log_needs_mac'])
    expect((await call('/api/v1/offline-conflicts/not-a-drain')).status).toBe(400)
  })
})

describe('a round from the Mac', () => {
  it('sends the vocabulary, the boards and the inbox; the vocabulary lands in the copy store, the box\'s file as it was', async () => {
    const before = await fs.readFile(STT_VOCAB_FILE, 'utf8')
    const results = await syncCopyKinds(macKinds(['stt-vocab', 'boards', 'inbox', 'inbox-bodies']), { targets: () => [companion] })
    expect(results.map((r) => `${r.kind}:${r.action}`).sort()).toEqual(['boards:synced', 'inbox-bodies:synced', 'inbox:synced', 'stt-vocab:synced'])
    expect(await fs.readFile(STT_VOCAB_FILE, 'utf8')).toBe(before)
    const state = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'cache', 'replica', 'stt-vocab.json'), 'utf8')) as { rows: Record<string, unknown> }
    expect(state.rows).toEqual({ vocab: { key: 'vocab', words: ['Acme', 'Kubernetes'] } })
  })
})

describe('the Mac away, with the copies held', () => {
  it('a letter body is the copy\'s, whole, by Range and framed', async () => {
    const whole = await call(`/api/v1/human-inbox/${box.digest.id}/body`)
    expect([whole.status, whole.text, whole.headers.get('x-walnut-body-bytes')]).toEqual([200, MAC_BODY.digest, String(bytes(MAC_BODY.digest))])
    const part = await call(`/api/v1/human-inbox/${box.digest.id}/body`, { headers: { Range: 'bytes=0-3' } })
    expect([part.status, part.text, part.headers.get('content-range')]).toEqual([206, 'Acme', `bytes 0-3/${bytes(MAC_BODY.digest)}`])
    const framed = await call(`/api/v1/human-inbox/${box.digest.id}/body?frame=1`)
    expect([framed.status, framed.text]).toEqual([200, MAC_BODY.digest])
    // The framed markdown response ends: the next request on its keep-alive socket is answered.
    expect((await call(`/api/v1/human-inbox/${box.digest.id}/body`)).status).toBe(200)
    expect((await call(`/api/v1/human-inbox/${launchId}/body`)).text).toBe(MAC_BODY.launch)
  })

  it('a body the copy lacks is relayed (the Mac is away: 503), never read from git sync\'s folder', async () => {
    for (const id of [box.deploy.id, box.only.id]) {
      const r = await call(`/api/v1/human-inbox/${id}/body`)
      expect([id, r.status, why(r)?.code]).toEqual([id, 503, 'bridge_offline'])
      expect(r.text).not.toContain('from git sync')
    }
  })

  it('a plugin\'s letters.get reads the Mac\'s copy', async () => {
    expect((await plugin.letters.get(box.digest.id))?.subject).toBe('Acme digest, from the Mac')
    expect((await plugin.letters.get(launchId))?.subject).toBe('Acme launch notes, from the Mac')
    expect(await plugin.letters.get(box.only.id)).toBeNull()
  })

  it('the vocabulary is the Mac\'s: the transcriber\'s prompt, both GETs (with the copy\'s age)', async () => {
    expect(await loadVocabPrompt()).toBe('Acme, Kubernetes')
    const v1 = await call('/api/v1/stt/vocab')
    expect([v1.status, v1.body]).toEqual([200, { words: ['Acme', 'Kubernetes'] }])
    expect(Number(v1.headers.get(COPY_AS_OF_HEADER))).toBeGreaterThan(0)
    const web = await call('/api/stt/vocab')
    expect([web.status, web.body.words, web.body.path]).toEqual([200, ['Acme', 'Kubernetes'], path.join('config', 'share', 'stt-vocab.txt')])
    expect(Number(web.headers.get(COPY_AS_OF_HEADER))).toBeGreaterThan(0)
  })

  it('a word added on the box needs the Mac, and the box\'s own file is not written', async () => {
    const before = await fs.readFile(STT_VOCAB_FILE, 'utf8')
    for (const p of ['/api/v1/stt/vocab', '/api/stt/vocab']) {
      const r = await post(p, { word: 'Marina' })
      expect([p, r.status, why(r)?.code, why(r)?.why]).toEqual([p, 503, 'needs_leader', 'stt_vocab_writes_need_mac'])
    }
    expect(await fs.readFile(STT_VOCAB_FILE, 'utf8')).toBe(before)
    // A bad request is still a bad request.
    expect((await post('/api/v1/stt/vocab', { word: ' ' })).status).toBe(400)
  })

  it('a board is the Mac\'s copy; the user turning boards off for the box makes it need the Mac again', async () => {
    const b = await call(`/api/v1/tasks/${BOARD_TASK}/board`)
    expect([b.status, (b.body.board as { html: string } | null)?.html]).toEqual([200, '<p>Acme plan, from the Mac</p>'])
    const off = await syncCopyKinds(macKinds(['boards']), { targets: () => [{ ...companion, copies: async () => ({ boards: false }) }] })
    expect(off.map((r) => `${r.kind}:${r.error}`)).toEqual(['boards:kind_not_copied'])
    const after = await call(`/api/v1/tasks/${BOARD_TASK}/board`)
    // Turned off by the user: kept only on the Mac (4f), not "not copied yet".
    expect([after.status, why(after)?.why]).toEqual([503, 'not_kept_here'])
    expect(await fs.readFile(path.join(WALNUT_HOME, 'boards', `${BOARD_TASK}.json`), 'utf8')).toBe(GIT_BOARD)
  })

  it('a conflict log still needs the Mac', async () => {
    expect((await call('/api/v1/offline-conflicts/d-acme-1')).status).toBe(503)
  })
})
