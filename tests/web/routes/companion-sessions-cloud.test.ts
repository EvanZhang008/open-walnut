/**
 * Stage 2c of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE
 * server: the Mac's sessions reach the companion as the `sessions` copy kind (the
 * Mac's round, copy-kind.ts syncCopyKinds, over the real client and the real
 * /bridge/replica door), into the box's copy store, and the phone's session list
 * (GET /api/v1/sessions) is built from it (core/companion-sessions.ts).
 *
 * Pinned:
 *   - before a round, the list is the pushed projection, with no copy header;
 *   - after one, the list is the Mac's projection over the copy: the same
 *     eligibility (live, or stopped in the last 14 days; never archived), newest
 *     first, the task title from the box's task copy, the host label from its
 *     config copy, and the `x-walnut-copy-as-of` header;
 *   - the copy is a file of its own under `cache/replica/home/`: the box's live
 *     registry (the sessions it runs itself) gets none of the Mac's rows, and no
 *     stored row names a process;
 *   - a later round's changes (a status, a new row, a removal) show at once, from
 *     the rows the box keeps parsed, and a write that lands while those rows are
 *     being parsed is not lost;
 *   - a purge (the Mac turned the kind off for the companion) puts the pushed list back.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-sessions-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { copyKinds } from '../../../src/core/replication/kinds/index.js'
import { syncCopyKinds, type CopyKind, type CopyTarget } from '../../../src/core/replication/kinds/copy-kind.js'
import { COPY_AS_OF_HEADER } from '../../../src/core/replication/kinds/gate.js'
import { configCopyRows } from '../../../src/core/replication/config-allowlist.js'
import { companionCopyFile } from '../../../src/core/replication/kinds/sessions.js'
import { applyCompanionSessionCopy, closeCompanionSessionCopy, companionSessionCopyIds, readCompanionSessionCopy, sessionIdsInStore } from '../../../src/core/session-db.js'
import { writeProjectionCache } from '../../../src/core/projection-cache.js'
import { syncTaskReplica } from '../../../src/core/replication/task-replica.js'
import type { SessionRecord, Task } from '../../../src/core/types.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const TASK = 'mses01-aaaa'
const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

function session(id: string, over: Partial<SessionRecord> & Record<string, unknown> = {}): SessionRecord {
  return {
    claudeSessionId: id, taskId: '', project: 'Acme', process_status: 'running', mode: 'default',
    startedAt: ago(1), lastActiveAt: ago(0.5), messageCount: 3, title: `Session ${id}`, host: 'devbox', cwd: '/work/acme',
    ...over,
  } as SessionRecord
}

let macSessions: SessionRecord[] = []
const macConfig = { hosts: { devbox: { label: 'Dev box', enabled: true } } }

/** The Mac's sessions and config kinds, their rows from the test's Mac. */
function macKinds(): CopyKind<any>[] {
  const rowsOf: Record<string, () => Promise<unknown[]>> = {
    sessions: async () => macSessions,
    config: async () => configCopyRows(macConfig).rows,
  }
  return copyKinds().filter((k) => rowsOf[k.kind]).map((k) => ({ ...k, watch: () => () => {}, rows: rowsOf[k.kind]! }))
}

/** The Mac's choice of kinds for the companion (its Settings row). */
let copies: Record<string, boolean> = {}
const companion: CopyTarget = {
  id: 'companion', kind: 'companion', label: 'Cloud companion',
  available: async () => true,
  copies: async () => copies,
  post: (payload, opts) => postToCloudReplica(payload, opts),
}

async function list(): Promise<{ status: number; ids: string[]; rows: Array<Record<string, unknown>>; body: Record<string, unknown>; asOf: string | null }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, { headers: { Authorization: `Bearer ${T.phone}` } })
  const body = await r.json().catch(() => ({})) as Record<string, unknown>
  const rows = (body.sessions ?? []) as Array<Record<string, unknown>>
  return { status: r.status, ids: rows.map((s) => String(s.id)), rows, body, asOf: r.headers.get(COPY_AS_OF_HEADER) }
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
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
  // The pushed projection (the old path): one session.
  await writeProjectionCache('sessions', {
    version: 1, exportedAt: now,
    sessions: [{ id: 's-pushed', title: 'Pushed', project: 'Acme', process_status: 'running', last_active_at: now }],
  })
  // The task one session works for, in this box's task copy (as the Mac sends it).
  const task = { id: TASK, title: 'Acme launch', status: 'todo', phase: 'IN_PROGRESS', priority: 'none', project: 'Acme', source: 'local', session_ids: [], description: '', summary: '', note: '', created_at: now, updated_at: now } as Task
  await syncTaskReplica({ view: async () => ({ tasks: [task], registry: { projects: { Acme: { source: 'local' as const, order_index: 0 } }, task_groups: {}, custom_tiers: [] } }), post: postToCloudReplica })
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('before a round', () => {
  it('the list is the pushed projection, with no copy header', async () => {
    const r = await list()
    expect([r.status, r.ids, r.asOf]).toEqual([200, ['s-pushed'], null])
  })
})

describe('the Mac\'s rounds', () => {
  it('a first round: the list is the Mac\'s projection over the copy', async () => {
    macSessions = [
      session('s-run', { taskId: TASK, lastActiveAt: ago(0.1), pid: 4242, outputFile: '/tmp/s-run.jsonl' }),
      session('s-stopped-recent', { process_status: 'stopped', lastActiveAt: ago(2) }),
      session('s-archived', { archived: true }),
      session('s-stopped-20d', { process_status: 'stopped', lastActiveAt: ago(20) }),
      session('s-stopped-60d', { process_status: 'stopped', lastActiveAt: ago(60) }),
      session('s-error-no-active', { process_status: 'error', lastActiveAt: '', startedAt: ago(3) }),
    ]
    const results = await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect(results.map((r) => `${r.kind}:${r.action}`).sort()).toEqual(['config:synced', 'sessions:synced'])
    const r = await list()
    expect(r.status).toBe(200)
    // Live first by activity; the 20-day stop is past the list's 14 days; archived never.
    expect(r.ids).toEqual(['s-run', 's-stopped-recent', 's-error-no-active'])
    expect(Number(r.asOf)).toBeGreaterThan(0)
    expect(r.body.syncedAt).toBe(new Date(Number(r.asOf)).toISOString())
    const run = r.rows.find((s) => s.id === 's-run')!
    expect(run).toMatchObject({ task_id: TASK, task_title: 'Acme launch', host: 'devbox', host_label: 'Dev box', process_status: 'running' })
  })

  it('the copy is a file of its own: the box\'s live registry has none of the Mac\'s rows, and no stored row names a process', async () => {
    const copied = companionSessionCopyIds(companionCopyFile()).sort()
    expect(copied).toEqual(macSessions.map((s) => s.claudeSessionId).sort())
    expect(sessionIdsInStore().filter((id) => copied.includes(id))).toEqual([])
    const stored = (await readCompanionSessionCopy(companionCopyFile())).find((s) => s.claudeSessionId === 's-run') as unknown as Record<string, unknown>
    expect(stored.pid).toBeUndefined()
    expect(stored.outputFile).toBeUndefined()
    expect(companionCopyFile()).toBe(path.join(WALNUT_HOME, 'cache', 'replica', 'home', 'sessions.sqlite'))
  })

  it('a later round\'s changes show at once: a status, a new row, a removal', async () => {
    macSessions = [
      session('s-run', { taskId: TASK, process_status: 'stopped', lastActiveAt: ago(0.05) }),
      session('s-new', { lastActiveAt: ago(0.01), title: 'Fresh work' }),
      session('s-archived', { archived: true }),
      session('s-stopped-20d', { process_status: 'stopped', lastActiveAt: ago(20) }),
      session('s-stopped-60d', { process_status: 'stopped', lastActiveAt: ago(60) }),
    ]
    const results = await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect(results.find((r) => r.kind === 'sessions')?.action).toBe('synced')
    const r = await list()
    expect(r.ids).toEqual(['s-new', 's-run'])
    expect(r.rows.find((s) => s.id === 's-run')?.process_status).toBe('stopped')
    expect(r.rows.find((s) => s.id === 's-new')?.title).toBe('Fresh work')
    // An unarchived row the Mac un-archives comes back.
    macSessions = macSessions.map((s) => (s.claudeSessionId === 's-archived' ? { ...s, archived: false, lastActiveAt: ago(0.001) } : s))
    await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect((await list()).ids).toEqual(['s-archived', 's-new', 's-run'])
  })

  it('a new process reads the copy back from disk', async () => {
    closeCompanionSessionCopy()
    expect((await list()).ids).toEqual(['s-archived', 's-new', 's-run'])
  })

  it('a write that lands while the rows are being parsed is not lost', async () => {
    // Enough rows that the parse yields to the loop between slices.
    applyCompanionSessionCopy(companionCopyFile(), { rows: Array.from({ length: 160 }, (_, i) => session(`s-bulk-${i}`, { lastActiveAt: ago(5) })) })
    closeCompanionSessionCopy()
    const reading = readCompanionSessionCopy(companionCopyFile())
    applyCompanionSessionCopy(companionCopyFile(), { rows: [session('s-mid-parse', { lastActiveAt: ago(0) })], removeIds: ['s-bulk-0'] })
    const ids = (await reading).map((s) => s.claudeSessionId)
    // The read began before the write; the write must still be in the rows from here on.
    const after = (await readCompanionSessionCopy(companionCopyFile())).map((s) => s.claudeSessionId)
    expect(after).toContain('s-mid-parse')
    expect(after).not.toContain('s-bulk-0')
    expect(ids.length).toBeGreaterThan(150)
    applyCompanionSessionCopy(companionCopyFile(), { removeIds: [...Array.from({ length: 160 }, (_, i) => `s-bulk-${i}`), 's-mid-parse'] })
  })

  it('a purge (the Mac turned the kind off here): the list holds the box\'s own sessions only, said partial, never the pushed one (4f)', async () => {
    copies = { sessions: false }
    const off = await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect(off.find((r) => r.kind === 'sessions')).toMatchObject({ action: 'unsupported', error: 'kind_not_copied', removed: 5 })
    expect(companionSessionCopyIds(companionCopyFile())).toEqual([])
    const l = await list()
    expect([l.status, (l.body.partial as { why?: string } | undefined)?.why, l.ids]).toEqual([200, 'not_kept_here', []])
    // Turned on again: the next round fills it again.
    copies = {}
    await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect((await list()).ids).toEqual(['s-archived', 's-new', 's-run'])
  })
})
