/**
 * The `prefs` copy kind (docs/plan/walnut-replica-servers-impl.md, WP5): the Mac's
 * ui prefs and favorites (carved out of config.yaml, nothing else of it) to a host
 * replica, where GET /api/ui-prefs and GET /api/favorites read the copy and their
 * writes answer 503 needs_leader. Real files, real route, real follower, real
 * routers behind the real error handler.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import yaml from 'js-yaml'
import { createMockConstants } from '../../../helpers/mock-constants.js'
import { startCopyHarness, stepsSince, type CopyHarness } from '../../../helpers/copy-kind-harness.js'
import { fullConfigFixture, PLANTED_SECRETS } from '../../../helpers/full-config-fixture.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-prefs', { CLOUD_MODE: false }))

import { CONFIG_FILE, UI_PREFS_FILE, WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { runCopyRound, syncCopyKinds } from '../../../../src/core/replication/kinds/copy-kind.js'
import { PREFS_KIND, readFavoritesCopy, readUiPrefsCopy, _resetPrefsCopyForTesting } from '../../../../src/core/replication/kinds/prefs.js'
import { buildKindManifest } from '../../../../src/core/replication/kind-leader.js'
import { _resetReplicaStatusForTesting, forgetKindManifests } from '../../../../src/core/replication/replica-status.js'

const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
let api: Server
let base = ''
const kind = { ...PREFS_KIND, watch: () => () => {} }
const copyFile = () => path.join(WALNUT_HOME, 'cache', 'replica', 'prefs.json')

async function round() {
  return runCopyRound(kind, await buildKindManifest(kind, [...await kind.rows()]), h.target, { asOf: Date.now() })
}

function setReplica(on: boolean): void {
  if (on) Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  else for (const k of ENV) delete process.env[k]
  _resetServerRoleForTesting()
}

const MAC_PREFS = {
  'open-walnut-sidebar-width': { v: '312', ts: 1_000 },
  'walnut-todo-collapsed': { v: '["Acme"]', ts: 2_000 },
  'open-walnut-legacy-plain': 'plain-string',
  'open-walnut-gone': { v: null, ts: 3_000 },
  'not-a-layout-key': { v: 'x', ts: 1 },
  'open-walnut-file-explorer-selected:local:/Users/marina': { v: 'a', ts: 1 },
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  setReplica(true)
  h = await startCopyHarness()
  const [{ default: express }, { favoritesRouter }, { uiPrefsRouter }, { searchMemoryV1Router }, { errorHandler }] = await Promise.all([
    import('express'), import('../../../../src/web/routes/favorites.js'), import('../../../../src/web/routes/ui-prefs.js'),
    import('../../../../src/web/routes/search-memory-v1.js'), import('../../../../src/web/middleware/error-handler.js'),
  ])
  const app = express()
  app.use(express.json())
  app.use('/api/favorites', favoritesRouter)
  app.use('/api/ui-prefs', uiPrefsRouter)
  // The phone's twin of GET /api/favorites (the frozen /api/v1).
  app.use('/api/v1', searchMemoryV1Router)
  app.use(errorHandler)
  api = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})

afterAll(async () => {
  await h.close()
  await new Promise<void>((r) => api.close(() => r()))
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  setReplica(true)
  _resetPrefsCopyForTesting()
  _resetReplicaStatusForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(UI_PREFS_FILE), { recursive: true })
  h.calls.length = 0
  await fsp.writeFile(UI_PREFS_FILE, JSON.stringify(MAC_PREFS))
  await fsp.writeFile(CONFIG_FILE, yaml.dump(fullConfigFixture()))
})

describe('a round of the prefs copy', () => {
  it('copies layout prefs and favorites only, at 0600, and converges', async () => {
    expect(await round()).toMatchObject({ action: 'synced', sent: 5 })
    expect(stepsSince(h.calls)).toEqual(['sync:prefs', 'put:prefs:5'])
    expect(fs.statSync(copyFile()).mode & 0o777).toBe(0o600)
    expect(await readUiPrefsCopy()).toEqual({
      'open-walnut-sidebar-width': { v: '312', ts: 1_000 },
      'walnut-todo-collapsed': { v: '["Acme"]', ts: 2_000 },
      'open-walnut-legacy-plain': { v: 'plain-string', ts: 0 },
      'open-walnut-gone': { v: null, ts: 3_000 },
    })
    expect(await readFavoritesCopy()).toEqual({ projects: ['Acme'], notes: ['Notes/acme.md'] })
    // Favorites are carved out: nothing else of config.yaml is in the copy.
    const text = fs.readFileSync(copyFile(), 'utf8')
    for (const s of PLANTED_SECRETS) expect([s, text.includes(s)]).toEqual([s, false])
    expect(text).not.toContain('devbox')
    // Nor did any step that crossed the link.
    for (const c of h.calls) for (const s of [...PLANTED_SECRETS, 'devbox']) expect([c.op, s, c.text.includes(s)]).toEqual([c.op, s, false])
    forgetKindManifests(['prefs'])
    const from = h.calls.length
    expect(await round()).toMatchObject({ action: 'synced', sent: 0 })
    expect(stepsSince(h.calls, from)).toEqual(['sync:prefs'])
  })

  it('a change of one pref on the Mac is one row', async () => {
    await round()
    await fsp.writeFile(UI_PREFS_FILE, JSON.stringify({ ...MAC_PREFS, 'open-walnut-sidebar-width': { v: '400', ts: 5_000 } }))
    expect(await round()).toMatchObject({ action: 'synced', sent: 1 })
    expect((await readUiPrefsCopy())?.['open-walnut-sidebar-width']).toEqual({ v: '400', ts: 5_000 })
  })

  it('an unreadable ui-prefs file on the Mac skips the round; the copy stays', async () => {
    await round()
    const held = fs.readFileSync(copyFile(), 'utf8')
    await fsp.rm(UI_PREFS_FILE)
    await fsp.symlink(path.basename(UI_PREFS_FILE), UI_PREFS_FILE)
    await expect(kind.rows()).rejects.toThrow(/ELOOP/)
    h.calls.length = 0
    expect(await syncCopyKinds([kind], { targets: () => [h.target] })).toEqual([])
    expect(h.calls).toEqual([])
    expect(fs.readFileSync(copyFile(), 'utf8')).toBe(held)
  })
})

describe('the routes on the replica', () => {
  it('GET /api/ui-prefs and GET /api/favorites answer from the copy, not from a local file', async () => {
    await round()
    // The Mac moves on; the replica answers what it holds until the next round.
    await fsp.writeFile(UI_PREFS_FILE, JSON.stringify({ 'open-walnut-sidebar-width': { v: '999', ts: 9_000 } }))
    const prefs = await (await fetch(`${base}/api/ui-prefs`)).json() as { prefs: Record<string, unknown> }
    expect(prefs.prefs['open-walnut-sidebar-width']).toEqual({ v: '312', ts: 1_000 })
    const fav = await (await fetch(`${base}/api/favorites`)).json()
    expect(fav).toEqual({ projects: ['Acme'], notes: ['Notes/acme.md'] })
  })

  it('before the first round both routes answer needs_leader kind_not_copied, never an empty answer', async () => {
    for (const p of ['/api/favorites', '/api/ui-prefs']) {
      const r = await fetch(`${base}${p}`)
      expect([p, r.status]).toEqual([p, 503])
      expect(await r.json()).toMatchObject({ error: { code: 'needs_leader', why: 'kind_not_copied' } })
    }
  })

  it('their writes answer 503 needs_leader and write nothing', async () => {
    await round()
    const configBefore = fs.readFileSync(CONFIG_FILE, 'utf8')
    const prefsBefore = fs.readFileSync(UI_PREFS_FILE, 'utf8')
    const put = await fetch(`${base}/api/ui-prefs`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefs: { 'open-walnut-sidebar-width': { v: '1', ts: 99_999 } } }) })
    expect(put.status).toBe(503)
    expect(await put.json()).toMatchObject({ error: { code: 'needs_leader', why: 'prefs_writes_need_mac' } })
    const add = await fetch(`${base}/api/favorites/projects/Marina`, { method: 'POST' })
    expect(add.status).toBe(503)
    expect(await add.json()).toMatchObject({ error: { code: 'needs_leader', why: 'prefs_writes_need_mac' } })
    const note = await fetch(`${base}/api/favorites/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'Notes/marina.md' }) })
    expect(note.status).toBe(503)
    expect(await note.json()).toMatchObject({ error: { code: 'needs_leader', why: 'prefs_writes_need_mac' } })
    expect(fs.readFileSync(CONFIG_FILE, 'utf8')).toBe(configBefore)
    expect(fs.readFileSync(UI_PREFS_FILE, 'utf8')).toBe(prefsBefore)
  })

  it('on the leader the same routes read and write the Mac files as before', async () => {
    setReplica(false)
    const put = await fetch(`${base}/api/ui-prefs`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefs: { 'open-walnut-sidebar-width': { v: '500', ts: 99_999 } } }) })
    expect(put.status).toBe(200)
    const prefs = await (await fetch(`${base}/api/ui-prefs`)).json() as { prefs: Record<string, unknown> }
    expect(prefs.prefs['open-walnut-sidebar-width']).toEqual({ v: '500', ts: 99_999 })
    expect(await (await fetch(`${base}/api/favorites`)).json()).toEqual({ projects: ['Acme'], notes: ['Notes/acme.md'] })
  })
})

describe('every favorites read on the replica is the prefs copy', () => {
  it('getConfig(), the phone GET /api/v1/favorites and the project list read it; before the first round none of them invents favorites', async () => {
    // A project on the replica's task store, as its task copy would hold it.
    setReplica(false)
    const { addTask } = await import('../../../../src/core/task-manager.js')
    await addTask({ title: 'Acme release', project: 'Acme' })
    setReplica(true)
    const cm = await import('../../../../src/core/config-manager.js')
    const { buildProjectsPayload } = await import('../../../../src/web/routes/projects.js')
    const acmeFavorite = async () => ((await buildProjectsPayload()).projects.find((p) => p.name === 'Acme') as { favorite?: boolean } | undefined)?.favorite

    // No copy yet: the phone is told so, as the web route tells it; nothing reads as a favorite.
    const none = await fetch(`${base}/api/v1/favorites`)
    expect(none.status).toBe(503)
    expect(await none.json()).toMatchObject({ error: { code: 'needs_leader', why: 'kind_not_copied' } })
    expect((await cm.getConfig()).favorites).toBeUndefined()
    expect(await acmeFavorite()).toBe(false)

    await round()
    // The Mac's own config.yaml (one home for both sides here) is never what the replica reads.
    await fsp.writeFile(CONFIG_FILE, yaml.dump({ ...fullConfigFixture(), favorites: { projects: ['Marina'], notes: [] } }))
    const want = { projects: ['Acme'], notes: ['Notes/acme.md'] }
    expect((await cm.getConfig()).favorites).toEqual(want)
    const v1 = await fetch(`${base}/api/v1/favorites`)
    expect(v1.status).toBe(200)
    expect(await v1.json()).toEqual(want)
    expect(await (await fetch(`${base}/api/favorites`)).json()).toEqual(want)
    expect(await acmeFavorite()).toBe(true)
  })
})

describe('the host turned the prefs copy off', () => {
  it('drops the copy and keeps the off marker; the routes answer needs_leader, not empty; on again, a full manifest', async () => {
    let choice: Record<string, boolean> = {}
    const host = await startCopyHarness({ id: 'host:prefs-off', copies: async () => choice })
    try {
      await syncCopyKinds([kind], { targets: () => [host.target] })
      choice = { prefs: false }
      let from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['purge:prefs'])
      expect(JSON.parse(fs.readFileSync(copyFile(), 'utf8'))).toMatchObject({ v: 1, off: true })
      expect(await readUiPrefsCopy()).toBeNull()
      for (const p of ['/api/favorites', '/api/ui-prefs']) {
        const r = await fetch(`${base}${p}`)
        expect([p, r.status]).toEqual([p, 503])
        // The dispatcher's 503 headers too: a client tells the two apart by nothing.
        expect([p, r.headers.get('retry-after'), r.headers.get('x-walnut-answered-via')]).toEqual([p, '5', 'replica'])
        expect(await r.json()).toMatchObject({ error: { code: 'needs_leader', why: 'not_kept_here' } })
      }
      choice = {}
      from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)[0]).toBe('sync:prefs')
      expect(await readFavoritesCopy()).toEqual({ projects: ['Acme'], notes: ['Notes/acme.md'] })
    } finally { await host.close() }
  })
})

describe('the leader starts a round when the prefs change', () => {
  it('a ui-prefs save and a favorites save each call the kind watch', async () => {
    setReplica(false)
    let n = 0
    const stop = PREFS_KIND.watch(() => { n++ })
    try {
      await new Promise((r) => setTimeout(r, 50)) // the watch hooks in after its imports
      await fetch(`${base}/api/ui-prefs`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefs: { 'open-walnut-sidebar-width': { v: '7', ts: 199_999 } } }) })
      expect(n).toBe(1)
      await fetch(`${base}/api/favorites/projects/Marina`, { method: 'POST' })
      expect(n).toBe(2)
    } finally { stop() }
    await fetch(`${base}/api/ui-prefs`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefs: { 'open-walnut-sidebar-width': { v: '8', ts: 299_999 } } }) })
    expect(n).toBe(2)
  })
})
