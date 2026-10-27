/**
 * Unit tests for restart recovery's scheduler (src/core/session-auto-recover.ts):
 * which lost sessions are resumed, in what order, under which caps, and what
 * happens to the task's phase meanwhile.
 *
 * 2026-10-26: the Mac rebooted with 42 sessions on it. Twelve had work in
 * flight and all twelve were handed back as NEED_ACTION; none was resumed.
 *
 * Fully offline: clock, timers, records, tasks, the daemon's fold, the load
 * average and the send are injected, so the state machine runs deterministically
 * with no server, CLI or real timers.
 */

import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import {
  SessionAutoRecover,
  resolveAutoRecoverConfig,
  AUTO_RECOVER_SOURCE,
  type AutoRecoverConfig,
  type AutoRecoverDeps,
} from '../../src/core/session-auto-recover.js'
import { RESUME_MESSAGE } from '../../src/core/sessions/restart-loss.js'
import type { SessionRecord, SessionRestartLoss, TaskPhase } from '../../src/core/types.js'
import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'

// ── Fake environment ──

const T0 = Date.parse('2026-10-26T02:03:52.000Z')
const BOOT = Date.parse('2026-10-26T01:57:00.000Z')

interface FakeTimer { id: number; fn: () => void; at: number }

class World {
  t = T0
  seq = 0
  timers = new Map<number, FakeTimer>()
  records = new Map<string, SessionRecord>()
  tasks = new Map<string, { phase: TaskPhase; isMain: boolean }>()
  snapshots = new Map<string, SessionSnapshot | null>()
  owner: 'server' | 'daemon' | 'unknown' = 'server'
  load = 0.5
  cwdOk: boolean | null = true
  sends: Array<{ sessionId: string; message: string; source: string }> = []
  handBacks: string[] = []
  notes: Array<{ sessionId: string; message: string }> = []
  /** Messages waiting in each session's queue (a delivery the host could not take puts its batch back). */
  pending = new Map<string, number>()
  deliveryFailed = new Map<string, (error: string) => void>()
  dropped: Array<{ sid: string; messageId: string }> = []
  /** What a send does to the record: bring it back (default), fail the spawn, or nothing. */
  onSend: (sid: string) => void = (sid) => { this.patch(sid, { process_status: 'running' }) }

  patch(sid: string, p: Partial<SessionRecord>): void {
    const r = this.records.get(sid)
    if (r) this.records.set(sid, { ...r, ...p, statusRevision: (r.statusRevision ?? 1) + ('process_status' in p ? 1 : 0) })
  }

  deps(): Partial<AutoRecoverDeps> {
    return {
      now: () => this.t,
      setTimer: (fn, ms) => {
        const id = ++this.seq
        this.timers.set(id, { id, fn, at: this.t + ms })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: (h) => { this.timers.delete(h as unknown as number) },
      send: async (sessionId, message, opts) => {
        this.sends.push({ sessionId, message, source: opts.source })
        this.onSend(sessionId)
      },
      getSession: async (sid) => this.records.get(sid) ?? null,
      listSessions: async () => [...this.records.values()],
      getTask: async (id) => this.tasks.get(id) ?? null,
      recoveryOwner: async () => this.owner,
      fetchSnapshot: async (r) => this.snapshots.get(r.claudeSessionId) ?? null,
      cwdExists: async () => this.cwdOk,
      taskDir: async (taskId) => `/state/open-walnut/tasks/${taskId}`,
      bootTimeMs: () => BOOT,
      loadPerCpu: () => this.load,
      noteAttempt: async (sid, attempts) => {
        this.patch(sid, { autoRecover: { attempts, lastAt: new Date(this.t).toISOString() } })
      },
      patchLoss: async (sid, fn) => {
        const r = this.records.get(sid)
        if (!r) return null
        const next = fn(r.restartLoss)
        this.records.set(sid, { ...r, restartLoss: next })
        return next ?? null
      },
      handBack: async (taskId) => {
        this.handBacks.push(taskId)
        const t = this.tasks.get(taskId)
        if (t && (t.phase === 'IN_PROGRESS' || t.phase === 'TODO')) t.phase = 'NEED_ACTION'
      },
      emitNote: (sessionId, _t, message) => { this.notes.push({ sessionId, message }) },
      pendingMessages: async (sid) => this.pending.get(sid) ?? 0,
      onDeliveryFailed: (sid, cb) => {
        this.deliveryFailed.set(sid, cb)
        return () => { this.deliveryFailed.delete(sid) }
      },
      dropMessage: async (sid, messageId) => {
        this.dropped.push({ sid, messageId })
        this.pending.set(sid, 0)
      },
    }
  }

  /** Advance the clock in 1 s steps, running due timers and letting promises settle. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    while (this.t < end) {
      this.t = Math.min(end, this.t + 1000)
      for (let pass = 0; pass < 3; pass++) {
        const due = [...this.timers.values()].filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)
        for (const x of due) { this.timers.delete(x.id); x.fn() }
        for (let i = 0; i < 12; i++) await Promise.resolve()
      }
    }
  }

  loss(sid: string): SessionRestartLoss | undefined { return this.records.get(sid)?.restartLoss }
}

const CFG: AutoRecoverConfig = {
  enabled: true,
  delayMs: 20_000,
  staggerMs: 15_000,
  maxAttempts: 3,
  windowMs: 6 * 3_600_000,
  concurrency: 2,
  maxLoadPerCpu: 1.5,
  loadWaitMs: 10 * 60_000,
  settleTimeoutMs: 180_000,
  retryDelayMs: 120_000,
  ownerWaitMs: 24 * 3_600_000,
}

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    v: 100, cliState: 'dead', turnActive: false, pendingPermission: null,
    gatingBgCount: 0, detachedBgCount: 0, teamActive: false, cronActive: false,
    wakeupAt: null, lastResult: { isError: false, endOffset: 90 }, pid: null, exitCode: null,
    ...over,
  }
}

/** A session the startup reconciler just marked dead (its 'after' record). */
function dead(w: World, sid: string, phase: TaskPhase, opts: {
  snapshot?: SessionSnapshot | null; lastActiveAt?: string; isMain?: boolean; host?: string; before?: SessionRecord['process_status']
} = {}): { rec: SessionRecord; before: SessionRecord } {
  const taskId = `task-${sid}`
  const lastActiveAt = opts.lastActiveAt ?? '2026-10-26T01:50:00.000Z'
  const base = {
    claudeSessionId: sid, taskId, type: 'interactive', archived: false, cwd: '/repo/marina',
    startedAt: '2026-10-25T10:00:00.000Z', lastActiveAt, messageCount: 5, statusRevision: 7,
    ...(opts.host ? { host: opts.host } : {}),
  } as SessionRecord
  const before = { ...base, process_status: opts.before ?? 'running' } as SessionRecord
  const rec = {
    ...base, process_status: 'stopped', status_reason: 'server_restart',
    last_status_change: new Date(w.t).toISOString(), statusRevision: 8,
  } as SessionRecord
  w.records.set(sid, rec)
  w.tasks.set(taskId, { phase, isMain: !!opts.isMain })
  w.snapshots.set(sid, opts.snapshot === undefined ? snap() : opts.snapshot)
  return { rec, before }
}

function make(w: World, cfg: Partial<AutoRecoverConfig> = {}): SessionAutoRecover {
  return new SessionAutoRecover({ ...CFG, ...cfg }, w.deps())
}

// ── Classification at boot ──

describe('boot: only work that was in flight is resumed', () => {
  it('resumes a turn, background commands, an armed wakeup or cron; leaves settled and parked work alone', async () => {
    const w = new World()
    const sar = make(w)
    const cases = [
      dead(w, 'turn', 'IN_PROGRESS', { snapshot: snap({ turnActive: true, lastResult: null }) }),
      dead(w, 'bg', 'IN_PROGRESS', { snapshot: snap({ detachedBgCount: 2 }) }),
      dead(w, 'wake', 'IN_PROGRESS', { snapshot: snap({ wakeupAt: Date.parse('2026-10-26T02:30:00Z') }) }),
      dead(w, 'cron', 'IN_PROGRESS', { snapshot: snap({ cronActive: true }) }),
      dead(w, 'settled', 'IN_PROGRESS'),
      dead(w, 'parked', 'WAITING'),
      dead(w, 'parked-on-own-bg', 'WAITING', { snapshot: snap({ gatingBgCount: 1 }) }),
      dead(w, 'handed', 'NEED_ACTION', { snapshot: snap({ turnActive: true }) }),
      dead(w, 'prompt', 'IN_PROGRESS', { snapshot: snap({ turnActive: true, pendingPermission: { requestId: 'r1' } }) }),
      dead(w, 'old-wake', 'IN_PROGRESS', { snapshot: snap({ wakeupAt: Date.parse('2026-10-20T00:00:00Z') }) }),
    ]
    for (const { rec, before } of cases) expect(sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })).toBe(true)
    await w.advance(1000)

    const verdicts = Object.fromEntries(cases.map(({ rec }) => [rec.claudeSessionId, w.loss(rec.claudeSessionId)?.verdict]))
    expect(verdicts).toEqual({
      turn: 'resume', bg: 'resume', wake: 'resume', cron: 'resume',
      settled: 'settled', parked: 'wait_held', 'parked-on-own-bg': 'resume',
      handed: 'handed_back', prompt: 'waiting_user', 'old-wake': 'settled',
    })
    // Only the settled IN_PROGRESS tasks are handed back (a prompt waits on the user too).
    expect(w.handBacks.sort()).toEqual(['task-old-wake', 'task-prompt', 'task-settled'])
    // Interrupted tasks keep their phase while they wait: never "waiting on the user".
    for (const sid of ['turn', 'bg', 'wake', 'cron']) expect(w.tasks.get(`task-${sid}`)!.phase).toBe('IN_PROGRESS')
    expect(w.tasks.get('task-parked-on-own-bg')!.phase).toBe('WAITING')
    expect(w.tasks.get('task-parked')!.phase).toBe('WAITING')
    // The reboot is named: this machine booted after the sessions last ran.
    expect(w.loss('turn')).toMatchObject({ cause: 'machine_reboot', state: 'queued', lost: ['turn'], told: false, taskDir: '/state/open-walnut/tasks/task-turn' })
    expect(w.loss('bg')).toMatchObject({ lost: ['background'], backgroundCount: 2 })
    // A settled session on a rebooted machine is still told once (its /tmp is gone).
    expect(w.loss('settled')).toMatchObject({ state: 'skipped', told: false })
  })

  it('a server restart (no reboot) does not bother an idle session with a notice', async () => {
    const w = new World()
    const sar = make(w)
    const { rec, before } = dead(w, 's', 'IN_PROGRESS', { lastActiveAt: '2026-10-26T02:00:00.000Z' })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(1000)
    expect(w.loss('s')).toMatchObject({ cause: 'server_restart', verdict: 'settled', told: true })
  })

  it('without a fold (host cannot answer) the record\'s last status decides', async () => {
    const w = new World()
    const sar = make(w)
    const a = dead(w, 'was-running', 'IN_PROGRESS', { snapshot: null, before: 'running' })
    const b = dead(w, 'was-idle', 'IN_PROGRESS', { snapshot: null, before: 'idle' })
    sar.noteLoss(a.rec, 'server_restart', a.before, { requireInfra: false })
    sar.noteLoss(b.rec, 'server_restart', b.before, { requireInfra: false })
    await w.advance(1000)
    expect(w.loss('was-running')?.verdict).toBe('resume')
    expect(w.loss('was-idle')?.verdict).toBe('settled')
  })

  it('a fold that says the process lives: nothing lost, no hand-back', async () => {
    const w = new World()
    const sar = make(w)
    const { rec, before } = dead(w, 'alive', 'IN_PROGRESS', { snapshot: snap({ cliState: 'idle' }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(1000)
    expect(w.loss('alive')).toMatchObject({ state: 'skipped', reason: 'process is alive' })
    expect(w.handBacks).toEqual([])
  })

  it('a missing working directory is not resumed into: handed back with a note', async () => {
    const w = new World()
    w.cwdOk = false
    const sar = make(w)
    const { rec, before } = dead(w, 'gone', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(30_000)
    expect(w.loss('gone')).toMatchObject({ verdict: 'cwd_missing', cwdMissing: true })
    expect(w.sends).toEqual([])
    expect(w.handBacks).toEqual(['task-gone'])
    expect(w.notes.at(-1)?.message).toContain('no longer exists')
  })

  it('Main between turns is not handed back; Main mid-turn is resumed', async () => {
    const w = new World()
    const sar = make(w)
    const idle = dead(w, 'main-idle', 'IN_PROGRESS', { isMain: true })
    const busy = dead(w, 'main-busy', 'IN_PROGRESS', { isMain: true, snapshot: snap({ turnActive: true }) })
    sar.noteLoss(idle.rec, 'server_restart', idle.before, { requireInfra: false })
    sar.noteLoss(busy.rec, 'server_restart', busy.before, { requireInfra: false })
    await w.advance(1000)
    expect(w.handBacks).toEqual([])
    expect(w.loss('main-busy')?.verdict).toBe('resume')
  })
})

// ── The hand-back guard ──

describe('holdsHandBack: interrupted work never reads as waiting on the user', () => {
  it('holds from the reconciler\'s mark, through classification and the queue, and lets go once resolved', async () => {
    const w = new World()
    const sar = make(w)
    const { rec, before } = dead(w, 'x', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    // Before anything stamped it: the reconciler's own hand-back must wait.
    expect(sar.holdsHandBack(rec)).toBe(true)
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(1000)
    expect(w.loss('x')?.state).toBe('queued')
    expect(sar.holdsHandBack(w.records.get('x')!)).toBe(true)
    await w.advance(25_000)
    expect(w.loss('x')?.state).toBe('resumed')
    expect(sar.holdsHandBack(w.records.get('x')!)).toBe(false)
  })

  it('an old unstamped server_restart record does not hold; a disabled scheduler holds nothing', () => {
    const w = new World()
    const { rec } = dead(w, 'x', 'IN_PROGRESS')
    expect(make(w, { enabled: false }).holdsHandBack(rec)).toBe(false)
    w.t += 11 * 60_000
    expect(make(w).holdsHandBack(rec)).toBe(false)
  })

  it('a loss nobody resolved stops holding after the host-wait window', () => {
    const w = new World()
    const { rec } = dead(w, 'x', 'IN_PROGRESS')
    const stuck = { ...rec, restartLoss: { at: new Date(w.t).toISOString(), cause: 'host_restart', lost: ['turn'], verdict: 'resume', state: 'queued' } } as SessionRecord
    const sar = make(w)
    expect(sar.holdsHandBack(stuck)).toBe(true)
    w.t += 25 * 3_600_000
    expect(sar.holdsHandBack(stuck)).toBe(false)
  })
})

// ── The queue ──

describe('resume queue', () => {
  it('sends one resume message per session, through the normal send path, with the restart source', async () => {
    const w = new World()
    const sar = make(w)
    const { rec, before } = dead(w, 'a', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(19_000)
    expect(w.sends).toEqual([])  // a just-booted host settles first
    await w.advance(5_000)
    expect(w.sends).toEqual([{ sessionId: 'a', message: RESUME_MESSAGE, source: AUTO_RECOVER_SOURCE }])
    expect(w.records.get('a')!.autoRecover?.attempts).toBe(1)
    expect(w.notes[0].message).toContain('It will resume automatically')
  })

  it('open turns first, then the most recent work', async () => {
    const w = new World()
    const sar = make(w, { concurrency: 1, staggerMs: 0 })
    const older = dead(w, 'bg-old', 'IN_PROGRESS', { snapshot: snap({ detachedBgCount: 1 }), lastActiveAt: '2026-10-26T01:00:00.000Z' })
    const newer = dead(w, 'bg-new', 'IN_PROGRESS', { snapshot: snap({ detachedBgCount: 1 }), lastActiveAt: '2026-10-26T01:40:00.000Z' })
    const turn = dead(w, 'turn', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }), lastActiveAt: '2026-10-26T00:00:00.000Z' })
    for (const c of [older, newer, turn]) sar.noteLoss(c.rec, 'server_restart', c.before, { requireInfra: false })
    await w.advance(1000)
    expect(sar.queuedIds()).toEqual(['turn', 'bg-new', 'bg-old'])
    await w.advance(60_000)
    expect(w.sends.map((s) => s.sessionId)).toEqual(['turn', 'bg-new', 'bg-old'])
  })

  it('at most `concurrency` resumes in flight per host; the next starts when one is back', async () => {
    const w = new World()
    w.onSend = () => { /* the session stays stopped until we say so */ }
    const sar = make(w, { concurrency: 2, staggerMs: 0 })
    for (const sid of ['a', 'b', 'c', 'd']) {
      const c = dead(w, sid, 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
      sar.noteLoss(c.rec, 'server_restart', c.before, { requireInfra: false })
    }
    await w.advance(25_000)
    expect(w.sends).toHaveLength(2)
    expect(sar.inFlightIds()).toHaveLength(2)
    w.patch(w.sends[0].sessionId, { process_status: 'running' })
    await w.advance(3_000)
    expect(w.sends).toHaveLength(3)
    // A resume that never reports back frees its slot at the settle timeout.
    await w.advance(180_000)
    expect(w.sends).toHaveLength(4)
    expect(w.loss(w.sends[1].sessionId)?.state).toBe('sent')
  })

  it('remote hosts have their own slots and are not load gated', async () => {
    const w = new World()
    w.load = 9
    const sar = make(w, { concurrency: 1, staggerMs: 0 })
    const local = dead(w, 'local', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    const remote = dead(w, 'remote', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }), host: 'devbox' })
    sar.noteLoss(local.rec, 'server_restart', local.before, { requireInfra: false })
    sar.noteLoss(remote.rec, 'host_restart', remote.before, { requireInfra: false })
    await w.advance(25_000)
    expect(w.sends.map((s) => s.sessionId)).toEqual(['remote'])
    expect(w.loss('remote')?.cause).toBe('host_restart')
  })

  it('a busy machine (just booted) holds new resumes; past the wait they go one at a time', async () => {
    const w = new World()
    w.load = 3.2
    w.onSend = () => { /* stays stopped: holds its slot */ }
    const sar = make(w, { concurrency: 2, staggerMs: 0, loadWaitMs: 5 * 60_000, settleTimeoutMs: 180_000 })
    for (const sid of ['a', 'b']) {
      const c = dead(w, sid, 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
      sar.noteLoss(c.rec, 'server_restart', c.before, { requireInfra: false })
    }
    await w.advance(4 * 60_000)
    expect(w.sends).toEqual([])
    await w.advance(2 * 60_000)
    expect(w.sends).toHaveLength(1)  // one at a time while still busy
    await w.advance(30_000)
    expect(w.sends).toHaveLength(1)
    w.load = 0.8  // the machine settles: the normal caps apply again
    await w.advance(40_000)
    expect(w.sends).toHaveLength(2)
  })

  it('a session that came back on its own (someone else sent first) is not sent a second message', async () => {
    const w = new World()
    const sar = make(w)
    const { rec, before } = dead(w, 'a', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(5_000)
    w.patch('a', { process_status: 'running' })  // a human typed into it
    await w.advance(30_000)
    expect(w.sends).toEqual([])
    expect(w.loss('a')).toMatchObject({ state: 'resumed', reason: 'resumed by another message' })
  })

  it('a task the human moved meanwhile (done, handed back, parked) is left alone', async () => {
    const w = new World()
    const sar = make(w)
    const { rec, before } = dead(w, 'a', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(5_000)
    w.tasks.get('task-a')!.phase = 'COMPLETE'
    await w.advance(30_000)
    expect(w.sends).toEqual([])
    expect(w.loss('a')).toMatchObject({ state: 'skipped', reason: 'task moved to COMPLETE' })
  })

  it('a session its host daemon supervises is left to the daemon', async () => {
    const w = new World()
    w.owner = 'daemon'
    const sar = make(w)
    const { rec, before } = dead(w, 'a', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(30_000)
    expect(w.sends).toEqual([])
    expect(w.loss('a')?.state).toBe('skipped')
  })

  it('an offline host keeps its sessions queued until it returns; never past the host-wait window', async () => {
    const w = new World()
    w.owner = 'unknown'
    const sar = make(w, { ownerWaitMs: 10 * 60_000 })
    const a = dead(w, 'a', 'IN_PROGRESS', { snapshot: null, host: 'devbox' })
    sar.noteLoss(a.rec, 'host_restart', a.before, { requireInfra: false })
    await w.advance(3 * 60_000)
    expect(w.sends).toEqual([])
    expect(sar.queuedIds()).toEqual(['a'])
    w.owner = 'server'  // the host is back
    await w.advance(61_000)
    expect(w.sends.map((s) => s.sessionId)).toEqual(['a'])

    const w2 = new World()
    w2.owner = 'unknown'
    const sar2 = make(w2, { ownerWaitMs: 10 * 60_000 })
    const b = dead(w2, 'b', 'IN_PROGRESS', { snapshot: null, host: 'devbox' })
    sar2.noteLoss(b.rec, 'host_restart', b.before, { requireInfra: false })
    await w2.advance(12 * 60_000)
    expect(w2.loss('b')?.state).toBe('gave_up')
    expect(w2.handBacks).toEqual(['task-b'])
    expect(w2.notes.at(-1)?.message).toContain('did not come back')
  })

  it('a failed spawn is retried within the persisted budget, then handed back', async () => {
    const w = new World()
    w.onSend = (sid) => { w.patch(sid, { process_status: 'error', errorMessage: 'spawn failed' }) }
    const sar = make(w, { retryDelayMs: 60_000 })
    const { rec, before } = dead(w, 'a', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(10 * 60_000)
    expect(w.sends).toHaveLength(3)
    expect(w.records.get('a')!.autoRecover?.attempts).toBe(3)
    expect(w.loss('a')?.state).toBe('gave_up')
    expect(w.handBacks).toEqual(['task-a'])
  })

  // 2026-10-26: the user's login on the Mac ended; for hours the session daemon
  // could not start ("port file not created within 30s"). A resume then puts its
  // message back in the queue and reports delivery_failed; the record is not touched.
  const DAEMON_DOWN = 'Local daemon failed to start — port file not created within 30s, and the Walnut Sessions host (pid 44765) is still running'
  function hostCannotTake(w: World): void {
    w.onSend = (sid) => {
      w.pending.set(sid, 1)
      queueMicrotask(() => w.deliveryFailed.get(sid)?.(DAEMON_DOWN))
    }
  }

  it('a resume the host daemon could not take waits for the host: no attempt spent, no second send, the task held', async () => {
    const w = new World()
    hostCannotTake(w)
    const sar = make(w)
    const { rec, before } = dead(w, 'a', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(2 * 3_600_000)
    expect(w.sends).toHaveLength(1)
    expect(w.records.get('a')!.autoRecover?.attempts).toBe(0)
    expect(w.loss('a')).toMatchObject({ state: 'queued', waitingHost: { error: DAEMON_DOWN } })
    expect(w.loss('a')?.reason).toContain("this computer's session daemon")
    expect(sar.holdsHandBack(w.records.get('a')!)).toBe(true)
    expect(w.handBacks).toEqual([])
    // The new login's daemon serves: its reconnect delivers the queued message.
    w.pending.set('a', 0)
    w.patch('a', { process_status: 'running' })
    await w.advance(61_000)
    expect(w.sends).toHaveLength(1)
    expect(w.loss('a')).toMatchObject({ state: 'resumed' })
    expect(w.loss('a')?.waitingHost).toBeUndefined()
    expect(w.handBacks).toEqual([])
  })

  it('a host that never takes the resume is handed back after the host-wait window, with the daemon error as the reason', async () => {
    const w = new World()
    hostCannotTake(w)
    const sar = make(w, { ownerWaitMs: 30 * 60_000 })
    const { rec, before } = dead(w, 'a', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(40 * 60_000)
    expect(w.sends).toHaveLength(1)
    expect(w.loss('a')?.state).toBe('gave_up')
    expect(w.handBacks).toEqual(['task-a'])
    expect(w.notes.at(-1)?.message).toContain("this computer's session daemon could not take the resume")
    expect(w.notes.at(-1)?.message).toContain('port file not created')
    // The queued resume is removed, so it never goes out after the hand-back.
    expect(w.dropped).toEqual([{ sid: 'a', messageId: expect.stringMatching(/^qm-recover-/) }])
  })

  it('a queued message that left without bringing the session back is judged afresh (a normal attempt)', async () => {
    const w = new World()
    hostCannotTake(w)
    const sar = make(w)
    const { rec, before } = dead(w, 'a', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(5 * 60_000)
    expect(w.loss('a')?.waitingHost).toBeDefined()
    // The batch was parked (or delivered and died): nothing waits in the queue any more.
    w.pending.set('a', 0)
    w.onSend = (sid) => { w.patch(sid, { process_status: 'running' }) }
    await w.advance(61_000)
    expect(w.sends).toHaveLength(2)
    expect(w.loss('a')?.state).toBe('resumed')
  })

  it('a send that throws goes back to the queue and is retried', async () => {
    const w = new World()
    let fail = true
    const sar = new SessionAutoRecover({ ...CFG, retryDelayMs: 30_000 }, {
      ...w.deps(),
      send: async (sessionId, message, opts) => {
        if (fail) { fail = false; throw new Error('queue write failed') }
        w.sends.push({ sessionId, message, source: opts.source })
        w.patch(sessionId, { process_status: 'running' })
      },
    })
    const { rec, before } = dead(w, 'a', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(25_000)
    expect(w.sends).toEqual([])
    await w.advance(35_000)
    expect(w.sends).toHaveLength(1)
    expect(w.loss('a')?.state).toBe('resumed')
  })
})

// ── Duplicates, budgets and a restart in the middle ──

describe('no double recovery', () => {
  it('a second report of the same death is ignored, while tracked and after it is decided', async () => {
    const w = new World()
    const sar = make(w)
    const { rec, before } = dead(w, 'p', 'WAITING')
    expect(sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })).toBe(true)
    expect(sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })).toBe(false)
    await w.advance(1000)
    const decided = w.records.get('p')!
    expect(decided.restartLoss?.verdict).toBe('wait_held')
    expect(sar.wouldAttempt(decided, { requireInfra: false })).toEqual({ ok: false, reason: 'already-decided' })
    // A later life and a new death (its status moved on) is a new loss.
    w.patch('p', { process_status: 'stopped' })
    expect(sar.wouldAttempt(w.records.get('p')!, { requireInfra: false })).toEqual({ ok: true })
  })

  it('a session that spent its budget (a reboot loop) is not taken on', () => {
    const w = new World()
    const { rec } = dead(w, 'loop', 'IN_PROGRESS')
    const spent = { ...rec, autoRecover: { attempts: 3, lastAt: new Date(w.t - 60_000).toISOString() } } as SessionRecord
    expect(make(w).wouldAttempt(spent, { requireInfra: false })).toEqual({ ok: false, reason: 'session-budget' })
  })

  it('a restart mid-recovery: the next boot picks up queued and unclassified losses, not finished ones', async () => {
    const w = new World()
    const first = make(w, { concurrency: 1, staggerMs: 60_000 })
    for (const sid of ['a', 'b', 'c']) {
      const c = dead(w, sid, 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
      first.noteLoss(c.rec, 'server_restart', c.before, { requireInfra: false })
    }
    await w.advance(25_000)
    expect(w.sends.map((s) => s.sessionId)).toHaveLength(1)
    // The server dies here, and the session it just resumed dies with it.
    first.stop()
    expect(w.sends[0].sessionId).toBe('a')
    expect(w.loss('a')?.state).toBe('resumed')
    w.patch('a', { process_status: 'stopped', status_reason: 'server_restart', last_status_change: new Date(w.t).toISOString() })
    // One more was still unclassified when the server died.
    const d = dead(w, 'd', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    w.records.set('d', { ...d.rec, restartLoss: { at: new Date(w.t).toISOString(), cause: 'server_restart', lost: [], state: 'pending' } })

    const second = make(w, { concurrency: 4, staggerMs: 0 })
    // The reconciler reports 'a' again: a new death, so a new loss on the same budget.
    expect(second.noteLoss(w.records.get('a')!, 'server_restart', { ...w.records.get('a')!, process_status: 'running' }, { requireInfra: false })).toBe(true)
    expect(await second.resumeUnfinished()).toBe(3)  // b, c still queued + d unclassified
    await w.advance(25_000)
    const counts = w.sends.reduce<Record<string, number>>((m, s) => ({ ...m, [s.sessionId]: (m[s.sessionId] ?? 0) + 1 }), {})
    expect(counts).toEqual({ a: 2, b: 1, c: 1, d: 1 })
    expect(w.records.get('a')!.autoRecover?.attempts).toBe(2)
  })
})

describe('review findings: facts and holds across lives', () => {
  it('an earlier life\'s resolved loss does not stop the hold on a new death', () => {
    const w = new World()
    const { rec } = dead(w, 'x', 'IN_PROGRESS')
    const old = { ...rec, statusRevision: 12, restartLoss: { at: new Date(w.t - 2 * 3_600_000).toISOString(), cause: 'server_restart', lost: ['turn'], verdict: 'resume', state: 'resumed', revision: 9 } } as SessionRecord
    expect(make(w).holdsHandBack(old)).toBe(true)
    // The same death, decided and not resumed: no hold.
    expect(make(w).holdsHandBack({ ...old, restartLoss: { ...old.restartLoss!, state: 'skipped', revision: 12 } })).toBe(false)
  })

  it('a sent resume holds only through its settle window', () => {
    const w = new World()
    const { rec } = dead(w, 'x', 'IN_PROGRESS')
    const sent = { ...rec, status_reason: 'snapshot_projection', restartLoss: { at: new Date(w.t).toISOString(), sentAt: new Date(w.t).toISOString(), cause: 'machine_reboot', lost: ['turn'], verdict: 'resume', state: 'sent' } } as SessionRecord
    const sar = make(w)
    expect(sar.holdsHandBack(sent)).toBe(true)
    w.t += 4 * 60_000
    expect(sar.holdsHandBack(sent)).toBe(false)
  })

  it('a restart during classification decides on the stored facts of the death, not the rewritten record', async () => {
    const w = new World()
    const { rec } = dead(w, 'p', 'IN_PROGRESS', { snapshot: null })
    // The record was rewritten since (stopped, activity moved to the first boot).
    w.records.set('p', { ...rec, process_status: 'stopped', lastActiveAt: new Date(w.t).toISOString(), restartLoss: {
      at: new Date(w.t).toISOString(), cause: 'server_restart', lost: [], state: 'pending',
      before: { status: 'running', lastActiveAt: '2026-10-26T01:50:00.000Z', permission: false },
    } })
    const sar = make(w)
    expect(await sar.resumeUnfinished()).toBe(1)
    await w.advance(1000)
    expect(w.loss('p')).toMatchObject({ verdict: 'resume', cause: 'machine_reboot', lost: ['turn'] })
  })

  it('a runtime report with no fold (old daemon) still resumes, as before', async () => {
    const w = new World()
    const sar = make(w)
    const { rec } = dead(w, 'r', 'IN_PROGRESS', { snapshot: null, host: 'devbox' })
    const relabelled = { ...rec, status_reason: 'auto_recovered_dead', errorKind: 'infra' } as SessionRecord
    w.records.set('r', relabelled)
    expect(sar.schedule(relabelled, 'remote_unreachable')).toBe(true)
    await w.advance(1000)
    expect(w.loss('r')).toMatchObject({ verdict: 'resume', cause: 'host_restart' })
  })

  it('an error already on the record before the send is not this spawn\'s failure', async () => {
    const w = new World()
    w.onSend = () => { /* still booting: the record keeps its old error */ }
    const sar = make(w, { retryDelayMs: 30_000 })
    const { rec, before } = dead(w, 'e', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    w.records.set('e', { ...rec, process_status: 'error' })
    sar.noteLoss(w.records.get('e')!, 'server_restart', before, { requireInfra: false })
    await w.advance(5 * 60_000)
    expect(w.sends).toHaveLength(1)
  })

  it('a classification that fails hands the task back instead of holding it', async () => {
    const w = new World()
    const sar = new SessionAutoRecover(CFG, { ...w.deps(), getTask: async (id) => { if (id === 'task-f' && !failed) { failed = true; throw new Error('db down') } return w.tasks.get(id) ?? null } })
    let failed = false
    const { rec, before } = dead(w, 'f', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    sar.noteLoss(rec, 'server_restart', before, { requireInfra: false })
    await w.advance(2000)
    expect(w.loss('f')?.state).toBe('gave_up')
    expect(w.handBacks).toEqual(['task-f'])
    expect(sar.holdsHandBack(w.records.get('f')!)).toBe(false)
  })

  it('a notice told in an earlier life is told again for a new death', async () => {
    const w = new World()
    const sar = make(w)
    const { rec, before } = dead(w, 't', 'IN_PROGRESS', { snapshot: snap({ turnActive: true }) })
    w.records.set('t', { ...rec, restartLoss: { at: 'x', cause: 'server_restart', lost: [], state: 'skipped', verdict: 'settled', told: true, revision: 3 } })
    sar.noteLoss(w.records.get('t')!, 'server_restart', before, { requireInfra: false })
    await w.advance(1000)
    expect(w.loss('t')).toMatchObject({ verdict: 'resume', told: false })
  })
})

describe('config', () => {
  it('defaults and the opt-out', () => {
    const prev = process.env.WALNUT_AUTO_RECOVER_ENABLED
    try {
      delete process.env.WALNUT_AUTO_RECOVER_ENABLED
      expect(resolveAutoRecoverConfig()).toMatchObject({ enabled: true, concurrency: 2, maxAttempts: 3, maxLoadPerCpu: 3 })
      process.env.WALNUT_AUTO_RECOVER_ENABLED = '0'
      expect(resolveAutoRecoverConfig().enabled).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.WALNUT_AUTO_RECOVER_ENABLED
      else process.env.WALNUT_AUTO_RECOVER_ENABLED = prev
    }
  })
  it('a disabled scheduler takes nothing on', () => {
    const w = new World()
    const { rec, before } = dead(w, 'a', 'IN_PROGRESS')
    expect(make(w, { enabled: false }).noteLoss(rec, 'server_restart', before, { requireInfra: false })).toBe(false)
  })
})
