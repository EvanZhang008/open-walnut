/**
 * A wait that a turn only interrupted comes back when that turn ends
 * (src/core/task-wait-resume.ts, wired in src/core/phase.ts).
 *
 * 2026-10-25: a worker parked on an armed trigger, its tests still queued,
 * flipped to NEED_ACTION seven times in three and a half hours: a leader's
 * message, a Walnut notice or its own background work ran a turn, the turn
 * ended, the task was handed back and its wait_until was gone. Now such a turn
 * ends back in WAITING with the same clock while the task still has an armed
 * trigger. What still ends a wait for good: the trigger's own fire, the clock,
 * a person's message, a prompt for the human, a session error, a phase write in
 * between, and a trigger that was paused, deleted or stopped meanwhile.
 *
 * Harness as in task-waiting.test.ts: the daemon LOOKUP is stubbed and the
 * trigger events go to the sink directly; delivery and the session's turns are
 * the real code path against the mock daemon + mock CLI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-wait-resume-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { handleTriggerChecked, handleTriggerFired } from '../../src/core/routines/trigger-events.js'
import { MAX_CONSECUTIVE_CHECK_ERRORS } from '../../src/providers/trigger-check-core.js'
import { getOp } from '../../src/ops/index.js'
import { applySessionPhase, handBackTaskOnSessionEnd } from '../../src/core/phase.js'
import { sweepWaitUntil, trackedWaitUntil } from '../../src/core/task-wait-until.js'
import { interruptedWaits, noteInterruptedWait } from '../../src/core/task-wait-resume.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'
import { settleUserStatusSync } from '../../src/core/user-status-sync.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const HOUR = 3_600_000

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

async function until<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
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
function opCall(callerSid: string) {
  return async (method: string, p: string, body?: unknown) => {
    const r = await req(method, `/api/v1${p}`, body, { 'x-walnut-caller-sid': callerSid })
    if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.json)}`)
    return r.json
  }
}

/** Phase edges of ONE task, in order, while `run` runs, until `settled` says so. */
async function phasesDuring(taskId: string, run: () => Promise<void>, settled: (seen: string[]) => boolean, timeoutMs?: number): Promise<string[]> {
  const { bus, EventNames } = await import('../../src/core/event-bus.js')
  const seen: string[] = []
  // Edges away from where the task stands now: a late write that repeats the current phase (the
  // user status sync's debounced write after a park) is not an edge.
  let last = (await task(taskId)).phase as string
  const name = `task-wait-resume-e2e-${Math.random().toString(36).slice(2)}`
  bus.subscribe(name, (e) => {
    const t = (e.data as { task?: { id: string; phase: string } }).task
    if (t?.id === taskId && last !== t.phase) { seen.push(t.phase); last = t.phase }
  }, { global: true, interest: [EventNames.TASK_UPDATED] })
  try {
    await run()
    await until('phase edges', async () => [...seen], settled, timeoutMs)
  } finally {
    bus.unsubscribe(name)
  }
  return seen
}

const ended = (s: string[]) => s.includes('IN_PROGRESS') && (s[s.length - 1] === 'WAITING' || s[s.length - 1] === 'NEED_ACTION')

async function sessionStatus(sid: string): Promise<string> {
  const r = await req('GET', `/api/sessions/${sid}`)
  return r.json?.session?.process_status ?? r.json?.process_status ?? ''
}

interface Worker { sid: string; taskId: string }

async function startWorker(message = 'watch the test run', mode?: string): Promise<Worker> {
  const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message, ...(mode ? { mode } : {}) })
  expect(started.status, JSON.stringify(started.json)).toBe(200)
  const w = { sid: started.json.sessionId, taskId: started.json.taskId }
  await until('first hand-back', () => task(w.taskId), (t) => t.phase === 'NEED_ACTION')
  await until('session idle', () => sessionStatus(w.sid), (s) => s !== 'running')
  return w
}

async function park(w: Worker, waitUntil?: string, callerSid = w.sid): Promise<any> {
  await getOp('task_update')!.handler!({ id: w.taskId, phase: 'WAITING', ...(waitUntil !== undefined ? { wait_until: waitUntil } : {}) }, opCall(callerSid))
  const t = await task(w.taskId)
  expect(t.phase).toBe('WAITING')
  return t
}

async function createTrigger(w: Worker, name: string): Promise<string> {
  // A real, quiet check: a missing script makes the daemon's first check an
  // error, whose notice lands in the session as a turn of its own.
  const dir = path.join(os.homedir(), '.open-walnut', 'triggers', name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'check.sh'), 'cat >/dev/null; echo \'{"fire": false}\'\n')
  const r = await req('POST', '/api/v1/routines/trigger', {
    name, run: `bash ~/.open-walnut/triggers/${name}/check.sh`, every: '5m',
    prompt: 'Check the test run and do the next step.',
    description: `Watches ${name}; fires once when the run finishes.`,
    session: 'this',
  }, { 'x-walnut-caller-sid': w.sid })
  expect(r.status, JSON.stringify(r.json)).toBe(201)
  return r.json.job.id
}

const deleteTrigger = (id: string) => req('DELETE', `/api/routines/${id}`)

const peer = (w: Worker, text: string, source = 'peer') => sendMessageToSession(w.sid, text, { source, taskId: w.taskId })

let a: Worker
let trig = ''

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  setTriggerDaemonLookupForTest(() => fakeDaemon())
  a = await startWorker()
  trig = await createTrigger(a, 'test-run')
}, 120_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a turn that only interrupts the wait ends back in Waiting', () => {
  it('a peer message: In Progress while it runs, then Waiting with the same clock and no red dot', async () => {
    const until2h = new Date(Date.now() + 2 * HOUR).toISOString()
    await park(a, until2h)
    const seen = await phasesDuring(a.taskId, () => peer(a, 'status? reply when you can').then(() => {}), ended)
    expect(seen).toEqual(['IN_PROGRESS', 'WAITING'])
    const t = await task(a.taskId)
    expect(t).toMatchObject({ phase: 'WAITING', wait_until: until2h })
    expect(t.unread).toBeFalsy()
    expect(trackedWaitUntil().get(a.taskId)).toBe(Date.parse(until2h))
    expect(interruptedWaits().has(a.taskId)).toBe(false)
  })

  it('a Walnut notice, twice in a row: each turn ends back in Waiting', async () => {
    const until3h = new Date(Date.now() + 3 * HOUR).toISOString()
    await park(a, until3h)
    for (let i = 0; i < 2; i++) {
      const seen = await phasesDuring(a.taskId, () => peer(a, `notice ${i}`, 'walnut-notify').then(() => {}), ended)
      expect(seen).toEqual(['IN_PROGRESS', 'WAITING'])
      expect((await task(a.taskId)).wait_until).toBe(until3h)
    }
  })

  it('a wait with no clock comes back with no clock', async () => {
    await park(a, '')
    expect((await task(a.taskId)).wait_until).toBeUndefined()
    const seen = await phasesDuring(a.taskId, () => peer(a, 'ping').then(() => {}), ended)
    expect(seen).toEqual(['IN_PROGRESS', 'WAITING'])
    expect((await task(a.taskId)).wait_until).toBeUndefined()
  })

  it('a leader parks its idle worker and then writes to it: the worker answers and stays parked on the leader\'s clock', async () => {
    const lead = await startWorker('lead the team')
    const until90m = new Date(Date.now() + 90 * 60_000).toISOString()
    await park(a, until90m, lead.sid)
    const seen = await phasesDuring(a.taskId, () => peer(a, 'the leader asks: how far is the run?').then(() => {}), ended)
    expect(seen).toEqual(['IN_PROGRESS', 'WAITING'])
    expect((await task(a.taskId)).wait_until).toBe(until90m)
  })

  it('a leader parks the worker WHILE the leader\'s message runs: the turn end leaves it parked (held this turn)', async () => {
    const until1h = new Date(Date.now() + HOUR).toISOString()
    await getOp('task_update')!.handler!({ id: a.taskId, phase: 'IN_PROGRESS' }, opCall(a.sid))
    await peer(a, 'slow:2500 run the next step')
    await until('turn running', () => sessionStatus(a.sid), (s) => s === 'running')
    await park(a, until1h)
    await until('turn over', () => sessionStatus(a.sid), (s) => s !== 'running')
    await new Promise((r) => setTimeout(r, 500))
    expect(await task(a.taskId)).toMatchObject({ phase: 'WAITING', wait_until: until1h })
  })

  it('a peer message right after the session parked itself in the same turn: the wait survives the turn end', async () => {
    const until1h = new Date(Date.now() + HOUR).toISOString()
    await getOp('task_update')!.handler!({ id: a.taskId, phase: 'IN_PROGRESS' }, opCall(a.sid))
    const seen = await phasesDuring(a.taskId, async () => {
      await peer(a, 'slow:2500 arm the watch and park')
      await until('turn running', () => sessionStatus(a.sid), (s) => s === 'running')
      await park(a, until1h)
      // A notice injected into the still-running turn leaves WAITING at send time.
      await peer(a, 'a notice lands mid-turn', 'walnut-notify')
    }, (s) => s.length >= 3 && s[s.length - 1] === 'WAITING' && s.lastIndexOf('IN_PROGRESS') > s.indexOf('WAITING'), 30_000)
    expect(seen[seen.length - 1]).toBe('WAITING')
    await until('session idle', () => sessionStatus(a.sid), (s) => s !== 'running')
    await new Promise((r) => setTimeout(r, 1500))
    expect(await task(a.taskId)).toMatchObject({ phase: 'WAITING', wait_until: until1h })
  })
})

describe('what still ends the wait for good', () => {
  it('a person\'s message: its turn ends as Need Action', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    const seen = await phasesDuring(a.taskId, async () => {
      const r = await req('POST', `/api/v1/sessions/${a.sid}/messages`, { text: 'how is it going?' })
      expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
    }, ended)
    expect(seen).toEqual(['IN_PROGRESS', 'NEED_ACTION'])
    expect((await task(a.taskId)).wait_until).toBeUndefined()
  })

  it('a person writing during the interrupting turn: Need Action at its end', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    const seen = await phasesDuring(a.taskId, async () => {
      await peer(a, 'slow:2500 a long answer to the leader')
      await until('turn running', () => sessionStatus(a.sid), (s) => s === 'running')
      const r = await req('POST', `/api/v1/sessions/${a.sid}/messages`, { text: 'also, one question for you' })
      expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
    }, (s) => s[s.length - 1] === 'NEED_ACTION', 30_000)
    expect(seen).not.toContain('WAITING')
    await until('session idle', () => sessionStatus(a.sid), (s) => s !== 'running')
    await new Promise((r) => setTimeout(r, 1500))
    expect((await task(a.taskId)).phase).toBe('NEED_ACTION')
  })

  it('its trigger fires: the fire is what it waited for, so Need Action as before', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    const seen = await phasesDuring(a.taskId, () => handleTriggerFired('__local__', {
      type: 'trigger.fired', id: trig, epoch: 'epoch-1', seq: 1, atMs: Date.now(),
      items: [{ id: 'run-17#done', title: 'run 17 finished' }], durationMs: 3, nextRunAtMs: Date.now() + 300_000,
    }), ended)
    expect(seen).toEqual(['IN_PROGRESS', 'NEED_ACTION'])
  })

  it('the clock: its wake turn ends as Need Action as before', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    const seen = await phasesDuring(a.taskId, async () => { await sweepWaitUntil(Date.now() + 2 * HOUR) }, ended)
    expect(seen).toEqual(['IN_PROGRESS', 'NEED_ACTION'])
  })

  it('a clock that passed during the interrupting turn: the wait comes back and its clock wakes it at once', async () => {
    const soon = new Date(Date.now() + 1_500).toISOString()
    await park(a, soon)
    const seen = await phasesDuring(a.taskId, () => peer(a, 'slow:2500 a long answer').then(() => {}), ended, 30_000)
    expect(seen).toEqual(['IN_PROGRESS', 'WAITING'])
    expect((await task(a.taskId)).wait_until).toBe(soon)
    const woken = await phasesDuring(a.taskId, async () => { expect(await sweepWaitUntil()).toContain(a.taskId) }, ended)
    expect(woken).toEqual(['IN_PROGRESS', 'NEED_ACTION'])
  })

  for (const [what, act] of [
    ['paused', async (id: string) => { await getOp('trigger_pause')!.handler!({ id }, opCall(a.sid)) }],
    ['deleted', async (id: string) => { await deleteTrigger(id) }],
    ['stopped after failing checks', async (id: string) => {
      const { getCronService } = await import('../../src/web/routes/cron.js')
      // No session notice for the errors (cooldown stamped): only the stop is under test.
      await getCronService()!.update(id, { state: { checkErrorNoticeAtMs: Date.now() } })
      for (let i = 1; i <= MAX_CONSECUTIVE_CHECK_ERRORS; i++) {
        await handleTriggerChecked('__local__', {
          type: 'trigger.checked', id, atMs: Date.now(), outcome: 'error',
          error: 'exit 1: not logged in', durationMs: 2, nextRunAtMs: Date.now() + 300_000, consecutiveErrors: i,
        })
      }
    }],
  ] as const) {
    it(`a trigger ${what} during the interrupting turn: Need Action`, async () => {
      const id = await createTrigger(a, `doomed-${what.split(' ')[0]}`)
      await deleteTrigger(trig)
      await park(a, new Date(Date.now() + HOUR).toISOString())
      const seen = await phasesDuring(a.taskId, async () => {
        await peer(a, 'slow:2500 a long answer to the leader')
        await until('turn running', () => sessionStatus(a.sid), (s) => s === 'running')
        await act(id)
      }, (s) => s[s.length - 1] === 'NEED_ACTION', 30_000)
      expect(seen).not.toContain('WAITING')
      await until('session idle', () => sessionStatus(a.sid), (s) => s !== 'running')
      await new Promise((r) => setTimeout(r, 1500))
      expect((await task(a.taskId)).phase).toBe('NEED_ACTION')
      await deleteTrigger(id)
      trig = await createTrigger(a, `test-run-${what.split(' ')[0]}`)
    })
  }

  it('a task with only a clock and no trigger: a peer turn ends as Need Action (it may be the reply it waited for)', async () => {
    await deleteTrigger(trig)
    await park(a, new Date(Date.now() + HOUR).toISOString())
    const seen = await phasesDuring(a.taskId, () => peer(a, 'here is the reply you waited for').then(() => {}), ended)
    expect(seen).toEqual(['IN_PROGRESS', 'NEED_ACTION'])
    trig = await createTrigger(a, 'test-run-again')
  })

  it('the session parks again in the interrupting turn with a new clock: that one stands', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    const until5h = new Date(Date.now() + 5 * HOUR).toISOString()
    await peer(a, 'slow:2500 re-plan the wait')
    await until('turn running', () => sessionStatus(a.sid), (s) => s === 'running')
    await park(a, until5h)
    await until('session idle', () => sessionStatus(a.sid), (s) => s !== 'running')
    await new Promise((r) => setTimeout(r, 1500))
    expect(await task(a.taskId)).toMatchObject({ phase: 'WAITING', wait_until: until5h })
  })

  it('someone sets another status during the interrupting turn: the turn end hands it back, never Waiting', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    await peer(a, 'slow:2500 a long answer')
    await until('turn running', () => sessionStatus(a.sid), (s) => s === 'running')
    const r = await req('PATCH', `/api/tasks/${a.taskId}`, { phase: 'TODO' })
    expect(r.status).toBe(200)
    await until('session idle', () => sessionStatus(a.sid), (s) => s !== 'running')
    await new Promise((r2) => setTimeout(r2, 1500))
    expect((await task(a.taskId)).phase).toBe('NEED_ACTION')
    expect(interruptedWaits().has(a.taskId)).toBe(false)
  })
})

describe('turn ends that are not a plain result', () => {
  it('the reconciler\'s hand-back of an ended turn brings the wait back; a session error does not', async () => {
    const until1h = new Date(Date.now() + HOUR).toISOString()
    await park(a, until1h)
    // The exit edge without a delivered turn: the session stays idle.
    await applySessionPhase(a.taskId, 'session:input', 'test', { sessionId: a.sid, sendSource: 'peer' })
    expect((await task(a.taskId)).phase).toBe('IN_PROGRESS')
    expect(interruptedWaits().get(a.taskId)?.cause).toBe('message')
    expect(await handBackTaskOnSessionEnd(a.taskId, a.sid, 'test', { turnEnd: true })).toBe(true)
    expect(await task(a.taskId)).toMatchObject({ phase: 'WAITING', wait_until: until1h })
    // A late result for the same turn finds it waiting and leaves it.
    expect((await applySessionPhase(a.taskId, 'session:result', 'test', { sessionId: a.sid })).changed).toBe(false)

    await applySessionPhase(a.taskId, 'session:input', 'test', { sessionId: a.sid, sendSource: 'peer' })
    await applySessionPhase(a.taskId, 'session:error', 'test', { sessionId: a.sid })
    expect((await task(a.taskId)).phase).toBe('NEED_ACTION')
    expect(interruptedWaits().has(a.taskId)).toBe(false)
  })

  it('a hand-back for a process that died in the turn (no clean end) is a hand-back', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    await applySessionPhase(a.taskId, 'session:input', 'test', { sessionId: a.sid, sendSource: 'peer' })
    expect(await handBackTaskOnSessionEnd(a.taskId, a.sid, 'session-reconciler')).toBe(true)
    expect((await task(a.taskId)).phase).toBe('NEED_ACTION')
  })

  it('a turn nobody sent that is not the CLI\'s background follow-up (a wakeup, a loop) hands back', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    await applySessionPhase(a.taskId, 'session:input', 'test', { sessionId: a.sid, sendSource: 'peer' })
    const t = await task(a.taskId)
    noteInterruptedWait(a.taskId, { waitUntil: null, leftAt: t.phase_changed_at, sessionId: a.sid, cause: 'self', source: 'test' })
    expect(sessionRunner.findSessionByClaudeId(a.sid)?.lastResultOrigin).not.toBe('task-notification')
    await applySessionPhase(a.taskId, 'session:result', 'test', { sessionId: a.sid })
    expect((await task(a.taskId)).phase).toBe('NEED_ACTION')
  })

  it('a send that is not an interruption ends the remembered wait even when it lands after its turn began', async () => {
    for (const sendSource of ['routine-trigger', 'retry', 'restart', 'ui', undefined]) {
      await park(a, new Date(Date.now() + HOUR).toISOString())
      await applySessionPhase(a.taskId, 'session:input', 'test', { sessionId: a.sid, sendSource: 'peer' })
      expect(interruptedWaits().has(a.taskId)).toBe(true)
      await applySessionPhase(a.taskId, 'session:input', 'test', { sessionId: a.sid, sendSource })
      expect(interruptedWaits().has(a.taskId), String(sendSource)).toBe(false)
      await applySessionPhase(a.taskId, 'session:result', 'test', { sessionId: a.sid })
      expect((await task(a.taskId)).phase, String(sendSource)).toBe('NEED_ACTION')
    }
  })

  it('a stale result from an older turn neither flips nor restores', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    await applySessionPhase(a.taskId, 'session:input', 'test', { sessionId: a.sid, sendSource: 'peer' })
    const live = sessionRunner.findSessionByClaudeId(a.sid)
    expect(live).toBeTruthy()
    const res = await applySessionPhase(a.taskId, 'session:result', 'test', { sessionId: a.sid, turnGen: live!.turnGen - 1 })
    expect(res.changed).toBe(false)
    expect((await task(a.taskId)).phase).toBe('IN_PROGRESS')
    expect(interruptedWaits().has(a.taskId)).toBe(true)
    await applySessionPhase(a.taskId, 'session:result', 'test', { sessionId: a.sid })
    expect((await task(a.taskId)).phase).toBe('WAITING')
  })

  it('a turn the CLI starts itself for its background work: Waiting again while the trigger is armed', async () => {
    const until1h = new Date(Date.now() + HOUR).toISOString()
    await getOp('task_update')!.handler!({ id: a.taskId, phase: 'IN_PROGRESS' }, opCall(a.sid))
    // The turn backgrounds a command and ends; the session parks; the command's
    // completion opens a follow-up turn the CLI starts itself (mock-claude).
    await peer(a, 'detached-followup-test:4000')
    // Its first result lands at ~250 ms with the command still running (no hand-back).
    await new Promise((r) => setTimeout(r, 1200))
    expect((await task(a.taskId)).phase).toBe('IN_PROGRESS')
    await park(a, until1h)
    // The park's own user-status write is not a phase edge of the follow-up turn.
    await settleUserStatusSync()
    const seen = await phasesDuring(a.taskId, async () => {}, (s) => s.includes('IN_PROGRESS') && s[s.length - 1] !== 'IN_PROGRESS', 40_000)
    expect(seen).toEqual(['IN_PROGRESS', 'WAITING'])
    expect(await task(a.taskId)).toMatchObject({ phase: 'WAITING', wait_until: until1h })
  }, 60_000)

  it('the same with no trigger: the follow-up hands the task back', async () => {
    // The previous mock process exits 300 ms after its follow-up; let it go first.
    await until('session idle', () => sessionStatus(a.sid), (s) => s !== 'running')
    await new Promise((r) => setTimeout(r, 1500))
    await deleteTrigger(trig)
    try {
      await getOp('task_update')!.handler!({ id: a.taskId, phase: 'IN_PROGRESS' }, opCall(a.sid))
      await peer(a, 'detached-followup-test:4000')
      // Its first result lands at ~250 ms with the command still running (no hand-back).
      await new Promise((r) => setTimeout(r, 1200))
      expect((await task(a.taskId)).phase).toBe('IN_PROGRESS')
      await park(a, new Date(Date.now() + HOUR).toISOString())
      await settleUserStatusSync()
      const seen = await phasesDuring(a.taskId, async () => {}, (s) => s.includes('IN_PROGRESS') && s[s.length - 1] !== 'IN_PROGRESS', 40_000)
      expect(seen).toEqual(['IN_PROGRESS', 'NEED_ACTION'])
    } finally {
      trig = await createTrigger(a, 'test-run-final')
    }
    await until('session idle', () => sessionStatus(a.sid), (s) => s !== 'running')
    await new Promise((r) => setTimeout(r, 1500))
  }, 60_000)
})

describe('what the task waited for, arriving inside an interrupting turn or as the turn itself', () => {
  it('its trigger fires while a peer\'s turn runs: Need Action at the end', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    const seen = await phasesDuring(a.taskId, async () => {
      await peer(a, 'slow:2500 a long answer to the leader')
      await until('turn running', () => sessionStatus(a.sid), (s) => s === 'running')
      await handleTriggerFired('__local__', {
        type: 'trigger.fired', id: trig, epoch: 'epoch-mid', seq: 1, atMs: Date.now(),
        items: [{ id: 'run-19#done', title: 'run 19 finished' }], durationMs: 3, nextRunAtMs: Date.now() + 300_000,
      })
    }, (s) => s[s.length - 1] === 'NEED_ACTION', 40_000)
    expect(seen).not.toContain('WAITING')
    await until('session idle', () => sessionStatus(a.sid), (s) => s !== 'running', 30_000)
    await new Promise((r) => setTimeout(r, 1500))
    expect((await task(a.taskId)).phase).toBe('NEED_ACTION')
  })

  it('a fire its host delivered straight into the CLI during a peer\'s turn: Need Action at the end', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    await peer(a, 'slow:2500 a long answer to the leader')
    await until('turn running', () => sessionStatus(a.sid), (s) => s === 'running')
    expect(interruptedWaits().has(a.taskId)).toBe(true)
    // The server only hears of it afterwards, as a recorded host delivery (no send of its own).
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: trig, epoch: 'epoch-host', seq: 1, atMs: Date.now(),
      items: [{ id: 'run-21#done', title: 'run 21 finished' }], durationMs: 3, nextRunAtMs: Date.now() + 300_000,
      host: { atMs: Date.now(), sessionId: a.sid, messageId: 'qm-host-test-1', seqs: [1] },
    } as never)
    expect(interruptedWaits().has(a.taskId)).toBe(false)
    await until('session idle', () => sessionStatus(a.sid), (s) => s !== 'running', 30_000)
    await new Promise((r) => setTimeout(r, 1500))
    expect((await task(a.taskId)).phase).toBe('NEED_ACTION')
  })

  it('a host-delivered fire heard only after the wait came back still wakes the task', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    const restored = await phasesDuring(a.taskId, async () => {
      await peer(a, 'slow:1500 a short answer')
      await until('turn running', () => sessionStatus(a.sid), (s) => s === 'running')
    }, ended)
    expect(restored).toEqual(['IN_PROGRESS', 'WAITING'])
    const deliveredAt = Date.parse((await task(a.taskId)).phase_changed_at) - 500 // during the turn
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id: trig, epoch: 'epoch-host-late', seq: 1, atMs: deliveredAt,
      items: [{ id: 'run-22#done', title: 'run 22 finished' }], durationMs: 3, nextRunAtMs: Date.now() + 300_000,
      host: { atMs: deliveredAt, sessionId: a.sid, messageId: 'qm-host-test-2', seqs: [1] },
    } as never)
    expect((await task(a.taskId)).phase).toBe('IN_PROGRESS')
    await applySessionPhase(a.taskId, 'session:result', 'test', { sessionId: a.sid })
    // The watch has fired before, so the clean end of its fire's turn is a standing routine
    // going back to its wait (phase.ts), not a hand-back to the user.
    expect((await task(a.taskId)).phase).toBe('WAITING')
  })

  it('the reply to its own request: Need Action (it is what it waited for)', async () => {
    const lead = await startWorker('lead the run')
    const ask = await opCall(a.sid)('POST', '/messages', { to: lead.taskId, title: 'Run ok?', text: 'is run 20 fine?', expect_reply: true })
    expect(ask.requestId).toMatch(/^rq-/)
    await until('lead turn over', () => sessionStatus(lead.sid), (s) => s !== 'running')
    await until('worker idle', () => sessionStatus(a.sid), (s) => s !== 'running')
    await park(a, new Date(Date.now() + HOUR).toISOString())
    const seen = await phasesDuring(a.taskId, async () => {
      await opCall(lead.sid)('POST', '/messages', { in_reply_to: ask.requestId, title: 'Run 20 is fine', text: 'yes, all green' })
    }, ended)
    expect(seen).toEqual(['IN_PROGRESS', 'NEED_ACTION'])
  })

  it('a peer\'s message into a waiting task tells the session the wait comes back; a person\'s does not', async () => {
    await park(a, new Date(Date.now() + HOUR).toISOString())
    daemon.clearCommandHistory()
    await phasesDuring(a.taskId, () => peer(a, 'quick question from the leader').then(() => {}), ended)
    const sent = () => [...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
      .map((c) => String(c.payload.text ?? c.payload.message ?? ''))
    expect(sent().some((t) => t.includes('quick question from the leader') && t.includes('goes back to Waiting'))).toBe(true)
    daemon.clearCommandHistory()
    await phasesDuring(a.taskId, async () => {
      await req('POST', `/api/v1/sessions/${a.sid}/messages`, { text: 'a person asks' })
    }, ended)
    const human = sent().filter((t) => t.includes('a person asks'))
    expect(human.length).toBeGreaterThan(0)
    expect(human.some((t) => t.includes('goes back to Waiting'))).toBe(false)
  })
})

describe('a line its host delivered straight into the CLI (no send on the server)', () => {
  // 2026-10-29: a same-host peer note went through the host's own delivery
  // (offline-host-core.ts localSend), so the server saw no send, only the
  // daemon's ordered walnut-injected marker and then the CLI's turn. That turn
  // read as the CLI's own ('self'), and its clean end handed the parked task to
  // the user. The stream's copy of the line is what says whose turn it is.
  const kit = createEnvelopeKit()
  let h: Worker
  let lead: Worker

  /**
   * What the host's daemon does for it, and nothing on the server: the ordered marker
   * (daemon-core appendUserMarkerLine), then the FIFO write. The mock CLI answers at
   * once where a real one takes seconds, so the line reaches it only once the marker
   * opened the turn: the order a real turn has.
   */
  async function hostDelivers(w: Worker, content: string): Promise<void> {
    const stream = daemon.streamFilePath(w.sid)
    fsSync.appendFileSync(stream, JSON.stringify({
      type: 'user', subtype: 'walnut-injected', message: { role: 'user', content },
      walnutMessageId: `qm-host-${Math.random().toString(16).slice(2, 18)}`, walnutDelivery: 'ordered',
      timestamp: new Date().toISOString(),
    }) + '\n')
    await until('turn start', () => task(w.taskId), (t) => t.phase === 'IN_PROGRESS')
    const fd = fsSync.openSync(stream.replace(/\.jsonl$/, '.pipe'), fsSync.constants.O_WRONLY | fsSync.constants.O_NONBLOCK)
    try { fsSync.writeSync(fd, JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n') } finally { fsSync.closeSync(fd) }
  }
  /** A live CLI waiting on its FIFO (the mock's multi-turn mode), then the park. */
  async function liveAndParked(w: Worker, waitUntil: string): Promise<void> {
    await getOp('task_update')!.handler!({ id: w.taskId, phase: 'IN_PROGRESS' }, opCall(w.sid))
    await peer(w, 'snapshot-clean-turn')
    await until('clean turn over', () => task(w.taskId), (t) => t.phase === 'NEED_ACTION', 30_000)
    await until('session idle', () => sessionStatus(w.sid), (s) => s !== 'running')
    await park(w, waitUntil)
  }
  /** The host-delivered turn, from its start to its end. */
  const hostTurn = (w: Worker, content: string) => phasesDuring(w.taskId, () => hostDelivers(w, content), ended, 30_000)
  const peerNote = (text: string) => kit.buildPeerWrapper(text, {
    title: 'Lead', shortId: lead.sid.slice(0, 8), sessionId: lead.sid, taskId: lead.taskId, host: 'local',
  }, { title: 'A note from the leader' })

  beforeAll(async () => {
    lead = await startWorker('lead the host team')
    h = await startWorker('watch the host build')
    await createTrigger(h, 'host-build')
  }, 60_000)

  it('a peer\'s note: the turn ends back in Waiting with the same clock', async () => {
    const until2h = new Date(Date.now() + 2 * HOUR).toISOString()
    await liveAndParked(h, until2h)
    expect(await hostTurn(h, peerNote('Hold your build: the store export is blocked until the license is accepted.'))).toEqual(['IN_PROGRESS', 'WAITING'])
    expect(await task(h.taskId)).toMatchObject({ phase: 'WAITING', wait_until: until2h })
  }, 60_000)

  it('Walnut status notices led by the instruction notice: Waiting again', async () => {
    const until1h = new Date(Date.now() + HOUR).toISOString()
    await liveAndParked(h, until1h)
    const policy = kit.buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'task-routing-policy' }, body: 'Your default instructions changed.' })
    const notice = kit.buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'status' }, body: 'A task you follow moved.' })
    expect(await hostTurn(h, `${policy}\n\n${notice}`)).toEqual(['IN_PROGRESS', 'WAITING'])
    expect((await task(h.taskId)).wait_until).toBe(until1h)
  }, 60_000)

  it('a reply to its request: Need Action (it is what it waited for)', async () => {
    await liveAndParked(h, new Date(Date.now() + HOUR).toISOString())
    const reply = kit.buildReplyDeliveryText({ id: 'rq-abc123', preview: 'is the build fine?' } as never, {
      title: 'Lead', shortId: lead.sid.slice(0, 8), host: 'local', sessionId: lead.sid, taskId: lead.taskId,
    }, 'yes, all green')
    expect(await hostTurn(h, reply)).toEqual(['IN_PROGRESS', 'NEED_ACTION'])
  }, 60_000)

  it('a person\'s words, even behind the instruction notice: Need Action', async () => {
    const policy = kit.buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'task-routing-policy' }, body: 'Your default instructions changed.' })
    for (const words of ['how is the build going?', `${policy}\n\nhow is the build going?`]) {
      await liveAndParked(h, new Date(Date.now() + HOUR).toISOString())
      expect(await hostTurn(h, words), words.slice(0, 30)).toEqual(['IN_PROGRESS', 'NEED_ACTION'])
    }
  }, 90_000)
})
describe('a prompt for the human, and the way back to work', () => {
  it('a permission prompt in an interrupting turn: Need Action now, and still after the answer', async () => {
    const b = await startWorker('watch the deploy', 'default')
    await createTrigger(b, 'deploy-watch')
    await park(b, new Date(Date.now() + HOUR).toISOString())
    await peer(b, 'status-permission-test:Bash')
    const prompted = await until('prompt', async () => (await req('GET', `/api/sessions/${b.sid}`)).json, (j) => !!(j?.session ?? j)?.pendingPermission)
    const pending = (prompted.session ?? prompted).pendingPermission
    expect((await task(b.taskId)).phase).toBe('NEED_ACTION')
    expect(interruptedWaits().has(b.taskId)).toBe(false)
    const ans = await req('POST', `/api/sessions/${b.sid}/permission`, { requestId: pending.requestId, allow: true })
    expect(ans.status, JSON.stringify(ans.json)).toBeLessThan(300)
    await until('session idle', () => sessionStatus(b.sid), (s) => s !== 'running')
    await new Promise((r) => setTimeout(r, 1500))
    expect((await task(b.taskId)).phase).toBe('NEED_ACTION')
  }, 60_000)

  it('after a restored wait, a trigger that keeps firing is a standing routine: its fire turn ends back in Waiting, and the task completes', async () => {
    const clock = new Date(Date.now() + HOUR).toISOString()
    await park(a, clock)
    const restored = await phasesDuring(a.taskId, () => peer(a, 'ping').then(() => {}), ended)
    expect(restored).toEqual(['IN_PROGRESS', 'WAITING'])
    const fired = await phasesDuring(a.taskId, () => handleTriggerFired('__local__', {
      type: 'trigger.fired', id: trig, epoch: 'epoch-9', seq: 1, atMs: Date.now(),
      items: [{ id: 'run-18#done', title: 'run 18 finished' }], durationMs: 3, nextRunAtMs: Date.now() + 300_000,
    }), ended)
    // Its second fire: the watch keeps firing, so the task waits on the next one, not on the user
    // (the first fire, above, handed it back: a one-time watch's fire is what it waited for).
    expect(fired).toEqual(['IN_PROGRESS', 'WAITING'])
    // Back on the clock it had when the fire came (the fire's move out of WAITING cleared it).
    expect((await task(a.taskId)).wait_until).toBe(clock)
    const done = await req('POST', `/api/v1/tasks/${a.taskId}/complete`, {})
    expect(done.status, JSON.stringify(done.json)).toBeLessThan(300)
    expect((await task(a.taskId)).phase).toBe('COMPLETE')
  })
})
