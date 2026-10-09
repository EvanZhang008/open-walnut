/**
 * The search index copy over the real door: POST /bridge/replica kind 'search'
 * on a real CLOUD_MODE server, driven by the primary's real round
 * (core/replication/search-replica.ts) over the real client (cloud-ingest.ts
 * postToCloudReplica: gzip, machine token), then searched the way the phone
 * searches while the Mac is away (GET /api/v1/search with a phone token; this
 * server has never heard from a primary, so it answers itself).
 *
 * The primary's index is a temp file with the text fixture embedder. The
 * companion's semantic lane is off under the test runner, so its copy ranks by
 * keyword here; that the copied vectors rescore is pinned in
 * tests/lib/hybrid-search-replica.test.ts.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-replica-search', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { _resetCloudIngestForTesting, cloudReplicaAvailable, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { createSearchIndex, type SearchIndex } from '../../../src/lib/hybrid-search/index.js'
import { SEARCH_V2_KIND_WEIGHTS } from '../../../src/core/search/wiring.js'
import { syncSearchReplica, noteSearchDocChange, _resetSearchReplicaForTesting } from '../../../src/core/replication/search-replica.js'
import { _resetSearchReplicaStoreForTesting } from '../../../src/core/replication/search-replica-store.js'
import { getV1Forward } from '../../../src/web/v1-forward/proxy.js'

const MAC_HOME = '/Users/someone/.open-walnut'
const TEXT_WORKER = new URL('../../lib/fixtures/text-embed-worker.cjs', import.meta.url).pathname

let server: HttpServer
let port = 0
let dir = ''
let src: SearchIndex
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }

async function get(url: string, bearer: string) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { Authorization: `Bearer ${bearer}` } })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

async function postReplica(bearer: string, body: unknown) {
  const r = await fetch(`http://127.0.0.1:${port}/bridge/replica`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

beforeAll(async () => {
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fsp.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
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
  // The runner's semantic lane is off, so the companion would report no model;
  // stand in the primary's, and the memory of a roomy box.
  _resetSearchReplicaStoreForTesting({ model: () => 'fake/model', totalMb: () => 8_000, macAway: () => getV1Forward().primaryAway() })
  _resetSearchReplicaForTesting()

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-search-replica-http-'))
  src = createSearchIndex({
    dbPath: path.join(dir, 'mac.sqlite'), kinds: SEARCH_V2_KIND_WEIGHTS,
    embedder: { modelId: 'fake/text:{}', dims: 4, workerPath: TEXT_WORKER }, onDocChange: noteSearchDocChange,
  })
  src.upsert({ kind: 'task', ref: 'mrep01-aaaa', title: 'Rotate the cedar gateway certificate', summary: 'Before Friday', updatedAt: Date.now() })
  src.upsert({ kind: 'note', ref: `${MAC_HOME}/notes/garden/lantern.md`, title: 'Lantern notes', note: 'The cedar lantern hangs by the gate.', updatedAt: Date.now() })
  for (let i = 0; i < 40 && (await src.backfillVectors({})).drained === false; i++) { /* drain */ }
}, 60_000)

afterAll(async () => {
  await src?.stopEmbedder().catch(() => {})
  try { src?.close() } catch { /* closed */ }
  await stopServer()
  fs.rmSync(dir, { recursive: true, force: true })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the search index copy over POST /bridge/replica', () => {
  it('a phone token cannot write the copy; a malformed step is a 400', async () => {
    _resetAuthRateLimitForTesting()
    expect((await postReplica(T.phone, { op: 'status', kind: 'search', mode: 'auto' })).status).toBe(403)
    expect(await postReplica(T.local, { op: 'sync', kind: 'search', entries: [{ k: 'task:x', h: 'nope' }] })).toMatchObject({ status: 400 })
    expect(await postReplica(T.local, { op: 'bogus', kind: 'search' })).toMatchObject({ status: 400, body: { error: 'unknown_op' } })
  })

  it('the real round fills the copy, and the phone\'s search uses it while the Mac is away', async () => {
    const deps = {
      index: () => src, model: () => 'fake/model', home: MAC_HOME, mode: async () => 'auto' as const,
      post: postToCloudReplica, available: cloudReplicaAvailable,
    }
    expect(await syncSearchReplica(deps)).toMatchObject({ action: 'synced', sent: 2, inSync: true })
    expect(await syncSearchReplica(deps)).toEqual({ action: 'in-sync' })

    const notes = await get('/api/v1/search?q=lantern&types=task,memory', T.phone)
    expect(notes.status).toBe(200)
    expect(notes.body).toMatchObject({ offline: true })
    expect(notes.body.degraded).toBeUndefined()
    expect(typeof notes.body.asOf).toBe('string')
    expect(notes.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'memory', path: path.join(WALNUT_HOME, 'notes', 'garden', 'lantern.md'), matchField: 'note' }),
    ]))
    // The task copy here is empty: the task comes from the index copy alone.
    const tasks = await get('/api/v1/search?q=gateway%20certificate&types=task', T.phone)
    expect(tasks.body.results).toEqual([expect.objectContaining({ type: 'task', taskId: 'mrep01-aaaa', matchField: 'task' })])
  })
})
