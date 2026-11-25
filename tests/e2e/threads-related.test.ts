/**
 * Related threads beside a new one, on a real server (experiment threads_related,
 * src/core/org/thread-related.ts; 2026-11-25, the user: "It should do a fuzzy match, or go through
 * a vector database, and attach the related threads; the agent decides").
 *
 * A task below the Garden lead keeps Threads; the lead holds an open thread on the orchard fence.
 * His message to the task, sent the phone's way (POST /api/v1/sessions/:id/messages), opens a new
 * thread there:
 *   - off: the threads hint is today's, byte for byte;
 *   - on: the hint names the lead's thread as related, and whose it is;
 *   - on, with a slow embedder, a failing one and one with no worker running: the message is still
 *     filed and sent, in time, and a model with no worker running is never asked.
 * Only the CLI is mocked (no CLI runs: the messages wait in the queue).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-threads-related'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { getQueue } from '../../src/core/session-message-queue.js'
import { readThreads, writeThreadsFor } from '../../src/core/org/threads-store.js'
import { setShortTextEmbedderForTests, type ShortTextEmbedder } from '../../src/core/search/short-text-vectors.js'
import { RELATED_DEADLINE_MS } from '../../src/core/org/thread-related.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const SID = '77777777-6666-4777-8888-000000000001'
const FENCE = 'th-0fe11ce00001'
let base = ''
let leadId = ''
let taskId = ''

async function setRelated(on: boolean): Promise<void> {
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { threads_related: on } }) })
  expect(put.status).toBe(200)
}

/** His message as the phone sends it; the threads hint it reached the session with. */
async function send(text: string): Promise<{ hint: string; threadId: string; ms: number }> {
  const started = Date.now()
  const res = await fetch(`${base}/api/v1/sessions/${SID}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
  const ms = Date.now() - started
  expect(res.status, await res.clone().text()).toBe(202)
  const row = (await getQueue(SID)).find((m) => m.message.includes(text))
  expect(row, 'his message is queued for the session').toBeTruthy()
  const m = /Walnut \(threads\): (filed as new thread (th-[a-f0-9]+)\.[^\n]*)/.exec(row!.message)
  expect(m, row!.message).toBeTruthy()
  return { hint: m![1], threadId: m![2], ms }
}

beforeAll(async () => {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  leadId = (await ensureProjectLead('Garden')).id
  taskId = (await addTask({ title: 'Fence repair', project: 'Garden', parent_task_id: leadId })).task.id
  await updateTaskRaw(taskId, { threads_on: true, phase: 'IN_PROGRESS' } as never, { source: 'test' })
  await createSessionRecord(SID, taskId, 'Garden', WALNUT_HOME)
  await updateSessionRecord(SID, { process_status: 'stopped' })
  const at = new Date(Date.now() - 3600_000).toISOString()
  const fence: OrgThread = {
    id: FENCE, title: 'Orchard fence posts', titled: true, state: 'needs', reply: 'Replace the two leaning posts? I recommend oak.', replyAt: at,
    createdAt: at, updatedAt: at, by: `task:${leadId}`,
    messages: [{ id: 'tm-0fe11ce00001', at, text: 'The posts by the orchard gate lean', via: 'chat' }],
  } as OrgThread
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${leadId}.json`), JSON.stringify({ version: 1, taskId: leadId, threads: [fence] }))
}, 60_000)

afterAll(async () => {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  setShortTextEmbedderForTests(undefined)
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('related threads beside his new thread', () => {
  it('off: the threads hint is today\'s, byte for byte', async () => {
    await setRelated(false)
    const { hint, threadId } = await send('The orchard fence posts lean again after the rain')
    // The task had no open thread: today's line for a new thread, nothing after it.
    expect(hint).toBe(`filed as new thread ${threadId}. Give it a short title (thread_update).`)
  })

  it('on: the hint names the lead\'s open thread on that subject, and whose it is', async () => {
    await setRelated(true)
    const { hint, threadId } = await send('Two more orchard fence posts are leaning by the gate')
    expect(hint).toContain(` Related threads (its subject is one of yours: thread_update {"id":"${threadId}","merge_into":"<id>"}`)
    expect(hint).toContain(`${FENCE} "Orchard fence posts" (needs, on "Garden`)
    expect(hint).toContain(leadId)
    // Advice only: nothing merged, his message is its own new thread.
    const mine = (await readThreads(taskId)).threads.find((t) => t.id === threadId)
    expect(mine?.messages[0].text).toBe('Two more orchard fence posts are leaning by the gate')
    expect((await readThreads(leadId)).threads.map((t) => t.id)).toEqual([FENCE])
  })

  it('on: a task finished this week offers its closed thread apart, never its leftover open one', async () => {
    const done = (await addTask({ title: 'Compost corner', project: 'Garden', parent_task_id: leadId })).task.id
    const day = new Date(Date.now() - 24 * 3600_000).toISOString()
    await updateTaskRaw(done, { threads_on: true, phase: 'COMPLETE', completed_at: day } as never, { source: 'test' })
    const closed = { id: 'th-0c0b0570e001', title: 'Compost bin lid cracked', titled: true, state: 'answered', createdAt: day, updatedAt: day, by: `task:${done}`, messages: [{ id: 'tm-0c0b0570e001', at: day, text: 'The compost bin lid is cracked', via: 'chat' }], closed: { how: 'acked', at: day, by: 'human' } } as unknown as OrgThread
    const leftover = { id: 'th-0c0b0570e002', title: 'Compost bin lid hinge', state: 'working', createdAt: day, updatedAt: day, by: `task:${done}`, messages: [{ id: 'tm-0c0b0570e002', at: day, text: 'The compost bin lid hinge is loose', via: 'chat' }] } as unknown as OrgThread
    // Through the store (its cache and lock): the server already read this task's empty Threads.
    await writeThreadsFor(done, (cur) => ({ file: { ...cur, threads: [closed, leftover] }, out: null }))
    expect((await readThreads(done)).threads).toHaveLength(2)
    const { hint } = await send('The compost bin lid cracked again in the frost')
    expect(hint).toContain(' Related, closed this week (no merge: a new ask about it stays its own thread; read it, and say on the new card that it continues it): th-0c0b0570e001 "Compost bin lid cracked" (on "Compost corner"')
    expect(hint).not.toContain('th-0c0b0570e002')
  })

  it('on, with a slow, a failing and an idle embedder: his message is filed and sent, in time, and an idle model is never asked', async () => {
    const up = () => ({ query: true, passage: true })
    const slow: ShortTextEmbedder = {
      model: 'slow-model', running: up,
      query: () => new Promise((r) => setTimeout(() => r(Int8Array.from([1, 0])), 10_000)),
      passages: (texts) => new Promise((r) => setTimeout(() => r(texts.map(() => Int8Array.from([1, 0]))), 10_000)),
    }
    const failing: ShortTextEmbedder = {
      model: 'failing-model', running: up,
      query: async () => { throw new Error('model gone') },
      passages: async () => { throw new Error('model gone') },
    }
    let asked = 0
    const idle: ShortTextEmbedder = {
      model: 'idle-model', running: () => ({ query: false, passage: false }),
      query: async () => { asked++; return null },
      passages: async () => { asked++; return [] },
    }
    for (const [embedder, text] of [[slow, 'The orchard fence gate hinge squeaks'], [failing, 'Which oak posts should replace the leaning ones'], [idle, 'Replace the leaning ones with oak this week']] as const) {
      setShortTextEmbedderForTests(embedder)
      const { hint, threadId, ms } = await send(text)
      expect(ms).toBeLessThan(RELATED_DEADLINE_MS + 4_000)
      // The words lane still names the lead's thread.
      expect(hint).toContain(FENCE)
      await vi.waitFor(async () => expect((await readThreads(taskId)).threads.find((t) => t.id === threadId)?.messages[0].text).toBe(text), { timeout: 5_000 })
    }
    // No worker running: the model was never asked (no worker is started for this).
    expect(asked).toBe(0)
  })
})
