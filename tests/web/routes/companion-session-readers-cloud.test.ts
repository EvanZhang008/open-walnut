/**
 * Stage 2c of docs/plan/walnut-companion-unified-replica.md, the readers, on a real
 * CLOUD_MODE server: every companion reader of the session projection reads the
 * box's copies of the Mac's sessions and model catalogs once it holds them, and
 * the box tells the Mac it no longer reads the pushed projection. The Mac's rounds
 * go over the real client (copy-kind.ts syncCopyKinds, postToCloudReplica) and its
 * pushes over the real ingest client (cloud-ingest.ts postToCloudIngest).
 *
 * Pinned:
 *   - before a round: the pushed projection answers every reader (recent
 *     sessions, the events snapshot, the model picker with the pushed catalogs,
 *     the stop fence, the session's host and its name), and the box answers the
 *     push as before (`sent`);
 *   - after a round of sessions and config only (an older Mac, or the catalogs
 *     kind resting): the readers read the copy, the picker still takes the pushed
 *     catalogs, and the box still answers the push as read;
 *   - with the catalogs copy too: the picker takes the copied catalog, the stop a
 *     Mac row carries reaches the stop fence and the host lookup, and the box
 *     answers the sessions push `unread` (still writing it) and every other push
 *     as before;
 *   - a purge (the Mac turned the sessions choice off for the box) drops both
 *     copies: the readers go back to the pushed projection and the push is read again;
 *   - a copy that cannot be read: the readers take the pushed projection, and the
 *     box says it reads the push again, so the Mac keeps it coming.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-session-readers-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudIngest, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { copyKinds } from '../../../src/core/replication/kinds/index.js'
import { syncCopyKinds, type CopyKind, type CopyTarget } from '../../../src/core/replication/kinds/copy-kind.js'
import { COPY_AS_OF_HEADER } from '../../../src/core/replication/kinds/gate.js'
import { configCopyRows } from '../../../src/core/replication/config-allowlist.js'
import { readProjectionCache } from '../../../src/core/projection-cache.js'
import { syncTaskReplica } from '../../../src/core/replication/task-replica.js'
import { companionCopyFile } from '../../../src/core/replication/kinds/sessions.js'
import { closeCompanionSessionCopy } from '../../../src/core/session-db.js'
import { getModelCopy } from '../../../src/core/sessions/model-options-copy.js'
import { projectedStops } from '../../../src/core/sessions/cloud-stop-fence.js'
import { resolveCloudSessionHost } from '../../../src/core/sessions/cloud-session-host.js'
import { sessionHostName } from '../../../src/web/routes/session-stop-v1.js'
import type { SessionRecord, Task } from '../../../src/core/types.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const TASK = 'mrds01-aaaa'
const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
const STOP = { id: 'stop-acme-1', requestedAt: ago(0.01), state: 'pending' as const }

const macSessions: SessionRecord[] = [
  { claudeSessionId: 's-devbox', taskId: TASK, project: 'Acme', process_status: 'running', mode: 'default', startedAt: ago(1), lastActiveAt: ago(0.02), messageCount: 4, host: 'devbox', cwd: '/work/acme', cliModel: 'sonnet[1m]', effort: 'medium', stopRequest: STOP, pid: 4242 },
  { claudeSessionId: 's-mac', taskId: '', project: 'Acme', process_status: 'idle', mode: 'default', startedAt: ago(2), lastActiveAt: ago(0.5), messageCount: 2, model: 'opus' },
  { claudeSessionId: 's-old', taskId: '', project: 'Acme', process_status: 'stopped', mode: 'default', startedAt: ago(30), lastActiveAt: ago(20), messageCount: 1, host: 'devbox' },
] as unknown as SessionRecord[]
const macConfig = { hosts: { devbox: { label: 'Dev box', enabled: true } } }
const COPIED_MODELS = [
  { value: 'sonnet[1m]', displayName: 'Sonnet (1M)', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
]

/** The Mac's push of its sessions projection: one row, the catalogs the push used to carry. */
function pushed(title: string): Record<string, unknown> {
  return {
    version: 1, exportedAt: new Date().toISOString(),
    sessions: [{ id: 's-pushed', title, host: 'devbox', process_status: 'idle', started_at: ago(1), last_active_at: ago(0.1), message_count: 1, cli_model: 'pushed-model' }],
    host_model_catalogs: { devbox: { fetchedAt: ago(1), models: [{ value: 'pushed-model', displayName: 'Pushed model' }] } },
  }
}
const pushSessions = (data: Record<string, unknown>) => postToCloudIngest('projection-upsert', JSON.stringify({ which: 'sessions', data }))

/** The Mac's kinds (`only` of them), their rows from the test's Mac. */
function macKinds(only: string[]): CopyKind<any>[] {
  const rowsOf: Record<string, () => Promise<unknown[]>> = {
    sessions: async () => macSessions,
    config: async () => configCopyRows(macConfig).rows,
    'model-catalogs': async () => [{ key: 'devbox', models: COPIED_MODELS, fetchedAt: ago(0.5) }],
  }
  return copyKinds().filter((k) => only.includes(k.kind)).map((k) => ({ ...k, watch: () => () => {}, rows: rowsOf[k.kind]! }))
}

let copies: Record<string, boolean> = {}
const companion: CopyTarget = {
  id: 'companion', kind: 'companion', label: 'Cloud companion',
  available: async () => true,
  copies: async () => copies,
  post: (payload, opts) => postToCloudReplica(payload, opts),
}

async function recent(): Promise<{ ids: string[]; asOf: string | null; rows: Array<Record<string, unknown>> }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/recent?limit=20`, { headers: { Authorization: `Bearer ${T.phone}` } })
  expect(r.status).toBe(200)
  const rows = ((await r.json()) as { sessions: Array<Record<string, unknown>> }).sessions
  return { ids: rows.map((s) => String(s.id)), asOf: r.headers.get(COPY_AS_OF_HEADER), rows }
}

/** The session ids of the events feed's first snapshot frame. */
async function snapshotIds(): Promise<string[]> {
  const ac = new AbortController()
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { headers: { Authorization: `Bearer ${T.phone}` }, signal: ac.signal })
  expect(r.status).toBe(200)
  const reader = r.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const m = /event: snapshot\ndata: (.*)\n\n/.exec(buf)
      if (m) return (JSON.parse(m[1]!) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)
    }
  } finally {
    ac.abort()
  }
  throw new Error('no snapshot frame')
}

const pickerIds = async (sid: string) => (await getModelCopy().modelOptions(sid))?.models.map((m) => m.id) ?? null

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000e5', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000f6', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
  const task = { id: TASK, title: 'Acme launch', status: 'todo', phase: 'IN_PROGRESS', priority: 'none', project: 'Acme', source: 'local', session_ids: [], description: '', summary: '', note: '', created_at: now, updated_at: now } as Task
  await syncTaskReplica({ view: async () => ({ tasks: [task], registry: { projects: { Acme: { source: 'local' as const, order_index: 0 } }, task_groups: {}, custom_tiers: [] } }), post: postToCloudReplica })
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('before a round: the pushed projection', () => {
  it('the box takes the push as before, and every reader answers from it', async () => {
    expect(await pushSessions(pushed('Pushed once'))).toBe('sent')
    expect((await recent())).toMatchObject({ ids: ['s-pushed'], asOf: null })
    expect(await snapshotIds()).toEqual(['s-pushed'])
    expect(await pickerIds('s-pushed')).toEqual(['pushed-model'])
    expect(await pickerIds('s-devbox')).toBeNull()
    expect((await projectedStops()).get('s-pushed')).toBeNull()
    expect(await resolveCloudSessionHost('s-pushed')).toMatchObject({ host: 'devbox' })
  })
})

describe('a round of sessions and config, no model catalogs yet', () => {
  it('the readers read the copy; the picker keeps the pushed catalogs; the push is still read', async () => {
    const results = await syncCopyKinds(macKinds(['sessions', 'config']), { targets: () => [companion] })
    expect(results.map((r) => `${r.kind}:${r.action}`).sort()).toEqual(['config:synced', 'sessions:synced'])
    const r = await recent()
    expect(r.ids).toEqual(['s-devbox', 's-mac'])
    expect(Number(r.asOf)).toBeGreaterThan(0)
    expect(r.rows[0]).toMatchObject({ task_title: 'Acme launch', host_label: 'Dev box', cli_model: 'sonnet[1m]' })
    expect(await snapshotIds()).toEqual(['s-devbox', 's-mac'])
    // The row is the copy's; its host's catalog is still the one the push carried.
    expect(await pickerIds('s-devbox')).toEqual(['pushed-model'])
    expect(await pushSessions(pushed('Pushed twice'))).toBe('sent')
  })
})

describe('with the model catalogs copy too', () => {
  it('the picker takes the copied catalog, with the copy\'s round as its age', async () => {
    const results = await syncCopyKinds(macKinds(['sessions', 'config', 'model-catalogs']), { targets: () => [companion] })
    expect(results.find((r) => r.kind === 'model-catalogs')?.action).toBe('synced')
    const opts = await getModelCopy().modelOptions('s-devbox')
    expect(opts).toMatchObject({ current: 'sonnet[1m]', currentEffort: 'medium', offline: true })
    expect(opts!.models.map((m) => m.id)).toEqual(['sonnet[1m]', 'haiku'])
    expect(opts!.asOf).toBe(new Date(Number((await recent()).asOf)).toISOString())
    // A session on the Mac itself: no catalog for it, the static list.
    expect(await pickerIds('s-mac')).not.toContain('pushed-model')
  })

  it('a Mac row\'s stop reaches the stop fence and the host lookup; the host is named by its label', async () => {
    expect((await projectedStops()).get('s-devbox')).toEqual(STOP)
    expect(await resolveCloudSessionHost('s-devbox')).toMatchObject({ host: 'devbox', hostLabel: 'Dev box', cwd: '/work/acme', stopRequest: STOP })
    expect(await sessionHostName('s-devbox')).toContain('Dev box')
    // The pushed row is gone from every reader: the copy is the one source now.
    // (Not listed: asked of the Mac, which this test has none of.)
    const gone = await resolveCloudSessionHost('s-pushed').catch((err: unknown) => err as { host?: string })
    expect(gone?.host).toBeUndefined()
  })

  it('the box answers the sessions push `unread`, still writes it, and answers every other push as before', async () => {
    expect(await pushSessions(pushed('Pushed, unread'))).toBe('unread')
    const file = await readProjectionCache('sessions') as { sessions: Array<{ title?: string }> }
    expect(file.sessions[0]?.title).toBe('Pushed, unread')
    // The readers did not move back to it.
    expect((await recent()).ids).toEqual(['s-devbox', 's-mac'])
    expect(await postToCloudIngest('projection-upsert', JSON.stringify({ which: 'tasks', data: { version: 2, exportedAt: new Date().toISOString(), tasks: [] } }))).toBe('sent')
    expect(await postToCloudIngest('transcript-upsert', JSON.stringify({ sid: 's-devbox', data: { version: 1, sessionId: 's-devbox', exportedAt: 'x', truncated: false, messages: [] } }))).toBe('sent')
  })
})

describe('a purge: the Mac turned the sessions choice off for the box', () => {
  it('drops both copies; the box routes by the pushed projection again, but never shows it while the Mac is away (4f)', async () => {
    copies = { sessions: false }
    try {
      const off = await syncCopyKinds(macKinds(['sessions', 'config', 'model-catalogs']), { targets: () => [companion] })
      expect(off.filter((r) => r.kind !== 'config').map((r) => `${r.kind}:${r.error}`).sort()).toEqual(['model-catalogs:kind_not_copied', 'sessions:kind_not_copied'])
      // Not kept here, the Mac away: the list needs it, the event snapshot carries none.
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/recent?limit=20`, { headers: { Authorization: `Bearer ${T.phone}` } })
      expect([r.status, ((await r.json()) as { error?: { why?: string } }).error?.why]).toEqual([503, 'not_kept_here'])
      expect(await snapshotIds()).toEqual([])
      // The box's own readers (a session's host, its model picker) take the push.
      expect(await resolveCloudSessionHost('s-pushed')).toMatchObject({ host: 'devbox' })
      expect(await pickerIds('s-pushed')).toEqual(['pushed-model'])
      expect(await pushSessions(pushed('Pushed after the purge'))).toBe('sent')
    } finally {
      copies = {}
    }
  })
})

describe('a copy that cannot be read', () => {
  it('the readers take the pushed projection, and the box reads the push again', async () => {
    await syncCopyKinds(macKinds(['sessions', 'config', 'model-catalogs']), { targets: () => [companion] })
    expect(await pushSessions(pushed('Pushed, unread again'))).toBe('unread')
    closeCompanionSessionCopy()
    for (const f of [companionCopyFile(), `${companionCopyFile()}-wal`, `${companionCopyFile()}-shm`]) await fs.rm(f, { force: true })
    await fs.writeFile(companionCopyFile(), 'not a database')
    expect((await recent())).toMatchObject({ ids: ['s-pushed'], asOf: null })
    expect(await snapshotIds()).toEqual(['s-pushed'])
    expect(await pushSessions(pushed('Pushed, copy broken'))).toBe('sent')
    expect((await recent()).rows[0]?.title).toBe('Pushed, copy broken')
  })
})
