/**
 * Structured replies and the in-use check on completing another task, through the real server.
 *
 *  - `POST /api/v1/messages` with `in_reply_to` may carry `result` / `evidence` / `not_done`
 *    (src/core/peers/structured-reply.ts): the request row keeps them (settleReplied), the
 *    replier's task keeps its latest result (Task.result_report, via 'reply'), and the asker
 *    reads them as plain sections of the delivered text (composeReplyText). The fields without
 *    `in_reply_to` are refused; a plain reply leaves no result_report.
 *  - A late reply to an EXPIRED request settles it (settleLateReply, `lateFrom: 'expired'`).
 *  - `POST /api/v1/tasks/:id/complete` with `result` / `not_done` keeps a result_report via
 *    'complete'; `POST /api/v1/tasks/:id/not-done` settles it; nothing to settle is 409.
 *  - A SESSION completing ANOTHER task that is still in use or unfinished (a Partial nobody
 *    settled, someone else's unanswered request) is refused with 409 `task_in_use`, through POST
 *    /complete and a PATCH to COMPLETE alike, unless it passes `force` and a reason of 10+
 *    characters (src/core/sessions/complete-in-use.ts); open subtasks never block it, and a
 *    person is never refused. A plain reply to another request keeps a standing Partial.
 *  - `POST /api/v1/tasks/:id/team-stop` stops a task and every open task under it (sessions,
 *    never the caller's own; wait clocks off in the stored row; asks between members withdrawn),
 *    and `team-resume` puts the clocks and asks back (src/core/sessions/team-stop.ts).
 *
 * Harness as in task-wait-resume.test.ts: mock daemon + mock CLI, everything else real. Request
 * rows are made with createSessionRequest (the row a real ask writes), so no turn of the target
 * runs and no turn-end edge settles the row before the reply under test.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-structured-reply-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { createSessionRequest, getSessionRequest, settleNotified } from '../../src/core/session-requests.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

const url = (p: string) => `http://localhost:${port}${p}`

async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url(p), {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const asSession = (sid: string) => ({ 'x-walnut-caller-sid': sid })

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

async function sessionStatus(sid: string): Promise<string> {
  const r = await req('GET', `/api/sessions/${sid}`)
  return r.json?.session?.process_status ?? r.json?.process_status ?? ''
}

interface Worker { sid: string; taskId: string }

async function startWorker(message: string): Promise<Worker> {
  const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message })
  expect(started.status, JSON.stringify(started.json)).toBe(200)
  const w = { sid: started.json.sessionId, taskId: started.json.taskId }
  await until('first hand-back', () => task(w.taskId), (t) => t.phase === 'NEED_ACTION')
  await until('session idle', () => sessionStatus(w.sid), (s) => s !== 'running')
  return w
}

/** Every text the daemon was asked to write into a session (send or a resume's start). */
const sentTexts = () => [...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
  .map((c) => String(c.payload.text ?? c.payload.message ?? ''))

async function createTask(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await req('POST', '/api/tasks', { title, project: 'Acme', ...extra })
  expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
  return String(r.json.task.id)
}

/** A request from the asker to the lead, the row a real `task_send expect_reply` writes. */
const ask = (asker: Worker, target: Worker, text: string) => createSessionRequest({
  fromSessionId: asker.sid, fromTaskId: asker.taskId, toSessionId: target.sid, toTaskId: target.taskId, text,
})

let asker: Worker
let lead: Worker

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  asker = await startWorker('lead the release')
  lead = await startWorker('check the release build')
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a structured reply on task_send', () => {
  it('settles the request with its fields, records a Partial result on the replier, and the asker reads every section', async () => {
    const rq = await ask(asker, lead, 'is the release build green?')
    daemon.clearCommandHistory()
    const r = await req('POST', '/api/v1/messages', {
      in_reply_to: rq.id,
      text: 'Mostly green.',
      result: 'The macOS build passes all 412 tests.',
      evidence: ['/tmp/acme/build.log', 'https://example.com/ci/run/77'],
      not_done: '- iOS build not run\n- docs not checked',
    }, asSession(lead.sid))
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json).toMatchObject({ repliedTo: rq.id, targetSessionId: asker.sid })

    const row = await getSessionRequest(rq.id)
    expect(row).toMatchObject({
      status: 'replied',
      reply: {
        result: 'The macOS build passes all 412 tests.',
        evidence: ['/tmp/acme/build.log', 'https://example.com/ci/run/77'],
        not_done: ['iOS build not run', 'docs not checked'],
      },
    })
    expect(row?.lateFrom).toBeUndefined()
    // The status read an agent's `walnut wait rq-…` uses carries the same fields.
    const read = await req('GET', `/api/v1/requests/${rq.id}`)
    expect(read.json.request.reply.not_done).toEqual(['iOS build not run', 'docs not checked'])

    const t = await task(lead.taskId)
    expect(t.result_report).toMatchObject({
      via: 'reply',
      request_id: rq.id,
      to_task_id: asker.taskId,
      by: `task:${lead.taskId}`,
      result: 'The macOS build passes all 412 tests.',
      not_done: ['iOS build not run', 'docs not checked'],
    })
    expect(t.result_report.settled).toBeUndefined()
    expect(Number.isFinite(Date.parse(t.result_report.at))).toBe(true)

    const delivered = await until('reply delivered to the asker', async () => sentTexts().filter((s) => s.includes('Mostly green.')), (a) => a.length > 0)
    const text = delivered[0]
    expect(text).toContain('Result: The macOS build passes all 412 tests.')
    expect(text).toContain('Evidence:\n- /tmp/acme/build.log\n- https://example.com/ci/run/77')
    expect(text).toContain('Not done (partial reply):\n- iOS build not run\n- docs not checked')
    await until('asker idle', () => sessionStatus(asker.sid), (s) => s !== 'running', 30_000)
  }, 60_000)

  it('a reply with only a result (no text) is delivered as its Result section', async () => {
    const rq = await ask(asker, lead, 'did the smoke test pass?')
    daemon.clearCommandHistory()
    const r = await req('POST', '/api/v1/messages', { in_reply_to: rq.id, result: 'Smoke test passed on run 78.' }, asSession(lead.sid))
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(await getSessionRequest(rq.id)).toMatchObject({ status: 'replied', reply: { result: 'Smoke test passed on run 78.' } })
    // A full answer after a partial one clears the Partial mark: the newest result wins.
    const t = await task(lead.taskId)
    expect(t.result_report).toMatchObject({ via: 'reply', request_id: rq.id, result: 'Smoke test passed on run 78.' })
    expect(t.result_report.not_done).toBeUndefined()
    const delivered = await until('result-only reply delivered', async () => sentTexts().filter((s) => s.includes('Smoke test passed on run 78.')), (a) => a.length > 0)
    expect(delivered[0]).toContain('Result: Smoke test passed on run 78.')
    expect(delivered[0]).not.toContain('Not done (partial reply):')
    await until('asker idle', () => sessionStatus(asker.sid), (s) => s !== 'running', 30_000)
  }, 60_000)

  it('the fields without in_reply_to are refused with 400, and nothing is sent', async () => {
    daemon.clearCommandHistory()
    const r = await req('POST', '/api/v1/messages', {
      to: asker.taskId, text: 'FYI the build is green', not_done: ['iOS'],
    }, asSession(lead.sid))
    expect(r.status, JSON.stringify(r.json)).toBe(400)
    expect(JSON.stringify(r.json)).toContain('in_reply_to')
    await new Promise((res) => setTimeout(res, 300))
    expect(sentTexts().some((s) => s.includes('FYI the build is green'))).toBe(false)
  })

  it('a plain text reply still works and records no result fields (nothing reads as Partial)', async () => {
    const other = await startWorker('review the changelog')
    const rq = await ask(asker, other, 'is the changelog ready?')
    daemon.clearCommandHistory()
    const r = await req('POST', '/api/v1/messages', { in_reply_to: rq.id, text: 'yes, the changelog is ready' }, asSession(other.sid))
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    const row = await getSessionRequest(rq.id)
    expect(row?.status).toBe('replied')
    expect(row?.reply).toBeUndefined()
    const t = await task(other.taskId)
    // A plain reply carries no result, so it writes none (session-send-core.ts noteResultReport):
    // it only ends a Partial of the same request, and never erases a result written before.
    expect(t.result_report).toBeUndefined()
    const delivered = await until('plain reply delivered', async () => sentTexts().filter((s) => s.includes('yes, the changelog is ready')), (a) => a.length > 0)
    expect(delivered[0]).not.toContain('Not done (partial reply):')
    await until('asker idle', () => sessionStatus(asker.sid), (s) => s !== 'running', 30_000)
  }, 90_000)
})

describe('a late reply to an overdue request', () => {
  it('flips an expired request to replied with lateFrom expired, keeping the fields', async () => {
    const rq = await ask(asker, lead, 'is the rollout done?')
    const expired = await settleNotified(rq.id, 'timeout')
    expect(expired?.status).toBe('expired')
    daemon.clearCommandHistory()
    const r = await req('POST', '/api/v1/messages', {
      in_reply_to: rq.id, text: 'Sorry, late: the rollout is done.', not_done: ['region two not verified'],
    }, asSession(lead.sid))
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    const row = await getSessionRequest(rq.id)
    expect(row).toMatchObject({ status: 'replied', lateFrom: 'expired', reply: { not_done: ['region two not verified'] } })
    expect(Date.parse(row!.settledAt!)).toBeGreaterThanOrEqual(Date.parse(expired!.settledAt!))
    await until('late reply delivered', async () => sentTexts().filter((s) => s.includes('the rollout is done')), (a) => a.length > 0)
    await until('asker idle', () => sessionStatus(asker.sid), (s) => s !== 'running', 30_000)
  }, 60_000)

  it('a second reply to a request already replied leaves the row as it was', async () => {
    const rq = await ask(asker, lead, 'second ask about the rollout')
    await settleNotified(rq.id, 'timeout')
    expect((await req('POST', '/api/v1/messages', { in_reply_to: rq.id, text: 'first late answer', result: 'first' }, asSession(lead.sid))).status).toBe(202)
    const first = await getSessionRequest(rq.id)
    expect((await req('POST', '/api/v1/messages', { in_reply_to: rq.id, text: 'second late answer', result: 'second' }, asSession(lead.sid))).status).toBe(202)
    const second = await getSessionRequest(rq.id)
    expect(second).toEqual(first)
    expect(second?.reply?.result).toBe('first')
    await until('asker idle', () => sessionStatus(asker.sid), (s) => s !== 'running', 30_000)
  }, 60_000)
})

describe('a completion with a result', () => {
  it('stores result_report via complete, the response carries it, and not-done settles it', async () => {
    const id = await createTask('Ship the release notes')
    const done = await req('POST', `/api/v1/tasks/${id}/complete`, {
      result: 'Release notes published.', evidence: 'https://example.com/notes\n- /tmp/acme/notes.md', not_done: ['translations pending'],
    })
    expect(done.status, JSON.stringify(done.json)).toBe(200)
    expect(done.json.task.phase).toBe('COMPLETE')
    expect(done.json.task.result_report).toMatchObject({
      via: 'complete', by: 'human', result: 'Release notes published.',
      evidence: ['https://example.com/notes', '/tmp/acme/notes.md'], not_done: ['translations pending'],
    })
    expect((await task(id)).result_report).toMatchObject({ via: 'complete', not_done: ['translations pending'] })

    const settle = await req('POST', `/api/v1/tasks/${id}/not-done`, { how: 'taken', note: 'filed as its own task' })
    expect(settle.status, JSON.stringify(settle.json)).toBe(200)
    const stored = (await task(id)).result_report
    expect(stored.settled).toMatchObject({ how: 'taken', by: 'human', note: 'filed as its own task' })
    // The items themselves are kept; only the Partial mark is gone.
    expect(stored.not_done).toEqual(['translations pending'])
    // The route's contract: `{ task }` is the settled task (task-v1.ts, POST /tasks/:id/not-done).
    expect(settle.json.task.id).toBe(id)
    expect(settle.json.task.result_report?.settled).toMatchObject({ how: 'taken', by: 'human' })
  })

  it('a settle with a bad how is 400; a task with nothing to settle answers 409 not_partial', async () => {
    const id = await createTask('Tidy the backlog')
    expect((await req('POST', `/api/v1/tasks/${id}/not-done`, { how: 'later' })).status).toBe(400)
    const none = await req('POST', `/api/v1/tasks/${id}/not-done`, { how: 'dropped' })
    expect(none.status, JSON.stringify(none.json)).toBe(409)
    expect(JSON.stringify(none.json)).toContain('not_partial')
    // A completion with a full result (no not_done) is not Partial either.
    expect((await req('POST', `/api/v1/tasks/${id}/complete`, { result: 'Backlog tidied.' })).json.task.result_report)
      .toMatchObject({ via: 'complete', result: 'Backlog tidied.' })
    const full = await req('POST', `/api/v1/tasks/${id}/not-done`, { how: 'dropped' })
    expect(full.status).toBe(409)
    expect(JSON.stringify(full.json)).toContain('not_partial')
  })

  it('a session completing its own task with a result is recorded as that task', async () => {
    const own = await startWorker('write the migration guide')
    const done = await req('POST', `/api/v1/tasks/${own.taskId}/complete`, { result: 'Guide written.', not_done: 'screenshots' }, asSession(own.sid))
    expect(done.status, JSON.stringify(done.json)).toBe(200)
    expect(done.json.task.result_report).toMatchObject({ via: 'complete', by: `task:${own.taskId}`, not_done: ['screenshots'] })
  }, 60_000)
})

describe('a session completing another task that is still in use', () => {
  it('open subtasks never block it: the completion goes through and lists them', async () => {
    const parent = await createTask('Coordinate the launch')
    await createTask('Launch: write the blog post', { parent_task_id: parent })
    const r = await req('POST', `/api/v1/tasks/${parent}/complete`, { result: 'done' }, asSession(lead.sid))
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json.task.phase).toBe('COMPLETE')
    expect(r.json.open_subtasks?.length).toBe(1)
  })

  it('a Partial nobody settled blocks POST /complete and a PATCH to COMPLETE alike; force needs a real reason', async () => {
    // A task whose last result was Partial, reopened: no session needed to make one.
    const partial = async (title: string) => {
      const id = await createTask(title)
      expect((await req('POST', `/api/v1/tasks/${id}/complete`, { result: 'Half of it.', not_done: 'German' })).status).toBe(200)
      const reopened = await req('PATCH', `/api/v1/tasks/${id}`, { phase: 'IN_PROGRESS' })
      expect(reopened.status, JSON.stringify(reopened.json)).toBe(200)
      expect((await task(id)).result_report?.not_done).toEqual(['German'])
      return id
    }
    const id = await partial('Translate the release notes')
    const post = await req('POST', `/api/v1/tasks/${id}/complete`, {}, asSession(lead.sid))
    expect(post.status, JSON.stringify(post.json)).toBe(409)
    expect(JSON.stringify(post.json)).toContain('unfinished_result')
    const patch = await req('PATCH', `/api/v1/tasks/${id}`, { phase: 'COMPLETE' }, asSession(lead.sid))
    expect(patch.status, JSON.stringify(patch.json)).toBe(409)
    expect(JSON.stringify(patch.json)).toContain('task_in_use')
    expect((await req('PATCH', `/api/v1/tasks/${id}`, { phase: 'COMPLETE', force: true, reason: 'too short' }, asSession(lead.sid))).status).toBe(409)
    expect((await task(id)).phase).not.toBe('COMPLETE')
    const forced = await req('PATCH', `/api/v1/tasks/${id}`, {
      phase: 'COMPLETE', force: true, reason: 'the user dropped the German translation today',
    }, asSession(lead.sid))
    expect(forced.status, JSON.stringify(forced.json)).toBe(200)
    expect((await task(id)).phase).toBe('COMPLETE')
    // A closer that gives its own verdict on the result needs no force.
    const id2 = await partial('Translate the FAQ')
    const verdict = await req('POST', `/api/v1/tasks/${id2}/complete`, { result: 'German is not needed after all.' }, asSession(lead.sid))
    expect(verdict.status, JSON.stringify(verdict.json)).toBe(200)
    expect(verdict.json.task.result_report).toMatchObject({ via: 'complete', result: 'German is not needed after all.' })
    expect(verdict.json.task.result_report.not_done).toBeUndefined()
  })

  it('a person (no caller header) is never refused', async () => {
    const parent = await createTask('Plan the offsite')
    await createTask('Offsite: book the venue', { parent_task_id: parent })
    const r = await req('POST', `/api/v1/tasks/${parent}/complete`, {})
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json.task.phase).toBe('COMPLETE')
  })

  it('its unfinished work blocks it too: a Partial result nobody settled, and someone else still waiting on it', async () => {
    const worker = await startWorker('translate the release notes')
    // Its last result was Partial: another session may not close it as if it were whole...
    const rq = await ask(asker, worker, 'are the notes translated?')
    expect((await req('POST', '/api/v1/messages', { in_reply_to: rq.id, text: 'Half.', not_done: 'German' }, asSession(worker.sid))).status).toBe(202)
    await until('worker idle', () => sessionStatus(worker.sid), (s) => s !== 'running', 30_000)
    // A plain answer to ANOTHER request settles nothing: the Partial stands.
    const rq2 = await ask(asker, worker, 'which branch?')
    expect((await req('POST', '/api/v1/messages', { in_reply_to: rq2.id, text: 'main' }, asSession(worker.sid))).status).toBe(202)
    expect((await task(worker.taskId)).result_report?.not_done).toEqual(['German'])
    await until('worker idle again', () => sessionStatus(worker.sid), (s) => s !== 'running', 30_000)
    const blocked = await req('POST', `/api/v1/tasks/${worker.taskId}/complete`, {}, asSession(lead.sid))
    expect(blocked.status, JSON.stringify(blocked.json)).toBe(409)
    expect(JSON.stringify(blocked.json)).toContain('unfinished_result')
    // ...but a closer that gives its own verdict on the result may.
    const other = await startWorker('proofread the notes')
    const pending = await ask(asker, other, 'proofread done?')
    const waited = await req('POST', `/api/v1/tasks/${other.taskId}/complete`, { result: 'done' }, asSession(lead.sid))
    expect(waited.status, JSON.stringify(waited.json)).toBe(409)
    expect(JSON.stringify(waited.json)).toContain('unanswered_requests')
    expect(JSON.stringify(waited.json)).toContain(pending.id)
    // The asker itself may drop its own ask and close it.
    const own = await req('POST', `/api/v1/tasks/${other.taskId}/complete`, { result: 'not needed' }, asSession(asker.sid))
    expect(own.status, JSON.stringify(own.json)).toBe(200)
    const closed = await req('POST', `/api/v1/tasks/${worker.taskId}/complete`, { result: 'half', not_done: 'German' }, asSession(lead.sid))
    expect(closed.status, JSON.stringify(closed.json)).toBe(200)
  }, 120_000)

  it('a task not in use completes for a session caller with no force', async () => {
    const id = await createTask('Rename the CI job')
    const r = await req('POST', `/api/v1/tasks/${id}/complete`, {}, asSession(lead.sid))
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json.task.phase).toBe('COMPLETE')
  })
})

describe('one step stops a whole team', () => {
  it('stops every member\'s session, takes the stored wait clock off and withdraws asks between members; resume puts them back', async () => {
    const boss = await startWorker('lead the docs team')
    const w1 = await startWorker('write the guide')
    const w2 = await startWorker('review the guide')
    for (const w of [w1, w2]) expect((await req('PATCH', `/api/v1/tasks/${w.taskId}`, { parent_task_id: boss.taskId })).status).toBe(200)
    const until1 = new Date(Date.now() + 6 * 3_600_000).toISOString()
    expect((await req('PATCH', `/api/v1/tasks/${w2.taskId}`, { phase: 'WAITING', wait_until: until1 })).status).toBe(200)
    const rq = await ask(boss, w1, 'is the guide written?')

    const stop = await req('POST', `/api/v1/tasks/${boss.taskId}/team-stop`, {})
    expect(stop.status, JSON.stringify(stop.json)).toBe(200)
    expect(stop.json.tasks).toBe(3)
    // The mock CLI ends with each turn, so no session is live here to stop (the stop itself is
    // pinned in tests/core/team-stop.test.ts and on a real CLI); nothing is started by the stop.
    expect(stop.json.stopped).toEqual([])
    for (const w of [boss, w1, w2]) expect(await sessionStatus(w.sid)).not.toBe('running')
    // Read back from the store: the clock is really gone, not only in the answer.
    expect((await task(w2.taskId)).wait_until ?? null).toBeNull()
    expect((await getSessionRequest(rq.id))?.status).toBe('withdrawn')
    expect((await task(boss.taskId)).team_stop).toMatchObject({ by: 'human', when: 'now' })
    // The phone's slim row says so too.
    const slim = await req('GET', `/api/v1/tasks/${boss.taskId}`)
    expect(JSON.stringify(slim.json)).toContain('team_stop')

    const back = await req('POST', `/api/v1/tasks/${boss.taskId}/team-resume`, {})
    expect(back.status, JSON.stringify(back.json)).toBe(200)
    const w2After = await task(w2.taskId)
    if (w2After.phase === 'WAITING') expect(w2After.wait_until).toBe(until1)
    expect((await getSessionRequest(rq.id))?.status).toBe('pending')
    expect((await task(boss.taskId)).team_stop ?? null).toBeNull()
  }, 120_000)

  it('a session stopping its own team is recorded as that task, and the op answers what it did', async () => {
    const boss = await startWorker('lead the site team')
    const w = await startWorker('fix the site footer')
    expect((await req('PATCH', `/api/v1/tasks/${w.taskId}`, { parent_task_id: boss.taskId })).status).toBe(200)
    const stop = await req('POST', `/api/v1/tasks/${boss.taskId}/team-stop`, { when: 'turn_end' }, asSession(boss.sid))
    expect(stop.status, JSON.stringify(stop.json)).toBe(200)
    expect(stop.json).toMatchObject({ root: { id: boss.taskId }, tasks: 2, stopped: [], atTurnEnd: [] })
    expect((await task(boss.taskId)).team_stop).toMatchObject({ by: `task:${boss.taskId}`, when: 'turn_end' })
    expect((await req('POST', `/api/v1/tasks/${boss.taskId}/team-stop`, { when: 'later' })).status).toBe(400)
    expect((await req('POST', '/api/v1/tasks/no-such-task/team-stop', {})).status).toBe(404)
  }, 120_000)
})
