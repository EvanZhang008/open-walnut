/**
 * Who hears about a trigger whose check is in trouble, through the real server
 * (2026-10-09: a check failed five times in a row over one over-long item id, the
 * trigger was stopped, and nobody noticed for 20 hours).
 *
 * The daemon's reports are handed to the real sink (what the socket handler does);
 * the session notices are asserted where they land, the mock daemon's writes and
 * spawns for the target task's session; the bells and the letter in their stores.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-health-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import { handleTriggerChecked, handleTriggerFired } from '../../src/core/routines/trigger-events.js'
import { listNotifications } from '../../src/core/notifications/store.js'
import { listLetters } from '../../src/core/human-inbox/store.js'
import { MAX_CONSECUTIVE_CHECK_ERRORS, type TriggerCheckedEvent } from '../../src/providers/trigger-check-core.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const MIN = 60_000

let server: HttpServer
let port: number
let daemon: MockDaemon

const fakeDaemon: TriggerDaemon = {
  host: '__local__',
  hasCapability: (cap) => cap === 'triggers-v1',
  triggersPushed: true,
  async send() { return { ok: true } },
}

async function req(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function jobState(id: string) {
  return (await req('GET', `/api/routines/${id}`)).json.job
}

/** Every text that reached a session's CLI, by a stdin write or on a spawn. */
function textsToSessions(): Array<{ sid: string; text: string }> {
  const written = daemon.getFifoWrites().map((w) => ({ sid: w.sid, text: w.message }))
  const spawned = daemon.getCommandHistoryFor('start')
    .filter((c) => c.payload.deferMessage !== true)
    .map((c) => ({ sid: String(c.payload.sid ?? ''), text: String(c.payload.message ?? '') }))
  return [...written, ...spawned]
}

/** The trigger notices one trigger sent, by outcome. One delivery can show as a write AND a spawn: count texts once. */
function notices(triggerId: string, outcome: string): string[] {
  const texts = textsToSessions()
    .map((c) => c.text)
    .filter((t) => t.includes('<walnut-message kind="notification"') && t.includes(`outcome="${outcome}"`) && t.includes(`(${triggerId})`))
  return [...new Set(texts)]
}

async function waitFor<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await read()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    v = await read()
  }
  return v
}

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms))

async function bells(prefix: string) {
  return (await listNotifications()).feed.filter((n) => n.dedupKey.startsWith(prefix))
}

async function lettersAbout(name: string) {
  return (await listLetters()).letters.filter((l) => l.subject.includes(`"${name}"`))
}

function checked(id: string, atMs: number, outcome: TriggerCheckedEvent['outcome'], extra: Partial<TriggerCheckedEvent> = {}) {
  return handleTriggerChecked('__local__', {
    type: 'trigger.checked', id, atMs, outcome, durationMs: 7, nextRunAtMs: atMs + 5 * MIN, consecutiveErrors: 0,
    ...(outcome === 'error' ? { error: 'exit 1: items[3].id is too long' } : {}),
    ...extra,
  })
}

async function newTask(title: string): Promise<string> {
  const r = await req('POST', '/api/tasks', { title, project: 'Trigger health e2e' })
  expect(r.status).toBe(201)
  return r.json.id ?? r.json.task?.id
}

async function newSession(taskId: string, sid: string, status: 'stopped' | 'idle'): Promise<void> {
  const { createSessionRecord } = await import('../../src/core/session-tracker.js')
  await createSessionRecord(sid, taskId, 'Trigger health e2e', '/tmp', {
    host: '__local__', title: 'Watch the pipeline', initialProcessStatus: status, initialStatusReason: 'expected_teardown',
  })
}

async function newTrigger(name: string, taskId: string): Promise<string> {
  const r = await req('POST', '/api/routines', {
    name,
    schedule: { kind: 'every', everyMs: 5 * MIN },
    check: { run: `bash ~/.open-walnut/triggers/${name.replace(/\W+/g, '-')}/check.sh` },
    executor: { type: 'session', config: { target: taskId, prompt: 'Check the pipeline.' } },
  })
  expect(r.status).toBe(201)
  return r.json.job.id
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  setTriggerDaemonLookupForTest(() => fakeDaemon)
}, 60_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a check that keeps failing', () => {
  let taskId = ''
  let id = ''
  const t0 = Date.now()

  beforeAll(async () => {
    taskId = await newTask('pipeline watch target')
    await newSession(taskId, 'th-session-main', 'stopped')
    id = await newTrigger('pipeline watch', taskId)
  })

  it('the first failure tells the session: the error, the trigger id, the run time, and how to try a fix', async () => {
    await checked(id, t0, 'error')
    const [notice] = await waitFor(() => notices(id, 'check_failed'), (n) => n.length > 0)
    expect(notice).toBeTruthy()
    expect(notice).toContain('from="Trigger: pipeline watch"')
    expect(notice).toContain(`Your trigger "pipeline watch" (${id}) check failed on this machine at ${new Date(t0).toISOString()} after 7 ms.`)
    expect(notice).toContain('items[3].id is too long')
    expect(notice).toContain(`After ${MAX_CONSECUTIVE_CHECK_ERRORS} failures in a row Walnut stops the trigger.`)
    expect(notice).toContain(`walnut tools call trigger_test '{"run":"bash ~/.open-walnut/triggers/pipeline-watch/check.sh","id":"${id}"}'`)
    // It went to THAT task's session (resumed cold: it was stopped).
    expect(textsToSessions().find((c) => c.text === notice)?.sid).toBe('th-session-main')
    // The user is not bothered by one failure.
    expect(await bells(`trigger-failing:${id}`)).toHaveLength(0)
  })

  it('the second failure tells no one; the third puts one bell in front of the user', async () => {
    await checked(id, t0 + 5 * MIN, 'error')
    await settle()
    expect(notices(id, 'check_failed')).toHaveLength(1)
    expect(await bells(`trigger-failing:${id}`)).toHaveLength(0)

    await checked(id, t0 + 10 * MIN, 'error')
    const [bell] = await bells(`trigger-failing:${id}`)
    expect(bell.title).toBe('Trigger "pipeline watch" keeps failing')
    expect(bell.severity).toBe('warning')
    expect(bell.taskId).toBe(taskId)
    expect(bell.body).toContain(`3 checks in a row failed on this machine since ${new Date(t0).toISOString()}`)
    expect(bell.body).toContain('items[3].id is too long')

    // The fourth refreshes nothing: one bell per run of failures.
    await checked(id, t0 + 15 * MIN, 'error')
    const again = await bells(`trigger-failing:${id}`)
    expect(again).toHaveLength(1)
    expect(again[0].count ?? 1).toBe(1)
    expect(notices(id, 'check_failed')).toHaveLength(1)
  })

  it('the fifth stops it: the session is told, the user gets a letter, the failing bell goes', async () => {
    await checked(id, t0 + 20 * MIN, 'error')
    const job = await jobState(id)
    expect(job.enabled).toBe(false)

    const [stop] = await waitFor(() => notices(id, 'trigger_disabled'), (n) => n.length > 0)
    expect(stop).toContain(`Walnut stopped your trigger "pipeline watch" (${id})`)
    expect(stop).toContain(`failed ${MAX_CONSECUTIVE_CHECK_ERRORS} times in a row, from ${new Date(t0).toISOString()} to ${new Date(t0 + 20 * MIN).toISOString()}`)
    expect(stop).toContain(`walnut tools call trigger_resume '{"id":"${id}"}'`)

    const [letter] = await lettersAbout('pipeline watch')
    expect(letter.subject).toBe(`Trigger "pipeline watch" stopped after ${MAX_CONSECUTIVE_CHECK_ERRORS} failed checks`)
    expect(letter.type).toBe('review')
    expect(letter.taskRefs).toEqual([taskId])
    expect(letter.read).toBe(false)
    // The letter makes its own bell; the failing one is out of date and gone.
    expect(await bells(`letter:${letter.id}`)).toHaveLength(1)
    expect(await bells(`trigger-failing:${id}`)).toHaveLength(0)
    expect(await bells(`trigger-disabled:${id}`)).toHaveLength(0)
  })

  it('a second stop after a resume is news again: a second letter', async () => {
    const r = await req('PATCH', `/api/routines/${id}`, { enabled: true })
    expect(r.status).toBe(200)
    const t1 = t0 + 2 * 60 * MIN
    // A resume starts the count over: one failure does not stop it, and it is
    // reported again (inside the 6h limit: the resume starts that over too).
    await checked(id, t1, 'error')
    expect((await jobState(id)).enabled).toBe(true)
    expect((await jobState(id)).state.consecutiveErrors).toBe(1)
    await waitFor(() => notices(id, 'check_failed'), (n) => n.length >= 2)
    expect(notices(id, 'check_failed')).toHaveLength(2)
    for (let i = 1; i < MAX_CONSECUTIVE_CHECK_ERRORS; i++) await checked(id, t1 + i * 5 * MIN, 'error')
    expect((await jobState(id)).enabled).toBe(false)
    expect(await lettersAbout('pipeline watch')).toHaveLength(2)
    await waitFor(() => notices(id, 'trigger_disabled'), (n) => n.length >= 2)
    expect(notices(id, 'trigger_disabled')).toHaveLength(2)
  })
})

describe('when the user hears, and when the bell goes', () => {
  it('two failures 30 minutes apart are enough; a passing check takes the bell back', async () => {
    const taskId = await newTask('slow watch target')
    const id = await newTrigger('slow watch', taskId)
    const t0 = Date.now()
    await checked(id, t0, 'error')
    await checked(id, t0 + 29 * MIN, 'error')
    expect(await bells(`trigger-failing:${id}`)).toHaveLength(0)
    await checked(id, t0 + 31 * MIN, 'error')
    expect(await bells(`trigger-failing:${id}`)).toHaveLength(1)

    await checked(id, t0 + 36 * MIN, 'quiet', { reason: 'all-seen' })
    expect(await bells(`trigger-failing:${id}`)).toHaveLength(0)
    expect((await jobState(id)).state.consecutiveErrors).toBe(0)
  })

  it('a fire after failures also takes the bell back: it was a check that worked', async () => {
    const taskId = await newTask('busy watch target')
    await newSession(taskId, 'th-session-busy', 'stopped')
    const id = await newTrigger('busy watch', taskId)
    const t0 = Date.now()
    for (let i = 0; i < 3; i++) await checked(id, t0 + i * 5 * MIN, 'error')
    expect(await bells(`trigger-failing:${id}`)).toHaveLength(1)
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id, epoch: 'busy-epoch', seq: 1, atMs: Date.now(),
      items: [{ id: 'msg-1' }], durationMs: 3, nextRunAtMs: Date.now() + 5 * MIN,
    })
    expect(await bells(`trigger-failing:${id}`)).toHaveLength(0)
    expect((await jobState(id)).state.consecutiveErrors).toBe(0)
  })

  it('a source that fails now and then wakes its session at most once in 6 hours', async () => {
    const taskId = await newTask('flaky watch target')
    await newSession(taskId, 'th-session-flaky', 'stopped')
    const id = await newTrigger('flaky watch', taskId)
    const t0 = Date.now()
    await checked(id, t0, 'error')
    await waitFor(() => notices(id, 'check_failed'), (n) => n.length > 0)
    await checked(id, t0 + 5 * MIN, 'quiet', { reason: 'fire-false' })
    await checked(id, t0 + 60 * MIN, 'error', { error: 'exit 7: network down' })
    await settle()
    expect(notices(id, 'check_failed')).toHaveLength(1)
    await checked(id, t0 + 65 * MIN, 'quiet', { reason: 'fire-false' })
    await checked(id, t0 + 7 * 60 * MIN, 'error', { error: 'exit 7: network down again' })
    const after = await waitFor(() => notices(id, 'check_failed'), (n) => n.length >= 2)
    expect(after).toHaveLength(2)
    expect(after.some((t) => t.includes('network down again'))).toBe(true)
  })

  it('a completed task hears nothing, and the stop letter says no session could be told', async () => {
    const taskId = await newTask('closed watch target')
    await newSession(taskId, 'th-session-closed', 'stopped')
    const id = await newTrigger('closed watch', taskId)
    const done = await req('POST', `/api/tasks/${taskId}/complete`, {})
    expect(done.status).toBeLessThan(300)
    const t0 = Date.now()
    for (let i = 0; i < MAX_CONSECUTIVE_CHECK_ERRORS; i++) await checked(id, t0 + i * 5 * MIN, 'error')
    await settle()
    expect(notices(id, 'check_failed')).toHaveLength(0)
    expect(notices(id, 'trigger_disabled')).toHaveLength(0)
    const [letter] = await lettersAbout('closed watch')
    expect(letter).toBeTruthy()
    const { getLetter } = await import('../../src/core/human-inbox/store.js')
    const full = await getLetter(letter.id, { inlineMaxBytes: Infinity })
    expect(JSON.stringify(full)).toContain('no session that could be told')
  })
})

describe('output the daemon repaired', () => {
  const slip = 'items[0].id was 490 chars (over 200); the daemon shortened it to a stable id and kept the original in "fullId"'

  it('a quiet check that needed repairs is not an error, lands on the History row, and tells a live session once a day', async () => {
    const taskId = await newTask('repaired watch target')
    await newSession(taskId, 'th-session-live', 'idle')
    const id = await newTrigger('repaired watch', taskId)
    const t0 = Date.now()
    const warnings = [slip]
    await checked(id, t0, 'quiet', { reason: 'all-seen', warnings })
    const job = await jobState(id)
    expect(job.state.consecutiveErrors ?? 0).toBe(0)
    expect(job.state.checkLog[0]).toMatchObject({ outcome: 'quiet', warnings })
    const [notice] = await waitFor(() => notices(id, 'check_repaired'), (n) => n.length > 0)
    expect(notice).toContain('broke the output contract, and the daemon repaired it')
    expect(notice).toContain('items[0].id was 490 chars')

    await checked(id, t0 + 5 * MIN, 'quiet', { reason: 'all-seen', warnings })
    await settle()
    expect(notices(id, 'check_repaired')).toHaveLength(1)
    // The mock CLI ends after its turn; a day later the session is live again.
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    await waitFor(async () => {
      const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
      return (await getSessionByClaudeId('th-session-live'))?.process_status
    }, (st) => st !== 'running')
    await updateSessionRecord('th-session-live', { process_status: 'idle' })
    await checked(id, t0 + 25 * 60 * MIN, 'quiet', { reason: 'all-seen', warnings })
    await waitFor(() => notices(id, 'check_repaired'), (n) => n.length >= 2)
    expect(notices(id, 'check_repaired')).toHaveLength(2)
  })

  it('a stopped session is never woken for repairs', async () => {
    const taskId = await newTask('repaired stopped target')
    await newSession(taskId, 'th-session-stopped-repair', 'stopped')
    const id = await newTrigger('repaired stopped', taskId)
    await checked(id, Date.now(), 'quiet', { reason: 'all-seen', warnings: ['1 item dropped, the first because items[2] must be an object with a string "id"'] })
    await settle()
    expect(notices(id, 'check_repaired')).toHaveLength(0)
  })

  it('a fire carries its repairs in the envelope and on the History row', async () => {
    const taskId = await newTask('repaired fire target')
    await newSession(taskId, 'th-session-fire', 'stopped')
    const id = await newTrigger('repaired fire', taskId)
    const warnings = ['items[0].id was 490 chars (over 200); the daemon shortened it to a stable id and kept the original in "fullId"']
    await handleTriggerFired('__local__', {
      type: 'trigger.fired', id, epoch: 'th-epoch', seq: 1, atMs: Date.now(),
      items: [{ id: 'acme/approval~0123456789abcdef', fullId: 'acme/approval/'.repeat(35) }],
      durationMs: 3, nextRunAtMs: Date.now() + 5 * MIN, warnings,
    })
    const envelope = await waitFor(
      () => textsToSessions().map((c) => c.text).find((t) => t.includes('<walnut-message kind="trigger"') && t.includes('Trigger: repaired fire')),
      (t) => !!t,
    )
    expect(envelope).toContain('The check script broke the output contract, and the daemon repaired it (fix the script):')
    expect(envelope).toContain('acme/approval~0123456789abcdef')
    const job = await jobState(id)
    expect(job.state.fireLog[0]).toMatchObject({ outcome: 'fired', warnings })
    expect(job.state.warningNoticeAtMs).toBeGreaterThan(0)
  })
})
