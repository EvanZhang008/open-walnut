/**
 * His words switch a task's Threads, on a real server (src/core/org/threads-word-switch.ts,
 * thread-capture.ts prepareThreadCapture). 2026-11-21, the user in the Interview task: "你不要再回复
 * 这个 thread 了，就回复我就好了"; the next message was filed as a new thread all the same, and the
 * agent was told to title it. Now:
 *
 *   1. his order turns Threads off (the ⋮ menu's same switch): that message is not filed, the agent
 *      is told what Walnut did and how he undoes it, and no cleanup line rides with it;
 *   2. while off, his messages file nothing and carry no threads hint;
 *   3. "开回 thread" turns them back on, and his next message is filed again;
 *   4. Main's and a lead's Threads are the org's: the same words there are filed as any message.
 * Only the Claude CLI is mocked (no CLI runs: the messages wait in the queue).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-threads-word-switch'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask, getTask } from '../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'
import { prepareHintedSend } from '../../src/core/hints/hint-send.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { threadsSwitchedText } from '../../src/core/org/threads-word-switch.js'

const TASK_SID = '77777777-6666-4777-8888-999999999a01'
const LEAD_SID = '77777777-6666-4777-8888-999999999a02'
const ORDER = '你不要再回复这个 thread 了，就回复我就好了。'
let base = ''
let taskId = ''
let leadId = ''

/** The web send's own steps (routes/session-chat.ts): hints composed, queued, then committed. */
async function typeInto(sid: string, text: string): Promise<string> {
  const record = await getSessionByClaudeId(sid)
  const prepared = await prepareHintedSend(sid, record, text, { sentBy: 'person' })
  await sendMessageToSession(sid, text, { source: 'ui', taskId: record?.taskId, enqueueMessage: prepared.enqueueText, hinted: true })
  await prepared.commit()
  return prepared.enqueueText
}

const hintOf = (text: string) => /Walnut \(threads\):([\s\S]*?)<\/system-reminder>/.exec(text)?.[1]?.trim() ?? ''
const tidyOf = (text: string) => /Walnut \(threads-tidy\)/.test(text)
const texts = async (id: string) => (await readThreads(id)).threads.flatMap((t) => t.messages.map((m) => m.text))

beforeAll(async () => {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  taskId = (await addTask({ title: 'Interview prep', project: 'Orchard' })).task.id
  await fetch(`${base}/api/tasks/${taskId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threads_on: true }) })
  await createSessionRecord(TASK_SID, taskId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(TASK_SID, { process_status: 'stopped' })
  leadId = (await ensureProjectLead('Orchard')).id
  await createSessionRecord(LEAD_SID, leadId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(LEAD_SID, { process_status: 'stopped' })
})

afterAll(async () => {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('his words switch a task\'s Threads', () => {
  it('on: his first question is filed as a thread', async () => {
    expect((await getTask(taskId)).threads_on).toBe(true)
    expect(hintOf(await typeInto(TASK_SID, 'how do interviews expect rate limiting?'))).toMatch(/new thread th-/)
    expect(await texts(taskId)).toEqual(['how do interviews expect rate limiting?'])
  })

  it('his order turns them off: not filed, the agent is told what happened and how to undo, no cleanup line', async () => {
    const sent = await typeInto(TASK_SID, ORDER)
    expect(hintOf(sent)).toBe(threadsSwitchedText('off'))
    expect(tidyOf(sent)).toBe(false)
    expect((await getTask(taskId)).threads_on).toBe(false)
    expect(await texts(taskId)).toEqual(['how do interviews expect rate limiting?'])
  })

  it('while off, his messages file nothing and carry no threads hint', async () => {
    for (const words of ['and Istio?', 'what about the database layer?']) {
      const sent = await typeInto(TASK_SID, words)
      expect(hintOf(sent)).toBe('')
      expect(tidyOf(sent)).toBe(false)
    }
    expect(await texts(taskId)).toEqual(['how do interviews expect rate limiting?'])
  })

  it('"开回 thread" turns them back on, and his next message is filed again', async () => {
    expect(hintOf(await typeInto(TASK_SID, '开回 thread 吧'))).toBe(threadsSwitchedText('on'))
    expect((await getTask(taskId)).threads_on).toBe(true)
    expect(await texts(taskId)).toEqual(['how do interviews expect rate limiting?'])
    expect(hintOf(await typeInto(TASK_SID, 'one more: caching?'))).toMatch(/thread th-/)
    expect(await texts(taskId)).toContain('one more: caching?')
  })

  it('a lead\'s Threads are the org\'s: the same words are filed there as any message', async () => {
    const sent = await typeInto(LEAD_SID, ORDER)
    expect(hintOf(sent)).not.toBe(threadsSwitchedText('off'))
    expect(await texts(leadId)).toContain(ORDER)
  })
})
