/**
 * The session header's phase write with no shared store
 * (web/src/components/sessions/task-phase-write.ts, used by TaskQuickActions.tsx;
 * docs/plan/walnut-replica-servers-impl.md section 3, "Op ids"; WP2): one op id
 * across every attempt, a flat 2 s apart (about 10 s, as before op ids), a
 * newer pick drops an older one's retries, and an answer that may have been
 * kept is not retried and is shown.
 *
 * The real web client (request() and updateTask) over a stubbed fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OP_ID_HEADER } from '../../web/src/api/op-id'
import { createPhaseWriter, PHASE_WRITE_DELAY_MS, PHASE_WRITE_RETRIES } from '../../web/src/components/sessions/task-phase-write'

type Answer = { status: number; body: unknown }

const SENT = { error: { code: 'primary_timeout', sent: true, message: 'Your Mac did not answer in time, and it may have kept the change; check it before you try again.' } }
const TASK = (phase: string) => ({ task: { id: 't1', title: 'Acme', status: 'todo', phase, project: '', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' } })

let calls: Array<{ opId: string | undefined; phase: string }>
let answers: Answer[]

function hooks() {
  const h = { done: 0, resync: 0, errors: [] as string[] }
  return { h, hooks: { done: () => { h.done++ }, resync: () => { h.resync++ }, showError: (m: string) => { h.errors.push(m) } } }
}

beforeEach(() => {
  calls = []
  answers = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const phase = (JSON.parse(String(init.body)) as { phase: string }).phase
    calls.push({ opId: (init.headers as Record<string, string>)[OP_ID_HEADER], phase })
    const a = answers.shift() ?? { status: 200, body: TASK(phase) }
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('the session header phase write', () => {
  it('a 504 sent:true is one attempt, shown with the replica message, and the header resyncs', async () => {
    answers.push({ status: 504, body: SENT })
    const { h, hooks: k } = hooks()
    await createPhaseWriter(undefined, 1)('t1', 'COMPLETE', k)
    expect(calls).toHaveLength(1)
    expect(h).toEqual({ done: 0, resync: 1, errors: [SENT.error.message] })
  })

  it('a 502 then a 200: two attempts under one op id, done once, no error shown', async () => {
    answers.push({ status: 502, body: {} })
    const { h, hooks: k } = hooks()
    await createPhaseWriter(undefined, 1)('t1', 'IN_PROGRESS', k)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.opId).toMatch(/^op-[0-9a-f]{16}$/)
    expect(calls[1]!.opId).toBe(calls[0]!.opId)
    expect(h).toEqual({ done: 1, resync: 0, errors: [] })
  })

  it('the retries are a flat 2 s apart, about 10 s in all before the header resyncs', async () => {
    expect(PHASE_WRITE_RETRIES * PHASE_WRITE_DELAY_MS).toBeLessThanOrEqual(10_000)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    for (let i = 0; i < 6; i++) answers.push({ status: 502, body: {} })
    const { h, hooks: k } = hooks()
    const done = createPhaseWriter()('t1', 'IN_PROGRESS', k)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    // A growing wait (2 s, 4 s, ...) would still be at two attempts after 4 s.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(6_000)
    await done
    expect(calls).toHaveLength(6)
    expect(new Set(calls.map((c) => c.opId)).size).toBe(1)
    expect(h).toEqual({ done: 0, resync: 1, errors: [] })
  })

  it('a newer pick for the task drops the older pick\'s pending retries: the older phase never lands after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    answers.push({ status: 502, body: {} })
    const write = createPhaseWriter()
    const a = hooks()
    const b = hooks()
    const first = write('t1', 'WAITING', a.hooks)
    await vi.advanceTimersByTimeAsync(0)
    const second = write('t1', 'IN_PROGRESS', b.hooks)
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([first, second])
    expect(calls.map((c) => c.phase)).toEqual(['WAITING', 'IN_PROGRESS'])
    expect(calls[0]!.opId).not.toBe(calls[1]!.opId)
    // The newer pick owns the header: the older one neither resyncs nor reports.
    expect(a.h).toEqual({ done: 0, resync: 0, errors: [] })
    expect(b.h).toEqual({ done: 1, resync: 0, errors: [] })
  })
})

describe('TaskQuickActions writes its phase through the phase writer', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '../../web/src/components/sessions/TaskQuickActions.tsx'), 'utf8')
  const handler = source.slice(source.indexOf('const handlePhaseChange'), source.indexOf('const handleSetWaitUntil'))

  it('handlePhaseChange calls writePhase, never updateTask or a timer of its own (a new op id per attempt)', () => {
    expect(handler).toContain('writePhase(id, phase')
    expect(source).toContain('createPhaseWriter()')
    expect(handler).not.toMatch(/updateTask\(/)
    expect(handler).not.toMatch(/setTimeout\(/)
    // The "may have been kept" message reaches the store's banner when there is one.
    expect(handler).toMatch(/showError: \(message\) => store\?\.showOperationError\(message\)/)
  })
})
