/**
 * A remote daemon upgrade prepares the new daemon's fold checkpoints first, and
 * the old daemon keeps serving meanwhile (remote-fold-prewarm.ts).
 *
 * 2026-10-27: a deploy changed the checkpoint format, and the always-on dev
 * host's new daemon spent 29.5 s folding its live streams before it listened,
 * with every session on that host unreachable.
 *
 * All SSH is stubbed at sshExec and the prewarm itself at prewarmRemoteFolds
 * (its real run is pinned by remote-fold-prewarm.test.ts); no process, socket
 * or tunnel is created. The new daemon an update puts on the host before its
 * stop (stageUpgrade) is stubbed at deployDaemon, as in the service guard tests.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { DaemonConnection, remoteServiceProbePaths } from '../../src/providers/daemon-connection.js'
import type { SshTarget } from '../../src/providers/session-io.js'

const TARGET: SshTarget = { hostname: 'devbox.example.com', user: 'tester' }
const EXPECTED_VERSION = 'walnut-daemon-expected00'
const priv = (conn: DaemonConnection) => conn as unknown as Record<string, (...args: unknown[]) => unknown>
const fields = (conn: DaemonConnection) => conn as unknown as { upgradeRecheckTimer: unknown }

const probeReply = () => [...remoteServiceProbePaths().map((p) => `absent ${p}`), 'walnut-service-probe-done'].join('\n')

/** An unmanaged host running an older daemon; returns the commands issued. */
function skewedHost(conn: DaemonConnection): string[] {
  const seen: string[] = []
  vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
  vi.spyOn(priv(conn), 'deployDaemon').mockImplementation(async () => { seen.push('DEPLOY'); return 'node' })
  vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    if (cmd.includes('walnut-service-probe-done')) return probeReply()
    if (cmd.includes('uname -m')) return 'x86_64'
    if (cmd.includes('walnut-daemon-stop-confirmed')) return 'walnut-daemon-stop-confirmed\n'
    if (cmd.includes('daemon.version')) return 'walnut-daemon-old00000'
    return ''
  })
  return seen
}

const stops = (seen: string[]) => seen.filter((c) => c.includes('walnut-daemon-stop-confirmed'))

function pending() {
  let settle!: { resolve: () => void; reject: (e: Error) => void }
  const promise = new Promise<void>((resolve, reject) => { settle = { resolve, reject } })
  return { promise, settle: () => settle }
}

afterEach(() => {
  vi.restoreAllMocks()
  DaemonConnection.FOLD_PREWARM_INLINE_WAIT_MS = 8_000
})

describe('DaemonConnection upgrade with a remote fold prewarm', () => {
  it('a quick prewarm runs before the stop, inside the same decision', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    const seen = skewedHost(conn)
    const order: string[] = []
    vi.spyOn(priv(conn), 'prewarmRemoteFolds').mockImplementation(async () => { order.push(`prewarm@${stops(seen).length}${seen.includes('DEPLOY') ? '+staged' : ''}`) })
    await expect(priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(order).toEqual(['prewarm@0'])
    expect(stops(seen)).toHaveLength(1)
    // Then the new daemon goes onto the host, still before the stop.
    expect(seen.indexOf('DEPLOY')).toBeGreaterThan(-1)
    expect(seen.indexOf('DEPLOY')).toBeLessThan(seen.findIndex((c) => c.includes('walnut-daemon-stop-confirmed')))
  })

  it('a long prewarm keeps the old daemon serving, then the update is decided again at once', async () => {
    DaemonConnection.FOLD_PREWARM_INLINE_WAIT_MS = 20
    const conn = new DaemonConnection('devbox', TARGET)
    const seen = skewedHost(conn)
    const run = pending()
    const prewarm = vi.spyOn(priv(conn), 'prewarmRemoteFolds').mockReturnValue(run.promise)
    const recheck = vi.spyOn(priv(conn), 'recheckPostponedUpgrade').mockResolvedValue(undefined)

    await expect(priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(stops(seen)).toHaveLength(0)
    expect(fields(conn).upgradeRecheckTimer).not.toBeNull()

    // Asked again while it runs (a reconnect): still the old daemon, no second prewarm.
    await expect(priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(prewarm).toHaveBeenCalledTimes(1)
    expect(stops(seen)).toHaveLength(0)

    run.settle().resolve()
    await vi.waitFor(() => expect(recheck).toHaveBeenCalledTimes(1))
    expect(fields(conn).upgradeRecheckTimer).toBeNull()
    // The decision now goes ahead, without preparing again.
    await expect(priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(prewarm).toHaveBeenCalledTimes(1)
    expect(stops(seen)).toHaveLength(1)
  })

  it('a failed prewarm lets the upgrade go ahead as before', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    const seen = skewedHost(conn)
    vi.spyOn(priv(conn), 'prewarmRemoteFolds').mockRejectedValue(new Error('fold prewarm exited with code 1'))
    await expect(priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(true)
    expect(stops(seen)).toHaveLength(1)
  })

  it('open ACP turns still defer first, before any prewarm', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    const seen = skewedHost(conn)
    const exec = vi.mocked(priv(conn).sshExec)
    const base = exec.getMockImplementation()!
    exec.mockImplementation(async (...args: unknown[]) => String(args[0]).includes('acp-busy.json')
      ? JSON.stringify({ busySids: ['acp-1'], updatedAt: Date.now() })
      : base(...args))
    const prewarm = vi.spyOn(priv(conn), 'prewarmRemoteFolds').mockResolvedValue(undefined)
    await expect(priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(prewarm).not.toHaveBeenCalled()
    expect(stops(seen)).toHaveLength(0)
  })

  it('a current daemon is never prepared for', async () => {
    const conn = new DaemonConnection('devbox', TARGET)
    vi.spyOn(priv(conn), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED_VERSION)
    vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (...args: unknown[]) => {
      const cmd = String(args[0])
      if (cmd.includes('walnut-service-probe-done')) return probeReply()
      if (cmd.includes('daemon.version')) return EXPECTED_VERSION
      return ''
    })
    const prewarm = vi.spyOn(priv(conn), 'prewarmRemoteFolds').mockResolvedValue(undefined)
    await expect(priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(prewarm).not.toHaveBeenCalled()
  })
})
