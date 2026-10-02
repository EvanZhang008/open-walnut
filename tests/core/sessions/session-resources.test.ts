/**
 * The server side of proc.sample (src/core/sessions/session-resources.ts):
 * frames per host, naming from the store (an ACP runtime id looked up once),
 * history, the watched/slow cadence, one request per host at a time, the
 * no-reading reasons, a route deadline that answers what it has, a failed
 * sample that keeps the last good rows, and a host that leaves saying so.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  SessionResourceSampler, isHeavy, FAST_MS, SLOW_MS, WATCH_MS, MIN_GAP_MS, HISTORY_POINTS, KEEP_GOOD_MS,
  type SessionResourcesDeps, type HostResourceFrame,
} from '../../../src/core/sessions/session-resources.js'
import type { ProcSample, SessionProcUsage } from '../../../src/providers/proc-sample-core.js'

function usage(sid: string, rssMb: number, cpuPct: number | null, extra: Partial<SessionProcUsage> = {}): SessionProcUsage {
  return {
    sid, kind: 'cli', rootPid: 100, alive: true, procCount: 2, rssBytes: rssMb * 1024 ** 2, cpuPct,
    top: [{ pid: 100, comm: 'claude', rssBytes: rssMb * 1024 ** 2, cpuPct }], ...extra,
  }
}

function sample(sessions: SessionProcUsage[], at = 1000, extra: Partial<ProcSample> = {}): ProcSample & { ok: true } {
  return {
    ok: true, at, sampleMs: 12, processCount: 900,
    host: { platform: 'darwin', totalMemBytes: 48 * 1024 ** 3, loadavg1: 2.5, cpuCount: 14 },
    sessions, ...extra,
  }
}

interface Harness {
  deps: SessionResourcesDeps
  sampler: SessionResourceSampler
  published: HostResourceFrame[]
  hosts: string[]
  caps: Record<string, string[]>
  replies: Record<string, () => Promise<Record<string, unknown>>>
  sends: Array<{ host: string; cmd: string; timeoutMs?: number }>
  timers: Array<{ fn: () => void; ms: number; id: number }>
  clock: { now: number }
  fire: (n?: number) => Promise<void>
  acpLookups: string[]
}

function harness(opts: { hosts?: string[]; caps?: Record<string, string[]>; heavyRssBytes?: number } = {}): Harness {
  const clock = { now: 10_000 }
  const published: HostResourceFrame[] = []
  const timers: Harness['timers'] = []
  const sends: Harness['sends'] = []
  const acpLookups: string[] = []
  let timerSeq = 0
  const h: Partial<Harness> = {
    published, timers, sends, clock, acpLookups,
    hosts: opts.hosts ?? ['__local__', 'clouddev'],
    caps: opts.caps ?? { __local__: ['proc-sample-v1'], clouddev: ['proc-sample-v1'] },
    replies: {},
  }
  const store: Record<string, { claudeSessionId: string; taskId: string; title: string }> = {
    'sid-a': { claudeSessionId: 'sid-a', taskId: 'task-a', title: 'Fix the build' },
    'sid-b': { claudeSessionId: 'sid-b', taskId: 'task-b', title: 'Write docs' },
    'acp-session-1': { claudeSessionId: 'acp-session-1', taskId: 'task-acp', title: 'Codex run' },
  }
  // An ACP worker's daemon id is its runtime id; the Walnut session id is another one.
  const acpStore: Record<string, { claudeSessionId: string; taskId: string; title: string }> = {
    'rid-1': { claudeSessionId: 'acp-session-1', taskId: 'task-acp', title: 'Codex run' },
  }
  const deps: SessionResourcesDeps = {
    listHosts: () => h.hosts!,
    connectionsFor: (host) => {
      if (!h.hosts!.includes(host)) return []
      const link = (key: string) => ({
        hasCapability: (c: string) => (h.caps![key] ?? []).includes(c),
        send: (cmd: string, _params: Record<string, unknown>, timeoutMs?: number) => {
          sends.push({ host: key, cmd, timeoutMs })
          const r = h.replies![key]
          return r ? r() : Promise.resolve(sample([]))
        },
      })
      // `<host>#2` stands for a second daemon answering for the same host.
      return [host, `${host}#2`].filter((k) => k === host || h.caps![k]).map(link)
    },
    sessionBySid: (sid) => store[sid] ?? null,
    sessionByAcpRuntimeId: (rid) => { acpLookups.push(rid); return acpStore[rid] ?? null },
    publish: (f) => { published.push(f) },
    now: () => clock.now,
    setTimer: (fn, ms) => { const id = ++timerSeq; timers.push({ fn, ms, id }); return id },
    clearTimer: (t) => { const i = timers.findIndex((x) => x.id === t); if (i >= 0) timers.splice(i, 1) },
    heavyRssBytes: opts.heavyRssBytes,
  }
  h.deps = deps
  h.sampler = new SessionResourceSampler(deps)
  h.fire = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      const t = timers.shift()
      if (!t) throw new Error('no timer armed')
      clock.now += t.ms
      t.fn()
      // Let the tick's promise chain settle (the deps' timers are fake, so a real macrotask hop is safe).
      await new Promise<void>((r) => setImmediate(r))
    }
  }
  return h as Harness
}

describe('isHeavy', () => {
  it('fires on RSS or on CPU, not on a null cpu', () => {
    expect(isHeavy({ rssBytes: 2 * 1024 ** 3, cpuPct: null })).toBe(true)
    expect(isHeavy({ rssBytes: 100, cpuPct: 120 })).toBe(true)
    expect(isHeavy({ rssBytes: 100, cpuPct: null })).toBe(false)
    expect(isHeavy({ rssBytes: 100, cpuPct: 99.9 })).toBe(false)
  })
})

describe('SessionResourceSampler.read', () => {
  it('names each session from the store, sorts by RSS, totals the host, and flags heavy ones', async () => {
    const h = harness({ heavyRssBytes: 1024 ** 3 })
    h.replies.__local__ = async () => sample([
      usage('sid-b', 300, 10),
      usage('sid-a', 1500, 45.5),
      usage('rid-1', 200, null, { kind: 'acp' }),
      usage('sid-stranger', 50, null),
      usage('sid-gone', 0, null, { alive: false, procCount: 0, top: [] }),
      usage('sid-leaked', 40, null, { alive: false, procCount: 1 }),
    ])
    const f = await h.sampler.read('__local__', { fresh: true })
    expect(f.ok).toBe(true)
    expect(f.machine).toEqual({ platform: 'darwin', totalMemBytes: 48 * 1024 ** 3, loadavg1: 2.5, cpuCount: 14 })
    expect(f.processCount).toBe(900)
    // The gone root with nothing left is dropped; the one that leaked a child stays.
    expect(f.sessions.map((s) => s.sid)).toEqual(['sid-a', 'sid-b', 'rid-1', 'sid-stranger', 'sid-leaked'])
    expect(f.sessions[0]).toMatchObject({ sessionId: 'sid-a', taskId: 'task-a', title: 'Fix the build', known: true, heavy: true })
    expect(f.sessions[1]).toMatchObject({ taskId: 'task-b', known: true, heavy: false })
    expect(f.sessions[2]).toMatchObject({ sid: 'rid-1', sessionId: 'acp-session-1', taskId: 'task-acp', title: 'Codex run', kind: 'acp', known: true })
    expect(f.sessions[3]).toMatchObject({ known: false, heavy: false })
    expect(f.sessions[3].taskId).toBeUndefined()
    expect(f.sessions[3].sessionId).toBeUndefined()
    expect(f.totals).toEqual({ sessions: 5, rssBytes: (300 + 1500 + 200 + 50 + 40) * 1024 ** 2, cpuPct: 55.5 })
    expect(h.sends).toEqual([{ host: '__local__', cmd: 'proc.sample', timeoutMs: 10_000 }])
    expect(h.published).toHaveLength(1)
    expect(h.published[0].sessions[0].history).toBeUndefined()
  })

  it('a host with no connection, an old daemon, and a failing ps each answer their own reason', async () => {
    const h = harness({ caps: { __local__: ['proc-sample-v1'], clouddev: [] } })
    h.replies.__local__ = async () => ({ ok: false, error: 'internal daemon error' })
    expect(await h.sampler.read('nowhere', { fresh: true })).toMatchObject({ ok: false, reason: 'not_connected', sessions: [] })
    expect(await h.sampler.read('clouddev', { fresh: true })).toMatchObject({ ok: false, reason: 'daemon_needs_upgrade' })
    expect(await h.sampler.read('__local__', { fresh: true })).toMatchObject({ ok: false, reason: 'error', error: 'internal daemon error' })
    h.replies.__local__ = () => Promise.reject(new Error('daemon command timeout: proc.sample'))
    h.clock.now += MIN_GAP_MS + 1
    expect(await h.sampler.read('__local__', { fresh: true })).toMatchObject({ ok: false, reason: 'error', error: 'daemon command timeout: proc.sample' })
    // A daemon whose ps failed answers ok with an error and no sessions: the frame says both.
    h.replies.__local__ = async () => sample([], 1, { error: 'ps failed: timed out' })
    h.clock.now += MIN_GAP_MS + 1
    const f = await h.sampler.read('__local__', { fresh: true })
    expect(f).toMatchObject({ ok: true, reason: 'error', error: 'ps failed: timed out', totals: { sessions: 0 } })
  })

  it('a host with two daemons (a handover, or the local daemon on two sockets) merges both; one failing never hides the other', async () => {
    const h = harness({ caps: { __local__: ['proc-sample-v1'], '__local__#2': ['proc-sample-v1'], clouddev: ['proc-sample-v1'] } })
    // The first daemon runs no sessions (an isolated idle one); the second runs A,
    // and both report B, the second with its live root.
    h.replies.__local__ = async () => sample([usage('sid-b', 10, null, { alive: false, procCount: 1 })], 1, { processCount: 900 })
    h.replies['__local__#2'] = async () => sample([usage('sid-a', 300, 5), usage('sid-b', 200, 1)], 1, { processCount: 950 })
    const f = await h.sampler.read('__local__', { fresh: true })
    expect(h.sends.filter((s) => s.host.startsWith('__local__')).map((s) => s.host).sort()).toEqual(['__local__', '__local__#2'])
    expect(f).toMatchObject({ ok: true, processCount: 950 })
    expect(f.reason).toBeUndefined()
    expect(f.sessions.map((s) => [s.sid, s.alive, s.rssBytes / 1024 ** 2])).toEqual([['sid-a', true, 300], ['sid-b', true, 200]])
    // One daemon down: the other's reading stands, and no error reason is shown.
    h.replies.__local__ = () => Promise.reject(new Error('daemon command timeout: proc.sample'))
    h.clock.now += MIN_GAP_MS + 1
    const g = await h.sampler.read('__local__', { fresh: true })
    expect(g).toMatchObject({ ok: true, totals: { sessions: 2 } })
    expect(g.reason).toBeUndefined()
    // A daemon whose ps failed beside one that answered: still a clean reading.
    h.replies.__local__ = async () => sample([], 1, { error: 'ps failed: timed out', processCount: 0 })
    h.clock.now += MIN_GAP_MS + 1
    expect((await h.sampler.read('__local__', { fresh: true })).reason).toBeUndefined()
    // Both down: the host's reading is an error (over the last good rows, see below).
    h.replies['__local__#2'] = () => Promise.reject(new Error('gone'))
    h.replies.__local__ = () => Promise.reject(new Error('gone too'))
    h.clock.now += MIN_GAP_MS + 1
    expect(await h.sampler.read('__local__', { fresh: true })).toMatchObject({ reason: 'error', error: 'gone too', stale: true })
  })

  it('a failed sample keeps the last good rows, marked stale, for a while; then the error stands alone', async () => {
    const h = harness({ heavyRssBytes: 1024 ** 3 })
    h.replies.__local__ = async () => sample([usage('sid-a', 2000, 150)])
    const good = await h.sampler.read('__local__', { fresh: true })
    expect(good.sessions[0].heavy).toBe(true)
    h.replies.__local__ = () => Promise.reject(new Error('daemon command timeout: proc.sample'))
    h.clock.now += SLOW_MS
    const kept = await h.sampler.read('__local__', { fresh: true })
    expect(kept).toMatchObject({ ok: true, stale: true, goodAt: good.at, reason: 'error', error: 'daemon command timeout: proc.sample', at: h.clock.now })
    expect(kept.sessions.map((x) => [x.sid, x.heavy])).toEqual([['sid-a', true]])
    expect(h.published.at(-1)).toEqual(kept)
    // Still failing: the rows' age counts from the good sample, not from the last stale frame.
    h.clock.now = good.at + KEEP_GOOD_MS + 1
    const gone = await h.sampler.read('__local__', { fresh: true })
    expect(gone).toMatchObject({ ok: false, reason: 'error', sessions: [] })
    // A host that is not connected or needs an upgrade never stands on old rows.
    h.replies.__local__ = async () => sample([usage('sid-a', 10, 1)])
    h.clock.now += MIN_GAP_MS + 1
    await h.sampler.read('__local__', { fresh: true })
    h.caps.__local__ = []
    h.clock.now += MIN_GAP_MS + 1
    expect(await h.sampler.read('__local__', { fresh: true })).toMatchObject({ ok: false, reason: 'daemon_needs_upgrade', sessions: [] })
  })

  it('a read with a deadline answers what it has when a host is stuck, and the sample still lands', async () => {
    const h = harness()
    let resolve!: (v: Record<string, unknown>) => void
    h.replies.__local__ = () => new Promise((r) => { resolve = r })
    const first = h.sampler.read('__local__', { fresh: true, deadlineMs: 2_500 })
    expect(h.timers.map((t) => t.ms)).toEqual([2_500])
    await h.fire()
    expect(await first).toMatchObject({ host: '__local__', ok: false, reason: 'sampling' })
    resolve(sample([usage('sid-a', 10, 1)]))
    await new Promise<void>((r) => setImmediate(r))
    expect(h.published.at(-1)).toMatchObject({ ok: true, totals: { sessions: 1 } })
    // With a frame to fall back on: the last frame, marked stale.
    h.clock.now += MIN_GAP_MS + 1
    const second = h.sampler.read('__local__', { fresh: true, deadlineMs: 2_500 })
    await h.fire()
    expect(await second).toMatchObject({ ok: true, stale: true, totals: { sessions: 1 } })
    // A host that answers in time: its frame, and the deadline timer is cleared.
    resolve(sample([usage('sid-a', 20, 1)]))
    await new Promise<void>((r) => setImmediate(r))
    h.replies.__local__ = async () => sample([usage('sid-a', 30, 1)])
    h.clock.now += MIN_GAP_MS + 1
    const third = await h.sampler.read('__local__', { fresh: true, deadlineMs: 2_500 })
    expect(third.stale).toBeUndefined()
    expect(third.sessions[0].rssBytes).toBe(30 * 1024 ** 2)
    expect(h.timers).toEqual([])
  })

  it('an ACP runtime id is looked up in the store once; an unknown one is asked about again only after a while', async () => {
    const h = harness()
    h.replies.__local__ = async () => sample([usage('rid-1', 10, 1, { kind: 'acp' }), usage('rid-x', 10, 1, { kind: 'acp' })])
    for (let i = 0; i < 3; i++) {
      h.clock.now += MIN_GAP_MS + 1
      const f = await h.sampler.read('__local__', { fresh: true })
      expect(f.sessions.find((x) => x.sid === 'rid-1')).toMatchObject({ sessionId: 'acp-session-1', title: 'Codex run', known: true })
      expect(f.sessions.find((x) => x.sid === 'rid-x')).toMatchObject({ known: false })
    }
    expect(h.acpLookups).toEqual(['rid-1', 'rid-x'])
    h.clock.now += 30_000
    await h.sampler.read('__local__', { fresh: true })
    expect(h.acpLookups).toEqual(['rid-1', 'rid-x', 'rid-x'])
  })

  it('two fresh reads inside the gap, or during one request, cost one proc.sample', async () => {
    const h = harness()
    let resolve!: (v: Record<string, unknown>) => void
    h.replies.__local__ = () => new Promise((r) => { resolve = r })
    const p1 = h.sampler.read('__local__', { fresh: true })
    const p2 = h.sampler.read('__local__', { fresh: true })
    resolve(sample([usage('sid-a', 100, 1)]))
    const [f1, f2] = await Promise.all([p1, p2])
    expect(f1).toBe(f2)
    expect(h.sends).toHaveLength(1)
    // Younger than MIN_GAP_MS: reused. Older: sampled again.
    h.replies.__local__ = async () => sample([usage('sid-a', 200, 1)])
    h.clock.now += MIN_GAP_MS - 1
    expect((await h.sampler.read('__local__', { fresh: true })).sessions[0].rssBytes).toBe(100 * 1024 ** 2)
    h.clock.now += 2
    expect((await h.sampler.read('__local__', { fresh: true })).sessions[0].rssBytes).toBe(200 * 1024 ** 2)
    expect(h.sends).toHaveLength(2)
    // Not fresh: the last frame, no request.
    await h.sampler.read('__local__')
    expect(h.sends).toHaveLength(2)
  })

  it('keeps a bounded history per session and drops a session gone for three samples', async () => {
    const h = harness()
    let rss = 100
    h.replies.__local__ = async () => sample([usage('sid-a', rss++, 5)])
    for (let i = 0; i < HISTORY_POINTS + 5; i++) {
      h.clock.now += MIN_GAP_MS + 1
      await h.sampler.read('__local__', { fresh: true })
    }
    const f = await h.sampler.read('__local__', { history: true })
    const hist = f.sessions[0].history!
    expect(hist).toHaveLength(HISTORY_POINTS)
    expect(hist[hist.length - 1].rssBytes).toBe((100 + HISTORY_POINTS + 4) * 1024 ** 2)
    expect(hist[0].rssBytes).toBe((100 + 5) * 1024 ** 2)
    // The session leaves; after a grace of three samples its history is gone, and a return starts fresh.
    h.replies.__local__ = async () => sample([])
    for (let i = 0; i < 3; i++) { h.clock.now += MIN_GAP_MS + 1; await h.sampler.read('__local__', { fresh: true }) }
    h.replies.__local__ = async () => sample([usage('sid-a', 7, 1)])
    h.clock.now += MIN_GAP_MS + 1
    const back = await h.sampler.read('__local__', { fresh: true, history: true })
    expect(back.sessions[0].history).toHaveLength(1)
  })

  it('history is per host: the same sid on two hosts never mixes', async () => {
    const h = harness()
    h.replies.__local__ = async () => sample([usage('sid-a', 10, 1)])
    h.replies.clouddev = async () => sample([usage('sid-a', 20, 1)])
    await h.sampler.readAll({ fresh: true, history: true })
    h.clock.now += MIN_GAP_MS + 1
    const all = await h.sampler.readAll({ fresh: true, history: true })
    const local = all.find((f) => f.host === '__local__')!
    const remote = all.find((f) => f.host === 'clouddev')!
    expect(local.sessions[0].history!.map((p) => p.rssBytes)).toEqual([10 * 1024 ** 2, 10 * 1024 ** 2])
    expect(remote.sessions[0].history!.map((p) => p.rssBytes)).toEqual([20 * 1024 ** 2, 20 * 1024 ** 2])
  })
})

describe('SessionResourceSampler cadence', () => {
  it('ticks slow on its own, fast while watched, and a fresh read renews the watch', async () => {
    const h = harness()
    h.replies.__local__ = async () => sample([usage('sid-a', 10, 1)])
    h.sampler.start()
    expect(h.timers.map((t) => t.ms)).toEqual([0])
    await h.fire()
    expect(h.sends.filter((s) => s.host === '__local__')).toHaveLength(1)
    expect(h.timers.map((t) => t.ms)).toEqual([SLOW_MS])
    // Someone opens the readout: the pending slow timer is replaced by an immediate one, then fast ones.
    h.sampler.markWatched()
    expect(h.timers.map((t) => t.ms)).toEqual([0])
    await h.fire()
    expect(h.timers.map((t) => t.ms)).toEqual([FAST_MS])
    await h.fire(3)
    expect(h.timers.map((t) => t.ms)).toEqual([FAST_MS])
    // The watch lapses: back to slow.
    h.clock.now += WATCH_MS
    await h.fire()
    expect(h.timers.map((t) => t.ms)).toEqual([SLOW_MS])
    expect(h.published.length).toBeGreaterThan(5)
    h.sampler.stop()
    expect(h.timers).toEqual([])
  })

  it('a failing host never stops the tick, and stop() arms nothing more', async () => {
    const h = harness()
    h.replies.__local__ = () => Promise.reject(new Error('boom'))
    h.sampler.start()
    await h.fire()
    expect(h.published.find((f) => f.host === '__local__')).toMatchObject({ ok: false, reason: 'error' })
    expect(h.timers).toHaveLength(1)
    h.sampler.stop()
    await expect(h.fire()).rejects.toThrow('no timer armed')
  })

  it('latest() answers the last frame per host and forgets a host that left the pool', async () => {
    const h = harness()
    h.replies.__local__ = async () => sample([usage('sid-a', 10, 1)])
    await h.sampler.readAll({ fresh: true })
    expect(h.sampler.latest().map((f) => f.host).sort()).toEqual(['__local__', 'clouddev'])
    expect(h.sampler.latest('clouddev')).toHaveLength(1)
    h.hosts.splice(h.hosts.indexOf('clouddev'), 1)
    h.clock.now += MIN_GAP_MS + 1
    const before = h.published.length
    await h.sampler.readAll({ fresh: true })
    expect(h.sampler.latest().map((f) => f.host)).toEqual(['__local__'])
    // Every client hears it once, so no pill or menu row keeps the old numbers.
    const left = h.published.slice(before).filter((f) => f.host === 'clouddev')
    expect(left).toEqual([expect.objectContaining({ ok: false, reason: 'not_connected', sessions: [] })])
    h.clock.now += MIN_GAP_MS + 1
    await h.sampler.readAll({ fresh: true })
    expect(h.published.filter((f) => f.host === 'clouddev')).toHaveLength(2)
  })
})

describe('publish shape', () => {
  it('a published frame is the wire frame: no history, json-safe', async () => {
    const h = harness()
    h.replies.__local__ = async () => sample([usage('sid-a', 10, 1)])
    await h.sampler.read('__local__', { fresh: true, history: true })
    const f = h.published[0]
    expect(JSON.parse(JSON.stringify(f))).toEqual(f)
    expect(f.sessions[0]).not.toHaveProperty('history')
    vi.restoreAllMocks()
  })
})
