/**
 * After a restart, what makes no login comes back at once (host-warmup.ts sweep 'resume').
 *
 * 2026-11-25: 129 server restarts in 39 h each cut every host's link for 9 to 17 s. About 7.5 s
 * was the server's own start; the rest was each host waiting its turn in the one-at-a-time queue
 * behind a 3 s startup delay and a 1.5 s pace, newdev last at 9 s after the server listened,
 * although none of those dials made a login (host-network machines, and an SSH master the old
 * process left running). Pins:
 *   - R1: host-network machines are dialled at start, together; an SSH host with its master left
 *     goes first in the queue at start; the rest wait for the startup delay; SSH hosts never two at once;
 *   - R2: a resume dial that failed fast is not dialled again by the startup sweep (one failure,
 *     one credential wait), and one still running is neither dialled again nor shown queued by a Retry;
 *   - R3: masterLeftRunning is true only for this data dir's socket for this target, and it is the
 *     path the connection itself opens (hostControlSocketPath).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { HostWarmup, type HostWarmupCandidate } from '../../../src/core/hosts/host-warmup.js'
import { controlSocketPath, hostControlSocketPath, masterLeftRunning, masterTargetIdentity } from '../../../src/providers/ssh-control-master.js'

const silent = { info: () => {}, warn: () => {} }
const host = (key: string, extra: Partial<HostWarmupCandidate> = {}): HostWarmupCandidate => ({ key, sshTarget: { hostname: `${key}.example.test` }, ...extra })

function trackingConnect(ms: number, fail: Set<string> = new Set()) {
  const order: Array<{ key: string; at: number }> = []
  const live = new Set<string>()
  let maxLive = 0
  const connecting = new Set<string>()
  const connected = new Set<string>()
  const fn = vi.fn(async (key: string) => {
    connecting.add(key)
    live.add(key)
    maxLive = Math.max(maxLive, live.size)
    order.push({ key, at: Date.now() })
    await new Promise((r) => setTimeout(r, ms))
    live.delete(key)
    connecting.delete(key)
    if (fail.has(key)) throw new Error(`connect ${key}: refused`)
    connected.add(key)
    return { connected: true }
  })
  return { fn, order, connecting, connected, get maxLive() { return maxLive } }
}

describe('host warmup after a restart', () => {
  let warmup: HostWarmup | null = null
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-25T09:54:21Z')) })
  afterEach(() => { warmup?.stop(); warmup = null; vi.useRealTimers() })

  it('R1: host-network machines at once and together; an SSH host with its master left first in the queue; SSH never two at once', async () => {
    const connect = trackingConnect(1_000)
    const t0 = Date.now()
    const ssh = new Set(['newdev', 'fresh-a', 'fresh-b'])
    let sshLive = 0, sshMax = 0
    const fn = vi.fn(async (key: string, target: unknown) => {
      if (ssh.has(key)) { sshLive++; sshMax = Math.max(sshMax, sshLive) }
      try { return await connect.fn(key, target as never) } finally { if (ssh.has(key)) sshLive-- }
    })
    warmup = new HostWarmup({
      startupDelayMs: 3_000, paceMs: 1_500, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [
        host('olddev', { cheapDial: true }),
        host('home-pc', { cheapDial: true }),
        host('newdev', { masterReusable: true }),
        host('fresh-a'), host('fresh-b'),
      ],
      connect: fn, isConnected: (k) => connect.connected.has(k), isConnecting: (k) => connect.connecting.has(k), now: () => Date.now(),
    })
    warmup.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(connect.order.map((o) => o.key).sort()).toEqual(['home-pc', 'newdev', 'olddev'])
    expect(connect.order.every((o) => o.at - t0 < 100)).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    const queued = connect.order.filter((o) => o.key.startsWith('fresh'))
    expect(queued.map((o) => o.key)).toEqual(['fresh-a', 'fresh-b'])
    expect(queued[0]!.at - t0).toBeGreaterThanOrEqual(3_000)
    expect(queued[1]!.at - queued[0]!.at).toBeGreaterThanOrEqual(2_500)
    expect(sshMax).toBe(1)
    expect(fn).toHaveBeenCalledTimes(5)
    for (const k of ['olddev', 'home-pc', 'newdev', 'fresh-a', 'fresh-b']) expect(warmup.snapshot()[k]).toMatchObject({ state: 'done' })
  })

  it('R2: a resume dial that failed fast is not dialled again at the startup delay: one failure, one credential wait', async () => {
    const connect = trackingConnect(50, new Set(['olddev', 'newdev']))
    warmup = new HostWarmup({
      startupDelayMs: 1_000, paceMs: 100, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [host('olddev', { cheapDial: true }), host('newdev', { masterReusable: true })],
      connect: connect.fn, isConnected: (k) => connect.connected.has(k), isConnecting: (k) => connect.connecting.has(k), now: () => Date.now(),
      classify: (message) => (message.includes('newdev') ? 'cert_expired' : 'unreachable') as never,
    })
    warmup.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(connect.fn).toHaveBeenCalledTimes(2)
    expect(warmup.snapshot().olddev).toMatchObject({ state: 'failed', error: 'connect olddev: refused' })
    // The credential clock's first re-dial is a minute out, armed once (not pushed to two).
    const retryAt = warmup.snapshot().newdev!.retryAt!
    expect(retryAt - Date.now()).toBeGreaterThan(50_000)
    expect(retryAt - Date.now()).toBeLessThanOrEqual(60_000)
  })

  it('R2: a resume dial still running is neither dialled again nor shown queued by a Retry or the startup sweep', async () => {
    const connect = trackingConnect(5_000)
    const states: string[] = []
    warmup = new HostWarmup({
      startupDelayMs: 1_000, paceMs: 100, resweepIntervalMs: 0, log: silent,
      listHosts: async () => [host('olddev', { cheapDial: true })],
      connect: connect.fn, isConnected: (k) => connect.connected.has(k), isConnecting: () => false, now: () => Date.now(),
      onChange: (_k, state) => { states.push(state) },
    })
    warmup.start()
    await vi.advanceTimersByTimeAsync(10)
    await warmup.kick('olddev')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(connect.fn).toHaveBeenCalledTimes(1)
    expect(warmup.snapshot().olddev).toMatchObject({ state: 'running' })
    expect(states).not.toContain('queued')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(warmup.snapshot().olddev).toMatchObject({ state: 'done' })
  })
})

describe('masterLeftRunning', () => {
  it('R3: true only for this data dir\'s socket for this target', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-'))
    const t = { hostname: 'newdev.example.test', user: 'someone' }
    const home = path.join(dir, 'home')
    const sock = controlSocketPath({ hostKey: 'newdev', target: masterTargetIdentity(t), home }, dir)
    expect(hostControlSocketPath('newdev', t, home, dir)).toBe(sock)
    expect(masterLeftRunning('newdev', t, home, dir)).toBe(false)
    const srv = net.createServer()
    await new Promise<void>((r) => srv.listen(sock, () => r()))
    try {
      expect(masterLeftRunning('newdev', t, home, dir)).toBe(true)
      expect(masterLeftRunning('newdev', { ...t, hostname: 'other.example.test' }, home, dir)).toBe(false)
      expect(masterLeftRunning('newdev', t, path.join(dir, 'other-home'), dir)).toBe(false)
      expect(masterLeftRunning('newdev', { hostname: '' }, home, dir)).toBe(false)
    } finally {
      await new Promise<void>((r) => srv.close(() => r()))
      fs.rmSync(dir, { recursive: true, force: true })
    }
    // A plain file at the path (not a socket) is no master.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-'))
    const sock2 = controlSocketPath({ hostKey: 'newdev', target: masterTargetIdentity(t), home }, dir2)
    fs.writeFileSync(sock2, '')
    expect(masterLeftRunning('newdev', t, home, dir2)).toBe(false)
    fs.rmSync(dir2, { recursive: true, force: true })
  })
})
