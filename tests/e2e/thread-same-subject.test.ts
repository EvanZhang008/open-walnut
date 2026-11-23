/**
 * One subject is one thread, through thread_create's own door (POST /tasks/:id/threads/open,
 * org/thread-same-subject.ts). The shape of the user's tree on 2026-11-23: a task of a lead's team
 * keeps its own threads; the lead opens a thread on the subject the task already follows. Walnut
 * names the task's open thread (409 same_subject); a reason that it is another subject opens it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-same-subject'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask, updateTask } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { openNodeThread } from '../../src/core/org/threads-store.js'

const LEAD_SID = '66666666-6666-4777-8888-999999999991'
let base = ''
let leadId = ''
let workerId = ''

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  workerId = (await addTask({ title: 'Failover review', project: 'Acme' })).task.id
  await updateTask(workerId, { threads_on: true })
  leadId = (await ensureProjectLead('Acme')).id
  await createSessionRecord(LEAD_SID, leadId, 'Acme', WALNUT_HOME)
  await updateSessionRecord(LEAD_SID, { process_status: 'stopped' })
  await openNodeThread(workerId, { title: 'Gamma auto failover switch for acme-west-1', text: 'The switch is off in gamma.', from: 'node', state: 'answered' }, `task:${workerId}`)
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

const open = (body: Record<string, unknown>) => fetch(`${base}/api/v1/tasks/${leadId}/threads/open`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': LEAD_SID },
  body: JSON.stringify({ text: 'What reached me.', from: 'node', state: 'answered', ...body }),
})

describe('thread_create on a subject a task of the team already follows', () => {
  it('is refused, naming that task and its thread', async () => {
    const res = await open({ title: 'acme-west-1 gamma failover switch' })
    expect(res.status).toBe(409)
    const body = await res.json() as { error?: { code?: string; message?: string }; code?: string; message?: string }
    const text = JSON.stringify(body)
    expect(text).toContain('same_subject')
    expect(text).toContain('Failover review')
    expect(text).toContain('separate_reason')
  })

  it('a thread that names that task, whatever its title, is told the subject lives on the task', async () => {
    const res = await open({ title: 'Something the review found', tasks: [workerId] })
    expect(res.status).toBe(409)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('same_subject')
    expect(text).toContain('keeps its own Threads')
    // A subject none of its threads covers opens with the reason said.
    expect((await open({ title: 'Approve the vendor contract', tasks: [workerId], separate_reason: 'The contract is the lead\'s own call, not the review\'s work.' })).status).toBe(201)
  })

  it('a first post or summary that only points elsewhere is refused', async () => {
    const res = await open({ title: 'Stand-up notes for the week', text: 'The stand-up summary was given to you.' })
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('write the answer itself')
  })

  it('opens with a reason that it is another subject, and an unrelated subject opens at once', async () => {
    expect((await open({ title: 'acme-west-1 gamma failover switch', separate_reason: 'This is the prod switch, a separate change with its own review.' })).status).toBe(201)
    expect((await open({ title: 'Quarterly budget review' })).status).toBe(201)
  })
})
