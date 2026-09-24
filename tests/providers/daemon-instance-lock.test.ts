import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  DAEMON_LOCK_DEADLINE_MS,
  DAEMON_LOCK_MAGIC,
  DAEMON_LOCK_MAX_BANNER_BYTES,
  DAEMON_LOCK_PORT_BASE,
  DAEMON_LOCK_PORT_SPAN,
  DaemonLockConflictError,
  DaemonLockOptionsError,
  acquireDaemonInstanceLock,
  buildDaemonLockBanner,
  daemonLockPort,
  lockDirFor,
  normalizeWsPort,
  parseDaemonLockBanner,
  type LockNetLike,
  type LockServerLike,
  type LockSocketLike,
} from '../../src/providers/daemon-instance-lock.js'

type AnyFn = (...args: unknown[]) => void

function emitter() {
  const map = new Map<string, AnyFn[]>()
  return {
    on(event: string, fn: AnyFn) { map.set(event, [...(map.get(event) ?? []), fn]) },
    emit(event: string, ...args: unknown[]) { for (const fn of map.get(event) ?? []) fn(...args) },
  }
}

interface StubOptions {
  listenError?: NodeJS.ErrnoException
  closeError?: Error
  probeChunks?: Array<string | Buffer>
  probeError?: Error
  probeEnd?: boolean
}

function makeStubNet(opts: StubOptions = {}) {
  const calls = { createServer: 0, listen: [] as Record<string, unknown>[], connections: [] as number[], closes: 0 }
  let handler: ((socket: LockSocketLike) => void) | null = null
  const serverEvents = emitter()
  const server: LockServerLike = {
    on: (event, fn) => serverEvents.on(event, fn as AnyFn),
    listen: (options) => {
      calls.listen.push(options as unknown as Record<string, unknown>)
      if (opts.listenError) serverEvents.emit('error', opts.listenError)
      else serverEvents.emit('listening')
    },
    close: (cb) => { calls.closes += 1; cb?.(opts.closeError ?? null) },
    address: () => (opts.listenError ? null : { port: Number(calls.listen[0]?.port ?? 0) }),
  }
  const netApi: LockNetLike = {
    createServer: (h) => { calls.createServer += 1; handler = h; return server },
    createConnection: ({ port }) => {
      calls.connections.push(port)
      const events = emitter()
      const socket: LockSocketLike = {
        on: (event, fn) => events.on(event, fn as AnyFn),
        end: () => undefined,
        destroy: () => undefined,
      }
      void Promise.resolve().then(() => {
        if (opts.probeError) { events.emit('error', opts.probeError); return }
        for (const chunk of opts.probeChunks ?? []) events.emit('data', chunk)
        if (opts.probeEnd) events.emit('end')
      })
      return socket
    },
  }
  const serve = (o: { close?: boolean } = { close: true }) => {
    let line = ''
    let destroyed = false
    const events = emitter()
    handler?.({
      on: (event, fn) => events.on(event, fn as AnyFn),
      end: (data) => { line = String(data ?? '') },
      destroy: () => { destroyed = true },
    })
    if (o.close) events.emit('close')
    return { line, banner: () => parseDaemonLockBanner(line.trim()), destroyed: () => destroyed }
  }
  return { netApi, calls, serve }
}

const inUse: NodeJS.ErrnoException = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
const stubFs = { realpathSync: (p: string) => p }
const BASE = { runtimeDir: '/tmp/open-walnut', uid: 501, pid: 4242, instanceId: 'd-4242-abc', fs: stubFs }
const bannerLine = (info: Parameters<typeof buildDaemonLockBanner>[0]) =>
  JSON.stringify(buildDaemonLockBanner(info)) + '\n'

describe('daemonLockPort', () => {
  it('is deterministic and stays below the default ephemeral ranges', () => {
    const a = daemonLockPort(501, '/tmp/open-walnut')
    expect(daemonLockPort(501, '/tmp/open-walnut')).toBe(a)
    expect(a).toBeGreaterThanOrEqual(DAEMON_LOCK_PORT_BASE)
    expect(a).toBeLessThan(DAEMON_LOCK_PORT_BASE + DAEMON_LOCK_PORT_SPAN)
    expect(DAEMON_LOCK_PORT_BASE + DAEMON_LOCK_PORT_SPAN).toBeLessThanOrEqual(32768)
    expect(daemonLockPort(502, '/tmp/open-walnut')).not.toBe(a)
    expect(daemonLockPort(501, '/tmp/open-walnut-b')).not.toBe(a)
  })
})

describe('lockDirFor', () => {
  it('canonicalises through realpath', () => {
    const seen: string[] = []
    const dir = lockDirFor('/tmp/link', { realpathSync: (p) => { seen.push(p); return '/private/tmp/real' } })
    expect(seen).toEqual(['/tmp/link'])
    expect(dir).toBe('/private/tmp/real')
  })

  it('never falls back when realpath fails, so a later mkdir cannot change the port', () => {
    for (const code of ['ENOENT', 'EACCES']) {
      const err = Object.assign(new Error(`${code}: realpath`), { code })
      expect(() => lockDirFor('/tmp/open-walnut', { realpathSync: () => { throw err } })).toThrow(err)
    }
    const missing = lockDirFor('/tmp/a', { realpathSync: () => '/private/tmp/a' })
    expect(daemonLockPort(501, missing)).not.toBe(daemonLockPort(501, '/tmp/a'))
    expect(() => lockDirFor('rel/dir', stubFs)).toThrow(DaemonLockOptionsError)
  })
})

describe('banner encoding', () => {
  it('round-trips and clamps wsPort', () => {
    const banner = buildDaemonLockBanner({ uid: 501, dir: '/d', pid: 7, instanceId: 'i', wsPort: 0 })
    expect(banner.magic).toBe(DAEMON_LOCK_MAGIC)
    expect(banner.wsPort).toBeNull()
    expect(parseDaemonLockBanner(JSON.stringify(banner))).toEqual(banner)
    expect([normalizeWsPort(-1), normalizeWsPort(1.5), normalizeWsPort(65536), normalizeWsPort(65535)])
      .toEqual([null, null, null, 65535])
  })

  it('rejects foreign, broken or out-of-range lines', () => {
    const good = { magic: DAEMON_LOCK_MAGIC, uid: 1, dir: '/d', pid: 2, instanceId: 'i' }
    const bad = [{ magic: 'other/1' }, { uid: -1 }, { uid: 1.5 }, { pid: 1 }, { dir: '' }, { instanceId: '  ' }]
    expect(parseDaemonLockBanner('not json')).toBeNull()
    for (const patch of bad) expect(parseDaemonLockBanner(JSON.stringify({ ...good, ...patch }))).toBeNull()
  })
})

describe('acquireDaemonInstanceLock — owner', () => {
  it('binds the deterministic port exclusively, without reusePort', async () => {
    const stub = makeStubNet()
    const result = await acquireDaemonInstanceLock({ ...BASE, net: stub.netApi })
    if (result.kind !== 'owner') throw new Error('expected owner')
    expect(result.port).toBe(daemonLockPort(BASE.uid, BASE.runtimeDir))
    expect(Object.keys(stub.calls.listen[0]).sort()).toEqual(['exclusive', 'host', 'port'])
    expect(stub.calls.listen[0]).toEqual({ port: result.port, host: '127.0.0.1', exclusive: true })
    expect(stub.calls.connections).toEqual([])
  })

  it('answers each connection with one banner line and reflects publish()', async () => {
    const stub = makeStubNet()
    const result = await acquireDaemonInstanceLock({ ...BASE, net: stub.netApi })
    if (result.kind !== 'owner') throw new Error('expected owner')
    const first = stub.serve()
    expect(first.line.endsWith('\n')).toBe(true)
    expect(first.banner()).toEqual({
      magic: DAEMON_LOCK_MAGIC, uid: 501, dir: '/tmp/open-walnut', pid: 4242, instanceId: 'd-4242-abc', wsPort: null,
    })
    result.publish(4321)
    expect(stub.serve().banner()?.wsPort).toBe(4321)
    result.publish(70000)
    expect(stub.serve().banner()?.wsPort).toBeNull()
  })

  it('deadlines an incoming socket that never closes, and clears it on close', async () => {
    const stub = makeStubNet()
    const result = await acquireDaemonInstanceLock({ ...BASE, net: stub.netApi, deadlineMs: 15 })
    if (result.kind !== 'owner') throw new Error('expected owner')
    const lingering = stub.serve({ close: false })
    const wellBehaved = stub.serve({ close: true })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(lingering.destroyed()).toBe(true)
    expect(wellBehaved.destroyed()).toBe(false)
    expect(DAEMON_LOCK_DEADLINE_MS).toBe(2000)
  })

  it('shares one release promise and never swallows a close error', async () => {
    const ok = makeStubNet()
    const owner = await acquireDaemonInstanceLock({ ...BASE, net: ok.netApi })
    if (owner.kind !== 'owner') throw new Error('expected owner')
    const a = owner.release()
    const b = owner.release()
    expect(a).toBe(b)
    await expect(a).resolves.toBeUndefined()
    expect(ok.calls.closes).toBe(1)

    const failing = makeStubNet({ closeError: new Error('boom') })
    const second = await acquireDaemonInstanceLock({ ...BASE, net: failing.netApi })
    if (second.kind !== 'owner') throw new Error('expected owner')
    await expect(second.release()).rejects.toThrow('boom')
    await expect(second.release()).rejects.toThrow('boom')
    expect(failing.calls.closes).toBe(1)
  })
})

describe('acquireDaemonInstanceLock — existing owner', () => {
  it('probes the one port and returns the holder', async () => {
    const line = bannerLine({ uid: 501, dir: '/tmp/open-walnut', pid: 99, instanceId: 'd-99-zz', wsPort: 3456 })
    const stub = makeStubNet({ listenError: inUse, probeChunks: [line] })
    const result = await acquireDaemonInstanceLock({ ...BASE, net: stub.netApi })
    expect(result).toEqual({
      kind: 'existing',
      owner: { uid: 501, dir: '/tmp/open-walnut', pid: 99, instanceId: 'd-99-zz', wsPort: 3456 },
    })
    expect(stub.calls.createServer).toBe(1)
    expect(stub.calls.connections).toEqual([daemonLockPort(BASE.uid, BASE.runtimeDir)])
  })

  it('decodes a banner whose multi-byte path is split across chunks', async () => {
    const dir = '/tmp/open-walnut/\u65e5\u672c\u8a9e-č' // CJK "Japanese": multi-byte path
    const bytes = Buffer.from(bannerLine({ uid: 501, dir, pid: 99, instanceId: 'd-99-zz', wsPort: null }), 'utf8')
    const cut = bytes.findIndex((b) => b >= 0x80) + 1
    expect(cut).toBeGreaterThan(1)
    const stub = makeStubNet({ listenError: inUse, probeChunks: [bytes.subarray(0, cut), bytes.subarray(cut)] })
    const result = await acquireDaemonInstanceLock({ ...BASE, runtimeDir: dir, net: stub.netApi })
    if (result.kind !== 'existing') throw new Error('expected existing')
    expect(result.owner.dir).toBe(dir)
    expect(result.owner.dir).not.toContain('�')
  })
})

describe('acquireDaemonInstanceLock — refusals', () => {
  const reject = async (opts: StubOptions, reason: string) => {
    const stub = makeStubNet(opts)
    const err = await acquireDaemonInstanceLock({ ...BASE, net: stub.netApi, deadlineMs: 20 }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(DaemonLockConflictError)
    expect((err as DaemonLockConflictError).reason).toBe(reason)
    expect((err as DaemonLockConflictError).port).toBe(daemonLockPort(BASE.uid, BASE.runtimeDir))
    return stub
  }

  it('refuses a holder of another uid or another dir', async () => {
    for (const owner of [{ uid: 502, dir: '/tmp/open-walnut' }, { uid: 501, dir: '/tmp/other-walnut' }]) {
      await reject({ listenError: inUse, probeChunks: [bannerLine({ ...owner, pid: 8, instanceId: 'i', wsPort: null })] }, 'foreign')
    }
  })

  it('refuses a non-walnut banner, silence, an oversize line and a half-line close', async () => {
    await reject({ listenError: inUse, probeChunks: ['{"magic":"ssh/1"}\n'] }, 'malformed')
    const timedOut = await reject({ listenError: inUse }, 'timeout')
    expect(timedOut.calls.connections.length).toBe(1)
    await reject({ listenError: inUse, probeChunks: ['x'.repeat(DAEMON_LOCK_MAX_BANNER_BYTES + 1)] }, 'oversize')
    await reject({ listenError: inUse, probeChunks: ['{"magic":"walnut'], probeEnd: true }, 'malformed')
    await reject({ listenError: inUse, probeEnd: true }, 'malformed')
    await reject({ listenError: inUse, probeError: new Error('ECONNREFUSED') }, 'unreachable')
    await reject({ listenError: Object.assign(new Error('listen EACCES'), { code: 'EACCES' }) }, 'listen')
  })

  it('validates identity and runtimeDir before binding anything', async () => {
    const bad = [{ uid: -1 }, { uid: 1.5 }, { pid: 1 }, { pid: 0 }, { instanceId: '  ' }, { runtimeDir: 'rel/dir' }, { port: -1 }, { port: 70000 }]
    for (const patch of bad) {
      const stub = makeStubNet()
      await expect(acquireDaemonInstanceLock({ ...BASE, net: stub.netApi, ...patch }))
        .rejects.toBeInstanceOf(DaemonLockOptionsError)
      expect(stub.calls.createServer).toBe(0)
    }
  })
})

describe('real loopback contention', () => {
  const identity = (runtimeDir: string, instanceId: string, port: number) => ({ runtimeDir, uid: os.userInfo().uid, pid: process.pid, instanceId, port })

  it('reports the live holder and never double-binds', async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-lock-'))
    const first = await acquireDaemonInstanceLock(identity(runtimeDir, 'd-first', 0))
    if (first.kind !== 'owner') throw new Error('expected owner')
    first.publish(9911)
    try {
      const second = await acquireDaemonInstanceLock(identity(runtimeDir, 'd-second', first.port))
      if (second.kind !== 'existing') throw new Error('expected existing')
      expect(second.owner.instanceId).toBe('d-first')
      expect(second.owner.wsPort).toBe(9911)
      expect(second.owner.dir).toBe(fs.realpathSync(runtimeDir))
    } finally {
      await first.release()
      fs.rmSync(runtimeDir, { recursive: true, force: true })
    }
  })

  it('refuses a foreign listener squatting the port', async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-lock-'))
    const squatter = net.createServer((socket) => socket.end('OpenSSH_9.0\n'))
    await new Promise<void>((resolve) => squatter.listen({ port: 0, host: '127.0.0.1' }, () => resolve()))
    const port = (squatter.address() as net.AddressInfo).port
    try {
      await expect(acquireDaemonInstanceLock({ ...identity(runtimeDir, 'd-third', port), deadlineMs: 500 }))
        .rejects.toMatchObject({ name: 'DaemonLockConflictError', reason: 'malformed' })
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()))
      fs.rmSync(runtimeDir, { recursive: true, force: true })
    }
  })
})
