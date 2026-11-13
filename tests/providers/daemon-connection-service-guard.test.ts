/**
 * A remote host whose daemon runs as an OS service is off limits to walnut's
 * unmanaged lifecycle paths.
 *
 * Three shapes this pins, each one a way the old code fought the manager:
 *
 *   1. checkDaemonRunning() found no live daemon during a launchd/systemd gap and
 *      returned null → connect()/reconnect() deployed and `nohup`-started an
 *      unmanaged daemon into /tmp/open-walnut. The daemon's instance lock then
 *      refuses every managed start ("service handover is required") forever.
 *      Now: it throws a service-not-ready error that NEITHER the strict nor the
 *      non-strict path may swallow.
 *   2. A capability handshake failure ran forceRedeployAndReconnect(), which
 *      `--stop`s the daemon and kills its pid — the manager restarts it right
 *      back, racing our replacement. Now: refused BEFORE any WS/tunnel teardown.
 *   3. shouldUpgradeDaemon() silently returned false for a managed daemon, so a
 *      stale protocol served forever with nothing in the logs. Now: it compares
 *      versions and names `walnut daemon install` on mismatch, while still never
 *      stopping the process.
 *
 * All SSH is stubbed at sshExec; no process, socket, or tunnel is created.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

const { managedUpdate } = vi.hoisted(() => ({ managedUpdate: vi.fn() }))
vi.mock('../../src/providers/daemon-service-update.js', () => ({ updateRemoteDaemonService: managedUpdate }))
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  DaemonConnection,
  DaemonServiceNotReadyError,
  DaemonServiceProbeError,
  SERVICE_PROBE_TIMEOUTS_MS,
  UPGRADE_RECHECK_DELAYS_MS,
  buildRemoteServiceProbeCmd,
  parseRemoteServiceProbe,
  remoteServiceProbePaths,
  managedUpdateScope,
  reviveScopeOf,
  REVIVE_EVERY_MS,
} from '../../src/providers/daemon-connection.js'
import { log } from '../../src/logging/index.js'
import { DAEMON_UPDATE_BEHIND_MAX_MS, daemonUpdateOverdue } from '../../src/providers/daemon-update-behind.js'
import { setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'
import { buildBackoffSettled } from '../../src/providers/daemon-build-backoff.js'
import { holdAndRecord, recordStoreWrites } from '../helpers/store-write-order.js'
import type { SshTarget } from '../../src/providers/session-io.js'
import { PROBING_WORD } from '../../src/providers/daemon-update-probation.js'

const TARGET: SshTarget = { hostname: 'devbox.example.com', user: 'tester' }
const EXPECTED_VERSION = 'walnut-daemon-expected00'
const RUNNING_STATUS = JSON.stringify({ running: true, pid: 4242, port: 32100 })

const priv = (conn: DaemonConnection) => conn as unknown as Record<string, (...args: unknown[]) => unknown>
const state = (conn: DaemonConnection) => conn as unknown as Record<string, unknown>

/** Probe reply for the real path list, with chosen paths present/unknown. */
function probeReply(opts: { present?: string[]; unknown?: string[]; truncated?: boolean; dir?: string } = {}): string {
  const lines = remoteServiceProbePaths(opts.dir).map((p) => {
    if (opts.present?.includes(p)) return `present ${p}`
    if (opts.unknown?.includes(p)) return `unknown ${p}`
    return `absent ${p}`
  })
  if (!opts.truncated) lines.push('walnut-service-probe-done')
  return lines.join('\n')
}

interface SshRoutes {
  /** The service probe's reply, or a function of the attempt's deadline (throw = no answer). */
  probe: string | ((timeoutMs: number) => string)
  /** `<binary> --status` reply. Empty = no daemon; a function may throw (ssh failed). */
  status?: string | (() => string)
  /** pid/port file probe reply. Empty = no daemon; a function may throw (ssh failed). */
  files?: string | (() => string)
  /** /tmp/open-walnut/daemon.version contents, or a function (throw = the read failed). */
  version?: string | (() => string)
  /** acp-busy.json contents. Empty = no open ACP turns. */
  busy?: string
  stopPending?: boolean
  /** Awaited before the stop confirms (a slow shutdown). */
  stopGate?: Promise<void>
  /** The service revive's record (daemon-update-tail.ts reviveScript), or a function of it. */
  revive?: string | (() => string)
  /** Files an update's runner left in its staging dir on the host, read with `if [ -f ... ]; then cat`. */
  record?: Map<string, string>
  /** What the check for a running probation prints (daemon-update-probation.ts probingCheckScript). */
  probing?: string
}

const answer = (route: string | (() => string) | undefined) => typeof route === 'function' ? route() : route ?? ''

/**
 * Stub every SSH round trip; returns the list of commands actually issued. The
 * deploy an update makes before its stop (stageUpgrade) is stubbed too, seen as
 * `DEPLOY`: its uploads are not SSH round trips (they have tests of their own).
 */
function stubSsh(conn: DaemonConnection, routes: SshRoutes): string[] {
  const seen: string[] = []
  // What runs the daemon, as a hello says it: with none known no copy can be kept, and nothing is stopped.
  if ((conn as unknown as { _runtime: unknown })._runtime == null) (conn as unknown as { _runtime: unknown })._runtime = 'node'
  vi.spyOn(priv(conn), 'deployDaemon').mockImplementation(async () => { seen.push('DEPLOY'); return 'node' })
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    // The staged daemon's trial run and the kept previous daemon (daemon-trial-cmd.ts): it serves, and the files were kept.
    if (cmd.includes('walnut-trial-ok')) return 'walnut-trial-ok'
    if (cmd.includes('walnut-previous-kept')) return 'walnut-previous-kept'
    if (cmd.includes('walnut-revive=updating')) return answer(routes.revive)
    if (cmd.includes(PROBING_WORD)) return routes.probing ?? ''
    const read = /^if \[ -f '(\/tmp\/open-walnut-update\.[^']+)' \]/.exec(cmd)
    if (read && routes.record) return routes.record.get(read[1]) ?? '__walnut_no_file__'
    if (cmd.includes('walnut-service-probe-done')) {
      return typeof routes.probe === 'function' ? routes.probe(Number(args[1])) : routes.probe
    }
    if (cmd.includes('walnut-daemon-stop-confirmed')) {
      if (routes.stopGate) await routes.stopGate
      if (routes.stopPending) throw new Error('shutdown pending')
      return 'walnut-daemon-stop-confirmed\n'
    }
    if (cmd.includes('uname -m')) return 'x86_64'
    if (cmd.includes('--status')) return answer(routes.status)
    if (cmd.includes('kill -0')) return answer(routes.files)
    if (cmd.includes('acp-busy.json')) return routes.busy ?? ''
    if (cmd.includes('daemon.version')) return typeof routes.version === 'function' ? routes.version() : routes.version ?? ''
    return ''
  })
  return seen
}

// `kill -0` is the read-only liveness probe; any other kill, or a --stop, ends a daemon. The trial's kill stops only its own trial child.
// The revive's script holds the tail's put-back, whose cron branch asks the supervisor's own child to
// exit after its config was put back; what a revive did is the route's answer, not that text.
const destructive = (seen: string[]) => seen.filter((c) => !c.includes('walnut-trial-ok') && !c.includes('walnut-revive=updating') && (c.includes('--stop') || /\bkill\b(?! -0\b)/.test(c)))

describe('remote service probe (pure)', () => {
  it('parses real shell output with HOME expansion and literal hostile-looking path text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-service-probe-'))
    try {
      const special = "a' b; $(touch unwanted)"
      await fs.writeFile(path.join(root, special), 'service')
      const paths = [`$HOME/${special}`, '$HOME/missing/deep/unit', '$HOME/link']
      await fs.symlink(path.join(root, 'absent-target'), path.join(root, 'link'))
      const { stdout } = await promisify(execFile)('/bin/sh', ['-c', buildRemoteServiceProbeCmd(paths)], {
        env: { HOME: root, PATH: '/usr/bin:/bin' }, cwd: root, timeout: 5000,
      })
      expect(parseRemoteServiceProbe(stdout, paths)).toEqual({ managed: true, present: [paths[0], paths[2]], unknown: [] })
      await expect(fs.stat(path.join(root, 'unwanted'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('the command classifies present / unreadable / absent and ends with a sentinel', () => {
    const cmd = buildRemoteServiceProbeCmd(['/tmp/open-walnut/daemon.service'])
    expect(cmd).toContain("[ -e '/tmp/open-walnut/daemon.service' ]")
    expect(cmd).toContain("'present /tmp/open-walnut/daemon.service'")
    expect(cmd).toContain("'unknown /tmp/open-walnut/daemon.service'")
    expect(cmd).toContain("'absent /tmp/open-walnut/daemon.service'")
    expect(cmd.trimEnd().endsWith('echo walnut-service-probe-done')).toBe(true)
  })

  it('probes the runtime marker plus both platforms\' persistent configs', () => {
    expect(remoteServiceProbePaths()).toEqual([
      '/tmp/open-walnut/daemon.service',
      '$HOME/.config/systemd/user/open-walnut-daemon.service',
      '/etc/systemd/system/open-walnut-daemon.service',
      '$HOME/.local/share/open-walnut/daemon/daemon-boot.sh',
      '$HOME/Library/LaunchAgents/dev.openwalnut.session-daemon.plist',
    ])
  })

  it('updates exactly one config of Walnut\'s from the server: a user unit or the cron boot script, never a system unit', () => {
    const [user, system, cron] = ['$HOME/.config/systemd/user/open-walnut-daemon.service', '/etc/systemd/system/open-walnut-daemon.service', '$HOME/.local/share/open-walnut/daemon/daemon-boot.sh']
    expect(managedUpdateScope([user])).toBe('user')
    expect(managedUpdateScope([cron])).toBe('cron')
    expect(managedUpdateScope(['/tmp/open-walnut/daemon.service', cron])).toBe('cron')
    expect(managedUpdateScope([system])).toBeNull()
    expect(managedUpdateScope([user, cron])).toBeNull()
    expect(managedUpdateScope([user, system])).toBeNull()
    expect(managedUpdateScope([])).toBeNull()
  })

  it('a complete all-absent reply is the only "not managed" answer', () => {
    expect(parseRemoteServiceProbe(probeReply(), remoteServiceProbePaths()).managed).toBe(false)
  })

  it('a present config → managed', () => {
    const config = '/etc/systemd/system/open-walnut-daemon.service'
    const takeover = parseRemoteServiceProbe(probeReply({ present: [config] }), remoteServiceProbePaths())
    expect(takeover.managed).toBe(true)
    expect(takeover.present).toEqual([config])
  })

  it('an unreadable config → managed, listed as unknown', () => {
    const config = '$HOME/.config/systemd/user/open-walnut-daemon.service'
    const takeover = parseRemoteServiceProbe(probeReply({ unknown: [config] }), remoteServiceProbePaths())
    expect(takeover.managed).toBe(true)
    expect(takeover.unknown).toEqual([config])
  })

  it('a reply without the sentinel is unknown everywhere (truncation ≠ absence), and no answer', () => {
    const takeover = parseRemoteServiceProbe(probeReply({ truncated: true }), remoteServiceProbePaths())
    expect(takeover.managed).toBe(true)
    expect(takeover.unknown).toEqual(remoteServiceProbePaths())
    expect(takeover.undetermined).toBe('the probe reply was cut short')
  })

  it('a complete reply is an answer, even one with unreadable paths', () => {
    const config = '$HOME/.config/systemd/user/open-walnut-daemon.service'
    expect('undetermined' in parseRemoteServiceProbe(probeReply({ unknown: [config] }), remoteServiceProbePaths())).toBe(false)
    expect('undetermined' in parseRemoteServiceProbe(probeReply(), remoteServiceProbePaths())).toBe(false)
  })

  it('the service error claims a service only when Walnut saw its config', () => {
    const seen = new DaemonServiceNotReadyError('devbox', 'x', { managed: true, present: ['/tmp/open-walnut/daemon.service'], unknown: [] })
    const unread = new DaemonServiceNotReadyError('devbox', 'x', { managed: true, present: [], unknown: ['$HOME/.config/systemd/user/open-walnut-daemon.service'] })
    expect(seen.message).toContain("'devbox' runs the walnut session daemon as an OS service")
    expect(unread.message).toContain("'devbox' may run the walnut session daemon as an OS service")
  })

  it('a path the reply never mentions is unknown, not absent', () => {
    const takeover = parseRemoteServiceProbe(
      'absent /tmp/open-walnut/daemon.service\nwalnut-service-probe-done',
      ['/tmp/open-walnut/daemon.service', '/etc/systemd/system/open-walnut-daemon.service'],
    )
    expect(takeover.managed).toBe(true)
    expect(takeover.unknown).toEqual(['/etc/systemd/system/open-walnut-daemon.service'])
  })
})

describe('DaemonConnection — managed host, daemon not answering', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const managedProbe = () => probeReply({ present: ['/etc/systemd/system/open-walnut-daemon.service'] })

  it('checkDaemonRunning() throws service-not-ready instead of returning null', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    stubSsh(conn, { probe: managedProbe() })

    const error = await (priv(conn).checkDaemonRunning() as Promise<unknown>).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DaemonServiceNotReadyError)
    expect((error as DaemonServiceNotReadyError).kind).toBe('service-not-ready')
    expect((error as Error).message).toContain('walnut daemon restart --yes')
  })

  it('the strict path surfaces the same error (never an SSH misdiagnosis)', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    stubSsh(conn, { probe: managedProbe() })

    await expect(priv(conn).checkDaemonRunning({ strict: true }))
      .rejects.toBeInstanceOf(DaemonServiceNotReadyError)
  })

  it('connect() refuses — no deploy, no nohup start', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    stubSsh(conn, { probe: managedProbe() })
    vi.spyOn(priv(conn), 'ensureControlMaster').mockResolvedValue(undefined)
    // The daemon dir probe has its own tests; the stub ssh does not answer it.
    vi.spyOn(priv(conn), 'resolveRemoteDir').mockResolvedValue(undefined)
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue('node')
    const start = vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(1234)

    await expect(conn.connect()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    expect(deploy).toHaveBeenCalledTimes(0)
    expect(start).toHaveBeenCalledTimes(0)
  })

  it('reconnect() refuses too — the error is not swallowed into a redeploy', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    stubSsh(conn, { probe: managedProbe() })
    vi.spyOn(priv(conn), 'stopControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'ensureControlMaster').mockResolvedValue(undefined)
    // The daemon dir probe has its own tests; the stub ssh does not answer it.
    vi.spyOn(priv(conn), 'resolveRemoteDir').mockResolvedValue(undefined)
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue('node')
    const start = vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(1234)

    await expect(priv(conn).reconnect()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    expect(deploy).toHaveBeenCalledTimes(0)
    expect(start).toHaveBeenCalledTimes(0)
  })

  it('an unmanaged host still reports "absent" so the deploy path survives', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    stubSsh(conn, { probe: probeReply() })

    await expect(priv(conn).checkDaemonRunning()).resolves.toBeNull()
  })
})

// 2026-11-04 review: a service whose config is on the host while nothing of it runs (a bootout
// with no bootstrap after it) was only ever refused over SSH; the local server revived it.
describe('DaemonConnection: a service on the host with nothing of it running', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const userUnit = '$HOME/.config/systemd/user/open-walnut-daemon.service'
  const agent = '$HOME/Library/LaunchAgents/dev.openwalnut.session-daemon.plist'

  it('revives a user unit or a LaunchAgent, the cron supervisor, and never a system unit or two kinds at once', () => {
    expect(reviveScopeOf([userUnit])).toBe('user')
    expect(reviveScopeOf([agent])).toBe('user')
    expect(reviveScopeOf(['$HOME/.local/share/open-walnut/daemon/daemon-boot.sh'])).toBe('cron')
    expect(reviveScopeOf(['/etc/systemd/system/open-walnut-daemon.service'])).toBeNull()
    expect(reviveScopeOf([userUnit, '$HOME/.local/share/open-walnut/daemon/daemon-boot.sh'])).toBeNull()
    expect(reviveScopeOf([])).toBeNull()
  })

  it('is loaded the way an update tail does it, over SSH, then served: nothing deployed, nothing stopped', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const routes: SshRoutes = { probe: probeReply({ present: [userUnit] }), status: '', version: EXPECTED_VERSION }
    routes.revive = () => { routes.status = RUNNING_STATUS; return 'outcome=loaded\nthe service was not running; it was loaded again' }
    const seen = stubSsh(conn, routes)
    const start = vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(1234)
    await expect(priv(conn).checkDaemonRunning()).resolves.toBe(32100)
    expect(seen.filter((cmd) => cmd.includes('walnut-revive=updating'))).toHaveLength(1)
    expect(seen).not.toContain('DEPLOY')
    expect(start).not.toHaveBeenCalled()
    expect(destructive(seen)).toEqual([])
  })

  it('a revive that finds an update at work refuses and says so, and is not run again within its interval', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const seen = stubSsh(conn, { probe: probeReply({ present: [agent] }), status: '', revive: 'walnut-revive=updating' })
    await expect(priv(conn).checkDaemonRunning()).rejects.toThrow(/a daemon update's runner is still at work on the host/)
    await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    expect(seen.filter((cmd) => cmd.includes('walnut-revive=updating'))).toHaveLength(1)
    state(conn)._revivedAt = Date.now() - REVIVE_EVERY_MS - 1
    await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    expect(seen.filter((cmd) => cmd.includes('walnut-revive=updating'))).toHaveLength(2)
  })

  it('a revive that leaves no daemon refuses with its words', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    stubSsh(conn, { probe: probeReply({ present: [userUnit] }), status: '', revive: 'outcome=down\nno daemon answered within 30 s after the service was started' })
    await expect(priv(conn).checkDaemonRunning()).rejects.toThrow(/\(no daemon answered within 30 s after the service was started\)/)
  })
})

describe('DaemonConnection: a managed update over SSH that did not go through', () => {
  afterEach(() => { vi.restoreAllMocks(); managedUpdate.mockReset() })

  function managedOnOld(record?: Map<string, string>, probing?: string) {
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
    vi.spyOn(priv(conn), 'getLocalBinaryPath').mockResolvedValue('/fixture/daemon')
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(log.session, 'error').mockImplementation(() => {})
    const seen = stubSsh(conn, { probe: probeReply({ present: ['$HOME/.config/systemd/user/open-walnut-daemon.service'] }), status: RUNNING_STATUS, version: 'walnut-daemon-old00000', record, probing })
    const postpone = vi.spyOn(priv(conn), 'postponeUpgrade').mockImplementation(() => {})
    return { conn, seen, postpone }
  }

  it('deferred on the host (launchd starting no jobs): served as it is, put off for the cooldown, no failure', async () => {
    const { conn, postpone, seen } = managedOnOld()
    managedUpdate.mockRejectedValue(new Error('Managed daemon update failed: update deferred: launchd is starting no jobs in this login session now (a dark wake with the lid closed, or a login not finished); nothing was changed, and the running daemon keeps serving; '))
    await expect(priv(conn).checkDaemonRunning()).resolves.toBe(32100)
    expect(postpone).toHaveBeenCalledTimes(1)
    expect(postpone.mock.calls[0][0]).toMatch(/^update deferred: launchd is starting no jobs/)
    expect(postpone.mock.calls[0][3]).toEqual({ delayMs: 10 * 60_000 })
    expect(state(conn)._lastUpgradeAttempt).toBeNull()
    expect(state(conn)._updateFailure).toBeNull()
    expect(destructive(seen)).toEqual([])
  })

  // 2026-11-10 review: a swap held or deferred on the host after its upload changed nothing, but it
  // counted as a forced try; three dark-wake deferrals spent them, and the holds were back with no bound.
  it.each([
    ['deferred', () => new Error('Managed daemon update failed: update deferred: launchd is starting no jobs in this login session now; nothing was changed, and the running daemon keeps serving')],
    ['held', () => Object.assign(new Error("the last daemon update's probation still watches the new daemon on the host"), { name: 'NetUpdateHeldError' })],
    ['failed', () => new Error('Managed daemon update failed: the readiness check timed out')],
  ] as const)('overdue, a swap %s on the host after its upload counts as a forced try only when it ran', async (kind, error) => {
    const { conn } = managedOnOld()
    vi.spyOn(priv(conn), 'noteOverdue').mockImplementation(() => { state(conn)._overdueMs = 1 })
    managedUpdate.mockReset().mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { onStaged?: () => boolean | Promise<boolean> }) => {
      expect(await opts?.onStaged?.()).toBe(true)
      throw error()
    })
    await priv(conn).checkDaemonRunning().catch(() => null)
    expect(managedUpdate).toHaveBeenCalledTimes(1)
    expect(state(conn)._forcedTries).toEqual(kind === 'failed' ? { expected: EXPECTED_VERSION, n: 1 } : null)
  })

  // 2026-11-05 review 6: an update inside the last one's probation took its copies, the only way back
  // from a build that fails late; and each try uploaded the build first.
  it("the last update's probation still at work on the host: nothing uploaded or run, asked again after its end", async () => {
    const { conn, postpone, seen } = managedOnOld(undefined, `${PROBING_WORD} until=1800000600 now=1800000000\n`)
    await expect(priv(conn).checkDaemonRunning()).resolves.toBe(32100)
    expect(managedUpdate).not.toHaveBeenCalled()
    expect(postpone).toHaveBeenCalledTimes(1)
    expect(postpone.mock.calls[0][0]).toMatch(/probation still watches the new daemon/)
    expect(postpone.mock.calls[0][3]).toEqual({ delayMs: 605_000 })
    expect(state(conn)._lastUpgradeAttempt ?? null).toBeNull()
    expect(state(conn)._updateFailure ?? null).toBeNull()
    expect(destructive(seen)).toEqual([])
    // Its end not known (a probation in its last looks): asked again in a minute.
    const late = managedOnOld(undefined, `${PROBING_WORD} until= now=1800000000\n`)
    await expect(priv(late.conn).checkDaemonRunning()).resolves.toBe(32100)
    expect(late.postpone.mock.calls[0][3]).toEqual({ steady: true })
    expect(managedUpdate).not.toHaveBeenCalled()
  })

  it("another update's runner still at work on the host: served as it is, asked again in a minute", async () => {
    const { conn, postpone } = managedOnOld()
    managedUpdate.mockRejectedValue(Object.assign(new Error('another daemon update is still running on the host'), { name: 'NetUpdateHeldError' }))
    await expect(priv(conn).checkDaemonRunning()).resolves.toBe(32100)
    expect(postpone.mock.calls[0][3]).toEqual({ steady: true })
    expect(state(conn)._lastUpgradeAttempt).toBeNull()
    expect(state(conn)._updateFailure).toBeNull()
  })

  it("a failure says why on the host's status, and 'down' while it is away when the record says no daemon runs there", async () => {
    const { conn } = managedOnOld()
    managedUpdate.mockRejectedValue(Object.assign(new Error('the update answered ok, but afterwards on the host: no daemon answered within 90 s, and no earlier service config to go back to'), { tailOutcome: 'down' }))
    await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    state(conn)._connected = false
    expect(conn.daemonUpdateView).toMatchObject({ state: 'down', message: expect.stringContaining('no daemon answered within 90 s') })
    state(conn)._connected = true
    state(conn)._daemonVersion = 'walnut-daemon-old00000'
    expect(conn.daemonUpdateView).toMatchObject({ state: 'failed' })
  })

  // 2026-11-04 review: 'down' outlived the daemon that came back, so every ordinary disconnect
  // afterwards read as the update having left the host with no daemon.
  it("a daemon that answers ends 'down'; the build the update wanted ends the failure", async () => {
    const { conn } = managedOnOld()
    managedUpdate.mockRejectedValue(Object.assign(new Error('the update answered ok, but afterwards on the host: no daemon answered within 90 s'), { tailOutcome: 'down' }))
    await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    const hello = vi.spyOn(priv(conn), '_sendHandshake').mockResolvedValue({ ok: true, capabilities: [], version: 'walnut-daemon-old00000' })
    await priv(conn).verifyCapabilities()
    state(conn)._connected = false
    expect(conn.daemonUpdateView).toBeNull()
    state(conn)._connected = true
    expect(conn.daemonUpdateView).toMatchObject({ state: 'failed' })
    hello.mockResolvedValue({ ok: true, capabilities: [], version: EXPECTED_VERSION })
    await priv(conn).verifyCapabilities()
    expect(state(conn)._updateFailure).toBeNull()
  })

  // 2026-11-04 review: tried again after the 10 min cooldown, each try a stop and a put-back of the host's daemon.
  it('a build that answered ok and did not stay serving is not tried again for a day; any other failure is, after the cooldown', async () => {
    const { conn, postpone } = managedOnOld()
    managedUpdate.mockRejectedValue(Object.assign(new Error('the update answered ok, but afterwards on the host: the previous service config was put back'), { tailOutcome: 'restored', buildFailed: true }))
    await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    expect(managedUpdate).toHaveBeenCalledTimes(1)
    const later = (ms: number) => { state(conn)._lastUpgradeAttempt.at -= ms; if (state(conn)._realDirFail) state(conn)._realDirFail.at -= ms }
    later(11 * 60_000)
    postpone.mockClear()
    await priv(conn).checkDaemonRunning().catch(() => null)
    expect(managedUpdate).toHaveBeenCalledTimes(1)
    // Asked again when its day off ends (2026-11-10 review: nothing asked again while the link stayed up).
    expect(postpone).toHaveBeenCalledTimes(1)
    expect(postpone.mock.calls[0][0]).toContain('asked again when its day off ends')
    const { delayMs } = postpone.mock.calls[0][3] as { delayMs: number }
    expect(delayMs).toBeGreaterThan(23 * 60 * 60_000)
    expect(delayMs).toBeLessThanOrEqual(24 * 60 * 60_000)
    later(24 * 60 * 60_000)
    await priv(conn).checkDaemonRunning().catch(() => null)
    expect(managedUpdate).toHaveBeenCalledTimes(2)
    managedUpdate.mockRejectedValue(new Error('Managed daemon update failed: the readiness check timed out'))
    state(conn)._realDirFail = null
    later(11 * 60_000)
    await priv(conn).checkDaemonRunning().catch(() => null)
    later(11 * 60_000)
    await priv(conn).checkDaemonRunning().catch(() => null)
    expect(managedUpdate).toHaveBeenCalledTimes(4)
  })

  // 2026-11-04 review: the day off lived in memory, so every deploy (a server restart) let the next connect try the build again.
  it('the day off of a build that did not stay serving is kept across a server restart', async () => {
    const file = path.join(os.tmpdir(), `walnut-ssh-backoff-${process.pid}-${Date.now()}.json`)
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    try {
      const { conn } = managedOnOld()
      managedUpdate.mockRejectedValue(Object.assign(new Error('Managed daemon update failed: the daemon never answered as ready'), { buildFailed: true }))
      await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
      await buildBackoffSettled()
      const { conn: restarted } = managedOnOld()
      await priv(restarted).checkDaemonRunning().catch(() => null)
      expect(managedUpdate).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env.WALNUT_BUILD_BACKOFF_FILE
      await fs.rm(file, { force: true })
    }
  })

  // 2026-11-04 review: an update whose answer did not come in time left its record on the host and
  // nobody read it back, so a build that had stopped the daemon was tried again within the hour.
  it('the record an update left after the wait ended is read back on a later check: a build that did not stay is held a day, after a restart too', async () => {
    const stamp = `${process.pid}-${Date.now()}`
    const files = [path.join(os.tmpdir(), `walnut-ssh-late-backoff-${stamp}.json`), path.join(os.tmpdir(), `walnut-ssh-late-unread-${stamp}.json`)]
    process.env.WALNUT_BUILD_BACKOFF_FILE = files[0]
    process.env.WALNUT_UPDATE_UNREAD_FILE = files[1]
    const DIR = '/tmp/open-walnut-update.Late1234ab'
    const record = new Map<string, string>([[`${DIR}/update.sh`, '#!/bin/sh\n']])
    try {
      const { conn } = managedOnOld(record)
      managedUpdate.mockRejectedValue(Object.assign(new Error('the update on the host did not report back within 900 s; it may still finish there'), { keepStaging: true, directory: DIR }))
      await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
      await buildBackoffSettled()
      // The server started again (a deploy) while the runner still works: no second update under it.
      const { conn: restarted, seen, postpone } = managedOnOld(record)
      await expect(priv(restarted).checkDaemonRunning()).resolves.toBe(32100)
      expect(postpone.mock.calls.at(-1)?.[0]).toBe('the previous daemon update is still running on the host')
      expect(managedUpdate).toHaveBeenCalledTimes(1)
      // The runner finished: the new daemon never answered after the old one stopped, and the old one is back.
      record.set(`${DIR}/update.done`, 'rc=1 tries=1 tail=serving\n')
      record.set(`${DIR}/update.out`, JSON.stringify({ ok: false, failure: { code: 'notReady', stopped: true, message: 'the new daemon never answered as ready', rollback: 'the previous daemon was started again' } }))
      record.set(`${DIR}/update.tail`, 'outcome=serving\na daemon answers\n')
      await priv(restarted).checkDaemonRunning().catch(() => null)
      expect(managedUpdate).toHaveBeenCalledTimes(1)
      expect(seen.some((c) => c.includes(`rm -rf '${DIR}'`))).toBe(true)
      expect(state(restarted)._realDirFail).toMatchObject({ expected: EXPECTED_VERSION, reason: expect.stringContaining('never answered as ready') })
      state(restarted)._connected = true
      state(restarted)._daemonVersion = 'walnut-daemon-old00000'
      expect(restarted.daemonUpdateView).toMatchObject({ state: 'failed', message: expect.stringContaining('never answered as ready') })
      await buildBackoffSettled()
      // A further restart reads the day off from disk, and the record is not read again.
      const { conn: third, seen: thirdSeen } = managedOnOld(record)
      await priv(third).checkDaemonRunning().catch(() => null)
      expect(managedUpdate).toHaveBeenCalledTimes(1)
      expect(thirdSeen.some((c) => c.includes(DIR))).toBe(false)
    } finally {
      delete process.env.WALNUT_BUILD_BACKOFF_FILE
      delete process.env.WALNUT_UPDATE_UNREAD_FILE
      for (const f of files) await fs.rm(f, { force: true })
    }
  })

  // 2026-11-04 review 4: the record was kept only once the server's 15 min wait gave up, so a
  // deploy during an update (its server restarted mid-wait) left the next server no hold and no
  // cooldown: it stopped the healthy daemon once more for a build that had just failed.
  it('the record is kept from the launch on: a server restarted during the update reads it back before any new attempt', async () => {
    const stamp = `${process.pid}-${Date.now()}`
    const files = [path.join(os.tmpdir(), `walnut-ssh-launch-backoff-${stamp}.json`), path.join(os.tmpdir(), `walnut-ssh-launch-unread-${stamp}.json`)]
    process.env.WALNUT_BUILD_BACKOFF_FILE = files[0]
    process.env.WALNUT_UPDATE_UNREAD_FILE = files[1]
    const DIR = '/tmp/open-walnut-update.Launch12ab'
    const record = new Map<string, string>([[`${DIR}/update.sh`, '#!/bin/sh\n']])
    try {
      const { conn } = managedOnOld(record)
      // The runner starts on the host, and this server goes away before its answer (a deploy).
      managedUpdate.mockImplementation(async (_source: unknown, _expected: unknown, io: { detached?: { onLaunched?: (d: string) => void } }) => {
        io.detached?.onLaunched?.(DIR)
        return new Promise(() => {})
      })
      void priv(conn).checkDaemonRunning()
      await vi.waitFor(() => expect(managedUpdate).toHaveBeenCalledTimes(1))
      await buildBackoffSettled()
      expect(Object.values(JSON.parse(await fs.readFile(files[1], 'utf8')))).toEqual([expect.objectContaining({ directory: DIR, expected: EXPECTED_VERSION })])
      // The server started again while the runner works: no second update under it.
      const { conn: restarted, seen, postpone } = managedOnOld(record)
      await expect(priv(restarted).checkDaemonRunning()).resolves.toBe(32100)
      expect(postpone.mock.calls.at(-1)?.[0]).toBe('the previous daemon update is still running on the host')
      expect(managedUpdate).toHaveBeenCalledTimes(1)
      // Its runner finished: the new config would not start after the old daemon stopped, and the old one is back.
      record.set(`${DIR}/update.done`, 'rc=1 tries=1 tail=serving\n')
      record.set(`${DIR}/update.out`, JSON.stringify({ ok: false, failure: { code: 'commandFailed', stopped: true, message: 'Job for open-walnut-daemon.service failed', rollback: 'the previous daemon was started again' } }))
      record.set(`${DIR}/update.tail`, 'outcome=serving\na daemon answers\n')
      // The hold is on disk before the host's record goes (2026-11-04 review 5: only asked for).
      let removedFirst: boolean | null = null
      recordStoreWrites({ delayMs: 150, onDisk: (w) => { if (w === 'daemon-build-backoff.json:set') removedFirst = seen.some((c) => c.includes(`rm -rf '${DIR}'`)) } })
      await priv(restarted).checkDaemonRunning().catch(() => null)
      expect(managedUpdate).toHaveBeenCalledTimes(1)
      expect(seen.some((c) => c.includes(`rm -rf '${DIR}'`))).toBe(true)
      await vi.waitFor(() => expect(removedFirst).not.toBeNull())
      expect(removedFirst).toBe(false)
      expect(state(restarted)._realDirFail).toMatchObject({ expected: EXPECTED_VERSION, reason: expect.stringContaining('Job for open-walnut-daemon.service failed') })
      await buildBackoffSettled()
      // The record goes after the hold (its own write comes once the host's dir is removed).
      await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(files[1], 'utf8'))).toEqual({}))
    } finally {
      delete process.env.WALNUT_BUILD_BACKOFF_FILE
      delete process.env.WALNUT_UPDATE_UNREAD_FILE
      for (const f of files) await fs.rm(f, { force: true })
    }
  })

  it('an update answered in time leaves no record behind, and its build\'s hold is on disk before the record goes', async () => {
    const stamp = `${process.pid}-${Date.now()}`
    const file = path.join(os.tmpdir(), `walnut-ssh-answered-unread-${stamp}.json`)
    process.env.WALNUT_UPDATE_UNREAD_FILE = file
    try {
      const { conn } = managedOnOld()
      const writes = recordStoreWrites()
      let during = ''
      managedUpdate.mockImplementation(async (_s: unknown, _e: unknown, io: { detached?: { onLaunched?: (d: string) => void } }) => {
        io.detached?.onLaunched?.('/tmp/open-walnut-update.Answer12ab')
        await buildBackoffSettled()
        during = await fs.readFile(file, 'utf8')
        throw Object.assign(new Error('Managed daemon update failed: the daemon never answered as ready'), { buildFailed: true })
      })
      await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
      expect(during).toContain('/tmp/open-walnut-update.Answer12ab')
      await buildBackoffSettled()
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({})
      // 2026-11-04 review 5: the record went first, so a server killed in between kept neither.
      expect(holdAndRecord(writes)).toEqual(['daemon-update-unread.json:set', 'daemon-build-backoff.json:set', 'daemon-update-unread.json:clear'])
    } finally {
      delete process.env.WALNUT_UPDATE_UNREAD_FILE
      await fs.rm(file, { force: true })
    }
  })

  it('a failure the host recovered from reads as failed only while connected', async () => {
    const { conn } = managedOnOld()
    managedUpdate.mockRejectedValue(Object.assign(new Error('the update answered ok, but afterwards on the host: the previous service config was put back'), { tailOutcome: 'restored' }))
    await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    state(conn)._connected = false
    expect(conn.daemonUpdateView).toBeNull()
  })
})

describe('DaemonConnection — managed host with a live daemon', () => {
  afterEach(() => { vi.restoreAllMocks() })

  const managedProbe = () => probeReply({ present: ['/tmp/open-walnut/daemon.service'] })

  it.each([false, true])('routes a user service update through the transaction without unmanaged stop or spawn (failure=%s)', async (fails) => {
    managedUpdate.mockReset()
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
    vi.spyOn(priv(conn), 'getLocalBinaryPath').mockResolvedValue('/fixture/daemon')
    const routes = { probe: probeReply({ present: ['$HOME/.config/systemd/user/open-walnut-daemon.service'] }), status: RUNNING_STATUS, version: 'old-version' }
    const seen = stubSsh(conn, routes)
    const stop = vi.spyOn(priv(conn), 'stopUnmanagedDaemon').mockResolvedValue(undefined)
    const start = vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(1234)
    managedUpdate.mockImplementation(async () => {
      if (fails) throw new Error('update busy')
      routes.status = JSON.stringify({ running: true, pid: 4343, port: 32200 })
      routes.version = EXPECTED_VERSION
    })
    if (fails) await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    else await expect(priv(conn).checkDaemonRunning()).resolves.toBe(32200)
    expect(managedUpdate).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(destructive(seen)).toEqual([])
  })

  it('a version-skewed managed daemon is reused, never stopped, and logged loudly', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
    const seen = stubSsh(conn, { probe: managedProbe(), status: RUNNING_STATUS, version: 'walnut-daemon-old00000' })
    const errorLog = vi.spyOn(log.session, 'error').mockImplementation(() => {})

    await expect(priv(conn).checkDaemonRunning()).resolves.toBe(32100)
    expect(destructive(seen)).toEqual([])
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(String(errorLog.mock.calls[0][0])).toContain('walnut daemon install --yes --executable')
    // A service Walnut SAW is a verdict, not a postponement: no clock re-asks it.
    expect(state(conn).upgradeRecheckTimer).toBeNull()
  })

  it('a matching version logs nothing and still refuses to upgrade itself', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
    const seen = stubSsh(conn, { probe: managedProbe(), status: RUNNING_STATUS, version: EXPECTED_VERSION })
    const errorLog = vi.spyOn(log.session, 'error').mockImplementation(() => {})

    await expect(priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(destructive(seen)).toEqual([])
    expect(errorLog).toHaveBeenCalledTimes(0)
  })

  it.each(['checkDaemonRunning', 'forceRedeployAndReconnect'])('starts nothing when the old daemon has not finished draining: %s', async (method) => {
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
    const seen = stubSsh(conn, { probe: probeReply(), status: RUNNING_STATUS, version: 'walnut-daemon-old00000', stopPending: true })
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue('node')
    const start = vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(1234)
    await expect(priv(conn)[method]()).rejects.toThrow('shutdown was not confirmed')
    // The new daemon went onto the host beside the old one (before the stop), and nothing more.
    expect(deploy).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
    expect(seen.some((cmd) => /rm -f \/tmp\/open-walnut\/daemon\./.test(cmd))).toBe(false)
  })

  it('an UNMANAGED skewed daemon is still stopped for upgrade (path intact)', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
    const seen = stubSsh(conn, { probe: probeReply(), status: RUNNING_STATUS, version: 'walnut-daemon-old00000' })

    await expect(priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(destructive(seen).length).toBeGreaterThan(0)
  })
})

describe('DaemonConnection — capability drift on a managed host', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('forceRedeployAndReconnect() refuses BEFORE tearing down WS/tunnel', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    const seen = stubSsh(conn, { probe: probeReply({ present: ['/tmp/open-walnut/daemon.service'] }) })
    const teardown = vi.spyOn(priv(conn), 'closeBulkChannel')
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue('node')
    const start = vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(1234)

    await expect(priv(conn).forceRedeployAndReconnect()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    expect(teardown).toHaveBeenCalledTimes(0)
    expect(deploy).toHaveBeenCalledTimes(0)
    expect(start).toHaveBeenCalledTimes(0)
    expect(destructive(seen)).toEqual([])
  })

  it('reads the startup posture from the actual hello envelope', async () => {
    const { REQUIRED_DAEMON_CAPABILITIES } = await import('../../src/providers/daemon-capabilities.js')
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), '_sendHandshake').mockResolvedValue({ ok: true, capabilities: [...REQUIRED_DAEMON_CAPABILITIES], cronSupervision: { managed: true, startup: 'service' } })
    expect(await priv(conn).verifyCapabilities()).toBe(true)
    expect(conn.daemonStartup).toBe('service')
  })

  it('an unmanaged host still redeploys on drift', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    stubSsh(conn, { probe: probeReply() })
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue('node')
    vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(1234)
    vi.spyOn(priv(conn), 'createTunnel').mockResolvedValue(5555)
    vi.spyOn(priv(conn), 'connectWebSocket').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'verifyCapabilities').mockResolvedValue(true)

    await expect(priv(conn).forceRedeployAndReconnect()).resolves.toBeUndefined()
    expect(deploy).toHaveBeenCalledTimes(1)

    conn.disconnect()
  })
})

describe('DaemonConnection — a service probe with no answer is not a verdict', () => {
  // 2026-10-01: a 5s probe timed out under load, read as "runs as an OS service",
  // and the deploy's daemon update for that host was dropped until some later
  // reconnect (hosts with no service at all also failed reconnects with that claim).
  let conn: DaemonConnection | null = null
  afterEach(() => {
    if (conn) { state(conn)._connected = false; conn.disconnect(); conn = null }
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const noAnswer = () => { throw new Error('Command failed: ssh -o ControlMaster=auto\nssh: connect to host devbox port 22: Operation timed out') }
  const skewed = () => {
    conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
    return conn
  }
  // Every postpone, in order: the first of a hold is a warning, the same hold asked again is at info.
  const postponed = (warn: { mock: { calls: unknown[][]; invocationCallOrder: number[] } }) => {
    const info = vi.isMockFunction(log.session.info) ? vi.mocked(log.session.info).mock : { calls: [], invocationCallOrder: [] }
    return [warn.mock, info]
      .flatMap((m) => m.calls.map((c, i) => ({ c: c as unknown[], at: m.invocationCallOrder[i] })))
      .filter(({ c }) => c[0] === 'DaemonConnection: daemon update postponed; checking again')
      .sort((a, b) => a.at - b.at)
      .map(({ c }) => c[1] as { reason: string; retryInMs: number; attempt: number })
  }
  beforeEach(() => { vi.spyOn(log.session, 'info').mockImplementation(() => {}) })

  it('asks once more with a longer deadline and uses that answer', async () => {
    conn = new DaemonConnection('devbox', TARGET)
    const deadlines: number[] = []
    stubSsh(conn, { probe: (ms) => { deadlines.push(ms); if (deadlines.length === 1) noAnswer(); return probeReply() } })
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})

    await expect(priv(conn).checkDaemonRunning()).resolves.toBeNull()
    expect(deadlines).toEqual(SERVICE_PROBE_TIMEOUTS_MS)
    expect(warn.mock.calls.filter((c) => c[0] === 'DaemonConnection: OS-service probe got no answer')).toHaveLength(1)
  })

  it('a live daemon is reused as it is: nothing stopped, no service claimed, the update asked again later', async () => {
    const c = skewed()
    const seen = stubSsh(c, { probe: noAnswer, status: RUNNING_STATUS, version: 'walnut-daemon-old00000' })
    const errorLog = vi.spyOn(log.session, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})

    await expect(priv(c).checkDaemonRunning()).resolves.toBe(32100)
    expect(destructive(seen)).toEqual([])
    expect(errorLog).not.toHaveBeenCalled()
    expect(postponed(warn)).toEqual([expect.objectContaining({
      reason: 'could not check the OS-service state (ssh: connect to host devbox port 22: Operation timed out)',
      retryInMs: UPGRADE_RECHECK_DELAYS_MS[0],
    })])
    expect(state(c).upgradeRecheckTimer).not.toBeNull()
    c.disconnect()
    expect(state(c).upgradeRecheckTimer).toBeNull()
  })

  it('a current daemon needs no second look', async () => {
    const c = skewed()
    stubSsh(c, { probe: noAnswer, status: RUNNING_STATUS, version: EXPECTED_VERSION })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})

    await expect(priv(c).checkDaemonRunning()).resolves.toBe(32100)
    expect(state(c).upgradeRecheckTimer).toBeNull()
  })

  it.each([
    ['ssh gave no answer', noAnswer, 'Operation timed out'],
    ['the reply was cut short', () => probeReply({ truncated: true }), 'the probe reply was cut short'],
  ])('no daemon and no answer (%s): refuses to start one, claims no service, and stays retryable', async (_label, probe, reason) => {
    conn = new DaemonConnection('devbox', TARGET)
    stubSsh(conn, { probe })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})

    for (const strict of [false, true]) {
      const error = await (priv(conn).checkDaemonRunning({ strict }) as Promise<unknown>).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DaemonServiceProbeError)
      expect(error).not.toBeInstanceOf(DaemonServiceNotReadyError)
      expect((error as Error).message).toContain("could not check whether 'devbox' runs its session daemon as an OS service")
      expect((error as Error).message).toContain(reason)
      expect((error as Error).message).not.toContain('walnut daemon')
    }
  })

  it.each(['connect', 'reconnect'])('%s() deploys nothing while the probe has no answer', async (entry) => {
    conn = new DaemonConnection('devbox', TARGET)
    const seen = stubSsh(conn, { probe: noAnswer })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(priv(conn), 'stopControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'ensureControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'resolveRemoteDir').mockResolvedValue(undefined)
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue('node')
    const start = vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(1234)

    const run = entry === 'connect' ? conn.connect() : priv(conn).reconnect() as Promise<void>
    await expect(run).rejects.toBeInstanceOf(DaemonServiceProbeError)
    expect(deploy).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(destructive(seen)).toEqual([])
  })

  it('capability drift does not replace a daemon nobody could classify, and the connection stays up', async () => {
    conn = new DaemonConnection('devbox', TARGET)
    const seen = stubSsh(conn, { probe: noAnswer })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const teardown = vi.spyOn(priv(conn), 'closeBulkChannel')
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue('node')

    await expect(priv(conn).forceRedeployAndReconnect()).rejects.toBeInstanceOf(DaemonServiceProbeError)
    expect(teardown).not.toHaveBeenCalled()
    expect(deploy).not.toHaveBeenCalled()
    expect(destructive(seen)).toEqual([])
  })

  it('the stop uses the answer it just read: one probe per decision, not a second chance to get none', async () => {
    const c = skewed()
    let probes = 0
    const seen = stubSsh(c, { probe: () => { probes++; return probeReply() }, status: RUNNING_STATUS, version: 'walnut-daemon-old00000' })

    await expect(priv(c).checkDaemonRunning()).resolves.toBeNull()
    expect(probes).toBe(1)
    expect(destructive(seen).length).toBeGreaterThan(0)
  })

  it('a link that is down reads as the ssh error in strict mode, and still deploys nothing', async () => {
    conn = new DaemonConnection('devbox', TARGET)
    const sshDown = () => { throw new Error('ssh: Could not resolve hostname devbox: nodename nor servname provided') }
    stubSsh(conn, { probe: noAnswer, status: sshDown, files: sshDown })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})

    await expect(priv(conn).checkDaemonRunning({ strict: true })).rejects.toThrow('Could not resolve hostname')
    await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceProbeError)
  })

  it('a determined answer ends a pending re-check', async () => {
    const c = skewed()
    const routes: SshRoutes = { probe: noAnswer, status: RUNNING_STATUS, version: 'walnut-daemon-old00000' }
    stubSsh(c, routes)
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(log.session, 'error').mockImplementation(() => {})

    await priv(c).checkDaemonRunning()
    expect(state(c).upgradeRecheckTimer).not.toBeNull()
    routes.probe = probeReply({ present: ['/etc/systemd/system/open-walnut-daemon.service'] })
    await priv(c).checkDaemonRunning()
    expect(state(c).upgradeRecheckTimer).toBeNull()
    expect(state(c)._upgradeRecheckAttempt).toBe(0)
  })

  it('a version read that fails is asked again too', async () => {
    const c = skewed()
    stubSsh(c, { probe: probeReply(), status: RUNNING_STATUS, version: () => { throw new Error('ssh: Connection reset by peer') } })
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})

    await expect(priv(c).checkDaemonRunning()).resolves.toBe(32100)
    expect(postponed(warn).map((p) => p.reason)).toEqual(['the version check did not finish (ssh: Connection reset by peer)'])
  })

  it('the re-check goes ahead on the live connection once the probe answers', async () => {
    vi.useFakeTimers()
    const c = skewed()
    const routes: SshRoutes = { probe: noAnswer, status: RUNNING_STATUS, version: 'walnut-daemon-old00000' }
    const seen = stubSsh(c, routes)
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => {})

    await expect(priv(c).checkDaemonRunning()).resolves.toBe(32100)
    state(c)._connected = true
    routes.probe = probeReply()
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])

    expect(destructive(seen).length).toBeGreaterThan(0)
    expect(lost).toHaveBeenCalledTimes(1)
    expect(state(c).upgradeRecheckTimer).toBeNull()
  })

  it('backs off while there is still no answer, and stops when the daemon turns out current or the connection closes', async () => {
    vi.useFakeTimers()
    const c = skewed()
    const routes: SshRoutes = { probe: noAnswer, status: RUNNING_STATUS, version: 'walnut-daemon-old00000' }
    const seen = stubSsh(c, routes)
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => {})

    await priv(c).checkDaemonRunning()
    state(c)._connected = true
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[1])
    expect(postponed(warn).map((p) => p.retryInMs)).toEqual(UPGRADE_RECHECK_DELAYS_MS.slice(0, 3))

    // A connection that is down has the reconnect to decide: the clock does nothing.
    state(c)._connected = false
    const before = seen.length
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[2])
    expect(seen.length).toBe(before)
    expect(state(c).upgradeRecheckTimer).toBeNull()

    // Someone else updated it meanwhile: the next decision clears the backoff.
    state(c)._connected = true
    routes.version = EXPECTED_VERSION
    await priv(c).checkDaemonRunning()
    expect(state(c).upgradeRecheckTimer).toBeNull()
    expect(state(c)._upgradeRecheckAttempt).toBe(0)
    expect(lost).not.toHaveBeenCalled()
    expect(destructive(seen)).toEqual([])
  })

  it('an update put off for open ACP turns goes ahead once they close', async () => {
    vi.useFakeTimers()
    const c = skewed()
    const routes: SshRoutes = {
      probe: probeReply(), status: RUNNING_STATUS, version: 'walnut-daemon-old00000',
      busy: JSON.stringify({ busySids: ['acp-1'], updatedAt: Date.now() }),
    }
    const seen = stubSsh(c, routes)
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => {})

    await expect(priv(c).checkDaemonRunning()).resolves.toBe(32100)
    expect(destructive(seen)).toEqual([])
    expect(postponed(warn).map((p) => p.reason)).toEqual(['ACP turns are open'])

    state(c)._connected = true
    routes.busy = JSON.stringify({ busySids: ['acp-1'], updatedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])
    expect(destructive(seen)).toEqual([])
    expect(lost).not.toHaveBeenCalled()

    routes.busy = ''
    // Open turns end on their own: asked again every minute, no backoff.
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])
    expect(postponed(warn).map((p) => p.retryInMs)).toEqual([UPGRADE_RECHECK_DELAYS_MS[0], UPGRADE_RECHECK_DELAYS_MS[0]])
    expect(destructive(seen).length).toBeGreaterThan(0)
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('overdue, open ACP turns no longer hold the update (daemon-update-behind.ts)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-overdue-'))
    setAcpUpgradeHoldFileForTest(path.join(dir, 'holds.json'))
    try {
      const c = skewed()
      const routes: SshRoutes = {
        probe: probeReply(), status: RUNNING_STATUS, version: 'walnut-daemon-old00000',
        busy: JSON.stringify({ busySids: ['acp-1'], updatedAt: Date.now() }),
      }
      const seen = stubSsh(c, routes)
      const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
      vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => {})
      const now = Date.now()
      for (let t = now - DAEMON_UPDATE_BEHIND_MAX_MS - 60_000; t < now; t += 30 * 60_000) daemonUpdateOverdue('devbox', 'walnut-daemon-old00000', true, t)
      await priv(c).checkDaemonRunning()
      expect(postponed(warn).map((p) => p.reason)).not.toContain('ACP turns are open')
      expect(destructive(seen).length).toBeGreaterThan(0)
    } finally {
      setAcpUpgradeHoldFileForTest(null)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a re-check whose connection dropped meanwhile stops nothing and leaves the decision to the reconnect', async () => {
    vi.useFakeTimers()
    const c = skewed()
    const routes: SshRoutes = { probe: noAnswer, status: RUNNING_STATUS, version: 'walnut-daemon-old00000' }
    const seen = stubSsh(c, routes)
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => {})

    await priv(c).checkDaemonRunning()
    state(c)._connected = true
    // The connection drops (a new epoch) while the re-check reads the version.
    routes.probe = probeReply()
    routes.version = () => { state(c)._connected = false; state(c)._connectionEpoch = Number(state(c)._connectionEpoch) + 1; return 'walnut-daemon-old00000' }
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])

    expect(destructive(seen)).toEqual([])
    expect(lost).not.toHaveBeenCalled()
    expect(postponed(warn)).toHaveLength(1)
    expect(state(c).upgradeRecheckTimer).toBeNull()
  })

  it('daemon commands in flight hold the stop, and it is asked again in a minute', async () => {
    vi.useFakeTimers()
    const c = skewed()
    const routes: SshRoutes = { probe: noAnswer, status: RUNNING_STATUS, version: 'walnut-daemon-old00000' }
    const seen = stubSsh(c, routes)
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => {})

    await priv(c).checkDaemonRunning()
    state(c)._connected = true
    routes.probe = probeReply()
    const pending = state(c).pendingCommands as Map<number, unknown>
    pending.set(1, { cmd: 'sendRaw' })
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])
    expect(destructive(seen)).toEqual([])
    expect(postponed(warn).at(-1)).toEqual(expect.objectContaining({
      reason: '1 daemon command(s) that change a session or a file are in flight', retryInMs: UPGRADE_RECHECK_DELAYS_MS[0],
    }))

    pending.clear()
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])
    expect(destructive(seen).length).toBeGreaterThan(0)
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('a verdict for one runtime dir never licenses a stop in another', async () => {
    const c = skewed()
    const dirs: string[] = []
    const seen = stubSsh(c, {
      probe: () => { const dir = String(state(c)._remoteDir); dirs.push(dir); return probeReply({ dir }) },
      status: RUNNING_STATUS, version: 'walnut-daemon-old00000',
    })
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    // The live daemon was adopted from the other production dir after the probe.
    vi.spyOn(priv(c), 'getRemoteDaemonPath').mockImplementation(async () => {
      state(c)._remoteDir = '/home/tester/.open-walnut/run'
      return '/home/tester/.open-walnut/run/daemon-linux-x64'
    })

    await priv(c).checkDaemonRunning()
    expect(dirs).toEqual(['/tmp/open-walnut', '/home/tester/.open-walnut/run'])
    expect(destructive(seen).length).toBeGreaterThan(0)
  })

  it('a runtime marker in the adopted dir refuses the stop', async () => {
    const c = skewed()
    const seen = stubSsh(c, {
      probe: () => {
        const dir = String(state(c)._remoteDir)
        return dir === '/tmp/open-walnut' ? probeReply() : probeReply({ dir, present: [`${dir}/daemon.service`] })
      },
      status: RUNNING_STATUS, version: 'walnut-daemon-old00000',
    })
    vi.spyOn(priv(c), 'getRemoteDaemonPath').mockImplementation(async () => {
      state(c)._remoteDir = '/home/tester/.open-walnut/run'
      return '/home/tester/.open-walnut/run/daemon-linux-x64'
    })

    await expect(priv(c).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceNotReadyError)
    expect(destructive(seen)).toEqual([])
  })

  it('a re-check that fires while a connect is still dialling asks again a minute later', async () => {
    vi.useFakeTimers()
    const c = skewed()
    const routes: SshRoutes = { probe: noAnswer, status: RUNNING_STATUS, version: 'walnut-daemon-old00000' }
    const seen = stubSsh(c, routes)
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => {})

    await priv(c).checkDaemonRunning()
    state(c)._connecting = true
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])
    expect(postponed(warn).at(-1)).toEqual(expect.objectContaining({ reason: 'a connect was in progress', retryInMs: UPGRADE_RECHECK_DELAYS_MS[0] }))
    expect(destructive(seen)).toEqual([])

    state(c)._connecting = false
    state(c)._connected = true
    routes.probe = probeReply()
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])
    expect(destructive(seen).length).toBeGreaterThan(0)
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('pings and reads in flight do not hold the stop; a stop the daemon refused is asked again', async () => {
    vi.useFakeTimers()
    const c = skewed()
    const routes: SshRoutes = { probe: noAnswer, status: RUNNING_STATUS, version: 'walnut-daemon-old00000', stopPending: true }
    stubSsh(c, routes)
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => {})

    await priv(c).checkDaemonRunning()
    state(c)._connected = true
    routes.probe = probeReply()
    const pending = state(c).pendingCommands as Map<number, unknown>
    pending.set(1, { cmd: 'ping' })
    pending.set(2, { cmd: 'fs.read' })
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])
    expect(warn.mock.calls.some((c) => c[0] === 'DaemonConnection: postponed daemon update check failed')).toBe(true)
    expect(postponed(warn).at(-1)?.reason).toMatch(/^the check failed \(Daemon shutdown was not confirmed/)
    expect(lost).not.toHaveBeenCalled()

    routes.stopPending = false
    pending.set(3, { cmd: 'send' })
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[1])
    expect(postponed(warn).at(-1)?.reason).toBe('1 daemon command(s) that change a session or a file are in flight')
    pending.clear()
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('a reconnect waits for a re-check that is still stopping the daemon, then deploys the new build', async () => {
    vi.useFakeTimers()
    const c = skewed()
    let release!: () => void
    const routes: SshRoutes = {
      probe: noAnswer, status: RUNNING_STATUS, version: 'walnut-daemon-old00000',
      stopGate: new Promise<void>((r) => { release = r }),
    }
    stubSsh(c, routes)
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    // The reconnect's first SSH step: it must not touch the master under the stop.
    const master = vi.spyOn(priv(c), 'ensureControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(c), 'resolveRemoteDir').mockResolvedValue(undefined)
    const deployAndStart = vi.spyOn(priv(c), 'deployAndStart').mockResolvedValue(32200)
    vi.spyOn(priv(c), 'createTunnel').mockResolvedValue(5555)
    vi.spyOn(priv(c), 'connectWebSocket').mockResolvedValue(undefined)
    vi.spyOn(priv(c), 'verifyCapabilities').mockResolvedValue(true)
    vi.spyOn(priv(c), 'startPing').mockImplementation(() => {})
    vi.spyOn(priv(c), 'recoverDisconnectedSessions').mockResolvedValue(undefined)

    await priv(c).checkDaemonRunning()
    state(c)._connected = true
    routes.probe = probeReply()
    await vi.advanceTimersByTimeAsync(UPGRADE_RECHECK_DELAYS_MS[0])
    expect(state(c)._upgradeRecheckInFlight).not.toBeNull()

    // The stop drops the socket; the reconnect starts while the stop still confirms.
    state(c)._connected = false
    state(c)._connectionEpoch = Number(state(c)._connectionEpoch) + 1
    routes.status = ''
    // And the probe has no answer again: the reconnect must still deploy, not leave the host dark.
    routes.probe = noAnswer
    const reconnecting = priv(c).reconnect() as Promise<void>
    await vi.advanceTimersByTimeAsync(0)
    expect(master).not.toHaveBeenCalled()

    release()
    await reconnecting
    expect(master).toHaveBeenCalledTimes(1)
    expect(deployAndStart).toHaveBeenCalledTimes(1)

    // It stood in for an answer once: the next reconnect needs a real one.
    await expect(priv(c).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceProbeError)
  })

  it('our own stop stands in for an answer only for two minutes', async () => {
    vi.useFakeTimers()
    conn = new DaemonConnection('devbox', TARGET)
    stubSsh(conn, { probe: noAnswer })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(log.session, 'info').mockImplementation(() => {})

    state(conn)._stoppedUnmanaged = { at: Date.now(), dir: '/tmp/open-walnut' }
    vi.advanceTimersByTime(2 * 60_000 + 1)
    await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceProbeError)
    state(conn)._stoppedUnmanaged = { at: Date.now(), dir: '/home/tester/.open-walnut/run' }
    await expect(priv(conn).checkDaemonRunning()).rejects.toBeInstanceOf(DaemonServiceProbeError)
    state(conn)._stoppedUnmanaged = { at: Date.now(), dir: '/tmp/open-walnut' }
    await expect(priv(conn).checkDaemonRunning()).resolves.toBeNull()
  })
})
