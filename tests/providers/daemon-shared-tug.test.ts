/**
 * Two Walnuts of different builds share one daemon and reconnect over and over: the
 * daemon is not swapped back and forth (2026-11-03: a host shared by two people's
 * Walnuts; each server put its own build back on every connect, because a daemon's
 * version is a content hash with no order, and every swap cut the other's link).
 *
 * The host is simulated: its daemon.version and daemon.serves.json (what the running
 * daemon records, served-walnuts-core.ts), and an upgrade that puts the asking server's
 * build there. Two real DaemonConnection instances (one per Walnut, each its own key and
 * build) run the real shouldUpgradeDaemon against it; only SSH and the upload are stubbed.
 *
 * Pinned:
 *   - newer build with a capability the running daemon lacks: it updates once, then
 *     neither side swaps again however often they reconnect;
 *   - two builds with the same capabilities: nobody swaps;
 *   - a host only one Walnut uses still gets exactly that Walnut's build;
 *   - a daemon that keeps no record (an older build) is updated as before;
 *   - a Walnut gone for longer than the shared window no longer holds the daemon.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonConnection, remoteServiceProbePaths, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { ourDaemonCapabilities, REPLACE_BREAKER_MS, SHARED_WINDOW_MS, sharedDaemonVerdict, walnutKeyOf } from '../../src/providers/daemon-shared.js'
import { log } from '../../src/logging/index.js'

type Priv = Record<string, (...args: unknown[]) => unknown>
const priv = (c: DaemonConnection) => c as unknown as Priv
const state = (c: DaemonConnection) => c as unknown as Record<string, unknown>

const KEY_A = 'aaaaaaaaaaaaaaaa'
const KEY_B = 'bbbbbbbbbbbbbbbb'
const UNMANAGED = remoteServiceProbePaths().map((p) => `absent ${p}`).concat('walnut-service-probe-done').join('\n')

interface Build { version: string; capabilities: string[] }
interface Host { version: string; capabilities: string[] | null; walnuts: Record<string, number>; swaps: string[]; recordOf?: string; twin?: 'binary' | 'source' }

const CAPS = ourDaemonCapabilities('binary')
const OLD: Build = { version: 'walnut-daemon-old000000001', capabilities: CAPS.slice(0, -1) }
const NEW: Build = { version: 'walnut-daemon-new000000002', capabilities: CAPS }
const NEW_TWIN: Build = { version: 'walnut-daemon-twin00000003', capabilities: CAPS }

let conns: DaemonConnection[] = []
afterEach(() => {
  for (const c of conns) { state(c)._connected = false; c.disconnect() }
  conns = []
  setPooledConnectionForTest('devbox', null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** One Walnut's server on the shared host. */
function walnut(host: Host, key: string, build: Build): DaemonConnection {
  const c = new DaemonConnection('devbox', { hostname: 'devbox.example.com', user: 'tester' })
  conns.push(c)
  state(c).ownWalnutKey = key
  vi.spyOn(priv(c), 'getExpectedDaemonVersion').mockReturnValue(build.version)
  vi.spyOn(priv(c), 'acpTurnsOpen').mockResolvedValue(false)
  vi.spyOn(priv(c), 'execRunsOpen').mockResolvedValue(false)
  vi.spyOn(priv(c), 'holdUpgradeForFoldPrewarm').mockResolvedValue(false)
  vi.spyOn(priv(c), 'unmanagedTakeover').mockResolvedValue({})
  vi.spyOn(priv(c), 'stageUpgrade').mockResolvedValue(undefined)
  vi.spyOn(priv(c), 'stopUnmanagedDaemon').mockImplementation(async () => {
    // The swap: this server's build runs now, and its daemon reads back the record (served-walnuts-core).
    host.version = build.version
    host.capabilities = build.capabilities
    host.swaps.push(build.version)
  })
  vi.spyOn(priv(c), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    if (cmd.includes('walnut-service-probe-done')) return UNMANAGED
    if (cmd.includes('daemon.version')) {
      const serves = host.capabilities
        ? JSON.stringify({ v: 1, version: host.recordOf ?? host.version, twin: host.twin ?? 'binary', capabilities: host.capabilities, walnuts: host.walnuts, at: Date.now() })
        : ''
      // The same reply the real `cat …; echo; echo MARK; cat …` gives.
      return `${host.version}\n__WALNUT_DAEMON_SERVES__\n${serves}`
    }
    return ''
  })
  return c
}

/** A connect: the upgrade check, then its pushes, which the daemon notes (when it keeps a record). */
async function connect(host: Host, c: DaemonConnection, key: string): Promise<boolean> {
  const upgraded = await priv(c).shouldUpgradeDaemon('/remote/daemon') as boolean
  if (host.capabilities) host.walnuts[key] = Date.now()
  return upgraded
}

/** Both Walnuts reconnect `rounds` times, 15 minutes apart (past every cooldown). */
async function tug(host: Host, a: [DaemonConnection, string], b: [DaemonConnection, string], rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await connect(host, a[0], a[1])
    vi.setSystemTime(Date.now() + 15 * 60_000)
    await connect(host, b[0], b[1])
    vi.setSystemTime(Date.now() + 15 * 60_000)
  }
}

function setup(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'))
  vi.spyOn(log.session, 'info').mockImplementation(() => {})
  vi.spyOn(log.session, 'warn').mockImplementation(() => {})
}

describe('two Walnuts of different builds on one daemon', () => {
  it('the build that adds a capability updates once; then nobody swaps, however often both reconnect', async () => {
    setup()
    const host: Host = { version: OLD.version, capabilities: OLD.capabilities, walnuts: {}, swaps: [] }
    const older = walnut(host, KEY_A, OLD)
    const newer = walnut(host, KEY_B, NEW)
    // The older Walnut was here first and used it alone.
    await connect(host, older, KEY_A)
    expect(host.swaps).toEqual([])
    await tug(host, [newer, KEY_B], [older, KEY_A], 20)
    expect(host.swaps).toEqual([NEW.version])
    expect(host.version).toBe(NEW.version)
  })

  it('two builds with the same capabilities: nobody swaps', async () => {
    setup()
    const host: Host = { version: NEW.version, capabilities: NEW.capabilities, walnuts: { [KEY_A]: Date.now() }, swaps: [] }
    await tug(host, [walnut(host, KEY_B, NEW_TWIN), KEY_B], [walnut(host, KEY_A, NEW), KEY_A], 20)
    expect(host.swaps).toEqual([])
  })

  it('a server that names no home (an older Walnut, key "-") also holds the daemon', async () => {
    setup()
    const host: Host = { version: NEW_TWIN.version, capabilities: NEW_TWIN.capabilities, walnuts: { '-': Date.now() }, swaps: [] }
    await connect(host, walnut(host, KEY_A, NEW), KEY_A)
    expect(host.swaps).toEqual([])
  })
})

describe('everything else is updated as before', () => {
  it('a host only this Walnut uses gets exactly its build', async () => {
    setup()
    const host: Host = { version: NEW_TWIN.version, capabilities: NEW_TWIN.capabilities, walnuts: { [KEY_A]: Date.now() }, swaps: [] }
    expect(await connect(host, walnut(host, KEY_A, NEW), KEY_A)).toBe(true)
    expect(host.swaps).toEqual([NEW.version])
  })

  it('a daemon that keeps no record (a build older than this rule) is updated', async () => {
    setup()
    const host: Host = { version: OLD.version, capabilities: null, walnuts: {}, swaps: [] }
    expect(await connect(host, walnut(host, KEY_A, NEW), KEY_A)).toBe(true)
  })

  it('a daemon that lacks a capability is updated although another Walnut uses it', async () => {
    setup()
    const host: Host = { version: OLD.version, capabilities: OLD.capabilities, walnuts: { [KEY_B]: Date.now() }, swaps: [] }
    expect(await connect(host, walnut(host, KEY_A, NEW), KEY_A)).toBe(true)
  })

  it('another Walnut gone longer than the shared window no longer holds it', async () => {
    setup()
    const host: Host = { version: NEW_TWIN.version, capabilities: NEW_TWIN.capabilities, walnuts: { [KEY_B]: Date.now() - SHARED_WINDOW_MS - 1 }, swaps: [] }
    expect(await connect(host, walnut(host, KEY_A, NEW), KEY_A)).toBe(true)
  })

  it('a record a stopped build left (its version is not the running one) proves nothing', async () => {
    setup()
    const host: Host = { version: NEW_TWIN.version, capabilities: NEW_TWIN.capabilities, walnuts: { [KEY_B]: Date.now() }, swaps: [] }
    host.recordOf = 'walnut-daemon-gone00000004'
    const c = walnut(host, KEY_A, NEW)
    expect(await connect(host, c, KEY_A)).toBe(true)
  })

  it('WALNUT_DAEMON_KEEP_SHARED=0 replaces it as before', async () => {
    setup()
    vi.stubEnv('WALNUT_DAEMON_KEEP_SHARED', '0')
    try {
      const host: Host = { version: NEW_TWIN.version, capabilities: NEW_TWIN.capabilities, walnuts: { [KEY_B]: Date.now() }, swaps: [] }
      expect(await connect(host, walnut(host, KEY_A, NEW), KEY_A)).toBe(true)
    } finally { vi.unstubAllEnvs() }
  })
})

describe('builds that do not cover each other, and a third party that keeps putting its own back', () => {
  it('each build has a capability the other lacks: neither replaces the other', async () => {
    setup()
    const X: Build = { version: 'walnut-daemon-x00000000005', capabilities: [...CAPS.slice(1), 'future-only-v1'] }
    const host: Host = { version: X.version, capabilities: X.capabilities, walnuts: { [KEY_B]: Date.now() }, swaps: [] }
    await tug(host, [walnut(host, KEY_A, NEW), KEY_A], [walnut(host, KEY_B, X), KEY_B], 10)
    expect(host.swaps).toEqual([])
  })

  it('replaced once, then another build lacking the same comes back: kept for a day, replaced after', async () => {
    setup()
    const host: Host = { version: OLD.version, capabilities: OLD.capabilities, walnuts: { [KEY_B]: Date.now() }, swaps: [] }
    const c = walnut(host, KEY_A, NEW)
    expect(await connect(host, c, KEY_A)).toBe(true)
    // A server without this rule puts its build back, again and again.
    for (let i = 0; i < 5; i++) {
      host.version = OLD.version; host.capabilities = OLD.capabilities; host.walnuts[KEY_B] = Date.now()
      vi.setSystemTime(Date.now() + 30 * 60_000)
      expect(await connect(host, c, KEY_A)).toBe(false)
    }
    expect(host.swaps).toEqual([NEW.version])
    host.version = OLD.version; host.capabilities = OLD.capabilities
    vi.setSystemTime(Date.now() + REPLACE_BREAKER_MS)
    host.walnuts[KEY_B] = Date.now()
    expect(await connect(host, c, KEY_A)).toBe(true)
  })

  it('a source-twin daemon that lacks a capability this build ships with every sidecar is replaced', async () => {
    setup()
    const lacking = ourDaemonCapabilities('source').filter((c) => c !== 'task-dir-prune-v1')
    const host: Host = { version: NEW_TWIN.version, capabilities: lacking, walnuts: { [KEY_B]: Date.now() }, swaps: [], twin: 'source' }
    expect(await connect(host, walnut(host, KEY_A, NEW), KEY_A)).toBe(true)
  })
})

describe('the verdict on its own', () => {
  it('one Walnut written with other slashes is one key', () => {
    expect(walnutKeyOf('/home/u/.open-walnut/')).toBe(walnutKeyOf('/home/u/.open-walnut'))
    expect(walnutKeyOf('/home/u//.open-walnut')).toBe(walnutKeyOf('/home/u/.open-walnut'))
    expect(walnutKeyOf('/')).not.toBe(walnutKeyOf(''))
  })

  it('host-dependent capabilities are no reason to keep a daemon that lacks one of ours', () => {
    const caps = [...CAPS.slice(1), 'service-handover-v1', 'cron-supervision-v1', 'service-update-v1', 'acp-host-v1']
    const v = sharedDaemonVerdict({ ourKey: KEY_A, runningVersion: 'v', running: { version: 'v', twin: 'binary', capabilities: caps, walnuts: { [KEY_B]: 1 } }, now: 2 })
    expect(v).toMatchObject({ keep: false, shared: true })
  })
})

