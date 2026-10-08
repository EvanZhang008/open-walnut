/**
 * What the companion needs for its model picker while the Mac is away
 * (src/core/session-projection.ts): each projected session carries the CLI
 * model and the effort in effect, and the copy pushed to the companion carries
 * every host's model catalog beside the rows. The Mac's own cache and the
 * phone-facing projection stay without the catalogs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-model'))
const pushes = vi.hoisted(() => [] as Array<{ kind: string; payload: { which: string; data: Record<string, unknown> } }>)
const writes = vi.hoisted(() => [] as Array<{ which: string; data: Record<string, unknown> }>)
vi.mock('../../src/core/projection-cache.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/projection-cache.js')>()),
  pushProjectionToCloud: (kind: string, payload: { which: string; data: Record<string, unknown> }) => { pushes.push({ kind, payload }) },
  writeProjectionCache: async (which: string, data: Record<string, unknown>) => { writes.push({ which, data }) },
}))
const catalogs = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../src/core/host-model-catalog.js', () => ({ listHostModelCatalogs: async () => catalogs.value }))
vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: async () => [{
    claudeSessionId: 'bbbbbbbb-2222-4222-8222-222222222222', host: 'devbox', process_status: 'idle',
    startedAt: '2026-10-07T10:00:00Z', lastActiveAt: '2026-10-07T11:00:00Z',
    model: 'opus', cliModel: 'sonnet[1m]', effort: 'high', effectiveEffort: 'medium',
  }],
  isListableSession: () => true,
}))
vi.mock('../../src/core/task-manager.js', () => ({ listTasks: async () => [], listFolderLabels: async () => new Map() }))

import { buildSessionProjection, exportSessionProjection, projectSession } from '../../src/core/session-projection.js'
import type { SessionRecord } from '../../src/core/types.js'

const MODELS = [{ value: 'sonnet[1m]', displayName: 'Sonnet (1M)', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }]

beforeEach(() => {
  pushes.length = 0
  writes.length = 0
  catalogs.value = {}
})

describe('session projection: model fields', () => {
  it('a row carries the CLI model and the effort in effect (the CLI\'s own over the requested one)', () => {
    const row = projectSession({
      claudeSessionId: 's1', host: 'devbox', process_status: 'idle', startedAt: 'a', lastActiveAt: 'b',
      model: 'opus', cliModel: 'opus[1m]', effort: 'high', effectiveEffort: 'medium',
    } as SessionRecord, undefined)
    expect(row).toMatchObject({ model: 'opus', cli_model: 'opus[1m]', effort: 'medium' })
    const bare = projectSession({ claudeSessionId: 's2', process_status: 'idle', startedAt: 'a', lastActiveAt: 'b', effort: 'low' } as SessionRecord, undefined)
    expect(bare.cli_model).toBeUndefined()
    expect(bare.effort).toBe('low')
  })

  it('the copy pushed to the companion carries each host\'s catalog; the Mac\'s cache and the built projection do not', async () => {
    catalogs.value = {
      devbox: { models: MODELS, cwd: '/home/u/repo', fetchedAt: '2026-10-07T20:00:00Z', sourceSpawnTs: 1 },
      empty: { models: [], fetchedAt: '2026-10-07T20:00:00Z' },
    }
    expect(await exportSessionProjection()).toBe(1)
    expect(pushes).toHaveLength(1)
    expect(pushes[0].payload.which).toBe('sessions')
    // Only what the picker reads: no working directory, no spawn clock, no empty catalog.
    expect(pushes[0].payload.data.host_model_catalogs).toEqual({ devbox: { models: MODELS, fetchedAt: '2026-10-07T20:00:00Z' } })
    expect(writes[0].data.host_model_catalogs).toBeUndefined()
    expect((await buildSessionProjection()).host_model_catalogs).toBeUndefined()
  })

  it('no catalog at all: the push is the projection as it was', async () => {
    await exportSessionProjection()
    expect(pushes[0].payload.data).not.toHaveProperty('host_model_catalogs')
    expect((pushes[0].payload.data.sessions as Array<Record<string, unknown>>)[0]).toMatchObject({ cli_model: 'sonnet[1m]', effort: 'medium' })
  })
})
