import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

vi.mock('../../src/commands/demo-process.js', () => ({ demoProcessGone: vi.fn() }))
import { demoProcessGone } from '../../src/commands/demo-process.js'
import { closeDemoSignIns, demoSignInDirectories, prepareDemoSignIns, reopenDemoSignIns } from '../../src/commands/demo-sign-ins.js'
import { demoPaths, type DemoPaths } from '../../src/commands/demo-home.js'

let base: string
let paths: DemoPaths
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'demo-sign-ins-')))
  paths = demoPaths(path.join(base, 'open-walnut-demo'), 'g')
  vi.mocked(demoProcessGone).mockReset().mockResolvedValue(true)
})
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }) })
const live = { pid: 4242, startTime: 'ps:Sat Nov 7 07:55:28 2026' }
async function record(value: unknown): Promise<string> {
  const file = path.join(demoSignInDirectories(paths).accepting, `${randomUUID()}.json`)
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 })
  return file
}

describe('Demo sign-in admission across reset', () => {
  it('creates a private accepting dir and never reopens one a failed stop closed', async () => {
    await prepareDemoSignIns(paths)
    const dirs = demoSignInDirectories(paths)
    expect((await fs.stat(dirs.accepting)).mode & 0o777).toBe(0o700)
    await closeDemoSignIns(paths)
    await prepareDemoSignIns(paths)
    await expect(fs.stat(dirs.accepting)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.stat(dirs.closed)).isDirectory()).toBe(true)
  })

  it('keeps all concurrent login identities and refuses while any one is alive', async () => {
    await prepareDemoSignIns(paths)
    await record(live)
    await record({ ...live, pid: 4243 })
    vi.mocked(demoProcessGone).mockImplementation(async row => row.pid !== 4243)
    await expect(closeDemoSignIns(paths)).rejects.toThrow(/still open in Terminal/)
    const dirs = demoSignInDirectories(paths)
    expect((await fs.readdir(dirs.closed)).length).toBe(2)
    vi.mocked(demoProcessGone).mockResolvedValue(true)
    await expect(closeDemoSignIns(paths)).resolves.toBeUndefined()
    await expect(fs.stat(dirs.accepting)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('captures a writer opened before the rename and refuses a partial record without erasing it', async () => {
    await prepareDemoSignIns(paths)
    const dirs = demoSignInDirectories(paths)
    const name = `${randomUUID()}.json`
    const writer = await fs.open(path.join(dirs.accepting, name), 'wx', 0o600)
    try {
      await expect(closeDemoSignIns(paths)).rejects.toThrow()
      expect(await fs.readFile(path.join(dirs.closed, name), 'utf8')).toBe('')
      await writer.writeFile(JSON.stringify(live))
      vi.mocked(demoProcessGone).mockResolvedValue(false)
      await expect(closeDemoSignIns(paths)).rejects.toThrow(/still open in Terminal/)
    } finally { await writer.close() }
  })

  it('a stale script cannot claim a login after reset admission closed', async () => {
    await prepareDemoSignIns(paths)
    const dirs = demoSignInDirectories(paths)
    await closeDemoSignIns(paths)
    await expect(fs.open(path.join(dirs.accepting, `${randomUUID()}.json`), 'wx', 0o600)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([null, {}, { pid: 0, startTime: live.startTime }, { ...live, pid: '4242' }, { ...live, startTime: '' }])('keeps an invalid identity: %j', async value => {
    await prepareDemoSignIns(paths)
    const file = await record(value)
    await expect(closeDemoSignIns(paths)).rejects.toThrow(/identity is unavailable/)
    expect(await fs.readFile(path.join(demoSignInDirectories(paths).closed, path.basename(file)), 'utf8')).toBe(JSON.stringify(value))
    expect(demoProcessGone).not.toHaveBeenCalled()
  })

  it('refuses a symlinked admission directory, leaving the target alone', async () => {
    await prepareDemoSignIns(paths)
    const dirs = demoSignInDirectories(paths)
    const target = path.join(base, 'target')
    await fs.mkdir(target, { mode: 0o700 })
    await fs.rmdir(dirs.accepting)
    await fs.symlink(target, dirs.accepting)
    await expect(closeDemoSignIns(paths)).rejects.toThrow(/not private/)
    expect(await fs.readdir(target)).toEqual([])
  })

  it('refuses a nonprivate record or symlink without following it', async () => {
    await prepareDemoSignIns(paths)
    const file = await record(live)
    await fs.chmod(file, 0o644)
    await expect(closeDemoSignIns(paths)).rejects.toThrow(/not private/)
    expect(demoProcessGone).not.toHaveBeenCalled()
  })

  it('only recovery of confirmed exited logins reopens admission', async () => {
    await prepareDemoSignIns(paths)
    await record(live)
    vi.mocked(demoProcessGone).mockResolvedValue(false)
    await expect(reopenDemoSignIns(paths)).rejects.toThrow(/still open/)
    vi.mocked(demoProcessGone).mockResolvedValue(true)
    await reopenDemoSignIns(paths)
    expect(await fs.readdir(demoSignInDirectories(paths).accepting)).toEqual([])
    await expect(fs.stat(demoSignInDirectories(paths).closed)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('takes an older empty generation without creating admission during a stop', async () => {
    await closeDemoSignIns(paths)
    await expect(fs.stat(demoSignInDirectories(paths).root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
