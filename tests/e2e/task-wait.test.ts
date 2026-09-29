/**
 * "Wait until a trigger" through the real server (src/core/task-waiting.ts,
 * src/web/routes/task-wait-v1.ts, the task_wait / task_stop_waiting ops).
 *
 * The session parks its own task on a trigger it created. The task stays To Do
 * and visible; a finished turn does not hand it back; the trigger's fire is
 * delivered with a note and, once that turn ends, the task goes back to the
 * human as Need Action. A human message, 5 failing checks, deleting the trigger,
 * Stop waiting and completing the task all end the wait.
 *
 * Harness as in trigger-routines.test.ts: the daemon LOOKUP is stubbed and the
 * trigger events are handed to the sink directly; delivery and the session's
 * turns are the real code path against the mock daemon + mock CLI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-wait-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { handleTriggerChecked, handleTriggerFired } from '../../src/core/routines/trigger-events.js'
import { listNotifications } from '../../src/core/notifications/store.js'
import { MAX_CONSECUTIVE_CHECK_ERRORS } from '../../src/providers/trigger-check-core.js'
import { getOp } from '../../src/ops/index.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

function fakeDaemon(): TriggerDaemon {
  return {
    host: '__local__',
    hasCapability: (cap) => cap === 'triggers-v1',
    triggersPushed: true,
    async send(cmd) {
      if (cmd === 'triggers.test') {
        return { ok: true, result: { ok: true, exitCode: 0, durationMs: 1, stdoutTail: '', stderrTail: '', parsed: { fire: false, hasState: false }, error: null, wouldFire: false, newItemCount: 0 } }
      }
      return { ok: true }
    },
  }
}

const url = (p: string) => `http://localhost:${port}${p}`

async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url(p), {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function task(id: string): Promise<any> {
  const r = await req('GET', `/api/tasks/${id}`)
  return r.json.task ?? r.json
}

async function routine(id: string): Promise<any | null> {
  const r = await req('GET', `/api/routines/${id}`)
  return r.status === 200 ? r.json.job : null
}

async function until<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await probe()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    v = await probe()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 400)}`)
  return v
}

/** The op an agent calls, through the same /api/v1 route and caller header the ops executor uses. */
function opCall(sid: string) {
  return async (method: string, p: string, body?: unknown) => {
    const r = await req(method, `/api/v1${p}`, body, { 'x-walnut-caller-sid': sid })
    if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.json)}`)
    return r.json
  }
}

function envelopes(): string[] {
  return [...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
    .filter((c) => c.payload.deferMessage !== true)
    .map((c) => String(c.payload.text ?? c.payload.message ?? ''))
    .filter((t) => t.includes('<walnut-message kind="trigger"'))
}

let sid = ''
let taskId = ''

async function createTrigger(name: string): Promise<string> {
  const r = await req('POST', '/api/v1/routines/trigger', {
    name, run: `bash ~/.open-walnut/triggers/${name}/check.sh`, every: '5m',
    prompt: 'Tell the user what the review said.',
    description: `Watches ${name}; fires once when the review lands.`,
    session: 'this',
  }, { 'x-walnut-caller-sid': sid })
  expect(r.status, JSON.stringify(r.json)).toBe(201)
  return r.json.job.id
}

async function fire(routineId: string, seq: number, epoch: string) {
  await handleTriggerFired('__local__', {
    type: 'trigger.fired', id: routineId, epoch, seq, atMs: Date.now(),
    items: [{ id: `CR-1234#rev${seq}`, title: 'approved' }], durationMs: 3, nextRunAtMs: Date.now() + 300_000,
  })
}

const waitOp = () => getOp('task_wait')!
const stopOp = () => getOp('task_stop_waiting')!

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  setTriggerDaemonLookupForTest(() => fakeDaemon())

  const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'ship it once CR 1234 is approved' })
  expect(started.status).toBe(200)
  sid = started.json.sessionId
  taskId = started.json.taskId
  // The first turn ends: the task is handed back (red), which is what a wait clears.
  await until('first hand-back', () => task(taskId), (t) => t.phase === 'NEED_ACTION')
}, 90_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('task_wait: parking the calling session\'s task', () => {
  let routineId = ''

  it('parks the task: To Do, no red dot, condition on one line', async () => {
    routineId = await createTrigger('cr-1234')
    const out = await waitOp().handler!({ condition: '  CR 1234\n  is approved ', routine_id: routineId }, opCall(sid)) as any
    expect(out.task.id).toBe(taskId)
    const t = await task(taskId)
    expect(t.phase).toBe('TODO')
    expect(t.unread).toBeFalsy()
    expect(t.waiting).toMatchObject({ condition: 'CR 1234 is approved', routine_id: routineId })
    expect(t.waiting.woke_at).toBeUndefined()
  })

  it('refuses what cannot work, and changes nothing', async () => {
    const other = await req('POST', '/api/tasks', { title: 'another task', project: 'Wait e2e' })
    const otherId = other.json.id ?? other.json.task?.id
    const foreign = await req('POST', '/api/v1/routines/trigger', {
      run: 'bash x.sh', every: '5m', prompt: 'p', description: 'Watches something else.', session: otherId,
    })
    const plain = await req('POST', '/api/routines', {
      name: 'plain', schedule: { kind: 'every', everyMs: 600_000 },
      executor: { type: 'session', config: { target: taskId, prompt: 'p' } },
    })
    const done = await req('POST', '/api/tasks', { title: 'done task', project: 'Wait e2e' })
    const doneId = done.json.id ?? done.json.task?.id
    await req('PATCH', `/api/tasks/${doneId}`, { phase: 'COMPLETE' })
    const h = { 'x-walnut-caller-sid': sid }
    const cases: Array<[string, string, unknown, Record<string, string>, number, RegExp]> = [
      ['no condition', '/api/v1/tasks/this/wait', { routine_id: routineId }, h, 400, /condition is required/],
      ['no routine', '/api/v1/tasks/this/wait', { condition: 'x' }, h, 400, /routine_id is required/],
      ['unknown routine', '/api/v1/tasks/this/wait', { condition: 'x', routine_id: 'nope' }, h, 404, /no trigger nope/],
      ['foreign trigger', '/api/v1/tasks/this/wait', { condition: 'x', routine_id: foreign.json.job.id }, h, 400, /not to this task/],
      ['no check', '/api/v1/tasks/this/wait', { condition: 'x', routine_id: plain.json.job.id }, h, 400, /no check script/],
      ['"this" with no caller', '/api/v1/tasks/this/wait', { condition: 'x', routine_id: routineId }, {}, 400, /no calling session/],
      ['unknown task', '/api/v1/tasks/task-that-never-existed/wait', { condition: 'x', routine_id: routineId }, {}, 404, /./],
      ['complete task', `/api/v1/tasks/${doneId}/wait`, { condition: 'x', routine_id: routineId }, {}, 409, /complete/],
    ]
    for (const [label, p, body, headers, status, msg] of cases) {
      const r = await req('POST', p, body, headers)
      expect(r.status, label).toBe(status)
      expect(r.json?.error?.message ?? '', label).toMatch(msg)
    }
    // The real wait is untouched.
    expect((await task(taskId)).waiting).toMatchObject({ routine_id: routineId, condition: 'CR 1234 is approved' })
    await req('DELETE', `/api/routines/${foreign.json.job.id}`)
    await req('DELETE', `/api/routines/${plain.json.job.id}`)
  })

  it('a turn that ends while waiting keeps the task To Do with no red dot', async () => {
    // An automated send (not a human) so the wait is not ended by the message itself.
    const { sendMessageToSession } = await import('../../src/core/session-message-queue.js')
    const { bus, EventNames } = await import('../../src/core/event-bus.js')
    const seen: string[] = []
    bus.subscribe('task-wait-e2e-phases', (e) => {
      const t = (e.data as { task?: { id: string; phase: string } }).task
      if (t?.id === taskId && seen[seen.length - 1] !== t.phase) seen.push(t.phase)
    }, { global: true, interest: [EventNames.TASK_UPDATED] })
    try {
      await sendMessageToSession(sid, 'keep going', { source: 'auto-continue', taskId })
      // The turn really ran and really ended: IN_PROGRESS, then back to TODO.
      await until('turn start and end', async () => [...seen], (s) => s.includes('IN_PROGRESS') && s[s.length - 1] === 'TODO')
    } finally {
      bus.unsubscribe('task-wait-e2e-phases')
    }
    expect(seen).not.toContain('NEED_ACTION')
    const t = await task(taskId)
    expect(t.phase).toBe('TODO')
    expect(t.unread).toBeFalsy()
    expect(t.waiting.woke_at).toBeUndefined()
  })

  it('the fire ends the wait, tells the session how to keep waiting, and the turn after it hands back', async () => {
    daemon.clearCommandHistory()
    await fire(routineId, 1, 'wait-epoch')
    const sent = await until('fire delivery', async () => envelopes(), (e) => e.length >= 1)
    expect(sent[0]).toContain('Tell the user what the review said.')
    expect(sent[0]).toContain('this task was waiting until: CR 1234 is approved')
    expect(sent[0]).toContain(`"routine_id":"${routineId}"`)
    const woke = await task(taskId)
    expect(woke.waiting).toMatchObject({ routine_id: routineId, woke_reason: 'fired' })
    // The trigger stops polling; its dedup state is kept for a re-arm.
    expect((await routine(routineId)).enabled).toBe(false)
    // The delivered turn ends: Need Action with the red dot.
    const back = await until('hand-back after fire', () => task(taskId), (t) => t.phase === 'NEED_ACTION')
    expect(back.unread).toBe(true)
    expect(back.waiting.settled_at).toBeTruthy()
  })

  it('a later fire of that trigger, turned back on by hand, is an ordinary fire', async () => {
    const r = await req('PATCH', `/api/routines/${routineId}`, { enabled: true })
    expect(r.status).toBe(200)
    daemon.clearCommandHistory()
    await fire(routineId, 2, 'wait-epoch')
    const sent = await until('second delivery', async () => envelopes(), (e) => e.length >= 1)
    expect(sent[0]).toContain('Tell the user what the review said.')
    expect(sent[0]).not.toContain('this task was waiting until')
    // Nothing turns it off again: it is not the wait's fire.
    await new Promise((r2) => setTimeout(r2, 500))
    expect((await routine(routineId)).enabled).toBe(true)
    await until('turn after the ordinary fire', () => task(taskId), (t) => t.phase === 'NEED_ACTION')
  })

  it('re-arming with the same trigger re-enables it and quiets the task again', async () => {
    await req('PATCH', `/api/routines/${routineId}`, { enabled: false })
    // The re-arm is not "too late": the fires in its log are the ones the wait already had.
    const out = await waitOp().handler!({ condition: 'CR 1234 is approved', routine_id: routineId }, opCall(sid)) as any
    expect(JSON.stringify(out)).not.toContain('already fired')
    const t = await task(taskId)
    expect(t.phase).toBe('TODO')
    expect(t.unread).toBeFalsy()
    expect(t.waiting.woke_at).toBeUndefined()
    expect((await routine(routineId)).enabled).toBe(true)
  })

  it(`${MAX_CONSECUTIVE_CHECK_ERRORS} failing checks hand the task back with a notice`, async () => {
    for (let i = 1; i <= MAX_CONSECUTIVE_CHECK_ERRORS; i++) {
      await handleTriggerChecked('__local__', {
        type: 'trigger.checked', id: routineId, atMs: Date.now(), outcome: 'error',
        error: 'exit 1: gh: not logged in', durationMs: 2, nextRunAtMs: Date.now() + 300_000, consecutiveErrors: i,
      })
    }
    const t = await task(taskId)
    expect(t.phase).toBe('NEED_ACTION')
    expect(t.unread).toBe(true)
    expect(t.waiting).toMatchObject({ woke_reason: 'check-failed' })
    const { feed } = await listNotifications()
    const note = feed.find((n) => n.dedupKey === `task-wait-failed:${taskId}:${routineId}`)
    expect(note?.title).toContain('Stopped waiting:')
    expect(note?.body).toContain('gh: not logged in')
  })

  it('deleting the trigger removes the wait', async () => {
    await waitOp().handler!({ condition: 'CR 1234 is approved', routine_id: routineId }, opCall(sid))
    expect((await routine(routineId)).enabled).toBe(true)
    expect((await req('DELETE', `/api/routines/${routineId}`)).status).toBeLessThan(300)
    await until('wait removed', () => task(taskId), (t) => !t.waiting)
  })
})

describe('what else ends a wait', () => {
  it('a human message ends it; the turn after it hands back as usual', async () => {
    const id = await createTrigger('msg-watch')
    await waitOp().handler!({ condition: 'the build is green', routine_id: id }, opCall(sid))
    const r = await req('POST', `/api/v1/sessions/${sid}/messages`, { text: 'actually, do it now' })
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
    const woke = await until('wake by message', () => task(taskId), (t) => t.waiting?.woke_reason === 'message')
    expect(woke.waiting.routine_id).toBe(id)
    await until('trigger disabled', () => routine(id), (j) => j?.enabled === false)
    await until('hand-back', () => task(taskId), (t) => t.phase === 'NEED_ACTION' && t.unread === true)
  })

  it('Stop waiting drops the wait and deletes the trigger; the task stays where it is', async () => {
    const id = await createTrigger('stop-watch')
    await waitOp().handler!({ condition: 'Alex replies', routine_id: id }, opCall(sid))
    const out = await stopOp().handler!({ task: taskId }, opCall(sid)) as any
    expect(out.task.id).toBe(taskId)
    const t = await task(taskId)
    expect(t.waiting).toBeUndefined()
    expect(t.phase).toBe('TODO')
    expect(await routine(id)).toBeNull()
    // Nothing to stop is not an error.
    expect((await req('DELETE', `/api/v1/tasks/${taskId}/wait`)).status).toBe(200)
  })

  it('setting Need Action by hand ends it; In Progress keeps it', async () => {
    const id = await createTrigger('status-watch')
    await waitOp().handler!({ condition: 'the deploy finishes', routine_id: id }, opCall(sid))
    await req('PATCH', `/api/tasks/${taskId}`, { phase: 'IN_PROGRESS' })
    let t = await task(taskId)
    expect(t.phase).toBe('IN_PROGRESS')
    expect(t.waiting.woke_at).toBeUndefined()
    await req('PATCH', `/api/tasks/${taskId}`, { phase: 'NEED_ACTION' })
    t = await task(taskId)
    expect(t.phase).toBe('NEED_ACTION')
    expect(t.waiting).toMatchObject({ woke_reason: 'status-changed' })
    await until('trigger disabled', () => routine(id), (j) => j?.enabled === false)
    await req('PATCH', `/api/tasks/${taskId}`, { phase: 'TODO' })
  })

  it('a trigger that fired before task_wait parks nothing, and says so', async () => {
    const id = await createTrigger('early-watch')
    // The first check found the condition already true, seconds after trigger_create.
    daemon.clearCommandHistory()
    await fire(id, 1, 'early-epoch')
    await until('early delivery', async () => envelopes(), (e) => e.length >= 1)
    const out = await waitOp().handler!({ condition: 'CR 99 is approved', routine_id: id }, opCall(sid)) as any
    expect(JSON.stringify(out)).toContain('already fired')
    const t = await task(taskId)
    expect(t.waiting).toMatchObject({ routine_id: id, woke_reason: 'fired' })
    expect(t.waiting.since >= t.waiting.woke_at).toBe(true)
    // So the fire's turn hands the task back like any other.
    await until('hand-back', () => task(taskId), (v) => v.phase === 'NEED_ACTION')
    // Re-arming after reading it is allowed: that is a decision to keep waiting.
    await waitOp().handler!({ condition: 'CR 99 is approved', routine_id: id }, opCall(sid))
    expect((await task(taskId)).waiting.woke_at).toBeUndefined()
    await stopOp().handler!({}, opCall(sid))
  })

  it('completing the task deletes its trigger and the wait, and adds no task:completed of its own', async () => {
    const id = await createTrigger('done-watch')
    await waitOp().handler!({ condition: 'QA signs off', routine_id: id }, opCall(sid))
    const { bus, EventNames } = await import('../../src/core/event-bus.js')
    let completed = 0
    bus.subscribe('task-wait-e2e-completed', (e) => {
      if ((e.data as { task?: { id: string } }).task?.id === taskId) completed++
    }, { global: true, interest: [EventNames.TASK_COMPLETED] })
    try {
      await req('PATCH', `/api/tasks/${taskId}`, { phase: 'COMPLETE' })
      await until('trigger deleted', () => routine(id), (j) => j === null)
      await new Promise((r) => setTimeout(r, 500))
    } finally {
      bus.unsubscribe('task-wait-e2e-completed')
    }
    // The PATCH itself announces the completion (task:updated); the wait's cleanup
    // writes the COMPLETE row silently, since a write with an event there would
    // emit task:completed and run every completion hook a second time.
    expect(completed).toBe(0)
    const t = await until('wait cleared', () => task(taskId), (v) => !v.waiting)
    expect(t.phase).toBe('COMPLETE')
    // A complete task cannot wait.
    const r = await req('POST', `/api/v1/tasks/${taskId}/wait`, { condition: 'x', routine_id: id })
    expect(r.status).toBe(409)
  })
})
