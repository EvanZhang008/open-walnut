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

/** Probe reply for the real path list, with chosen paths present/unknown. */
function probeReply(opts: { present?: string[]; unknown?: string[]; truncated?: boolean } = {}): string {
  const lines = remoteServiceProbePaths().map((p) => {
    if (opts.present?.includes(p)) return `present ${p}`
    if (opts.unknown?.includes(p)) return `unknown ${p}`
    return `absent ${p}`
  })
  if (!opts.truncated) lines.push('walnut-service-probe-done')
  return lines.join('\n')
}

interface SshRoutes {
  probe: string
  /** `<binary> --status` reply. Empty = no daemon. */
  status?: string
  /** pid/port file probe reply. Empty = no daemon. */
  files?: string
  /** /tmp/open-walnut/daemon.version contents. */
  version?: string
  stopPending?: boolean
}

/** Stub every SSH round trip; returns the list of commands actually issued. */
function stubSsh(conn: DaemonConnection, routes: SshRoutes): string[] {
  const seen: string[] = []
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    if (cmd.includes('walnut-service-probe-done')) return routes.probe
    if (cmd.includes('walnut-daemon-stop-confirmed')) {
      if (routes.stopPending) throw new Error('shutdown pending')
      return 'walnut-daemon-stop-confirmed\n'
    }
    if (cmd.includes('uname -m')) return 'x86_64'
    if (cmd.includes('--status')) return routes.status ?? ''
    if (cmd.includes('kill -0')) return routes.files ?? ''
    if (cmd.includes('daemon.version')) return routes.version ?? ''
    return ''
  })
  return seen
}

const destructive = (seen: string[]) => seen.filter((c) => c.includes('--stop') || /\bkill\b/.test(c))

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

  it('a reply without the sentinel is unknown everywhere (truncation ≠ absence)', () => {
    const takeover = parseRemoteServiceProbe(probeReply({ truncated: true }), remoteServiceProbePaths())
    expect(takeover.managed).toBe(true)
    expect(takeover.unknown).toEqual(remoteServiceProbePaths())
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
