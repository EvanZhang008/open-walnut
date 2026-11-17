/**
 * A session's task_send through the real server (POST /api/v1/messages, the route task_send binds
 * to) is never refused for the format of what its text names: review or ticket numbers, another
 * task's files, words in another language. Whether the work is the target's own deliverable is the
 * sender's judgment (the task routing contract's steps); the answer puts the target's deliverable
 * in front of the sender, so a message that was other work shows at once.
 *
 * The cases are the dispatch audit's of 2026-11-16, rewritten with neutral data:
 *   - same file, different deliverable: a lead hands a code review's task (bucket permission and
 *     alarm dimensions) another task's half-done outage fix in the same poller, naming a review
 *     number and the other task's patch path. Delivered; the answer quotes the code review's own
 *     deliverable, which is not the outage fix;
 *   - the same deliverable's normal follow-up: one more piece of evidence for the owner's own
 *     "the whole app is slow" deliverable. Delivered, as it always was;
 *   - words in another language: a Chinese follow-up to an English-titled owner. Delivered.
 * tests/core/no-format-refusal-guard.test.ts fails when a check of a message's formats comes back.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-send-names-other-work'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { getQueue } from '../../src/core/session-message-queue.js'
import { getOp } from '../../src/ops/index.js'

const LEAD_SID = 'abababab-1111-4bbb-8ccc-dddddddddddd'
const REVIEW_SID = 'cdcdcdcd-2222-4bbb-8ccc-dddddddddddd'
const SLOW_SID = 'efefefef-3333-4bbb-8ccc-dddddddddddd'
let base = ''
let review = ''
let slow = ''
let outage = ''

async function send(body: Record<string, unknown>, sid: string | null = LEAD_SID): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify({ expect_reply: false, ...body }),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

async function worker(title: string, sid: string, userRequest: string): Promise<string> {
  const id = (await addTask({ title, project: 'Orchard' } as never)).task.id
  await updateTaskRaw(id, { note: `## User Request\n${userRequest}` } as never, { source: 'test' })
  await createSessionRecord(sid, id, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(sid, { process_status: 'idle' } as never)
  await updateTaskRaw(id, { session_id: sid } as never, { source: 'test' })
  return id
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const lead = (await addTask({ title: 'Orchard VP', project: 'Orchard' } as never)).task.id
  await updateTaskRaw(lead, { org_role: 'lead' } as never, { source: 'test' })
  await createSessionRecord(LEAD_SID, lead, 'Orchard', WALNUT_HOME)
  review = await worker('Code review: storage poller bucket-list permission', REVIEW_SID,
    'Review 1 adds only the bucket-list permission on the health bucket (REV-555000111); review 2 adds alarm dimensions.')
  slow = await worker('Whole app feels slow: typing, new task, chats', SLOW_SID,
    'Find why the whole app is slow at times and fix the cause.')
  outage = (await addTask({ title: 'Region outage: poller did not fail over', project: 'Orchard' } as never)).task.id
}, 60_000)

afterAll(async () => { await stopServer() })

describe('a session\'s task_send is judged by its sender, never by what its text names', () => {
  it('same file, different deliverable: delivered, and the answer quotes the target\'s own deliverable', async () => {
    const text = 'Today\'s outage exposed two faults in the poller you are fixing, so it is yours. '
      + `Half-done patch at /home/u/.local/state/open-walnut/tasks/${outage}/poller.patch; open it as REV-555000444, ticket 0123456789.`
    const r = await send({ to: review, title: 'Outage fix is yours', text })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(JSON.stringify(await getQueue(REVIEW_SID))).toContain('poller.patch')
    expect(r.json.targetDeliverable).toBe('Review 1 adds only the bucket-list permission on the health bucket (REV-555000111); review 2 adds alarm dimensions.')
    // What task_send's caller reads: the deliverable beside "queued", and what to do when it was other work.
    const outcome = getOp('task_send')!.mapResult!({ body: r.json, args: { to: review, text } }) as { outcome: string }
    expect(outcome.outcome).toContain('Its deliverable: "Review 1 adds only the bucket-list permission')
    expect(outcome.outcome).toContain('If what you sent is other work, tell it to drop that and task_create it.')
  })

  it('the same deliverable\'s follow-up: delivered as it always was', async () => {
    const r = await send({ to: slow, text: 'One more piece of evidence for your deliverable: twice today the whole server was slow, GET /api/config took 3 s.' })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json.targetDeliverable).toBe('Find why the whole app is slow at times and fix the cause.')
    expect(JSON.stringify(await getQueue(SLOW_SID))).toContain('GET /api/config took 3 s')
  })

  it('words in another language: delivered', async () => {
    // "The draft-save lag is also part of your slowness case, see INC-2024-0099", in Chinese.
    const r = await send({ to: slow, text: '\u8349\u7a3f\u4fdd\u5b58\u5361\u987f\u4e5f\u5c5e\u4e8e\u4f60\u7684\u6162\u95ee\u9898\uff0c\u89c1 INC-2024-0099' })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
  })

  it('the person\'s own send carries no deliverable line', async () => {
    const r = await send({ to: review, text: 'From me: also look at REV-555000777.' }, null)
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(r.json.targetDeliverable).toBeUndefined()
  })
})

