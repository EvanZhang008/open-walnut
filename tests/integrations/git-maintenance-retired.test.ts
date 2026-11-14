import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-retired-maintenance'))
vi.mock('../../src/core/boot-policy.js', () => ({ bootPolicy: () => false }))
vi.mock('../../src/core/capabilities.js', () => ({ hasCapability: (name: string) => name === 'bridge-door' }))

import { WALNUT_HOME } from '../../src/constants.js'
import { DEBRIS_MAX_AGE_MS, startGitMaintenance } from '../../src/integrations/git-maintenance.js'

let handle: ReturnType<typeof startGitMaintenance> | undefined
afterEach(async () => {
  handle?.stop()
  handle = undefined
  vi.unstubAllEnvs()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('retired data worktree maintenance', () => {
  it('sweeps stale transfer debris without expiring refs or running gc on the old copy', async () => {
    // No hub here: exercising only the retired worktree branch of the real scheduler.
    vi.stubEnv('WALNUT_GIT_HUB_DIR', path.join(WALNUT_HOME, 'missing-hub'))
    // The same pass sweeps deploy bundles: never let this test use the real temp dir.
    const tmp = path.join(WALNUT_HOME, 'test-tmp')
    await fs.mkdir(tmp, { recursive: true })
    vi.stubEnv('TMPDIR', tmp)
    vi.stubEnv('TMP', tmp)
    vi.stubEnv('TEMP', tmp)
    const gitDir = path.join(WALNUT_HOME, '.git')
    const packDir = path.join(gitDir, 'objects', 'pack')
    await fs.mkdir(packDir, { recursive: true })
    await fs.mkdir(path.join(gitDir, 'refs', 'heads'), { recursive: true })
    const stale = path.join(packDir, 'tmp_pack_old')
    const fresh = path.join(packDir, 'tmp_pack_live')
    const realPack = path.join(packDir, 'pack-existing.pack')
    const backup = path.join(gitDir, 'refs', 'heads', 'backup-20200101')
    for (const file of [stale, fresh, realPack, backup]) await fs.writeFile(file, 'preserve unless stale temporary debris')
    const old = new Date(Date.now() - DEBRIS_MAX_AGE_MS - 60_000)
    const deploy = path.join(tmp, 'walnut-retired.bundle')
    const other = path.join(tmp, 'unrelated.bundle')
    await fs.writeFile(deploy, 'rebuildable')
    await fs.writeFile(other, 'keep')
    await fs.utimes(deploy, old, old)
    await fs.utimes(other, old, old)
    const looseTmp = path.join(gitDir, 'objects', 'ab', 'tmp_obj_old')
    await fs.mkdir(path.dirname(looseTmp), { recursive: true })
    await fs.writeFile(looseTmp, 'not scanned')
    await fs.utimes(looseTmp, old, old)
    await fs.utimes(stale, old, old)
    await fs.utimes(realPack, old, old)
    await fs.utimes(backup, old, old)
    handle = startGitMaintenance({ startDelayMs: 3_600_000 })
    expect(await handle.runOnce(true)).toEqual([])
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(deploy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(other, 'utf8')).toBe('keep')
    expect(await fs.readFile(looseTmp, 'utf8')).toBe('not scanned')
    for (const file of [fresh, realPack, backup]) expect(await fs.readFile(file, 'utf8')).toBe('preserve unless stale temporary debris')
    await expect(fs.stat(path.join(gitDir, 'walnut-last-maintenance'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
