/**
 * A host's daemon is replaced automatically at most once every 2 hours
 * (src/providers/daemon-update-gap.ts).
 *
 * 2026-11-03: a run of deploys replaced clouddev's daemon once per build, seven
 * pushes in 20 minutes over a slow link, each swap dropping its sessions' link;
 * 2026-11-24: one host's daemon was replaced 19 times in 24 hours.
 * Pinned on both update paths a remote host has:
 *   - SSH hosts (DaemonConnection.shouldUpgradeDaemon): the age comes from the
 *     same probe as the version (ps etime of daemon.pid); a daemon younger than
 *     the gap keeps serving and the update is decided again when the gap ends;
 *   - host network machines (decideNetUpdate): the age comes from the hello's
 *     startedAt; a request (host_daemon_update) is never held.
 * All SSH is stubbed at sshExec; no process, socket or tunnel is created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonConnection, remoteServiceProbePaths } from '../../src/providers/daemon-connection.js'
import { decideNetUpdate, type NetUpdateFacts } from '../../src/providers/daemon-net-update.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  capabilityByBuild, DAEMON_UPDATE_GAP_RECHECK_MS, DAEMON_UPDATE_MIN_GAP_MS, daemonUpdateGapHold, daemonUpdateMinGapMs, daemonUpdateWaitMs,
  DOOR_CAPABILITIES, parseEtimeMs, spanWords, UpdateGapHold,
} from '../../src/providers/daemon-update-gap.js'
import { HOST_DEPENDENT_CAPABILITIES } from '../../src/providers/daemon-shared.js'
import { DAEMON_UPDATE_BEHIND_MAX_MS, DAEMON_UPDATE_BEHIND_STALE_MS } from '../../src/providers/daemon-update-behind.js'
import { UPGRADE_RECHECK_DELAYS_MS } from '../../src/providers/daemon-connection.js'
import { needCapability } from '../../src/providers/daemon-capability-need.js'
import { MANAGED } from '../helpers/daemon-connection-update-stubs.js'
import { REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { claimDaemonUpdate, resetDaemonUpdateClaims } from '../../src/providers/daemon-update-claim.js'

const GAP = DAEMON_UPDATE_MIN_GAP_MS
const EXPECTED = 'walnut-daemon-expected00'
const OLD = 'walnut-daemon-old00000'
const priv = (c: DaemonConnection) => c as unknown as Record<string, (...args: unknown[]) => unknown>

describe('the gap rule', () => {
  it('reads ps etime in every shape', () => {
    expect(parseEtimeMs('   05:00\n')).toBe(5 * 60_000)
    expect(parseEtimeMs('01:02:03')).toBe((3600 + 120 + 3) * 1000)
    expect(parseEtimeMs('2-03:04:05')).toBe(((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000)
    expect(parseEtimeMs('')).toBeNull()
    expect(parseEtimeMs('ps: unknown option')).toBeNull()
  })

  it('waits out the gap from the daemon\'s start; unknown age or gap 0 goes now', () => {
    expect(daemonUpdateWaitMs(5 * 60_000, GAP)).toBe(GAP - 5 * 60_000)
    expect(daemonUpdateWaitMs(GAP, GAP)).toBe(0)
    expect(daemonUpdateWaitMs(null, GAP)).toBe(0)
    expect(daemonUpdateWaitMs(-5, GAP)).toBe(0)
    expect(daemonUpdateWaitMs(1000, 0)).toBe(0)
  })

  it('holds one build at most one gap in all, so a daemon that keeps restarting still gets it', () => {
    expect(daemonUpdateWaitMs(60_000, GAP, 15 * 60_000)).toBe(GAP - 15 * 60_000)
    expect(daemonUpdateWaitMs(60_000, GAP, GAP)).toBe(0)
    expect(daemonUpdateWaitMs(60_000, GAP, GAP * 3)).toBe(0)
  })

  it('is 2 hours unless the env sets it; 0 turns it off', () => {
    expect(GAP).toBe(2 * 60 * 60_000)
    expect(daemonUpdateMinGapMs({})).toBe(GAP)
    expect(daemonUpdateMinGapMs({ WALNUT_DAEMON_UPDATE_MIN_GAP_MS: '0' })).toBe(0)
    expect(daemonUpdateMinGapMs({ WALNUT_DAEMON_UPDATE_MIN_GAP_MS: '60000' })).toBe(60_000)
    expect(daemonUpdateMinGapMs({ WALNUT_DAEMON_UPDATE_MIN_GAP_MS: 'soon' })).toBe(GAP)
  })

  it('gives way past the 3 h bound and to a capability this server needs', () => {
    const base = { host: 'devbox', ageMs: 60_000, gapMs: GAP, now: 0 }
    expect(daemonUpdateGapHold(base)).toMatchObject({ waitMs: GAP - 60_000, until: GAP - 60_000 })
    expect(daemonUpdateGapHold({ ...base, overdue: true })).toBeNull()
    expect(daemonUpdateGapHold({ ...base, needs: 'snapshot-v1' })).toBeNull()
    // The bound is longer than the gap, so the gap is never what keeps a host past it.
    expect(DAEMON_UPDATE_BEHIND_MAX_MS).toBeGreaterThan(GAP)
  })

  it('says when the update goes and how to have it now', () => {
    const now = new Date(2026, 10, 25, 13, 0).getTime()
    const why = daemonUpdateGapHold({ host: 'devbox', ageMs: 20 * 60_000, gapMs: GAP, now })!.why
    expect(why).toBe('its daemon started 20 min ago; Walnut replaces a host\'s daemon by itself at most once every 2 h, '
      + 'so this update goes at 2:40 PM with the build of then (host_daemon_update devbox does it now)')
    expect(spanWords(100 * 60_000)).toBe('1 h 40 min')
  })

  it('a held update is decided again before the 3 h bound\'s clock would go stale', () => {
    expect(DAEMON_UPDATE_GAP_RECHECK_MS).toBe(Math.max(...UPGRADE_RECHECK_DELAYS_MS))
    expect(DAEMON_UPDATE_GAP_RECHECK_MS).toBeLessThan(DAEMON_UPDATE_BEHIND_STALE_MS)
  })

  it('counts a missing capability once per running build, and only one a newer daemon brings', () => {
    const g = new UpdateGapHold()
    const young = { host: 'devbox', ageMs: 60_000, gapMs: GAP, running: OLD }
    expect(g.decide(EXPECTED, { ...young, now: 0 })).not.toBeNull()
    expect(g.holds).toBe(true)
    // Said by where a daemon runs, never by its build: no update brings these.
    for (const cap of ['net-v1', 'service-update-v1', 'acp-host-v1', 'not-a-capability']) expect(g.need(cap, OLD), cap).toBe(false)
    expect(g.need('snapshot-v1', null)).toBe(false) // a daemon that named no build
    expect(g.need('snapshot-v1', OLD)).toBe(true)
    expect(g.need('usage-scan-v1', OLD)).toBe(false) // once per running build
    expect(g.needs(OLD)).toBe('snapshot-v1')
    expect(g.decide(EXPECTED, { ...young, now: 1 })).toBeNull()
    expect(g.holds).toBe(false)
    // Another build running there: the need was the old one's.
    expect(g.needs('walnut-daemon-other0')).toBeNull()
  })

  it('keeps an ask with its build: every decision of it goes past the gap, another build waits again', () => {
    const g = new UpdateGapHold()
    const young = { host: 'devbox', ageMs: 60_000, gapMs: GAP, running: OLD, now: 0 }
    g.ask(EXPECTED)
    expect(g.decide(EXPECTED, young)).toBeNull()
    expect(g.decide(EXPECTED, { ...young, now: 15 * 60_000 })).toBeNull()
    expect(g.decide('walnut-daemon-newer0', young)).not.toBeNull()
  })

  it('a grants file read only in part keeps the ask for the next read; a revoke ends it', () => {
    const g = new UpdateGapHold()
    let err: (Error & { code?: string }) | null = Object.assign(new Error('grants file unreadable'), { code: 'exec_grants_unreadable' })
    g.ask(EXPECTED, { overBusy: true }, () => { if (err) throw err })
    expect(g.asked(EXPECTED)).toBe(false) // no answer on the grant now: no ask now
    err = null
    expect(g.overBusy(EXPECTED)).toBe(true) // read again: it still stands
    err = Object.assign(new Error('revoked'), { code: 'exec_grant_revoked' })
    expect(g.asked(EXPECTED)).toBe(false)
    err = null
    expect(g.asked(EXPECTED)).toBe(false) // gone for good
  })

  it('every required capability is one a newer daemon brings, so a daemon that lacks one is updated past the gap', () => {
    for (const cap of REQUIRED_DAEMON_CAPABILITIES) expect(capabilityByBuild(cap), cap).toBe(true)
  })

  // The door's capabilities (daemon-standalone.ts) are claimed by where the daemon runs: the two lists stay one.
  it('knows every capability the daemon says by where it runs', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
    const line = /const DOOR_CAPABILITIES = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? ''
    const door = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(door.length).toBeGreaterThan(0)
    expect([...DOOR_CAPABILITIES].sort()).toEqual(door.sort())
    for (const cap of [...door, ...HOST_DEPENDENT_CAPABILITIES]) expect(capabilityByBuild(cap), cap).toBe(false)
  })
})

/** An unmanaged SSH host running `version`, whose daemon has run `etime` (the probe's tail). */
function host(conn: DaemonConnection, version: string, etime: string | null, serviceProbe?: string): string[] {
  const seen: string[] = []
  // What runs the daemon, as a hello says it: with none known no copy can be kept, and nothing is stopped.
  ;(conn as unknown as { _runtime: unknown })._runtime = 'node'
  vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED)
  vi.spyOn(priv(conn), 'deployDaemon').mockImplementation(async () => { seen.push('DEPLOY'); return 'node' })
  vi.spyOn(priv(conn), 'prewarmRemoteFolds').mockResolvedValue(undefined)
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    // The staged daemon's trial run and the kept previous daemon (daemon-trial-cmd.ts): it serves, and the files were kept.
    if (cmd.includes('walnut-trial-ok')) return 'walnut-trial-ok'
    if (cmd.includes('walnut-previous-kept')) return 'walnut-previous-kept'
    if (cmd.includes('walnut-service-probe-done')) return serviceProbe ?? [...remoteServiceProbePaths().map((p) => `absent ${p}`), 'walnut-service-probe-done'].join('\n')
    if (cmd.includes('uname -m')) return 'x86_64'
    if (cmd.includes('walnut-daemon-stop-confirmed')) return 'walnut-daemon-stop-confirmed\n'
    if (cmd.includes('daemon.version')) {
      // The probe as a real shell prints it: version, the serves mark, and the age mark when ps answers.
      const age = cmd.includes('__WALNUT_DAEMON_AGE__') && etime !== null ? `\n__WALNUT_DAEMON_AGE__\n${etime}\n` : ''
      return `${version}\n\n__WALNUT_DAEMON_SERVES__\n${age}`
    }
    return ''
  })
  return seen
}
const stops = (seen: string[]) => seen.filter((c) => c.includes('walnut-daemon-stop-confirmed'))

let conns: DaemonConnection[] = []
afterEach(() => {
  for (const c of conns) c.disconnect()
  conns = []
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
function make(): DaemonConnection {
  const c = new DaemonConnection('devbox', { hostname: 'devbox.example.com', user: 'tester' })
  conns.push(c)
  return c
}

describe('an SSH host\'s daemon', () => {
  it('that started 5 minutes ago keeps serving; the update is decided again when the gap ends', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    const seen = host(c, OLD, '   05:00')
    const postpone = vi.spyOn(priv(c), 'postponeUpgrade')
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(seen.filter((s) => s === 'DEPLOY')).toEqual([])
    expect(stops(seen)).toEqual([])
    expect(postpone).toHaveBeenCalledTimes(1)
    const [why, , , opts] = postpone.mock.calls[0] as [string, string, string, { delayMs: number; until: number }]
    expect(why).toMatch(/started 5 min ago.*host_daemon_update devbox does it now/)
    // Asked again within the recheck cadence, not only at the gap's end: the 3 h bound's clock stays seen.
    expect(opts.delayMs).toBe(DAEMON_UPDATE_GAP_RECHECK_MS)
    expect(opts.until).toBeGreaterThanOrEqual(Date.now() + GAP - 5 * 60_000 - 1_000)
    expect(c.daemonUpdateWait).toBeNull() // the link is down: no wait is shown
  })

  it('past the 3 h bound is updated at once, young or not', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    const seen = host(c, OLD, '00:30')
    vi.spyOn(priv(c), 'noteOverdue').mockImplementation(function (this: { _overdueMs: number }) { this._overdueMs = DAEMON_UPDATE_BEHIND_MAX_MS + 1 })
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(stops(seen)).toHaveLength(1)
  })

  it('held, a capability a feature needs and the daemon lacks decides it again now, once; a plain read does not', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    vi.useFakeTimers()
    try {
      const c = make()
      const seen = host(c, OLD, '00:30')
      ;(c as unknown as { _capabilities: string[] })._capabilities = ['attach-v1']
      const recheck = vi.spyOn(priv(c), 'recheckPostponedUpgrade').mockResolvedValue(false)
      ;(c as unknown as { _daemonVersion: string })._daemonVersion = OLD
      await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
      // hasCapability is a read: an optional probe with a fallback decides nothing.
      expect(c.hasCapability('snapshot-v1')).toBe(false)
      expect(needCapability(c, 'net-v1')).toBe(false) // a door capability: no build brings it
      await vi.advanceTimersByTimeAsync(0)
      expect(recheck).not.toHaveBeenCalled()
      expect(needCapability(c, 'snapshot-v1')).toBe(false)
      expect(needCapability(c, 'snapshot-v1')).toBe(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(recheck).toHaveBeenCalledTimes(1)
      // The decision it starts goes past the gap.
      await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
      expect(stops(seen)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('held, is decided again when the gap ends, and a daemon that restarted meanwhile no longer holds it past one gap', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    vi.useFakeTimers()
    try {
      const c = make()
      const seen = host(c, OLD, '00:30')
      const recheck = vi.spyOn(priv(c), 'recheckPostponedUpgrade').mockResolvedValue(false)
      await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(GAP)
      expect(recheck).toHaveBeenCalledTimes(1)
      // The re-check finds the daemon young again (it crashed and restarted): one gap has passed, so it goes.
      await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
      expect(stops(seen)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['ran past the gap', OLD, '02:05:00'],
    ['whose age ps could not tell', OLD, null],
  ])('that %s is updated now', async (_case, version, etime) => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    const seen = host(c, version, etime)
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(stops(seen)).toHaveLength(1)
  })

  // Review r1, high 2: a daemon that refuses this server's handshake (a required capability missing)
  // cannot serve it at all; upgradeBeforeServing's decision must not wait for the gap.
  it.each([[true], [false]])('managed and young, missing a required capability (%s), is updated at once; with them all it waits', async (missing) => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    host(c, OLD, '00:30', MANAGED)
    vi.spyOn(priv(c), '_sendHandshake').mockResolvedValue({ ok: true, version: OLD, capabilities: missing ? [] : [...REQUIRED_DAEMON_CAPABILITIES] })
    vi.spyOn(priv(c), 'announceProbeRole').mockImplementation(() => {})
    await priv(c).verifyCapabilities()
    const managed = vi.spyOn(priv(c), 'updateManagedDaemon').mockResolvedValue(true)
    vi.spyOn(priv(c), 'serviceModeNow').mockResolvedValue({ due: false })
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(missing)
    expect(managed).toHaveBeenCalledTimes(missing ? 1 : 0)
  })

  it('missing (a start, not a replacement) is never held', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    host(c, '', '00:03')
    const postpone = vi.spyOn(priv(c), 'postponeUpgrade')
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(postpone).not.toHaveBeenCalled()
  })

  it('of the current build is left alone, young or not', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    const seen = host(c, EXPECTED, '00:03')
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(stops(seen)).toEqual([])
  })
})

// A task that fixed host-side code puts it on the host now (host_daemon_update), on the SSH path too.
describe('an SSH host\'s daemon asked for now', () => {
  /** A live link: the asked decision runs as a postponed one does (runUpgradeRecheck). */
  function live(c: DaemonConnection): { lost: ReturnType<typeof vi.fn> } {
    Object.assign(c as unknown as Record<string, unknown>, { _connected: true, _daemonVersion: OLD })
    vi.spyOn(priv(c), 'getRemoteDaemonPath').mockResolvedValue('/tmp/open-walnut/daemon-linux-x64')
    const lost = vi.fn()
    vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(lost)
    return { lost }
  }

  it('goes past the gap, and answers in the host network update\'s shape', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    const seen = host(c, OLD, '00:30')
    const { lost } = live(c)
    const answer = await c.requestDaemonUpdate()
    expect(answer).toMatchObject({ phase: 'running', host: 'devbox', running: OLD, expected: EXPECTED })
    expect(stops(seen)).toHaveLength(1)
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('still waits for the host\'s work, and says why', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    const seen = host(c, OLD, '00:30')
    live(c)
    vi.spyOn(priv(c), 'acpTurnsOpen').mockImplementation(async (...a: unknown[]) => {
      priv(c).postponeUpgrade('ACP turns are open', a[0], a[1], { steady: true })
      return true
    })
    expect(await c.requestDaemonUpdate()).toMatchObject({ phase: 'postponed', message: 'waiting: ACP turns are open', running: OLD, expected: EXPECTED })
    expect(stops(seen)).toEqual([])
  })

  it('a refused asker stops nothing', async () => {
    const c = make()
    host(c, OLD, '02:05:00')
    live(c)
    const seen = (c as unknown as { sshExec: { mock: { calls: unknown[] } } }).sshExec.mock.calls
    await expect(c.requestDaemonUpdate(() => { throw new Error('the grant was revoked') })).rejects.toThrow(/revoked/)
    expect(seen).toEqual([])
  })

  // Review r1, high 1: an ask an ACP turn put off was then held by the gap for up to 2 h.
  it('asked and put off by an open ACP turn, goes once the turn ends, without being asked again', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    const seen = host(c, OLD, '00:30')
    live(c)
    let open = true
    vi.spyOn(priv(c), 'acpTurnsOpen').mockImplementation(async (...a: unknown[]) => {
      if (!open) return false
      priv(c).postponeUpgrade('ACP turns are open', a[0], a[1], { steady: true })
      return true
    })
    expect(await c.requestDaemonUpdate()).toMatchObject({ phase: 'postponed', message: 'waiting: ACP turns are open' })
    open = false
    // The automatic decision the postpone's timer runs (no ask, no soft holds lifted but the gap's).
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(stops(seen)).toHaveLength(1)
  })

  // 2026-11-25: an ask refused as busy, then the link dropped and came back on a new connection
  // object, whose next automatic decision held the asked build for the gap again: the ask was lost.
  it('the ask survives a reconnect that makes a new connection to the host', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const first = make()
    host(first, OLD, '00:30')
    live(first)
    vi.spyOn(priv(first), 'acpTurnsOpen').mockImplementation(async (...a: unknown[]) => {
      priv(first).postponeUpgrade('ACP turns are open', a[0], a[1], { steady: true })
      return true
    })
    expect(await first.requestDaemonUpdate()).toMatchObject({ phase: 'postponed', message: 'waiting: ACP turns are open' })
    first.disconnect()
    const next = make()
    const seen = host(next, OLD, '00:30')
    // The automatic decision of the new connection: no ask passed, the gap gives way all the same.
    await expect(priv(next).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(stops(seen)).toHaveLength(1)
  })

  it('the ask is its build\'s: a newer build expected after it waits for the gap again', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    host(c, OLD, '00:30')
    live(c)
    vi.spyOn(priv(c), 'acpTurnsOpen').mockResolvedValue(true)
    await c.requestDaemonUpdate()
    vi.spyOn(priv(c), 'getExpectedDaemonVersion').mockReturnValue('walnut-daemon-newer0')
    const postpone = vi.spyOn(priv(c), 'postponeUpgrade')
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(String(postpone.mock.calls[0]?.[0])).toMatch(/at most once every 2 h/)
  })

  // Review r1 low 5, r2 low D: running only when a decision here replaced the daemon meanwhile; a link blip is no swap.
  it.each([
    ['another decision replaced the daemon while it waited', true, 'running'],
    ['the link only dropped', false, 'skipped'],
  ])('answers by what happened: %s', async (_case, replaced, phase) => {
    const c = make()
    host(c, OLD, '02:05:00')
    live(c)
    vi.spyOn(priv(c), 'recheckPostponedUpgrade').mockImplementation(async () => {
      Object.assign(c as unknown as Record<string, unknown>, { _connected: false, ...(replaced ? { _replacedAt: Date.now() } : {}) })
      return false
    })
    expect(await c.requestDaemonUpdate()).toMatchObject({ phase, ...(replaced ? { message: expect.stringContaining('reconnects on the new build') } : {}) })
  })

  // Review r2, low C: a grant revoked before the swap takes the ask with it.
  it('an asker refused before the swap leaves no ask behind: the gap holds that build again', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    const seen = host(c, OLD, '00:30')
    live(c)
    let asks = 0
    const gate = () => { if (++asks > 1) throw new Error('the grant was revoked') }
    expect(await c.requestDaemonUpdate(gate)).toMatchObject({ phase: 'postponed', message: expect.stringContaining('refused') })
    expect(stops(seen)).toEqual([])
    const postpone = vi.spyOn(priv(c), 'postponeUpgrade')
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(String(postpone.mock.calls[0]?.[0])).toMatch(/at most once every 2 h/)
  })
})

describe('a host network machine\'s daemon', () => {
  const facts = (over: Partial<NetUpdateFacts> = {}): NetUpdateFacts => ({
    kind: 'net', host: 'studio-mac', testServer: false, follower: false, expected: EXPECTED, running: OLD, startup: 'service',
    serviceExecutable: '/srv/walnut', has: () => true, autofixOff: null, turnedOff: false, requested: false, lastAttempt: null,
    now: 1_000_000_000, cooldownMs: 10 * 60_000, target: 'darwin-arm64', source: { file: '/srv/daemon' },
    minGapMs: GAP, ...over,
  })

  it('that started within the gap waits for it to end', () => {
    expect(decideNetUpdate(facts({ daemonAgeMs: 5 * 60_000 }))).toMatchObject({
      go: false, skip: 'recent', retryInMs: GAP - 5 * 60_000, until: 1_000_000_000 + GAP - 5 * 60_000, why: expect.stringContaining('host_daemon_update studio-mac'),
    })
  })

  it('is updated past the gap, on request, with an unknown start, once held a whole gap, past the 3 h bound, or for a capability needed', () => {
    for (const over of [
      { daemonAgeMs: GAP + 1 }, { daemonAgeMs: 5 * 60_000, requested: true }, { daemonAgeMs: null }, { daemonAgeMs: 60_000, gapHeldForMs: GAP },
      { daemonAgeMs: 60_000, overdue: true }, { daemonAgeMs: 60_000, capNeeded: 'snapshot-v1' },
    ]) {
      expect(decideNetUpdate(facts(over)), JSON.stringify(over)).toMatchObject({ go: true })
    }
  })
})

// 2026-11-23: one daemon reached as two hosts (a host network entry and an SSH entry for the same
// machine) was updated by both, each against the other's lock (daemon-update-claim.ts).
describe('an SSH host whose daemon another host name also reaches', () => {
  // Earlier tests' updates leave their settle window behind: each case starts with no claim.
  beforeEach(() => resetDaemonUpdateClaims())
  afterEach(() => resetDaemonUpdateClaims())

  it('while the other name updates it, nothing goes up or stops here; once that ended badly, this one updates it', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    const seen = host(c, OLD, '02:05:00')
    vi.spyOn(priv(c), 'sameDaemonHosts').mockResolvedValue(['devbox', 'devbox-net'])
    const postpone = vi.spyOn(priv(c), 'postponeUpgrade')
    const peer = await claimDaemonUpdate('devbox-net', async () => ['devbox', 'devbox-net'])
    if ('heldBy' in peer) throw new Error('the peer could not claim')
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(seen.filter((s) => s === 'DEPLOY')).toEqual([])
    expect(stops(seen)).toEqual([])
    expect(postpone.mock.calls.map((a) => a[0])).toContain('devbox-net reaches the same daemon and is updating it now')
    peer.release(false)
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(stops(seen)).toHaveLength(1)
    // Replaced here: the other name waits out the settle window instead of starting the same update.
    expect(await claimDaemonUpdate('devbox-net', async () => ['devbox'])).toEqual({ heldBy: 'devbox' })
  })

  it('an update that stopped before the stop frees the claim at once', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    host(c, OLD, '02:05:00')
    vi.spyOn(priv(c), 'sameDaemonHosts').mockResolvedValue(['devbox', 'devbox-net'])
    // The trial run of the staged build fails: the running daemon keeps serving.
    vi.spyOn(priv(c), 'trialStaged').mockResolvedValue('it did not answer')
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect('heldBy' in (await claimDaemonUpdate('devbox-net', async () => ['devbox']))).toBe(false)
  })
})
