/**
 * The main agent's task never parks and never hands itself back on a turn end
 * (src/core/org/main-stays-active.ts).
 *
 * 2026-10-25: Main set its own task to WAITING with a wait_until at the end of
 * almost every turn, because its prompt carried the worker's rule "arm a trigger,
 * it parks this task as Waiting". It vanished from the user's task list, added a
 * tool row per turn, and its clock woke it for nothing. Every turn end also
 * painted it NEED_ACTION although it was only answering.
 *
 * Through the real server, the mock daemon and a mock CLI that records its argv:
 * the prompt Main's engine receives, the park refusals (task_update, the PATCH a
 * person's phase picker sends, trigger_create), and the turn-end phase.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-main-stays-active-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { getOp } from '../../src/ops/index.js'
import { applySessionPhase } from '../../src/core/phase.js'
import { ensureMainTask } from '../../src/core/org/org-store.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { updateTask } from '../../src/core/task-manager.js'
import { reconcileProcessStatus } from '../../src/core/session-reconcile.js'
import { updateSessionRecord } from '../../src/core/session-tracker.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { MAIN_DELEGATES_LINE, MAIN_STAYS_ACTIVE_LINE, MAIN_TRACKING_LINE } from '../../src/core/sessions/session-context.js'

const CAPTURE_CLI = path.resolve(import.meta.dirname, 'fixtures/mock-claude-argv-capture.mjs')
const ARGV_DIR = path.join(os.tmpdir(), `walnut-main-argv-${process.pid}`)
const PARK_RULE = 'It parks this task as Waiting'

let server: HttpServer
let port: number
let daemon: MockDaemon
let main: { id: string }
let mainSid: string

function fakeDaemon(): TriggerDaemon {
  return { host: '__local__', hasCapability: (cap) => cap === 'triggers-v1', triggersPushed: true, async send() { return { ok: true } } }
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

/** The --append-system-prompt of every spawn so far that names this task id. */
async function promptsFor(taskId: string): Promise<string[]> {
  const files = await fs.readdir(ARGV_DIR).catch(() => [] as string[])
  const out: string[] = []
  for (const f of files) {
    const argv = JSON.parse(await fs.readFile(path.join(ARGV_DIR, f), 'utf8')) as string[]
    const i = argv.indexOf('--append-system-prompt')
    if (i >= 0 && argv[i + 1]?.includes(`(id ${taskId},`)) out.push(argv[i + 1])
  }
  return out
}

async function startOn(body: Record<string, unknown>): Promise<{ sid: string; taskId: string }> {
  const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', ...body })
  expect(started.status, JSON.stringify(started.json)).toBe(200)
  return { sid: started.json.sessionId as string, taskId: started.json.taskId as string }
}

/** session:result events seen per session id: the edge the turn-end phase write rides. */
const results = new Map<string, number>()

/** A turn is over: its result event went out, and the record settled. */
async function turnOver(sid: string, resultsBefore: number): Promise<void> {
  await until('result event', async () => results.get(sid) ?? 0, (n) => n > resultsBefore, 30_000)
  await until('turn end', async () => (await getSessionByClaudeId(sid))?.process_status, (s) => s === 'idle' || s === 'stopped')
  // The phase write is the result subscriber's next await; a worker's lands well inside this.
  await new Promise((r) => setTimeout(r, 1000))
}

const asMain = (sid: string) => async (method: string, p: string, body?: unknown) => {
  const r = await req(method, `/api/v1${p}`, body, { 'x-walnut-caller-sid': sid })
  if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.rm(ARGV_DIR, { recursive: true, force: true })
  process.env.MOCK_CLAUDE_ARGV_DIR = ARGV_DIR
  bus.subscribe('test-main-results', (event) => {
    const sid = (event.data as { sessionId?: string } | undefined)?.sessionId
    if (sid) results.set(sid, (results.get(sid) ?? 0) + 1)
  }, { global: true, interest: [EventNames.SESSION_RESULT] })
  daemon = await createMockDaemon()
  // The mock daemon spawns its own CLI command; the runner's is a containment guard.
  daemon.setCliCommand(CAPTURE_CLI)
  sessionRunner.setCliCommand(CAPTURE_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  setTriggerDaemonLookupForTest(() => fakeDaemon())
  main = await ensureMainTask()
  const started = await startOn({ taskId: main.id, message: 'how is it going' })
  mainSid = started.sid
  await turnOver(mainSid, 0)
}, 120_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  bus.unsubscribe('test-main-results')
  sessionRunner.setTestDaemonUrl(undefined)
  delete process.env.MOCK_CLAUDE_ARGV_DIR
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(ARGV_DIR, { recursive: true, force: true }).catch(() => {})
})

describe('the prompt Main\'s engine receives', () => {
  it('says Main stays active, and carries no park rule', async () => {
    const prompts = await promptsFor(main.id)
    expect(prompts.length).toBeGreaterThan(0)
    for (const p of prompts) {
      expect(p).toContain('You are the user\'s main agent')
      expect(p).toContain(MAIN_STAYS_ACTIVE_LINE.trim())
      expect(p).toContain('never set your own task to WAITING')
      expect(p).not.toContain(PARK_RULE)
      expect(p).not.toContain('off the user\'s list; the fire brings it back')
      // Main hands big work to subtasks, and carries no rule saying the opposite.
      expect(p).toContain(MAIN_DELEGATES_LINE.trim())
      expect(p).toContain(MAIN_TRACKING_LINE.trim())
      expect(p).not.toContain('Never create or start a task')
    }
  })

  it('a work task still gets the park rule and not Main\'s line', async () => {
    const { sid, taskId } = await startOn({ message: 'fix the menu page' })
    await until('worker hand-back', () => task(taskId), (t) => t.phase === 'NEED_ACTION')
    const [p] = await promptsFor(taskId)
    expect(p).toContain(PARK_RULE)
    expect(p).not.toContain('never set your own task to WAITING')
    expect(sid).toBeTruthy()
  })
})

describe('a turn end leaves Main In Progress', () => {
  it('after its first turn ended, Main is In Progress with no red dot', async () => {
    const t = await task(main.id)
    expect(t.phase).toBe('IN_PROGRESS')
    expect(t.unread).not.toBe(true)
  })

  it('a second turn, sent by the user, ends In Progress too', async () => {
    // Main was red from an older build: the user's message moves it back, and the turn end keeps it there.
    await updateTask(main.id, { phase: 'NEED_ACTION' }, { source: 'api' })
    const before = results.get(mainSid) ?? 0
    const send = await req('POST', `/api/v1/sessions/${mainSid}/messages`, { text: 'and the iOS work?' })
    expect(send.status, JSON.stringify(send.json)).toBeLessThan(300)
    await turnOver(mainSid, before)
    const t = await task(main.id)
    expect(t.phase).toBe('IN_PROGRESS')
    expect(t.unread).not.toBe(true)
  })

  it('a turn-end result and a reconciler hand-back do not move it', async () => {
    expect((await applySessionPhase(main.id, 'session:result', 'test', { sessionId: mainSid })).changed).toBe(false)
    expect((await applySessionPhase(main.id, 'reconciler', 'test', { sessionId: mainSid, newPhase: 'NEED_ACTION' })).changed).toBe(false)
    expect((await task(main.id)).phase).toBe('IN_PROGRESS')
  })

  it('a settled Main is no phase debt for the reconcile lane', async () => {
    const rec = (await getSessionByClaudeId(mainSid))!
    expect(['idle', 'stopped']).toContain(rec.process_status)
    expect(await reconcileProcessStatus(rec, { evidence: 'evidence-was-read' })).toEqual({ converged: false, reason: 'not-running' })
  })

  it('a prompt for the user does mark it as needing them', async () => {
    const r = await applySessionPhase(main.id, 'session:awaiting-human', 'test', { sessionId: mainSid })
    expect(r).toMatchObject({ changed: true, newPhase: 'NEED_ACTION' })
    expect((await task(main.id)).unread).toBe(true)
    await updateTask(main.id, { phase: 'IN_PROGRESS' }, { source: 'api' })
  })

  it('a failure still flags it: a session error, and a reconcile of a session that ended in one', async () => {
    expect(await applySessionPhase(main.id, 'session:error', 'test', { sessionId: mainSid })).toMatchObject({ changed: true, newPhase: 'NEED_ACTION' })
    await updateTask(main.id, { phase: 'IN_PROGRESS' }, { source: 'api' })
    const prev = (await getSessionByClaudeId(mainSid))!.process_status
    await updateSessionRecord(mainSid, { process_status: 'error' })
    try {
      expect(await applySessionPhase(main.id, 'reconciler', 'test', { sessionId: mainSid, newPhase: 'NEED_ACTION' }))
        .toMatchObject({ changed: true, newPhase: 'NEED_ACTION' })
    } finally {
      await updateSessionRecord(mainSid, { process_status: prev })
      await updateTask(main.id, { phase: 'IN_PROGRESS' }, { source: 'api' })
    }
  })
})

describe('Main never parks', () => {
  it('task_update phase=WAITING is not applied, and the outcome says so', async () => {
    const op = getOp('task_update')!
    const out = await op.handler!({ id: main.id, phase: 'WAITING', wait_until: '1h' } as any, asMain(mainSid) as any) as any
    expect(out.phase_ignored).toMatchObject({ phase: 'WAITING', reason: 'main_stays_active' })
    expect(out.outcome).toMatch(/^phase=WAITING was NOT applied\. The main agent's task never parks/)
    expect(out.next).toMatch(/^Do not park this task again/)
    expect(out.next).not.toContain('The task is waiting')
    const t = await task(main.id)
    expect(t.phase).toBe('IN_PROGRESS')
    expect(t.wait_until).toBeUndefined()
  })

  it('the rest of the same patch still applies', async () => {
    const r = await req('PATCH', `/api/v1/tasks/${main.id}`, { phase: 'WAITING', priority: 'important' }, { 'x-walnut-caller-sid': mainSid })
    expect(r.status).toBe(200)
    expect(r.json.phase_ignored?.reason).toBe('main_stays_active')
    expect(r.json.task.priority).toBe('important')
    expect(r.json.task.phase).toBe('IN_PROGRESS')
  })

  it('a wait_until alone is refused with the reason', async () => {
    const r = await req('PATCH', `/api/v1/tasks/${main.id}`, { wait_until: '2h' }, { 'x-walnut-caller-sid': mainSid })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.json)).toContain('main_stays_active')
  })

  it('a person\'s phase picker (no caller) does not park it either', async () => {
    const r = await req('PATCH', `/api/tasks/${main.id}`, { phase: 'WAITING' })
    expect(r.status).toBeLessThan(500)
    expect((await task(main.id)).phase).toBe('IN_PROGRESS')
  })

  it('a work task still parks (control)', async () => {
    const { taskId } = await startOn({ message: 'watch the deploy' })
    await until('worker hand-back', () => task(taskId), (t) => t.phase === 'NEED_ACTION')
    const r = await req('PATCH', `/api/v1/tasks/${taskId}`, { phase: 'WAITING' })
    expect(r.status).toBe(200)
    expect(r.json.phase_ignored).toBeUndefined()
    expect((await task(taskId)).phase).toBe('WAITING')
  })

  it.each([[undefined], [true], [false]])('trigger_create (wait=%s) arms the trigger and never parks Main', async (wait) => {
    const op = getOp('trigger_create')!
    const body = {
      run: 'bash ~/.open-walnut/triggers/pr-1/check.sh', every: '5m',
      prompt: 'Read the review on PR 1.', description: 'Checks PR 1 for a review every 5 minutes.',
      ...(wait === undefined ? {} : { wait }),
    }
    const res = await asMain(mainSid)(op.bind!.method, op.bind!.path, body)
    expect(res.wait).toMatchObject({ parked: false, task_id: main.id, reason: 'main_stays_active' })
    const out = op.mapResult!({ body: res, args: body }) as any
    expect(out.outcome).toContain('the main agent\'s, which never parks')
    expect(out.outcome).not.toContain('park it with task_update phase=WAITING')
    expect((await task(main.id)).phase).toBe('IN_PROGRESS')
  })
})
