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
  fetchServerRole,
  roleFactsOf,
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
      fetchInstallDir(), fetchSelfRepair(), fetchNotesDir(), fetchCanRevealLocalFiles(), fetchServerRole().then((r) => r.replica), fetchBuildInfo(),
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
    expect(await Promise.all([fetchInstallDir(), fetchCanRevealLocalFiles(), fetchServerRole().then((r) => r.replica), fetchBuildInfo()]))
      .toEqual([null, false, false, null])
    mocks.apiGet.mockResolvedValue(facts)
    expect(await fetchInstallDir()).toBe('/src/walnut')
    expect(mocks.apiGet).toHaveBeenCalledTimes(2)
  })

  it('missing fields read as their fallbacks', async () => {
    mocks.apiGet.mockResolvedValue({})
    expect(await Promise.all([fetchInstallDir(), fetchSelfRepair(), fetchNotesDir(), fetchCanRevealLocalFiles(), fetchServerRole().then((r) => r.replica), fetchBuildInfo()]))
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

describe('roleFactsOf: role and capabilities, read from `cloud` on an older server', () => {
  const all = ['public-door', 'bridge-door', 'cloud-exec', 'backup-leader']
  it('the Mac: the leader, no capabilities', () => {
    expect(roleFactsOf({ cloud: false, role: 'leader' })).toEqual({ replica: false, capabilities: [] })
  })
  it('a host replica answering alone: a replica, no capabilities', () => {
    expect(roleFactsOf({ cloud: false, role: 'replica', serverCapabilities: [] })).toEqual({ replica: true, capabilities: [] })
    expect(roleFactsOf({ cloud: false, role: 'replica' })).toEqual({ replica: true, capabilities: [] })
  })
  it('the companion names its own capabilities', () => {
    expect(roleFactsOf({ cloud: true, role: 'replica', serverCapabilities: ['public-door'] })).toEqual({ replica: true, capabilities: ['public-door'] })
  })
  it('an older companion (only `cloud`, or `role` with no capabilities) offers all four', () => {
    expect(roleFactsOf({ cloud: true })).toEqual({ replica: true, capabilities: all })
    expect(roleFactsOf({ cloud: true, role: 'replica' })).toEqual({ replica: true, capabilities: all })
  })
  it('an older Mac or no answer: the leader', () => {
    expect(roleFactsOf({})).toEqual({ replica: false, capabilities: [] })
    expect(roleFactsOf(null)).toEqual({ replica: false, capabilities: [] })
  })
  it('fetchServerRole reads the shared answer', async () => {
    mocks.apiGet.mockResolvedValue({ ...facts, cloud: true })
    expect(await fetchServerRole()).toEqual({ replica: true, capabilities: all })
  })
})

describe('the web reads the same field names the server sends', () => {
  it('every key of src/web/server-facts.ts ServerFacts is declared on the web config facts', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(import.meta.dirname, '..', '..')
    const server = fs.readFileSync(path.join(root, 'src/web/server-facts.ts'), 'utf8')
    const web = fs.readFileSync(path.join(root, 'web/src/api/config.ts'), 'utf8')
    const body = /export interface ServerFacts \{([\s\S]*?)\n\}/.exec(server)?.[1] ?? ''
    const keys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1])
    expect(keys).toEqual(expect.arrayContaining(['role', 'placement', 'serverCapabilities', 'leader']))
    for (const k of ['role', 'placement', 'serverCapabilities']) expect(web).toMatch(new RegExp(`\\n\\s*${k}\\?:`))
  })
})
