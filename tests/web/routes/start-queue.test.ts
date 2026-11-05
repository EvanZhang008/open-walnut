/**
 * The start queue (core/sessions/start-queue.ts): a worker session's start past the
 * running-subtask cap is queued on the task and started by Walnut itself once a slot frees,
 * highest priority first, then the oldest. 2026-11-03: a VP at the cap read "do this part with
 * your own tools" and did the work itself, then wrote its own retry loops.
 *
 * Real startServer({ port: 0, dev: true }) with an isolated home, real task and session
 * records, the real start path. Only the Claude CLI spawn is replaced (sessionRunner.startSession).
 * The loop runs (WALNUT_START_QUEUE=1), so the nudge on a sibling leaving IN_PROGRESS is real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-start-queue'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { MAX_RUNNING_SUBTASKS, MAX_RUNNING_SUBTASKS_USER_ASKED, SubtaskLimitError } from '../../../src/core/sessions/subtask-limits.js'
import { startSessionForTask } from '../../../src/core/sessions/task-start.js'
import { drainStartQueue } from '../../../src/core/sessions/start-queue.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { taskExecution } from '../../../src/ops/task-execution.js'

const DO_IT_YOURSELF = /own tools|do (it|this part|that part|the work) yourself/i

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`
const failFor = new Set<string>()
const spawned: string[] = []

let seq = 0
async function sessionFor(taskId: string): Promise<string> {
  seq += 1
  const sid = `33333333-4444-5555-6666-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, taskId, 'queue', '/repo/queue', { title: `Session ${seq}` })
  return sid
}

async function children(parentId: string, phases: string[], extra: Record<string, unknown> = {}): Promise<string[]> {
  const ids: string[] = []
  for (const [i, phase] of phases.entries()) {
    const { task } = await addTask({ title: `Child ${i} of ${parentId}`, project: 'queue', parent_task_id: parentId, ...extra } as never)
    if (phase !== 'TODO') await updateTaskRaw(task.id, { phase: phase as never })
    ids.push(task.id)
  }
  return ids
}

async function startAs(sid: string | undefined, taskId: string, body: Record<string, unknown>) {
  const res = await fetch(api(`/api/v1/tasks/${taskId}/start`), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify({ cwd: os.tmpdir(), expect_reply: false, ...body }),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

/** A worker with the cap full of running subtasks. */
async function fullWorker(title: string) {
  const { task: parent } = await addTask({ title, project: 'queue' })
  const running = await children(parent.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
  const sid = await sessionFor(parent.id)
  return { parent, running, sid }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  process.env.WALNUT_START_QUEUE = '1'
  // The CLI spawn only: the runner marks the task running the way the real one does.
  vi.spyOn(sessionRunner, 'startSession').mockImplementation(async (data: any) => {
    const sid = data.preassignedSessionId as string
    if (failFor.has(data.taskId)) throw new Error('spawn refused for the test')
    spawned.push(data.taskId)
    await updateTaskRaw(data.taskId, { phase: 'IN_PROGRESS' as never })
    return { claudeSessionId: sid, title: 'x' } as never
  })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  delete process.env.WALNUT_START_QUEUE
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the start queue', () => {
  it('queues a start at the cap, starts the highest priority first, and the next one by itself when a sibling stops', async () => {
    const { parent, running, sid } = await fullWorker('Busy lead')
    const [plain, urgent] = await children(parent.id, ['TODO', 'TODO'])
    await updateTaskRaw(urgent, { priority: 'immediate' as never })

    const first = await startAs(sid, plain, { message: 'go plain' })
    expect(first.status).toBe(202)
    expect(first.json).toMatchObject({ taskId: plain, started: false, queued: { position: 1, cap: MAX_RUNNING_SUBTASKS } })
    const second = await startAs(sid, urgent, { message: 'go urgent' })
    expect(second.json.queued.position).toBe(1)
    const queuedPlain = await getTask(plain)
    expect(queuedPlain.start_queue).toMatchObject({ parent_id: parent.id, caller_sid: sid, params: { message: 'go plain' } })
    expect(taskExecution(queuedPlain as never).state).toBe('queued')

    // The queue's own start is never queued again: at the cap it throws, and the entry stays as it was.
    const replay = await startSessionForTask({ taskIdPrefix: plain, callerSid: sid, source: 'start-queue', queueWhenFull: true })
      .catch((e: unknown) => e) as SubtaskLimitError
    expect(replay).toBeInstanceOf(SubtaskLimitError)
    expect(replay.code).toBe('too_many_running_subtasks')
    expect(replay.message).not.toMatch(DO_IT_YOURSELF)
    expect((await getTask(plain)).start_queue?.at).toBe(queuedPlain.start_queue?.at)

    // One sibling stops: the immediate one starts first, the plain one still waits.
    await updateTaskRaw(running[0], { phase: 'NEED_ACTION' as never })
    const drained = await drainStartQueue(parent.id)
    expect(drained.started).toEqual([urgent])
    expect(drained.waiting).toEqual([plain])
    const started = await getTask(urgent)
    expect(started.start_queue ?? undefined).toBeUndefined()
    expect(started.last_start?.state).toBe('started')
    expect((await getTask(plain)).start_queue).toBeTruthy()

    // Another sibling stops: the nudge starts the plain one by itself, no drain called here.
    await updateTaskRaw(running[1], { phase: 'NEED_ACTION' as never }, { emitEvent: true, source: 'test' })
    await vi.waitFor(async () => {
      expect((await getTask(plain)).start_queue ?? undefined).toBeUndefined()
    }, { timeout: 10_000, interval: 200 })
    expect(spawned).toContain(plain)
    expect((await getTask(plain)).last_start?.state).toBe('started')
  })

  it('a start the user asked for is not held back by older plain starts the lower cap refuses', async () => {
    // 2026-11-04: three older plain starts at the cap of 8 kept a user-asked start queued for
    // hours with 15 of 16 running, because the first refusal stopped the whole line.
    const { task: parent } = await addTask({ title: 'Lead past both caps', project: 'queue' })
    const running = await children(parent.id, Array(MAX_RUNNING_SUBTASKS_USER_ASKED).fill('IN_PROGRESS'))
    const sid = await sessionFor(parent.id)
    const [olderA, olderB, asked, askedLater] = await children(parent.id, ['TODO', 'TODO', 'TODO', 'TODO'])
    for (const id of [olderA, olderB]) expect((await startAs(sid, id, { message: 'plain' })).json.queued).toBeTruthy()
    for (const id of [asked, askedLater]) {
      expect((await startAs(sid, id, { message: 'asked', user_request: 'please start this one now, I am waiting' })).json.queued).toBeTruthy()
    }

    // One slot frees: under 16, still over 8. The user-asked one goes, the plain ones wait.
    await updateTaskRaw(running[0], { phase: 'NEED_ACTION' as never })
    const drained = await drainStartQueue(parent.id)
    expect(drained.started).toEqual([asked])
    expect(drained.waiting.sort()).toEqual([olderA, olderB, askedLater].sort())
    expect((await getTask(olderA)).start_queue).toBeTruthy()
    expect((await getTask(askedLater)).start_queue).toBeTruthy()
  })

  it("a helper's start of a lead's subtask queues under the lead, starts when the lead has room, and drops with the helper", async () => {
    const { parent: lead, running } = await fullWorker('Lead a helper starts for')
    const [forHelper, dropsWithHelper] = await children(lead.id, ['TODO', 'TODO'])
    const { task: helper } = await addTask({ title: 'Helper task', project: 'queue' })
    const helperSid = await sessionFor(helper.id)
    expect((await startAs(helperSid, forHelper, { message: 'go for the lead' })).json.queued).toMatchObject({ cap: MAX_RUNNING_SUBTASKS })
    expect((await getTask(forHelper)).start_queue).toMatchObject({ parent_id: lead.id, caller_sid: helperSid })

    // The lead completes with its subtasks open: the helper still waits, the entry stays.
    await updateTaskRaw(lead.id, { phase: 'COMPLETE' as never })
    expect((await drainStartQueue(lead.id)).waiting).toContain(forHelper)
    await updateTaskRaw(lead.id, { phase: 'IN_PROGRESS' as never })

    // A slot of the lead frees: the drain starts it.
    await updateTaskRaw(running[0], { phase: 'NEED_ACTION' as never })
    expect((await drainStartQueue(lead.id)).started).toEqual([forHelper])

    // The helper completes: its other queued start goes with it.
    expect((await startAs(helperSid, dropsWithHelper, { message: 'later' })).json.queued).toBeTruthy()
    await updateTaskRaw(helper.id, { phase: 'COMPLETE' as never })
    expect((await drainStartQueue(lead.id)).dropped).toContain(dropsWithHelper)
  })

  it("a person's start clears a queued entry", async () => {
    const { parent, sid } = await fullWorker('Lead the person overrides')
    const [waiting] = await children(parent.id, ['TODO'])
    expect((await startAs(sid, waiting, { message: 'later' })).json.queued).toBeTruthy()

    const person = await startAs(undefined, waiting, { message: 'now, from the board' })
    expect(person.status).toBe(202)
    expect(person.json.queued).toBeUndefined()
    const after = await getTask(waiting)
    expect(after.start_queue ?? undefined).toBeUndefined()
    expect(after.last_start?.state).toBe('started')
  })

  it('drops a COMPLETE task, holds a team-stopped team, and cancels on DELETE', async () => {
    const { parent, running, sid } = await fullWorker('Lead with a stopped team')
    const [done, held, cancelled] = await children(parent.id, ['TODO', 'TODO', 'TODO'])
    for (const id of [done, held, cancelled]) expect((await startAs(sid, id, { message: id })).status).toBe(202)

    await updateTaskRaw(done, { phase: 'COMPLETE' as never })
    const del = await fetch(api(`/api/v1/tasks/${cancelled}/start-queue`), { method: 'DELETE' })
    expect(await del.json()).toMatchObject({ taskId: cancelled, cleared: true })
    await updateTaskRaw(parent.id, { team_stop: { at: new Date().toISOString(), by: 'human', when: 'now', members: [] } as never })
    // A slot frees while the stop is in force: nothing of the team starts.
    await updateTaskRaw(running[0], { phase: 'NEED_ACTION' as never })
    const whileStopped = await drainStartQueue(parent.id)
    expect(whileStopped.held).toEqual([held])
    expect(whileStopped.started).toEqual([])
    expect((await getTask(done)).start_queue ?? undefined).toBeUndefined()
    expect(spawned).not.toContain(held)

    // team_resume: the held start goes (this drain, or the nudge if it came first).
    await updateTaskRaw(parent.id, { team_stop: null as never })
    await drainStartQueue(parent.id)
    expect(spawned).toContain(held)
    expect((await getTask(held)).start_queue ?? undefined).toBeUndefined()
    expect(spawned).not.toContain(cancelled)
  })

  it('a replay that fails for another reason is dropped, with the failure on the task', async () => {
    const { parent, running, sid } = await fullWorker('Lead whose replay fails')
    const [broken] = await children(parent.id, ['TODO'])
    expect((await startAs(sid, broken, { message: 'will fail' })).status).toBe(202)
    failFor.add(broken)
    await updateTaskRaw(running[0], { phase: 'COMPLETE' as never })
    const out = await drainStartQueue(parent.id)
    expect(out.dropped).toEqual([broken])
    const after = await getTask(broken)
    expect(after.start_queue ?? undefined).toBeUndefined()
    expect(after.last_start?.state).toBe('failed')
    expect(taskExecution(after as never).state).toBe('error')
  })
  // The 2026-11-03 review: a caller whose session is gone failed open and started every entry at once;
  // a session begun by a path that writes no last_start got the queued message again.
  it('a gone caller session still waits for a slot, a finished caller drops its entries, a session since queued drops one', async () => {
    const { parent, running, sid } = await fullWorker('Lead whose session went away')
    const [a, b] = await children(parent.id, ['TODO', 'TODO'])
    for (const id of [a, b]) expect((await startAs(sid, id, { message: id })).status).toBe(202)
    // The caller's session record is gone: the replay is admitted against the parent itself.
    await updateTaskRaw(a, { start_queue: { ...(await getTask(a)).start_queue!, caller_sid: '99999999-0000-0000-0000-000000000000' } as never })
    await updateTaskRaw(b, { start_queue: { ...(await getTask(b)).start_queue!, caller_sid: '99999999-0000-0000-0000-000000000000' } as never })
    const full = await drainStartQueue(parent.id)
    expect(full.started).toEqual([])
    expect(full.waiting.sort()).toEqual([a, b].sort())
    await updateTaskRaw(running[0], { phase: 'NEED_ACTION' as never })
    const one = await drainStartQueue(parent.id)
    expect(one.started).toHaveLength(1)
    expect(one.waiting).toHaveLength(1)

    const { parent: done, sid: doneSid } = await fullWorker('Lead that finished')
    const [orphan] = await children(done.id, ['TODO'])
    expect((await startAs(doneSid, orphan, { message: 'x' })).status).toBe(202)
    await updateTaskRaw(done.id, { phase: 'COMPLETE' as never })
    expect((await drainStartQueue(done.id)).dropped).toEqual([orphan])
    expect((await getTask(orphan)).start_queue ?? undefined).toBeUndefined()

    const { parent: p3, running: r3, sid: sid3 } = await fullWorker('Lead whose task the board started')
    const [boardStarted] = await children(p3.id, ['TODO'])
    expect((await startAs(sid3, boardStarted, { message: 'x' })).status).toBe(202)
    await new Promise((r) => setTimeout(r, 5))
    await sessionFor(boardStarted)
    await updateTaskRaw(r3[0], { phase: 'NEED_ACTION' as never })
    const out = await drainStartQueue(p3.id)
    expect(out.dropped).toEqual([boardStarted])
    expect(spawned).not.toContain(boardStarted)
  })
})

