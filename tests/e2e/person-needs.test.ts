/**
 * A person's NEED_ACTION is their own ask (src/core/sessions/person-needs.ts; 2026-11-02). Only a
 * real ask reaches Needs you and a bare NEED_ACTION after a turn asks nothing, so a task the user
 * set to "needs you" from its status control (or the phone, or the CLI from a terminal) must still
 * read Needs you, while the same move by a session reads nothing asked.
 *
 * Guard for the class: every request route that writes a phase (each one that runs the park gate)
 * marks a person's move; a new phase route that does not fails here. Only the Claude CLI is mocked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-person-needs'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses, HANDBACK_SETTLE_MS } from '../../src/core/user-status-sync.js'
import { MARKED_ASK } from '../../src/core/user-status.js'
import { personMarkedNeeds } from '../../src/core/sessions/person-needs.js'

let base = ''
let n = 0

/** A task whose session ran a turn and sits idle, read as Waiting before the move. */
async function idleTask(): Promise<string> {
  n += 1
  const id = (await addTask({ title: `Garden bed ${n}`, project: 'Garden' })).task.id
  const sid = `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`
  await createSessionRecord(sid, id, 'Garden', WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  await updateTask(id, { phase: 'IN_PROGRESS' })
  return id
}

async function call(method: string, url: string, body: unknown, callerSid?: string): Promise<Response> {
  const res = await fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) }, body: JSON.stringify(body),
  })
  expect(res.ok, `${method} ${url}: ${res.status} ${await res.clone().text()}`).toBe(true)
  return res
}

async function statusAfter(id: string) {
  await syncUserStatuses(new Set([id]), Date.now() + HANDBACK_SETTLE_MS + 1_000)
  return (await getTask(id)).user_status
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a person sets NEED_ACTION', () => {
  const ROUTES: Array<[string, (id: string, sid?: string) => Promise<Response>]> = [
    ['PATCH /api/tasks/:id', (id, sid) => call('PATCH', `/api/tasks/${id}`, { phase: 'NEED_ACTION' }, sid)],
    ['PATCH /api/v1/tasks/:id', (id, sid) => call('PATCH', `/api/v1/tasks/${id}`, { phase: 'NEED_ACTION' }, sid)],
    ['POST /api/tasks/batch/phase', (id, sid) => call('POST', '/api/tasks/batch/phase', { task_ids: [id], phase: 'NEED_ACTION' }, sid)],
    ['POST /api/v1/tasks/batch/phase', (id, sid) => call('POST', '/api/v1/tasks/batch/phase', { task_ids: [id], phase: 'NEED_ACTION' }, sid)],
  ]

  for (const [name, move] of ROUTES) {
    it(`${name}: a person's move reads Needs you; a session's reads nothing asked`, async () => {
      const mine = await idleTask()
      await move(mine)
      expect(await statusAfter(mine), name).toMatchObject({ state: 'needs', ask: MARKED_ASK })

      const theirs = await idleTask()
      await move(theirs, '99999999-2222-4333-8444-555555555555')
      expect(await statusAfter(theirs), name).toMatchObject({ state: 'waiting', toRead: 'turn' })
    })
  }

  it('the mark ends with the phase: a later turn and hand-back read nothing asked', async () => {
    const id = await idleTask()
    await call('PATCH', `/api/tasks/${id}`, { phase: 'NEED_ACTION' })
    expect(personMarkedNeeds(await getTask(id))).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    await updateTask(id, { phase: 'IN_PROGRESS' })
    await new Promise((r) => setTimeout(r, 20))
    await updateTask(id, { phase: 'NEED_ACTION' })
    expect(personMarkedNeeds(await getTask(id))).toBe(false)
  })
})

describe('guard: every phase route marks a person\'s NEED_ACTION', () => {
  it('each route file that runs the park gate also marks', async () => {
    const dir = path.resolve(__dirname, '../../src/web/routes')
    const missing: string[] = []
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.ts')) continue
      const src = await fs.readFile(path.join(dir, f), 'utf8')
      const gates = (src.match(/splitSessionParks\(|admitSessionPark\(/g) ?? []).length
      const marks = (src.match(/markPersonNeeds\(/g) ?? []).length
      if (gates > marks) missing.push(`${f}: ${gates} phase write(s), ${marks} mark(s)`)
    }
    expect(missing, 'A route writes a phase but never marks a person\'s NEED_ACTION (core/sessions/person-needs.ts)').toEqual([])
  })
})
