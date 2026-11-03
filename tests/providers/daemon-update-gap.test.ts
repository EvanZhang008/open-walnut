/**
 * A host's daemon is replaced at most once per gap (src/providers/daemon-update-gap.ts).
 *
 * 2026-11-03: a run of deploys replaced clouddev's daemon once per build, seven
 * pushes in 20 minutes over a slow link, each swap dropping its sessions' link.
 * Pinned on both update paths a remote host has:
 *   - SSH hosts (DaemonConnection.shouldUpgradeDaemon): the age comes from the
 *     same probe as the version (ps etime of daemon.pid); a daemon younger than
 *     the gap keeps serving and the update is decided again when the gap ends;
 *   - host network machines (decideNetUpdate): the age comes from the hello's
 *     startedAt; a request (host_daemon_update) is never held.
 * All SSH is stubbed at sshExec; no process, socket or tunnel is created.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonConnection, remoteServiceProbePaths } from '../../src/providers/daemon-connection.js'
import { decideNetUpdate, type NetUpdateFacts } from '../../src/providers/daemon-net-update.js'
import { DAEMON_UPDATE_MIN_GAP_MS, daemonUpdateMinGapMs, daemonUpdateWaitMs, parseEtimeMs } from '../../src/providers/daemon-update-gap.js'

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
    expect(daemonUpdateWaitMs(60_000, GAP, 15 * 60_000)).toBe(5 * 60_000)
    expect(daemonUpdateWaitMs(60_000, GAP, GAP)).toBe(0)
    expect(daemonUpdateWaitMs(60_000, GAP, GAP * 3)).toBe(0)
  })

  it('is 20 minutes unless the env sets it; 0 turns it off', () => {
    expect(GAP).toBe(20 * 60_000)
    expect(daemonUpdateMinGapMs({})).toBe(GAP)
    expect(daemonUpdateMinGapMs({ WALNUT_DAEMON_UPDATE_MIN_GAP_MS: '0' })).toBe(0)
    expect(daemonUpdateMinGapMs({ WALNUT_DAEMON_UPDATE_MIN_GAP_MS: '60000' })).toBe(60_000)
    expect(daemonUpdateMinGapMs({ WALNUT_DAEMON_UPDATE_MIN_GAP_MS: 'soon' })).toBe(GAP)
  })
})

/** An unmanaged SSH host running `version`, whose daemon has run `etime` (the probe's tail). */
function host(conn: DaemonConnection, version: string, etime: string | null): string[] {
  const seen: string[] = []
  vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED)
  vi.spyOn(priv(conn), 'deployDaemon').mockImplementation(async () => { seen.push('DEPLOY'); return 'node' })
  vi.spyOn(priv(conn), 'prewarmRemoteFolds').mockResolvedValue(undefined)
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    if (cmd.includes('walnut-service-probe-done')) return [...remoteServiceProbePaths().map((p) => `absent ${p}`), 'walnut-service-probe-done'].join('\n')
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
    const [why, , , opts] = postpone.mock.calls[0] as [string, string, string, { delayMs: number }]
    expect(why).toMatch(/started 5 min ago/)
    expect(opts.delayMs).toBe(GAP - 5 * 60_000 + 5_000)
  })

  it('held, is decided again when the gap ends, and a daemon that restarted meanwhile no longer holds it past one gap', async () => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    vi.useFakeTimers()
    try {
      const c = make()
      const seen = host(c, OLD, '00:30')
      const recheck = vi.spyOn(priv(c), 'recheckPostponedUpgrade').mockResolvedValue(undefined)
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
    ['ran past the gap', OLD, '25:00'],
    ['whose age ps could not tell', OLD, null],
  ])('that %s is updated now', async (_case, version, etime) => {
    vi.stubEnv('WALNUT_DAEMON_UPDATE_MIN_GAP_MS', String(GAP))
    const c = make()
    const seen = host(c, version, etime)
    await expect(priv(c).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(stops(seen)).toHaveLength(1)
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

describe('a host network machine\'s daemon', () => {
  const facts = (over: Partial<NetUpdateFacts> = {}): NetUpdateFacts => ({
    kind: 'net', host: 'studio-mac', testServer: false, follower: false, expected: EXPECTED, running: OLD, startup: 'service',
    serviceExecutable: '/srv/walnut', has: () => true, autofixOff: null, turnedOff: false, requested: false, lastAttempt: null,
    now: 1_000_000_000, cooldownMs: 10 * 60_000, target: 'darwin-arm64', source: { file: '/srv/daemon' },
    minGapMs: GAP, ...over,
  })

  it('that started within the gap waits for it to end', () => {
    expect(decideNetUpdate(facts({ daemonAgeMs: 5 * 60_000 }))).toMatchObject({ go: false, skip: 'recent', retryInMs: GAP - 5 * 60_000 })
  })

  it('is updated past the gap, on request, with an unknown start, or once held a whole gap', () => {
    for (const over of [{ daemonAgeMs: GAP + 1 }, { daemonAgeMs: 5 * 60_000, requested: true }, { daemonAgeMs: null }, { daemonAgeMs: 60_000, gapHeldForMs: GAP }]) {
      expect(decideNetUpdate(facts(over)), JSON.stringify(over)).toMatchObject({ go: true })
    }
  })
})
