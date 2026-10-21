/**
 * The `model-catalogs` copy kind (stage 2c of
 * docs/plan/walnut-companion-unified-replica.md): the Mac's host model catalogs,
 * one row per host, without the fields only the Mac uses; a round a few seconds
 * after a catalog write; a follower that stores the rows as they came and refuses
 * a malformed one. The leader side reads the real catalog store; the follower is
 * the real route of a host replica (the companion's is pinned on a real server by
 * tests/web/routes/companion-session-readers-cloud.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../../helpers/mock-constants.js'
import { startCopyHarness, type CopyHarness } from '../../../helpers/copy-kind-harness.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-model-catalogs', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { runCopyRound } from '../../../../src/core/replication/kinds/copy-kind.js'
import { MODEL_CATALOGS_KIND, readModelCatalogsCopy, _resetModelCatalogsCopyForTesting } from '../../../../src/core/replication/kinds/model-catalogs.js'
import { buildKindManifest } from '../../../../src/core/replication/kind-leader.js'
import { followerStep } from '../../../../src/core/replication/kind-follower.js'
import { _resetReplicaStatusForTesting } from '../../../../src/core/replication/replica-status.js'
import { saveHostModelCatalog, _flushHostModelCatalogWrites, _resetHostModelCatalogCache } from '../../../../src/core/host-model-catalog.js'

const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
const SONNET = { value: 'sonnet[1m]', displayName: 'Sonnet (1M)', supportsEffort: true, supportedEffortLevels: ['low' as const, 'medium' as const] }

async function round() {
  const kind = { ...MODEL_CATALOGS_KIND, watch: () => () => {} }
  return runCopyRound(kind, await buildKindManifest(kind, [...await kind.rows()]), h.target, { asOf: Date.now() })
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
  h = await startCopyHarness()
})

afterAll(async () => {
  await h.close()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  await _flushHostModelCatalogWrites()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  _resetHostModelCatalogCache()
  _resetModelCatalogsCopyForTesting()
  _resetReplicaStatusForTesting()
})

describe('the leader', () => {
  it('sends one row per host with models, without the cwd or the spawn time', async () => {
    await saveHostModelCatalog('devbox', [SONNET], '/home/acme', 1_000)
    await saveHostModelCatalog(undefined, [{ value: 'opus', displayName: 'Opus' }])
    await saveHostModelCatalog('empty-host', [])
    const rows = await MODEL_CATALOGS_KIND.rows()
    expect(rows.map((r) => r.key).sort()).toEqual(['__local__', 'devbox'])
    expect(rows.find((r) => r.key === 'devbox')).toEqual({ key: 'devbox', models: [SONNET], fetchedAt: expect.any(String) })
  })

  it('a catalog write brings a round', async () => {
    const soon = vi.fn()
    const stop = MODEL_CATALOGS_KIND.watch(soon)
    await new Promise((r) => setTimeout(r, 20)) // the watch subscribes after its lazy import
    await saveHostModelCatalog('devbox', [SONNET], '/home/acme', 2_000)
    expect(soon).toHaveBeenCalledTimes(1)
    stop()
    await saveHostModelCatalog('devbox', [SONNET], '/home/acme', 3_000)
    expect(soon).toHaveBeenCalledTimes(1)
  })
})

describe('the follower', () => {
  it('keeps the rows as they came, in the projection\'s shape', async () => {
    await saveHostModelCatalog('devbox', [SONNET], '/home/acme', 1_000)
    expect(await readModelCatalogsCopy()).toBeNull()
    expect(await round()).toMatchObject({ kind: 'model-catalogs', action: 'synced', sent: 1 })
    expect(await readModelCatalogsCopy()).toEqual({ devbox: { models: [SONNET], fetchedAt: expect.any(String) } })
  })

  it('refuses a malformed row, and stores nothing of that put', async () => {
    for (const row of [
      { key: 'devbox', models: [], fetchedAt: 'x' },
      { key: 'devbox', models: [{ displayName: 'no value' }], fetchedAt: 'x' },
      { key: 'dev box/../x', models: [SONNET], fetchedAt: 'x' },
      { key: 'devbox', models: [SONNET], fetchedAt: 'x', cwd: '/home/acme' },
    ]) {
      expect(await followerStep({ op: 'put', kind: 'model-catalogs', rows: [row], last: true, schemaVersion: 1 })).toMatchObject({ ok: false, status: 400, error: 'bad_rows' })
    }
    expect(await readModelCatalogsCopy()).toBeNull()
  })
})
