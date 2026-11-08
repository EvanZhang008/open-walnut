import fs from 'node:fs/promises'
import childProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: (...args: Parameters<typeof actual.execFile>) => actual.default.execFile(...args) }
})
import { demoProcessGone, demoProcessStart, demoServerGroupGone } from '../../src/commands/demo-process.js'

const pid = 4242
beforeEach(() => { vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill) })
afterEach(() => vi.restoreAllMocks())
const stat = (start: string) => `${pid} (a process) S ${Array(18).fill('0').join(' ')} ${start} 0`

describe('Demo server process identity', () => {
  it('keeps data when the server exited but its group remains alive', async () => {
    vi.mocked(process.kill).mockImplementation(((target: number) => {
      if (target === pid) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      return true
    }) as typeof process.kill)
    expect(await demoServerGroupGone({ pid })).toBe(false)
    expect(vi.mocked(process.kill).mock.calls).toEqual([[pid, 0], [-pid, 0]])
  })

  it.each(['EPERM', 'EACCES', 'EIO'])('an unknown server group (%s) keeps data', async code => {
    vi.mocked(process.kill).mockImplementation(((target: number) => {
      throw Object.assign(new Error('probe'), { code: target === pid ? 'ESRCH' : code })
    }) as typeof process.kill)
    expect(await demoServerGroupGone({ pid })).toBe(false)
  })

  it('clears only after both server and group probes confirm ESRCH', async () => {
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    expect(await demoServerGroupGone({ pid })).toBe(true)
    expect(vi.mocked(process.kill).mock.calls).toEqual([[pid, 0], [-pid, 0]])
  })

  it.each([-1, 0, 1, 1.5, NaN])('refuses an invalid process identity %s without any probe', async pid => {
    for (const check of [demoServerGroupGone, demoProcessGone]) await expect(check({ pid })).rejects.toThrow(/Invalid/)
    await expect(demoProcessStart(pid)).rejects.toThrow(/Invalid/)
    expect(process.kill).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform !== 'linux')('distinguishes a reused pid from the recorded server without signalling it', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(stat('222'))
    expect(await demoProcessStart(pid)).toBe('proc:222')
    expect(await demoProcessGone({ pid, startTime: 'proc:111' })).toBe(true)
    expect(await demoProcessGone({ pid, startTime: 'proc:222' })).toBe(false)
    for (const args of vi.mocked(process.kill).mock.calls) expect(args).toEqual([pid, 0])
  })

  it.skipIf(process.platform !== 'linux')('a reused pid does not probe an unrelated new process group', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(stat('222'))
    expect(await demoServerGroupGone({ pid, startTime: 'proc:111' })).toBe(true)
    expect(await demoServerGroupGone({ pid, startTime: 'proc:222' })).toBe(false)
    expect(vi.mocked(process.kill).mock.calls).toEqual([[pid, 0], [pid, 0]])
  })

  it('compares a recorded ps identity without probing the reused process group', async () => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_file: string, _args: string[], _opts: unknown, done: (error: null, out: string) => void) => {
      done(null, 'Sat Nov  7 11:00:00 2026\n')
      return {} as childProcess.ChildProcess
    }) as typeof childProcess.execFile)
    expect(await demoServerGroupGone({ pid, startTime: 'ps:Sat Nov 7 10:00:00 2026' })).toBe(true)
    expect(await demoServerGroupGone({ pid, startTime: 'ps:Sat Nov 7 11:00:00 2026' })).toBe(false)
    expect(vi.mocked(process.kill).mock.calls).toEqual([[pid, 0], [pid, 0]])
  })

  it.each([true, false])('checks the group after the pid exits during its ps read (group gone: %s)', async gone => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_file: string, _args: string[], _opts: unknown, done: (error: Error, out: string) => void) => {
      done(new Error('process exited'), '')
      return {} as childProcess.ChildProcess
    }) as typeof childProcess.execFile)
    let probes = 0
    vi.mocked(process.kill).mockImplementation(((target: number) => {
      if (++probes === 1 || target === -pid && !gone) return true
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    }) as typeof process.kill)
    expect(await demoServerGroupGone({ pid, startTime: 'ps:Sat Nov 7 10:00:00 2026' })).toBe(gone)
    expect(vi.mocked(process.kill).mock.calls).toEqual([[pid, 0], [pid, 0], [-pid, 0]])
  })

  it.each(['EPERM', 'EACCES', 'EIO'])('an unknown server identity (%s) never guesses a reused pid', async code => {
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('unavailable'), { code }) })
    const read = vi.spyOn(fs, 'readFile')
    expect(await demoServerGroupGone({ pid, startTime: 'proc:111' })).toBe(false)
    expect(read).not.toHaveBeenCalled()
    expect(vi.mocked(process.kill).mock.calls).toEqual([[pid, 0]])
  })

  it('an older state without a start time is not treated as gone on an unknown pid', async () => {
    expect(await demoProcessGone({ pid })).toBe(false)
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('permission'), { code: 'EPERM' }) })
    expect(await demoProcessGone({ pid })).toBe(false)
  })

  it('uses the recorded ps format even on Linux for a native sign-in marker', async () => {
    const startTime = await demoProcessStart(process.pid, 'ps')
    expect(startTime).toMatch(/^ps:/)
    expect(await demoProcessGone({ pid: process.pid, startTime: startTime! })).toBe(false)
    expect(await demoProcessGone({ pid: process.pid, startTime: 'ps:another process' })).toBe(true)
  })

  it('a confirmed missing pid is gone without a process table guess', async () => {
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    expect(await demoProcessGone({ pid, startTime: 'proc:111' })).toBe(true)
  })

  it.skipIf(process.platform !== 'linux')('keeps data when the start time cannot be read', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'EACCES' }))
    await expect(demoProcessGone({ pid, startTime: 'proc:111' })).rejects.toThrow(/unavailable/)
  })
})
