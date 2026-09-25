/**
 * The page-lifetime helpers in web/src/api/config.ts share ONE GET /api/config.
 * The route is expensive (self-repair probe, memory stats, asset report) and the
 * helpers all fire in the same cold-load fan-out, so each must not own a fetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }))

vi.mock('../../web/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web/src/api/client')>()
  return { ...actual, apiGet: mocks.apiGet }
})

import {
  _resetServerFactsForTest,
  fetchBuildInfo,
  fetchCanRevealLocalFiles,
  fetchInstallDir,
  fetchIsCloudReplica,
  fetchNotesDir,
  fetchSelfRepair,
  invalidateSelfRepair,
  peekBuildInfo,
} from '../../web/src/api/config'

const build = { version: '0.4.5', commit: '3942cf7', branch: 'main', builtAt: '2026-09-24T12:00:00.000Z', dirty: false }
const facts = {
  installDir: '/src/walnut',
  selfRepair: { available: true, source: null, cloneDir: '/clone', repoUrl: 'https://example.com/r.git' },
  notesDir: '/notes',
  canRevealLocalFiles: true,
  cloud: false,
  build,
}

beforeEach(() => {
  mocks.apiGet.mockReset()
  _resetServerFactsForTest()
})

describe('shared GET /api/config', () => {
  it('serves every helper from one request', async () => {
    mocks.apiGet.mockResolvedValue(facts)
    const answers = await Promise.all([
      fetchInstallDir(), fetchSelfRepair(), fetchNotesDir(), fetchCanRevealLocalFiles(), fetchIsCloudReplica(), fetchBuildInfo(),
    ])
    expect(answers).toEqual(['/src/walnut', facts.selfRepair, '/notes', true, false, build])
    expect(await fetchInstallDir()).toBe('/src/walnut')
    expect(mocks.apiGet).toHaveBeenCalledTimes(1)
    expect(mocks.apiGet).toHaveBeenCalledWith('/api/config')
  })

  it('peekBuildInfo is empty until the answer lands, then synchronous', async () => {
    mocks.apiGet.mockResolvedValue(facts)
    expect(peekBuildInfo()).toBeNull()
    await fetchNotesDir()
    expect(peekBuildInfo()).toEqual(build)
  })

  it('a failed fetch resolves every fallback and the next call retries', async () => {
    mocks.apiGet.mockRejectedValueOnce(new Error('offline'))
    expect(await Promise.all([fetchInstallDir(), fetchCanRevealLocalFiles(), fetchIsCloudReplica(), fetchBuildInfo()]))
      .toEqual([null, false, false, null])
    mocks.apiGet.mockResolvedValue(facts)
    expect(await fetchInstallDir()).toBe('/src/walnut')
    expect(mocks.apiGet).toHaveBeenCalledTimes(2)
  })

  it('missing fields read as their fallbacks', async () => {
    mocks.apiGet.mockResolvedValue({})
    expect(await Promise.all([fetchInstallDir(), fetchSelfRepair(), fetchNotesDir(), fetchCanRevealLocalFiles(), fetchIsCloudReplica(), fetchBuildInfo()]))
      .toEqual([null, null, null, false, false, null])
  })

  it('invalidateSelfRepair refetches, so a finished clone shows its new source', async () => {
    mocks.apiGet.mockResolvedValueOnce(facts)
    expect((await fetchSelfRepair())?.source).toBeNull()
    invalidateSelfRepair()
    const cloned = { ...facts.selfRepair, source: { dir: '/clone', kind: 'clone' } }
    mocks.apiGet.mockResolvedValueOnce({ ...facts, selfRepair: cloned })
    expect(await fetchSelfRepair()).toEqual(cloned)
    expect(mocks.apiGet).toHaveBeenCalledTimes(2)
  })
})
