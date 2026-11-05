/**
 * The server-side brakes on a session multiplying itself through Walnut tasks
 * (core/sessions/subtask-limits.ts): a subtask chain at most MAX_SUBTASK_DEPTH
 * deep, and at most MAX_RUNNING_SUBTASKS of one task's subtasks running at once.
 *
 * Why in the server: a prompt line saying "don't fan out" is one routine edit
 * from deletion, and a session whose subtasks file subtasks has no natural stop.
 * Only work a SESSION creates or starts is limited; the human never is.
 *
 * Real startServer({ port: 0, dev: true }) with an isolated home and real session
 * records. No test here spawns a CLI: every start either is refused before the
 * spawn or goes through the exported check alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-subtask-limits'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask, listTasks, updateTaskRaw } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import {
  MAX_RUNNING_SUBTASKS, MAX_RUNNING_SUBTASKS_USER_ASKED, MAX_SUBTASK_DEPTH, SubtaskLimitError, admitSubtaskStart, assertSubtaskDepth, taskDepth,
} from '../../../src/core/sessions/subtask-limits.js'
import { admitStartWithinLimits } from '../../../src/core/sessions/task-start.js'

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`

let seq = 0
async function sessionFor(taskId: string, project: string): Promise<string> {
  seq += 1
  const sid = `22222222-3333-4444-5555-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, taskId, project, `/repo/${project}`, { title: `Session ${seq}` })
  return sid
}

/** top → d1 → … → d<levels>, all in `project`; returns the ids, top first. */
async function chain(project: string, levels: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i <= levels; i++) {
    const { task } = await addTask({
      title: i === 0 ? `Top ${project}` : `Level ${i} ${project}`, project,
      ...(i > 0 ? { parent_task_id: ids[i - 1] } : {}),
    })
    ids.push(task.id)
  }
  return ids
}

async function children(parentId: string, phases: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const [i, phase] of phases.entries()) {
    const { task } = await addTask({ title: `Child ${i} of ${parentId}`, project: 'fanout', parent_task_id: parentId })
    if (phase !== 'TODO') await updateTaskRaw(task.id, { phase: phase as never })
    ids.push(task.id)
  }
  return ids
}

async function createAs(sid: string | undefined, body: Record<string, unknown>) {
  const res = await fetch(api('/api/v1/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
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

describe('subtask depth', () => {
  it('counts levels below the top-level task', async () => {
    const ids = await chain('depth-count', 3)
    expect(await Promise.all(ids.map(taskDepth))).toEqual([0, 1, 2, 3])
    expect(MAX_SUBTASK_DEPTH).toBe(3)
  })

  it('stops a walk through a parent loop instead of spinning', async () => {
    const [a, b] = await chain('depth-loop', 1)
    // A corrupted store: a's parent is its own child.
    await updateTaskRaw(a, { parent_task_id: b })
    const depth = await taskDepth(a)
    expect(depth).toBeGreaterThan(0)
    expect(depth).toBeLessThanOrEqual(MAX_SUBTASK_DEPTH + 2)
  })

  it('a session at the last allowed level can still file one level down', async () => {
    const ids = await chain('depth-ok', 2)
    const sid = await sessionFor(ids[2], 'depth-ok')

    const { status, json } = await createAs(sid, { title: 'Level 3 work' })

    expect(status).toBe(201)
    expect(json.placement.parent_task_id).toBe(ids[2])
    expect(await taskDepth(json.task.id)).toBe(3)
  })

  it('a session already at the cap is refused with 409 subtask_too_deep, and nothing is filed', async () => {
    const ids = await chain('depth-cap', 3)
    const sid = await sessionFor(ids[3], 'depth-cap')
    const before = (await listTasks({})).length

    const { status, json } = await createAs(sid, { title: 'One level too deep' })

    expect(status).toBe(409)
    expect(json.error.code).toBe('subtask_too_deep')
    expect(json.error.message).toContain(`"Level 3 depth-cap" (${ids[3]}) is already a subtask 3 levels deep`)
    expect(json.error.message).toContain('Do this part here with your own tools')
    expect((await listTasks({})).length).toBe(before)
    // Naming another project does not escape it: the new task is still its subtask.
    const elsewhere = await createAs(sid, { title: 'Elsewhere', project: 'other-place', user_words: 'file it under other-place' })
    expect(elsewhere.status).toBe(409)
    expect(elsewhere.json.error.code).toBe('subtask_too_deep')
  })

  it('never limits the human: a create with no caller files a fifth level', async () => {
    const ids = await chain('depth-human', 3)
    const res = await fetch(api('/api/tasks'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Human-made level 4', project: 'depth-human', parent_task_id: ids[3] }),
    })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: { id: string } }
    expect((await getTask(task.id)).parent_task_id).toBe(ids[3])
  })

  it('the check itself is a typed 409', async () => {
    const ids = await chain('depth-typed', 3)
    const err = await assertSubtaskDepth(ids[3]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SubtaskLimitError)
    expect((err as SubtaskLimitError).statusCode).toBe(409)
    await expect(assertSubtaskDepth(ids[2])).resolves.toBeUndefined()
  })
})

describe('running subtasks', () => {
  it('counts only running children, never the task being started', async () => {
    const { task: parent } = await addTask({ title: 'Fan-out parent', project: 'fanout' })
    const running = await children(parent.id, Array(MAX_RUNNING_SUBTASKS - 1).fill('IN_PROGRESS'))
    await children(parent.id, ['NEED_ACTION', 'COMPLETE', 'TODO'])
    const [next] = await children(parent.id, ['TODO'])

    // Seven running: the eighth may start.
    const release = await admitSubtaskStart(parent.id, next)
    release()

    await updateTaskRaw(next, { phase: 'IN_PROGRESS' as never })
    // Eight running now, but a restart of one of them does not count itself.
    ;(await admitSubtaskStart(parent.id, next))()
    const [ninth] = await children(parent.id, ['TODO'])
    const err = await admitSubtaskStart(parent.id, ninth, 'Fan-out parent').catch((e: unknown) => e) as SubtaskLimitError
    expect(err).toBeInstanceOf(SubtaskLimitError)
    expect(err.code).toBe('too_many_running_subtasks')
    expect(err.message).toContain(`${MAX_RUNNING_SUBTASKS} subtasks of "Fan-out parent" are already running`)
    expect(err.message).toContain(`walnut wait ${running.slice(0, 3).join(' ')} --any`)
  })

  it('parallel starts at the limit admit exactly the free slots, and a settled start frees its slot', async () => {
    // Claude Code runs a turn's tool calls in parallel: ten task_create calls
    // arrive together, before any child is IN_PROGRESS on the board.
    const { task: parent } = await addTask({ title: 'Parallel parent', project: 'fanout' })
    await children(parent.id, Array(MAX_RUNNING_SUBTASKS - 2).fill('IN_PROGRESS'))
    const burst = await children(parent.id, Array(5).fill('TODO'))

    const outcomes = await Promise.allSettled(burst.map((id) => admitSubtaskStart(parent.id, id)))
    const admitted = outcomes.filter((o): o is PromiseFulfilledResult<() => void> => o.status === 'fulfilled')
    const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected')
    expect(admitted).toHaveLength(2)
    expect(refused).toHaveLength(3)
    for (const r of refused) expect((r.reason as SubtaskLimitError).code).toBe('too_many_running_subtasks')

    // While the two are still starting, a refused one retried is refused again.
    const [late, other] = burst.filter((_, i) => outcomes[i].status === 'rejected')
    await expect(admitSubtaskStart(parent.id, late)).rejects.toBeInstanceOf(SubtaskLimitError)
    // One start fails (never reaches IN_PROGRESS): its slot is free again, once.
    admitted[0].value()
    admitted[0].value()
    const again = await admitSubtaskStart(parent.id, late)
    await expect(admitSubtaskStart(parent.id, other)).rejects.toBeInstanceOf(SubtaskLimitError)
    again()
    admitted[1].value()
  })

  it('a refused admission holds nothing: the next parent and the same parent both proceed', async () => {
    const { task: busy } = await addTask({ title: 'Full parent', project: 'fanout' })
    const full = await children(busy.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const [a] = await children(busy.id, ['TODO'])
    const { task: calm } = await addTask({ title: 'Calm parent', project: 'fanout' })
    const [b] = await children(calm.id, ['TODO'])

    const [refusedA, admittedB] = await Promise.allSettled([admitSubtaskStart(busy.id, a), admitSubtaskStart(calm.id, b)])
    expect(refusedA.status).toBe('rejected')
    expect(admittedB.status).toBe('fulfilled')
    if (admittedB.status === 'fulfilled') admittedB.value()
    // Once one sibling finishes, the same parent admits again: the refusal left no lock or slot behind.
    await updateTaskRaw(full[0], { phase: 'NEED_ACTION' as never })
    ;(await admitSubtaskStart(busy.id, a))()
  })

  it('a worker session at the limit is queued by the start route (202), before any spawn', async () => {
    const { task: parent } = await addTask({ title: 'Busy worker', project: 'fanout' })
    await children(parent.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const [waiting] = await children(parent.id, ['TODO'])
    const sid = await sessionFor(parent.id, 'fanout')

    const res = await fetch(api(`/api/v1/tasks/${waiting}/start`), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': sid },
      body: JSON.stringify({ message: 'go' }),
    })

    // Queued, not refused (start-queue.ts): Walnut starts it once a slot frees.
    expect(res.status).toBe(202)
    const json = await res.json() as { started: boolean; queued?: { position: number; running: string[]; cap: number } }
    expect(json.started).toBe(false)
    expect(json.queued).toMatchObject({ position: 1, cap: MAX_RUNNING_SUBTASKS })
    expect(json.queued?.running).toHaveLength(MAX_RUNNING_SUBTASKS)
    // Queued before the start was recorded: no attempt, no session, the start kept on the task.
    const after = await getTask(waiting)
    expect(after.last_start).toBeUndefined()
    expect(after.session_id ?? undefined).toBeUndefined()
    expect(after.start_queue).toMatchObject({ parent_id: parent.id, caller_sid: sid, params: { message: 'go' } })
  })

  it('applies to worker sessions only: the human, an ask and an unknown caller are not limited', async () => {
    const { task: parent } = await addTask({ title: 'Ask-like parent', project: 'fanout' })
    await children(parent.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const [waiting] = await children(parent.id, ['TODO'])
    const target = await getTask(waiting)

    ;(await admitStartWithinLimits(target, undefined))()
    ;(await admitStartWithinLimits(target, 'not-a-session'))()

    const { task: ask } = await addTask({ title: 'Ask Walnut chat', project: 'Ask Walnut', walnut_agent: true })
    await children(ask.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const askSid = await sessionFor(ask.id, 'Ask Walnut')
    ;(await admitStartWithinLimits(target, askSid))()

    // The same shape from a worker is refused.
    const workerSid = await sessionFor(parent.id, 'fanout')
    await expect(admitStartWithinLimits(target, workerSid)).rejects.toBeInstanceOf(SubtaskLimitError)
  })
})

describe("whose cap: the started task's lead, whoever starts it", () => {
  // 2026-11-05: a helper task with no running subtasks of its own started a lead's queued subtask
  // while 18 of that lead's subtasks ran (cap 16), because the cap was counted on the starter.
  it("another task's session starting a full lead's subtask is held to the lead's cap, and queued under the lead", async () => {
    const { task: lead } = await addTask({ title: 'Full lead', project: 'fanout' })
    await children(lead.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const [waiting] = await children(lead.id, ['TODO'])
    const { task: helper } = await addTask({ title: 'Helper with nothing running', project: 'fanout' })
    const helperSid = await sessionFor(helper.id, 'fanout')

    const refused = await admitStartWithinLimits(await getTask(waiting), helperSid).catch((e: unknown) => e) as SubtaskLimitError
    expect(refused).toBeInstanceOf(SubtaskLimitError)
    expect(refused.detail).toMatchObject({ parentId: lead.id, cap: MAX_RUNNING_SUBTASKS })
    expect(refused.message).toContain('Full lead')

    const res = await fetch(api(`/api/v1/tasks/${waiting}/start`), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': helperSid },
      body: JSON.stringify({ message: 'go' }),
    })
    expect(res.status).toBe(202)
    const json = await res.json() as { started: boolean; queued?: { cap: number } }
    expect(json.started).toBe(false)
    expect(json.queued?.cap).toBe(MAX_RUNNING_SUBTASKS)
    expect((await getTask(waiting)).start_queue).toMatchObject({ parent_id: lead.id, caller_sid: helperSid })
  })

  it("the user's words raise the lead's cap to the higher one, from any starter", async () => {
    const { task: lead } = await addTask({ title: 'Lead past the plain cap', project: 'fanout' })
    const running = await children(lead.id, Array(MAX_RUNNING_SUBTASKS_USER_ASKED).fill('IN_PROGRESS'))
    const [waiting] = await children(lead.id, ['TODO'])
    const { task: helper } = await addTask({ title: 'Helper', project: 'fanout' })
    const helperSid = await sessionFor(helper.id, 'fanout')
    const words = 'please start this one now, I am waiting for it'
    await expect(admitStartWithinLimits(await getTask(waiting), helperSid, words)).rejects.toBeInstanceOf(SubtaskLimitError)
    await updateTaskRaw(running[0], { phase: 'NEED_ACTION' as never })
    ;(await admitStartWithinLimits(await getTask(waiting), helperSid, words))()
    // Without the words the lead's plain cap still holds it.
    await expect(admitStartWithinLimits(await getTask(waiting), helperSid)).rejects.toBeInstanceOf(SubtaskLimitError)
  })

  it('a lead that is an ask (Main) is never limited, and a task with no lead counts on its starter', async () => {
    const { task: ask } = await addTask({ title: 'Main-like ask', project: 'Ask Walnut', walnut_agent: true })
    await children(ask.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const [askChild] = await children(ask.id, ['TODO'])
    const { task: worker } = await addTask({ title: 'Busy worker of its own', project: 'fanout' })
    await children(worker.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const workerSid = await sessionFor(worker.id, 'fanout')
    ;(await admitStartWithinLimits(await getTask(askChild), workerSid))()

    const { task: loose } = await addTask({ title: 'No lead', project: 'fanout' })
    await expect(admitStartWithinLimits(await getTask(loose.id), workerSid)).rejects.toMatchObject({ detail: { parentId: worker.id } })
  })

  it("a transfer's new task takes its source's slot: one for one, never refused for the source", async () => {
    const { task: lead } = await addTask({ title: 'Lead at its cap', project: 'fanout' })
    const running = await children(lead.id, Array(MAX_RUNNING_SUBTASKS).fill('IN_PROGRESS'))
    const [moved] = await children(lead.id, ['TODO'])
    await updateTaskRaw(moved, { transferred_from: running[0] } as never)
    const workerSid = await sessionFor(running[0], 'fanout')
    ;(await admitStartWithinLimits(await getTask(moved), workerSid))()
    // Any other start under that lead is still held.
    const [other] = await children(lead.id, ['TODO'])
    await expect(admitStartWithinLimits(await getTask(other), workerSid)).rejects.toBeInstanceOf(SubtaskLimitError)
  })

  it('every admission counts on the lead: each call site, word for word', async () => {
    // A new call of admitSubtaskStart must count on the started task's lead too (and pass the
    // transfer's source); list it here once it does.
    const { execFileSync } = await import('node:child_process')
    const hits = execFileSync('git', ['grep', '-h', '-o', 'admitSubtaskStart([^;]*', '--', 'src'], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('admitSubtaskStart(\n')).sort()
    expect(hits.filter((h) => !/^admitSubtaskStart\($/.test(h))).toEqual([
      'admitSubtaskStart(lead.id, task.id, lead.title, { userAsked: !!quoted, replacing: task.transferred_from })',
      'admitSubtaskStart(leadOf(t), t.id, undefined, { userAsked, replacing: t.transferred_from })',
    ].sort())
  })
})
