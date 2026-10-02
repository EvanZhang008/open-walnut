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

import { describe, it, expect, vi, afterEach } from 'vitest'

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
} from '../../src/providers/daemon-connection.js'
import { log } from '../../src/logging/index.js'
import type { SshTarget } from '../../src/providers/session-io.js'

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
}

const answer = (route: string | (() => string) | undefined) => typeof route === 'function' ? route() : route ?? ''

/** Stub every SSH round trip; returns the list of commands actually issued. */
function stubSsh(conn: DaemonConnection, routes: SshRoutes): string[] {
  const seen: string[] = []
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
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

// `kill -0` is the read-only liveness probe; any other kill, or a --stop, ends a daemon.
const destructive = (seen: string[]) => seen.filter((c) => c.includes('--stop') || /\bkill\b(?! -0\b)/.test(c))

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
      '$HOME/Library/LaunchAgents/dev.openwalnut.session-daemon.plist',
    ])
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
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue(undefined)
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
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue(undefined)
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

  it.each(['checkDaemonRunning', 'forceRedeployAndReconnect'])('does not deploy when the old daemon has not finished draining: %s', async (method) => {
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
    const seen = stubSsh(conn, { probe: probeReply(), status: RUNNING_STATUS, version: 'walnut-daemon-old00000', stopPending: true })
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue(undefined)
    const start = vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(1234)
    await expect(priv(conn)[method]()).rejects.toThrow('shutdown was not confirmed')
    expect(deploy).not.toHaveBeenCalled()
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
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue(undefined)
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
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue(undefined)
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
  const postponed = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls
    .filter((c) => c[0] === 'DaemonConnection: daemon update postponed; checking again')
    .map((c) => c[1] as { reason: string; retryInMs: number; attempt: number })

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
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue(undefined)
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
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue(undefined)

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
    const stopMaster = vi.spyOn(priv(c), 'stopControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(c), 'ensureControlMaster').mockResolvedValue(undefined)
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
    expect(stopMaster).not.toHaveBeenCalled()

    release()
    await reconnecting
    expect(stopMaster).toHaveBeenCalledTimes(1)
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
