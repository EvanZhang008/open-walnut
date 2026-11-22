/**
 * The resend family on a host that runs its sessions (src/core/session-channel/host-resend.ts):
 * before, every member started only on the leader (web/server.ts role() === 'leader' and the
 * primary-store jobs), so on a host none ran at all, and the leader skips a host-judged session:
 * nobody resent. Now the host starts each one, and each acts for this host's own rows only.
 *
 * Real: a host replica's role, its own-row writer, a row it owns and a row the leader's copy brought,
 * the real modules and bus. The judge gate is wrapped to count what reaches each member's handler.
 * Guards:
 *   - every member of the plan's section 5 table is started here, and each one's bus handler passes
 *     an event of the own row to the member and drops one of the copied row;
 *   - the boot scans (judgedHereRecords) read only the own row;
 *   - a respawn due while the leader is away waits for it, and gives way to a send meanwhile;
 *   - a turn end of an own session is stamped with the retrier of this host that took it;
 *   - a give-up's phase edge on an own session goes to the leader as a retry-over fact.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-resend', { CLOUD_MODE: false }))

/** Per subscriber handler: the session ids its member was handed. */
const reached = new Map<(e: unknown) => unknown, string[]>()
vi.mock('../../../src/core/sessions/judge-of.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/sessions/judge-of.js')>()
  return {
    ...real,
    judgedHereOnly: <E extends { data: unknown }, R>(handler: (event: E) => R) => {
      const seen: string[] = []
      const counted = (event: E) => { const sid = (event.data as { sessionId?: string } | null)?.sessionId; if (sid) seen.push(sid); return undefined as unknown as R }
      const wrapped = real.judgedHereOnly(counted)
      reached.set(wrapped as unknown as (e: unknown) => unknown, seen)
      void handler
      return wrapped
    },
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting, setLeaderPresence } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { judgedHereRecords } from '../../../src/core/sessions/judge-of.js'
import { leaderPromptRunner, startHostResendFamily, turnEndStamp, whenLeaderAnswers, type HostResendFamily } from '../../../src/core/session-channel/host-resend.js'
import { __setTurnRetrierForTesting } from '../../../src/core/sessions/turn-run.js'
import { applySessionPhase } from '../../../src/core/phase.js'

const KEY = 'devbox'
const OWN = 'host-own-resend'
const COPY = 'leader-copy-resend'

/** The bus subscribers each member registers (src/core/... startX), name -> module. */
const GATED_MEMBERS = [
  'queue-after-turn', 'idle-compaction', 'prompt-refresh-respawn', 'context-full-recovery', 'safeguard-switch',
  'model-restore', 'session-auto-continue', 'session-endpoint-wait', 'session-usage-limit-wait',
]

const subscribed = new Map<string, (e: BusEvent) => unknown>()
let family: HostResendFamily | null = null

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER', 'WALNUT_HOST_KEY']) delete process.env[k]
  process.env.WALNUT_ENDPOINT_WAIT = '1'
  process.env.WALNUT_USAGE_LIMIT_WAIT = '1'
  _resetServerRoleForTesting()
  // The leader's copy, as it reaches the host: a row of the leader's.
  sessionDb.applySessionCopy({ rows: [{ claudeSessionId: COPY, taskId: '', project: 'p', process_status: 'idle', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } as never] })
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  // Now a host replica that runs its sessions: its own row.
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_HOST_KEY = KEY
  _resetServerRoleForTesting()
  sessionDb.allowOwnRowWrites(KEY)
  await tracker.createSessionRecord(OWN, '', 'Marina', '/tmp', { host: KEY, judge: 'host' } as never)
  const sub = bus.subscribe.bind(bus)
  vi.spyOn(bus, 'subscribe').mockImplementation(((name: string, handler: (e: BusEvent) => unknown, filter?: unknown) => {
    subscribed.set(name, handler)
    return (sub as (...a: unknown[]) => unknown)(name, handler, filter)
  }) as never)
  family = await startHostResendFamily()
}, 60_000)

afterAll(async () => {
  family?.stop()
  vi.restoreAllMocks()
  sessionDb.allowOwnRowWrites(null)
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY', 'WALNUT_ENDPOINT_WAIT', 'WALNUT_USAGE_LIMIT_WAIT']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the resend family runs on a host for its own rows only', () => {
  it('starts every member of the table here', () => {
    for (const name of [...GATED_MEMBERS, 'turn-run']) expect(subscribed.has(name), name).toBe(true)
  })

  for (const name of GATED_MEMBERS) {
    it(`${name}: an event of the own row reaches the member, one of the copied row does not`, () => {
      const handler = subscribed.get(name)!
      const seen = reached.get(handler as never)
      expect(seen, `${name} subscribes through judgedHereOnly`).toBeDefined()
      seen!.length = 0
      const ev = (sid: string): BusEvent => ({ name: 'session:probe', data: { sessionId: sid }, destinations: [], urgency: 'normal', timestamp: Date.now(), source: 'test', traceId: 't' })
      handler(ev(OWN))
      handler(ev(COPY))
      expect(seen).toEqual([OWN])
    })
  }

  it('the boot scans read only the own row', async () => {
    const rows = judgedHereRecords(await tracker.listSessions())
    expect(rows.map((r) => r.claudeSessionId)).toEqual([OWN])
  })
})

describe('a respawn on the current prompt waits for the leader', () => {
  it('goes once the leader answers again', async () => {
    let answers = false
    let polls = 0
    const ok = await whenLeaderAnswers(() => true, { answers: () => answers, sleep: async () => { if (++polls === 3) answers = true }, pollMs: 1 })
    expect(ok).toBe(true)
    expect(polls).toBe(3)
  })

  it('gives way to a send that came meanwhile, and to a wait that ran out', async () => {
    let wanted = true
    let polls = 0
    expect(await whenLeaderAnswers(() => wanted, { answers: () => false, sleep: async () => { if (++polls === 2) wanted = false } })).toBe(false)
    let t = 0
    expect(await whenLeaderAnswers(() => true, { answers: () => false, sleep: async () => { t += 10 }, now: () => t, maxMs: 30 })).toBe(false)
  })

  it('the runner the prompt refresh is handed respawns only after the wait', async () => {
    const calls: string[] = []
    const runner = { respawnOnCurrentPrompt: async (id: string) => { calls.push(id); return 'respawned' as const }, other: () => 'x' }
    let release: (v: boolean) => void = () => {}
    const gated = leaderPromptRunner(runner, () => new Promise<boolean>((r) => { release = r }))
    const p = gated.respawnOnCurrentPrompt(OWN, () => true)
    await new Promise((r) => setTimeout(r, 5))
    expect(calls).toEqual([])
    release(true)
    expect(await p).toBe('respawned')
    expect(calls).toEqual([OWN])
    expect(gated.other()).toBe('x')
    const away = leaderPromptRunner(runner, async () => false)
    expect(await away.respawnOnCurrentPrompt(OWN, () => true)).toBe('gave-way')
    expect(calls).toEqual([OWN])
  })

  it('the host role reads its leader\'s presence', async () => {
    setLeaderPresence(false, 'test')
    let polls = 0
    const p = whenLeaderAnswers(() => polls < 50, { sleep: async () => { if (++polls === 2) setLeaderPresence(true, 'test') } })
    expect(await p).toBe(true)
  })
})

describe('what the leader learns of a host retrier', () => {
  it('a turn end is stamped with the retrier that took it here, in its own tick', async () => {
    await __setTurnRetrierForTesting('auto_continue', { reason: 'auto_continue', sources: [], takes: (end) => end.sessionId === OWN && end.isError, wait: () => null, keep: () => false })
    try {
      const stamp = await turnEndStamp()
      expect(stamp('session:result', { sessionId: OWN, isError: true, result: 'API Error: overloaded' })).toMatchObject({ hostTakenBy: 'auto_continue' })
      expect(stamp('session:result', { sessionId: OWN, isError: false, result: 'done' })).toMatchObject({ hostTakenBy: null })
      expect(stamp('session:error', { sessionId: OWN, error: 'died' })).toMatchObject({ hostTakenBy: 'auto_continue' })
      const other = { sessionId: OWN, text: 'x' }
      expect(stamp('session:text-delta', other)).toBe(other)
    } finally {
      await __setTurnRetrierForTesting('auto_continue', null)
    }
  })

  it('a give-up\'s phase edge on an own session goes to the leader as a retry-over fact; a plain edge does not', async () => {
    const got: unknown[] = []
    bus.subscribe('host-retry-over', (e) => { if (e.name === EventNames.SESSION_RETRY_OVER) got.push(e.data) })
    try {
      await applySessionPhase('task-on-leader', 'session:error', 'usage-limit-wait:gave_up', { sessionId: OWN, retryOver: true })
      await applySessionPhase('task-on-leader', 'session:result', 'server.ts:session-result', { sessionId: OWN })
      expect(got).toEqual([{ sessionId: OWN, taskId: 'task-on-leader', phase: { trigger: 'session:error', why: 'usage-limit-wait:gave_up' } }])
    } finally {
      bus.unsubscribe('host-retry-over')
    }
  })
})
