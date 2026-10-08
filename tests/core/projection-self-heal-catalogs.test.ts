/**
 * The 5-minute self-heal sweep (projection-cache.ts) re-pushes the Mac's own
 * sessions cache file, which is kept without the host model catalogs. The
 * companion's model picker reads those catalogs while the Mac is away, so the
 * sweep's push must carry them as the export's does (session-projection.ts
 * sessionsPushPayload). 2026-10-08: live, the sweep replaced the companion's
 * copy every 5 minutes with one that had none.
 *
 * Real projection-cache code on real files; the ingest call and the catalog
 * store are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-self-heal-catalogs'))
vi.mock('../../src/providers/daemon-connection.js', () => ({ getConnectedDaemonConnection: () => null }))
const ingestSpy = vi.hoisted(() => vi.fn(async (_kind: string, _wire: string): Promise<'sent' | 'failed' | 'unsupported'> => 'sent'))
vi.mock('../../src/core/cloud-ingest.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/cloud-ingest.js')>()),
  postToCloudIngest: (kind: string, wire: string) => ingestSpy(kind, wire),
  cloudIngestResting: () => false,
}))
const catalogs = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../src/core/host-model-catalog.js', () => ({ listHostModelCatalogs: async () => catalogs.value }))

import { readProjectionCache, runProjectionSelfHealSweep, writeProjectionCache, _resetProjectionCacheForTesting } from '../../src/core/projection-cache.js'
import { WALNUT_HOME } from '../../src/constants.js'

const MODELS = [{ value: 'sonnet[1m]', displayName: 'Sonnet (1M)', supportsEffort: true }]
const envelope = {
  version: 1, exportedAt: '2026-10-08T00:00:00.000Z',
  sessions: [{ id: 's1', host: 'devbox', process_status: 'stopped', started_at: 'x', last_active_at: 'y', message_count: 1, cli_model: 'sonnet[1m]' }],
}

function sessionsPushes(): Array<Record<string, unknown>> {
  return ingestSpy.mock.calls
    .map((c) => JSON.parse(c[1]) as { which?: string; data: Record<string, unknown> })
    .filter((p) => p.which === 'sessions')
    .map((p) => p.data)
}

beforeEach(async () => {
  _resetProjectionCacheForTesting()
  ingestSpy.mockClear()
  catalogs.value = {}
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await writeProjectionCache('sessions', envelope)
})

describe('self-heal sweep: the host model catalogs ride along', () => {
  it('the sweep\'s push carries every host\'s catalog; the cache file stays without it', async () => {
    catalogs.value = { devbox: { models: MODELS, cwd: '/home/u', fetchedAt: '2026-10-08T00:00:00.000Z', sourceSpawnTs: 1 } }
    await runProjectionSelfHealSweep()
    const pushed = sessionsPushes()
    expect(pushed).toHaveLength(1)
    expect(pushed[0].host_model_catalogs).toEqual({ devbox: { models: MODELS, fetchedAt: '2026-10-08T00:00:00.000Z' } })
    expect(pushed[0].sessions).toEqual(envelope.sessions)
    expect(await readProjectionCache('sessions')).toEqual(envelope)
  })

  it('no catalog: the cache file as it is', async () => {
    await runProjectionSelfHealSweep()
    expect(sessionsPushes()).toEqual([envelope])
  })

  it('a new catalog is sent again; the same one is not', async () => {
    catalogs.value = { devbox: { models: MODELS, fetchedAt: '2026-10-08T00:00:00.000Z' } }
    await runProjectionSelfHealSweep()
    await runProjectionSelfHealSweep()
    expect(sessionsPushes()).toHaveLength(1)
    catalogs.value = { devbox: { models: MODELS, fetchedAt: '2026-10-08T01:00:00.000Z' } }
    await runProjectionSelfHealSweep()
    expect(sessionsPushes()).toHaveLength(2)
  })
})
