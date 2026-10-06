/**
 * The WAITING phase through the real server (src/core/phase.ts, task-manager's
 * held-phase guard, src/core/task-wait-until.ts, the api-v1 PATCH).
 *
 * A session parks its own task with `task_update {phase: WAITING}` as the last
 * call of its turn. The task stays in every list; the end of that turn, a
 * session error and a background phase write leave it alone. The next message
 * into the session (a trigger fire, a human, the wait_until clock) moves it to
 * IN_PROGRESS and the turn ends as NEED_ACTION like any other; a prompt for the
 * human moves it to NEED_ACTION directly. With no session to wake, the clock
 * hands the task back as NEED_ACTION with a red dot and a notice.
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

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-waiting-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { handleTriggerChecked, handleTriggerFired } from '../../src/core/routines/trigger-events.js'
import { listNotifications } from '../../src/core/notifications/store.js'
import { MAX_CONSECUTIVE_CHECK_ERRORS } from '../../src/providers/trigger-check-core.js'
import { getOp } from '../../src/ops/index.js'
import { applySessionPhase } from '../../src/core/phase.js'
import { loadWaitUntilDeadlines, sweepWaitUntil, trackedWaitUntil } from '../../src/core/task-wait-until.js'
import { updateTaskRaw } from '../../src/core/task-manager.js'

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

function envelopes(kind = 'trigger'): string[] {
  return [...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
    .filter((c) => c.payload.deferMessage !== true)
    .map((c) => String(c.payload.text ?? c.payload.message ?? ''))
    .filter((t) => t.includes(`<walnut-message kind="${kind}"`))
}

/** Phase edges of ONE task, in order, while `run` runs. */
async function phasesDuring(taskId: string, run: () => Promise<void>, settled: (seen: string[]) => boolean): Promise<string[]> {
  const { bus, EventNames } = await import('../../src/core/event-bus.js')
  const seen: string[] = []
  const name = `task-waiting-e2e-${Math.random().toString(36).slice(2)}`
  bus.subscribe(name, (e) => {
    const t = (e.data as { task?: { id: string; phase: string } }).task
    if (t?.id === taskId && seen[seen.length - 1] !== t.phase) seen.push(t.phase)
  }, { global: true, interest: [EventNames.TASK_UPDATED] })
  try {
    await run()
    await until('phase edges', async () => [...seen], settled)
  } finally {
    bus.unsubscribe(name)
  }
  return seen
}

let sid = ''
let taskId = ''

const updateOp = () => getOp('task_update')!

async function park(opts: { wait_until?: string } = {}): Promise<any> {
  const out = await updateOp().handler!({ id: taskId, phase: 'WAITING', ...opts }, opCall(sid)) as any
  const t = await task(taskId)
  expect(t.phase).toBe('WAITING')
  expect(t.status).toBe('todo')
  expect(t.unread).toBeFalsy()
  return out
}

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
  await until('first hand-back', () => task(taskId), (t) => t.phase === 'NEED_ACTION')
}, 90_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('task_update phase=WAITING from the session', () => {
  it('parks the task: Waiting, todo bucket, no red dot, the default 1-day clock, and tells the session to end its turn', async () => {
    const before = Date.now()
    const out = await park()
    expect(JSON.stringify(out)).toContain('End your turn now')
    const v1 = await req('GET', `/api/v1/tasks?status=todo`)
    const row = v1.json.tasks.find((t: any) => t.id === taskId)
    expect(row).toMatchObject({ phase: 'WAITING', status: 'todo' })
    // No wait_until named: the default clock, so a snooze is never silent forever.
    const ahead = Date.parse(row.wait_until) - before
    expect(ahead).toBeGreaterThanOrEqual(86_400_000)
    expect(ahead).toBeLessThan(86_400_000 + 60_000)
    // The outcome names the stored clock, not the request (which named none).
    expect(JSON.stringify(out)).toContain(`or the clock at ${row.wait_until}`)
    expect(trackedWaitUntil().has(taskId)).toBe(true)
    // "" asks for no clock on purpose.
    await park({ wait_until: '' })
    expect((await task(taskId)).wait_until).toBeUndefined()
    expect(trackedWaitUntil().has(taskId)).toBe(false)
  })

  it('the turn that set it ending, a session error and the reconciler leave it waiting', async () => {
    for (const trigger of ['session:result', 'session:error'] as const) {
      const res = await applySessionPhase(taskId, trigger, 'test', { sessionId: sid })
      expect(res.changed, trigger).toBe(false)
    }
    const t = await task(taskId)
    expect(t.phase).toBe('WAITING')
    expect(t.unread).toBeFalsy()
  })

  it('a background phase write cannot end it; a deliberate one can', async () => {
    const r = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'IN_PROGRESS' })
    expect(r.status).toBe(200)
    expect((await task(taskId)).phase).toBe('IN_PROGRESS')
    await park()
    await updateTaskRaw(taskId, { phase: 'TODO' } as never)
    expect((await task(taskId)).phase).toBe('WAITING')
  })

  it('a prompt that needs the human moves it to Need Action', async () => {
    const res = await applySessionPhase(taskId, 'session:awaiting-human', 'test', { sessionId: sid })
    expect(res).toMatchObject({ changed: true, newPhase: 'NEED_ACTION' })
    expect((await task(taskId)).unread).toBe(true)
  })
})

describe('what brings a waiting task back', () => {
  it('a trigger fire: the delivered turn runs (In Progress) and ends as Need Action; the trigger keeps polling', async () => {
    const routineId = await createTrigger('cr-1234')
    await park()
    daemon.clearCommandHistory()
    const seen = await phasesDuring(taskId, () => fire(routineId, 1, 'epoch-1'),
      (s) => s.includes('IN_PROGRESS') && s[s.length - 1] === 'NEED_ACTION')
    expect(seen[0]).toBe('IN_PROGRESS')
    const sent = envelopes()
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent[0]).toContain('Tell the user what the review said.')
    // No wait bookkeeping rides the envelope any more.
    expect(sent[0]).not.toContain('was waiting until')
    const back = await task(taskId)
    expect(back.phase).toBe('NEED_ACTION')
    expect(back.unread).toBe(true)
    const routine = await req('GET', `/api/routines/${routineId}`)
    expect(routine.json.job.enabled).toBe(true)
    await req('DELETE', `/api/routines/${routineId}`)
  })

  it('a human message: the same path', async () => {
    await park()
    const seen = await phasesDuring(taskId, async () => {
      const r = await req('POST', `/api/v1/sessions/${sid}/messages`, { text: 'how is it going?' })
      expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
    }, (s) => s.includes('IN_PROGRESS') && s[s.length - 1] === 'NEED_ACTION')
    expect(seen[0]).toBe('IN_PROGRESS')
  })

  it('setting Waiting again mid-conversation holds, and picking another status by hand ends it', async () => {
    await park()
    const r = await req('PATCH', `/api/tasks/${taskId}`, { phase: 'TODO' })
    expect(r.status).toBe(200)
    expect((await task(taskId)).phase).toBe('TODO')
  })

  it(`${MAX_CONSECUTIVE_CHECK_ERRORS} failing checks on its trigger hand the task back with a notice`, async () => {
    const routineId = await createTrigger('flaky-check')
    await park()
    for (let i = 1; i <= MAX_CONSECUTIVE_CHECK_ERRORS; i++) {
      await handleTriggerChecked('__local__', {
        type: 'trigger.checked', id: routineId, atMs: Date.now(), outcome: 'error',
        error: 'exit 1: gh: not logged in', durationMs: 2, nextRunAtMs: Date.now() + 300_000, consecutiveErrors: i,
      })
    }
    const t = await task(taskId)
    expect(t.phase).toBe('NEED_ACTION')
    expect(t.unread).toBe(true)
    const { feed } = await listNotifications()
    const note = feed.find((n) => n.dedupKey === `wait-trigger-failed:${taskId}:${routineId}`)
    expect(note?.title).toContain('Stopped waiting:')
    expect(note?.body).toContain('gh: not logged in')
    await req('DELETE', `/api/routines/${routineId}`)
  })
})

describe('wait_until: the clock', () => {
  it('rides with phase=WAITING, shows in the projection, and is refused on a task that is not waiting', async () => {
    const until1h = new Date(Date.now() + 3_600_000).toISOString()
    const bad = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'IN_PROGRESS', wait_until: until1h })
    expect(bad.status).toBe(400)
    await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'TODO' })
    const notWaiting = await req('PATCH', `/api/v1/tasks/${taskId}`, { wait_until: until1h })
    expect(notWaiting.status).toBe(400)
    const junk = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING', wait_until: 'next friday' })
    expect(junk.status).toBe(400)

    const ok = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING', wait_until: until1h })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json.task).toMatchObject({ phase: 'WAITING', status: 'todo', wait_until: until1h })
    // The timer learned it from the task event.
    expect(trackedWaitUntil().get(taskId)).toBe(Date.parse(until1h))
    // Clearing keeps the wait, drops the clock.
    const cleared = await req('PATCH', `/api/v1/tasks/${taskId}`, { wait_until: '' })
    expect(cleared.json.task.phase).toBe('WAITING')
    expect(cleared.json.task.wait_until).toBeUndefined()
    expect(trackedWaitUntil().has(taskId)).toBe(false)
  })

  it('past it, the session is woken like a trigger: In Progress, then Need Action, and the clock is gone', async () => {
    const until1h = new Date(Date.now() + 3_600_000).toISOString()
    await park({ wait_until: until1h })
    // Half an hour early the sweep leaves it alone.
    expect(await sweepWaitUntil(Date.now() + 30 * 60_000)).not.toContain(taskId)
    expect((await task(taskId)).phase).toBe('WAITING')

    daemon.clearCommandHistory()
    let woke: string[] = []
    const seen = await phasesDuring(taskId, async () => { woke = await sweepWaitUntil(Date.now() + 2 * 3_600_000) },
      (s) => s.includes('IN_PROGRESS') && s[s.length - 1] === 'NEED_ACTION')
    expect(woke).toContain(taskId)
    expect(seen[0]).toBe('IN_PROGRESS')
    const sent = envelopes()
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent[0]).toContain('from="Walnut: wait until"')
    expect(sent[0]).toContain('The wait on this task ran until')
    const back = await task(taskId)
    expect(back.phase).toBe('NEED_ACTION')
    expect(back.wait_until).toBeUndefined()
    // A second sweep finds nothing.
    expect(await sweepWaitUntil(Date.now() + 3 * 3_600_000)).not.toContain(taskId)
  })

  it('with no session to wake, the task comes back as Need Action with a red dot and a notice', async () => {
    const created = await req('POST', '/api/tasks', { title: 'Reply from legal', project: 'p' })
    expect(created.status, JSON.stringify(created.json)).toBeLessThan(300)
    const id = created.json.task?.id ?? created.json.id
    const until1h = new Date(Date.now() + 3_600_000).toISOString()
    const r = await req('PATCH', `/api/v1/tasks/${id}`, { phase: 'WAITING', wait_until: until1h })
    expect(r.status, JSON.stringify(r.json)).toBe(200)

    expect(await sweepWaitUntil(Date.now() + 2 * 3_600_000)).toContain(id)
    const t = await task(id)
    expect(t.phase).toBe('NEED_ACTION')
    expect(t.unread).toBe(true)
    expect(t.wait_until).toBeUndefined()
    const { feed } = await listNotifications()
    const note = feed.find((n) => n.dedupKey === `wait-until:${id}:${until1h}`)
    expect(note?.title).toContain('Waiting is over:')
  })

  it('the boot scan picks up a clock that passed while Walnut was down, and ignores junk', async () => {
    const created = await req('POST', '/api/tasks', { title: 'Boot scan', project: 'p' })
    const id = created.json.task?.id ?? created.json.id
    const past = new Date(Date.now() - 60_000).toISOString()
    await updateTaskRaw(id, { phase: 'WAITING', wait_until: past } as never, { source: 'api' })
    // A malformed value written by an older build must not reach the timer.
    const junkTask = await req('POST', '/api/tasks', { title: 'Junk clock', project: 'p' })
    const junkId = junkTask.json.task?.id ?? junkTask.json.id
    await updateTaskRaw(junkId, { phase: 'WAITING', wait_until: 'not a date' } as never, { source: 'api' })

    await loadWaitUntilDeadlines()
    expect(trackedWaitUntil().has(id)).toBe(true)
    expect(trackedWaitUntil().has(junkId)).toBe(false)
    expect(await sweepWaitUntil(Date.now())).toContain(id)
    expect((await task(id)).phase).toBe('NEED_ACTION')
    expect((await task(junkId)).phase).toBe('WAITING')
  })
})
