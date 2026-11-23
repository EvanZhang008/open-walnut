/**
 * A session a start handed this host is the host's from its first write, whatever copy of the
 * leader's row arrives and in whatever order (session-db.ts claimStartingRow, applySessionCopy;
 * sessions/starting-claims.ts). The leader marks its seed row this host's before it sends the start,
 * but the host's copy of the seed may still be the version from before the mark: without the claim
 * the own-row writer refused every write of that row, the session's row was never this host's, and
 * the emitter dropped its first facts (a bench run lost 5 to 10 s of one session's tool calls).
 *
 * Real pieces: the host replica's store with its own-row writer, the tracker, the row hook, the
 * emitter and the fact log; the bus is a plain EventBus standing in for the runner's events.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-start-claim', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import { EventBus } from '../../../src/core/event-bus.js'
import { FactLog } from '../../../src/core/session-channel/fact-log.js'
import { createHostEmitter, type HostEmitter } from '../../../src/core/session-channel/host-emitter.js'
import { _resetStartingClaimsForTesting } from '../../../src/core/sessions/starting-claims.js'
import type { SessionRecord } from '../../../src/core/types.js'

const KEY = 'devbox'
const SID_BEFORE = 'aaaaaaaa-0001-4001-8001-000000000001'
const SID_AFTER = 'aaaaaaaa-0002-4002-8002-000000000002'
const SID_FAILED = 'aaaaaaaa-0003-4003-8003-000000000003'
const SID_UNCLAIMED = 'aaaaaaaa-0004-4004-8004-000000000004'

/** The leader's seed as its copy may come down: this host's key, but not judged here yet (from before handSeedToHost). */
const preJudgeSeed = (sid: string): SessionRecord => ({
  claudeSessionId: sid, taskId: `task-${sid.slice(-4)}`, project: 'Acme', process_status: 'running', mode: 'default',
  startedAt: '2026-11-23T00:00:00.000Z', lastActiveAt: '2026-11-23T00:00:00.000Z', messageCount: 1, host: KEY, title: 'Busy build',
} as SessionRecord)

let dir = ''
let log: FactLog
let bus: EventBus
let emitter: HostEmitter

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER']) delete process.env[k]
  _resetServerRoleForTesting()
  // The store exists (as the leader's copy makes it), then this process is the host replica.
  sessionDb.applySessionCopy({ rows: [] })
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_HOST_KEY = KEY
  _resetServerRoleForTesting()
  sessionDb.allowOwnRowWrites(KEY)
})

afterAll(async () => {
  sessionDb.allowOwnRowWrites(null)
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  _resetStartingClaimsForTesting()
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-start-claim-'))
  log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
  bus = new EventBus()
  // The real row hook (session-tracker.ts noteSessionRowWritten): the emitter hears every own row written.
  emitter = createHostEmitter({ log, channel: null, hostKey: KEY, ownRows: async () => [], bus, pendingMs: 300 })
  await emitter.start()
})

afterEach(async () => {
  emitter.stop()
  await log.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

/** The runner's first lines of a busy turn: each step a tool call and its result. */
function emitSteps(sid: string, from: number, n: number): void {
  for (let i = from; i < from + n; i++) {
    bus.emit('session:tool-use', { sessionId: sid, toolName: 'Bash', toolUseId: `toolu_${i}`, input: { command: `npm test -- --shard ${i}` } }, ['main-ai'])
    bus.emit('session:tool-result', { sessionId: sid, toolUseId: `toolu_${i}`, result: `PASS shard ${i}` }, ['main-ai'])
  }
}

/** The records of `sid` in the fact log, by name. */
async function logged(sid: string): Promise<string[]> {
  await log.flush()
  return (await log.read(0)).filter((r) => r.sid === sid).map((r) => (r.name === 'row' ? (r.data as { born?: boolean }).born ? 'row:born' : 'row' : r.name))
}

/** The runner's own writes of its session's row, as the host's port makes them (host-port.ts: this host's key). */
async function runnerWrites(sid: string): Promise<void> {
  await tracker.createSessionRecord(sid, `task-${sid.slice(-4)}`, 'Acme', '/work', { host: KEY, pid: 4242 })
  await tracker.updateSessionRecord(sid, { process_status: 'running', activity: 'writing' })
}

describe('a start the leader handed this host claims its session\'s row', () => {
  it('the copy from before the leader\'s mark came first: the start claims it, the runner\'s writes go through, and every first fact reaches the log', async () => {
    sessionDb.applySessionCopy({ ownHost: KEY, rows: [preJudgeSeed(SID_BEFORE)] })
    sessionDb.claimStartingRow(SID_BEFORE)
    // The CLI's first lines can beat the row's first write: held, then kept after the row is born.
    emitSteps(SID_BEFORE, 0, 5)
    await runnerWrites(SID_BEFORE)
    emitSteps(SID_BEFORE, 5, 5)
    const names = await logged(SID_BEFORE)
    expect(names[0]).toBe('row:born')
    expect(names.filter((n) => n === 'session:tool-use')).toHaveLength(10)
    expect(names.filter((n) => n === 'session:tool-result')).toHaveLength(10)
    expect(await tracker.getSessionByClaudeId(SID_BEFORE)).toMatchObject({ host: KEY, judge: 'host', pid: 4242 })
  })

  it('the copy from before the mark comes after the start: it never takes the row back, and the writes after it still go through', async () => {
    sessionDb.claimStartingRow(SID_AFTER)
    await runnerWrites(SID_AFTER)
    emitSteps(SID_AFTER, 0, 3)
    // A replication round that still carries the old version of the seed.
    sessionDb.applySessionCopy({ ownHost: KEY, rows: [{ ...preJudgeSeed(SID_AFTER), human_note: 'from the leader' } as SessionRecord] })
    const row = await tracker.getSessionByClaudeId(SID_AFTER)
    expect(row).toMatchObject({ host: KEY, judge: 'host', pid: 4242, human_note: 'from the leader' })
    await tracker.updateSessionRecord(SID_AFTER, { activity: 'thinking' })
    emitSteps(SID_AFTER, 3, 3)
    const names = await logged(SID_AFTER)
    expect(names[0]).toBe('row:born')
    expect(names.filter((n) => n === 'session:tool-use')).toHaveLength(6)
  })

  it('the copy from before the mark comes after the claim but before any write: it comes down as this host\'s', async () => {
    const sid = 'aaaaaaaa-0005-4005-8005-000000000005'
    sessionDb.claimStartingRow(sid)
    sessionDb.applySessionCopy({ ownHost: KEY, rows: [preJudgeSeed(sid)] })
    await runnerWrites(sid)
    expect(await tracker.getSessionByClaudeId(sid)).toMatchObject({ host: KEY, judge: 'host' })
  })

  it('a start that failed gives the row back as the copy had it', async () => {
    sessionDb.applySessionCopy({ ownHost: KEY, rows: [preJudgeSeed(SID_FAILED)] })
    sessionDb.claimStartingRow(SID_FAILED)
    expect((await tracker.getSessionByClaudeId(SID_FAILED))?.judge).toBe('host')
    sessionDb.releaseStartingRow(SID_FAILED)
    const row = await tracker.getSessionByClaudeId(SID_FAILED)
    expect(row?.judge).toBeUndefined()
    // The leader's again: its copy is no longer merged as this host's, and the host cannot write it.
    await expect(tracker.updateSessionRecord(SID_FAILED, { activity: 'writing' })).rejects.toThrow(sessionDb.NOT_OWN_ROW)
  })

  it('a row no start claimed stays the leader\'s: the own-row writer still refuses it', async () => {
    sessionDb.applySessionCopy({ ownHost: KEY, rows: [preJudgeSeed(SID_UNCLAIMED)] })
    await expect(tracker.updateSessionRecord(SID_UNCLAIMED, { activity: 'writing' })).rejects.toThrow(sessionDb.NOT_OWN_ROW)
    expect((await tracker.getSessionByClaudeId(SID_UNCLAIMED))?.judge).toBeUndefined()
  })
})
