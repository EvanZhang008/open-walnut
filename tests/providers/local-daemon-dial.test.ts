/**
 * The local daemon is dialled at the address it serves from now (src/providers/local-daemon-dial.ts).
 *
 * 2026-11-16, nightly server-restart-upload: a session made while a new local daemon was starting
 * kept the gone daemon's address, and its start failed with ECONNREFUSED a second after the new
 * one was up. The class: anything that reads `localDaemon.wsUrl` once and dials it later.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const daemon = vi.hoisted(() => ({
  wsUrl: null as string | null,
  starting: null as Promise<number> | null,
  ensureRunning: vi.fn(async () => 0),
}))
vi.mock('../../src/providers/local-daemon.js', () => ({ localDaemon: daemon }))
const pool = vi.hoisted(() => ({ dial: vi.fn(async (_host: string, url: string) => ({ url, connected: true })) }))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/daemon-connection.js')>()),
  getDirectDaemonConnection: pool.dial,
}))

import { dialLocalDaemon, getLocalDaemonConnection } from '../../src/providers/local-daemon-dial.js'
import { createSessionManager } from '../../src/providers/session-manager.js'
import type { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'

const refused = (url: string) => new Error(`WebSocket connection failed: ECONNREFUSED (host=__local__, url=${url})`)

afterEach(() => {
  daemon.wsUrl = null
  daemon.starting = null
  daemon.ensureRunning.mockReset().mockImplementation(async () => 0)
  pool.dial.mockReset().mockImplementation(async (_host: string, url: string) => ({ url, connected: true }))
})

describe('dialLocalDaemon', () => {
  it('waits for a start in flight and dials the address it ends on', async () => {
    daemon.wsUrl = 'ws://localhost:1111'
    let done!: () => void
    const start = new Promise<number>((resolve) => { done = () => { daemon.wsUrl = 'ws://localhost:2222'; resolve(2222) } })
    // The start ends only once the dial waits on it (it takes the start's .catch), not after a clock.
    let waiting!: () => void
    const atWait = new Promise<void>((resolve) => { waiting = resolve })
    daemon.starting = Object.assign(start, {
      catch: (onRejected: (reason: unknown) => unknown) => { waiting(); return Promise.prototype.catch.call(start, onRejected) },
    })
    const dial = vi.fn(async (url: string) => url)
    const dialled = dialLocalDaemon(dial)
    await atWait
    expect(dial).not.toHaveBeenCalled()
    done()
    expect(await dialled).toBe('ws://localhost:2222')
    expect(dial).toHaveBeenCalledTimes(1)
  })

  it('an address that refuses is checked with ensureRunning and dialled once more where it serves now', async () => {
    daemon.wsUrl = 'ws://localhost:1111'
    daemon.ensureRunning.mockImplementation(async () => { daemon.wsUrl = 'ws://localhost:3333'; return 3333 })
    const seen: string[] = []
    const result = await dialLocalDaemon(async (url) => {
      seen.push(url)
      if (url.endsWith(':1111')) throw refused(url)
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(seen).toEqual(['ws://localhost:1111', 'ws://localhost:3333'])
    expect(daemon.ensureRunning).toHaveBeenCalledTimes(1)
  })

  it('tries once more only: a daemon that still refuses is the error', async () => {
    daemon.wsUrl = 'ws://localhost:1111'
    const dial = vi.fn(async (url: string) => { throw refused(url) })
    await expect(dialLocalDaemon(dial)).rejects.toThrow(/ECONNREFUSED/)
    expect(dial).toHaveBeenCalledTimes(2)
  })

  it('another failure is not a moved daemon: no check, no second dial', async () => {
    daemon.wsUrl = 'ws://localhost:1111'
    const dial = vi.fn(async () => { throw new Error('handshake timed out') })
    await expect(dialLocalDaemon(dial)).rejects.toThrow('handshake timed out')
    expect(dial).toHaveBeenCalledTimes(1)
    expect(daemon.ensureRunning).not.toHaveBeenCalled()
  })

  it('no daemon yet: it is started before the dial', async () => {
    daemon.ensureRunning.mockImplementation(async () => { daemon.wsUrl = 'ws://localhost:4444'; return 4444 })
    const conn = await getLocalDaemonConnection() as unknown as { url: string }
    expect(conn.url).toBe('ws://localhost:4444')
  })
})

describe('a local session follows the daemon', () => {
  const connect = (m: RemoteSessionManager) => (m as unknown as { ensureConnected(): Promise<{ url: string }> }).ensureConnected()

  it('made while the old daemon was serving, it dials the new one', async () => {
    daemon.wsUrl = 'ws://localhost:1111'
    const manager = createSessionManager('tmp-follow', undefined) as RemoteSessionManager
    expect(manager.followsLocalDaemon).toBe(true)
    // The daemon started again on another port before the session connected.
    daemon.wsUrl = 'ws://localhost:5555'
    expect((await connect(manager)).url).toBe('ws://localhost:5555')
  })

  it('its old address refusing, it dials where the daemon serves now', async () => {
    daemon.wsUrl = 'ws://localhost:1111'
    const manager = createSessionManager('tmp-refused', undefined) as RemoteSessionManager
    pool.dial.mockImplementation(async (_host: string, url: string) => {
      if (url.endsWith(':1111')) throw refused(url)
      return { url, connected: true }
    })
    daemon.ensureRunning.mockImplementation(async () => { daemon.wsUrl = 'ws://localhost:6666'; return 6666 })
    expect((await connect(manager)).url).toBe('ws://localhost:6666')
  })

  it('a caller\'s own address (a test daemon) is never replaced', () => {
    daemon.wsUrl = 'ws://localhost:1111'
    const manager = createSessionManager('tmp-own', undefined, undefined, undefined, undefined, 'ws://localhost:7777') as RemoteSessionManager
    expect(manager.followsLocalDaemon).toBe(false)
  })
})

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

describe('ratchet: the local daemon\'s address is read only where it is current', () => {
  it('every reader of localDaemon.wsUrl is listed with why its read is current', () => {
    const ROOT = join(__dirname, '..', '..')
    // Each read either IS the dial path (local-daemon-dial.ts), comes right after its own
    // ensureRunning, or only seeds a value the reader replaces at its connect.
    const READERS: Record<string, string> = {
      'src/providers/local-daemon-dial.ts': 'the dial path itself',
      'src/providers/session-manager.ts': 'seeds a manager that follows the daemon at connect (followsLocalDaemon)',
      'src/providers/daemon-connection.ts': 'read right after its own ensureRunning, inside the reconnect loop',
      'src/core/feature-nodes/feature-service.ts': 'only whether a daemon serves (it never starts one); it dials through getLocalDaemonConnection',
    }
    const found = new Set<string>()
    for (const file of walk(join(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8').replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '')
      if (/\blocalDaemon\.wsUrl\b/.test(src)) found.add(relative(ROOT, file))
    }
    expect([...found].sort(), `A new place reads localDaemon.wsUrl. Dial the local daemon through
getLocalDaemonConnection or dialLocalDaemon (src/providers/local-daemon-dial.ts): an address read once
is the gone daemon's after it starts again, and the dial fails with ECONNREFUSED.`).toEqual(Object.keys(READERS).sort())
  })
})
