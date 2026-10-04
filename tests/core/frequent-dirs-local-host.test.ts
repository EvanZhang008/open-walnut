/**
 * The launcher drew two identical "walnut · Local" chips: the same folder sat in
 * the store under host null (count 1108) and under host '' (a caller that passed
 * an empty string). '' and null both mean this machine, so one folder = one entry.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-frequent-dirs-local'))

import { FREQUENT_DIRS_FILE } from '../../src/constants.js'
import { getFrequentDirs, recordDirectory, recordDirectoryUses, recordLaunchPrefs } from '../../src/core/frequent-dirs.js'

function seed(directories: unknown[]): void {
  fs.writeFileSync(FREQUENT_DIRS_FILE, JSON.stringify({ version: 1, compiledAt: '2026-10-01T00:00:00Z', directories }))
}

const stored = () => JSON.parse(fs.readFileSync(FREQUENT_DIRS_FILE, 'utf-8')).directories as Array<{ cwd: string; host: string | null; count: number }>

beforeEach(() => {
  fs.rmSync(FREQUENT_DIRS_FILE, { force: true })
})

describe('frequent-dirs: the empty host is this machine', () => {
  it("folds a legacy host '' row into the null-host row on read", async () => {
    seed([
      { cwd: '/repo', host: null, count: 1108, lastUsed: '2026-10-01T00:00:00Z', projectVotes: { Walnut: 1000 }, lastLaunch: { model: 'm1' } },
      { cwd: '/repo', host: '', count: 1, lastUsed: '2026-10-03T18:41:31Z', projectVotes: { Walnut: 1 } },
      { cwd: '/repo', host: 'devbox', count: 2, lastUsed: '2026-08-01T00:00:00Z', projectVotes: {} },
    ])
    const dirs = await getFrequentDirs()
    expect(dirs).toHaveLength(2)
    const local = dirs.find((d) => d.host === null)!
    expect(local.count).toBe(1109)
    expect(local.lastUsed).toBe('2026-10-03T18:41:31Z')
    expect(local.projectVotes).toEqual({ Walnut: 1001 })
    expect(local.lastLaunch).toEqual({ model: 'm1' })
    expect(dirs.find((d) => d.host === 'devbox')?.count).toBe(2)
  })

  it("recordDirectory with host '' counts against the local row instead of adding one", async () => {
    seed([{ cwd: '/repo', host: null, count: 5, lastUsed: '2026-10-01T00:00:00Z', projectVotes: {} }])
    await recordDirectory('/repo', '', 'Walnut')
    expect(stored()).toEqual([expect.objectContaining({ cwd: '/repo', host: null, count: 6 })])
  })

  it("recordDirectory stores a new folder's empty host as null", async () => {
    seed([])
    await recordDirectory('/fresh', '')
    expect(stored()).toEqual([expect.objectContaining({ cwd: '/fresh', host: null, count: 1 })])
  })

  it("recordDirectoryUses and recordLaunchPrefs treat '' as local too", async () => {
    seed([{ cwd: '/repo', host: null, count: 1, lastUsed: '2026-10-01T00:00:00Z', projectVotes: {} }])
    await recordDirectoryUses([{ cwd: '/repo', host: '' }])
    await recordLaunchPrefs('/repo', '', { model: 'm2' })
    const rows = stored()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ host: null, count: 2 })
    expect((rows[0] as { lastLaunch?: unknown }).lastLaunch).toEqual({ model: 'm2' })
  })
})
