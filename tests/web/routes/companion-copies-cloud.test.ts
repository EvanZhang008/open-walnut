/**
 * Stage 2a of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE
 * server: the Mac's copy scheduler (kinds/copy-kind.ts syncCopyKinds) sends the
 * companion the kinds it keeps (requests, routines, prefs, personas) over the real
 * client (cloud-ingest.ts postToCloudReplica, machine token, gzip), and only those.
 *
 * Pinned:
 *   - the kinds the companion does not keep are never read on the Mac, never sent,
 *     never purged; one sent anyway is `404 unknown_kind` (the lane does not rest);
 *   - each copy lands in the box's copy store (`cache/replica/...`), and the box's
 *     own files (its requests, its cron engine's jobs, its config favorites) are
 *     byte for byte what they were, through a round that removes rows too;
 *   - with the Mac away, the v1 reads the box answers itself take the copy: a
 *     request (its own first), the routines list, one routine, the scheduler
 *     status, the favorites, each with `x-walnut-copy-as-of`; before any round,
 *     the old answers (503 from the relay, the box's own favorites).
 *
 * auth.json is written fresh (tokens known to the test); nothing is copied.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-copies-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { CONFIG_FILE, CRON_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { copyKinds } from '../../../src/core/replication/kinds/index.js'
import { keepsCopiesTarget, syncCopyKinds, type CopyKind, type CopyTarget } from '../../../src/core/replication/kinds/copy-kind.js'
import { COMPANION_COPY_KINDS, COPY_AS_OF_HEADER, copyPath } from '../../../src/core/replication/kinds/gate.js'
import { readRoutineRows } from '../../../src/core/replication/kinds/routines.js'
import type { PersonaRow } from '../../../src/core/replication/kinds/personas.js'
import type { PrefsRow } from '../../../src/core/replication/kinds/prefs.js'
import type { SessionRequest } from '../../../src/core/session-requests.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const NOW = '2026-10-21T08:00:00.000Z'

// The Mac's rows. Its routines live in files of their own here, so the box's same-named files stay the box's.
let macDir = ''
let macRequests: SessionRequest[] = []
let macFavorites = { projects: ['Acme'], notes: ['notes/acme-plan.md'] }
const persona: PersonaRow = { key: 'general', agentId: 'general', name: 'Walnut', systemPrompt: 'You are Walnut, as the Mac renders it.', systemPromptMode: 'append' }

function request(id: string, status: SessionRequest['status']): SessionRequest {
  return { id, fromSessionId: 's-mac-lead', toSessionId: 's-mac-worker', status, createdAt: NOW } as SessionRequest
}

function job(id: string, name: string): Record<string, unknown> {
  return {
    id, name, enabled: true, createdAtMs: 1_000, updatedAtMs: 2_000,
    schedule: { kind: 'every', everyMs: 3_600_000 }, sessionTarget: 'main', wakeMode: 'next-heartbeat',
    payload: { kind: 'systemEvent', text: name },
  }
}

async function writeMacRoutines(jobs: Record<string, unknown>[]): Promise<void> {
  await fs.mkdir(macDir, { recursive: true })
  await fs.writeFile(path.join(macDir, 'cron-jobs.json'), JSON.stringify({ version: 2, jobs }))
  await fs.writeFile(path.join(macDir, 'cron-state.json'), JSON.stringify({ version: 1, states: Object.fromEntries(jobs.map((j, i) => [j.id, { nextRunAtMs: 50_000 + i, lastStatus: 'ok' }])) }))
}

/** Every copy kind, its rows from the test's Mac; a kind the companion does not keep must never be read. */
const read: string[] = []
function macKinds(): CopyKind<any>[] {
  const rowsOf: Record<string, () => Promise<unknown[]>> = {
    requests: async () => macRequests,
    routines: () => readRoutineRows(path.join(macDir, 'cron-jobs.json'), path.join(macDir, 'cron-state.json')),
    prefs: async () => [{ key: 'favorites', favorites: macFavorites } satisfies PrefsRow],
    personas: async () => [persona],
  }
  return copyKinds().map((k) => ({
    ...k,
    watch: () => () => {},
    rows: async () => {
      read.push(k.kind)
      const rows = rowsOf[k.kind]
      if (!rows) throw new Error(`the Mac read ${k.kind}, which the companion does not keep`)
      return rows()
    },
  }))
}

const companion: CopyTarget = {
  id: 'companion', kind: 'companion', label: 'Cloud companion',
  available: async () => true,
  post: (payload, opts) => postToCloudReplica(payload, opts),
}

async function get(p: string): Promise<{ status: number; body: Record<string, unknown>; asOf: string | null }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${T.phone}` } })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown>, asOf: r.headers.get(COPY_AS_OF_HEADER) }
}

// The box's own state: what a round must never touch.
const BOX_REQUESTS = JSON.stringify({ requests: [request('rq-b0b0b0', 'pending')] })
const BOX_JOBS = JSON.stringify({ version: 2, jobs: [job('rt-box-git-sync', 'Box git sync')] })
const ownFiles = () => Promise.all([
  fs.readFile(path.join(WALNUT_HOME, 'session-requests.json'), 'utf8'),
  fs.readFile(CRON_FILE, 'utf8'),
  fs.readFile(CONFIG_FILE, 'utf8'),
])

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  macDir = path.join(WALNUT_HOME, '..', `${path.basename(WALNUT_HOME)}-mac`)
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, user: { name: 'Ada' }, favorites: { projects: ['BoxOnly'], notes: [] } }))
  await fs.writeFile(path.join(WALNUT_HOME, 'session-requests.json'), BOX_REQUESTS)
  await fs.mkdir(path.dirname(CRON_FILE), { recursive: true })
  await fs.writeFile(CRON_FILE, BOX_JOBS)
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

describe('who keeps which kind', () => {
  it('the companion keeps the stage 2a kinds; a host replica keeps every kind; the plain host server none', () => {
    expect([...COMPANION_COPY_KINDS].sort()).toEqual(['personas', 'prefs', 'requests', 'routines'])
    const host = (program: string): CopyTarget => ({ ...companion, id: 'host:devbox', kind: 'host', program: () => program })
    for (const k of ['sessions', 'requests', 'boards', 'inbox', 'inbox-bodies', 'routines', 'conversations', 'prefs', 'config', 'personas']) {
      expect([k, keepsCopiesTarget(companion, k)]).toEqual([k, COMPANION_COPY_KINDS.has(k)])
      expect([k, keepsCopiesTarget(host('replica'), k)]).toEqual([k, true])
      expect([k, keepsCopiesTarget(host('host-server'), k)]).toEqual([k, false])
    }
    expect(keepsCopiesTarget(companion)).toBe(true)
  })

  it('copyPath keeps the companion\'s copy under cache/replica/home, and refuses a path outside the data dir', () => {
    expect(copyPath(CRON_FILE)).toBe(path.join(WALNUT_HOME, 'cache', 'replica', 'home', path.relative(WALNUT_HOME, CRON_FILE)))
    expect(() => copyPath('/etc/passwd')).toThrow(/not under the data dir/)
  })
})

describe('the Mac away, before any round: the old answers', () => {
  it('routines relay to the Mac (503), favorites are the box\'s own, a request the box does not hold is 404', async () => {
    const routines = await get('/api/v1/routines')
    expect(routines.status).toBe(503)
    expect(routines.asOf).toBeNull()
    expect((await get('/api/v1/favorites')).body).toEqual({ projects: ['BoxOnly'], notes: [] })
    expect((await get('/api/v1/requests/rq-acac01')).status).toBe(404)
  })
})

describe('a round of every kind from the Mac', () => {
  it('sends the four kinds the companion keeps and nothing else, and leaves the box\'s own files as they were', async () => {
    macRequests = [request('rq-acac01', 'pending'), request('rq-acac02', 'replied')]
    await writeMacRoutines([job('rt-acme-digest', 'Acme digest'), job('rt-acme-watch', 'Acme watch')])
    const before = await ownFiles()
    const results = await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect(results.map((r) => `${r.target}:${r.kind}:${r.action}`).sort()).toEqual([
      'companion:personas:synced', 'companion:prefs:synced', 'companion:requests:synced', 'companion:routines:synced',
    ])
    expect([...new Set(read)].sort()).toEqual(['personas', 'prefs', 'requests', 'routines'])
    expect(await ownFiles()).toEqual(before)
    // (The box's own engine rewrote its file at boot, in its own layout: still its one job.)
    expect(before[0]).toEqual(BOX_REQUESTS)
    expect(JSON.parse(before[1]).jobs.map((j: { id: string }) => j.id)).toEqual(['rt-box-git-sync'])
    expect(yaml.load(before[2])).toMatchObject({ favorites: { projects: ['BoxOnly'] } })
    // The copies, in the box's copy store.
    const home = path.join(WALNUT_HOME, 'cache', 'replica', 'home')
    expect(JSON.parse(await fs.readFile(path.join(home, 'session-requests.json'), 'utf8')).requests.map((r: SessionRequest) => r.id).sort()).toEqual(['rq-acac01', 'rq-acac02'])
    expect(JSON.parse(await fs.readFile(path.join(home, path.relative(WALNUT_HOME, CRON_FILE)), 'utf8')).jobs.map((j: { id: string }) => j.id)).toEqual(['rt-acme-digest', 'rt-acme-watch'])
    const replica = await fs.readdir(path.join(WALNUT_HOME, 'cache', 'replica'))
    for (const f of ['requests.json', 'routines.json', 'prefs.json', 'personas.json']) expect(replica).toContain(f)
    for (const f of ['config.json', 'boards.json', 'inbox.json', 'conversations.json']) expect(replica).not.toContain(f)
  })

  it('a kind the companion does not keep, sent anyway, is 404 unknown_kind', async () => {
    for (const kind of ['sessions', 'boards', 'inbox', 'inbox-bodies', 'conversations', 'config']) {
      expect([kind, await postToCloudReplica({ op: 'sync', kind, entries: [], asOf: Date.now(), schemaVersion: 1 })])
        .toEqual([kind, { ok: false, outcome: 'unsupported', status: 404, error: 'unknown_kind' }])
    }
  })

  it('a second round with nothing changed sends no rows (the 404s rested no other kind)', async () => {
    read.length = 0
    const results = await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect(results.every((r) => r.action === 'unchanged')).toBe(true)
  })
})

describe('the Mac away, with the copies held: the box answers from them', () => {
  it('a request: the box\'s own first, then the copy (with its age), else 404', async () => {
    const own = await get('/api/v1/requests/rq-b0b0b0')
    expect(own.status).toBe(200)
    expect(own.asOf).toBeNull()
    const copied = await get('/api/v1/requests/rq-acac02')
    expect(copied.status).toBe(200)
    expect((copied.body.request as SessionRequest).status).toBe('replied')
    expect(Number(copied.asOf)).toBeGreaterThan(0)
    expect((await get('/api/v1/requests/rq-ffffff')).status).toBe(404)
  })

  it('routines: the list, one routine, the status; never the box engine\'s own job', async () => {
    const list = await get('/api/v1/routines')
    expect(list.status).toBe(200)
    expect((list.body.jobs as Array<{ id: string }>).map((j) => j.id).sort()).toEqual(['rt-acme-digest', 'rt-acme-watch'])
    expect(Number(list.asOf)).toBeGreaterThan(0)
    const one = await get('/api/v1/routines/rt-acme-watch')
    expect(one.status).toBe(200)
    expect((one.body.job as { name: string; state: { nextRunAtMs: number } })).toMatchObject({ name: 'Acme watch', state: { nextRunAtMs: 50_001 } })
    expect((await get('/api/v1/routines/rt-box-git-sync')).status).toBe(404)
    expect((await get('/api/v1/routines/status')).body).toEqual({ enabled: false, storePath: '', jobs: 2, nextWakeAtMs: null })
  })

  it('favorites: the Mac\'s, not the box\'s config', async () => {
    const fav = await get('/api/v1/favorites')
    expect(fav.body).toEqual({ projects: ['Acme'], notes: ['notes/acme-plan.md'] })
    expect(Number(fav.asOf)).toBeGreaterThan(0)
  })

  it('a round that removes rows removes them from the copy only', async () => {
    macRequests = [request('rq-acac01', 'replied')]
    await writeMacRoutines([job('rt-acme-digest', 'Acme digest')])
    macFavorites = { projects: [], notes: [] }
    const before = await ownFiles()
    const results = await syncCopyKinds(macKinds(), { targets: () => [companion] })
    expect(results.filter((r) => r.action === 'synced').map((r) => r.kind).sort()).toEqual(['prefs', 'requests', 'routines'])
    expect(await ownFiles()).toEqual(before)
    expect((await get('/api/v1/requests/rq-acac02')).status).toBe(404)
    expect((await get('/api/v1/requests/rq-b0b0b0')).status).toBe(200)
    expect(((await get('/api/v1/routines')).body.jobs as Array<{ id: string }>).map((j) => j.id)).toEqual(['rt-acme-digest'])
    // An emptied favorites list is the Mac's answer, not "no copy".
    expect((await get('/api/v1/favorites')).body).toEqual({ projects: [], notes: [] })
  })
})
