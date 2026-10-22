/**
 * Stage 4d of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE
 * server: the files the box itself used to write for the Mac (notifications.json,
 * cron-jobs.json for the Mac's jobs, ui-prefs.json) get one owner, the Mac, without
 * git. The Mac is a fake behind the relay seam (callPrimaryControl); the copies come
 * over the real copy client (syncCopyKinds, postToCloudReplica).
 *
 * Pinned:
 *   - notifications: the console's feed is the Mac's while it answers, the box's
 *     waiting cards on top; while it is away, what the box has, marked `offline`;
 *     mark-read and dismiss run on the Mac, and need it (503) while it is away; a
 *     card the box makes reaches the Mac, and the data dir's notifications.json is
 *     byte for byte what git sync wrote;
 *   - routines: before a copy, the list relays (503 away); with the copy, the list,
 *     one routine and the status are the copy's; create, patch and Run now run on
 *     the Mac (its refusal is its own status), and need it while it is away; the
 *     box's cron-jobs.json never changes;
 *   - ui-prefs: GET is the box's file before a copy and the Mac's prefs after, with
 *     the copy's age; PUT is merged on the Mac and needs it while it is away; the
 *     box's file never changes;
 *   - the Ask Walnut launch memory is the personas copy's.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-owner-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; failure: Record<string, unknown> }
const mac = { up: false, old: false, calls: [] as Array<{ action: string; params: any }> }
const ok = (result: Record<string, unknown>): Reply => ({ ok: true, result })
const OFFLINE: Reply = { ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge', notSent: true } }
const MAC_FEED = [
  { id: 'n-mac-1', kind: 'cron', severity: 'info', title: 'Acme digest sent', dedupKey: 'cron:acme', timestamp: 1_000, read: false },
  { id: 'n-mac-2', kind: 'operation-error', severity: 'error', title: 'Mac backup failing', dedupKey: 'error:backup', timestamp: 2_000, read: true },
]
function fakeMac(action: string, params: any): Reply {
  mac.calls.push({ action, params })
  if (!mac.up) return OFFLINE
  switch (action) {
    case 'server.notifications': return ok({ feed: MAC_FEED, unreadCount: 1 })
    case 'server.notifications.mark': return ok({ unreadCount: 0 })
    case 'server.notifications.dismiss': return ok({ unreadCount: 1, removed: 1 })
    case 'server.notifications.cards':
      return mac.old
        ? { ok: false, failure: { kind: 'needs_upgrade', message: 'The primary box predates this mobile action' } }
        : ok({ applied: params.cards.length, skipped: 0, refused: [] })
    case 'server.routines': return ok({ jobs: [{ id: 'rt-acme-relayed', name: 'Acme relayed' }] })
    case 'server.routines.create': return ok({ job: { id: 'rt-acme-new', ...params.body } })
    case 'server.routines.patch': return { ok: false, failure: { kind: 'error', status: 400, code: 'bad_request', message: 'Invalid patch input.' } }
    case 'server.routines.run': return ok({ result: { ok: true, ran: params.id } })
    case 'server.ui-prefs.put': return ok({ ok: true })
    default: return OFFLINE
  }
}
vi.mock('../../../src/web/routes/v1-control-relay.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/web/routes/v1-control-relay.js')>()),
  callPrimaryControl: async (action: string, _sid: string, params: unknown) => fakeMac(action, params),
}))

import { CRON_FILE, UI_PREFS_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { copyKinds } from '../../../src/core/replication/kinds/index.js'
import { syncCopyKinds, type CopyKind, type CopyTarget } from '../../../src/core/replication/kinds/copy-kind.js'
import { COPY_AS_OF_HEADER } from '../../../src/core/replication/kinds/gate.js'
import { readRoutineRows } from '../../../src/core/replication/kinds/routines.js'
import type { PersonaRow } from '../../../src/core/replication/kinds/personas.js'
import type { PrefsRow } from '../../../src/core/replication/kinds/prefs.js'
import { addNotification } from '../../../src/core/notifications/store.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
let macDir = ''

const SHARED_FEED = path.join(WALNUT_HOME, 'notifications.json')
// What git sync last brought from the Mac.
const GIT_FEED = JSON.stringify({ version: 1, notifications: [
  { id: 'n-mac-1', kind: 'cron', severity: 'info', title: 'Acme digest sent (git)', dedupKey: 'cron:acme', timestamp: 1_000, read: false },
] })
const BOX_JOBS = JSON.stringify({ version: 2, jobs: [] })
const BOX_PREFS = JSON.stringify({ 'open-walnut-panel-width': { v: '300', ts: 5 } })

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; body: any; asOf: string | null }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { Authorization: `Bearer ${T.phone}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => ({})), asOf: r.headers.get(COPY_AS_OF_HEADER) }
}
const sent = (action: string) => mac.calls.filter((c) => c.action === action)
// The box's own error cards (a test box runs niced, say) ride the same path; the cases name theirs.
const named = (feed: Array<{ dedupKey: string }>) => feed.filter((n) => !n.dedupKey.startsWith('logerr:'))

function job(id: string, name: string): Record<string, unknown> {
  return {
    id, name, enabled: true, createdAtMs: 1_000, updatedAtMs: 2_000,
    schedule: { kind: 'every', everyMs: 3_600_000 }, sessionTarget: 'main', wakeMode: 'next-heartbeat',
    payload: { kind: 'systemEvent', text: name },
  }
}

/** The routines, prefs and personas kinds, their rows from the test's Mac. */
function macKinds(): CopyKind<any>[] {
  const persona: PersonaRow = { key: 'general', agentId: 'general', name: 'Walnut', systemPrompt: 'You are Walnut.', systemPromptMode: 'append', launchModel: 'opus', launchEffort: 'high' }
  const rowsOf: Record<string, () => Promise<unknown[]>> = {
    routines: () => readRoutineRows(path.join(macDir, 'cron-jobs.json'), path.join(macDir, 'cron-state.json')),
    prefs: async () => [{ key: 'ui:open-walnut-panel-width', pref: { v: '520', ts: 40 } }, { key: 'favorites', favorites: { projects: ['Acme'], notes: [] } }] satisfies PrefsRow[],
    personas: async () => [persona],
  }
  return copyKinds().filter((k) => rowsOf[k.kind]).map((k) => ({ ...k, watch: () => () => {}, rows: rowsOf[k.kind] }))
}
const companion: CopyTarget = { id: 'companion', kind: 'companion', label: 'Cloud companion', available: async () => true, post: (payload, opts) => postToCloudReplica(payload, opts) }
const boxFiles = () => Promise.all([fs.readFile(SHARED_FEED, 'utf8'), fs.readFile(CRON_FILE, 'utf8'), fs.readFile(UI_PREFS_FILE, 'utf8')])

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  macDir = path.join(WALNUT_HOME, '..', `${path.basename(WALNUT_HOME)}-mac`)
  await fs.mkdir(macDir, { recursive: true })
  await fs.writeFile(path.join(macDir, 'cron-jobs.json'), JSON.stringify({ version: 2, jobs: [job('rt-acme-digest', 'Acme digest'), job('rt-acme-watch', 'Acme watch')] }))
  await fs.writeFile(path.join(macDir, 'cron-state.json'), JSON.stringify({ version: 1, states: {} }))
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c5', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d6', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await fs.writeFile(SHARED_FEED, GIT_FEED)
  await fs.mkdir(path.dirname(CRON_FILE), { recursive: true })
  await fs.writeFile(CRON_FILE, BOX_JOBS)
  await fs.mkdir(path.dirname(UI_PREFS_FILE), { recursive: true })
  await fs.writeFile(UI_PREFS_FILE, BOX_PREFS)
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
  await fs.rm(macDir, { recursive: true, force: true }).catch(() => {})
})

describe('notifications: the Mac owns the feed', () => {
  it('away: what the box has, marked offline; a card it makes waits; mark and dismiss need the Mac', async () => {
    const before = await fs.readFile(SHARED_FEED, 'utf8')
    await addNotification({ kind: 'hook', severity: 'info', title: 'Box hook ran', dedupKey: 'hook:box-1' })
    const feed = await call('GET', '/api/notifications')
    expect([feed.status, feed.body.offline]).toEqual([200, true])
    expect(named(feed.body.feed).map((n: any) => [n.dedupKey, n.title])).toEqual([
      ['cron:acme', 'Acme digest sent (git)'], ['hook:box-1', 'Box hook ran'],
    ])
    for (const [p, body] of [['/api/notifications/mark-read', { dedupKeys: ['cron:acme'] }], ['/api/notifications/dismiss', { dedupKeys: ['cron:acme'] }]] as const) {
      const r = await call('POST', p, body)
      expect([p, r.status, r.body.error?.code, r.body.error?.why]).toEqual([p, 503, 'needs_leader', 'notification_changes_need_mac'])
    }
    expect(await fs.readFile(SHARED_FEED, 'utf8')).toBe(before)
  })

  it('an older Mac: its feed, with the box\'s waiting card on top', async () => {
    mac.up = true
    mac.old = true
    const feed = await call('GET', '/api/notifications')
    expect(feed.body.offline).toBeUndefined()
    expect(named(feed.body.feed).map((n) => n.dedupKey)).toEqual(['cron:acme', 'error:backup', 'hook:box-1'])
    expect(feed.body.unreadCount).toBe(feed.body.feed.filter((n: { read: boolean }) => !n.read).length)
  })

  it('the Mac answers: the box\'s card reaches it, mark and dismiss run there, the data dir\'s file stays git\'s', async () => {
    mac.old = false
    mac.calls.length = 0
    await addNotification({ kind: 'cron', severity: 'info', title: 'Box digest', dedupKey: 'cron:box-2' })
    await vi.waitFor(() => {
      const keys = sent('server.notifications.cards').flatMap((c) => c.params.cards.map((x: { key: string }) => x.key))
      expect(keys).toEqual(expect.arrayContaining(['hook:box-1', 'cron:box-2']))
    }, { timeout: 5_000 })
    await vi.waitFor(async () => {
      expect((await call('GET', '/api/notifications')).body.feed.map((n: { dedupKey: string }) => n.dedupKey)).toEqual(['cron:acme', 'error:backup'])
    }, { timeout: 5_000 })
    const mark = await call('POST', '/api/notifications/mark-read', { dedupKeys: ['cron:acme'] })
    expect([mark.status, mark.body]).toEqual([200, { unreadCount: 0 }])
    expect(sent('server.notifications.mark').at(-1)?.params).toEqual({ dedupKeys: ['cron:acme'] })
    const dismiss = await call('POST', '/api/notifications/dismiss', { ids: ['n-mac-2'] })
    expect([dismiss.status, dismiss.body]).toEqual([200, { unreadCount: 1, removed: 1 }])
    expect(sent('server.notifications.dismiss').at(-1)?.params).toEqual({ ids: ['n-mac-2'] })
    expect(await fs.readFile(SHARED_FEED, 'utf8')).toBe(GIT_FEED)
    mac.up = false
  })
})

describe('routines: the Mac\'s engine owns its jobs', () => {
  it('before a copy: the list relays, and needs the Mac while it is away', async () => {
    const away = await call('GET', '/api/routines')
    expect([away.status, away.body.error?.why]).toEqual([503, 'kind_not_copied'])
    mac.up = true
    const relayed = await call('GET', '/api/routines')
    expect([relayed.status, relayed.body.jobs.map((j: { id: string }) => j.id)]).toEqual([200, ['rt-acme-relayed']])
    mac.up = false
  })

  it('with the copy: list, one routine and status from it; writes on the Mac; the box\'s file never changes', async () => {
    const results = await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect(results.map((r) => `${r.kind}:${r.action}`).sort()).toEqual(['personas:synced', 'prefs:synced', 'routines:synced'])
    const before = await boxFiles()
    const list = await call('GET', '/api/routines')
    expect(list.body.jobs.map((j: { id: string }) => j.id).sort()).toEqual(['rt-acme-digest', 'rt-acme-watch'])
    expect((await call('GET', '/api/routines/rt-acme-watch')).body.job.name).toBe('Acme watch')
    expect((await call('GET', '/api/routines/rt-nope')).status).toBe(404)
    expect((await call('GET', '/api/routines/status')).body).toEqual({ enabled: false, storePath: '', jobs: 2, nextWakeAtMs: null })

    const awayCreate = await call('POST', '/api/routines', { name: 'Acme new' })
    expect([awayCreate.status, awayCreate.body.error?.why]).toEqual([503, 'routine_writes_need_mac'])
    mac.up = true
    const created = await call('POST', '/api/routines', { name: 'Acme new' })
    expect([created.status, created.body.job]).toEqual([201, { id: 'rt-acme-new', name: 'Acme new' }])
    expect(sent('server.routines.create').at(-1)?.params).toEqual({ body: { name: 'Acme new' } })
    const patched = await call('PATCH', '/api/routines/rt-acme-watch', { bogus: true })
    expect([patched.status, patched.body.error]).toEqual([400, 'Invalid patch input.'])
    const ran = await call('POST', '/api/routines/rt-acme-digest/run')
    expect([ran.status, ran.body]).toEqual([200, { result: { ok: true, ran: 'rt-acme-digest' } }])
    mac.up = false
    expect(await boxFiles()).toEqual(before)
    expect(JSON.parse(await fs.readFile(CRON_FILE, 'utf8')).jobs).toEqual([])
  })
})

describe('ui-prefs and the launch memory: the Mac\'s', () => {
  it('GET is the prefs copy with its age; PUT merges on the Mac and needs it away; the box\'s file stays', async () => {
    const got = await call('GET', '/api/ui-prefs')
    expect(got.body.prefs).toEqual({ 'open-walnut-panel-width': { v: '520', ts: 40 } })
    expect(Number(got.asOf)).toBeGreaterThan(0)
    const patch = { prefs: { 'open-walnut-panel-width': { v: '610', ts: 50 } } }
    const away = await call('PUT', '/api/ui-prefs', patch)
    expect([away.status, away.body.error?.why]).toEqual([503, 'prefs_writes_need_mac'])
    mac.up = true
    const put = await call('PUT', '/api/ui-prefs', patch)
    expect([put.status, put.body]).toEqual([200, { ok: true }])
    expect(sent('server.ui-prefs.put').at(-1)?.params).toEqual(patch)
    mac.up = false
    expect(await fs.readFile(UI_PREFS_FILE, 'utf8')).toBe(BOX_PREFS)
  })

  it('the Ask Walnut launch memory is the personas copy\'s', async () => {
    expect((await call('GET', '/api/sessions/ask-walnut-launch')).body).toEqual({ model: 'opus', effort: 'high' })
  })
})
