/**
 * Each host's slots (core/sessions/host-admission.ts) for an automatic start (a worker
 * session's), and what is left of the start queue (core/sessions/start-queue.ts). 2026-11-05, the
 * user: "remove this we don't want this limitation ... let only limit the auto start, not the one
 * start by human manually". 2026-11-06, the user: a start is a sync call, "if it did not start, it
 * must be an error": a worker's start that no host has room for is a 409 hosts_full to it, never
 * queued; a person's start and a start that quotes the user's words never wait; the starts an
 * older Walnut queued are each started for real or failed loudly.
 *
 * Real startServer({ port: 0, dev: true }) with an isolated home, real task and session
 * records, the real start path and the real host view (hostLoads); this Mac's numbers come
 * from the load prober seam (full = load 4 per CPU). Only the Claude CLI spawn is replaced
 * (sessionRunner.startSession). The loop runs (WALNUT_START_QUEUE=1), so nudges are real.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-start-queue'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask, listTasks, updateTaskRaw } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { startSessionForTask } from '../../../src/core/sessions/task-start.js'
import { clearStartQueue, drainStartQueue } from '../../../src/core/sessions/start-queue.js'
import { __resetHostAdmissionForTesting, slotHoldersOn, startsAdmittedOn } from '../../../src/core/sessions/host-admission.js'
import { __setHostLoadProberForTesting } from '../../../src/core/hosts/placement.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { taskExecution } from '../../../src/ops/task-execution.js'
import * as sendCore from '../../../src/core/sessions/session-send-core.js'

const DO_IT_YOURSELF = /own tools|do (it|this part|that part|the work) yourself/i

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`
const failFor = new Set<string>()
/** Spawns whose answer is lost (the daemon's reply timed out): the outcome is unknown. */
const lostFor = new Set<string>()
const spawned: string[] = []

/**
 * This Mac's numbers: 14 CPUs and 36 GB (7 slots). Full: load 100, past twice the cap of 3 per
 * CPU; busy: load 56, over the cap (placement looks elsewhere) but not full.
 */
function mac(state: boolean | 'busy', load1?: number): void {
  __setHostLoadProberForTesting(async () => ({
    cpus: 14, load: [load1 ?? (state === 'busy' ? 56 : state ? 100 : 1), 1, 1], cpuBusy: 0.1, memTotalBytes: 36 * 1024 ** 3, memAvailBytes: 20 * 1024 ** 3,
    diskPath: '/', diskFreeBytes: 500 * 1024 ** 3, diskTotalBytes: 1000 * 1024 ** 3, at: new Date().toISOString(),
  }))
}

let seq = 0
async function sessionFor(taskId: string): Promise<string> {
  seq += 1
  const sid = `33333333-4444-5555-6666-${String(seq).padStart(12, '0')}`
  // Idle, not in a turn: a caller's own session takes no slot.
  await createSessionRecord(sid, taskId, 'queue', '/repo/queue', { title: `Session ${seq}`, initialProcessStatus: 'idle' })
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

/** A worker task with a session of its own (an automatic starter). */
async function worker(title: string, running = 0) {
  const { task: parent } = await addTask({ title, project: 'queue' })
  const runningIds = await children(parent.id, Array(running).fill('IN_PROGRESS'))
  const sid = await sessionFor(parent.id)
  return { parent, running: runningIds, sid }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  process.env.WALNUT_START_QUEUE = '1'
  mac(true)
  // The CLI spawn only: the runner marks the task running the way the real one does.
  vi.spyOn(sessionRunner, 'startSession').mockImplementation(async (data: any) => {
    const sid = data.preassignedSessionId as string
    if (failFor.has(data.taskId)) throw new Error('spawn refused for the test')
    if (lostFor.has(data.taskId)) throw new Error('daemon command timeout: spawn answer lost for the test')
    spawned.push(data.taskId)
    await updateTaskRaw(data.taskId, { phase: 'IN_PROGRESS' as never })
    return { claudeSessionId: sid, title: 'x' } as never
  })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterEach(async () => {
  // One queue for every host: what a test left queued would start in the next.
  mac(true)
  // A started session holds its slot a minute (host-admission.ts): each test starts on a free Mac.
  __resetHostAdmissionForTesting()
  for (const t of await listTasks()) if (t.start_queue) await clearStartQueue(t.id, 'test cleanup')
})

afterAll(async () => {
  delete process.env.WALNUT_START_QUEUE
  __setHostLoadProberForTesting(null)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

/** What Walnut delivered to a session (session-send-core.ts deliverToSession), spied. */
const delivered = vi.spyOn(sendCore, 'deliverToSession')
const toldTo = (sid: string) => delivered.mock.calls.filter(([rec]) => rec.claudeSessionId === sid).map(([, o]) => o.busText).join('\n')

/** An entry an older Walnut queued (the start queue is no longer written). */
async function oldEntry(taskId: string, parentId: string, callerSid: string, params: Record<string, unknown> = {}) {
  await updateTaskRaw(taskId, { start_queue: {
    at: new Date(Date.now() - 60_000).toISOString(), parent_id: parentId, caller_sid: callerSid, host: '__local__', reason: 'all 7 slots taken',
    params: { cwd: os.tmpdir(), message: `queued ${taskId}`, expectReply: false, ...params },
  } } as never)
}

describe('a worker\'s start on each host\'s slots', () => {
  it('no host with room: a 409 hosts_full to the worker, naming the host and why; nothing is queued', async () => {
    const { parent, sid } = await worker('Busy lead')
    const [next] = await children(parent.id, ['TODO'])
    const res = await startAs(sid, next, { message: 'go' })
    expect(res.status).toBe(409)
    expect(res.json.error).toMatchObject({ code: 'hosts_full' })
    expect(res.json.error.message).toMatch(new RegExp(`^Task ${next} did not start: this Mac has no room \\(load past 6 per CPU\\)\\. `))
    expect(res.json.error.message).not.toMatch(DO_IT_YOURSELF)
    expect(res.json.detail).toMatchObject({ host: '__local__', label: 'this Mac', reason: 'load past 6 per CPU' })
    // On the task too, where task_get, the Board and its lead read it (review round 6).
    const after = await getTask(next)
    expect(after.start_queue ?? undefined).toBeUndefined()
    expect(taskExecution(after as never)).toMatchObject({ state: 'error', error: 'Did not start: this Mac has no room (load past 6 per CPU).' })
    // The status the Board and the lead read, as its sync derives it from the record.
    const { syncUserStatuses } = await import('../../../src/core/user-status-sync.js')
    await syncUserStatuses(new Set([next]))
    expect((await getTask(next)).user_status)
      .toMatchObject({ state: 'waiting', kind: 'not-started', waitingOn: 'Did not start: this Mac has no room (load past 6 per CPU).' })
    expect(spawned).not.toContain(next)
    expect(startsAdmittedOn('__local__')).toBe(0)
  })

  it('the start answers once the session is up (a sync call, 2026-11-06)', async () => {
    mac(false)
    const { parent, sid } = await worker('Lead on a free Mac')
    const [next] = await children(parent.id, ['TODO'])
    const res = await startAs(sid, next, { message: 'go' })
    expect(res.status).toBe(202)
    expect(res.json).toMatchObject({ taskId: next, started: true })
    expect(spawned).toContain(next)
  })

  it('a start whose session does not confirm is an error to the worker, never a 202 it reads as started', async () => {
    mac(false)
    const { parent, sid } = await worker('Lead whose start is not confirmed')
    const [next] = await children(parent.id, ['TODO'])
    lostFor.add(next)
    const res = await startAs(sid, next, { message: 'go' })
    expect(res.status).toBe(504)
    expect(res.json.error).toMatchObject({ code: 'start_unconfirmed' })
    expect(res.json.error.message).toMatch(new RegExp(`^Task ${next} did not confirm it started within 110 seconds\\. Do not start it again`))
    expect(res.json.detail).toMatchObject({ taskId: next })
  })

  it('a worker\'s message to a task whose conversation has no live session resumes it only when its host has room', async () => {
    const { parent, sid } = await worker('Lead resuming a stopped child')
    const [stopped] = await children(parent.id, ['IN_PROGRESS'])
    seq += 1
    const old = `33333333-4444-5555-6666-${String(seq).padStart(12, '0')}`
    await createSessionRecord(old, stopped, 'queue', os.tmpdir(), { title: 'Stopped child', initialProcessStatus: 'stopped' })
    await updateTaskRaw(stopped, { session_ids: [old], session_id: old } as never)
    const res = await startAs(sid, stopped, { message: 'go on' })
    expect(res.status).toBe(409)
    expect(res.json.error).toMatchObject({ code: 'hosts_full' })
    expect(res.json.detail).toMatchObject({ taskId: stopped, host: '__local__' })
    expect(startsAdmittedOn('__local__')).toBe(0)
  })

  it('a host over its load cap but not full still takes an automatic start (the load caps only steer placement)', async () => {
    mac('busy')
    const { parent, sid } = await worker('Lead on a busy Mac')
    const [next] = await children(parent.id, ['TODO'])
    const res = await startAs(sid, next, { message: 'go' })
    expect(res.status).toBe(202)
    expect(spawned).toContain(next)
  })

  it('no lead cap: a worker with 20 subtasks running starts the next at once when its host has room', async () => {
    mac(false)
    const { parent, sid } = await worker('Lead with twenty running', 20)
    const [next] = await children(parent.id, ['TODO'])
    const res = await startAs(sid, next, { message: 'go' })
    expect(res.status).toBe(202)
    expect(spawned).toContain(next)
  })

  it("a person's start and a start quoting the user's words start at once on a full host; a token is refused", async () => {
    const { parent, sid } = await worker('Lead the person overrides')
    const [byPerson, asked, token] = await children(parent.id, ['TODO', 'TODO', 'TODO'])
    const person = await startAs(undefined, byPerson, { message: 'now, from the board' })
    expect(person.status).toBe(202)
    expect((await getTask(byPerson)).last_start?.state).toBe('started')
    const userAsked = await startAs(sid, asked, { message: 'now', user_request: 'please start this one now, I am waiting' })
    expect(userAsked.status).toBe(202)
    expect(spawned).toContain(asked)
    // A too-short quote is a 400 and records nothing.
    const refused = await startAs(sid, token, { message: 'go', user_request: 'now' })
    expect(refused.status).toBe(400)
    expect((await getTask(token)).last_start).toBeUndefined()
  })
})

describe('the starts an older Walnut queued', () => {
  it('start for real once there is room, highest priority first', async () => {
    const { parent, sid } = await worker('Lead with old entries')
    const [plain, urgent] = await children(parent.id, ['TODO', 'TODO'])
    await updateTaskRaw(urgent, { priority: 'immediate' as never })
    for (const id of [plain, urgent]) await oldEntry(id, parent.id, sid)
    expect(taskExecution(await getTask(plain) as never)).toMatchObject({ state: 'queued' })
    mac(false)
    const out = await drainStartQueue()
    expect(out.started).toEqual([urgent, plain])
    for (const id of [urgent, plain]) {
      const t = await getTask(id)
      expect(t.start_queue ?? undefined).toBeUndefined()
      expect(t.last_start?.state).toBe('started')
    }
  })

  it('fail loudly on a full host: the entry goes, the failure is on the task, and the asker is told now', async () => {
    const { parent, sid } = await worker('Lead whose old entry cannot start')
    const [stuck] = await children(parent.id, ['TODO'])
    await oldEntry(stuck, parent.id, sid)
    const out = await drainStartQueue()
    expect(out.failed).toEqual([stuck])
    const after = await getTask(stuck)
    expect(after.start_queue ?? undefined).toBeUndefined()
    expect(taskExecution(after as never)).toMatchObject({ state: 'error', error: expect.stringMatching(/did not start: this Mac has no room/i) })
    const told = toldTo(sid)
    expect(told).toContain(`(${stuck}), which you started and Walnut had queued since`)
    expect(told).toContain('Walnut no longer queues starts')
    expect(spawned).not.toContain(stuck)
  })

  it("one that quotes the user's words starts at once on a full host", async () => {
    const { parent, sid } = await worker('Lead with an old user-asked entry')
    const [asked] = await children(parent.id, ['TODO'])
    await oldEntry(asked, parent.id, sid, { userRequest: 'please start this one now, I am waiting' })
    expect((await drainStartQueue()).started).toEqual([asked])
  })

  it('drops a COMPLETE task, one whose asker finished, and holds a team-stopped team until it resumes', async () => {
    const { parent, sid } = await worker('Lead with a stopped team')
    const [done, held] = await children(parent.id, ['TODO', 'TODO'])
    for (const id of [done, held]) await oldEntry(id, parent.id, sid)
    await updateTaskRaw(done, { phase: 'COMPLETE' as never })
    await updateTaskRaw(parent.id, { team_stop: { at: new Date().toISOString(), by: 'human', when: 'now', members: [] } as never })
    mac(false)
    const whileStopped = await drainStartQueue()
    expect(whileStopped.dropped).toContain(done)
    expect(whileStopped.held).toEqual([held])
    expect(spawned).not.toContain(held)
    await updateTaskRaw(parent.id, { team_stop: null as never })
    expect((await drainStartQueue()).started).toEqual([held])

    const { parent: finished, sid: finishedSid } = await worker('Lead that finished')
    const [orphan] = await children(finished.id, ['TODO'])
    await oldEntry(orphan, finished.id, finishedSid)
    await updateTaskRaw(finished.id, { phase: 'COMPLETE' as never })
    expect((await drainStartQueue()).dropped).toContain(orphan)
    expect(spawned).not.toContain(orphan)
  })

  it("Start now runs one as the user's own on a full host; the user's Cancel says so on the task; a run after a cancel starts nothing", async () => {
    const { parent, sid } = await worker('Lead the user overrides from the page')
    const [now, cancelled] = await children(parent.id, ['TODO', 'TODO'])
    for (const id of [now, cancelled]) await oldEntry(id, parent.id, sid)
    const res = await fetch(api(`/api/v1/tasks/${now}/start-queue/start`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ taskId: now })
    expect(spawned).toContain(now)
    expect((await getTask(now)).start_queue ?? undefined).toBeUndefined()
    expect((await fetch(api(`/api/v1/tasks/${now}/start-queue/start`), { method: 'POST' })).status).toBe(404)

    const entry = (await getTask(cancelled)).start_queue!
    const del = await fetch(api(`/api/v1/tasks/${cancelled}/start-queue?by=person`), { method: 'DELETE' })
    expect(await del.json()).toMatchObject({ cleared: true })
    expect(taskExecution(await getTask(cancelled) as never)).toMatchObject({ state: 'error', error: 'The user cancelled this queued start; it did not run.' })
    // A pass that read the entry before the cancel runs it after: nothing starts.
    mac(false)
    const late = await startSessionForTask({ ...entry.params, taskIdPrefix: cancelled, callerSid: sid, source: 'start-queue', queuedAt: entry.at } as never)
      .catch((e: unknown) => e) as Error
    expect(late.name).toBe('QueuedStartGoneError')
    expect(spawned).not.toContain(cancelled)
    expect(slotHoldersOn('__local__')).toEqual([now])
  })

  it('a run that fails for another reason is dropped, with the failure on the task, and gives its slot back', async () => {
    const { parent, sid } = await worker('Lead whose old entry fails')
    const [broken] = await children(parent.id, ['TODO'])
    await oldEntry(broken, parent.id, sid)
    failFor.add(broken)
    mac(false)
    const out = await drainStartQueue()
    expect(out.failed).toEqual([broken])
    const after = await getTask(broken)
    expect(after.start_queue ?? undefined).toBeUndefined()
    expect(after.last_start?.state).toBe('failed')
    expect(taskExecution(after as never).state).toBe('error')
    expect(startsAdmittedOn('__local__')).toBe(0)
  })
})

// 2026-11-06, the user: "if a task has not updated for a while, the VP gets a notification and checks it".
describe('a task asked to start or sent work that shows nothing for 10 minutes tells its asker', () => {
  it('once, waking it; never for a task whose session runs or ran since the ask', async () => {
    const { remindSilent, SILENT_AFTER_MS } = await import('../../../src/core/sessions/session-request-notify.js')
    const { createSessionRequest } = await import('../../../src/core/session-requests.js')
    const { parent, sid } = await worker('Lead that asked and heard nothing')
    const [silent, busy] = await children(parent.id, ['TODO', 'TODO'])
    const ask = await createSessionRequest({ fromSessionId: sid, fromTaskId: parent.id, toTaskId: silent, text: 'Do the silent part.' })
    seq += 1
    const busySid = `33333333-4444-5555-6666-${String(seq).padStart(12, '0')}`
    await createSessionRecord(busySid, busy, 'queue', '/repo/queue', { title: 'Busy child', initialProcessStatus: 'running' })
    await createSessionRequest({ fromSessionId: sid, fromTaskId: parent.id, toTaskId: busy, toSessionId: busySid, text: 'Do the busy part.' })
    // 2026-11-07: idle between turns, but it messaged its lead after the ask: at work, never told silent.
    const [talked] = await children(parent.id, ['TODO'])
    seq += 1
    const talkedSid = `33333333-4444-5555-6666-${String(seq).padStart(12, '0')}`
    await createSessionRecord(talkedSid, talked, 'queue', '/repo/queue', { title: 'Child that wrote back', initialProcessStatus: 'idle' })
    await createSessionRequest({ fromSessionId: sid, fromTaskId: parent.id, toTaskId: talked, toSessionId: talkedSid, text: 'Do the third part.' })
    await createSessionRequest({ fromSessionId: talkedSid, fromTaskId: talked, toSessionId: sid, text: 'Which file holds it?' })

    // Not yet ten minutes: nothing.
    expect(await remindSilent(Date.now() + SILENT_AFTER_MS - 60_000)).toBe(0)
    const later = Date.now() + SILENT_AFTER_MS + 60_000
    expect(await remindSilent(later)).toBe(1)
    const told = toldTo(sid)
    expect(told).toContain(`(${silent}) has shown nothing for 11 minutes since you asked (${ask.id}): no session of it ever started.`)
    expect(told).not.toContain(busy)
    expect(told).not.toContain(talked)
    // Only once.
    expect(await remindSilent(later + 60_000)).toBe(0)
  })
})
