/**
 * A deploy that changes the daemon never takes a remote host offline
 * (2026-11-03: every clouddev session read "Reconnecting" for 4.5 minutes
 * while the new server uploaded a 65 MB daemon INSIDE its connect, although the
 * old daemon ran the whole time).
 *
 * Pinned here:
 *   - connect() and reconnect() serve a live daemon of an older build as it is
 *     (checkDaemonRunning with deferUpgrade) and update it in the background
 *     once connected; a daemon that refuses the handshake is still updated
 *     first, as before.
 *   - the background update uploads while the old daemon serves; work that
 *     started during the upload holds the swap; a failed upload is asked again
 *     with its own backoff instead of taking the host down.
 *   - during the swap the host reads as connected, and a read waits for the new
 *     daemon (waitDaemonHandover); the window ends on the reconnect, or when it
 *     runs out.
 *   - a source ratchet: every path that can upload or stop a daemon is reached
 *     from connect() and reconnect() only through the deferred decision.
 *
 * All SSH is stubbed at sshExec; no process, socket or tunnel is created.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { managedUpdate } = vi.hoisted(() => ({ managedUpdate: vi.fn() }))
vi.mock('../../src/providers/daemon-service-update.js', () => ({ updateRemoteDaemonService: managedUpdate }))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'
import { DAEMON_UPDATE_BEHIND_MAX_MS, daemonUpdateOverdue } from '../../src/providers/daemon-update-behind.js'
import {
  DaemonConnection,
  daemonHandoverPending,
  getDaemonConnectState,
  getDaemonPoolStatus,
  remoteServiceProbePaths,
  setPooledConnectionForTest,
  waitDaemonHandover,
} from '../../src/providers/daemon-connection.js'
import { log } from '../../src/logging/index.js'

const TARGET = { hostname: 'devbox.example.com', user: 'tester' }
const EXPECTED = 'walnut-daemon-expected00'
const OLD = 'walnut-daemon-old00000'
const RUNNING = JSON.stringify({ running: true, pid: 4242, port: 32100 })

type Priv = Record<string, (...args: unknown[]) => unknown>
const priv = (c: DaemonConnection) => c as unknown as Priv
const state = (c: DaemonConnection) => c as unknown as Record<string, unknown>

function probe(present: string[] = []): string {
  return remoteServiceProbePaths().map((p) => `${present.includes(p) ? 'present' : 'absent'} ${p}`)
    .concat('walnut-service-probe-done').join('\n')
}
const MANAGED = probe(['$HOME/.config/systemd/user/open-walnut-daemon.service'])

interface Routes { probe: string; version: string; status?: string }

function stub(c: DaemonConnection, routes: Routes): string[] {
  const seen: string[] = []
  vi.spyOn(priv(c), 'deployDaemon').mockImplementation(async () => { seen.push('DEPLOY'); return 'node' })
  vi.spyOn(priv(c), 'getExpectedDaemonVersion').mockReturnValue(EXPECTED)
  vi.spyOn(priv(c), 'getLocalBinaryPath').mockResolvedValue('/fixture/daemon')
  vi.spyOn(priv(c), 'sshExec').mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    seen.push(cmd)
    if (cmd.includes('walnut-service-probe-done')) return routes.probe
    if (cmd.includes('walnut-daemon-stop-confirmed')) return 'walnut-daemon-stop-confirmed\n'
    if (cmd.includes('uname -m')) return 'x86_64'
    if (cmd.includes('--status')) return routes.status ?? RUNNING
    if (cmd.includes('acp-busy.json')) return ''
    if (cmd.includes('daemon.version')) return routes.version
    return ''
  })
  return seen
}

const destructive = (seen: string[]) => seen.filter((c) => c === 'DEPLOY' || c.includes('--stop') || /\bkill\b(?! -0\b)/.test(c))

let conns: DaemonConnection[] = []
function make(): DaemonConnection {
  const c = new DaemonConnection('devbox', TARGET)
  conns.push(c)
  return c
}
afterEach(() => {
  for (const c of conns) { state(c)._connected = false; c.disconnect() }
  conns = []
  setPooledConnectionForTest('devbox', null)
  managedUpdate.mockReset()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a connect serves the live daemon as it is', () => {
  it.each([['managed', MANAGED], ['unmanaged', probe()]])('%s host on an older build: the port is returned, nothing is uploaded or stopped', async (_kind, probeReply) => {
    const c = make()
    const seen = stub(c, { probe: probeReply, version: OLD })
    await expect(priv(c).checkDaemonRunning({ deferUpgrade: true })).resolves.toBe(32100)
    expect(managedUpdate).not.toHaveBeenCalled()
    expect(destructive(seen)).toEqual([])
    expect(state(c)._upgradeDeferred).toBe(true)
  })

  it('once connected, an older build is updated in the background; a current one is left alone', async () => {
    vi.useFakeTimers()
    const c = make()
    stub(c, { probe: probe(), version: OLD })
    const recheck = vi.spyOn(priv(c), 'recheckPostponedUpgrade').mockResolvedValue(undefined)
    vi.spyOn(log.session, 'info').mockImplementation(() => {})

    state(c)._upgradeDeferred = true
    state(c)._daemonVersion = OLD
    priv(c).startDeferredUpgrade()
    expect(state(c)._upgradeDeferred).toBe(false)
    await vi.advanceTimersByTimeAsync(DaemonConnection.DEFERRED_UPGRADE_DELAY_MS)
    expect(recheck).toHaveBeenCalledTimes(1)

    state(c)._upgradeDeferred = true
    state(c)._daemonVersion = EXPECTED
    priv(c).startDeferredUpgrade()
    await vi.advanceTimersByTimeAsync(DaemonConnection.DEFERRED_UPGRADE_DELAY_MS * 2)
    expect(recheck).toHaveBeenCalledTimes(1)
  })

  it('a live daemon that refuses the handshake is updated before it is served, as before', async () => {
    const c = make()
    stub(c, { probe: probe(), version: OLD })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const check = vi.spyOn(priv(c), 'checkDaemonRunning').mockResolvedValue(null)
    const start = vi.spyOn(priv(c), 'deployAndStart').mockResolvedValue(32200)
    vi.spyOn(priv(c), 'createTunnel').mockResolvedValue(5555)
    vi.spyOn(priv(c), 'connectWebSocket').mockResolvedValue(undefined)
    vi.spyOn(priv(c), 'verifyCapabilities').mockResolvedValue(true)
    state(c)._upgradeDeferred = true
    await expect(priv(c).upgradeBeforeServing({ strict: true })).resolves.toBe(true)
    // The update decided inline (no deferUpgrade), then the new daemon dialled.
    expect(check).toHaveBeenCalledWith({ strict: true })
    expect(start).toHaveBeenCalledTimes(1)
    expect(state(c)._upgradeDeferred).toBe(false)
  })
})

describe('the background update of a service-managed daemon', () => {
  const live = (c: DaemonConnection) => { state(c)._connected = true }

  it('uploads while the old daemon serves, then swaps with the host reading as connected until the new daemon answers', async () => {
    const c = make()
    stub(c, { probe: MANAGED, version: OLD })
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => {
      state(c)._connected = false
    })
    let during: { pending: boolean; reads: unknown } | null = null
    managedUpdate.mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { onStaged?: () => boolean | Promise<boolean> }) => {
      expect(await opts?.onStaged?.()).toBe(true)
      // The old daemon exits under the swap: the link drops.
      priv(c).setConnected(false)
      setPooledConnectionForTest('devbox', c)
      during = { pending: daemonHandoverPending('devbox'), reads: getDaemonConnectState('devbox') }
      return 'applied'
    })
    live(c)
    await priv(c).recheckPostponedUpgrade()
    expect(managedUpdate).toHaveBeenCalledTimes(1)
    expect(during!.pending).toBe(true)
    expect(during!.reads).toMatchObject({ connected: true, phase: 'connected', handover: true })
    expect(getDaemonPoolStatus().find((s) => s.host === 'devbox')).toMatchObject({ connected: true, phase: 'connected' })
    expect(lost).not.toHaveBeenCalled()

    // A read waiting on the swap runs as soon as the new daemon is connected.
    const waiting = waitDaemonHandover('devbox', 5_000)
    priv(c).setConnected(true)
    await expect(waiting).resolves.toBe(true)
    expect(daemonHandoverPending('devbox')).toBe(false)
    expect(state(c)._handoverUntil).toBe(0)
  })

  it('work that started during the upload holds the swap', async () => {
    const c = make()
    stub(c, { probe: MANAGED, version: OLD })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
    managedUpdate.mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { onStaged?: () => boolean | Promise<boolean> }) => {
      // A session write went out while the file uploaded.
      ;(state(c).pendingCommands as Map<number, unknown>).set(99, { cmd: 'send', timer: setTimeout(() => {}, 0), resolve: () => {}, reject: () => {} })
      return (await opts?.onStaged?.()) === false ? 'held' : 'applied'
    })
    live(c)
    await priv(c).recheckPostponedUpgrade()
    expect(state(c)._handoverUntil).toBe(0)
    expect(state(c).upgradeRecheckTimer).not.toBeNull()
    expect(state(c)._lastUpgradeAttempt).toBeNull()
  })

  it.each([['managed', MANAGED], ['unmanaged', probe()]])('host_exec runs on a %s host hold the update before anything is uploaded or stopped; it goes ahead once they end', async (_kind, probeReply) => {
    // 2026-11-03: a deploy swapped a Mac's daemon under a five minute iOS test run there,
    // and the run ended with the old daemon (exec-runs-hold.ts).
    const c = make()
    const seen = stub(c, { probe: probeReply, version: OLD })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
    vi.spyOn(priv(c), 'holdUpgradeForFoldPrewarm').mockResolvedValue(false)
    vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => { state(c)._connected = false })
    managedUpdate.mockResolvedValue('applied')
    let runs = [{ jobId: 'hx-ios', running: true }, { jobId: 'hx-done', running: false }]
    const send = vi.spyOn(c, 'send').mockImplementation((async (cmd: string) => (cmd === 'exec.list' ? { ok: true, jobs: runs } : { ok: true })) as never)
    state(c)._capabilities = ['host-exec-v1']
    live(c)
    await priv(c).recheckPostponedUpgrade()
    expect(send).toHaveBeenCalledWith('exec.list', {}, expect.any(Number))
    expect(destructive(seen)).toEqual([])
    expect(managedUpdate).not.toHaveBeenCalled()
    expect(state(c).upgradeRecheckTimer).not.toBeNull()

    runs = [{ jobId: 'hx-done', running: false }]
    clearTimeout(state(c).upgradeRecheckTimer as ReturnType<typeof setTimeout>)
    state(c).upgradeRecheckTimer = null
    await priv(c).recheckPostponedUpgrade()
    if (_kind === 'managed') expect(managedUpdate).toHaveBeenCalledTimes(1)
    else expect(seen).toContain('DEPLOY')
  })

  it('a daemon without host_exec is never asked, and an ask that fails holds nothing', async () => {
    for (const caps of [[], ['host-exec-v1']]) {
      const c = make()
      const seen = stub(c, { probe: probe(), version: OLD })
      vi.spyOn(log.session, 'info').mockImplementation(() => {})
      vi.spyOn(priv(c), 'holdUpgradeForFoldPrewarm').mockResolvedValue(false)
      vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => { state(c)._connected = false })
      const send = vi.spyOn(c, 'send').mockRejectedValue(new Error('exec.list timed out'))
      state(c)._capabilities = caps
      live(c)
      await priv(c).recheckPostponedUpgrade()
      expect(send.mock.calls.filter(([cmd]) => cmd === 'exec.list')).toHaveLength(caps.length ? 2 : 0)
      expect(seen).toContain('DEPLOY')
    }
  })

  it('a run that starts during the upload holds the stop (unmanaged) and the swap (managed)', async () => {
    for (const probeReply of [probe(), MANAGED]) {
      const c = make()
      const seen = stub(c, { probe: probeReply, version: OLD })
      vi.spyOn(log.session, 'warn').mockImplementation(() => {})
      vi.spyOn(log.session, 'info').mockImplementation(() => {})
      vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
      vi.spyOn(priv(c), 'holdUpgradeForFoldPrewarm').mockResolvedValue(false)
      vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => { state(c)._connected = false })
      let uploaded = false
      vi.spyOn(priv(c), 'deployDaemon').mockImplementation(async () => { seen.push('DEPLOY'); uploaded = true; return 'node' })
      managedUpdate.mockReset().mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { onStaged?: () => boolean | Promise<boolean> }) => {
        uploaded = true
        return (await opts?.onStaged?.()) === false ? 'held' : 'applied'
      })
      vi.spyOn(c, 'send').mockImplementation((async (cmd: string) => (cmd === 'exec.list' ? { ok: true, jobs: uploaded ? [{ jobId: 'hx-late', running: true }] : [] } : { ok: true })) as never)
      state(c)._capabilities = ['host-exec-v1']
      live(c)
      await priv(c).recheckPostponedUpgrade()
      expect(uploaded).toBe(true)
      expect(seen.filter((cmd) => cmd.includes('--stop') || cmd.includes('walnut-daemon-stop-confirmed'))).toEqual([])
      expect(state(c)._handoverUntil).toBe(0)
      expect(state(c).upgradeRecheckTimer).not.toBeNull()
    }
  })

  it('a host behind past the bound: writes in flight, host_exec runs and a busy daemon no longer hold it, and the swap asks the daemon to go over its work', async () => {
    // 2026-11-05: clouddev stayed on an old daemon for about 17.6 h, the reasons taking turns (daemon-update-behind.ts).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-overdue-'))
    setAcpUpgradeHoldFileForTest(path.join(dir, 'holds.json'))
    const gate = { poll: DaemonConnection.OVERDUE_GATE_POLL_MS, wait: DaemonConnection.OVERDUE_GATE_WAIT_MS }
    try {
      DaemonConnection.OVERDUE_GATE_POLL_MS = 10
      DaemonConnection.OVERDUE_GATE_WAIT_MS = 50
      const c = make()
      stub(c, { probe: MANAGED, version: OLD })
      const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
      vi.spyOn(log.session, 'info').mockImplementation(() => {})
      vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
      vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => { state(c)._connected = false })
      vi.spyOn(c, 'send').mockImplementation((async (cmd: string) => (cmd === 'exec.list' ? { ok: true, jobs: [{ jobId: 'hx-forever', running: true }] } : { ok: true })) as never)
      state(c)._capabilities = ['host-exec-v1', 'service-update-force-v1']
      // A session write that never ends, in flight at every look.
      ;(state(c).pendingCommands as Map<number, unknown>).set(99, { cmd: 'send', timer: setTimeout(() => {}, 0), resolve: () => {}, reject: () => {} })
      let over: unknown = 'not asked'
      managedUpdate.mockReset().mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { onStaged?: () => boolean | Promise<boolean>; overBusy?: boolean }) => {
        over = opts?.overBusy
        return (await opts?.onStaged?.()) === false ? 'held' : 'applied'
      })

      // Not yet overdue: held, nothing asked of the daemon.
      live(c)
      await priv(c).recheckPostponedUpgrade()
      expect(managedUpdate).not.toHaveBeenCalled()

      // Behind for the whole bound, checked all along (reasons taking turns do not restart it).
      const now = Date.now()
      for (let t = now - DAEMON_UPDATE_BEHIND_MAX_MS - 60_000; t < now; t += 30 * 60_000) daemonUpdateOverdue('devbox', OLD, true, t)
      clearTimeout(state(c).upgradeRecheckTimer as ReturnType<typeof setTimeout>)
      state(c).upgradeRecheckTimer = null
      live(c)
      await priv(c).recheckPostponedUpgrade()
      expect(managedUpdate).toHaveBeenCalledTimes(1)
      expect(over).toBe(true)
      expect(warn.mock.calls.map(([m]) => m)).toEqual(expect.arrayContaining([
        'DaemonConnection: daemon update overdue; it goes ahead over the work that held it',
        'DaemonConnection: overdue daemon update goes ahead over commands in flight',
      ]))

      // A daemon that can force but still refused (a session command it drains): asked again every minute.
      const busyTry = async (caps: string[]) => {
        managedUpdate.mockReset().mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { overBusy?: boolean }) => {
          over = opts?.overBusy
          throw new Error('Managed daemon update failed: Daemon has active operations; retry after they finish')
        })
        state(c)._capabilities = caps
        state(c)._lastUpgradeAttempt = null
        state(c)._busyRefusals = { expected: EXPECTED, n: 10 }
        clearTimeout(state(c).upgradeRecheckTimer as ReturnType<typeof setTimeout>)
        state(c).upgradeRecheckTimer = null
        live(c)
        await priv(c).recheckPostponedUpgrade()
        const postponed = warn.mock.calls.filter(([m]) => m === 'DaemonConnection: daemon update postponed; checking again').pop()
        expect(String((postponed?.[1] as { reason?: string }).reason)).toContain("the host's daemon is busy")
        return (postponed?.[1] as { retryInMs?: number }).retryInMs
      }
      // Overdue, an older daemon too is updated with --over-busy (the CLI restarts it through its
      // service when it will not prepare); a refusal still is asked again within 5 min, never backed off further.
      for (const caps of [['host-exec-v1', 'service-update-force-v1'], ['host-exec-v1']]) {
        expect(await busyTry(caps)).toBe(5 * 60_000)
        expect(over).toBe(true)
      }
    } finally {
      DaemonConnection.OVERDUE_GATE_POLL_MS = gate.poll
      DaemonConnection.OVERDUE_GATE_WAIT_MS = gate.wait
      setAcpUpgradeHoldFileForTest(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a managed update the daemon refused as busy is asked again in a minute, not a service error with a cooldown', async () => {
    const c = make()
    stub(c, { probe: MANAGED, version: OLD })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
    managedUpdate.mockReset().mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { onStaged?: () => boolean | Promise<boolean> }) => {
      expect(await opts?.onStaged?.()).toBe(true)
      throw new Error('Managed daemon update failed: service.handover: running host_exec jobs must finish first; the old service config was put back')
    })
    live(c)
    await expect(priv(c).recheckPostponedUpgrade()).resolves.toBeUndefined()
    expect(state(c)._handoverUntil).toBe(0)
    expect(state(c).upgradeRecheckTimer).not.toBeNull()
    expect(state(c)._lastUpgradeAttempt).toBeNull()
  })

  it('a managed update that failed after it started is asked again once its cooldown ends, also inside the cooldown, never left until the link drops', async () => {
    const c = make()
    stub(c, { probe: MANAGED, version: OLD })
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    const err = vi.spyOn(log.session, 'error').mockImplementation(() => {})
    vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
    managedUpdate.mockReset().mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { onStaged?: () => boolean | Promise<boolean> }) => {
      expect(await opts?.onStaged?.()).toBe(true)
      throw new Error('Managed daemon update failed: the daemon never answered as the new executable')
    })
    live(c)
    const retry = () => (warn.mock.calls.filter(([m]) => m === 'DaemonConnection: daemon update postponed; checking again').at(-1)?.[1] as { reason: string; retryInMs: number } | undefined)
    await priv(c).recheckPostponedUpgrade()
    expect(managedUpdate).toHaveBeenCalledTimes(1)
    expect(state(c).upgradeRecheckTimer).not.toBeNull()
    expect(retry()).toMatchObject({ reason: expect.stringContaining('the managed update did not complete') })
    expect(retry()!.retryInMs).toBeGreaterThan(10 * 60_000)

    // Asked inside the cooldown (a connect, a request): no second try, and a recheck at its end.
    clearTimeout(state(c).upgradeRecheckTimer as ReturnType<typeof setTimeout>)
    state(c).upgradeRecheckTimer = null
    await priv(c).recheckPostponedUpgrade()
    expect(managedUpdate).toHaveBeenCalledTimes(1)
    expect(state(c).upgradeRecheckTimer).not.toBeNull()
    expect(retry()).toMatchObject({ reason: expect.stringContaining('asked again when its cooldown ends') })
    expect(retry()!.retryInMs).toBeLessThanOrEqual(10 * 60_000 + 5_000)
    expect(err.mock.calls.some(([m]) => String(m).includes('use `walnut daemon install'))).toBe(false)
  })

  it('during an overdue swap a file change waits for it; other commands and a plain swap do not', async () => {
    const c = make()
    let settle!: () => void
    state(c)._swapInFlight = new Promise<void>((resolve) => { settle = resolve })
    state(c)._swapOverBusy = true
    state(c)._connected = false
    let done = false
    const write = c.send('fs.write', { path: '/x', data: 'y' }).catch((error: Error) => { done = true; return error })
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)
    // A session command is not held (it goes to the daemon there is, or fails on no link).
    await expect(c.send('send', { sid: 's' })).rejects.toThrow(/not connected/)
    settle()
    expect(String(await write)).toMatch(/not connected/)

    state(c)._swapInFlight = new Promise<void>(() => {})
    state(c)._swapOverBusy = false
    await expect(c.send('fs.write', { path: '/x', data: 'y' })).rejects.toThrow(/not connected/)

    // The host network updater's fence (its own promise, so a reconnect never waits on it).
    state(c)._swapInFlight = null
    const release = c.fenceFileChanges()
    let fenced = false
    const held = c.send('fs.rename', { from: '/a', to: '/b' }).catch((error: Error) => { fenced = true; return error })
    await new Promise((r) => setTimeout(r, 20))
    expect(fenced).toBe(false)
    expect(state(c)._swapInFlight).toBeNull()
    release()
    expect(String(await held)).toMatch(/not connected/)
    expect(state(c)._fileFence).toBeNull()
  })

  it('a daemon busy at every ask is asked less often: three times a minute apart, then backing off', async () => {
    const c = make()
    stub(c, { probe: MANAGED, version: OLD })
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
    managedUpdate.mockReset().mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { onStaged?: () => boolean | Promise<boolean> }) => {
      expect(await opts?.onStaged?.()).toBe(true)
      throw new Error('Managed daemon update failed: Error: service.handover: active ACP workers or relay requests must finish first; the old service config was put back')
    })
    live(c)
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      warn.mockClear()
      await priv(c).recheckPostponedUpgrade()
      const said = warn.mock.calls.find(([m]) => m === 'DaemonConnection: daemon update postponed; checking again')
      delays.push((said?.[1] as { retryInMs: number }).retryInMs)
      expect(state(c)._lastUpgradeAttempt).toBeNull()
    }
    expect(delays).toEqual([60_000, 60_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000])
  })

  it('a boot-start install waits for host_exec runs too', async () => {
    vi.stubEnv('WALNUT_DAEMON_BOOT_START', '1')
    const c = make()
    state(c)._connected = true
    state(c)._capabilities = ['host-exec-v1']
    vi.spyOn(c, 'send').mockImplementation((async (cmd: string) => (cmd === 'exec.list' ? { ok: true, jobs: [{ jobId: 'hx-ios', running: true }] } : { ok: true })) as never)
    const keeper = (c as unknown as { _bootStart: { io: { hold: () => Promise<string | null> } } | null })._bootStart
    expect(keeper).not.toBeNull()
    expect(await keeper!.io.hold()).toBe('1 host_exec run on the host would end with the daemon')
    vi.unstubAllEnvs()
  })

  it('a failed upload keeps the old daemon serving and is asked again later, not a service error', async () => {
    const c = make()
    stub(c, { probe: MANAGED, version: OLD })
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
    managedUpdate.mockImplementation(async () => {
      throw Object.assign(new Error('Daemon update upload failed; the installed service was not changed'), { name: 'DaemonUpdateStageError' })
    })
    live(c)
    await priv(c).recheckPostponedUpgrade()
    expect(state(c)._connected).toBe(true)
    expect(state(c).upgradeRecheckTimer).not.toBeNull()
    expect(state(c)._stageFail).toMatchObject({ expected: EXPECTED, attempt: 1 })
    expect(warn.mock.calls.some((call) => String(call[0]).includes('postponed') && String((call[1] as { reason: string }).reason).includes('could not be put on the host'))).toBe(true)
  })

  it('a link drop during the upload is dialled again at once, and the update runs again on the new link', async () => {
    const c = make()
    stub(c, { probe: MANAGED, version: OLD })
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
    let release!: () => void
    const uploading = new Promise<void>((r) => { release = r })
    const staged: boolean[] = []
    managedUpdate.mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { onStaged?: () => boolean | Promise<boolean> }) => {
      if (managedUpdate.mock.calls.length === 1) await uploading
      const go = (await opts?.onStaged?.()) ?? true
      staged.push(go)
      return go ? 'applied' : 'held'
    })
    vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => { priv(c).setConnected(false) })
    live(c)
    const first = priv(c).recheckPostponedUpgrade() as Promise<void>
    await vi.waitFor(() => expect(managedUpdate).toHaveBeenCalledTimes(1))
    // The link drops mid-upload: nothing holds a reconnect (only a swap would).
    priv(c).setConnected(false)
    expect(state(c)._swapInFlight).toBeNull()
    expect(c.handoverPending).toBe(false)
    // The reconnect served the old daemon and asked for its update again.
    priv(c).setConnected(true)
    void priv(c).recheckPostponedUpgrade()
    release()
    await first
    await vi.waitFor(() => expect(managedUpdate).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(staged).toEqual([false, true]))
  })

  it('the swap window opens when the link drops, not while the old daemon still answers', async () => {
    vi.useFakeTimers()
    const c = make()
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    setPooledConnectionForTest('devbox', c)
    live(c)
    priv(c).beginHandover()
    // A slow stop: the old daemon answers past the whole window.
    await vi.advanceTimersByTimeAsync(DaemonConnection.HANDOVER_WINDOW_MS + 1)
    expect(state(c)._handoverArmed).toBe(true)
    priv(c).setConnected(false)
    expect(daemonHandoverPending('devbox')).toBe(true)
    expect(getDaemonConnectState('devbox')).toMatchObject({ connected: true, handover: true })
    await vi.advanceTimersByTimeAsync(DaemonConnection.HANDOVER_WINDOW_MS - 1_000)
    expect(daemonHandoverPending('devbox')).toBe(true)
    priv(c).setConnected(true)
    expect(state(c)._handoverArmed).toBe(false)
  })

  it('a swap window that runs out shows the truth again', async () => {
    vi.useFakeTimers()
    const c = make()
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    setPooledConnectionForTest('devbox', c)
    live(c)
    priv(c).beginHandover()
    priv(c).setConnected(false)
    expect(getDaemonConnectState('devbox').connected).toBe(true)
    await vi.advanceTimersByTimeAsync(DaemonConnection.HANDOVER_WINDOW_MS + 1)
    expect(daemonHandoverPending('devbox')).toBe(false)
    expect(getDaemonConnectState('devbox')).toMatchObject({ connected: false })
    expect(getDaemonConnectState('devbox').handover).toBeUndefined()
    await expect(waitDaemonHandover('devbox', 1_000)).resolves.toBe(false)
  })
})

describe('the unmanaged background update', () => {
  it('stages while serving, and the stop opens the swap window', async () => {
    const c = make()
    const seen = stub(c, { probe: probe(), version: OLD })
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(priv(c), 'holdUpgradeForFoldPrewarm').mockResolvedValue(false)
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => { priv(c).setConnected(false) })
    state(c)._connected = true
    await priv(c).recheckPostponedUpgrade()
    const deployAt = seen.indexOf('DEPLOY')
    const stopAt = seen.findIndex((cmd) => cmd.includes('walnut-daemon-stop-confirmed'))
    expect(deployAt).toBeGreaterThanOrEqual(0)
    expect(stopAt).toBeGreaterThan(deployAt)
    expect(lost).toHaveBeenCalledTimes(1)
    expect(c.handoverPending).toBe(true)
  })
})

/**
 * The class: anything in a connect path that would put a new daemon on the
 * host or stop the old one before the host is served. The daemon update runs
 * through checkDaemonRunning → shouldUpgradeDaemon (unmanaged: stageUpgrade +
 * stop; managed: updateManagedDaemon). connect() and reconnect() may reach it
 * only with deferUpgrade, and upgradeBeforeServing (a daemon that refused the
 * handshake) only after the handshake. A new call site of these in either
 * method fails here and needs a reason in this list.
 */
describe('ratchet: no daemon update inside a connect while a live daemon answers', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/providers/daemon-connection.ts'), 'utf8')
  const body = (signature: RegExp): string => {
    const start = src.search(signature)
    expect(start).toBeGreaterThan(0)
    // The method ends at its closing brace, the first one at two-space indent.
    const end = src.indexOf('\n  }\n', start + 1)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
  }
  const UPGRADE_CALLS = /\b(shouldUpgradeDaemon|updateManagedDaemon|stageUpgrade|stopUnmanagedDaemon|deployDaemon|deployWalnutFile|uploadFile|forceRedeployAndReconnect|checkDaemonRunning|upgradeBeforeServing)\(/g

  it.each([
    ['connect', /\n {2}async connect\(\): Promise<void> \{/],
    ['reconnect', /\n {2}private async reconnect\(\): Promise<void> \{/],
  ])('%s(): every update path is the deferred one or comes after a refused handshake', (_name, signature) => {
    const text = body(signature)
    const calls = [...text.matchAll(UPGRADE_CALLS)].map((m) => {
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index))
      return { fn: m[1], line: line.trim() }
    }).filter((c) => !c.line.startsWith('//') && !c.line.startsWith('*'))
    for (const call of calls) {
      if (call.fn === 'checkDaemonRunning') expect(call.line).toContain('deferUpgrade: true')
      else if (call.fn === 'upgradeBeforeServing') expect(call.line).toMatch(/!handshakeOk && this\._upgradeDeferred/)
      else expect(['forceRedeployAndReconnect']).toContain(call.fn)
    }
    expect(calls.some((c) => c.fn === 'checkDaemonRunning')).toBe(true)
    // And the deferred update is started once the link is up (else hosts stay on old daemons for good).
    expect(text).toMatch(/\n\s+this\.startDeferredUpgrade\(\)/)
  })
})
