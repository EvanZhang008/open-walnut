/**
 * The pid-identity probes in src/utils/process.ts on a Linux host without ps (a
 * slim container image). They asked `ps -p <pid> -o command=`, which such a host
 * does not have: every live process with an expected binary read as dead (a live
 * claude among them), and each check printed "ps: not found". On Linux the
 * command line now comes from /proc/<pid>/cmdline.
 *
 * /proc is faked through node:fs (this runs on macOS too); ps is watched, never
 * expected. The pid probed is this test process's own (kill(pid, 0) only).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const proc = vi.hoisted(() => ({ cmdline: new Map<number, string>() }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const existsSync = (p: unknown) => (p === '/proc/self/stat' ? true : real.existsSync(p as string))
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    const m = typeof p === 'string' ? /^\/proc\/(\d+)\/cmdline$/.exec(p) : null
    if (m) {
      const text = proc.cmdline.get(Number(m[1]))
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return text
    }
    return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof real.readFileSync
  const mocked = { ...real, existsSync, readFileSync }
  return { ...mocked, default: mocked }
})
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, execSync: vi.fn(real.execSync), execFile: vi.fn(real.execFile) }
})

import { execFile, execSync } from 'node:child_process'
import { isProcessAlive, isProcessAliveAsync } from '../../src/utils/process.js'

beforeEach(() => {
  proc.cmdline.clear()
  vi.mocked(execSync).mockClear()
  vi.mocked(execFile).mockClear()
})

describe('a pid\'s command line on a Linux host', () => {
  it('comes from /proc/<pid>/cmdline, and no ps is asked', async () => {
    proc.cmdline.set(process.pid, '/usr/local/bin/node\0/home/me/.local/bin/claude\0-p\0')
    expect(isProcessAlive(process.pid, 'claude')).toBe(true)
    expect(await isProcessAliveAsync(process.pid, 'claude')).toBe(true)
    expect(isProcessAlive(process.pid, 'codex')).toBe(false)
    expect(await isProcessAliveAsync(process.pid, 'codex')).toBe(false)
    expect(execSync).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
  })

  it('a pid with no /proc entry left is not the binary', async () => {
    expect(isProcessAlive(process.pid, 'claude')).toBe(false)
    expect(await isProcessAliveAsync(process.pid, 'claude')).toBe(false)
    expect(execSync).not.toHaveBeenCalled()
  })

  it('without an expected binary, kill(pid, 0) alone answers, as before', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(execSync).not.toHaveBeenCalled()
  })
})
