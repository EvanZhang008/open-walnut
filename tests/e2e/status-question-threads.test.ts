/**
 * The status side question keeps the task's threads current, on a real server with only the CLI
 * faked (src/core/sessions/status-threads.ts; 2026-11-20, the user: "also that side question will
 * also maintain the thread, also we prefer the thread instead of inbox"). Under the experiment
 * task_threads, a task with three threads (one it opened, two of the user's) is asked where each
 * stands; its answer says needs-you with no ask (the motivating case), one subject waiting on a
 * rollout, the other two done, and one new subject. Walnut closes the thread the task opened,
 * answers the user's finished one (he closes it), parks the waiting one as pending with its
 * progress, opens the new one, and the task reads Waiting on the rollout: not "It answered your
 * question", not Needs you.
 *
 * An answer that says its cards again (2026-11-26, the thread monitor: one answer wrote all 6
 * answered cards it was asked about anew, and his cards lost their detail and links): five cards
 * that hold, all five given a line with new words, keep what they said, while the hidden thread
 * of the same answer still moves; two of them in a later answer are results that moved on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-status-question-threads'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { askStatus, settleStatusQuestion } from '../../src/core/sessions/status-question.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'
import { threadsForEveryTask } from '../../src/core/org/keeps-threads.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const SID = 'status-threads-session'
let base = ''
let taskId = ''
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const OWN = 'th-c0ffee01'
const DONE = 'th-c0ffee02'
const ROLLOUT = 'th-c0ffee03'

function fixture(id: string): OrgThread[] {
  return [
    { id: OWN, title: 'Nightly greenhouse auto-push', titled: true, state: 'answered', messages: [], createdAt: ago(50), updatedAt: ago(50),
      opener: { text: 'I set up the nightly push of the greenhouse readings.', at: ago(50), from: 'node', by: `task:${id}` } },
    { id: DONE, title: 'Turn on the watering alerts', state: 'working', createdAt: ago(40), updatedAt: ago(40),
      messages: [{ id: 'tm-c0ffee02', at: ago(40), text: 'Please turn on the watering alerts', via: 'chat' }] },
    { id: ROLLOUT, title: 'Seed tray app rollout', state: 'working', createdAt: ago(30), updatedAt: ago(30),
      messages: [{ id: 'tm-c0ffee03', at: ago(30), text: 'Tell me when the new seed tray app is out everywhere', via: 'chat' }] },
  ]
}

/** The CLI, faked: it answers the side question by the refs the question listed. */
function fakeSession(answer: (prompt: string) => string) {
  const fake = { sessionId: SID, askSideQuestion: vi.fn(async (prompt: string) => answer(prompt)), detach: () => {}, kill: () => {}, get active() { return false } }
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.set(SID, fake)
  return fake
}

const refOf = (prompt: string, title: string): string => {
  const m = new RegExp(`(t\\d+) "${title}"`).exec(prompt)
  if (!m) throw new Error(`"${title}" is not in the question:\n${prompt}`)
  return m[1]
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { task_threads: true } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(() => expect(threadsForEveryTask()).toBe(true), { timeout: 5000 })
  taskId = (await addTask({ title: 'Watch the seed tray app rollout', project: 'Orchard' })).task.id
  await updateTaskRaw(taskId, { phase: 'IN_PROGRESS' }, { source: 'test' })
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${taskId}.json`), JSON.stringify({ version: 1, taskId, threads: fixture(taskId) }))
})

afterAll(async () => {
  await settleStatusQuestion(SID, 10_000)
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.delete(SID)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the status question keeps the threads', () => {
  it('asks each thread, writes the answers to them, and the task reads Waiting on the rollout', async () => {
    const fake = fakeSession((q) => [
      'FOR_USER_STATE: needs-you',
      'FOR_USER_ASK: none',
      'FOR_USER_NOW: The new app version rolls out region by region.',
      'FOR_USER_NEXT: I tell you when it is out everywhere.',
      `FOR_USER_THREAD: ${refOf(q, 'Seed tray app rollout')} | waiting | Half the regions have the new version.`,
      `FOR_USER_THREAD: ${refOf(q, 'Nightly greenhouse auto-push')} | done | The nightly push runs.`,
      `FOR_USER_THREAD: ${refOf(q, 'Turn on the watering alerts')} | done | The watering alerts are on.`,
      'FOR_USER_THREAD: t9 | working | No such thread.',
      'FOR_USER_THREAD_NEW: waiting | Compost delivery | The truck comes on Tuesday.',
    ].join('\n'))
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    const prompt = fake.askSideQuestion.mock.calls[0][0] as string
    expect(prompt).toContain('FOR_USER_THREAD: <ref>')

    const threads = (await readThreads(taskId)).threads
    const byId = new Map(threads.map((t) => [t.id, t]))
    // The thread the task opened itself ends closed.
    expect(byId.get(OWN)?.closed).toMatchObject({ by: `task:${taskId}` })
    // His own request is answered with where it stands; he closes it.
    expect(byId.get(DONE)).toMatchObject({ state: 'answered', reply: 'The watering alerts are on.', reply_by: `task:${taskId}` })
    expect(byId.get(DONE)?.closed).toBeUndefined()
    // The waiting one is pending, its progress as its summary.
    expect(byId.get(ROLLOUT)).toMatchObject({ state: 'pending', reply: 'Half the regions have the new version.' })
    expect(byId.get(ROLLOUT)?.closed).toBeUndefined()
    // The new subject is a thread of its own, opened by the task, in the task's own state.
    const added = threads.find((t) => t.title === 'Compost delivery')
    expect(added).toMatchObject({ state: 'pending', opener: { from: 'node', by: `task:${taskId}`, text: 'The truck comes on Tuesday.' } })
    // No line ever hands a thread to the user.
    expect(threads.filter((t) => t.state === 'needs')).toEqual([])

    const task = await getTask(taskId)
    expect(task.status_report).toMatchObject({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'Seed tray app rollout; Compost delivery', from_threads: true })
    // The lines went to the threads: they are not kept on the task.
    expect(task.status_report?.threads).toBeUndefined()
    expect(task.status_report?.threads_new).toBeUndefined()
    expect(task.phase).toBe('WAITING')

    await settleUserStatusSync()
    await syncUserStatuses(new Set([taskId]))
    const status = (await getTask(taskId)).user_status
    expect(status?.state).toBe('waiting')
    expect(status?.toRead).toBeUndefined()
  })

  it('the same answer again moves nothing: no thread change time moves', async () => {
    const before = (await readThreads(taskId)).threads.map((t) => [t.id, t.updatedAt])
    await updateTaskRaw(taskId, { phase: 'IN_PROGRESS' }, { source: 'test' })
    fakeSession((q) => [
      'FOR_USER_STATE: waiting',
      'FOR_USER_WAITING_ON: outside: the rollout',
      `FOR_USER_THREAD: ${refOf(q, 'Seed tray app rollout')} | waiting | Half the regions have the new version.`,
      `FOR_USER_THREAD: ${refOf(q, 'Turn on the watering alerts')} | done | The watering alerts are on.`,
    ].join('\n'))
    await settleStatusQuestion(SID, 10_000)
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    const after = (await readThreads(taskId)).threads.map((t) => [t.id, t.updatedAt])
    expect(after).toEqual(before)
  })
})

describe('an answer that says its cards again', () => {
  const BEDS = ['North bed', 'Herb spiral', 'Apple row', 'Pond edge', 'Tool shed']
  const cardId = (i: number) => `th-bed0000${i}`
  const SEEDS = 'th-5eed0001'
  let node = ''

  it('five held cards rewritten in one answer keep their words and their place; the hidden thread still moves', async () => {
    await settleStatusQuestion(SID, 10_000)
    node = (await addTask({ title: 'Look after the garden beds', project: 'Orchard' })).task.id
    await updateTaskRaw(node, { phase: 'IN_PROGRESS' }, { source: 'test' })
    const held: OrgThread[] = BEDS.map((bed, i) => ({
      id: cardId(i), title: bed, titled: true, state: 'answered', createdAt: ago(300 - i * 20), updatedAt: ago(290 - i * 20),
      messages: [{ id: `tm-bed0000${i}`, at: ago(300 - i * 20), text: `What is left to do at the ${bed.toLowerCase()}?`, via: 'chat', answer: { text: `Nothing: the ${bed.toLowerCase()} is finished.`, at: ago(295 - i * 20) } }],
      reply: `${bed}: finished on Monday, photo at /srv/garden/bed-${i}.png, the soil test is at https://garden.example/soil/${i}`,
      replyAt: ago(290 - i * 20), reply_by: `task:${node}`,
    }))
    const seeds: OrgThread = { id: SEEDS, title: 'Spring seeds', titled: true, state: 'working', createdAt: ago(20), updatedAt: ago(20),
      messages: [{ id: 'tm-5eed0001', at: ago(20), text: 'Order the seeds for spring', via: 'chat' }] }
    await fs.writeFile(path.join(WALNUT_HOME, 'org', 'threads', `${node}.json`), JSON.stringify({ version: 1, taskId: node, threads: [...held, seeds] }))
    const before = new Map((await readThreads(node)).threads.map((t) => [t.id, t]))

    const fake = fakeSession((q) => [
      'FOR_USER_STATE: waiting',
      'FOR_USER_WAITING_ON: outside: the seed shop',
      ...BEDS.map((bed) => `FOR_USER_THREAD: ${refOf(q, bed)} | answered | The ${bed.toLowerCase()} is all done.`),
      `FOR_USER_THREAD: ${refOf(q, 'Spring seeds')} | waiting | The shop ships the seeds on Friday.`,
    ].join('\n'))
    expect(await askStatus(node, SID, Date.now())).toBe(true)
    // The question quoted each card as one that holds: the rule was there, and the answer ignored it.
    const prompt = fake.askSideQuestion.mock.calls[0][0] as string
    for (const bed of BEDS) expect(prompt).toMatch(new RegExp(`"${bed}" \\(answered[^)]*card: "`))

    const after = new Map((await readThreads(node)).threads.map((t) => [t.id, t]))
    for (let i = 0; i < BEDS.length; i++) {
      expect(after.get(cardId(i))?.reply).toBe(before.get(cardId(i))?.reply)
      expect(after.get(cardId(i))?.replyAt).toBe(before.get(cardId(i))?.replyAt)
      expect(after.get(cardId(i))?.updatedAt).toBe(before.get(cardId(i))?.updatedAt)
    }
    expect(after.get(SEEDS)).toMatchObject({ state: 'pending', reply: 'The shop ships the seeds on Friday.' })
  })

  it('two of them in a later answer are results that moved on: written', async () => {
    await settleStatusQuestion(SID, 10_000)
    await updateTaskRaw(node, { phase: 'IN_PROGRESS' }, { source: 'test' })
    fakeSession((q) => [
      'FOR_USER_STATE: waiting',
      'FOR_USER_WAITING_ON: outside: the seed shop',
      `FOR_USER_THREAD: ${refOf(q, 'North bed')} | answered | The north bed was replanted after the frost: /srv/garden/bed-0-new.png`,
      `FOR_USER_THREAD: ${refOf(q, 'Apple row')} | answered | The apple row lost two trees to the storm; both are replaced.`,
    ].join('\n'))
    expect(await askStatus(node, SID, Date.now())).toBe(true)
    const byId = new Map((await readThreads(node)).threads.map((t) => [t.id, t]))
    expect(byId.get(cardId(0))?.reply).toBe('The north bed was replanted after the frost: /srv/garden/bed-0-new.png')
    expect(byId.get(cardId(2))?.reply).toBe('The apple row lost two trees to the storm; both are replaced.')
    expect(byId.get(cardId(1))?.reply).toContain('finished on Monday')
  })
})
