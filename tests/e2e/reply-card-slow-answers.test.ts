/**
 * A reply's card line does not wait for the answers read (experiment threads_reply_tag;
 * src/core/org/reply-card.ts turnEndedWith, src/core/sessions/status-thread-carded.ts).
 *
 * On a server that keeps answers under his messages (org/thread-answers.ts reads the session's
 * transcript a moment after each turn), the write of the reply's card lines once came after that
 * read. Here the read is slow: every transcript read hangs for thirty seconds, as a busy host's
 * does. The turn ends with the event the runner emits; the status question the turn-complete hook
 * arms five seconds later must find the line written (the thread titled and answered) and leave the
 * thread out, while the answers read is still on its way and the reply is not under his message yet.
 * The isolated server, which has no answers job at all: tests/e2e/reply-card-real-flow.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

/** How long every transcript read hangs (0: not at all), how many reads waited, and the way to let them go (the test's end). */
const slow = vi.hoisted(() => ({ ms: 0, waited: 0, release: [] as Array<() => void> }))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-card-slow-answers'))
vi.mock('../../src/core/daemon-file-reader.js', async () => {
  const { mockLocalDaemonReader } = await import('../helpers/mock-local-daemon-reader.js')
  const real = mockLocalDaemonReader()
  class SlowReader extends real.DaemonFileReader {}
  const base = real.DaemonFileReader.prototype as unknown as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(base)) {
    const fn = base[name]
    if (name === 'constructor' || typeof fn !== 'function') continue
    ;(SlowReader.prototype as unknown as Record<string, unknown>)[name] = async function (this: unknown, ...args: unknown[]) {
      if (slow.ms) {
        slow.waited += 1
        await new Promise<void>((r) => { const t = setTimeout(r, slow.ms); t.unref?.(); slow.release.push(() => { clearTimeout(t); r() }) })
      }
      return (fn as (...a: unknown[]) => unknown).apply(this, args)
    }
  }
  return { ...real, DaemonFileReader: SlowReader }
})

import { CLAUDE_HOME, IS_EPHEMERAL, WALNUT_HOME } from '../../src/constants.js'
import { encodeProjectPath } from '../../src/core/session-history.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { markProcessing, removeProcessed } from '../../src/core/session-message-queue.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { replyTagNow } from '../../src/core/org/reply-card-switch.js'
import { settleStatusQuestion, STATUS_SETTLE_MS } from '../../src/core/sessions/status-question.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const SID = '5e55104a-0000-4000-8000-0000000510aa'
const READ_HANGS_MS = 30_000
let base = ''
let taskId = ''
const asked: Array<{ prompt: string; at: number; threads: OrgThread[]; readsWaiting: number }> = []

beforeAll(async () => {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { threads_reply_tag: true, threads_reminder: true } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(() => { expect(replyTagNow()).toBe(true) }, { timeout: 5000 })
  taskId = (await addTask({ title: 'Orchard plan helper', project: 'Orchard' })).task.id
  await createSessionRecord(SID, taskId, 'Orchard', WALNUT_HOME)
  await updateSessionRecord(SID, { process_status: 'idle' })
  await updateTaskRaw(taskId, { phase: 'IN_PROGRESS', session_id: SID }, { source: 'test' })
  const on = await fetch(`${base}/api/tasks/${taskId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threads_on: true }) })
  expect(on.status).toBe(200)
  const fake = {
    sessionId: SID, detach: () => {}, kill: () => {}, get active() { return false },
    askSideQuestion: async (prompt: string) => {
      asked.push({ prompt, at: Date.now(), threads: structuredClone((await readThreads(taskId)).threads), readsWaiting: slow.waited })
      return 'FOR_USER_STATE: working\nFOR_USER_NOW: Planning the orchard.'
    },
  }
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.set(SID, fake)
}, 40_000)

afterAll(async () => {
  slow.ms = 0
  for (const go of slow.release.splice(0)) go()
  delete process.env.WALNUT_THREAD_JOIN_SECS
  await settleStatusQuestion(SID, 10_000)
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.delete(SID)
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('an answers read that takes thirty seconds: the line is written and noted before the turn\'s status question', () => {
  it('the thread is titled and answered from the line, and left out of the question, while the read still runs', async () => {
    // This server keeps answers: the job that reads the transcript after each turn is running.
    expect(IS_EPHEMERAL).toBe(false)
    const sent = await fetch(`${base}/api/v1/sessions/${SID}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'How many apple trees fit in the north row?' }) })
    expect(sent.status).toBe(202)
    const rows = await markProcessing(SID)
    expect(rows).toHaveLength(1)
    const thread = /th-[0-9a-f]{6,32}/.exec(rows[0].message)![0]
    const reply = `Six, at four metres apart.\n\n<walnut-card thread="${thread}" state="answered" title="North row apple trees" summary="Six trees, four metres apart."/>`

    // The CLI wrote its transcript and answered the line; the runner emits the turn's result.
    const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(WALNUT_HOME))
    await fs.mkdir(dir, { recursive: true })
    const row = (n: number, type: 'user' | 'assistant', text: string) => JSON.stringify({
      type, uuid: `${SID.slice(0, 8)}-0000-4000-8000-00000000000${n}`, timestamp: new Date(Date.now() + n).toISOString(),
      message: type === 'user' ? { role: 'user', content: [{ type: 'text', text }] } : { id: `msg-${n}`, role: 'assistant', content: [{ type: 'text', text }] },
    })
    await fs.appendFile(path.join(dir, `${SID}.jsonl`), `${row(1, 'user', rows[0].message)}\n${row(2, 'assistant', reply)}\n`)
    await removeProcessed(SID, rows.map((r) => r.id))
    // From here every transcript read hangs.
    slow.ms = READ_HANGS_MS
    const endedAt = Date.now()
    bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, taskId, turnGen: 1, result: reply, isError: false, totalCost: 0.01, costDelta: 0.01, duration: 1200 }, ['main-ai', 'session-runner'], { source: 'session-runner' })

    await vi.waitFor(() => { expect(asked).toHaveLength(1) }, { timeout: 15_000, interval: 100 })
    const q = asked[0]
    // The question the hook armed, at its usual time: the slow read did not hold it.
    expect(q.at - endedAt).toBeGreaterThanOrEqual(STATUS_SETTLE_MS - 250)
    expect(q.at - endedAt).toBeLessThan(STATUS_SETTLE_MS + 4_000)
    // The answers read started and still hangs: the reply is not under his message.
    expect(q.readsWaiting).toBeGreaterThan(0)
    const t = q.threads.find((x) => x.id === thread)!
    expect(t.messages[0].answer).toBeUndefined()
    // The line was written all the same, and the question asks about no thread.
    expect(t).toMatchObject({ title: 'North row apple trees', titled: true, state: 'answered', reply: 'Six trees, four metres apart.', by: `task:${taskId}` })
    expect([...q.prompt.matchAll(/\bt\d+ "([^"]*)" \(/g)]).toEqual([])
    expect(q.prompt).not.toContain('North row apple trees')
  }, 60_000)
})
