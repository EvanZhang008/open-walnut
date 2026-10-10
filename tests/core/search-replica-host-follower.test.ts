/**
 * A server on a host (WALNUT_HOST_SERVER=1, not the cloud companion) is a
 * follower too: it keeps the same copy of the leader's search index, never
 * builds an index of its own, and searches the copy while the leader is away.
 * The leader's round runs against the real follower store in this process,
 * through a host target that carries only what JSON carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-search-host-follower', { CLOUD_MODE: false }))

import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js'
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js'
import * as wiring from '../../src/core/search/wiring.js'
import * as store from '../../src/core/replication/search-replica-store.js'
import { syncSearchReplica, noteSearchDocChange, followerSearchStatuses, _resetSearchReplicaForTesting } from '../../src/core/replication/search-replica.js'
import type { ReplicaTarget } from '../../src/core/replication/replica-targets.js'
import { followerKind } from '../../src/core/server-role.js'
import { companionSearchReady } from '../../src/core/search/companion-ready.js'
import { drainBackfill } from '../lib/text-embed-index.js'

const MAC_HOME = '/Users/someone/.open-walnut'
const TEXT_WORKER = new URL('../lib/fixtures/text-embed-worker.cjs', import.meta.url).pathname

let dir = ''
let src: SearchIndex

const host: ReplicaTarget = {
  id: 'host:devbox',
  kind: 'host',
  label: 'devbox',
  available: async () => true,
  post: async (payload) => {
    const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    const r = body.op === 'status' ? await store.searchReplicaStatus(body)
      : body.op === 'sync' ? await store.searchReplicaSync(body)
        : await store.searchReplicaPut(body)
    return r.ok ? { ok: true, reply: r } : { ok: false, outcome: 'failed', status: r.status, error: r.error }
  },
}

const deps = {
  index: () => src,
  model: () => 'fake/model',
  home: MAC_HOME,
  mode: async () => 'auto' as const,
  targets: () => [host],
  pause: async () => {},
}

beforeEach(async () => {
  process.env.WALNUT_HOST_SERVER = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(TASKS_DIR, { recursive: true })
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-search-host-'))
  _resetSearchReplicaForTesting()
  await wiring.closeSearchV2Index()
  store._resetSearchReplicaStoreForTesting({ totalMb: () => 16_000, macAway: async () => true, model: () => 'fake/model' })
  src = createSearchIndex({
    dbPath: path.join(dir, 'mac-search.sqlite'),
    kinds: wiring.SEARCH_V2_KIND_WEIGHTS,
    embedder: { modelId: 'fake/text:{}', dims: 4, workerPath: TEXT_WORKER },
    onDocChange: noteSearchDocChange,
  })
  src.upsert({ kind: 'task', ref: 't-1', title: 'Rotate the cedar gateway certificate', updatedAt: 1_000, identifiers: ['t-1'] })
  src.upsert({ kind: 'note', ref: `${MAC_HOME}/notes/lantern.md`, title: 'Lantern notes', note: 'The lantern shop opens at nine.', updatedAt: 2_000 })
  await drainBackfill(src)
})

afterEach(async () => {
  delete process.env.WALNUT_HOST_SERVER
  await src.stopEmbedder().catch(() => {})
  try { src.close() } catch { /* closed */ }
  await wiring.closeSearchV2Index()
  fs.rmSync(dir, { recursive: true, force: true })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a host server keeps the copy too', () => {
  it('is a follower: no index of its own, the copy at cache/search-replica.sqlite', () => {
    expect(followerKind()).toBe('host')
    expect(wiring.isSearchV2Enabled()).toBe(false)
    expect(wiring.searchV2IndexPath()).toBe(path.join(WALNUT_HOME, 'cache', 'search-replica.sqlite'))
  })

  it('the leader fills it, and its search uses it: the memory lane included, at its own paths', async () => {
    const { search } = await import('../../src/core/search.js')
    expect(await search('lantern', { types: ['memory'] })).toEqual([])
    expect(await syncSearchReplica(deps)).toMatchObject([{ target: 'host:devbox', action: 'synced', sent: 2, inSync: true }])
    expect(followerSearchStatuses()).toMatchObject([{ id: 'host:devbox', kind: 'host', label: 'devbox', state: 'ready' }])
    expect(companionSearchReady()).toBe(true)
    const hits = await search('lantern', { types: ['memory'] })
    expect(hits[0]).toMatchObject({ type: 'memory', path: path.join(WALNUT_HOME, 'notes', 'lantern.md') })
    expect((await search('cedar gateway', { types: ['task'] }))[0]?.taskId).toBe('t-1')
  })
})
