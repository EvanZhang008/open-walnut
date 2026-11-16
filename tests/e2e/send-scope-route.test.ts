/**
 * task_send's scope check through the real server (POST /api/v1/messages, the route task_send
 * binds to): a lead's message handing an open task another task's half-done fix is refused with
 * 409 scope_mismatch and nothing is queued; same_deliverable sends it, led by one line; a
 * follow-up of the target's own code review and the person's own send go as before.
 * The pure rules: tests/core/sessions/send-scope.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-send-scope-route'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { getQueue } from '../../src/core/session-message-queue.js'

const LEAD_SID = 'abababab-1111-4bbb-8ccc-dddddddddddd'
const TARGET_SID = 'cdcdcdcd-2222-4bbb-8ccc-dddddddddddd'
let base = ''
let target = ''
let other = ''

async function send(body: Record<string, unknown>, sid: string | null = LEAD_SID): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify({ expect_reply: false, ...body }),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}
const queued = async () => JSON.stringify(await getQueue(TARGET_SID))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const lead = (await addTask({ title: 'Router VP', project: 'Orchard' } as never)).task.id
  await updateTaskRaw(lead, { org_role: 'lead', note: '## Executive Summary\nCR-555000222 is on the board.' } as never, { source: 'test' })
  await createSessionRecord(LEAD_SID, lead, 'Orchard', WALNUT_HOME)

  target = (await addTask({ title: 'CR: acme-router poller ListBucket', project: 'Orchard' } as never)).task.id
  await updateTaskRaw(target, {
    note: '## User Request\nCR 1 adds only s3:ListBucket on the health bucket (CR-555000111); CR 2 adds alarm dimensions.',
    tags: ['cr:https://reviews.example.test/CR-555000111'],
  } as never, { source: 'test' })
  await createSessionRecord(TARGET_SID, target, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(TARGET_SID, { process_status: 'idle' } as never)
  await updateTaskRaw(target, { session_id: TARGET_SID } as never, { source: 'test' })

  other = (await addTask({ title: 'Region outage: poller did not fail over', project: 'Orchard' } as never)).task.id
}, 60_000)

afterAll(async () => { await stopServer() })

describe('POST /api/v1/messages: the scope check', () => {
  const handoff = () => `Today's outage exposed two faults in the poller you are fixing, so it is yours. `
    + `Half-done patches at /home/u/.local/state/open-walnut/tasks/${other}/router.patch; open it as CR-555000444.`

  it('refuses a lead\'s handoff of another task\'s work, and queues nothing', async () => {
    const r = await send({ to: target, title: 'Outage fix is yours', text: handoff() })
    expect(r.status, JSON.stringify(r.json)).toBe(409)
    expect(r.json.error.code).toBe('scope_mismatch')
    expect(r.json.error.message).toContain('Its deliverable: "CR 1 adds only s3:ListBucket on the health bucket')
    expect(r.json.refs).toEqual([
      { kind: 'review', ref: 'CR-555000444' },
      { kind: 'task_files', ref: other, title: 'Region outage: poller did not fail over' },
    ])
    expect(r.json.deliverable).toContain('CR 1 adds only s3:ListBucket')
    expect(await queued()).not.toContain('router.patch')
  })

  it('sends it with same_deliverable, led by one line the target reads', async () => {
    const short = await send({ to: target, text: handoff(), same_deliverable: 'ok' })
    expect(short.status).toBe(400)
    const r = await send({ to: target, text: handoff(), same_deliverable: 'The reviewer folded the outage fix into CR 2 of your request' })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    const q = await queued()
    expect(q).toContain('The sender says this is your own deliverable')
    expect(q).toContain('router.patch')
  })

  it('a follow-up of the target\'s own code review goes as before', async () => {
    const r = await send({ to: target, text: 'CR-555000111 has a reviewer comment: please answer it.' })
    expect(r.status, JSON.stringify(r.json)).toBe(202)
    expect(await queued()).toContain('please answer it')
  })

  it('the person\'s own send is never checked', async () => {
    const r = await send({ to: target, text: `From me: also look at CR-555000777.` }, null)
    expect(r.status, JSON.stringify(r.json)).toBe(202)
  })
})
