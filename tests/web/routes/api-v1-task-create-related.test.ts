/**
 * A session's task create first meets the related OPEN tasks
 * (src/core/sessions/related-open-tasks.ts), end to end through a real
 * startServer({ port: 0, dev: true }) with an isolated home.
 *
 * The contract pinned here:
 *   - a session caller (worker or Personal AI ask) whose new task looks like open work
 *     gets 409 related_open_tasks with the candidates, and NOTHING is created;
 *   - the candidates skip the caller's own task, the tasks above it, COMPLETE tasks,
 *     asks, leads, and tasks the brief names by id as other work (one it takes over
 *     under its own title stays), and include the caller's own open subtasks;
 *   - confirm_new + new_reason creates once (the reason kept in the description);
 *     confirm_new without a real reason is a 400, also creating nothing;
 *   - a human (no caller header: the web console, the phone) is never checked;
 *   - a lookup that throws or hangs lets the create go ahead (fail open);
 *   - an idempotent retry of a create that happened is reused, never refused;
 *   - the legacy POST /api/tasks and the task_create op see the same answer.
 * The harness turns the check off for every other test (vitest config env); this
 * file turns it back on.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskcreate-related'))
vi.mock('../../../src/core/fork-title.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/fork-title.js')>()),
  summarizeGroupLabel: vi.fn(async () => 'Refined Folder'),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask, listTasks, updateTask, createFolder, addToGroup } from '../../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { _injectRelatedLookupForTesting } from '../../../src/core/sessions/related-open-tasks.js'
import { executeOp } from '../../../src/ops/index.js'

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`

async function post(body: unknown, sid?: string, path = '/api/v1/tasks'): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

const count = async (): Promise<number> => (await listTasks()).length

let seq = 0
async function session(taskId: string, project: string): Promise<string> {
  seq += 1
  const sid = `aaaaaaaa-2222-3333-4444-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, taskId, project, `/repo/${project}`, { title: 'caller' })
  return sid
}

let worker: { id: string; sid: string }
let askSid: string
let subtaskId: string
let photoId: string
let parentId: string

beforeAll(async () => {
  process.env.WALNUT_RELATED_CHECK = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port

  // A busy project: filler work that shares the common words.
  for (const t of ['Fix iOS widget layout', 'iOS test flake in drawer', 'Fix share sheet crash', 'Test tab bar scroll jump',
    'Fix iOS login screen crash', 'iOS: search bar slow first load', 'Fix dark mode flaky test']) {
    await addTask({ title: t, project: 'marina' })
  }
  // The caller's chain: a parent, the worker itself, and the worker's own subtask.
  parentId = (await addTask({ title: 'Mobile keyboard layout epic', project: 'marina' })).task.id
  const w = (await addTask({ title: 'Keyboard layout work', project: 'marina', parent_task_id: parentId })).task
  const folder = await createFolder('Mobile', 'marina')
  await addToGroup(folder.group_id, [w.id])
  worker = { id: w.id, sid: await session(w.id, 'marina') }
  subtaskId = (await addTask({ title: 'Fix iOS keyboard layout', project: 'marina', parent_task_id: w.id })).task.id
  // Look-alikes that must never be listed: done work, a conversation, a lead.
  const done = (await addTask({ title: 'Fix iOS keyboard layout regression', project: 'marina' })).task
  await updateTask(done.id, { phase: 'COMPLETE' })
  await addTask({ title: 'Fix iOS keyboard layout', project: 'Ask Walnut', walnut_agent: true })
  await addTask({ title: 'Fix iOS keyboard layout', project: 'marina', org_role: 'lead' })
  // An open task someone is working on right now.
  photoId = (await addTask({ title: 'iOS photo picker crash', project: 'marina' })).task.id
  const busy = await session(photoId, 'marina')
  await updateSessionRecord(busy, { process_status: 'running' })
  const ask = (await addTask({ title: 'Chat about the week', project: 'Ask Walnut', walnut_agent: true })).task
  askSid = await session(ask.id, 'Ask Walnut')
}, 60_000)

afterEach(() => { _injectRelatedLookupForTesting(null) })

afterAll(async () => {
  delete process.env.WALNUT_RELATED_CHECK
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a session create that looks like open work is refused, nothing made', () => {
  it('409 with the candidates; own subtask listed, own task, its parent, done work, asks and leads not', async () => {
    const before = await count()
    const { status, json } = await post({ title: 'Fix the iOS keyboard layout bug' }, worker.sid)
    expect(status).toBe(409)
    expect(json.error.code).toBe('related_open_tasks')
    expect(await count()).toBe(before)
    const ids = (json.candidates as Array<{ id: string }>).map((c) => c.id)
    expect(ids[0]).toBe(subtaskId)
    expect(ids).not.toContain(worker.id)
    expect(ids).not.toContain(parentId)
    expect(json.candidates.length).toBeLessThanOrEqual(5)
    const titles = json.candidates.map((c: { title: string; project: string }) => `${c.project}:${c.title}`)
    expect(titles).not.toContain('marina:Fix iOS keyboard layout regression')
    expect(titles.filter((t: string) => t === 'marina:Fix iOS keyboard layout')).toHaveLength(1)
    expect(titles.some((t: string) => t.startsWith('Ask Walnut:'))).toBe(false)
    const own = json.candidates[0]
    expect(own).toMatchObject({ title: 'Fix iOS keyboard layout', project: 'marina', phase: 'TODO', session_running: false, your_subtask: true })
    // The words that carried the match; ones most open tasks share are left out.
    expect(own.reason).toContain('"keyboard"')
    expect(own.reason).toContain('your subtask')
    expect(typeof own.updated_at).toBe('string')
    // The message alone tells an older session both ways out.
    expect(json.error.message).toContain(subtaskId)
    expect(json.error.message).toContain('task_send')
    expect(json.error.message).toContain('confirm_new')
    expect(json.hint).toContain('new_reason')
  })

  it('a running candidate says so, with its folder-free place', async () => {
    const { status, json } = await post({ title: 'Photo picker crash on iOS' }, worker.sid)
    expect(status).toBe(409)
    const photo = json.candidates.find((c: { id: string }) => c.id === photoId)
    expect(photo).toMatchObject({ session_running: true, project: 'marina' })
    expect(photo.your_subtask).toBeUndefined()
  })

  it('a Personal AI ask is a session caller too', async () => {
    const before = await count()
    const { status, json } = await post({ title: 'iOS photo picker crash' }, askSid)
    expect(status).toBe(409)
    expect(json.candidates[0].id).toBe(photoId)
    expect(await count()).toBe(before)
  })

  it('work that only shares the common words goes through', async () => {
    const { status } = await post({ title: 'Fix iOS widget timezone label' }, worker.sid)
    expect(status).toBe(201)
  })
})

describe('confirm', () => {
  it('confirm_new without a reason, or a short one, is a 400 and creates nothing', async () => {
    const before = await count()
    const none = await post({ title: 'Fix the iOS keyboard layout bug', confirm_new: true }, worker.sid)
    expect(none.status).toBe(400)
    expect(none.json.error.message).toContain('new_reason')
    const short = await post({ title: 'Fix the iOS keyboard layout bug', confirm_new: true, new_reason: 'new' }, worker.sid)
    expect(short.status).toBe(400)
    const wrongType = await post({ title: 'Fix the iOS keyboard layout bug', confirm_new: 'yes' }, worker.sid)
    expect(wrongType.status).toBe(400)
    expect(await count()).toBe(before)
  })

  it('confirm_new + new_reason creates once, keeps the reason, and a repeat confirm does not loop', async () => {
    const before = await count()
    const reason = 'landscape keyboard only, a separate fix from the portrait one'
    const body = { title: 'Fix the iOS keyboard layout bug', description: 'Rotate the phone.', confirm_new: true, new_reason: reason }
    const first = await post(body, worker.sid)
    expect(first.status).toBe(201)
    expect(await count()).toBe(before + 1)
    const stored = await getTask(first.json.task.id)
    expect(stored.description).toBe(`Rotate the phone.\n\nCreated as new work, not an existing open task: ${reason}`)
    // A confirmed create never meets the check again: the agent is not sent round in circles.
    const again = await post(body, worker.sid)
    expect(again.status).toBe(201)
    expect(await count()).toBe(before + 2)
  })

  it('a replay of the original payload after a confirmed create reuses it (the confirm is not in the fingerprint)', async () => {
    const ask = { title: 'iOS photo picker crash fix', idempotency_key: 'picker-fix-1' }
    const refused = await post(ask, worker.sid)
    expect(refused.status).toBe(409)
    const confirmed = await post({ ...ask, confirm_new: true, new_reason: 'the crash on rotation, a different bug' }, worker.sid)
    expect(confirmed.status).toBe(201)
    const before = await count()
    const replay = await post(ask, worker.sid)
    expect(replay.status).toBe(200)
    expect(replay.json.reused).toBe(true)
    expect(replay.json.task.id).toBe(confirmed.json.task.id)
    expect(await count()).toBe(before)
  })

  it('an idempotent retry of a create that happened is reused, not refused by its own first try', async () => {
    const body = { title: 'Ledger export totals', idempotency_key: 'ledger-export-1' }
    const first = await post(body, worker.sid)
    expect(first.status).toBe(201)
    const before = await count()
    const retry = await post(body, worker.sid)
    expect(retry.status).toBe(200)
    expect(retry.json.reused).toBe(true)
    expect(await count()).toBe(before)
  })
})

describe('the caller\'s own tree is never listed back', () => {
  it('an open grandparent above a COMPLETE parent is the work the caller serves, not a candidate', async () => {
    const top = (await addTask({ title: 'Quarterly ledger close', project: 'books' })).task
    const mid = (await addTask({ title: 'Ledger close first pass', project: 'books', parent_task_id: top.id })).task
    const leaf = (await addTask({ title: 'Ledger close second pass', project: 'books', parent_task_id: mid.id })).task
    await updateTask(mid.id, { phase: 'COMPLETE' })
    const sid = await session(leaf.id, 'books')
    const { status } = await post({ title: 'Quarterly ledger close checklist' }, sid)
    expect(status).toBe(201)
  })
})

describe('a task the brief names by id', () => {
  it('as a partner it is not listed back; taken over under its own title it is', async () => {
    const seed = (await addTask({ title: 'Seed tray watering schedule', project: 'garden' })).task
    const lead = (await addTask({ title: 'Greenhouse season plan', project: 'garden' })).task
    const sid = await session(lead.id, 'garden')
    const about = 'the seed tray watering schedule'
    // Without the id the brief reads as that work: refused, the schedule listed.
    const unnamed = await post({ title: 'Greenhouse sensor dashboard', description: `Coordinate with ${about}: show its readings.` }, sid)
    expect(unnamed.status).toBe(409)
    expect(unnamed.json.candidates.map((c: { id: string }) => c.id)).toContain(seed.id)
    // Named by id as other work: the session already knows it, so it is created.
    const named = await post({ title: 'Greenhouse sensor dashboard', description: `Coordinate with ${seed.id} (${about}): show its readings.` }, sid)
    expect(named.status).toBe(201)
    // Named by id under its own title ("take over X"): that is X's work, still refused.
    const takeOver = await post({ title: 'Seed tray watering schedule', description: `Take over ${seed.id}; its session stopped.` }, sid)
    expect(takeOver.status).toBe(409)
    expect(takeOver.json.candidates[0].id).toBe(seed.id)
  })
})

describe('humans and failures', () => {
  it('no caller header (the web console, the phone): the same title is created, never checked', async () => {
    const lookup = vi.fn(async () => { throw new Error('must not be called') })
    _injectRelatedLookupForTesting(lookup)
    const { status } = await post({ title: 'Fix the iOS keyboard layout bug' })
    expect(status).toBe(201)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('a lookup that throws fails open: created', async () => {
    _injectRelatedLookupForTesting(async () => { throw new Error('store busy') })
    const before = await count()
    const { status } = await post({ title: 'iOS photo picker crash again' }, worker.sid)
    expect(status).toBe(201)
    expect(await count()).toBe(before + 1)
  })

  it('a lookup that hangs fails open within the deadline: created', async () => {
    _injectRelatedLookupForTesting(() => new Promise(() => {}))
    const started = Date.now()
    const { status } = await post({ title: 'iOS photo picker crash twice' }, worker.sid)
    expect(status).toBe(201)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('WALNUT_RELATED_CHECK=0 turns the check off', async () => {
    process.env.WALNUT_RELATED_CHECK = '0'
    try {
      const { status } = await post({ title: 'iOS photo picker crash' }, worker.sid)
      expect(status).toBe(201)
    } finally {
      process.env.WALNUT_RELATED_CHECK = '1'
    }
  })
})

describe('the other ways a session creates a task', () => {
  it('the legacy POST /api/tasks with a caller header is checked; without one it is not', async () => {
    const before = await count()
    const refused = await post({ title: 'iOS photo picker crash', project: 'marina' }, worker.sid, '/api/tasks')
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('related_open_tasks')
    // Same-word look-alikes made above (fail-open, check off) are listed too; the original among them.
    expect(refused.json.candidates.map((c: { id: string }) => c.id)).toContain(photoId)
    expect(await count()).toBe(before)
    const human = await post({ title: 'iOS photo picker crash', project: 'marina' }, undefined, '/api/tasks')
    expect(human.status).toBe(201)
    const confirmed = await post({ title: 'iOS photo picker crash', project: 'marina', confirm_new: true, new_reason: 'the iPad picker, a different component' }, worker.sid, '/api/tasks')
    expect(confirmed.status).toBe(201)
    expect(confirmed.json.task.description).toContain('the iPad picker, a different component')
  })

  it('the task_create op answers with text a session can act on, and confirm goes through', async () => {
    const before = await count()
    const opts = { apiBase: `http://127.0.0.1:${port}`, callerSid: worker.sid, origin: '__local__' }
    const refused = await executeOp('task_create', { title: 'Keyboard layout broken on iOS', record_only: true }, opts)
    expect(refused.ok).toBe(false)
    const message = (refused as { message: string }).message
    expect(message).toContain('related_open_tasks')
    expect(message).toContain(subtaskId)
    expect(message).toContain('"Fix iOS keyboard layout"')
    expect(message).toContain('task_send')
    expect(message).toContain('"confirm_new": true')
    expect(await count()).toBe(before)
    const made = await executeOp('task_create', {
      title: 'Keyboard layout broken on iOS', record_only: true, confirm_new: true, new_reason: 'the external keyboard case, not the on-screen one',
    }, opts)
    expect(made.ok).toBe(true)
    expect(await count()).toBe(before + 1)
  })
})

/**
 * A normal team flow with the check ON: a lead files its workers (each brief ends with
 * the same standard paragraph), a long title meets the title brake, a worker files its
 * own subtask, and an ask files an errand. Distinct deliverables in one project: none
 * of them may be refused.
 */
describe('a normal multi-task session flow is never refused', () => {
  it('a lead, its workers and an ask create distinct work in one project', async () => {
    for (const t of ['Bakery logo refresh', 'Supplier invoices for October', 'Fix the till printer']) await addTask({ title: t, project: 'bakery' })
    const lead = (await addTask({ title: 'Bakery website launch', project: 'bakery' })).task
    const leadSid = await session(lead.id, 'bakery')
    const tail = 'Run the tests on the build box before landing. Reply to the lead with the commit.'
    const workers: Array<[string, string]> = [
      ['Menu page with prices', `Build the menu page from the price sheet. ${tail}`],
      ['Order form to the shop mailbox', `Wire the order form so each order reaches the shop mailbox. ${tail}`],
      ['Opening hours banner', `Show the opening hours at the top of every page. ${tail}`],
      ['Photo gallery of the cakes', `A gallery page with the cake photos. ${tail}`],
      ['Accessibility pass over every page of the bakery website before launch', ''],
    ]
    const made: string[] = []
    for (const [title, description] of workers) {
      const { status, json } = await post({ title, ...(description ? { description } : {}) }, leadSid)
      expect({ title, status, error: json.error?.code }).toEqual({ title, status: 201, error: undefined })
      made.push(json.task.id)
    }
    const menuSid = await session(made[0], 'bakery')
    const own = await post({ title: 'Price sheet import script', description: 'Read the price sheet into the menu data.' }, menuSid)
    expect(own.status).toBe(201)
    const errand = await post({ title: 'Book the bakery photographer', description: 'For the gallery photos.' }, askSid)
    expect(errand.status).toBe(201)
  })
})
