// Control commands for a master reach it through the args they are handed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Every path under FAKE lives in memory; any other path goes to the real fs untouched.
const fakeFs = vi.hoisted(() => {
  const FAKE = '/walnut-fake-root/'
  const entries = new Map<string, 'socket' | 'file'>()
  const calls: Array<[string, string]> = []
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  const fake = (p: unknown) => typeof p === 'string' && p.startsWith(FAKE)
  return { FAKE, entries, calls, enoent, fake }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { entries, calls, enoent, fake } = fakeFs
  const over = {
    unlinkSync: (p: string) => {
      if (!fake(p)) return actual.unlinkSync(p)
      calls.push(['unlink', p])
      if (!entries.delete(p)) throw enoent(p)
    },
    writeFileSync: (p: string, ...rest: unknown[]) => {
      if (!fake(p)) return (actual.writeFileSync as (...a: unknown[]) => void)(p, ...rest)
      calls.push(['write', p])
      entries.set(p, 'file')
    },
    readFileSync: (p: string, ...rest: unknown[]) => {
      if (fake(p)) throw enoent(p)
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
    },
    openSync: (p: string, ...rest: unknown[]) => {
      if (fake(p)) throw enoent(p)
      return (actual.openSync as (...a: unknown[]) => number)(p, ...rest)
    },
  }
  return { ...actual, ...over, default: { ...actual, ...over } }
})

import { cancelRecordedForwards, exitControlMaster, ownedMuxClientArgs, removeStaleMaster, startControlMaster, type SshRunner } from '../../src/providers/ssh-control-master.js'

const SOCK = `${fakeFs.FAKE}walnut-ssh-devbox-abc`
const LOGIN = ['-o', 'BatchMode=yes', '-o', 'HostName=devbox.example.test', '-o', 'CanonicalizeHostname=yes', '-o', 'ClearAllForwardings=yes']

beforeEach(() => {
  fakeFs.entries.clear()
  fakeFs.calls.length = 0
})

function recorder() {
  const runs: string[][] = []
  const run: SshRunner = async (args) => { runs.push(args); return { stdout: '', stderr: '', code: 0, timedOut: false } }
  return { runs, run }
}

describe('owned mux control commands', () => {
  it('a stale master is told to exit through the control args, never the alias login', async () => {
    const r = recorder()
    await removeStaleMaster(SOCK, LOGIN, 'builder@devbox', { run: r.run, control: { args: ownedMuxClientArgs(SOCK), host: 'devbox.example.test' } })
    expect(r.runs).toEqual([[...ownedMuxClientArgs(SOCK), '-o', `ControlPath=${SOCK}`, '-O', 'exit', 'devbox.example.test']])
  })

  it('without control args a stale master exits with the login args, as before', async () => {
    const r = recorder()
    await removeStaleMaster(SOCK, LOGIN, 'builder@devbox', { run: r.run })
    expect(r.runs).toEqual([[...LOGIN, '-o', `ControlPath=${SOCK}`, '-O', 'exit', 'builder@devbox']])
  })

  it('exit and cancel run exactly the args they are handed', async () => {
    const r = recorder()
    await exitControlMaster(SOCK, ownedMuxClientArgs(SOCK), 'devbox.example.test', { run: r.run })
    expect(r.runs[0]!.slice(0, 4)).toEqual(['-F', '/dev/null', '-S', SOCK])
    expect(await cancelRecordedForwards(SOCK, ownedMuxClientArgs(SOCK), 'devbox.example.test', { run: r.run })).toEqual([])
  })

  it('a start takes its persist time from the caller, else the default', async () => {
    const r = recorder()
    await startControlMaster(SOCK, LOGIN, 'builder@devbox', { run: r.run, persistSecs: 30 })
    await startControlMaster(SOCK, LOGIN, 'builder@devbox', { run: r.run })
    expect(r.runs[0]).toContain('ControlPersist=30')
    expect(r.runs[1]).toContain('ControlPersist=300')
    expect(fakeFs.calls.every(([, p]) => p.startsWith(fakeFs.FAKE))).toBe(true)
  })
})
