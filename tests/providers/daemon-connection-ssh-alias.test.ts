// A found host dials its ~/.ssh/config alias; its forwards ride only Walnut's own master with no ssh config.
import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ssh-alias'))

const spawned = vi.hoisted(() => [] as Array<{ cmd: string; args: string[] }>)
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      spawned.push({ cmd, args })
      return Object.assign(new EventEmitter(), { stderr: new EventEmitter(), stdin: null, exitCode: null, unref() {}, kill: vi.fn() })
    }),
  }
})
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  const fakeSocket = () => Object.assign(new EventEmitter(), { destroy() {}, setTimeout() {} })
  return {
    ...actual,
    createServer: () => Object.assign(new EventEmitter(), {
      listen: (_p: number, _h: string, cb: () => void) => { queueMicrotask(cb) },
      address: () => ({ port: 40001 }),
      close: (cb: () => void) => { cb() },
    }),
    createConnection: (_o: unknown, cb: () => void) => { queueMicrotask(cb); return fakeSocket() },
  }
})

const master = vi.hoisted(() => ({
  plan: vi.fn(async () => ({ action: 'reuse' as const, state: 'live' as const })),
  cancel: vi.fn(async () => [] as string[]),
  start: vi.fn(async () => ({ previousLastWords: '' })),
  exit: vi.fn(async () => {}),
}))
vi.mock('../../src/providers/ssh-control-master.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/ssh-control-master.js')>()
  return {
    ...actual,
    planControlMaster: master.plan,
    cancelRecordedForwards: master.cancel,
    startControlMaster: master.start,
    exitControlMaster: master.exit,
    recordForward: () => {},
  }
})

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { controlSocketPath, ownedMuxClientArgs } from '../../src/providers/ssh-control-master.js'
import { sshAliasOptions, sshDestination, type SshTarget } from '../../src/providers/session-io.js'

interface SshInternals {
  _controlPath: string | null
  sshHostString: string
  sshTargetIdentity: string
  baseSshArgs: string[]
  buildSshArgs(opts?: { useControlMaster: boolean }): string[]
  forwardSsh(): { args: string[]; dest: string }
  ensureControlMaster(): Promise<void>
  stopControlMaster(opts?: { keep?: boolean }): Promise<void>
  createTunnel(remotePort: number): Promise<number>
  ensurePortForward(remotePort: number, target?: string): Promise<number>
}

function internals(target: SshTarget, hostKey = 'devbox'): SshInternals {
  return new DaemonConnection(hostKey, target) as unknown as SshInternals
}

const BASE = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
const ALIAS = (h: string) => ['-o', `HostName=${h}`, '-o', 'CanonicalizeHostname=yes', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '-o', 'ClearAllForwardings=yes']
const FOUND: SshTarget = { hostname: 'devbox.example.test', sshAlias: 'devbox', user: 'builder', port: 2200 }
const SOCK = '/walnut-test-nonexistent/walnut-ssh-devbox-abc'

beforeEach(() => {
  spawned.length = 0
  for (const f of Object.values(master)) f.mockClear()
})

describe('session-io ssh helpers', () => {
  it('sshDestination: the alias for a found host, else the hostname, with the user', () => {
    expect(sshDestination(FOUND)).toBe('builder@devbox')
    expect(sshDestination({ hostname: 'devbox.example.test', sshAlias: 'devbox' })).toBe('devbox')
    expect(sshDestination({ hostname: 'box.example.com', user: 'dev' })).toBe('dev@box.example.com')
  })

  it('sshAliasOptions: nothing for a manual host; an alias login always clears config forwards and refuses a TTY', () => {
    expect(sshAliasOptions({ hostname: 'box.example.com' })).toEqual([])
    expect(sshAliasOptions({ hostname: 'box.example.com' }, { tty: true })).toEqual([])
    expect(sshAliasOptions({ hostname: 'd.example.test', sshAlias: 'd' })).toEqual(ALIAS('d.example.test'))
    expect(sshAliasOptions({ hostname: 'd.example.test', sshAlias: 'd' }, { tty: true }))
      .toEqual(['-o', 'HostName=d.example.test', '-o', 'CanonicalizeHostname=yes', '-o', 'RemoteCommand=none', '-o', 'ClearAllForwardings=yes'])
  })

  it('ownedMuxClientArgs: no ssh config at all, mux only, never a login of its own', () => {
    expect(ownedMuxClientArgs(SOCK)).toEqual(['-F', '/dev/null', '-S', SOCK, '-o', 'ControlMaster=no', '-o', 'ProxyCommand=false', '-o', 'BatchMode=yes'])
  })
})

describe('DaemonConnection: login args for a found host', () => {
  it('dials the alias with the real hostname, explicit user and port, no config forwards, no TTY', () => {
    const c = internals(FOUND)
    expect(c.sshHostString).toBe('builder@devbox')
    expect(c.buildSshArgs({ useControlMaster: false })).toEqual([...BASE, ...ALIAS('devbox.example.test'), '-p', '2200'])
    expect(c.baseSshArgs).toContain('ClearAllForwardings=yes')
  })

  it('an edited hostname is still the machine dialled, under the alias', () => {
    const c = internals({ hostname: 'devbox-new.example.test', sshAlias: 'devbox' })
    expect(c.sshHostString).toBe('devbox')
    expect(c.buildSshArgs({ useControlMaster: false })).toContain('HostName=devbox-new.example.test')
  })

  it('a manual host keeps its exact destination and args', () => {
    const c = internals({ hostname: 'box.example.com', user: 'dev', port: 2222 }, 'box')
    expect(c.sshHostString).toBe('dev@box.example.com')
    expect(c.buildSshArgs({ useControlMaster: false })).toEqual([...BASE, '-p', '2222'])
  })

  it('the master identity is the real user@hostname:port, so a changed hostname never reuses the old socket', () => {
    expect(internals(FOUND).sshTargetIdentity).toBe('builder@devbox.example.test:2200')
    expect(internals({ hostname: 'box.example.com', user: 'dev' }, 'box').sshTargetIdentity).toBe('dev@box.example.com:')
    const a = internals({ hostname: 'devbox-a.example.test', sshAlias: 'devbox' }).sshTargetIdentity
    const b = internals({ hostname: 'devbox-b.example.test', sshAlias: 'devbox' }).sshTargetIdentity
    const home = '/walnut-home-for-test'
    expect(controlSocketPath({ hostKey: 'devbox', target: a, home }, '/sock')).not.toBe(controlSocketPath({ hostKey: 'devbox', target: b, home }, '/sock'))
  })

  it('the alias is part of the pooled target', () => {
    const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test', sshAlias: 'devbox' })
    expect(conn.targetsSame({ hostname: 'devbox.example.test', sshAlias: 'devbox' })).toBe(true)
    expect(conn.targetsSame({ hostname: 'devbox.example.test' })).toBe(false)
    expect(conn.targetsSame({ hostname: 'devbox-new.example.test', sshAlias: 'devbox' })).toBe(false)
  })
})

describe('DaemonConnection: Walnut\'s own forwards for a found host', () => {
  it('ride only Walnut\'s master with no ssh config, to the real hostname', () => {
    const c = internals(FOUND)
    c._controlPath = SOCK
    expect(c.forwardSsh()).toEqual({ args: ownedMuxClientArgs(SOCK), dest: 'devbox.example.test' })
  })

  it('without Walnut\'s master: a clear failure, never a direct login carrying config forwards', () => {
    const c = internals(FOUND)
    expect(() => c.forwardSsh()).toThrow(/SSH master unavailable for devbox/)
  })

  it('a manual host keeps its forward args, master or not', () => {
    const c = internals({ hostname: 'box.example.com', user: 'dev' }, 'box')
    expect(c.forwardSsh()).toEqual({ args: BASE, dest: 'dev@box.example.com' })
    c._controlPath = SOCK
    expect(c.forwardSsh()).toEqual({ args: [...BASE, '-o', `ControlPath=${SOCK}`], dest: 'dev@box.example.com' })
  })

  it('the tunnel: mux-only client, its own -L, no alias, no config', async () => {
    const c = internals(FOUND)
    c._controlPath = SOCK
    await c.createTunnel(7000)
    const run = spawned.at(-1)!
    expect(run.cmd).toBe('ssh')
    expect(run.args.slice(0, ownedMuxClientArgs(SOCK).length)).toEqual(ownedMuxClientArgs(SOCK))
    expect(run.args).toContain('40001:127.0.0.1:7000')
    expect(run.args.at(-1)).toBe('devbox.example.test')
    expect(run.args.some((a) => a === 'devbox' || a === 'builder@devbox' || a.startsWith('HostName='))).toBe(false)
  })

  it('the tunnel and a port forward without Walnut\'s master fail before any ssh starts', async () => {
    await expect(internals(FOUND).createTunnel(7000)).rejects.toThrow(/SSH master unavailable/)
    await expect(internals(FOUND).ensurePortForward(8080)).rejects.toThrow(/SSH master unavailable/)
    expect(spawned).toEqual([])
  })

  it('a port forward with Walnut\'s master: mux-only client to the real hostname', async () => {
    const c = internals(FOUND)
    c._controlPath = SOCK
    await c.ensurePortForward(8080)
    const run = spawned.at(-1)!
    expect(run.args.slice(0, ownedMuxClientArgs(SOCK).length)).toEqual(ownedMuxClientArgs(SOCK))
    expect(run.args).toContain('40001:127.0.0.1:8080')
    expect(run.args.at(-1)).toBe('devbox.example.test')
  })
})

describe('DaemonConnection: the master\'s control commands for a found host', () => {
  it('check and the reused master\'s forward cancel go with no ssh config; the login keeps the alias auth', async () => {
    const c = internals(FOUND)
    await c.ensureControlMaster()
    const [socket, loginArgs, loginHost, opts] = master.plan.mock.calls[0] as unknown as [string, string[], string, { control: { args: string[]; host: string } }]
    expect(loginHost).toBe('builder@devbox')
    expect(loginArgs).toContain('ClearAllForwardings=yes')
    expect(opts.control).toEqual({ args: ownedMuxClientArgs(socket), host: 'devbox.example.test' })
    expect(master.cancel).toHaveBeenCalledWith(socket, ownedMuxClientArgs(socket), 'devbox.example.test')
  })

  it('a new master starts with the alias auth and no config forwards', async () => {
    master.plan.mockResolvedValueOnce({ action: 'start', state: 'absent' } as never)
    const c = internals(FOUND)
    await c.ensureControlMaster()
    const [, args, host] = master.start.mock.calls[0] as unknown as [string, string[], string]
    expect(host).toBe('builder@devbox')
    expect(args).toEqual([...BASE, ...ALIAS('devbox.example.test'), '-p', '2200'])
  })

  it('stopping the master sends -O exit with no ssh config', async () => {
    const c = internals(FOUND)
    c._controlPath = SOCK
    await c.stopControlMaster()
    expect(master.exit).toHaveBeenCalledWith(SOCK, ownedMuxClientArgs(SOCK), 'devbox.example.test')
  })

  it('a manual host\'s control commands are what they were', async () => {
    const c = internals({ hostname: 'box.example.com', user: 'dev' }, 'box')
    await c.ensureControlMaster()
    const [socket, , , opts] = master.plan.mock.calls[0] as unknown as [string, string[], string, { control: { args: string[]; host: string } }]
    expect(opts.control).toEqual({ args: BASE, host: 'dev@box.example.com' })
    expect(master.cancel).toHaveBeenCalledWith(socket, BASE, 'dev@box.example.com')
  })
})
