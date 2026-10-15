/**
 * A retried user write keeps its op id (docs/plan/walnut-replica-servers-impl.md,
 * section 3, "Op ids"; WP2): withWriteRetry (web/src/api/write-retry.ts) mints
 * one id per user action and every attempt sends it, so the Mac's ledger can
 * apply a write whose first attempt a host replica answered 504 once. A write
 * the replica says may have been kept (504 sent:true, 503 leader_unsure with
 * why lost_answer, or journal_unwritable) is not retried at all: it is surfaced,
 * as its message asks. A plain 503 leader_unsure (the forward failed before a
 * byte was sent, nothing journaled) is retried under the same id.
 *
 * The real web client (request() and the task API) over a stubbed fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiError } from '../../web/src/api/client'
import { OP_ID_HEADER } from '../../web/src/api/op-id'
import { withWriteRetry, writeRetryable } from '../../web/src/api/write-retry'
import * as tasksApi from '../../web/src/api/tasks'

type Answer = { status: number; body: unknown }

const PRIMARY_TIMEOUT_SENT = { error: { code: 'primary_timeout', sent: true, message: 'Your Mac did not answer in time, and it may have kept the change; check it before you try again.' } }
const PRIMARY_TIMEOUT_NOT_SENT = { error: { code: 'primary_timeout', sent: false, message: 'Your Mac did not answer in time. Nothing was saved; try again.' } }
const TASK = { task: { id: 't1', title: 'Acme', status: 'todo', phase: 'TODO', project: '', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' } }

let calls: Array<{ url: string; method: string; opId: string | undefined }>
let answers: Answer[]

beforeEach(() => {
  calls = []
  answers = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ url, method: String(init.method), opId: headers[OP_ID_HEADER] })
    const a = answers.shift() ?? { status: 200, body: TASK }
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('withWriteRetry keeps one op id across attempts', () => {
  it('a 504 that was never sent, then a 200: both attempts send the same op id', async () => {
    answers.push({ status: 504, body: PRIMARY_TIMEOUT_NOT_SENT })
    const task = await withWriteRetry((opId) => tasksApi.toggleCompleteTask('t1', { opId }), 2, 1)
    expect(task.id).toBe('t1')
    expect(calls.map((c) => c.url)).toEqual(['/api/tasks/t1/toggle-complete', '/api/tasks/t1/toggle-complete'])
    expect(calls[0]!.opId).toMatch(/^op-[0-9a-f]{16}$/)
    expect(calls[1]!.opId).toBe(calls[0]!.opId)
  })

  it('a 502 (a proxy that lost the answer) twice, then a 200: three attempts, one op id', async () => {
    answers.push({ status: 502, body: {} }, { status: 502, body: {} })
    await withWriteRetry((opId) => tasksApi.updateTask('t1', { title: 'Acme 2' }, { opId }), 2, 1)
    expect(calls).toHaveLength(3)
    expect(new Set(calls.map((c) => c.opId)).size).toBe(1)
  })

  it('a network failure retries under the same op id too', async () => {
    let first = true
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), opId: (init.headers as Record<string, string>)[OP_ID_HEADER] })
      if (first) { first = false; throw new TypeError('Failed to fetch') }
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    await withWriteRetry((opId) => tasksApi.reorderTasks('', ['t1', 't2'], { opId }), 2, 1)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.opId).toBe(calls[0]!.opId)
  })

  it('the client\'s own deadline (a TimeoutError, before any replica budget) is retried under the same op id by design: the Mac\'s ledger applies it once', async () => {
    let first = true
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), opId: (init.headers as Record<string, string>)[OP_ID_HEADER] })
      if (first) { first = false; throw new DOMException('The operation timed out.', 'TimeoutError') }
      return new Response(JSON.stringify(TASK), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    await withWriteRetry((opId) => tasksApi.updateTask('t1', { phase: 'COMPLETE' }, { opId }), 2, 1)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.opId).toBe(calls[0]!.opId)
  })

  it('a function delay gives the wait before each retry, and superseded drops the pending retries', async () => {
    answers.push({ status: 502, body: {} }, { status: 502, body: {} })
    const waits: number[] = []
    await withWriteRetry((opId) => tasksApi.updateTask('t1', { title: 'x' }, { opId }), 2, (i) => { waits.push(i); return 1 })
    expect(waits).toEqual([0, 1])
    calls.length = 0
    answers.push({ status: 502, body: {} })
    const err = await withWriteRetry((opId) => tasksApi.updateTask('t1', { title: 'x' }, { opId }), 2, 1, () => true).catch((e: unknown) => e)
    expect((err as Error).name).toBe('WriteSuperseded')
    expect(calls).toHaveLength(1)
  })

  it('two user actions get two ids', async () => {
    await withWriteRetry((opId) => tasksApi.deleteTask('t1', { opId }), 2, 1)
    await withWriteRetry((opId) => tasksApi.deleteTask('t1', { force: true, opId }), 2, 1)
    expect(calls.map((c) => c.url)).toEqual(['/api/tasks/t1', '/api/tasks/t1?force=true'])
    expect(calls[0]!.opId).not.toBe(calls[1]!.opId)
  })
})

describe('a write that may have been kept is surfaced, not retried', () => {
  it('a 504 sent:true is one attempt, and the error carries the replica\'s message', async () => {
    answers.push({ status: 504, body: PRIMARY_TIMEOUT_SENT })
    const err = await withWriteRetry((opId) => tasksApi.toggleCompleteTask('t1', { opId }), 2, 1).catch((e: unknown) => e)
    expect(calls).toHaveLength(1)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(504)
    expect((err as ApiError).message).toBe(PRIMARY_TIMEOUT_SENT.error.message)
  })

  it('a 503 leader_unsure after a lost answer or journal_unwritable is one attempt; a 503 needs_leader (never applied) is retried', async () => {
    for (const error of [{ code: 'leader_unsure', why: 'lost_answer' }, { code: 'journal_unwritable', why: 'no_answer' }]) {
      calls.length = 0
      answers.push({ status: 503, body: { error: { ...error, retryAfter: 5, message: 'check it' } } })
      await expect(withWriteRetry((opId) => tasksApi.updateTask('t1', { title: 'x' }, { opId }), 2, 1)).rejects.toBeInstanceOf(ApiError)
      expect(calls).toHaveLength(1)
    }
    calls.length = 0
    answers.push({ status: 503, body: { error: { code: 'needs_leader', why: 'mac-away', retryAfter: 5, message: 'later' } } })
    await withWriteRetry((opId) => tasksApi.updateTask('t1', { title: 'x' }, { opId }), 2, 1)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.opId).toBe(calls[0]!.opId)
  })

  it('a plain 503 leader_unsure (the forward failed before it was sent) is retried under the same op id', async () => {
    answers.push({ status: 503, body: { error: { code: 'leader_unsure', retryAfter: 5, message: 'try again in a few seconds' } } })
    await withWriteRetry((opId) => tasksApi.updateTask('t1', { phase: 'COMPLETE' }, { opId }), 2, 1)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.opId).toBe(calls[0]!.opId)
  })

  it('writeRetryable: 4xx no; 504 sent:true no; 504 sent:false, 500, 502, a plain 504 and a network error yes', () => {
    expect(writeRetryable(new ApiError(409, 'conflict'))).toBe(false)
    expect(writeRetryable(new ApiError(504, 'm', PRIMARY_TIMEOUT_SENT))).toBe(false)
    expect(writeRetryable(new ApiError(504, 'm', PRIMARY_TIMEOUT_NOT_SENT))).toBe(true)
    expect(writeRetryable(new ApiError(504, 'Gateway Timeout'))).toBe(true)
    expect(writeRetryable(new ApiError(500, 'boom', { error: 'boom' }))).toBe(true)
    expect(writeRetryable(new ApiError(502, 'Bad Gateway'))).toBe(true)
    expect(writeRetryable(new TypeError('Failed to fetch'))).toBe(true)
  })
})
