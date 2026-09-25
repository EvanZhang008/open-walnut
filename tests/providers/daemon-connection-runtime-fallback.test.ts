/**
 * First-connect hardening in DaemonConnection: the runtime is verified before
 * it is used, a runtime-shaped start failure walks bun → binary → node ONCE
 * inside the same connect, a failed bun install keeps its log tail on the
 * error, and a relocated daemon dir reaches every command that names it.
 *
 * All SSH is stubbed at sshExec (routes below answer the way the real scripts
 * do); deploySource / deployBinary / getLocalBinaryPath are stubbed too, so no
 * process, socket, upload or tunnel is created.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { DaemonConnection, remoteServiceProbePaths } from '../../src/providers/daemon-connection.js'
import { RemoteCommandError } from '../../src/providers/remote-sh.js'
import { classifyHostConnectError } from '../../src/core/sessions/host-connect-hint.js'

type Priv = Record<string, (...args: unknown[]) => unknown>
const priv = (conn: DaemonConnection) => conn as unknown as Priv

const BUN_OK = 'bun_path=/home/me/.bun/bin/bun\nbun_rc=0\nbun_out=1.1.30'
const BUN_SIGILL = 'bun_path=/home/me/.bun/bin/bun\nbun_rc=132\nbun_out='
const BUN_MISSING = 'bun_path=MISSING'
const STARTED = '32100\n{"running":true}'
/** A complete "no OS service here" answer for either daemon dir. */
const NO_SERVICE = [...new Set([...remoteServiceProbePaths('/tmp/open-walnut'), ...remoteServiceProbePaths('/home/me/.cache/open-walnut')])]
  .map((p) => `absent ${p}`).concat('walnut-service-probe-done').join('\n')

interface Routes {
  dirProbe?: string | Error
  /** Reply to the live-daemon scan of both production dirs. */
  liveScan?: string
  bun?: string[]
  install?: string
  /** Start command reply per runtime; an Error is thrown. */
  start: Partial<Record<'bun' | 'binary' | 'node', string | Error>>
  /** daemon-start.log contents per runtime that last started. */
  startLog?: Partial<Record<'bun' | 'binary' | 'node', string>>
}

function runtimeOf(cmd: string): 'bun' | 'binary' | 'node' {
  if (/daemon-linux-\w+'? --start/.test(cmd)) return 'binary'
  if (/\/bun'? \S*daemon\.cjs'? --start/.test(cmd)) return 'bun'
  return 'node'
}

function setup(routes: Routes, opts: { binary?: boolean } = {}) {
  const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test', user: 'me' })
  const seen: string[] = []
  const starts: string[] = []
  const deploys: string[] = []
  const bunReplies = [...(routes.bun ?? [BUN_OK])]
  let lastStarted: 'bun' | 'binary' | 'node' = 'bun'
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    if (cmd.includes('walnut-dir-probe v1')) {
      if (routes.dirProbe instanceof Error) throw routes.dirProbe
      return routes.dirProbe ?? ''
    }
    if (cmd.includes('walnut-live none')) return routes.liveScan ?? 'walnut-live none'
    if (cmd.includes('walnut-service-probe-done')) return NO_SERVICE
    if (cmd.includes('bun_path=')) return bunReplies.length > 1 ? bunReplies.shift()! : bunReplies[0]
    if (cmd.includes('install_rc=')) return routes.install ?? 'install_rc=0\ninstall_log=/tmp/open-walnut/bun-install.log\ninstall_tail_begin\n\ninstall_tail_end'
    if (cmd.includes('nohup ')) {
      lastStarted = runtimeOf(cmd)
      starts.push(`${lastStarted}: ${cmd}`)
      const reply = routes.start[lastStarted] ?? ''
      if (reply instanceof Error) throw reply
      return reply
    }
    if (cmd.includes('daemon-start.log')) return routes.startLog?.[lastStarted] ?? ''
    if (cmd.includes('uname -m')) return 'x86_64'
    return ''
  })
  vi.spyOn(priv(conn), 'deploySource').mockImplementation(async () => { deploys.push(`source:${(conn as unknown as { _bunPath: string | null })._bunPath ? 'bun' : 'node'}`) })
  vi.spyOn(priv(conn), 'deployBinary').mockImplementation(async () => { deploys.push('binary') })
  vi.spyOn(priv(conn), 'getLocalBinaryPath').mockImplementation(async () => (opts.binary ? '/fake/dist/daemon-linux-x64' : null))
  vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(null)
  return { conn, seen, starts, deploys }
}

afterEach(() => { vi.restoreAllMocks() })

describe('runtime fallback chain', () => {
  it('bun dies with SIGILL at start → the binary, in the same connect, and the host records "binary"', async () => {
    const { conn, starts, deploys } = setup({
      start: { bun: '', binary: STARTED },
      startLog: { bun: 'walnut-daemon-exit=132' },
    }, { binary: true })
    const port = await priv(conn).deployAndStart()
    expect(port).toBe(32100)
    expect(starts.map((s) => s.split(':')[0])).toEqual(['bun', 'binary'])
    expect(deploys).toEqual(['source:bun', 'binary'])
    expect(conn.remoteRuntime).toBe('binary')
  })

  it('no prebuilt binary: bun → node; and when node cannot run either it stops (one chain, no loop)', async () => {
    const { conn, starts, deploys } = setup({
      start: { bun: '', node: '' },
      startLog: { bun: 'walnut-daemon-exit=132', node: "node: /lib64/libc.so.6: version `GLIBC_2.28' not found" },
    })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/GLIBC_2.28/)
    expect(starts.map((s) => s.split(':')[0])).toEqual(['bun', 'node'])
    expect(deploys).toEqual(['source:bun', 'source:node'])
    expect(conn.remoteRuntime).toBeNull()
  })

  it('a start failure that is not about the runtime does not fall back', async () => {
    const { conn, starts } = setup({ start: { bun: '' }, startLog: { bun: 'Error: listen EADDRINUSE: address already in use' } }, { binary: true })
    await expect(priv(conn).deployAndStart()).rejects.toThrow(/EADDRINUSE/)
    expect(starts).toHaveLength(1)
  })

  it('a start that exits non-zero still reads the start log (the runtime death is recorded there)', async () => {
    const { conn, starts } = setup({
      start: { bun: new RemoteCommandError('Command failed: ssh me@devbox sh -s\ncat: /tmp/open-walnut/daemon.port: No such file or directory', { code: 1, stdout: '', stderr: '', timedOut: false }), binary: STARTED },
      startLog: { bun: 'walnut-daemon-exit=132' },
    }, { binary: true })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(starts.map((s) => s.split(':')[0])).toEqual(['bun', 'binary'])
  })
})

describe('bun verification and install', () => {
  it('a bun that is installed but does not run is skipped, never reinstalled over', async () => {
    const { conn, seen, starts } = setup({ bun: [BUN_SIGILL], start: { binary: STARTED } }, { binary: true })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(seen.some((c) => c.includes('install_rc='))).toBe(false)
    expect(starts.map((s) => s.split(':')[0])).toEqual(['binary'])
  })

  it('a failed install keeps its log tail, and it rides the final error', async () => {
    const { conn } = setup({
      bun: [BUN_MISSING],
      install: 'install_rc=6\ninstall_log=/tmp/open-walnut/bun-install.log\ninstall_tail_begin\nwalnut: installing bun\ncurl: (6) Could not resolve host: bun.sh\ninstall_tail_end',
      start: { node: '' },
      startLog: { node: 'Error: listen EADDRINUSE' },
    })
    const err = await (priv(conn).deployAndStart() as Promise<unknown>).catch((e: unknown) => e)
    expect(String((err as Error).message)).toContain('bun install failed: exit 6')
    expect(String((err as Error).message)).toContain('Could not resolve host: bun.sh')
    expect(String((err as Error).message)).toContain('/tmp/open-walnut/bun-install.log')
  })

  it('an install that works is verified by running bun before it is used', async () => {
    const { conn, starts } = setup({ bun: [BUN_MISSING, BUN_OK], start: { bun: STARTED } })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(starts[0]).toMatch(/^bun: .*'\/home\/me\/\.bun\/bin\/bun' /)
    expect(conn.remoteRuntime).toBe('bun')
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
    const { conn, seen, starts } = setup({ dirProbe: FALLBACK_PROBE, start: { bun: STARTED } })
    await priv(conn).resolveRemoteDir()
    expect(conn.remoteDirChoice).toEqual({ path: '/home/me/.cache/open-walnut', fallback: true, reason: '/tmp is read-only', freeMb: 150 })
    expect(conn.remoteHome).toBe('/home/me')
    await priv(conn).deployAndStart()
    const start = starts[0]
    expect(start).toContain("WALNUT_DAEMON_DIR='/home/me/.cache/open-walnut'")
    expect(start).toContain("WALNUT_STREAMS_DIR='/home/me/.open-walnut/tmp/streams'")
    expect(start).toContain("'/home/me/.cache/open-walnut/daemon.cjs' --start > '/home/me/.cache/open-walnut/daemon-start.log'")
    expect(start).not.toContain('/tmp/open-walnut')

    seen.length = 0
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
    const { conn, starts } = setup({ dirProbe: probe, start: { bun: STARTED } })
    await priv(conn).resolveRemoteDir()
    expect(conn.remoteDirChoice).toMatchObject({ path: '/tmp/open-walnut', fallback: false })
    await priv(conn).deployAndStart()
    expect(starts[0]).not.toContain('WALNUT_DAEMON_DIR')
    expect(starts[0]).toContain("'/tmp/open-walnut/daemon.cjs' --start")
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
    const { conn, starts, deploys } = connecting({ dirProbe: timedOut, start: { bun: STARTED } })
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
      start: { bun: STARTED },
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
  it('the binary --status arm no longer claims "binary" (a bun daemon answers it too); hello says what runs', async () => {
    const { conn } = setup({ start: {} })
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

  it('a runtime that died at start is remembered: the next connect skips it (no 37MB re-upload)', async () => {
    const { conn, starts, deploys } = setup({
      bun: [BUN_MISSING],
      start: { binary: '', node: STARTED },
      startLog: { binary: 'walnut-daemon-exit=132' },
    }, { binary: true })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(starts.map((s) => s.split(':')[0])).toEqual(['binary', 'node'])
    expect(deploys).toEqual(['binary', 'source:node'])
    starts.length = 0
    deploys.length = 0
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(deploys).toEqual(['source:node'])
    expect(starts.map((s) => s.split(':')[0])).toEqual(['node'])
  })

  it('a known-bad bun is not probed or reinstalled on the next connect', async () => {
    const { conn, seen } = setup({ start: { bun: '', node: STARTED }, startLog: { bun: "bun: version `GLIBC_2.27' not found" } })
    expect(await priv(conn).deployAndStart()).toBe(32100)
    seen.length = 0
    expect(await priv(conn).deployAndStart()).toBe(32100)
    expect(seen.some((c) => c.includes('bun_path=') || c.includes('install_rc='))).toBe(false)
  })
})
