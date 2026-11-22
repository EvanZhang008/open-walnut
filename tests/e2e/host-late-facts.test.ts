/**
 * A host's facts read back late, on a real leader (docs/plan/one-service-every-host.md, phase 2; the
 * plan's late facts table): while the leader was away, a session its host runs finished three turns;
 * when the leader comes back the channel applies them with `late: true` and the time each happened,
 * through the same emit leader-boot.ts uses (sayHostFact). Every real subscriber of the server hears
 * them. After the backlog:
 *
 *   status    the task's phase moved once (to Needs action), its stored user status is what the
 *             one derivation says now, and it was written at most once for the whole backlog
 *   board     the Board's status view shows the task where its status says
 *   push      the phone got nothing for the late turns: at most one push in all (none here)
 *   hooks     the turn-end kind fired once per turn, marked late with the time it happened; a hook
 *             that would act on the session now (an injecting one) did not fire
 *   time      agent time is counted at each turn's own end, not at the time it was received
 *   triage    a triage run's late end is recorded with its own time, once, and is never settled again
 *
 * Only the Claude CLI is absent: no session runs here, the facts stand for a host's.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-late-facts'))

/** Every phone push the server makes (letters, threads): none may come of a late turn. */
const pushes: unknown[] = []
vi.mock('../../src/core/push/deliver.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/push/deliver.js')>()
  return { ...real, deliverPush: async (...args: Parameters<typeof real.deliverPush>) => { pushes.push(args[1]); return real.deliverPush(...args) } }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, linkSession, listTasks, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { settleUserStatusSync, syncUserStatuses } from '../../src/core/user-status-sync.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import { sayHostFact } from '../../src/core/session-channel/leader-boot.js'
import { forgetHostJudged, noteHostJudged } from '../../src/core/sessions/judge-of.js'
import { getSessionHookDispatcher } from '../../src/core/session-hooks/index.js'
import type { SessionHookContext } from '../../src/core/session-hooks/types.js'
import { readDayRecords } from '../../src/core/time-tracking/store.js'
import { localDateKey } from '../../src/core/time-tracking/rollup.js'
import { triageRunsNotePath } from '../../src/core/triage/runs.js'
import { TRIAGE_PROJECT } from '../../src/core/triage/bootstrap.js'
import { TRIAGE_AGENT_ID } from '../../src/core/triage/types.js'
import { buildStatusBoard } from '../../web/src/components/board/board-status-model.js'
import { shownState } from '../../src/core/user-status.js'

let server: HttpServer

const HOST = 'devbox'
const MIN = 60_000

/** Wait until `ok()` holds (the subscribers run after the emit, some after a settle delay). */
async function until(ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out waiting')
}

/** One finished turn of a host session, as its facts come back: the line reached it, a tool ran, the result. */
function lateTurn(sid: string, taskId: string, turnGen: number, endedAt: number, durationMs: number): void {
  const startedAt = endedAt - durationMs
  sayHostFact(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: sid, count: 1, messageIds: [`row-${sid}-${turnGen}`], turnGen }, { late: true, at: startedAt, to: ['main-ai'] })
  sayHostFact(EventNames.SESSION_TOOL_USE, { sessionId: sid, taskId, toolName: 'Bash', toolUseId: `tool-${sid}-${turnGen}`, input: { command: 'true' } }, { late: true, at: startedAt + 1_000, to: ['main-ai'] })
  sayHostFact(EventNames.SESSION_RESULT, {
    sessionId: sid, taskId, result: `Turn ${turnGen} is done.`, isError: false, duration: durationMs, turnGen, costDelta: 0,
  }, { late: true, at: endedAt, to: ['main-ai', 'session-runner'] })
}

/** A session its host runs and judges, linked to its task, as the leader knows it before it went away. */
async function hostSession(sid: string, taskId: string, project: string): Promise<void> {
  await createSessionRecord(sid, taskId, project)
  await updateSessionRecord(sid, { host: HOST, process_status: 'running', pid: process.pid })
  noteHostJudged(sid, HOST)
  await linkSession(taskId, sid)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  server = await startServer({ port: 0, dev: true })
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('three turns a host finished while the leader was away', () => {
  it('merge into the final state and act on nothing as if it just happened', async () => {
    const lead = (await addTask({ title: 'Late facts lead', project: 'Latefacts' })).task
    const worker = (await addTask({ title: 'Late facts worker', project: 'Latefacts' })).task
    await updateTask(worker.id, { parent_task_id: lead.id })
    const sid = 'host-late-worker-1'
    await hostSession(sid, worker.id, 'Latefacts')
    await updateTask(worker.id, { phase: 'IN_PROGRESS' })
    await settleUserStatusSync()

    // The hooks: the turn-end kind (firesLate) and one that would act on the session now.
    const dispatcher = getSessionHookDispatcher()!
    const turnEnds: SessionHookContext[] = []
    const injecting: SessionHookContext[] = []
    dispatcher.addHook({ id: 'test-late-turn-end', name: 'late turn end', hooks: ['onTurnComplete'], firesLate: true, handler: (p) => { if (p.sessionId === sid) turnEnds.push(p) } })
    dispatcher.addHook({ id: 'test-late-injecting', name: 'injecting', hooks: ['onTurnComplete', 'onToolUse', 'onTurnStart'], handler: (p) => { if (p.sessionId === sid) injecting.push(p) } })

    // What moved while the backlog was applied.
    const phaseMoves: string[] = []
    const statusWrites: unknown[] = []
    bus.subscribe('test-late-watch', (e: BusEvent) => {
      const d = e.data as { task?: { id?: string; user_status?: unknown }; oldPhase?: string; newPhase?: string }
      if (d.task?.id !== worker.id) return
      if (e.name === EventNames.TASK_PHASE_CHANGED) phaseMoves.push(`${d.oldPhase}->${d.newPhase}`)
      if (e.name === EventNames.TASK_UPDATED && e.source === 'user-status') statusWrites.push(d.task.user_status)
    }, { global: true, interest: [EventNames.TASK_PHASE_CHANGED, EventNames.TASK_UPDATED] })
    pushes.length = 0

    // The leader comes back: the host's row says where the session is now (rows apply before the
    // facts of a frame, leader-side.ts applyRecs), then the three turns, 3 h to 1 h ago.
    await updateSessionRecord(sid, { process_status: 'idle' })
    const ends = [3, 2, 1].map((h) => Date.now() - h * 60 * MIN)
    ends.forEach((end, i) => lateTurn(sid, worker.id, i + 1, end, 10 * MIN))

    // Status: one phase move for the backlog, and the stored status is what the derivation says now.
    await until(async () => (await getTask(worker.id)).phase === 'NEED_ACTION')
    await until(() => turnEnds.length === 3)
    await new Promise((r) => setTimeout(r, 2_500)) // the late lane's quiet window
    await settleUserStatusSync()
    expect(phaseMoves).toEqual(['IN_PROGRESS->NEED_ACTION'])
    expect(await syncUserStatuses(new Set([worker.id]))).toBe(0)
    expect(statusWrites.length).toBeLessThanOrEqual(1)
    const stored = (await getTask(worker.id)).user_status!
    expect(stored.state).not.toBe('working')

    // Board: its status view shows the task where its status says.
    const board = buildStatusBoard({ ownerId: lead.id, tasks: await listTasks() as never, now: Date.now(), doneWindowDays: 30 })
    const group = (Object.keys(board.groups) as Array<keyof typeof board.groups>).find((g) => board.groups[g].some((r) => r.task.id === worker.id))
    expect(group).toBe(shownState(stored.state))

    // Hooks: the turn-end kind once per turn, marked late with when it happened; no injecting one.
    expect(turnEnds.map((p) => [p.late, Date.parse(p.timestamp)])).toEqual(ends.map((end) => [true, end]))
    expect(injecting).toEqual([])

    // Agent time: each turn counted at its own end (ts = its start), on its own day.
    await until(async () => {
      const days = [...new Set(ends.map((e) => localDateKey(new Date(e))))]
      const recs = (await Promise.all(days.map((d) => readDayRecords(d)))).flat().filter((r) => r.kind === 'agent' && r.sessionId === sid)
      return recs.length === 3
    })
    const days = [...new Set(ends.map((e) => localDateKey(new Date(e))))]
    const agent = (await Promise.all(days.map((d) => readDayRecords(d)))).flat().filter((r) => r.kind === 'agent' && r.sessionId === sid)
    expect(agent.map((r) => Date.parse(r.ts)).sort()).toEqual(ends.map((e) => e - 10 * MIN))

    // Push: nothing for the late turns (at most one in all).
    expect(pushes.length).toBeLessThanOrEqual(1)
    expect(pushes).toEqual([])

    bus.unsubscribe('test-late-watch')
    dispatcher.removeHook('test-late-turn-end')
    dispatcher.removeHook('test-late-injecting')
    forgetHostJudged(sid)
  })

  it('a triage run that ended while the leader was away is recorded at its own time, once', async () => {
    const run = (await addTask({ title: 'Triage run late', project: TRIAGE_PROJECT })).task
    const endedAt = Date.now() - 2 * 60 * MIN
    await updateTaskRaw(run.id, { agent_id: TRIAGE_AGENT_ID, created_at: new Date(endedAt - 10 * MIN).toISOString() } as never)
    // The run watcher learns its run tasks from their creation (triage/runs.ts rememberRunTask).
    bus.emit(EventNames.TASK_CREATED, { task: await getTask(run.id) }, ['web-ui'], { source: 'test' })
    const sid = 'host-late-triage-1'
    await hostSession(sid, run.id, TRIAGE_PROJECT)

    const result = { sessionId: sid, taskId: run.id, result: 'Triage done.', isError: false, duration: 10 * MIN, turnGen: 1, costDelta: 0 }
    sayHostFact(EventNames.SESSION_RESULT, result, { late: true, at: endedAt, to: ['main-ai', 'session-runner'] })
    await until(async () => (await getTask(run.id)).phase === 'COMPLETE')

    const note = path.join(WALNUT_HOME, 'notes', triageRunsNotePath(endedAt))
    const linesOf = async () => (await fs.readFile(note, 'utf-8').catch(() => '')).split('\n').filter((l) => l.includes(`task ${run.id.slice(0, 8)}`))
    await until(async () => (await linesOf()).length === 1)
    // Its duration runs to its own end (10 min), not to the time the leader heard of it (2 h later).
    expect((await linesOf())[0]).toContain(' · 600s · ended ok')

    // The same end said again (a second read of the backlog) settles nothing more.
    sayHostFact(EventNames.SESSION_RESULT, result, { late: true, at: endedAt, to: ['main-ai', 'session-runner'] })
    await new Promise((r) => setTimeout(r, 1_000))
    expect(await linesOf()).toHaveLength(1)
    forgetHostJudged(sid)
  })
})
