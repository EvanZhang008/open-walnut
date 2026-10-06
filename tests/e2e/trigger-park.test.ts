/**
 * A trigger parks the task it is for (src/core/routines/trigger-api.ts
 * parkForTrigger, the api-v1 task PATCH), and no park sends a letter.
 *
 * 2026-10-04: a session finished its part, reported that a review was pending
 * and asked the user to watch it; the user had to say "make a trigger" and then
 * "don't ask me to do it". Now `trigger_create` on the caller's own task moves it
 * to WAITING in the same call (`wait:false` keeps it where it is while work
 * remains).
 *
 * 2026-10-05: the inbox letter every park then sent ("Waiting: <title>") filled
 * the user's inbox, one per re-park after each fire. Parks are quiet now; a stray
 * `wait_report` from a caller that still sends one is ignored, never a 400.
 *
 * Harness as in task-waiting.test.ts: the daemon LOOKUP is stubbed and fires are
 * handed to the sink directly; delivery and the session's turns are the real
 * code path against the mock daemon + mock CLI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-park-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { handleTriggerFired } from '../../src/core/routines/trigger-events.js'
import { getOp } from '../../src/ops/index.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const DAY = 86_400_000

let server: HttpServer
let port: number
let daemon: MockDaemon

function fakeDaemon(): TriggerDaemon {
  return {
    host: '__local__',
    hasCapability: (cap) => cap === 'triggers-v1',
    triggersPushed: true,
    async send() { return { ok: true } },
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

/** A session whose first turn has ended (its task handed back as Need Action). */
async function startSession(message: string): Promise<{ sid: string; taskId: string }> {
  const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message })
  expect(started.status, JSON.stringify(started.json)).toBe(200)
  const out = { sid: started.json.sessionId as string, taskId: started.json.taskId as string }
  await until('first hand-back', () => task(out.taskId), (t) => t.phase === 'NEED_ACTION')
  return out
}

const triggerBody = (extra: Record<string, unknown> = {}) => ({
  run: 'bash ~/.open-walnut/triggers/pr-123/check.sh', every: '5m',
  prompt: 'Read the review on PR 123 and do the next step.',
  description: 'Checks PR 123 for a review every 5 minutes; the session makes the requested change or merges it.',
  ...extra,
})

async function createTrigger(sid: string | null, extra: Record<string, unknown> = {}) {
  return req('POST', '/api/v1/routines/trigger', triggerBody(extra), sid ? { 'x-walnut-caller-sid': sid } : {})
}

async function letters(): Promise<any[]> {
  return (await req('GET', '/api/v1/human-inbox')).json.letters
}

async function lettersFor(taskId: string): Promise<any[]> {
  return (await letters()).filter((l) => (l.taskRefs ?? []).includes(taskId))
}

async function jobCount(): Promise<number> {
  return ((await req('GET', '/api/routines?includeDisabled=true')).json.jobs as unknown[]).length
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
}, 90_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('trigger_create parks the caller\'s own task by default', () => {
  it('Waiting with the 1-day clock, and no letter', async () => {
    const { sid, taskId } = await startSession('fix the menu page and get PR 123 merged')
    const before = Date.now()
    const r = await createTrigger(sid)
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    expect(r.json.wait).toMatchObject({ parked: true, task_id: taskId })
    expect(r.json.wait.already_waiting).toBeUndefined()

    const t = await task(taskId)
    expect(t.phase).toBe('WAITING')
    expect(t.status).toBe('todo')
    expect(t.unread).toBeFalsy()
    const ahead = Date.parse(t.wait_until) - before
    expect(ahead).toBeGreaterThanOrEqual(DAY)
    expect(ahead).toBeLessThan(DAY + 60_000)
    expect(r.json.wait.wait_until).toBe(t.wait_until)
    expect(r.json.wait).not.toHaveProperty('letter_id')
    expect(await lettersFor(taskId)).toHaveLength(0)
  })

  it('a stray wait_report from an older caller is ignored: still parked, still no letter', async () => {
    const { sid, taskId } = await startSession('an older session parks with a report')
    const r = await createTrigger(sid, { wait_report: 'PR 123 is pushed and CI is green.' })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    expect(r.json.wait).toMatchObject({ parked: true, task_id: taskId })
    expect((await task(taskId)).phase).toBe('WAITING')
    expect(await lettersFor(taskId)).toHaveLength(0)
  })

  it('the op tells the session it is parked and to end its turn', async () => {
    const { sid, taskId } = await startSession('watch the deploy')
    const call = async (method: string, p: string, body?: unknown) => {
      const r = await req(method, `/api/v1${p}`, body, { 'x-walnut-caller-sid': sid })
      if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.json)}`)
      return r.json
    }
    // trigger_create is a bound op: the executor calls its route, then mapResult.
    const op = getOp('trigger_create')!
    const out = op.mapResult!({ body: await call(op.bind!.method, op.bind!.path, triggerBody()), args: {} }) as any
    expect(out.outcome).toContain('The task is now Waiting, off the user\'s list, until it fires or ')
    expect(out.outcome).not.toMatch(/receipt|inbox/)
    expect(out.next).toMatch(/^End your turn now with one line saying what you wait on/)
    expect((await task(taskId)).phase).toBe('WAITING')
    expect(await lettersFor(taskId)).toHaveLength(0)
  })

  it('wait_until takes a duration, an ISO time, or "" for no clock', async () => {
    const { sid, taskId } = await startSession('wait for the build')
    const before = Date.now()
    const a = await createTrigger(sid, { wait_until: '6h' })
    expect(a.status, JSON.stringify(a.json)).toBe(201)
    const sixHours = Date.parse((await task(taskId)).wait_until) - before
    expect(sixHours).toBeGreaterThanOrEqual(6 * 3_600_000)
    expect(sixHours).toBeLessThan(6 * 3_600_000 + 60_000)

    const iso = new Date(Date.now() + 5 * DAY).toISOString()
    const b = await createTrigger(sid, { wait_until: iso })
    expect(b.json.wait).toMatchObject({ parked: true, already_waiting: true, wait_until: iso })
    expect((await task(taskId)).wait_until).toBe(iso)

    const c = await createTrigger(sid, { wait_until: '' })
    expect(c.json.wait).toMatchObject({ parked: true, wait_until: null })
    expect((await task(taskId)).wait_until).toBeUndefined()
    expect(await lettersFor(taskId)).toHaveLength(0)
  })

  it('a second trigger on a task already waiting keeps its clock, and still sends no letter', async () => {
    const { sid, taskId } = await startSession('two things to watch')
    await createTrigger(sid, { wait_until: '2d', name: 'First watch' })
    const clock = (await task(taskId)).wait_until
    const second = await createTrigger(sid, { name: 'Second watch', description: 'Watches the release channel for the go-ahead.' })
    expect(second.json.wait).toMatchObject({ parked: true, already_waiting: true, wait_until: clock })
    expect((await task(taskId)).wait_until).toBe(clock)
    expect(await lettersFor(taskId)).toHaveLength(0)
  })

  it('a bad wait or wait_until is refused and arms nothing', async () => {
    const { sid, taskId } = await startSession('nothing armed')
    const before = await jobCount()
    for (const [extra, message] of [
      [{ wait_until: 'next week' }, 'neither an ISO datetime nor a duration'],
      [{ wait_until: '2020-01-01T00:00:00Z' }, 'not in the future'],
      [{ wait_until: '0h' }, 'not in the future'],
      [{ wait: 'yes' }, 'wait must be true or false'],
    ] as const) {
      const r = await createTrigger(sid, extra)
      expect(r.status, JSON.stringify(extra)).toBe(400)
      expect(JSON.stringify(r.json)).toContain(message)
    }
    expect(await jobCount()).toBe(before)
    expect((await task(taskId)).phase).toBe('NEED_ACTION')
    expect(await lettersFor(taskId)).toHaveLength(0)
  })
})

describe('when a trigger does not park', () => {
  it('wait:false arms it and leaves the task where it is, with no letter', async () => {
    const { sid, taskId } = await startSession('still working on it')
    const r = await createTrigger(sid, { wait: false })
    expect(r.status).toBe(201)
    expect(r.json.wait).toEqual({ parked: false, task_id: taskId, reason: 'wait_false' })
    expect((await task(taskId)).phase).toBe('NEED_ACTION')
    expect(await lettersFor(taskId)).toHaveLength(0)
  })

  it('a trigger for another task leaves it alone unless wait:true says so', async () => {
    const { sid, taskId: own } = await startSession('watch for the other task')
    const other = await req('POST', '/api/v1/tasks', { title: 'Other task' })
    expect(other.status, JSON.stringify(other.json)).toBe(201)
    const otherId = other.json.task.id as string

    const plain = await createTrigger(sid, { session: otherId })
    expect(plain.json.wait).toEqual({ parked: false, task_id: otherId, reason: 'other_task' })
    expect((await task(otherId)).phase).toBe('TODO')
    expect((await task(own)).phase).toBe('NEED_ACTION')

    const asked = await createTrigger(sid, { session: otherId, wait: true })
    expect(asked.json.wait).toMatchObject({ parked: true, task_id: otherId })
    expect((await task(otherId)).phase).toBe('WAITING')
    expect(await lettersFor(otherId)).toHaveLength(0)
    expect((await task(own)).phase).toBe('NEED_ACTION')
  })

  it('a human creating a trigger by task id parks nothing unless asked, and gets no letter', async () => {
    const t = await req('POST', '/api/v1/tasks', { title: 'Human trigger' })
    const id = t.json.task.id as string
    const plain = await createTrigger(null, { session: id })
    expect(plain.json.wait).toMatchObject({ parked: false, reason: 'other_task' })
    const asked = await createTrigger(null, { session: id, wait: true })
    expect(asked.json.wait).toMatchObject({ parked: true })
    expect(asked.json.wait.letter_id).toBeUndefined()
    expect((await task(id)).phase).toBe('WAITING')
    expect(await lettersFor(id)).toHaveLength(0)
  })

  it('a completed task is never parked, even when asked', async () => {
    const { sid } = await startSession('close the other one')
    const t = await req('POST', '/api/v1/tasks', { title: 'Done already' })
    const id = t.json.task.id as string
    expect((await req('PATCH', `/api/v1/tasks/${id}`, { phase: 'COMPLETE' })).status).toBe(200)
    const r = await createTrigger(sid, { session: id, wait: true })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    expect(r.json.wait).toEqual({ parked: false, task_id: id, reason: 'complete' })
    expect((await task(id)).phase).toBe('COMPLETE')
    expect(await lettersFor(id)).toHaveLength(0)
  })
})

describe('the turn that parks it', () => {
  it('a reconcile of that same turn (the 30s snapshot pull) leaves it Waiting, and so does the turn\'s end', async () => {
    // 2026-10-04, live: the session armed its trigger mid-turn, the task parked,
    // and six seconds later the snapshot pull (a turn-start with no generation)
    // moved it to In Progress, so the end of that turn handed it back.
    const { sid, taskId } = await startSession('get the checklist reviewed')
    const sent = await req('POST', `/api/v1/sessions/${sid}/messages`, { text: 'slow:6000 arm the watch' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await until('the slow turn to run', () => task(taskId), (t) => t.phase === 'IN_PROGRESS')
    const r = await createTrigger(sid)
    expect(r.json.wait.parked).toBe(true)
    const { applySessionPhase } = await import('../../src/core/phase.js')
    const res = await applySessionPhase(taskId, 'session:turn-start', 'snapshot-apply:test', { sessionId: sid })
    expect(res.changed).toBe(false)
    expect((await task(taskId)).phase).toBe('WAITING')
    // The slow turn ends (6s): still Waiting, no red dot.
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    const after = await task(taskId)
    expect(after.phase).toBe('WAITING')
    expect(after.unread).toBeFalsy()
    // A new turn is its exit, as before.
    await req('POST', `/api/v1/sessions/${sid}/messages`, { text: 'any news?' })
    await until('the new turn to hand it back', () => task(taskId), (t) => t.phase === 'NEED_ACTION')
  })

  it('a background agent coming back inside that turn leaves it Waiting', async () => {
    // The CLI says {running} again when a background agent's result comes back
    // and the model picks the turn up. That is still the turn that parked the
    // task, so it must not count as a new one.
    const prevHold = process.env.MOCK_HOLD_TURN_MS
    process.env.MOCK_HOLD_TURN_MS = '2000'
    try {
      const { sid, taskId } = await startSession('get the change reviewed')
      await req('POST', `/api/v1/sessions/${sid}/messages`, { text: 'hold-turn-test:The reviewer found nothing to change.' })
      await until('the held turn to run', () => task(taskId), (t) => t.phase === 'IN_PROGRESS')
      expect((await createTrigger(sid)).json.wait.parked).toBe(true)
      // The agent returns at 2s and its summary ends the turn 4s later.
      const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
      await new Promise((resolve) => setTimeout(resolve, 6_500))
      await until('the held turn to end', () => getSessionByClaudeId(sid), (s) => s?.process_status === 'idle')
      const after = await task(taskId)
      expect(after.phase).toBe('WAITING')
      expect(after.unread).toBeFalsy()
    } finally {
      if (prevHold === undefined) delete process.env.MOCK_HOLD_TURN_MS
      else process.env.MOCK_HOLD_TURN_MS = prevHold
    }
  }, 40_000)

  it('a reconcile with no turn to compare against (the server restarted mid-turn) leaves it Waiting', async () => {
    // A restarted server attaches to the running CLI without its turn's start,
    // and its first snapshot pull used to read that as a new turn.
    const { sid, taskId } = await startSession('wait for the deploy')
    await createTrigger(sid)
    expect((await task(taskId)).phase).toBe('WAITING')
    const { applySessionPhase } = await import('../../src/core/phase.js')
    const res = await applySessionPhase(taskId, 'session:turn-start', 'snapshot-apply:test', { sessionId: 'attached-elsewhere' })
    expect(res.changed).toBe(false)
    expect((await task(taskId)).phase).toBe('WAITING')
  })
})

describe('the fire brings it back', () => {
  it('a fire into the parked task: In Progress, then Need Action', async () => {
    const { sid, taskId } = await startSession('merge PR 123 once approved')
    const created = await createTrigger(sid)
    expect((await task(taskId)).phase).toBe('WAITING')
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: created.json.job.id, epoch: 'epoch-park', seq: 1, atMs: Date.now(),
      items: [{ id: 'PR-123#approved', title: 'approved' }], durationMs: 3, nextRunAtMs: Date.now() + 300_000,
    })
    const back = await until('the fire\'s turn to end', () => task(taskId), (t) => t.phase === 'NEED_ACTION')
    expect(back.unread).toBe(true)
    expect(back.wait_until).toBeUndefined()
    // The fire needed nothing from the user, so the session parks again: still no letter.
    const again = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING' }, { 'x-walnut-caller-sid': sid })
    expect(again.status, JSON.stringify(again.json)).toBe(200)
    expect((await task(taskId)).phase).toBe('WAITING')
    expect(await lettersFor(taskId)).toHaveLength(0)
  })
})

describe('the clock running out is a check on the trigger', () => {
  // 2026-10-05, the user: a new trigger may be wrong, so the clock is short and
  // each time it runs out the session re-checks the thing and the trigger.
  // One session's notes: a sweep wakes every task whose clock passed.
  const wakeNotes = (sid: string) => [...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
    .filter((c) => c.payload.deferMessage !== true && (c.payload.sid ?? c.payload.sessionId) === sid)
    .map((c) => String(c.payload.text ?? c.payload.message ?? ''))
    .filter((t) => t.includes('from="Walnut: wait until"'))

  it('names the task\'s triggers with their state, asks for a re-check, and a short re-park holds', async () => {
    const { sid, taskId } = await startSession('merge PR 77 once approved')
    const created = await createTrigger(sid, { name: 'PR 77 review', wait_until: '1h' })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    const ahead = Date.parse((await task(taskId)).wait_until) - Date.now()
    expect(ahead).toBeGreaterThan(3_500_000)
    expect(ahead).toBeLessThanOrEqual(3_600_000)

    daemon.clearCommandHistory()
    const { sweepWaitUntil } = await import('../../src/core/task-wait-until.js')
    expect(await sweepWaitUntil(Date.now() + 2 * 3_600_000)).toContain(taskId)
    const [note] = await until('the wake note', async () => wakeNotes(sid), (n) => n.length > 0)
    expect(note).toContain('The wait on this task ran until')
    expect(note).toContain(`- "PR 77 review" (${created.json.job.id}): armed, every 5m, fired 0 times; it has not reported a single check yet.`)
    expect(note).toContain('only a look at the thing itself tells which')
    expect(note).toMatch(/If it happened and no fire came, the trigger is wrong/)
    expect(note).toMatch(/park again \(task_update phase=WAITING\) with a wait_until for when you now expect it, kept short/)
    await until('the wake turn to end', () => task(taskId), (t) => t.phase === 'NEED_ACTION')

    // The session found it still to come: a re-park with a short duration.
    const h = { 'x-walnut-caller-sid': sid }
    const again = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING', wait_until: '2h' }, h)
    expect(again.status, JSON.stringify(again.json)).toBe(200)
    const reparked = await task(taskId)
    expect(reparked.phase).toBe('WAITING')
    expect(Math.abs(Date.parse(reparked.wait_until) - (Date.now() + 2 * 3_600_000))).toBeLessThan(60_000)
    // And a park that named no time can be re-timed alone, as the op outcome says.
    const retimed = await req('PATCH', `/api/v1/tasks/${taskId}`, { wait_until: '30m' }, h)
    expect(retimed.status, JSON.stringify(retimed.json)).toBe(200)
    expect(Math.abs(Date.parse((await task(taskId)).wait_until) - (Date.now() + 1_800_000))).toBeLessThan(60_000)
    expect(await lettersFor(taskId)).toHaveLength(0)
  })

  it('says a paused trigger is not checking at all', async () => {
    const { sid, taskId } = await startSession('wait for the vendor reply')
    const created = await createTrigger(sid, { name: 'Vendor reply', wait_until: '1h' })
    const paused = await req('PATCH', `/api/v1/routines/${created.json.job.id}`, { enabled: false })
    expect(paused.status, JSON.stringify(paused.json)).toBe(200)
    daemon.clearCommandHistory()
    const { sweepWaitUntil } = await import('../../src/core/task-wait-until.js')
    expect(await sweepWaitUntil(Date.now() + 2 * 3_600_000)).toContain(taskId)
    const [note] = await until('the wake note', async () => wakeNotes(sid), (n) => n.length > 0)
    expect(note).toContain(`- "Vendor reply" (${created.json.job.id}): PAUSED, so it is not checking at all`)
  })

  it('a park with no trigger keeps the plain note', async () => {
    const { sid, taskId } = await startSession('remind me after lunch')
    await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING', wait_until: '1h' }, { 'x-walnut-caller-sid': sid })
    daemon.clearCommandHistory()
    const { sweepWaitUntil } = await import('../../src/core/task-wait-until.js')
    expect(await sweepWaitUntil(Date.now() + 2 * 3_600_000)).toContain(taskId)
    const [note] = await until('the wake note', async () => wakeNotes(sid), (n) => n.length > 0)
    expect(note).toContain('No trigger watches it. Take it from here')
    expect(note).not.toContain('Triggers on this task')
  })
})

describe('task PATCH into WAITING sends no letter', () => {
  it('a session\'s park sends none, again or with a stray wait_report', async () => {
    const { sid, taskId } = await startSession('park by hand')
    const h = { 'x-walnut-caller-sid': sid }
    const first = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING' }, h)
    expect(first.status, JSON.stringify(first.json)).toBe(200)
    expect(first.json).not.toHaveProperty('wait_receipt')
    expect((await task(taskId)).phase).toBe('WAITING')

    const again = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING' }, h)
    expect(again.status).toBe(200)
    const stray = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING', wait_report: 'Waiting for the vendor.' }, h)
    expect(stray.status, JSON.stringify(stray.json)).toBe(200)
    expect(stray.json).not.toHaveProperty('wait_receipt')
    expect(await lettersFor(taskId)).toHaveLength(0)

    // A letter the session decides to send (the user asked to be told) still lands,
    // so the zeros above are about the park, not a broken inbox read.
    const sent = await req('POST', '/api/v1/human-inbox', {
      subject: 'The vendor replied', type: 'info', markdown: 'You asked to hear when they did.', task_refs: [taskId],
    }, h)
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    expect(await lettersFor(taskId)).toHaveLength(1)
  })

  it('a human\'s park sends none', async () => {
    const t = await req('POST', '/api/v1/tasks', { title: 'Human park' })
    const id = t.json.task.id as string
    const r = await req('PATCH', `/api/v1/tasks/${id}`, { phase: 'WAITING' })
    expect(r.status).toBe(200)
    expect(await lettersFor(id)).toHaveLength(0)
  })

  it('wait_until takes a duration, and a past one is refused', async () => {
    const { sid, taskId } = await startSession('patch rules')
    const h = { 'x-walnut-caller-sid': sid }
    const past = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING', wait_until: '0h' }, h)
    expect(past.status).toBe(400)
    expect((await task(taskId)).phase).toBe('NEED_ACTION')
    expect(await lettersFor(taskId)).toHaveLength(0)

    const before = Date.now()
    const ok = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING', wait_until: '2d' }, h)
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    const ahead = Date.parse((await task(taskId)).wait_until) - before
    expect(ahead).toBeGreaterThanOrEqual(2 * DAY)
    expect(ahead).toBeLessThan(2 * DAY + 60_000)
  })
})
