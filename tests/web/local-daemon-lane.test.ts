/**
 * The primary's standing link to its own daemon (src/web/local-daemon-lane.ts), with fake
 * deps only: no daemon, no socket, no timer of its own (setTimer is captured, the clock is
 * the fake's). The fake pool keeps the '__local__' key the way getDaemonConnection does:
 * one attempt at a time that every caller joins, a 60 s failure cache, and an attempt
 * the pool no longer holds (a reset) that caches nothing and never connects.
 *
 *   - a ready edge starts one dial when cold, joins the running attempt when dialing (no
 *     second connect), and does nothing when connected or while the lane already watches;
 *   - a watched attempt that fails, another caller's included, with no later ready edge,
 *     is tried again after 2, 5, then 15 min, never before the cache allows; a success resets;
 *   - an attempt ended by a newer one (late old, fresh pool) hands the watch over, no failure;
 *   - stop and a restart: the stopped lane stays silent, the new one recovers;
 *   - which servers run it (primary, paired or not; companion; host replica; ephemeral).
 *
 * The boot and stop fence around it: tests/web/local-daemon-lane-boot-fence.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { startLocalDaemonLane, wantsLocalDaemonLane, type LocalDaemonLaneDeps } from '../../src/web/local-daemon-lane.js'
import { resolveServerRole } from '../../src/core/server-role.js'
import { bootPolicy } from '../../src/core/boot-policy.js'
import { resolveCapabilities } from '../../src/core/capabilities.js'

type State = ReturnType<LocalDaemonLaneDeps['wouldWait']>
interface Attempt { promise: Promise<void>; resolve(): void; reject(e: Error): void; detached: boolean }
interface Timer { fn: () => void; ms: number; at: number; cleared: boolean }

function pool() {
  let now = 0
  let connected = false
  let standing = false
  let current: Attempt | null = null
  let cachedUntil = 0
  const attempts: Attempt[] = []
  let joins = 0
  const listeners = new Set<() => void>()
  const timers: Timer[] = []

  const start = (): Attempt => {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    promise.catch(() => { /* every consumer handles its own copy */ })
    const a: Attempt = { promise, resolve, reject, detached: false }
    attempts.push(a)
    current = a
    return a
  }
  const wouldWait = (): State =>
    connected ? 'connected' : current ? 'dialing' : standing || now < cachedUntil ? 'fails-fast' : 'cold'
  /** getDaemonConnection: connected answers, a running attempt is joined, a cached failure throws, else a new connect(). */
  const dial = (): Promise<void> => {
    if (connected) return Promise.resolve()
    if (current) { joins++; return current.promise }
    if (standing || now < cachedUntil) return Promise.reject(new Error('failed a while ago'))
    return start().promise
  }

  return {
    attempts,
    joins: () => joins,
    timers,
    live: () => timers.filter((t) => !t.cleared),
    advance: (ms: number) => { now += ms },
    setStanding: (on: boolean) => { standing = on },
    /** One lane's deps over this pool, with its own log. */
    deps(logs: string[] = []): LocalDaemonLaneDeps {
      return {
        onReady: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
        wouldWait,
        dial,
        retryInMs: () => Math.max(0, cachedUntil - now),
        log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
        setTimer: (fn, ms) => { const t = { fn, ms, at: now, cleared: false }; timers.push(t); return { clear: () => { t.cleared = true } } },
      }
    },
    listeners: () => listeners.size,
    fireReady: () => { for (const cb of [...listeners]) cb() },
    fire: (t: Timer) => { now = Math.max(now, t.at + t.ms); t.cleared = true; t.fn() },
    /** Another caller (a route, a session) asks for the link. */
    other: () => { dial().catch(() => {}) },
    succeed: (a: Attempt) => {
      // The pool-reset guard: an instance the pool no longer holds is ended, never connected.
      if (a.detached || current !== a) { a.reject(new Error('Connection to __local__ was closed while it connected')); return }
      current = null
      connected = true
      a.resolve()
    },
    fail: (a: Attempt, cacheMs = 60_000) => {
      if (!a.detached && current === a) { current = null; cachedUntil = now + cacheMs }
      a.reject(new Error('hello timed out'))
    },
    /** disconnectAllDaemons: the running attempt is nobody's now. */
    reset: () => { connected = false; if (current) current.detached = true; current = null },
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('startLocalDaemonLane: one attempt watched at a time', () => {
  it('cold: a ready edge starts one dial; edges while it runs do nothing; once connected nothing more', async () => {
    const p = pool()
    const logs: string[] = []
    startLocalDaemonLane(p.deps(logs))
    expect(p.attempts).toHaveLength(0)
    p.fireReady()
    expect(p.attempts).toHaveLength(1)
    // The dial's own ensureRunning fires ready again: the lane already watches.
    p.fireReady()
    p.fireReady()
    expect(p.attempts).toHaveLength(1)
    expect(p.joins()).toBe(0)
    p.succeed(p.attempts[0])
    await tick()
    expect(logs).toEqual(['local daemon lane: connected'])
    p.fireReady()
    expect(p.attempts).toHaveLength(1)
    expect(p.joins()).toBe(0)
    expect(p.live()).toHaveLength(0)
  })

  it('dialing: it joins another caller\'s attempt, and when that fails with no later ready edge it tries again itself', async () => {
    const p = pool()
    const logs: string[] = []
    startLocalDaemonLane(p.deps(logs))
    p.other()
    p.fireReady()
    expect(p.attempts).toHaveLength(1)
    expect(p.joins()).toBe(1)
    p.fail(p.attempts[0])
    await tick()
    expect(logs).toEqual(['local daemon lane: attempt failed'])
    expect(p.live().map((t) => t.ms)).toEqual([120_000])
    // No ready edge follows: the lane's own timer is the only way back.
    p.fire(p.live()[0])
    expect(p.attempts).toHaveLength(2)
    p.succeed(p.attempts[1])
    await tick()
    expect(logs).toEqual(['local daemon lane: attempt failed', 'local daemon lane: connected'])
    expect(p.live()).toHaveLength(0)
  })

  it('a cached failure from another caller waits exactly the cache, once, then dials', () => {
    const p = pool()
    startLocalDaemonLane(p.deps())
    p.other()
    p.fail(p.attempts[0])
    p.advance(18_000)
    p.fireReady()
    expect(p.attempts).toHaveLength(1)
    expect(p.live().map((t) => t.ms)).toEqual([42_000])
    p.fireReady()
    expect(p.live()).toHaveLength(1)
    p.fire(p.live()[0])
    expect(p.attempts).toHaveLength(2)
  })

  it('a standing cause (fails fast with no cache clock) waits the lane\'s step, never a tight poll', () => {
    const p = pool()
    p.setStanding(true)
    startLocalDaemonLane(p.deps())
    p.fireReady()
    expect(p.attempts).toHaveLength(0)
    expect(p.live().map((t) => t.ms)).toEqual([120_000])
    p.fire(p.live()[0])
    expect(p.live().map((t) => t.ms)).toEqual([120_000])
    p.setStanding(false)
    p.fire(p.live()[0])
    expect(p.attempts).toHaveLength(1)
  })

  it('failed attempts retry after 2, 5, then every 15 min; a longer cache wins; a success resets', async () => {
    const p = pool()
    startLocalDaemonLane(p.deps())
    p.fireReady()
    const failLast = async (cacheMs = 60_000) => {
      p.fail(p.attempts[p.attempts.length - 1], cacheMs)
      await tick()
      const t = p.live()
      expect(t).toHaveLength(1)
      return t[0]
    }
    const next = (t: Timer) => { const n = p.attempts.length; p.fire(t); expect(p.attempts).toHaveLength(n + 1) }
    let t = await failLast()
    expect(t.ms).toBe(120_000)
    next(t)
    t = await failLast()
    expect(t.ms).toBe(300_000)
    next(t)
    t = await failLast()
    expect(t.ms).toBe(900_000)
    next(t)
    t = await failLast()
    expect(t.ms).toBe(900_000)
    next(t)
    t = await failLast(1_000_000)
    expect(t.ms).toBe(1_000_000)
    next(t)
    p.succeed(p.attempts[p.attempts.length - 1])
    await tick()
    expect(p.live()).toHaveLength(0)
    // The link drops and a later start is ready: the next failure starts from 2 min again.
    p.reset()
    p.fireReady()
    t = await failLast()
    expect(t.ms).toBe(120_000)
  })

  it('a ready edge while a retry waits and the cache is over dials at once and keeps one clock', async () => {
    const p = pool()
    startLocalDaemonLane(p.deps())
    p.fireReady()
    p.fail(p.attempts[0])
    await tick()
    expect(p.live()).toHaveLength(1)
    p.advance(70_000)
    p.fireReady()
    expect(p.attempts).toHaveLength(2)
    expect(p.live()).toHaveLength(0)
  })
})

describe('late old attempt, fresh pool', () => {
  it('the watched attempt is ended by a reset while a fresh one runs: the watch moves to the fresh one, no failure', async () => {
    const p = pool()
    const logs: string[] = []
    startLocalDaemonLane(p.deps(logs))
    p.fireReady()
    const old = p.attempts[0]
    p.reset()
    p.other()
    expect(p.attempts).toHaveLength(2)
    p.succeed(old)
    await tick()
    expect(logs).toEqual([])
    expect(p.live().map((t) => t.ms)).toEqual([1_000])
    p.fire(p.live()[0])
    // Joined, not dialled: still two connects.
    expect(p.attempts).toHaveLength(2)
    expect(p.joins()).toBe(1)
    p.fail(p.attempts[1])
    await tick()
    expect(logs).toEqual(['local daemon lane: attempt failed'])
    expect(p.live().map((t) => t.ms)).toEqual([120_000])
    p.fire(p.live()[0])
    expect(p.attempts).toHaveLength(3)
    p.succeed(p.attempts[2])
    await tick()
    expect(logs).toEqual(['local daemon lane: attempt failed', 'local daemon lane: connected'])
  })

  it('the old attempt fails late after the fresh one connected: nothing to do, nothing cached', async () => {
    const p = pool()
    const logs: string[] = []
    startLocalDaemonLane(p.deps(logs))
    p.fireReady()
    const old = p.attempts[0]
    p.reset()
    p.other()
    p.succeed(p.attempts[1])
    p.fail(old)
    await tick()
    expect(logs).toEqual([])
    expect(p.live()).toHaveLength(0)
    expect(p.deps().wouldWait()).toBe('connected')
  })
})

describe('stop and restart', () => {
  it('stop: no listener, no timer, and nothing after a late settle', async () => {
    const p = pool()
    const logs: string[] = []
    const lane = startLocalDaemonLane(p.deps(logs))
    p.fireReady()
    lane.stop()
    expect(p.listeners()).toBe(0)
    p.fail(p.attempts[0])
    await tick()
    expect(p.live()).toHaveLength(0)
    expect(logs).toEqual([])
  })

  it('stop clears a pending retry', async () => {
    const p = pool()
    const lane = startLocalDaemonLane(p.deps())
    p.fireReady()
    p.fail(p.attempts[0])
    await tick()
    expect(p.live()).toHaveLength(1)
    lane.stop()
    expect(p.live()).toHaveLength(0)
  })

  it('a restart: the old lane stays silent when its attempt settles late; the new one recovers through a failed retry', async () => {
    const p = pool()
    const oldLogs: string[] = []
    const newLogs: string[] = []
    const first = startLocalDaemonLane(p.deps(oldLogs))
    p.fireReady()
    first.stop()
    // stopServer stops the lane before the session runner resets the pool.
    p.reset()
    startLocalDaemonLane(p.deps(newLogs))
    p.fireReady()
    expect(p.attempts).toHaveLength(2)
    expect(p.joins()).toBe(0)
    p.fail(p.attempts[0])
    await tick()
    expect(oldLogs).toEqual([])
    expect(p.live()).toHaveLength(0)
    p.fail(p.attempts[1])
    await tick()
    expect(p.live().map((t) => t.ms)).toEqual([120_000])
    p.fire(p.live()[0])
    p.fail(p.attempts[2])
    await tick()
    expect(p.live().map((t) => t.ms)).toEqual([300_000])
    p.fire(p.live()[0])
    p.succeed(p.attempts[3])
    await tick()
    expect(newLogs).toEqual(['local daemon lane: attempt failed', 'local daemon lane: attempt failed', 'local daemon lane: connected'])
    expect(oldLogs).toEqual([])
    expect(p.listeners()).toBe(1)
  })
})

describe('which servers keep the lane', () => {
  // The branch server.ts takes before the lane: bootPolicy('local-daemon'), and not the companion's skip when cloud.exec is off.
  const decide = (env: Record<string, string>, cloudMode: boolean, caps: string, cloudExecEnabled: boolean, ephemeral: boolean) => {
    const { role, placement } = resolveServerRole(env as NodeJS.ProcessEnv, cloudMode)
    const { capabilities } = resolveCapabilities(caps, cloudMode)
    const branch = bootPolicy('local-daemon', placement, capabilities) && !(bootPolicy('cloud-exec', placement, capabilities) && !cloudExecEnabled)
    return { branch, lane: branch && wantsLocalDaemonLane({ role, ephemeral }) }
  }
  const rows: Array<[string, Record<string, string>, boolean, string, boolean, boolean, { branch: boolean; lane: boolean }]> = [
    // Pairing is no input of the decision (a paired primary has the same facts; what changes is
    // what the connected edge pushes), so one row stands for both; see 'the lane reads no pairing state'.
    ['the primary, paired or not', {}, false, '', false, false, { branch: true, lane: true }],
    ['an ephemeral primary: OFF, the boundary this change leaves as it was', {}, false, '', false, true, { branch: true, lane: false }],
    ['the companion with cloud.exec on (its own cloud-exec daemon)', {}, true, '', true, false, { branch: true, lane: false }],
    ['the companion with cloud.exec off', {}, true, '', false, false, { branch: false, lane: false }],
    ['the companion without the cloud-exec capability', {}, true, 'public-door', true, false, { branch: false, lane: false }],
    ['a host replica', { WALNUT_ROLE: 'replica' }, false, '', false, false, { branch: false, lane: false }],
    ['a plain host server', { WALNUT_HOST_SERVER: '1' }, false, '', false, false, { branch: false, lane: false }],
  ]
  for (const [name, env, cloudMode, caps, cloudExec, ephemeral, want] of rows) {
    it(name, () => { expect(decide(env, cloudMode, caps, cloudExec, ephemeral)).toEqual(want) })
  }

  it('the lane reads no pairing state', () => {
    const lane = readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'web', 'local-daemon-lane.ts'), 'utf8')
    expect(lane).not.toMatch(/getCloudBoxState|cloud-box-state|bridge\.json/)
  })
})
