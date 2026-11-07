/**
 * An answer for the user (task_send answers_ask) to a task that is not running, or is finished, is
 * recorded and taken off the user's Needs you, and starts no turn (2026-11-06, the org reflection:
 * a VP's answer resumed a stopped task, which pushed two commits and armed a second trigger before
 * the VP could stop it). A real server, real task and session stores, the real send queue.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ask-answer-no-wake'))

/** Every message put into a session, by session id: the real queue, recorded on the way in. */
const sentTo = vi.hoisted(() => [] as string[])
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/session-message-queue.js')>()
  return {
    ...real,
    sendMessageToSession: ((sid: string, ...rest: unknown[]) => {
      sentTo.push(sid)
      return (real.sendMessageToSession as (...a: unknown[]) => unknown)(sid, ...rest)
    }) as typeof real.sendMessageToSession,
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { createSessionRequest, getSessionRequest } from '../../src/core/session-requests.js'
import { getQueue } from '../../src/core/session-message-queue.js'

const LEAD_SID = 'eeeeeeee-aaaa-4bbb-8ccc-dddddddddddd'
const PROJECT = 'Orchard'
let base = ''
let lead = ''
let n = 0

type Status = 'idle' | 'running' | 'stopped' | 'error'

/** A task whose session is in `status`, asking the user `ask` in its own turn-end report. */
async function asking(title: string, ask: string, status: Status, opts: { folded?: boolean } = {}): Promise<{ id: string; sid: string }> {
  n += 1
  const id = (await addTask({ title, project: PROJECT } as never)).task.id
  const sid = `${String(n).padStart(8, '0')}-1111-4bbb-8ccc-dddddddddddd`
  await createSessionRecord(sid, id, PROJECT, WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  await updateTask(id, { phase: 'NEED_ACTION' })
  await new Promise((r) => setTimeout(r, 5))
  await updateTaskRaw(id, { status_report: { state: 'needs', ask, ask_own: { kind: 'user_own', why: 'It is his own decision' }, at: new Date().toISOString(), rule: 2 } } as never, { source: 'test' })
  await settle()
  if (!opts.folded) expect((await getTask(id)).user_status, `${title} asks the user`).toMatchObject({ state: 'needs', ask })
  if (status !== 'idle') await updateSessionRecord(sid, { process_status: status } as never)
  return { id, sid }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await syncUserStatuses(null, Date.now() + 60_000)
}

async function answer(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': LEAD_SID },
    body: JSON.stringify({ title: 'Decided', expect_reply: false, answers_ask: true, ...body }),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

const queued = async (sid: string) => JSON.stringify(await getQueue(sid))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  lead = (await ensureProjectLead(PROJECT)).id
  await createSessionRecord(LEAD_SID, lead, PROJECT, WALNUT_HOME)
  await updateSessionRecord(LEAD_SID, { process_status: 'idle' } as never)
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a task that is not running', () => {
  for (const status of ['stopped', 'error'] as const) {
    it(`(${status}): the answer is recorded, its ask leaves Needs you, and nothing is delivered`, async () => {
      const ask = `Run the ${status} cleanup on the staging bucket now?`
      const t = await asking(`Staging ${status}`, ask, status)
      const r = await answer({ to: t.id, text: 'No action needed: the bucket is fine.' })
      expect(r.status, JSON.stringify(r.json)).toBe(202)
      expect(r.json).toMatchObject({ delivery: 'recorded', notWoken: 'stopped', targetTaskId: t.id })
      expect(r.json.requestId).toBeUndefined()
      // Nothing queued or sent, the session left as it was, the task's phase untouched.
      expect(sentTo).not.toContain(t.sid)
      expect(await queued(t.sid)).not.toContain('bucket is fine')
      expect((await getSessionByClaudeId(t.sid))?.process_status).toBe(status)
      const after = await getTask(t.id)
      expect(after.phase).toBe('NEED_ACTION')
      expect(after.ask_answered).toMatchObject({ by: lead, ask })
      await settle()
      expect((await getTask(t.id)).user_status).toMatchObject({ state: 'waiting', answeredFor: { by: lead } })
    })
  }

  it('a request it asked of its lead is settled by the answer, with nothing delivered', async () => {
    const ask = 'Pick the orchard release date: Monday or Friday?'
    const t = await asking('Release date', ask, 'stopped')
    const rq = await createSessionRequest({ fromSessionId: t.sid, toSessionId: LEAD_SID, toTaskId: lead, fromTaskId: t.id, text: ask })
    const r = await answer({ in_reply_to: rq.id, text: 'Friday.' })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json).toMatchObject({ delivery: 'recorded', notWoken: 'stopped', repliedTo: rq.id })
    expect((await getSessionRequest(rq.id))?.status).toBe('replied')
    expect(sentTo).not.toContain(t.sid)
    expect(await queued(t.sid)).not.toContain('Friday')
    expect((await getTask(t.id)).ask_answered).toMatchObject({ ask, text: 'Friday.' })
  })

  it('hands_on is refused: it needs the task to work, and nothing is recorded', async () => {
    const ask = 'Should the orchard importer retry failed rows tonight?'
    const t = await asking('Importer retries', ask, 'stopped')
    const r = await answer({ to: t.id, text: 'Yes.', hands_on: 'rq-aaaaaaaaaaaa', expect_reply: true })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.json)).toContain('task_start')
    expect((await getTask(t.id)).ask_answered).toBeUndefined()
  })
})

describe('a finished task', () => {
  it('is never reopened by an answer, even with its CLI alive', async () => {
    const ask = 'Archive the old orchard dashboards?'
    const t = await asking('Dashboards', ask, 'idle')
    // Completed with its last status still asking (the sync never rewrites a COMPLETE row).
    await updateTaskRaw(t.id, { phase: 'COMPLETE' } as never, { source: 'test' })
    const r = await answer({ to: t.id, text: 'Keep them.' })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json).toMatchObject({ delivery: 'recorded', notWoken: 'complete' })
    expect(sentTo).not.toContain(t.sid)
    expect(await queued(t.sid)).not.toContain('Keep them')
    expect((await getTask(t.id)).phase).toBe('COMPLETE')
  })

  it('one that asks nothing any more is refused as complete, never sent', async () => {
    const t = await asking('Old export', 'Export the orchard ledger as CSV for the audit?', 'idle')
    await updateTaskRaw(t.id, { phase: 'COMPLETE', status_report: null } as never, { source: 'test' })
    const r = await answer({ to: t.id, text: 'Export it.' })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.json)).toContain('it is complete and asks the user nothing')
    expect(await queued(t.sid)).not.toContain('Export it.')
  })

  it('force with a reason is the explicit way: it goes in and reopens it', async () => {
    const ask = 'Rotate the orchard demo login page copy?'
    const t = await asking('Login copy', ask, 'idle')
    await updateTaskRaw(t.id, { phase: 'COMPLETE' } as never, { source: 'test' })
    const r = await answer({ to: t.id, text: 'Yes, rotate it.', force: true, reason: 'The copy must change before the demo.' })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json.delivery).toBe('queued')
    await expect.poll(() => queued(t.sid), { timeout: 5_000 }).toContain('Yes, rotate it.')
  })
})

describe('a task that runs', () => {
  it('gets the answer as a message, led by Walnut\'s line, as before', async () => {
    const ask = 'Turn on the orchard nightly report?'
    const t = await asking('Nightly report', ask, 'idle')
    const r = await answer({ to: t.id, text: 'Turn it on.' })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json.delivery).toBe('queued')
    expect(r.json.notWoken).toBeUndefined()
    await expect.poll(() => queued(t.sid), { timeout: 5_000 }).toContain('took it off the user')
    expect(sentTo).toContain(t.sid)
  })
})

describe('a teammate folded under the answered ask', () => {
  it('is told only while it runs: a stopped one is not resumed for it', async () => {
    const ask = 'Rename the orchard staging stage to beta?'
    const a = await asking('Stage holder', ask, 'idle')
    const b = await asking('Stage follower', ask, 'idle', { folded: true })
    await settle()
    const holder = (await getTask(b.id)).user_status?.sameAsk ? a : b
    const follower = holder === a ? b : a
    expect((await getTask(follower.id)).user_status).toMatchObject({ sameAsk: { id: holder.id, team: true } })
    await updateSessionRecord(follower.sid, { process_status: 'stopped' } as never)
    const r = await answer({ to: holder.id, text: 'Rename it.' })
    expect(r.json.delivery).toBe('queued')
    const rec = (await getTask(holder.id)).ask_answered!
    await updateTaskRaw(holder.id, { ask_answered: { ...rec, at: new Date(Date.now() + 120_000).toISOString() } } as never, { source: 'test' })
    await settle()
    expect((await getTask(follower.id)).user_status).toMatchObject({ state: 'waiting', sameAsk: { id: holder.id, answered: true } })
    await new Promise((r) => setTimeout(r, 1_500))
    expect(sentTo).not.toContain(follower.sid)
    expect(await queued(follower.sid)).not.toContain('it was answered there')
    expect((await getSessionByClaudeId(follower.sid))?.process_status).toBe('stopped')
  })
})
