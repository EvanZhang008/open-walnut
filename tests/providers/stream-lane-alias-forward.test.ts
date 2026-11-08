// The stream lane's forward for a host from ~/.ssh/config: its own master and TCP, a mux-only client.
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-lane-alias'))

// Every path under FAKE lives in memory; any other path goes to the real fs untouched.
const fakeFs = vi.hoisted(() => {
  const FAKE = '/walnut-fake-root/'
  const entries = new Map<string, 'socket' | 'file' | 'dir' | 'eacces'>()
  const calls: Array<[string, string]> = []
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  const fake = (p: unknown) => typeof p === 'string' && p.startsWith(FAKE)
  return { FAKE, entries, calls, enoent, fake }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { entries, calls, enoent, fake } = fakeFs
  const over = {
    existsSync: (p: string) => (fake(p) ? entries.has(p) : actual.existsSync(p)),
    lstatSync: (p: string, ...rest: unknown[]) => {
      if (!fake(p)) return (actual.lstatSync as (...a: unknown[]) => unknown)(p, ...rest)
      const t = entries.get(p)
      if (!t) throw enoent(p)
      if (t === 'eacces') throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' })
      return { isSocket: () => t === 'socket', isFile: () => t === 'file', isDirectory: () => t === 'dir', uid: 501 }
    },
    unlinkSync: (p: string) => {
      if (!fake(p)) return actual.unlinkSync(p)
      calls.push(['unlink', p])
      if (!entries.delete(p)) throw enoent(p)
    },
    rmdirSync: (p: string) => {
      if (!fake(p)) return actual.rmdirSync(p)
      calls.push(['rmdir', p])
      if ([...entries.keys()].some((k) => k.startsWith(`${p}/`))) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' })
      if (!entries.delete(p)) throw enoent(p)
    },
    writeFileSync: (p: string, ...rest: unknown[]) => {
      if (!fake(p)) return (actual.writeFileSync as (...a: unknown[]) => void)(p, ...rest)
      calls.push(['write', p])
      entries.set(p, 'file')
    },
    openSync: (p: string, ...rest: unknown[]) => {
      if (fake(p)) throw enoent(p)
      return (actual.openSync as (...a: unknown[]) => number)(p, ...rest)
    },
    mkdtempSync: (prefix: string, ...rest: unknown[]) => {
      if (fake(prefix)) throw new Error('mkdtemp is not expected here')
      return (actual.mkdtempSync as (...a: unknown[]) => string)(prefix, ...rest)
    },
  }
  return { ...actual, ...over, default: { ...actual, ...over } }
})

import { LANE_MASTER_PERSIST_SECS, STOPPED, sshLaneForward, type LaneForwardDeps } from '../../src/providers/stream-lane.js'
import { ownedMuxClientArgs, type SshRunner } from '../../src/providers/ssh-control-master.js'

const DIR = `${fakeFs.FAKE}wl-abc123`
const SOCK = `${DIR}/m`
const LOG = `${SOCK}.log`
const LOGIN = ['-o', 'BatchMode=yes', '-o', 'HostName=devbox.example.test', '-o', 'CanonicalizeHostname=yes', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '-o', 'ClearAllForwardings=yes']

beforeEach(() => {
  fakeFs.entries.clear()
  fakeFs.calls.length = 0
  fakeFs.entries.set(DIR, 'dir')
})

type ExitMode = 'ends' | 'hangs' | 'timeout' | 'fails'

function harness(opts: { ready?: boolean; startCode?: number; startLeavesSocket?: boolean; exitMode?: ExitMode } = {}) {
  const runs: string[][] = []
  const spawns: string[][] = []
  const procs: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; exitCode: number | null }> = []
  const mode = opts.exitMode ?? 'ends'
  const run: SshRunner = async (args) => {
    runs.push(args)
    if (args.includes('ControlMaster=yes')) {
      const code = opts.startCode ?? 0
      if (code === 0 || opts.startLeavesSocket) fakeFs.entries.set(SOCK, 'socket')
      return { stdout: '', stderr: '', code, timedOut: false }
    }
    if (args.includes('-O') && args[args.indexOf('-O') + 1] === 'exit') {
      if (mode === 'hangs') return new Promise(() => {})
      if (mode === 'timeout') return { stdout: '', stderr: '', code: null, timedOut: true }
      if (mode === 'fails') return { stdout: '', stderr: '', code: 255, timedOut: false }
      fakeFs.entries.delete(SOCK)
      procs.at(-1)?.emit('exit', 0, null)
      return { stdout: '', stderr: '', code: 0, timedOut: false }
    }
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  }
  const deps: LaneForwardDeps = {
    run,
    spawn: (_cmd, args) => {
      spawns.push(args)
      const p = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), stdin: new EventEmitter(), exitCode: null, kill: vi.fn() })
      procs.push(p)
      return p as unknown as ChildProcess
    },
    freePort: async () => 40100,
    accepting: async () => opts.ready ?? true,
    makeDir: () => DIR,
    stopWaitMs: 5,
  }
  const exits = () => runs.filter((a) => a.includes('-O') && a[a.indexOf('-O') + 1] === 'exit')
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
  return { deps, runs, spawns, procs, exits, tick }
}

const removed = (p: string) => fakeFs.calls.some(([op, q]) => (op === 'unlink' || op === 'rmdir') && q === p)

describe('sshLaneForward for a host found in ~/.ssh/config', () => {
  it('starts a master of its own (alias auth, no config forwards, bounded persist) in its own dir', async () => {
    const h = harness()
    await sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })
    const start = h.runs.find((a) => a.includes('ControlMaster=yes'))!
    expect(start.slice(0, LOGIN.length)).toEqual(LOGIN)
    expect(start).toContain(`ControlPath=${SOCK}`)
    expect(start).toContain(`ControlPersist=${LANE_MASTER_PERSIST_SECS}`)
    expect(start.slice(-2)).toEqual(['-fN', 'builder@devbox'])
  })

  it('its client is mux-only through that master: no ssh config, its own -L, the real hostname', async () => {
    const h = harness()
    await sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })
    expect(h.spawns).toEqual([[
      ...ownedMuxClientArgs(SOCK), '-T', '-L', '40100:127.0.0.1:9000', '-o', 'ExitOnForwardFailure=yes', 'devbox.example.test', 'exec cat >/dev/null',
    ]])
  })

  it('stop sends its own master -O exit; the client ends with it, so no signal; the dir is cleaned once the socket is gone', async () => {
    const h = harness()
    const fwd = await sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })
    fwd.stop()
    await h.tick()
    expect(h.exits()).toEqual([[...ownedMuxClientArgs(SOCK), '-o', `ControlPath=${SOCK}`, '-O', 'exit', 'devbox.example.test']])
    expect(h.procs[0]!.kill).not.toHaveBeenCalled()
    expect(removed(SOCK)).toBe(false)
    expect(removed(LOG)).toBe(true)
    expect(removed(DIR)).toBe(true)
    expect(await new Promise<string>((resolve) => fwd.onExit(resolve))).toBe(STOPPED)
    expect(h.exits()).toHaveLength(1)
  })

  it('an -O exit that never answers: only its own still-alive client gets SIGTERM, once', async () => {
    const h = harness({ exitMode: 'hangs' })
    const fwd = await sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })
    fwd.stop()
    fwd.stop()
    await h.tick(20)
    expect(h.exits()).toHaveLength(1)
    expect(h.procs[0]!.kill).toHaveBeenCalledTimes(1)
    expect(h.procs[0]!.kill).toHaveBeenCalledWith('SIGTERM')
    expect(removed(SOCK)).toBe(false)
  })

  it('an -O exit that timed out: the same, and the socket is kept', async () => {
    const h = harness({ exitMode: 'timeout' })
    const fwd = await sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })
    fwd.stop()
    await h.tick(20)
    expect(h.procs[0]!.kill).toHaveBeenCalledTimes(1)
    expect(removed(SOCK)).toBe(false)
    expect(removed(DIR)).toBe(false)
  })

  it('stopping twice sends one -O exit and signals nothing when the master took the client', async () => {
    const h = harness()
    const fwd = await sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })
    fwd.stop()
    fwd.stop()
    await h.tick(20)
    fwd.stop()
    expect(h.exits()).toHaveLength(1)
    expect(h.procs[0]!.kill).not.toHaveBeenCalled()
  })

  it('a stop wins over what ssh said: the exit reads as stopped', async () => {
    const h = harness({ exitMode: 'hangs' })
    const fwd = await sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })
    fwd.stop()
    h.procs[0]!.stderr.emit('data', Buffer.from('mux_client_request_session: read from master failed\n'))
    h.procs[0]!.emit('exit', 255, null)
    expect(await new Promise<string>((resolve) => fwd.onExit(resolve))).toBe(STOPPED)
    await h.tick(20)
    expect(h.procs[0]!.kill).not.toHaveBeenCalled()
  })

  it('a socket that cannot be checked (EACCES) is not taken for gone: log and dir stay', async () => {
    const h = harness({ exitMode: 'fails' })
    const fwd = await sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })
    fakeFs.entries.set(SOCK, 'eacces')
    fwd.stop()
    await h.tick(20)
    expect(removed(LOG)).toBe(false)
    expect(removed(DIR)).toBe(false)
  })

  it('an -O exit that leaves the socket keeps the socket, the log and the dir', async () => {
    const h = harness({ exitMode: 'fails' })
    const fwd = await sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })
    fwd.stop()
    await h.tick(20)
    expect(h.exits()).toHaveLength(1)
    expect(h.procs[0]!.kill).toHaveBeenCalledTimes(1)
    expect(removed(SOCK)).toBe(false)
    expect(removed(LOG)).toBe(false)
    expect(removed(DIR)).toBe(false)
    expect(fakeFs.entries.get(SOCK)).toBe('socket')
  })

  it('a forward that never opens ends its own master and throws', async () => {
    const h = harness({ ready: false })
    await expect(sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps }))
      .rejects.toThrow(/did not open/)
    expect(h.exits()).toHaveLength(1)
    expect(h.procs[0]!.kill).not.toHaveBeenCalled()
  })

  it('a master that cannot start is told to exit, and no client is spawned', async () => {
    const h = harness({ startCode: 255 })
    await expect(sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })).rejects.toThrow()
    expect(h.spawns).toEqual([])
    expect(h.exits()).toHaveLength(1)
  })

  it('a failed start whose socket survives -O exit keeps everything', async () => {
    const h = harness({ startCode: 255, startLeavesSocket: true, exitMode: 'fails' })
    await expect(sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })).rejects.toThrow()
    expect(removed(SOCK)).toBe(false)
    expect(removed(LOG)).toBe(false)
    expect(removed(DIR)).toBe(false)
  })

  it('a socket already in its dir is never used or removed', async () => {
    fakeFs.entries.set(SOCK, 'socket')
    const h = harness()
    await expect(sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })).rejects.toThrow(/not usable/)
    expect(h.runs).toEqual([])
    expect(fakeFs.calls).toEqual([])
  })

  it('a client that dies on its own says its master was lost, and the master is told to exit', async () => {
    const h = harness()
    const fwd = await sshLaneForward(LOGIN, 'builder@devbox', 9000, { ownMaster: { hostname: 'devbox.example.test' }, deps: h.deps })
    fakeFs.entries.delete(SOCK)
    const why = new Promise<string>((resolve) => fwd.onExit(resolve))
    h.procs[0]!.emit('exit', 255, null)
    expect(await why).toMatch(/^SSH master lost: /)
    await h.tick()
    expect(h.exits()).toHaveLength(1)
  })
})

describe('sshLaneForward for a manual host', () => {
  it('keeps its own direct forward: no master, the args it always had', async () => {
    const h = harness()
    const manual = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
    const fwd = await sshLaneForward(manual, 'dev@box.example.com', 9000, { deps: h.deps })
    expect(h.runs).toEqual([])
    expect(h.spawns[0]).toEqual([
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'RemoteCommand=none', ...manual,
      '-T', '-L', '40100:127.0.0.1:9000', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      'dev@box.example.com', 'exec cat >/dev/null',
    ])
    fwd.stop()
    expect(h.procs[0]!.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
