/**
 * The Mac back from sleep, after a host started a claude-code routine's run itself
 * (clock-host-start-v1): the run reaches the Mac twice, as a fire the host marked
 * `started` and as the `task-create` + `session` records of its offline journal, in
 * either order. Whatever the order, the Mac records the run once (History row, the
 * routine's last run), starts nothing (the executor is never called), and adopts the
 * session once, as this Mac files a routine's run: the routine's title and project,
 * never pinned, its folder on the task, the session on that host, no ask stamp.
 *
 * A real cron store, task store and session tracker on a temp home; the daemon's fire
 * and records are hand-written in the shapes the twins send (the ids derived by the
 * same core the twins run; tests/integration/clock-routine-twins.test.ts holds the
 * twins to them).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import crypto from 'node:crypto'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-clock-host-start-mac'))
const cron = vi.hoisted(() => ({ service: null as unknown }))
vi.mock('../../../src/web/routes/cron.js', () => ({ getCronService: () => cron.service }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { CronService } from '../../../src/core/cron/service.js'
import { handleTriggerFired } from '../../../src/core/routines/trigger-events.js'
import { setTriggerDaemonLookupForTest } from '../../../src/core/routines/trigger-daemon.js'
import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { getTask } from '../../../src/core/task-manager.js'
import { getSessionByClaudeId, getSessionsForTaskSync } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/task-db.js'
import { createClockHostStart } from '../../../src/providers/clock-host-start-core.js'
import type { TriggerFiredEvent } from '../../../src/providers/trigger-check-core.js'
import type { CronJob } from '../../../src/core/cron/types.js'

const HOST = 'marina'
const HOUR = 3_600_000
const BASE = Date.UTC(2026, 9, 23, 12, 0, 0)
const slot = (n: number) => BASE + n * HOUR
const CWD = '/srv/marina/repo'

const ids = createClockHostStart({ sha256: (t: string) => crypto.createHash('sha256').update(t).digest('hex') } as never)

let counter = 0
let runExecutor: ReturnType<typeof vi.fn>
let acks: Array<Record<string, unknown>>
let seqN = 9000

function service(): CronService {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return new CronService({
    nowMs: () => slot(1) + 5 * 60_000, log, storePath: path.join(WALNUT_HOME, `cron-${++counter}.json`), cronEnabled: false,
    broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }), runExecutor, onEvent: vi.fn(),
  } as never)
}

/** A claude-code routine on the host, its clock handed to that host's daemon. */
async function hostedRoutine(s: CronService, name: string, over: Record<string, unknown> = {}): Promise<CronJob> {
  const job = await s.add({
    name, enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
    executor: { type: 'claude-code', config: { cwd: CWD, host: HOST, instructions: 'Write the nightly report', ...over } },
  })
  await s.placeClocks(HOST, { wanted: new Set([job.id]), handover: true, knownHosts: new Set([HOST]), eligible: () => true })
  const placed = (await s.list({ includeDisabled: true, recompute: false })).find((j) => j.id === job.id)!
  const fromMs = placed.state.clockFromMs!
  expect(placed.state.clockHost).toBe(HOST)
  await s.settleClocks(HOST, { clocks: [{ id: job.id, fromMs, nextRunAtMs: fromMs }] })
  return (await s.list({ includeDisabled: true, recompute: false })).find((j) => j.id === job.id)!
}

/** What the host made for the run of `slotMs`: its fire (marked started) and its two journal records. */
function hostRun(job: CronJob, nth: number, title: string, project = 'Routines') {
  const fromMs = job.state.clockFromMs!
  const slotMs = fromMs + nth * HOUR
  const run = ids.idsOf(WALNUT_HOME, job.id, slotMs)
  const startedAt = slotMs + 31_000
  const fire: TriggerFiredEvent = {
    type: 'trigger.fired', id: job.id, epoch: 'e1', seq: 1, atMs: slotMs + 1_000, items: [], durationMs: 0,
    clock: { slotMs, fromMs },
    host: { atMs: startedAt, sessionId: run.sid, messageId: run.messageId, seqs: [1], started: true, taskId: run.taskId },
  }
  const spec = { home: WALNUT_HOME, host: HOST, title, project, cwd: CWD, message: 'Write the nightly report', mode: 'bypass' }
  const create = {
    v: 2, seq: ++seqN, at: startedAt, opId: run.taskOpId, rev: 1, actor: { kind: 'trigger', id: job.id },
    ...ids.taskRecordOf(spec, run),
  }
  const session = {
    v: 2, seq: ++seqN, at: startedAt, opId: run.sessionOpId, rev: 1, actor: { kind: 'session', sid: run.sid },
    kind: 'session', sid: run.sid, taskId: run.taskId, host: HOST, cwd: CWD, mode: 'bypass', title, startedAt,
    firstMessage: 'Write the nightly report', routine: { id: job.id, slotMs },
  }
  return { run, fire, create, session }
}

/** A host journal that keeps a record until an ack reaches it. */
function journal(records: Array<Record<string, unknown>>) {
  const pending = [...records]
  const rescued: string[][] = []
  return {
    pending, rescued,
    conn: {
      hostKey: HOST, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        if (cmd === 'offline.ack') for (const s of (p?.seqs as number[]) ?? []) { const i = pending.findIndex((r) => r.seq === s); if (i !== -1) pending.splice(i, 1) }
        return { ok: true }
      },
      rescue: async (sids: string[]) => { rescued.push(sids) },
    },
  }
}

async function jobOf(s: CronService, id: string): Promise<CronJob> {
  return (await s.list({ includeDisabled: true })).find((j) => j.id === id)!
}

async function expectAdopted(run: { sid: string; taskId: string }, title: string, project = 'Routines'): Promise<void> {
  const task = await getTask(run.taskId)
  expect(task).toMatchObject({ id: run.taskId, title, project, cwd: CWD, exec_session_id: run.sid, session_id: run.sid })
  expect(task.pinned).toBeFalsy()
  expect(task.walnut_agent).toBeFalsy()
  expect(task.session_ids).toEqual([run.sid])
  const s = await getSessionByClaudeId(run.sid)
  expect(s).toMatchObject({ claudeSessionId: run.sid, taskId: run.taskId, host: HOST, cwd: CWD, mode: 'bypass', title })
  expect(s!.profile).toBeUndefined()
  // The context this Mac appends to a session of that task, built for it here.
  expect(s!.appliedAppendSystemPrompt).toContain(`(id ${run.taskId}, project "${project}")`)
  expect(getSessionsForTaskSync(run.taskId)).toHaveLength(1)
}

beforeEach(() => {
  runExecutor = vi.fn().mockResolvedValue({ status: 'ok', summary: 'started' })
  acks = []
  setTriggerDaemonLookupForTest(() => ({
    host: HOST, hasCapability: () => true, capabilitiesKnown: true, triggersPushed: true,
    send: async (cmd: string, p: Record<string, unknown> = {}) => { if (cmd === 'triggers.ack') acks.push(p); return { ok: true } },
  }) as never)
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  _setHandoverBackoffForTesting([1, 1])
})
afterAll(() => { setTriggerDaemonLookupForTest(null); _setHandoverBackoffForTesting(null); closeDb() })

describe('a routine run the host started while the Mac was away', () => {
  it('the fire first, then the journal: recorded once, nothing started, the session adopted once', async () => {
    const s = service()
    cron.service = s
    const job = await hostedRoutine(s, 'Nightly report')
    const { run, fire, create, session } = hostRun(job, 0, 'Routine: Nightly report')

    await handleTriggerFired(HOST, fire)
    // The fire alone is the run's history: no executor, so no second session.
    expect(runExecutor).not.toHaveBeenCalled()
    const recorded = await jobOf(s, job.id)
    // The run is stamped with its fire, as every run a host delivered is.
    expect(recorded.state).toMatchObject({ lastStatus: 'ok', lastRunAtMs: fire.atMs })
    expect(recorded.state.fireLog).toHaveLength(1)
    expect(recorded.state.fireLog![0]).toMatchObject({ outcome: 'fired', seq: 1 })
    expect(JSON.stringify(recorded.state.fireLog![0])).toContain(`${HOST} started it in session`)
    expect(acks).toEqual([{ triggerId: job.id, seq: 1 }])

    const j = journal([create, session])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    await expectAdopted(run, 'Routine: Nightly report')
    expect(j.rescued.flat()).toContain(run.sid)

    // The daemon's replay of the same fire, and a lost ack's redrain: still one of each.
    await handleTriggerFired(HOST, fire)
    await runOfflineHandover(journal([create, session]).conn as never)
    expect(runExecutor).not.toHaveBeenCalled()
    expect((await jobOf(s, job.id)).state.fireLog).toHaveLength(1)
    await expectAdopted(run, 'Routine: Nightly report')
  })

  it('the journal first, then the fire: the same one run', async () => {
    const s = service()
    cron.service = s
    const job = await hostedRoutine(s, 'Weekly digest', { taskTitle: 'Digest of the week', project: 'Reports' })
    const { run, fire, create, session } = hostRun(job, 0, 'Digest of the week', 'Reports')

    await runOfflineHandover(journal([create, session]).conn as never)
    await expectAdopted(run, 'Digest of the week', 'Reports')
    // Nothing on the routine yet: the fire is what records the run.
    expect((await jobOf(s, job.id)).state.fireLog ?? []).toHaveLength(0)

    await handleTriggerFired(HOST, fire)
    expect(runExecutor).not.toHaveBeenCalled()
    const recorded = await jobOf(s, job.id)
    expect(recorded.state.lastStatus).toBe('ok')
    expect(recorded.state.fireLog).toHaveLength(1)
    // The summary names the session the Mac now knows.
    expect(JSON.stringify(recorded.state.fireLog![0])).toContain('started it in session')
    await handleTriggerFired(HOST, fire)
    expect((await jobOf(s, job.id)).state.fireLog).toHaveLength(1)
    await expectAdopted(run, 'Digest of the week', 'Reports')
  })

  it('a run of another slot is its own run, with its own task and session', async () => {
    const s = service()
    cron.service = s
    const job = await hostedRoutine(s, 'Hourly sweep')
    const a = hostRun(job, 0, 'Routine: Hourly sweep')
    const b = hostRun(job, 1, 'Routine: Hourly sweep')
    expect(a.run.sid).not.toBe(b.run.sid)
    expect(a.run.taskId).not.toBe(b.run.taskId)
    await runOfflineHandover(journal([a.create, a.session, b.create, b.session]).conn as never)
    await handleTriggerFired(HOST, a.fire)
    await handleTriggerFired(HOST, { ...b.fire, seq: 2, host: { ...b.fire.host!, seqs: [2] } })
    expect(runExecutor).not.toHaveBeenCalled()
    expect((await jobOf(s, job.id)).state.fireLog).toHaveLength(2)
    await expectAdopted(a.run, 'Routine: Hourly sweep')
    await expectAdopted(b.run, 'Routine: Hourly sweep')
  })

  it('a routine session record names a mode a routine may not run in: kept as the default', async () => {
    const s = service()
    cron.service = s
    const job = await hostedRoutine(s, 'Planner')
    const { run, create, session } = hostRun(job, 0, 'Routine: Planner')
    await runOfflineHandover(journal([create, { ...session, mode: 'plan' }]).conn as never)
    expect(await getSessionByClaudeId(run.sid)).toMatchObject({ mode: 'default' })
  })

  it('a routine session for a task the host did not create is refused, and nothing is linked', async () => {
    const s = service()
    cron.service = s
    const job = await hostedRoutine(s, 'Stray')
    const { run, session } = hostRun(job, 0, 'Routine: Stray')
    const j = journal([session])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    expect(await getSessionByClaudeId(run.sid)).toBeNull()
  })
})
