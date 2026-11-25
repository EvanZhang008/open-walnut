/**
 * What keeps the one Walnut service off a Mac unless the experiment macos_one_service is on, and off
 * places that are not this Walnut's (review round 1 of the macOS one-service change):
 *   - the mode decision's system gate (one-service-mode.ts wantedNow asks one-service-targets.ts
 *     servePlatformWhy with the flag): a Mac with the flag off is never asked, on either link;
 *   - (the host network path's check of the probed target: daemon-net-update-mode.test.ts);
 *   - setServe (a set straight into the service): a Mac only, the flag on;
 *   - the leader side of a follower that fell back (roleFallbackUnfit, noteRoleFallback): only with the
 *     flag on, kept on disk per host and build so a leader restart on the same build asks nothing again;
 *   - a Mac's shared daemon dir (mac-shared-slot.ts): nothing of this Walnut goes in while another serves it.
 * MACHINE SAFETY: no ssh, no daemon; every host answer is a fake.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// This Walnut's follower on the host, as the host-server manager would say it.
vi.mock('../../src/core/host-server/index.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), hostFollowerFact: () => ({ kind: 'replica' }) }))
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { roleFallbackUnfit, serveUnfits } from '../../src/providers/serve-unfit.js'
import { OFFER_NOT_SURE, serviceModeWantNow, wantedServiceMode, type ServiceModeFacts } from '../../src/providers/one-service-mode.js'
import { otherWalnuts, sharedMacSlotWhy } from '../../src/providers/mac-shared-slot.js'
import { walnutKeyOf } from '../../src/providers/daemon-serves.js'
import { MACOS_OFF_WHY } from '../../src/providers/one-service-targets.js'
import type { LauncherFacts } from '../../src/providers/service-launcher-beat.js'
import { WALNUT_HOME } from '../../src/constants.js'

type Priv = Record<string, (...args: unknown[]) => unknown> & Record<string, unknown>
const priv = (conn: DaemonConnection) => conn as unknown as Priv
const EXPECTED = 'walnut-daemon-aaaaaaaaaaaa'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('the system gate of the mode decision (one-service-mode.ts wantedNow, through the one table)', () => {
  const base: ServiceModeFacts = { experiment: true, serves: 'daemon', serviceHome: null, home: WALNUT_HOME, launcher: true, platform: 'darwin', follower: { kind: 'replica' } }

  it('a Mac with the flag off (or no word of it) gets the daemon with the table\'s reason; on: the service', () => {
    expect(wantedServiceMode(base)).toEqual({ want: 'daemon', why: MACOS_OFF_WHY })
    expect(wantedServiceMode({ ...base, macos: false })).toEqual({ want: 'daemon', why: MACOS_OFF_WHY })
    expect(wantedServiceMode({ ...base, macos: true })).toEqual({ want: 'walnut-serve' })
    // The flag is for Macs only: another system stays out.
    expect(wantedServiceMode({ ...base, platform: 'win32', macos: true })).toMatchObject({ want: 'daemon' })
  })

  const inputs = (platform: string, macos: boolean | undefined, offer: boolean | null = true) => ({
    serves: 'daemon' as const, serviceHome: null, home: WALNUT_HOME, launcher: true, expected: EXPECTED, serveUnfit: null,
    modeAsked: async () => null, platform: vi.fn(async () => platform), offerWanted: async () => offer, launcherWanted: async () => true,
    follower: async () => ({ kind: 'replica' as const }), note: vi.fn(),
    ...(macos === undefined ? {} : { macosWanted: vi.fn(async () => macos) }),
  })

  it('serviceModeWantNow reads the flag for a Mac only, and a Mac with it on says "not sure" like a Linux host', async () => {
    await expect(serviceModeWantNow(inputs('darwin', true))).resolves.toEqual({ want: 'walnut-serve' })
    await expect(serviceModeWantNow(inputs('darwin', false))).resolves.toEqual({ want: 'daemon', why: MACOS_OFF_WHY })
    await expect(serviceModeWantNow(inputs('darwin', undefined))).resolves.toEqual({ want: 'daemon', why: MACOS_OFF_WHY })
    const linux = inputs('linux', true)
    await expect(serviceModeWantNow(linux)).resolves.toEqual({ want: 'walnut-serve' })
    expect(linux.macosWanted).not.toHaveBeenCalled()
    const unsureOn = inputs('darwin', true, null)
    await expect(serviceModeWantNow(unsureOn)).resolves.toEqual({ want: null })
    expect(unsureOn.note).toHaveBeenCalledWith({ want: null, why: OFFER_NOT_SURE })
    const unsureOff = inputs('darwin', false, null)
    await serviceModeWantNow(unsureOff)
    expect(unsureOff.note).not.toHaveBeenCalled()
  })

  it('a connection to a Mac hands the decision its flag', async () => {
    const conn = new DaemonConnection('studio-mac', { hostname: 'studio-mac.example.test', user: 'me' })
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED)
    vi.spyOn(priv(conn), 'hostPlatform').mockResolvedValue('darwin')
    vi.spyOn(priv(conn), 'modeAsked').mockResolvedValue(null)
    // The launcher and the host's offer on (their defaults since the one-service flip).
    vi.stubEnv('WALNUT_SERVICE_LAUNCHER', '1')
    vi.stubEnv('WALNUT_HOST_SERVICE_OFFER', '1')
    priv(conn)._launcher = { current: '/x', good: '/x', phase: 'committed', since: 1 }
    vi.stubEnv('WALNUT_MACOS_ONE_SERVICE', '0')
    await expect(priv(conn).serviceModeWant()).resolves.toEqual({ want: 'daemon', why: MACOS_OFF_WHY })
    vi.stubEnv('WALNUT_MACOS_ONE_SERVICE', '1')
    await expect(priv(conn).serviceModeWant()).resolves.toEqual({ want: 'walnut-serve' })
  })
})

describe('setServe: a set straight into the service', () => {
  function conn(system: string | null) {
    const c = new DaemonConnection('shared-box', { hostname: 'shared-box.example.test', user: 'me' })
    vi.spyOn(priv(c), 'hostPlatform').mockResolvedValue(system)
    const want = vi.spyOn(priv(c), 'serviceModeWant').mockResolvedValue({ want: 'walnut-serve' })
    return { c, want }
  }

  it('a Mac with the flag on: the service\'s words', async () => {
    vi.stubEnv('WALNUT_MACOS_ONE_SERVICE', '1')
    const { c, want } = conn('darwin')
    expect(await priv(c).setServe(EXPECTED)).toMatchObject({ serve: { home: WALNUT_HOME, on: true } })
    expect(want).toHaveBeenCalledWith(expect.objectContaining({ serves: 'daemon', serviceHome: null }))
  })

  it('the flag off, a Linux host, or a system not known: none, and no decision is read', async () => {
    for (const [flag, system] of [['0', 'darwin'], ['1', 'linux'], ['1', null]] as const) {
      vi.stubEnv('WALNUT_MACOS_ONE_SERVICE', flag)
      const { c, want } = conn(system)
      expect(await priv(c).setServe(EXPECTED), `${flag} ${system}`).toBeUndefined()
      expect(want).not.toHaveBeenCalled()
    }
  })
})

describe('a follower that fell back, as the leader reads it', () => {
  const facts = (over: Partial<NonNullable<LauncherFacts['roleFallback']>> = {}): LauncherFacts => ({
    current: '/s/versions/a/daemon', good: '/s/versions/a/daemon', phase: 'committed', since: 1,
    roleFallback: { role: 'replica', home: WALNUT_HOME, exe: '/s/versions/a/daemon', at: 1, why: 'did not get ready in its last 3 starts', ...over },
  })

  it('this Walnut\'s follower role, on the version that runs, on the build expected: unfit with its reason', () => {
    expect(roleFallbackUnfit({ launcher: facts(), expected: EXPECTED, running: EXPECTED, home: WALNUT_HOME }))
      .toEqual({ expected: EXPECTED, why: expect.stringMatching(/did not come up as the Walnut service there \(did not get ready in its last 3 starts\)/) })
  })

  it('another Walnut\'s, the leader role, another version, another build running: nothing', () => {
    expect(roleFallbackUnfit({ launcher: facts({ home: '/other' }), expected: EXPECTED, running: EXPECTED, home: WALNUT_HOME })).toBeNull()
    expect(roleFallbackUnfit({ launcher: facts({ role: 'leader' }), expected: EXPECTED, running: EXPECTED, home: WALNUT_HOME })).toBeNull()
    expect(roleFallbackUnfit({ launcher: facts({ exe: '/s/versions/b/daemon' }), expected: EXPECTED, running: EXPECTED, home: WALNUT_HOME })).toBeNull()
    expect(roleFallbackUnfit({ launcher: facts(), expected: EXPECTED, running: 'walnut-daemon-older000000', home: WALNUT_HOME })).toBeNull()
    expect(roleFallbackUnfit({ launcher: null, expected: EXPECTED, running: EXPECTED, home: WALNUT_HOME })).toBeNull()
  })

  function fellBack() {
    const c = new DaemonConnection('studio-mac', { hostname: 'studio-mac.example.test', user: 'me' })
    vi.spyOn(priv(c), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED)
    vi.spyOn(priv(c), 'serviceModeWant').mockResolvedValue({ want: null })
    const p = priv(c)
    p._launcher = facts()
    p._daemonVersion = EXPECTED
    return c
  }

  it('noteRoleFallback with the flag on: this build is unfit there; off: nothing changes', async () => {
    vi.stubEnv('WALNUT_MACOS_ONE_SERVICE', '0')
    const off = fellBack()
    priv(off).noteRoleFallback()
    await new Promise((r) => setTimeout(r, 20))
    expect(priv(off)._serveUnfit).toBeNull()
    vi.stubEnv('WALNUT_MACOS_ONE_SERVICE', '1')
    const on = fellBack()
    priv(on).noteRoleFallback()
    await vi.waitFor(() => expect(priv(on)._serveUnfit).toMatchObject({ expected: EXPECTED }))
  })

  it('kept on disk per host and build: a new connection (a leader restart) on the same build reads it back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-unfit-'))
    try {
      vi.stubEnv('WALNUT_UPDATE_SERVE_UNFIT_FILE', path.join(dir, 'unfit.json'))
      vi.stubEnv('WALNUT_MACOS_ONE_SERVICE', '1')
      const first = fellBack()
      priv(first).markServeUnfit(EXPECTED, 'the walnut file did not come up as the Walnut service there')
      await vi.waitFor(async () => expect(await serveUnfits.read('ssh:studio-mac')).toMatchObject({ expected: EXPECTED }))
      const again = new DaemonConnection('studio-mac', { hostname: 'studio-mac.example.test', user: 'me' })
      vi.spyOn(priv(again), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED)
      expect(await priv(again).keptServeUnfit()).toMatchObject({ expected: EXPECTED, why: expect.stringMatching(/did not come up/) })
      // A newer build is asked again.
      const newer = new DaemonConnection('studio-mac', { hostname: 'studio-mac.example.test', user: 'me' })
      vi.spyOn(priv(newer), 'getExpectedDaemonVersion').mockReturnValue('walnut-daemon-bbbbbbbbbbbb')
      expect(await priv(newer).keptServeUnfit()).toBeNull()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('a Mac\'s shared daemon dir', () => {
  const NOW = Date.UTC(2026, 10, 25)
  const serves = (walnuts: Record<string, number>) => ({ version: '', twin: 'binary' as const, capabilities: [], walnuts, pty: null })
  const base = { system: 'darwin' as const, isolation: 'shared', ownSet: false, dir: '/tmp/open-walnut', home: '/Users/me/.open-walnut', now: NOW }
  // A serves record names each Walnut by its key, never its path.
  const ME = walnutKeyOf(base.home)
  const CHEN = walnutKeyOf('/Users/chen/.open-walnut')

  it('another Walnut served lately: refused, saying so', async () => {
    const why = await sharedMacSlotWhy({ ...base, serves: serves({ [CHEN]: NOW - 1000, [ME]: NOW }), run: async () => '' })
    expect(why).toMatch(/\(\/tmp\/open-walnut\) serves another Walnut; Walnut puts nothing of its own there/)
  })

  it('only this Walnut, a server with no home, or one long gone: allowed', async () => {
    expect(await sharedMacSlotWhy({ ...base, serves: serves({ [ME]: NOW, '-': NOW }), run: async () => '' })).toBeNull()
    expect(otherWalnuts(serves({ [CHEN]: NOW - 4 * 24 * 3600_000 }), base.home, NOW)).toEqual([])
  })

  it('no hello: the dir\'s serves record decides; none at all (nobody ever served it) is free; no answer is no proof', async () => {
    const file = JSON.stringify(serves({ [CHEN]: NOW }))
    expect(await sharedMacSlotWhy({ ...base, serves: null, run: async (c) => (c.includes('daemon.serves.json') ? file : '') })).toMatch(/another Walnut/)
    expect(await sharedMacSlotWhy({ ...base, serves: null, run: async () => '' })).toBeNull()
    expect(await sharedMacSlotWhy({ ...base, serves: null, run: async () => { throw new Error('link down') } })).toMatch(/could not be read/)
  })

  it('Linux, a test server, or this Walnut\'s own set dir: never refused', async () => {
    const other = serves({ [CHEN]: NOW })
    for (const over of [{ system: 'linux' as const }, { isolation: 'isolated' }, { ownSet: true }]) {
      expect(await sharedMacSlotWhy({ ...base, ...over, serves: other, run: async () => '' })).toBeNull()
    }
  })

  it('the connection refuses a deploy into it before anything is sent', async () => {
    const c = new DaemonConnection('shared-mac', { hostname: 'shared-mac.example.test', user: 'me' })
    const p = priv(c)
    p._remoteSystem = 'darwin'
    p._daemonServes = serves({ [CHEN]: Date.now() })
    const exec = vi.spyOn(p, 'sshExec').mockResolvedValue('')
    await expect(p.deployDaemon()).rejects.toThrow(/serves another Walnut/)
    expect(exec).not.toHaveBeenCalled()
  })
})
