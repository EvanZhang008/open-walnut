/**
 * A look at a stale Brief asks its node for one refresh turn, on a real server
 * (src/core/sessions/brief-refresh.ts, POST /api/v1/org/nodes/:id/brief-refresh):
 *   - a current Brief asks nothing;
 *   - a line whose task moved since makes it stale: one note goes into the lead's session queue,
 *     recorded on the task first, and a second look inside 15 minutes asks nothing;
 *   - the node writes its Brief itself through PUT /api/v1/tasks/:id/brief (brief_write), whole or
 *     by edits, and every write is shaped against the live tasks (a finished line goes, a missing
 *     ask is added); a worker keeps none, an edit that does not match and an overlong letter are
 *     refused;
 *   - the phone's attention heartbeat on the lead's session is a look too;
 *   - a test run on a real Walnut never starts one.
 * Only the Claude CLI is mocked (no CLI runs: the note waits in the queue).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-brief-refresh'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, listTasks, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { getQueue } from '../../src/core/session-message-queue.js'
import { briefSnapshot } from '../../src/core/sessions/brief-fresh.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const LEAD_SID = '44444444-5555-4666-8777-888888888888'
let base = ''
let leadId = ''
let workerId = ''

async function until(what: string, ok: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 15_000
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what} (worker: ${JSON.stringify((await getTask(workerId)).user_status)})`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function refresh(id: string, headers: Record<string, string> = {}): Promise<{ sent: boolean; why?: string }> {
  const res = await fetch(`${base}/api/v1/org/nodes/${id}/brief-refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ by: 'web' }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ sent: boolean; why?: string }>
}

async function write(id: string, payload: unknown): Promise<Response> {
  return fetch(`${base}/api/v1/tasks/${id}/brief`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
}

const notes = async () => (await getQueue(LEAD_SID)).filter((m) => m.message.includes('Walnut: Brief refresh'))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  workerId = (await addTask({ title: 'Review the doc', project: 'Garden' })).task.id
  await updateTaskRaw(workerId, { phase: 'NEED_ACTION', status_report: { state: 'needs', ask: 'Review section 3', at: new Date().toISOString() } }, { emitEvent: true, source: 'status-report' })
  await until('the worker asks the user', async () => (await getTask(workerId)).user_status?.ask === 'Review section 3')
  leadId = (await ensureProjectLead('Garden')).id
  await createSessionRecord(LEAD_SID, leadId, 'Garden', WALNUT_HOME)
  // Its CLI went quiet after its last turn.
  await updateSessionRecord(LEAD_SID, { process_status: 'stopped' })
  const letter = `### Needs you\n- <task-ref id="${workerId}" label="Review"/>: review section 3.\n### Working\n- None\n### Waiting / snoozed\n- None`
  const owner = await getTask(leadId)
  await updateTaskRaw(leadId, { brief: { text: letter, at: new Date().toISOString(), ...briefSnapshot(letter, owner, await listTasks()) } }, { emitEvent: true, source: 'status-report' })
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a Brief refresh', () => {
  it('a current Brief asks nothing', async () => {
    expect(await refresh(leadId)).toEqual({ sent: false, why: 'fresh' })
    expect(await notes()).toHaveLength(0)
  })

  it('a test run on a real Walnut never starts one', async () => {
    process.env.WALNUT_TEST_RUN_MARK = '1'
    try {
      expect(await refresh(leadId, { 'x-walnut-test-run': 'probe' })).toEqual({ sent: false, why: 'test_run' })
    } finally {
      delete process.env.WALNUT_TEST_RUN_MARK
    }
  })

  it('a moved line makes it stale: one note, recorded first; a second look inside the gap asks nothing', async () => {
    await updateTaskRaw(workerId, { phase: 'WAITING', status_report: { state: 'waiting', waiting_kind: 'task', waiting_on: 'The reviewer', at: new Date().toISOString() } }, { emitEvent: true, source: 'status-report' })
    await until('the worker waits', async () => (await getTask(workerId)).user_status?.state === 'waiting')
    const r = await refresh(leadId)
    expect(r.sent || r.why === 'not_delivered').toBe(true)
    const rec = (await getTask(leadId)).brief_refresh
    expect(rec).toMatchObject({ by: 'web', moved: 1 })
    expect(await notes()).toHaveLength(1)
    expect((await notes())[0]!.message).toContain('"Review the doc"')
    expect(await refresh(leadId)).toEqual({ sent: false, why: 'recent' })
    expect(await notes()).toHaveLength(1)
    // The refresh turn writes it itself (brief_write = this route): no longer stale, not updating.
    const read = await (await fetch(`${base}/api/v1/tasks/${leadId}/brief`)).json() as { fresh: { stale: boolean; words: string }; sections: { waiting: string[] }; rules: string }
    expect(read.fresh).toMatchObject({ stale: true, words: '1 line moved since' })
    expect(read.sections.waiting.join('\n')).toContain('waits on The reviewer')
    expect(read.rules).toContain('brief_write')
    const old = `### Needs you\n- <task-ref id="${workerId}" label="Review"/>: review section 3.\n`
    const put = await write(leadId, { edits: [{ old, new: '### Needs you\n- None\n' }, { old: '### Waiting / snoozed\n- None', new: `### Waiting / snoozed\n- <task-ref id="${workerId}" label="Review"/>: waits on the reviewer.` }] })
    expect(put.status).toBe(200)
    const t = await getTask(leadId)
    expect(Date.parse(t.brief!.at)).toBeGreaterThan(Date.parse(t.brief_refresh!.at))
    expect(t.brief!.text).toContain('waits on the reviewer')
    expect(t.brief!.marks?.[workerId]).toBeTruthy()
    expect(await refresh(leadId)).toEqual({ sent: false, why: 'recent' })
  })

  it('every write is shaped live, and the bad ones are refused', async () => {
    // Its own words leave out the worker that asks now: Walnut adds it, and drops a done task's line.
    const done = (await addTask({ title: 'Old chore', project: 'Garden' })).task.id
    await updateTaskRaw(done, { phase: 'COMPLETE' }, { emitEvent: true, source: 'test' })
    await updateTaskRaw(workerId, { phase: 'NEED_ACTION', status_report: { state: 'needs', ask: 'Approve the layout', at: new Date().toISOString() } }, { emitEvent: true, source: 'status-report', leaveHeld: true })
    await until('the worker asks', async () => (await getTask(workerId)).user_status?.ask === 'Approve the layout')
    const letter = `### Needs you\n- None\n### Working\n- <task-ref id="${done}" label="Old chore"/>: sweeping.\n### Waiting / snoozed\n- None`
    const res = await write(leadId, { content: letter })
    expect(res.status).toBe(200)
    const text = (await getTask(leadId)).brief!.text
    expect(text).not.toContain(`id="${done}"`)
    expect(text).toMatch(new RegExp(`### Needs you\\n- <task-ref id="${workerId}"[^\\n]*Approve the layout`))
    expect((await write(leadId, { edits: [{ old: 'no such line', new: 'x' }] })).status).toBe(409)
    expect((await write(leadId, { content: 'x'.repeat(5000) })).status).toBe(413)
    expect(((await (await write(workerId, { content: letter })).json()) as { error: { code: string } }).error.code).toBe('not_org_node')
  })

  it("the phone's heartbeat on the lead's session is a look", async () => {
    // Past the gap: the last refresh was long ago.
    await updateTaskRaw(leadId, { brief_refresh: { at: new Date(Date.now() - 16 * 60_000).toISOString(), by: 'web', moved: 1 } }, { source: 'test' })
    // A move of a line the Brief names makes it stale again.
    await updateTaskRaw(workerId, { phase: 'NEED_ACTION', status_report: { state: 'needs', ask: 'Pick a design', at: new Date().toISOString() } }, { emitEvent: true, source: 'status-report', leaveHeld: true })
    await until('the worker asks again', async () => (await getTask(workerId)).user_status?.ask === 'Pick a design')
    await until('the lead is idle', async () => !(await getTask(leadId)).user_status || (await getTask(leadId)).user_status?.state !== 'working')
    bus.emit(EventNames.TIME_BANKED, { records: [{ ts: new Date(Date.now() - 30_000).toISOString(), durationMs: 20_000, kind: 'session', source: 'ios', sessionId: LEAD_SID }] }, [], { source: 'time-tracking' })
    await until('a refresh asked by the phone', async () => (await getTask(leadId)).brief_refresh?.by === 'phone')
    expect((await getTask(leadId)).brief_refresh).toMatchObject({ by: 'phone', moved: 1 })
  })
})
