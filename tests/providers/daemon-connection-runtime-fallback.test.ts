/**
 * First-connect hardening in DaemonConnection: a start failure that says the daemon file
 * cannot RUN on the host (a CPU, a glibc) is one clear error with the reason remembered (the
 * file is not sent again for a while), and a relocated daemon dir reaches every command that
 * names it.
 *
 * All SSH is stubbed at sshExec (routes below answer the way the real scripts do);
 * deployBinary / getLocalBinaryPath are stubbed too, so no process, socket, upload or
 * tunnel is created.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { DaemonConnection, remoteServiceProbePaths, SshLoginRefusedError } from '../../src/providers/daemon-connection.js'
import { RemoteCommandError } from '../../src/providers/remote-sh.js'
import { classifyHostConnectError } from '../../src/core/sessions/host-connect-hint.js'

type Priv = Record<string, (...args: unknown[]) => unknown>
const priv = (conn: DaemonConnection) => conn as unknown as Priv

const STARTED = '32100\n{"running":true}'
/** A complete "no OS service here" answer for either daemon dir. */
const NO_SERVICE = [...new Set([...remoteServiceProbePaths('/tmp/open-walnut'), ...remoteServiceProbePaths('/home/me/.cache/open-walnut')])]
  .map((p) => `absent ${p}`).concat('walnut-service-probe-done').join('\n')

interface Routes {
  dirProbe?: string | Error
  /** Reply to the live-daemon scan of both production dirs. */
  liveScan?: string
  /** Start command reply; an Error is thrown. */
  start?: string | Error
  /** daemon-start.log contents. */
  startLog?: string
}

function setup(routes: Routes) {
  const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test', user: 'me' })
  const seen: string[] = []
  const starts: string[] = []
  const deploys: string[] = []
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    if (cmd.includes('walnut-dir-probe v1')) {
      if (routes.dirProbe instanceof Error) throw routes.dirProbe
      return routes.dirProbe ?? ''
    }
    if (cmd.includes('walnut-live none')) return routes.liveScan ?? 'walnut-live none'
    if (cmd.includes('walnut-service-probe-done')) return NO_SERVICE
    if (cmd.includes('nohup ')) {
      starts.push(cmd)
      const reply = routes.start ?? ''
      if (reply instanceof Error) throw reply
      return reply
    }
    if (cmd.includes('daemon-start.log')) return routes.startLog ?? ''
    if (cmd.includes('uname -m')) return 'x86_64'
    return ''
  })
  vi.spyOn(priv(conn), 'deployBinary').mockImplementation(async () => { deploys.push('binary') })
  vi.spyOn(priv(conn), 'getLocalBinaryPath').mockImplementation(async () => '/fake/dist/daemon-linux-x64')
  vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(null)
  return { conn, seen, starts, deploys }
}

afterEach(() => { vi.restoreAllMocks() })

const fileFailed = (conn: DaemonConnection) => (conn as unknown as { _fileFailed: { reason: string; at: number } | null })._fileFailed

describe('a daemon file that cannot run on the host', () => {
  it('SIGILL at start: one clear error, one start, the reason remembered, and the file is not sent again', async () => {
    const { conn, starts, deploys } = setup({ start: '', startLog: 'walnut-daemon-exit=132' })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/cannot run on devbox.*walnut-daemon-exit=132/)
    expect(starts).toHaveLength(1)
    expect(deploys).toEqual(['binary'])
    expect(fileFailed(conn)?.reason).toContain('walnut-daemon-exit=132')
    deploys.length = 0
    starts.length = 0
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/does not run on devbox, so it is not sent again/)
    expect(deploys).toEqual([])
    expect(starts).toEqual([])
  })

  it('a loader error (an old glibc) is the same: the host cannot run the file', async () => {
    const { conn, starts } = setup({ start: '', startLog: "daemon: /lib64/libc.so.6: version `GLIBC_2.28' not found" })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/GLIBC_2.28/)
    expect(starts).toHaveLength(1)
    expect(fileFailed(conn)).not.toBeNull()
  })

  it('a start failure that is not about the file does not remember anything', async () => {
    const { conn, starts } = setup({ start: '', startLog: 'Error: listen EADDRINUSE: address already in use' })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/EADDRINUSE/)
    expect(starts).toHaveLength(1)
    expect(fileFailed(conn)).toBeNull()
  })

  it('a start that exits non-zero still reads the start log (the death is recorded there)', async () => {
    const { conn, starts } = setup({
      start: new RemoteCommandError('Command failed: ssh me@devbox sh -s\ncat: /tmp/open-walnut/daemon.port: No such file or directory', { code: 1, stdout: '', stderr: '', timedOut: false }),
      startLog: 'walnut-daemon-exit=132',
    })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/cannot run on devbox/)
    expect(starts).toHaveLength(1)
  })
})

describe('daemon dir fallback threads through the connect', () => {
  const FALLBACK_PROBE = [
    'walnut-dir-probe v1', 'arch=x86_64', 'home=/home/me',
    'tmp_path=/tmp/open-walnut', 'tmp_live=0', 'tmp=read-only', 'tmp_free_mb=9000',
    'cache_path=/home/me/.cache/open-walnut', 'cache_live=0', 'cache=ok', 'cache_free_mb=150',
    'walnut-dir-probe-done',
  ].join('\n')

  it('a read-only /tmp moves the daemon to ~/.cache: start env, paths, status probes, stop all follow', async () => {
    const routes: Routes = { dirProbe: FALLBACK_PROBE, start: STARTED }
    const { conn, seen, starts } = setup(routes)
    await priv(conn).resolveRemoteDir()
    expect(conn.remoteDirChoice).toEqual({ path: '/home/me/.cache/open-walnut', fallback: true, reason: '/tmp is read-only', freeMb: 150 })
    expect(conn.remoteHome).toBe('/home/me')
    await priv(conn).deployAndStart()
    const start = starts[0]
    expect(start).toContain("WALNUT_DAEMON_DIR='/home/me/.cache/open-walnut'")
    expect(start).toContain("WALNUT_STREAMS_DIR='/home/me/.open-walnut/tmp/streams'")
    expect(start).toContain("'/home/me/.cache/open-walnut/daemon-linux-x64' --start > '/home/me/.cache/open-walnut/daemon-start.log'")
    expect(start).not.toContain('/tmp/open-walnut')

    seen.length = 0
    // The binary's --status is only asked when the file scan cannot answer.
    routes.liveScan = 'sh: the scan did not run'
    await priv(conn).checkDaemonRunning()
    const statusProbe = seen.find((c) => c.includes('--status'))!
    expect(statusProbe).toContain("env WALNUT_DAEMON_DIR='/home/me/.cache/open-walnut'")
    expect(statusProbe).toContain("'/home/me/.cache/open-walnut/daemon-linux-x64' --status")
    // The live-daemon scan looks in the chosen dir FIRST, then the other production dir.
    const scan = seen.find((c) => c.includes('walnut-live none'))!
    expect(scan.indexOf("d='/home/me/.cache/open-walnut'")).toBeLessThan(scan.indexOf("d='/tmp/open-walnut'"))
    expect(seen.some((c) => c.includes('/tmp/open-walnut/daemon'))).toBe(false)

    seen.length = 0
    await priv(conn).stopUnmanagedDaemon().catch(() => {})
    expect(seen.find((c) => c.includes('walnut-daemon-stop-confirmed'))).toContain("'/home/me/.cache/open-walnut/daemon.pid'")
  })

  it('a healthy /tmp keeps the env-free start it always had', async () => {
    const probe = FALLBACK_PROBE.replace('tmp=read-only', 'tmp=ok').replace('cache=ok', 'cache=unchecked')
    const { conn, starts } = setup({ dirProbe: probe, start: STARTED })
    await priv(conn).resolveRemoteDir()
    expect(conn.remoteDirChoice).toMatchObject({ path: '/tmp/open-walnut', fallback: false })
    await priv(conn).deployAndStart()
    expect(starts[0]).not.toContain('WALNUT_DAEMON_DIR')
    expect(starts[0]).toContain("'/tmp/open-walnut/daemon-linux-x64' --start")
  })

  it("ssh's own failure at the probe is the connect error (not a misleading deploy error later)", async () => {
    const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test' })
    const dead = new RemoteCommandError('Command failed: ssh devbox sh -s\nPermission denied (publickey).', { code: 255, stdout: '', stderr: '', timedOut: false })
    vi.spyOn(priv(conn), 'sshExec').mockRejectedValue(dead)
    await expect(priv(conn).resolveRemoteDir()).rejects.toBe(dead)
  })

  it('any other probe failure fails the connect (retryable) instead of defaulting to /tmp', async () => {
    const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test' })
    vi.spyOn(priv(conn), 'sshExec').mockRejectedValue(new Error('probe script exited 2'))
    const err = await (priv(conn).resolveRemoteDir() as Promise<unknown>).catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/daemon dir check on devbox did not finish \(probe script exited 2\)/)
    expect(classifyHostConnectError(err.message, 'devbox.example.test', ['devbox']).retryable).toBe(true)
    expect(conn.remoteDirChoice).toBeNull()
  })

  it('a reply without the probe lines fails too', async () => {
    const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test' })
    vi.spyOn(priv(conn), 'sshExec').mockResolvedValue('Last login: Mon Sep 22 on ttys001\n')
    await expect(priv(conn).resolveRemoteDir()).rejects.toThrow(/answered without its result lines/)
  })
})

describe('never a second daemon beside one that runs from the other dir', () => {
  const TMP_OK_PROBE = [
    'walnut-dir-probe v1', 'arch=x86_64', 'home=/home/me',
    'tmp_path=/tmp/open-walnut', 'tmp_live=0', 'tmp=ok', 'tmp_free_mb=9000',
    'cache_path=/home/me/.cache/open-walnut', 'cache_live=0', 'cache=unchecked',
    'walnut-dir-probe-done',
  ].join('\n')

  function connecting(routes: Routes) {
    const ctx = setup(routes)
    vi.spyOn(priv(ctx.conn), 'ensureControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(ctx.conn), 'createTunnel').mockResolvedValue(5555)
    vi.spyOn(priv(ctx.conn), 'connectWebSocket').mockResolvedValue(undefined)
    vi.spyOn(priv(ctx.conn), 'verifyCapabilities').mockResolvedValue(true)
    vi.spyOn(priv(ctx.conn), 'recoverDisconnectedSessions').mockResolvedValue(undefined)
    return ctx
  }

  it('a probe that times out (slow link) rejects the connect, retryable, and never issues a start', async () => {
    const timedOut = new RemoteCommandError('Command failed: ssh me@devbox.example.test sh -s\nRemote command timed out after 15000ms', { code: null, stdout: '', stderr: '', timedOut: true })
    const { conn, starts, deploys } = connecting({ dirProbe: timedOut, start: STARTED })
    const err = await conn.connect().catch((e: unknown) => e) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/daemon dir check on devbox did not finish/)
    const hint = classifyHostConnectError(err.message, 'me@devbox.example.test', ['devbox'])
    expect(hint.retryable).toBe(true)
    expect(starts).toEqual([])
    expect(deploys).toEqual([])
    conn.disconnect()
  })

  it('probe says /tmp is fine, but a daemon is alive in ~/.cache: it is adopted, nothing is deployed', async () => {
    const { conn, starts, deploys, seen } = connecting({
      dirProbe: TMP_OK_PROBE,
      liveScan: 'walnut-live dir=1 pid=4242 port=32200 runtime=bun',
      start: STARTED,
    })
    await conn.connect()
    expect(starts).toEqual([])
    expect(deploys).toEqual([])
    expect(conn.remoteDaemonDir).toBe('/home/me/.cache/open-walnut')
    expect(conn.remoteDirChoice).toMatchObject({ path: '/home/me/.cache/open-walnut', fallback: true, reason: 'a daemon started there earlier is still running' })
    expect(conn.remoteRuntime).toBe('bun')
    // The chosen dir (/tmp) is looked at first; the other production dir after it.
    const scan = seen.find((c) => c.includes('walnut-live none'))!
    expect(scan.indexOf("d='/tmp/open-walnut'")).toBeLessThan(scan.indexOf("d='/home/me/.cache/open-walnut'"))
    conn.disconnect()
  })
})

describe('what actually runs the daemon', () => {
  it('the --status arm does not claim a runtime; hello says what runs', async () => {
    const { conn } = setup({ })
    vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
      const cmd = String(args[0])
      if (cmd.includes('walnut-service-probe-done')) return NO_SERVICE
      if (cmd.includes('--status')) return '{"running":true,"port":32100,"pid":77}'
      return ''
    })
    expect(await priv(conn).checkDaemonRunning()).toBe(32100)
    expect(conn.remoteRuntime).toBeNull()
    vi.spyOn(priv(conn), '_sendHandshake').mockResolvedValue({ ok: true, capabilities: [], runtime: 'bun' })
    await priv(conn).verifyCapabilities()
    expect(conn.remoteRuntime).toBe('bun')
  })
})
