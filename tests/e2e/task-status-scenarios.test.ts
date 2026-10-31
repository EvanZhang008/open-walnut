/**
 * Task status scenarios, end to end on a real server: after every step of a real flow, every
 * surface shows the same state (2026-10-30, the user, after a snoozed task still showed as a red
 * Needs you card on the Org page: "fix the real root cause, the foundation ... testing is the most
 * important thing"). One place decides (src/core/user-status.ts deriveUserStatus, stored as
 * task.user_status); this suite reads what each surface would show from the same server:
 *
 *   stored   task.user_status.state                       (the one decision)
 *   phone    GET /api/v1/tasks row's user_status.state    (iOS and the v1 projection)
 *   org      GET /api/v1/org/reports needs_you of its project (the Org page cards and counts)
 *   brief    briefSectionLines of its lead lists it under Needs you iff needs
 *   board    buildStatusBoard groups (the Board's Status view)
 *   web      taskUserState / taskNeedsAction               (the panel, phone strip, search rows)
 *   check    status_check finds nothing wrong with it      (src/core/status-consistency.ts)
 *
 * Flows: ask -> answer, snooze -> the date passes, park on CI -> the trigger fires, a report that
 * waits on the user, a worker done -> its lead, a finished task reopened, the task's own line set by
 * itself, its lead and a person. Only the Claude CLI is
 * mocked; session records are written directly, as the session runtime would.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-status-scenarios'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, listTasks, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { applyReportPhase } from '../../src/core/sessions/report-phase.js'
import { applySessionPhase } from '../../src/core/phase.js'
import { briefSectionLines } from '../../src/core/sessions/brief.js'
import { checkStatuses } from '../../src/core/status-consistency.js'
import { recheckDue } from '../../src/core/sessions/needs-recheck.js'
import { snoozeEndedMs } from '../../src/core/snooze.js'
import { buildStatusBoard } from '../../web/src/components/board/board-status-model.js'
import { taskNeedsAction, taskUserState } from '../../web/src/utils/session-status.js'
import type { StatusReport } from '../../src/core/user-status.js'
import type { Task } from '../../src/core/types.js'

type State = 'needs' | 'working' | 'waiting' | 'done'

let server: HttpServer
let port: number

async function v1<T>(p: string): Promise<T> {
  const res = await fetch(`http://localhost:${port}/api/v1${p}`)
  return await res.json() as T
}

/** Every surface's reading of one task, after a sync pass. */
async function surfaces(taskId: string, leadId: string): Promise<Record<string, State | boolean>> {
  await syncUserStatuses(null)
  const task = await getTask(taskId)
  const all = await listTasks()
  const lead = all.find((t) => t.id === leadId)!
  const { tasks: phoneRows } = await v1<{ tasks: { id: string; user_status?: { state: State } }[] }>('/tasks?include_done=1')
  const reports = await v1<{ rows: { project?: string; needs_you: number }[] }>('/org/reports')
  const orgNeeds = reports.rows.find((r) => (r.project ?? '').toLowerCase() === (task.project ?? '').toLowerCase())?.needs_you ?? 0
  const board = buildStatusBoard({ ownerId: leadId, tasks: all as never, now: Date.now(), doneWindowDays: 30 })
  const boardState = (Object.keys(board.groups) as State[]).find((s) => board.groups[s].some((r) => r.task.id === taskId))
  const mismatches = (await checkStatuses(Date.now(), { settleMs: 0 })).filter((m) => m.taskId === taskId)
  return {
    stored: task.phase === 'COMPLETE' ? 'done' : task.user_status!.state,
    phone: task.phase === 'COMPLETE' ? 'done' : phoneRows.find((r) => r.id === taskId)?.user_status?.state ?? 'missing' as never,
    web: taskUserState(task as never),
    board: boardState ?? ('missing' as never),
    orgNeedsYou: orgNeeds > 0,
    webNeedsYou: taskNeedsAction(task as never),
    briefNeedsYou: briefSectionLines(lead, all).needs.some((l) => l.includes(`id="${taskId}"`)),
    checkClean: mismatches.length === 0,
  }
}

/** All surfaces agree on `state`. */
async function expectEverywhere(taskId: string, leadId: string, state: State, step: string): Promise<void> {
  const s = await surfaces(taskId, leadId)
  const needs = state === 'needs'
  expect(s, step).toEqual({
    stored: state, phone: state, web: state, board: state,
    orgNeedsYou: needs, webNeedsYou: needs, briefNeedsYou: needs, checkClean: true,
  })
}

const at = (offsetMs = 1_000) => new Date(Date.now() + offsetMs).toISOString()
const report = (r: Partial<StatusReport>): StatusReport => ({ at: at(), turn_ended_at: at(), ...r })

/** A lead and one worker in a project of their own, the worker's session stopped after a turn. */
async function team(name: string): Promise<{ lead: Task; worker: Task; sid: string }> {
  const lead = (await addTask({ title: `${name} lead`, project: name })).task
  await updateTaskRaw(lead.id, { org_role: 'lead' } as never, { emitEvent: true })
  const worker = (await addTask({ title: `${name} worker`, project: name })).task
  await updateTask(worker.id, { parent_task_id: lead.id })
  const sid = `sess-${name.toLowerCase()}-1`
  await createSessionRecord(sid, worker.id, name)
  await updateSessionRecord(sid, { process_status: 'stopped' })
  await updateTaskRaw(worker.id, { session_id: sid } as never, { emitEvent: true })
  // Its first turn ran: a report only moves a task that started (a TODO stays not started).
  await updateTask(worker.id, { phase: 'IN_PROGRESS' })
  return { lead, worker, sid }
}

/** A message reaches its session and a turn runs, as the delivery path moves the phase. */
async function turnStarts(task: Task, sid: string, source: string, reopen = false): Promise<void> {
  await applySessionPhase(task.id, 'session:input', source, { sessionId: sid, ...(reopen ? { reopenTerminal: true } : {}) })
  await updateSessionRecord(sid, { process_status: 'running' })
}

/** A turn ends with this report, as the session runtime and report-phase.ts do it. */
async function turnEnds(task: Task, sid: string, r: Partial<StatusReport>): Promise<void> {
  await updateSessionRecord(sid, { process_status: 'stopped' })
  const rep = report(r)
  await updateTaskRaw(task.id, { status_report: rep }, { emitEvent: true })
  await applyReportPhase(task.id, sid, rep, Date.now())
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('every surface shows the same state after every step', () => {
  it('ask -> the user answers -> its turn runs', async () => {
    const { lead, worker, sid } = await team('Askflow')
    await turnEnds(worker, sid, { state: 'needs', ask: 'Pick the release name' })
    expect((await getTask(worker.id)).phase).toBe('NEED_ACTION')
    await expectEverywhere(worker.id, lead.id, 'needs', 'asked')
    // The user's answer starts a turn.
    await turnStarts(worker, sid, 'web')
    await expectEverywhere(worker.id, lead.id, 'working', 'answered, turn running')
  }, 120_000)

  it('snooze -> nothing asks the user -> the date passes -> it asks again, with a fresh re-check clock', async () => {
    const { lead, worker, sid } = await team('Snoozeflow')
    await turnEnds(worker, sid, { state: 'needs', ask: 'Sign in on the phone' })
    await expectEverywhere(worker.id, lead.id, 'needs', 'asked')
    const until = new Date(Date.now() + 6_000).toISOString()
    await updateTask(worker.id, { start_date: until })
    await expectEverywhere(worker.id, lead.id, 'waiting', 'snoozed')
    expect((await getTask(worker.id)).user_status?.snoozed).toMatchObject({ until, ask: 'Sign in on the phone' })
    // Its session ends another turn still asking: the snooze holds (a report cannot undo it).
    await turnEnds(worker, sid, { state: 'needs', ask: 'Sign in on the phone, snoozed or not' })
    await expectEverywhere(worker.id, lead.id, 'waiting', 'report while snoozed')
    // The date passes.
    await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(until) - Date.now()) + 200))
    await expectEverywhere(worker.id, lead.id, 'needs', 'the date passed')
    const back = await getTask(worker.id)
    expect(back.user_status?.snoozed).toBeUndefined()
    // The 4-hour re-check counts from the date, not from the ask two weeks (here: seconds) ago.
    expect(recheckDue({ ...back, user_status: { ...back.user_status!, checkedAt: new Date(0).toISOString() } }, {
      nowMs: Date.now(), snoozeEndedMs: snoozeEndedMs(back, undefined, Date.now()),
    })).toBe(false)
  }, 120_000)

  it('a snoozed task\'s session raises it only with a stated reason', async () => {
    const { worker, sid } = await team('Letterflow')
    await updateTask(worker.id, { start_date: new Date(Date.now() + 3_600_000).toISOString() })
    const send = (extra: Record<string, unknown>) => fetch(`http://localhost:${port}/api/v1/human-inbox`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': sid },
      body: JSON.stringify({ type: 'review', subject: 'Review the plan', markdown: 'A or B?', ...extra }),
    })
    const refused = await send({})
    expect(refused.status).toBe(409)
    expect(JSON.stringify(await refused.json())).toContain('task_snoozed')
    expect((await send({ snooze_reason: 'short' })).status).toBe(409)
    const raised = await send({ snooze_reason: 'The vendor deadline moved to tomorrow morning' })
    expect(raised.status, await raised.clone().text()).toBe(201)
    // The reason leads the letter, so the user reads why it came before the date.
    const { id } = await raised.json() as { id: string }
    const stored = await fetch(`http://localhost:${port}/api/v1/human-inbox/${id}`).then((r) => r.text())
    expect(stored).toContain('raised now because: The vendor deadline moved')
    // The user asked for this one ("tell me when"): no reason needed.
    expect((await send({ user_asked: true })).status).toBe(201)
  }, 120_000)

  it('a subtask of a snoozed task sleeps with it', async () => {
    const { lead, worker, sid } = await team('Inheritflow')
    await turnEnds(worker, sid, { state: 'needs', ask: 'Review the draft' })
    await updateTask(lead.id, { start_date: new Date(Date.now() + 3_600_000).toISOString() })
    await expectEverywhere(worker.id, lead.id, 'waiting', 'parent snoozed')
  }, 120_000)

  it('park on CI -> the trigger fires -> its turn runs', async () => {
    const { lead, worker, sid } = await team('Ciflow')
    await turnEnds(worker, sid, { state: 'waiting', waiting_kind: 'outside', waiting_on: 'The CI run on the release branch' })
    expect((await getTask(worker.id)).phase).toBe('WAITING')
    await expectEverywhere(worker.id, lead.id, 'waiting', 'parked on CI')
    // The trigger fires: its note reaches the session and a turn runs.
    await turnStarts(worker, sid, 'trigger')
    await expectEverywhere(worker.id, lead.id, 'working', 'fired')
  }, 120_000)

  it('a report that waits on the user is Needs you, never a park', async () => {
    const { lead, worker, sid } = await team('Userwaitflow')
    await turnEnds(worker, sid, { state: 'waiting', waiting_kind: 'other', waiting_on: 'you: the meeting notes and the deadline' })
    expect((await getTask(worker.id)).phase).toBe('NEED_ACTION')
    await expectEverywhere(worker.id, lead.id, 'needs', 'waits on the user')
  }, 120_000)

  it('a worker done -> waits on its lead, not on the user', async () => {
    const { lead, worker, sid } = await team('Doneflow')
    await turnEnds(worker, sid, { state: 'done', now: 'Shipped the fix.' })
    await expectEverywhere(worker.id, lead.id, 'waiting', 'done, on its lead')
    expect((await getTask(worker.id)).user_status?.kind).toBe('lead')
  }, 120_000)

  it('a finished task reads Done, and reopened it is working again', async () => {
    const { lead, worker, sid } = await team('Reopenflow')
    await updateTask(worker.id, { phase: 'COMPLETE' })
    await expectEverywhere(worker.id, lead.id, 'done', 'completed')
    // A message from the user reopens it and runs a turn.
    await turnStarts(worker, sid, 'web', true)
    await expectEverywhere(worker.id, lead.id, 'working', 'reopened')
  }, 120_000)

  it('each task writes what it waits on next; its lead may change it; its own next report replaces that', async () => {
    const { lead, worker, sid } = await team('Lineflow')
    const leadSid = 'sess-lineflow-lead'
    await createSessionRecord(leadSid, lead.id, 'Lineflow')
    const line = async () => {
      await syncUserStatuses(new Set([worker.id]))
      return (await getTask(worker.id)).user_status
    }
    const put = (body: unknown, caller?: string) => fetch(`http://localhost:${port}/api/v1/tasks/${worker.id}/report`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...(caller ? { 'x-walnut-caller-sid': caller } : {}) },
      body: JSON.stringify(body),
    })
    // Its own turn-end report: the ask, by itself.
    await turnEnds(worker, sid, { state: 'needs', ask: 'Pick A or B for the parser output' })
    expect((await line())?.line).toMatchObject({ text: 'Pick A or B for the parser output', by: 'self' })
    await expectEverywhere(worker.id, lead.id, 'needs', 'its own ask')
    // Its lead changes it: waiting on the lead to land it. Recorded as the lead's, the phase follows.
    const set = await put({ state: 'waiting', waiting_kind: 'lead', waiting_on: 'Its lead, to land commit abc123' }, leadSid)
    expect(set.status, await set.clone().text()).toBe(200)
    expect((await getTask(worker.id)).phase).toBe('WAITING')
    expect(await line()).toMatchObject({ state: 'waiting', kind: 'lead', line: { text: 'Its lead, to land commit abc123', by: `task:${lead.id}`, byName: 'Lineflow lead' } })
    await expectEverywhere(worker.id, lead.id, 'waiting', 'its lead changed it')
    // Needs you always names the ask, whoever sets it.
    expect((await put({ state: 'needs' }, leadSid)).status).toBe(400)
    expect((await put({ state: 'waiting' }, leadSid)).status).toBe(400)
    // A person sets it.
    expect((await put({ state: 'needs', ask: 'Sign the release form' })).status).toBe(200)
    const byPerson = await line()
    expect(byPerson?.line, JSON.stringify({ phase: (await getTask(worker.id)).phase, byPerson, report: (await getTask(worker.id)).status_report })).toMatchObject({ text: 'Sign the release form', by: 'human' })
    // Its own next report replaces the change.
    await turnStarts(worker, sid, 'web')
    await turnEnds(worker, sid, { state: 'needs', ask: 'Review the draft' })
    expect((await line())?.line).toMatchObject({ text: 'Review the draft', by: 'self' })
  }, 120_000)
})
