/**
 * Threads on a task that is no Org node, once the user turns them on (Task.threads_on,
 * src/core/org/keeps-threads.ts; 2026-11-18, the user, about a leader task whose asks piled up in
 * one chat: "we should be able to enable the thread for a leader, default off ... click the more
 * and select to open"). On a real server:
 *
 *   1. off by default: the leader's chat files nothing, its Threads routes refuse, its prompt
 *      carries no Threads rules;
 *   2. the switch (PATCH /api/tasks/:id threads_on) stores it; a bad value is refused;
 *   3. on: his message is filed as a thread and tells the leader which one, the routes answer,
 *      the leader keeps the thread with thread_update, and its prompt carries the rules;
 *   4. naming the thread when handing work to its worker lists the worker and keeps the thread
 *      on the leader (no node above takes it);
 *   5. off again: nothing more is filed, the routes refuse, the rules leave the prompt;
 *   6. a running session hears the rules the moment they are turned on, and that they are gone when
 *      turned off (a versioned block); a thread waiting on him holds its worker's close only while on;
 *   7. while on, a thread waiting on him makes the task read Needs you, the away state is kept for it
 *      (away hint, away inbox thread, phone buzz) and the buzz opens the task's Threads; off, none;
 *   8. on or off, his words are also kept as the asks it owes (user-asks.ts): its close guard and
 *      compaction readback read them there.
 * Only the Claude CLI is mocked (no CLI runs: the messages wait in the queue).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-threads-on'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask, getTask } from '../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'
import { prepareHintedSend } from '../../src/core/hints/hint-send.js'
import { handOffThread } from '../../src/core/org/thread-follow.js'
import { TASK_THREADS_LINE, defaultInstructions } from '../../src/core/sessions/session-context.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import { readUserAsks } from '../../src/core/sessions/user-asks.js'
import { patchThread } from '../../src/core/org/threads-store.js'
import { threadWaitItems } from '../../src/core/sessions/owed-waits.js'
import { instructionNoticeFor } from '../../src/core/sessions/instruction-notice.js'
import { listTasks } from '../../src/core/task-manager.js'
import { readStatusFacts, statusInputOf } from '../../src/core/user-status-sync.js'
import { deriveUserStatus } from '../../src/core/user-status.js'
import { userAwayFrom } from '../../src/core/org/user-away.js'
import { threadPushContent } from '../../src/core/push/thread-push.js'

const LEADER_SID = '77777777-6666-4777-8888-999999999991'
let base = ''
let leaderId = ''
let workerId = ''

/** The web send's own steps (routes/session-chat.ts): hints composed, queued, then committed. */
async function typeIntoChat(text: string): Promise<string> {
  const record = await getSessionByClaudeId(LEADER_SID)
  const prepared = await prepareHintedSend(LEADER_SID, record, text, { sentBy: 'person' })
  await sendMessageToSession(LEADER_SID, text, { source: 'ui', taskId: record?.taskId, enqueueMessage: prepared.enqueueText, hinted: true })
  await prepared.commit()
  return prepared.enqueueText
}

const hintOf = (text: string) => /Walnut \(threads\):([\s\S]*?)<\/system-reminder>/.exec(text)?.[1] ?? ''

async function setThreads(value: unknown): Promise<Response> {
  return fetch(`${base}/api/tasks/${leaderId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threads_on: value }) })
}

async function threadsRes(): Promise<Response> {
  return fetch(`${base}/api/v1/tasks/${leaderId}/threads`)
}

beforeAll(async () => {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  leaderId = (await addTask({ title: 'Greenhouse care', project: 'Orchard' })).task.id
  workerId = (await addTask({ title: 'Check the vents', project: 'Orchard', parent_task_id: leaderId })).task.id
  await createSessionRecord(LEADER_SID, leaderId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(LEADER_SID, { process_status: 'stopped' })
})

afterAll(async () => {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('Threads on a leader task', () => {
  it('are off by default: nothing filed, routes refuse, no rules in the prompt', async () => {
    const leader = await getTask(leaderId)
    expect(leader.threads_on).toBeUndefined()
    expect(hintOf(await typeIntoChat('how are the seedlings doing?'))).toBe('')
    expect((await threadsRes()).status).toBe(409)
    expect(defaultInstructions(leader)).not.toContain(TASK_THREADS_LINE.trim())
  })

  it('the switch stores it, and refuses a value that is no boolean', async () => {
    expect((await setThreads('yes')).status).toBe(400)
    expect((await setThreads(true)).status).toBe(200)
    expect((await getTask(leaderId)).threads_on).toBe(true)
  })

  let filed: OrgThread
  it('on: his message is filed as a thread, the leader is told, keeps it, and has the rules', async () => {
    const sent = await typeIntoChat('the greenhouse humidity reading: what is it?')
    expect(hintOf(sent)).toMatch(/thread/i)
    const res = await threadsRes()
    expect(res.status).toBe(200)
    const list = ((await res.json()) as { threads: OrgThread[] }).threads
    expect(list).toHaveLength(1)
    filed = list[0]
    expect(filed.messages?.[0]?.text).toContain('humidity reading')
    // The leader keeps it with thread_update's route, as its own session.
    const upd = await fetch(`${base}/api/v1/tasks/${leaderId}/threads/${filed.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': LEADER_SID },
      body: JSON.stringify({ title: 'Greenhouse humidity', state: 'working' }),
    })
    expect(upd.status).toBe(200)
    const prompt = defaultInstructions(await getTask(leaderId))
    expect(prompt).toContain(TASK_THREADS_LINE.trim())
    expect(prompt).toContain('thread_update')
  })

  it('a thread named when handing work to its worker lists the worker and stays on the leader', async () => {
    const out = await handOffThread({ callerSid: LEADER_SID, target: workerId, threadId: filed.id })
    expect(out?.refused).toBeUndefined()
    expect(out?.moved).toEqual([])
    expect(out?.linked.map((l) => l.id)).toEqual([filed.id])
    const list = ((await (await threadsRes()).json()) as { threads: OrgThread[] }).threads
    const t = list.find((x) => x.id === filed.id)!
    expect(t.closed ?? null).toBeNull()
    expect(t.tasks).toContain(workerId)
  })

  let spawnedOff = ''
  let spawnedOn = ''
  it('a thread waiting on him holds the worker while on, and a session spawned off hears the rules', async () => {
    await patchThread(leaderId, filed.id, { state: 'needs', user_kind: 'user_own', user_kind_why: 'He asked to pick the watering plan himself' }, `task:${leaderId}`)
    const worker = await getTask(workerId)
    expect((await threadWaitItems(worker, await listTasks(), false)).map((w) => w.id)).toEqual([filed.id])
    const leader = await getTask(leaderId)
    spawnedOn = defaultInstructions(leader)
    spawnedOff = defaultInstructions({ ...leader, threads_on: undefined })
    const notice = instructionNoticeFor({ appliedAppendSystemPrompt: spawnedOff, engine: 'claude-code' } as never, leader, { ignoreTold: false })
    expect(notice).toContain("Threads, the user's setting for your task")
  })

  async function statusNow() {
    const all = await listTasks()
    const leader = all.find((t) => t.id === leaderId)!
    return deriveUserStatus(statusInputOf(leader, await readStatusFacts([leader], all.map((t) => t.id))))
  }

  // The slow-pass line names which source a slow pass waited on (user-status-sync.ts readMs).
  it('says how long each fact source took to read', async () => {
    const all = await listTasks()
    const leader = all.find((t) => t.id === leaderId)!
    const facts = await readStatusFacts([leader], all.map((t) => t.id))
    for (const source of ['sessions', 'undelivered', 'letters', 'approvals', 'choices', 'requests', 'triggers', 'schedules', 'checks', 'threads']) {
      expect(facts.readMs?.[source]).toBeGreaterThanOrEqual(0)
    }
  })

  it('while on, a thread waiting on him reads Needs you, and the away and buzz paths take the task', async () => {
    const s = await statusNow()
    expect(s.state).toBe('needs')
    expect(s.source).toBe('thread')
    expect(s.ask).toContain('Greenhouse humidity')
    const leader = await getTask(leaderId)
    expect(await userAwayFrom(leader)).not.toBeNull()
    const push = threadPushContent({ id: filed.id, title: 'Greenhouse humidity' }, leader)
    expect(push.data?.url).toBe(`/tasks/${leaderId}?view=threads`)
  })

  it('off again: nothing more is filed, routes refuse, the rules leave the prompt', async () => {
    expect((await setThreads(false)).status).toBe(200)
    const leader = await getTask(leaderId)
    // Kept as said (2026-11-19): off stays off when the experiment task_threads gives every task Threads.
    expect(leader.threads_on).toBe(false)
    expect(hintOf(await typeIntoChat('and the compost bin order?'))).toBe('')
    expect((await threadsRes()).status).toBe(409)
    expect(defaultInstructions(leader)).not.toContain(TASK_THREADS_LINE.trim())
    // Its thread is on no screen now: it holds the worker no more, asks him nothing, buzzes nothing.
    expect((await statusNow()).source).not.toBe('thread')
    expect(await userAwayFrom(leader)).toBeNull()
    expect(await threadWaitItems(await getTask(workerId), await listTasks(), false)).toEqual([])
    // A session spawned while on hears they are gone.
    const gone = instructionNoticeFor({ appliedAppendSystemPrompt: spawnedOn, engine: 'claude-code' } as never, leader, { ignoreTold: false })
    expect(gone).not.toBeNull()
    expect(spawnedOff).not.toContain('thread_update')
  })

  it('keeps his words as the asks it owes, on or off', async () => {
    // The writes are not awaited by the send (hint-send.ts commit): wait for the third.
    await expect.poll(async () => (await readUserAsks(leaderId)).asks.map((a) => a.text), { timeout: 5000 })
      .toEqual(['how are the seedlings doing?', 'the greenhouse humidity reading: what is it?', 'and the compost bin order?'])
  })
})
