/**
 * The thread check on a real server (experiment threads_audit, src/core/org/thread-audit.ts,
 * routes src/web/routes/thread-audit-v1.ts, op thread_audit). A lead holds two cards on one subject
 * (an orchard's irrigation timer) and a card whose summary asks him to pick while it sits in
 * answered. One pass with an injected judge tells both to the lead's session in ONE note that
 * wakes it; the counts route and the op show them; a second pass tells nothing new; after the lead
 * merges the two and rewrites the summary, the next pass counts both fixed. A lead with only a
 * quiet card hears it on its next message, no wake, and a second such note while the first is
 * unread carries its finding. With the switch off, or the org off, a pass does nothing.
 * Mocked: constants and the model (the judge seam); no CLI is started.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-audit-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { executeOp } from '../../src/ops/index.js'
import { fileThreadMessage, readThreads, writeThreadsFor } from '../../src/core/org/threads-store.js'
import { getQueue } from '../../src/core/session-message-queue.js'
import { _resetOrgEnabledForTesting } from '../../src/core/org/org-enabled.js'
import { runThreadAuditPass, setAuditJudgeOverride, startThreadAudit, threadAuditClockRuns, THREAD_AUDIT_SOURCE } from '../../src/core/org/thread-audit.js'
import { pendingRiding, ridingKeys, ridingLine } from '../../src/core/sessions/status-riding.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

let server: Server
let root = ''
interface Lead { id: string; sid: string }
let n = 0
async function newLead(): Promise<Lead> {
  const lead = (await addTask({ title: `Orchard VP ${++n}`, project: `AuditProj${n}`, source: 'local', org_role: 'lead' } as never)).task
  const sid = `audit-lead-${n}`
  await createSessionRecord(sid, lead.id, `AuditProj${n}`)
  return { id: lead.id, sid }
}
async function api<T = Record<string, any>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${root}${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const setThread = (taskId: string, id: string, patch: Partial<OrgThread>) =>
  writeThreadsFor(taskId, (cur) => ({ file: { ...cur, threads: cur.threads.map((t) => (t.id === id ? { ...t, ...patch } : t)) }, out: undefined }))
// Walnut's own notification under the check's source (thread-audit.ts auditMessage), never his words.
const notes = async (lead: Lead) => (await getQueue(lead.sid)).filter((m) => m.source === THREAD_AUDIT_SOURCE || m.message.includes('outcome="threads-audit"'))
const setSwitch = async (on: boolean) => expect((await api('PUT', '/api/config', { experimental: { threads_audit: on } })).status).toBe(200)

let judged: string[] = []

beforeAll(async () => {
  _resetOrgEnabledForTesting(true)
  server = await startServer({ port: 0, dev: true })
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  setAuditJudgeOverride(async (input) => { judged.push(input); return '1 SAME: one irrigation timer, told twice' })
}, 60_000)
afterAll(async () => {
  setAuditJudgeOverride(null)
  _resetOrgEnabledForTesting()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('the thread check', () => {
  let lead: Lead
  let timerA = ''
  let timerB = ''
  let paint = ''

  it('with the switch off a pass does nothing', async () => {
    lead = await newLead()
    timerA = (await fileThreadMessage(lead.id, { text: 'the pear orchard irrigation timer drifts at night', via: 'chat', at: ago(120) })).thread.id
    timerB = (await fileThreadMessage(lead.id, { text: 'irrigation timer drift in the pear orchard again', via: 'chat', at: ago(60) })).thread.id
    paint = (await fileThreadMessage(lead.id, { text: 'what color for the new gate', via: 'chat', at: ago(30) })).thread.id
    expect(new Set([timerA, timerB, paint]).size).toBe(3)
    await setThread(lead.id, timerA, { title: 'Pear orchard irrigation timer drifts at night', titled: true, state: 'answered', reply: 'The timer loses ten minutes a night; a new battery is ordered for Friday.' })
    await setThread(lead.id, timerB, { title: 'Irrigation timer drift in the pear orchard', titled: true, state: 'working', reply: 'Looking at the timer log of the pear orchard pump.' })
    // A card written before the refusal of an ask outside needs existed: it asks him from answered.
    await setThread(lead.id, paint, { title: 'Gate paint color', titled: true, state: 'answered', reply: 'The new gate is hung and primed. Please pick a paint color: white or barn red.' })

    await setSwitch(false)
    const off = await api('POST', '/api/v1/thread-audit/run', { task: lead.id })
    expect(off.status).toBe(200)
    expect(off.json).toMatchObject({ ran: false, why: 'off' })
    expect(await runThreadAuditPass()).toEqual([])
    expect(await notes(lead)).toHaveLength(0)
    expect(judged).toHaveLength(0)
    const counts = await api('GET', '/api/v1/thread-audit')
    expect(counts.json).toMatchObject({ on: false, days: [] })
  })

  it('one pass tells the repeat and the unasked decision in one note that wakes the lead', async () => {
    await setSwitch(true)
    const r = await api('POST', '/api/v1/thread-audit/run', { task: lead.id })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ran: true, delivery: 'woke', calls: 1 })
    expect(r.json.told.map((f: { kind: string }) => f.kind).sort()).toEqual(['repeat', 'unasked'])
    // The judge read titles and summary sentences, never his messages.
    expect(judged).toHaveLength(1)
    expect(judged[0]).toContain('Title: Pear orchard irrigation timer drifts at night')
    expect(judged[0]).not.toContain('again')
    const sent = await notes(lead)
    expect(sent).toHaveLength(1)
    const note = sent[0].message
    expect(note).toContain('Walnut\'s thread check')
    expect(note).toMatch(new RegExp(`thread_update \\{"id":"(${timerA}|${timerB})","merge_into":"(${timerA}|${timerB})"\\}`))
    expect(note).toContain(`- unasked: ${paint}`)
    expect(note).toContain('one irrigation timer, told twice')
    // Nothing on the threads was changed by the check.
    const threads = (await readThreads(lead.id)).threads
    expect(threads.filter((t) => !t.closed)).toHaveLength(3)
    expect(threads.find((t) => t.id === paint)?.state).toBe('answered')
  })

  it('the counts route and the op show what was found and told', async () => {
    const c = await api('GET', `/api/v1/thread-audit?days=3&task=${lead.id}`)
    expect(c.status).toBe(200)
    expect(c.json.on).toBe(true)
    expect(c.json.totals).toMatchObject({ passes: 1, calls: 1 })
    expect(c.json.totals.found).toMatchObject({ repeat: 1, unasked: 1, stale: 0, thin: 0 })
    expect(c.json.totals.reported).toMatchObject({ repeat: 1, unasked: 1 })
    expect(c.json.days[0].nodes[lead.id]).toBeTruthy()
    const out = await executeOp('thread_audit', { days: 3 }, { apiBase: root, origin: '__local__', callerMode: 'session', callerSid: lead.sid })
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out)).toMatch(/found 2 \(1 repeat, 1 unasked\), told 2/)
    expect((await api('GET', '/api/v1/thread-audit?days=0')).status).toBe(400)
  })

  it('a second pass tells nothing new and makes no second model call', async () => {
    const r = await api('POST', '/api/v1/thread-audit/run', { task: lead.id })
    expect(r.json).toMatchObject({ ran: true, delivery: 'none', calls: 0, told: [] })
    expect(r.json.found).toMatchObject({ repeat: 1, unasked: 1 })
    expect(await notes(lead)).toHaveLength(1)
    expect(judged).toHaveLength(1)
  })

  it('once the lead merges the two and rewrites the summary, the next pass counts both fixed', async () => {
    const merged = await executeOp('thread_update', { id: timerB, merge_into: timerA }, { apiBase: root, origin: '__local__', callerMode: 'session', callerSid: lead.sid })
    expect(merged.ok, JSON.stringify(merged)).toBe(true)
    await setThread(lead.id, paint, { reply: 'The new gate is hung and primed; it gets barn red on Saturday, as you picked.' })
    const r = await api('POST', '/api/v1/thread-audit/run', { task: lead.id })
    expect(r.json).toMatchObject({ ran: true, told: [] })
    expect(r.json.fixed).toMatchObject({ repeat: 1, unasked: 1 })
    const c = await api('GET', `/api/v1/thread-audit?task=${lead.id}`)
    expect(c.json.totals.fixed).toMatchObject({ repeat: 1, unasked: 1, stale: 0, thin: 0 })
    expect(c.json.totals.passes).toBe(3)
  })

  it('a lead with only a quiet card hears it on its next message, with no wake', async () => {
    const quiet = await newLead()
    const id = (await fileThreadMessage(quiet.id, { text: 'mend the north fence', via: 'chat', at: ago(3000) })).thread.id
    await setThread(quiet.id, id, { title: 'North fence', titled: true, state: 'working', reply: 'Posts are ordered.', updatedAt: ago(26 * 60) })
    const r = await api('POST', '/api/v1/thread-audit/run', { task: quiet.id })
    expect(r.json).toMatchObject({ ran: true, delivery: 'rode' })
    expect(r.json.told.map((f: { kind: string }) => f.kind)).toEqual(['stale'])
    expect(await notes(quiet)).toHaveLength(0)
    expect(ridingKeys(quiet.sid)).toContain('thread-audit')
    expect(ridingLine(quiet.sid, 'thread-audit')).toContain(`- stale: ${id}`)

    // A second riding note while the first is unread carries its finding: the one slot never drops it.
    const gate = (await fileThreadMessage(quiet.id, { text: 'oil the barn gate hinges', via: 'chat', at: ago(2900) })).thread.id
    await setThread(quiet.id, gate, { title: 'Barn gate hinges', titled: true, state: 'working', reply: 'Oil is on the shelf.', updatedAt: ago(30 * 60) })
    const again = await api('POST', '/api/v1/thread-audit/run', { task: quiet.id })
    expect(again.json).toMatchObject({ ran: true, delivery: 'rode' })
    const line = ridingLine(quiet.sid, 'thread-audit')!
    expect(line).toContain(`- stale: ${id}`)
    expect(line).toContain(`- stale: ${gate}`)
    // Told once each, though the first went twice.
    const counted = await api('GET', `/api/v1/thread-audit?task=${quiet.id}`)
    expect(counted.json.totals.reported.stale).toBe(2)

    // Read with its next message: the next note holds only what is new.
    pendingRiding(quiet.sid)!.markTold()
    expect(ridingLine(quiet.sid, 'thread-audit')).toBeUndefined()
    const well = (await fileThreadMessage(quiet.id, { text: 'clean the well cover', via: 'chat', at: ago(2800) })).thread.id
    await setThread(quiet.id, well, { title: 'Well cover', titled: true, state: 'working', reply: 'Brush is ordered.', updatedAt: ago(28 * 60) })
    await api('POST', '/api/v1/thread-audit/run', { task: quiet.id })
    const third = ridingLine(quiet.sid, 'thread-audit')!
    expect(third).toContain(`- stale: ${well}`)
    expect(third).not.toContain(id)
    expect(third).not.toContain(gate)
  })

  it('a check run by hand does nothing while the org is off', async () => {
    _resetOrgEnabledForTesting(false)
    try {
      expect((await api('POST', '/api/v1/thread-audit/run', { task: lead.id })).json).toMatchObject({ ran: false, why: 'org_off' })
    } finally {
      _resetOrgEnabledForTesting(true)
    }
  })

  it('the clock checks nothing under a test run (background AI is off), and the switch off ends its pass', async () => {
    expect(await runThreadAuditPass()).toEqual([])
    await setSwitch(false)
    expect((await api('POST', '/api/v1/thread-audit/run', { task: lead.id })).json).toMatchObject({ ran: false, why: 'off' })
  })
})

// Review 2026-11-25: the clock was started inside a promise the server did not wait for, so a stop
// that came first left it running, and the module's mark then made every later start a no-op.
describe('the clock\'s start and stop', () => {
  it('the server\'s start has its clock running before it returns', () => {
    expect(threadAuditClockRuns()).toBe(true)
  })

  it('a start replaces a clock left running, and a stop stops only its own: none is left behind', () => {
    const left = startThreadAudit()
    const next = startThreadAudit()
    expect(threadAuditClockRuns()).toBe(true)
    // The replaced handle's stop leaves the new clock alone.
    left.stop()
    expect(threadAuditClockRuns()).toBe(true)
    next.stop()
    expect(threadAuditClockRuns()).toBe(false)
    // An ephemeral server starts none.
    startThreadAudit({ ephemeral: true })
    expect(threadAuditClockRuns()).toBe(false)
  })

  it('a server stopped and started again runs one clock, and its stop leaves none', async () => {
    await stopServer()
    expect(threadAuditClockRuns()).toBe(false)
    server = await startServer({ port: 0, dev: true })
    root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    expect(threadAuditClockRuns()).toBe(true)
  }, 60_000)
})
