/**
 * checkDaemonRunning() reads the pid/port files before it executes anything.
 *
 * Source deploys (bun + daemon.cjs) never refresh the binary file in the
 * daemon dir, so on such a host `<binary> --status` runs code this server never
 * chose. 2026-10-02: a remote held a month-old binary whose `--status` still
 * ran its boot-time hooks loader and wrote one daemon-d-*.log per reconnect
 * (3,260 one-line files). The file scan answers the same question without
 * running any daemon code, so it goes first and a clean "none" settles it; the
 * binary is only asked when the scan could not answer.
 *
 * All SSH is stubbed at sshExec; no process, socket, or tunnel is created.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { DaemonConnection, remoteServiceProbePaths } from '../../src/providers/daemon-connection.js'
import type { SshTarget } from '../../src/providers/session-io.js'

const TARGET: SshTarget = { hostname: 'devbox.example.com', user: 'tester' }
const EXPECTED_VERSION = 'walnut-daemon-expected00'
const RUNNING_STATUS = JSON.stringify({ running: true, pid: 4242, port: 32100 })
const LIVE_SCAN = 'walnut-live dir=0 pid=38449 port=39829 runtime=bun'
const NONE_SCAN = 'walnut-live none'

const priv = (conn: DaemonConnection) => conn as unknown as Record<string, (...args: unknown[]) => unknown>
const state = (conn: DaemonConnection) => conn as unknown as Record<string, unknown>

const unmanagedProbe = () => [...remoteServiceProbePaths().map((p) => `absent ${p}`), 'walnut-service-probe-done'].join('\n')

interface Routes {
  /** pid/port file scan reply; a function may throw (ssh failed). */
  scan: string | (() => string)
  /** `<binary> --status` reply; a function may throw (ssh failed). */
  status?: string | (() => string)
}

const answer = (route: string | (() => string) | undefined) => typeof route === 'function' ? route() : route ?? ''

function stubSsh(conn: DaemonConnection, routes: Routes): string[] {
  const seen: string[] = []
  vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    if (cmd.includes('walnut-service-probe-done')) return unmanagedProbe()
    if (cmd.includes('uname -m')) return 'x86_64'
    if (cmd.includes('--status')) return answer(routes.status)
    if (cmd.includes('walnut-live')) return answer(routes.scan)
    if (cmd.includes('daemon.version')) return EXPECTED_VERSION
    return ''
  })
  return seen
}

const binaryExecs = (seen: string[]) => seen.filter((c) => c.includes('--status'))

describe('checkDaemonRunning probe order', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a live daemon found by the file scan is reused without executing the binary on disk', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    const seen = stubSsh(conn, { scan: LIVE_SCAN, status: RUNNING_STATUS })

    await expect(priv(conn).checkDaemonRunning()).resolves.toBe(39829)
    expect(binaryExecs(seen)).toEqual([])
    expect(state(conn)._runtime).toBe('bun')
  })

  it('a scan that ran to its end and found nothing settles it: absent, binary never executed', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    // A stale binary would still claim "running" here; it is not asked.
    const seen = stubSsh(conn, { scan: NONE_SCAN, status: RUNNING_STATUS })

    await expect(priv(conn).checkDaemonRunning()).resolves.toBeNull()
    expect(binaryExecs(seen)).toEqual([])
  })

  it('a scan whose reply is unreadable falls back to the binary status probe', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    const seen = stubSsh(conn, { scan: 'sh: unexpected output', status: RUNNING_STATUS })

    await expect(priv(conn).checkDaemonRunning()).resolves.toBe(32100)
    expect(binaryExecs(seen)).toHaveLength(1)
  })

  it('a scan the link failed falls back to the binary status probe', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    const seen = stubSsh(conn, { scan: () => { throw new Error('ssh: Connection reset by peer') }, status: RUNNING_STATUS })

    await expect(priv(conn).checkDaemonRunning()).resolves.toBe(32100)
    expect(binaryExecs(seen)).toHaveLength(1)
  })

  it('strict mode still reports a dead link when both probes fail', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    const down = () => { throw new Error('ssh: Connection reset by peer') }
    stubSsh(conn, { scan: down, status: down })

    await expect(priv(conn).checkDaemonRunning({ strict: true })).rejects.toThrow('Connection reset')
  })
})
