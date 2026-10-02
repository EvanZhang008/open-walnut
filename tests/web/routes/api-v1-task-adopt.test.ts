/**
 * Adopt a task as a worker, and release it (PATCH /api/v1/tasks/:id with
 * `parent_task_id`).
 *
 * Real startServer({ port: 0, dev: true }) with an isolated home; callers are real
 * session records whose tasks sit in real chains. The one fake is the delivery
 * itself (deliverToSession), so no CLI is needed to see who the notice reaches.
 *
 * The contract pinned here:
 *   - anyone may adopt or release; the response carries `placement` when the
 *     link changed, and the task keeps its project;
 *   - an unknown leader is 404 parent_not_found, the task itself 400 self_parent,
 *     a leader inside the task's own subtree 409 circular_parent, and a refusal
 *     writes nothing (not even a description sent in the same PATCH);
 *   - a SESSION caller meets the depth brake for the whole adopted subtree; the
 *     human never does;
 *   - the adopted task's own live session hears `adopted` / `released`; a task
 *     with no live session, the caller's own session and the leader hear nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-task-adopt'))

interface Delivered { sid: string; text: string; source: string; taskId?: string }
const delivered: Delivered[] = []
vi.mock('../../../src/core/sessions/session-send-core.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/sessions/session-send-core.js')>()
  return {
    ...real,
    deliverToSession: vi.fn(async (target: { claudeSessionId: string }, opts: { busText: string; source: string; taskId?: string }) => {
      delivered.push({ sid: target.claudeSessionId, text: opts.busText, source: opts.source, taskId: opts.taskId })
      return { delivery: 'queued' as const, messageId: `qm-test-${delivered.length}` }
    }),
  }
})

// Every notice attempt's result, so a test can wait for the one its PATCH started.
type NoticeResult = import('../../../src/core/sessions/adopt-notice.js').AdoptNoticeResult
const noticeResults: NoticeResult[] = []
vi.mock('../../../src/core/sessions/adopt-notice.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/sessions/adopt-notice.js')>()
  return {
    ...real,
    notifyAdoptedTask: vi.fn(async (n: Parameters<typeof real.notifyAdoptedTask>[0]) => {
      const r = await real.notifyAdoptedTask(n)
      noticeResults.push(r)
      return r
    }),
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`

async function patch(id: string, body: unknown, sid?: string): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(api(`/api/v1/tasks/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

let seq = 0
async function task(title: string, opts: { project?: string; parent?: string } = {}): Promise<string> {
  const { task: t } = await addTask({
    title, project: opts.project ?? 'adopt', ...(opts.parent ? { parent_task_id: opts.parent } : {}),
  })
  return t.id
}

async function sessionFor(taskId: string, status: 'running' | 'idle' | 'stopped' = 'running'): Promise<string> {
  seq += 1
  const sid = `33333333-4444-5555-6666-${String(seq).padStart(12, '0')}`
  const t = await getTask(taskId)
  await createSessionRecord(sid, taskId, t.project ?? '', `/repo/${t.project || 'inbox'}`, {
    title: t.title, initialProcessStatus: status,
  })
  return sid
}

/** Wait for the notice attempt the last PATCH started and return its result. */
async function nextNotice(before: number): Promise<NoticeResult> {
  await vi.waitFor(() => expect(noticeResults.length).toBeGreaterThan(before), { timeout: 5_000 })
  return noticeResults[before]
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  delivered.length = 0
})

describe('the human adopts and releases', () => {
  it('adopts an existing task from another project: linked, placement, project kept', async () => {
    const leader = await task('Close the quarter')
    const imported = await task('Imported invoice', { project: 'acme' })
    const { status, json } = await patch(imported, { parent_task_id: leader })
    expect(status).toBe(200)
    expect(json.task.id).toBe(imported)
    expect(json.task.project).toBe('acme')
    expect(json.placement).toEqual({ parent_task_id: leader, parent_title: 'Close the quarter' })
    const stored = await getTask(imported)
    expect(stored.parent_task_id).toBe(leader)
    expect(stored.project).toBe('acme')
  })

  it('accepts a unique id prefix for the leader and stores the full id', async () => {
    const leader = await task('Prefix leader')
    const worker = await task('Prefix worker')
    const { status, json } = await patch(worker, { parent_task_id: leader.slice(0, 10) })
    expect(status).toBe(200)
    expect(json.placement.parent_task_id).toBe(leader)
    expect((await getTask(worker)).parent_task_id).toBe(leader)
  })

  it('releases it: "" clears the link and names the old leader', async () => {
    const leader = await task('Release leader')
    const worker = await task('Release worker', { parent: leader })
    const { status, json } = await patch(worker, { parent_task_id: '' })
    expect(status).toBe(200)
    expect(json.placement).toEqual({
      parent_task_id: '', previous_parent_task_id: leader, previous_parent_title: 'Release leader',
    })
    expect((await getTask(worker)).parent_task_id).toBeUndefined()
  })

  it('moves a worker to another leader and names both', async () => {
    const first = await task('First leader')
    const second = await task('Second leader')
    const worker = await task('Moving worker', { parent: first })
    const { json } = await patch(worker, { parent_task_id: second })
    expect(json.placement).toEqual({
      parent_task_id: second, parent_title: 'Second leader',
      previous_parent_task_id: first, previous_parent_title: 'First leader',
    })
  })

  it('re-sending the leader it already has changes nothing and carries no placement', async () => {
    const leader = await task('Same leader')
    const worker = await task('Same worker', { parent: leader })
    await sessionFor(worker)
    const before = noticeResults.length
    const { status, json } = await patch(worker, { parent_task_id: leader })
    expect(status).toBe(200)
    expect(json.placement).toBeUndefined()
    expect(json.task.id).toBe(worker)
    const loose = await task('Loose task')
    const released = await patch(loose, { parent_task_id: '' })
    expect(released.status).toBe(200)
    expect(released.json.placement).toBeUndefined()
    // Give a stray notice the chance to show up before saying there was none.
    await new Promise((r) => setTimeout(r, 200))
    expect(noticeResults.length).toBe(before)
    expect(delivered).toEqual([])
  })
})

describe('refusals', () => {
  it('a non-string parent_task_id is 400 bad_request', async () => {
    const worker = await task('Typed worker')
    const { status, json } = await patch(worker, { parent_task_id: 42 })
    expect(status).toBe(400)
    expect(json.error.code).toBe('bad_request')
  })

  it('an unknown leader is 404 parent_not_found, and nothing in the PATCH is written', async () => {
    const worker = await task('Orphan worker')
    const { status, json } = await patch(worker, { parent_task_id: 'no-such-task-id', description: 'Should not land' })
    expect(status).toBe(404)
    expect(json.error.code).toBe('parent_not_found')
    const stored = await getTask(worker)
    expect(stored.parent_task_id).toBeUndefined()
    expect(stored.description ?? '').not.toContain('Should not land')
  })

  it('an unknown task is 404 not_found', async () => {
    const leader = await task('Leader of nothing')
    const { status, json } = await patch('no-such-task-id', { parent_task_id: leader })
    expect(status).toBe(404)
    expect(json.error.code).toBe('not_found')
  })

  it('the task itself is 400 self_parent', async () => {
    const worker = await task('Self worker')
    const { status, json } = await patch(worker, { parent_task_id: worker })
    expect(status).toBe(400)
    expect(json.error.code).toBe('self_parent')
  })

  it('a leader inside the task\'s own subtree is 409 circular_parent', async () => {
    const a = await task('Cycle A')
    const b = await task('Cycle B', { parent: a })
    const c = await task('Cycle C', { parent: b })
    const direct = await patch(a, { parent_task_id: b })
    expect(direct.status).toBe(409)
    expect(direct.json.error.code).toBe('circular_parent')
    const deep = await patch(a, { parent_task_id: c })
    expect(deep.status).toBe(409)
    expect(deep.json.error.code).toBe('circular_parent')
    expect((await getTask(a)).parent_task_id).toBeUndefined()
  })
})

describe('the depth brake holds for a session, never for the human', () => {
  it('a worker two levels deep cannot adopt a task that has its own subtask', async () => {
    const top = await task('Brake top')
    const one = await task('Brake level 1', { parent: top })
    const two = await task('Brake level 2', { parent: one })
    const callerSid = await sessionFor(two)
    const adopted = await task('Has a child')
    await task('The child', { parent: adopted })

    const refused = await patch(adopted, { parent_task_id: two }, callerSid)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('subtask_too_deep')
    expect((await getTask(adopted)).parent_task_id).toBeUndefined()

    // A leaf fits (2 + 1 = 3 levels).
    const leaf = await task('A leaf')
    expect((await patch(leaf, { parent_task_id: two }, callerSid)).status).toBe(200)

    // The same adoption from the human goes through.
    const human = await patch(adopted, { parent_task_id: two })
    expect(human.status).toBe(200)
    expect((await getTask(adopted)).parent_task_id).toBe(two)
  })
})

describe('the adopted task\'s session is told', () => {
  it('its session hears "adopted" mid-turn; the leader\'s session hears nothing', async () => {
    const leader = await task('Quarter close')
    const leaderSid = await sessionFor(leader)
    const worker = await task('Invoice import')
    const workerSid = await sessionFor(worker, 'running')
    const before = noticeResults.length

    const { status } = await patch(worker, { parent_task_id: leader }, leaderSid)
    expect(status).toBe(200)
    expect(await nextNotice(before)).toEqual({ delivered: true, sessionId: workerSid, delivery: 'queued' })
    expect(delivered).toHaveLength(1)
    const [d] = delivered
    expect(d.sid).toBe(workerSid)
    expect(d.source).toBe('walnut-notify')
    expect(d.taskId).toBe(worker)
    expect(d.text).toMatch(/^<walnut-message kind="notification" from="Walnut"/)
    expect(d.text).toContain(`about-task="${leader}"`)
    expect(d.text).toContain('outcome="adopted"')
    expect(d.text).toContain(`Your task is now a worker of "Quarter close" (${leader}). A message from that task ending in `
      + '"Reply when done" is its session\'s; the reply it names is how your result gets back. Walnut tells it when you '
      + 'stop, complete, hit an error or wait on the user.')
    expect(delivered.some((x) => x.sid === leaderSid)).toBe(false)
  })

  it('its live session hears "released" naming the old leader', async () => {
    const leader = await task('Old leader')
    const worker = await task('Released worker', { parent: leader })
    const workerSid = await sessionFor(worker)
    const before = noticeResults.length

    expect((await patch(worker, { parent_task_id: '' })).status).toBe(200)
    expect((await nextNotice(before)).delivered).toBe(true)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].sid).toBe(workerSid)
    expect(delivered[0].text).toContain('outcome="released"')
    expect(delivered[0].text).toContain(`Your task no longer has a leader; "Old leader" (${leader}) released it.`)
  })

  it('a task with no session hears nothing', async () => {
    const leader = await task('Quiet leader')
    const worker = await task('No session worker')
    const before = noticeResults.length
    expect((await patch(worker, { parent_task_id: leader })).status).toBe(200)
    expect(await nextNotice(before)).toEqual({ delivered: false, reason: 'no_running_session' })
    expect(delivered).toEqual([])
  })

  it.each(['idle', 'stopped'] as const)('a %s session is not woken for it', async (status) => {
    // Adopting is bookkeeping: a turn spent on "this is only a notice" is the
    // whole cost (2026-10-02: five idle workers each woke to say exactly that).
    // The session reads the link from its task when it next runs.
    const leader = await task('Sleeping leader')
    const worker = await task(`${status} worker`)
    await sessionFor(worker, status)
    const before = noticeResults.length
    expect((await patch(worker, { parent_task_id: leader })).status).toBe(200)
    expect(await nextNotice(before)).toEqual({ delivered: false, reason: 'no_running_session' })
    expect(delivered).toEqual([])
  })

  it('the caller\'s own session is not told what it just did', async () => {
    const leader = await task('Joined leader')
    const worker = await task('Joining worker')
    const workerSid = await sessionFor(worker)
    const before = noticeResults.length
    // The worker's own session puts its task under a leader.
    expect((await patch(worker, { parent_task_id: leader }, workerSid)).status).toBe(200)
    expect(await nextNotice(before)).toEqual({ delivered: false, reason: 'caller_session' })
    expect(delivered).toEqual([])
  })
})
