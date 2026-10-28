/**
 * A message that never reaches its session is reported as not delivered, never
 * as a turn that ended.
 *
 * 2026-10-28: a lead's task_send and then task_start to a stopped session on a
 * remote host were both refused by the daemon's one-CLI-per-session guard (the
 * user had `claude -r <sid>` open in a terminal on that host). The server put
 * the message back to be retried on every reconnect, the task was handed back
 * as if a turn had ended, and the request watch told the asker "Its turn ended
 * WITHOUT an explicit reply", quoting the session's message from 3.5 hours
 * before as if it were the answer. The session was 108 MB, which looked like
 * the cause but was not; the large-transcript case below pins that a session
 * that size still resumes and answers.
 *
 * What's real: server, WS, bus, queue, request store, hooks, user status.
 * Mocked: constants, the daemon (MockDaemon: the cli-owner refusal envelope),
 * the CLI (mock-claude.mjs, and a wrapper that dies while resuming).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-undelivered'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getQueue, resetCache, unparkMessage } from '../../src/core/session-message-queue.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

let server: Server
let daemon: MockDaemon
let port: number
let asker: { taskId: string; sid: string }

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const REFUSAL = 'start: this session already has a running CLI (pid 4087, started by a process no Walnut daemon recorded); not started a second time. Send to it through its owner, or retry once it has ended'
const SESSION_LIVE = { errorKind: 'session_live', reason: 'session_live', code: 'SESSION_LIVE' }

async function startOn(title: string): Promise<{ taskId: string; sid: string }> {
  const taskId = (await addTask({ title, project: 'Test' })).task.id
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project: 'Test', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
  return { taskId, sid }
}

/** The CLI is gone (Walnut's idle reap), as the incident's was. */
async function reaped(sid: string): Promise<void> {
  daemon.simulateDeath(sid, 0)
  await updateSessionRecord(sid, { process_status: 'stopped' })
}

async function ask(toTask: string, text: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': asker.sid },
    body: JSON.stringify({ to: toTask, text, expect_reply: true }),
  })
  expect(res.status).toBe(202)
  return ((await res.json()) as { requestId: string }).requestId
}

async function requestOf(id: string): Promise<{ status: string; outcome?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/requests/${id}`)
  return ((await res.json()) as { request: { status: string; outcome?: string } }).request
}

/**
 * Every distinct Walnut notice that reached the asker about request `id`. A cold
 * resume carries one line in its `start` and may write it again with `send`.
 */
function noticesFor(id: string): string[] {
  return [...new Set([...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
    .filter((c) => c.payload.sid === asker.sid)
    .map((c) => String(c.payload.message ?? ''))
    .filter((m) => m.includes(`request="${id}"`) && m.includes('kind="notification"')))]
}

/**
 * Every distinct Walnut notice about task `childId` for session `sid` (a parent's
 * subtask notices): sent to its CLI, or queued for its next turn (a `stopped`
 * notice to an idle parent waits there, it does not wake it).
 */
async function subtaskNoticesTo(sid: string, childId: string): Promise<string[]> {
  resetCache()
  return [...new Set([
    ...[...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
      .filter((c) => c.payload.sid === sid).map((c) => String(c.payload.message ?? '')),
    ...daemon.getFifoWrites().filter((w) => w.sid === sid).map((w) => w.message),
    ...(await getQueue(sid)).map((m) => m.message),
  ].filter((m) => m.includes('kind="notification"') && m.includes(childId) && !m.includes('request="')))]
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  asker = await startOn('Asking lead')
}, 120_000)

// Each case stands alone: a fault one leaves (it failed partway) never reaches the next.
afterEach(() => {
  daemon.injectStartFault(null)
  daemon.setCliCommand(MOCK_CLI)
})

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the host refuses the session (another CLI holds it)', () => {
  it('parks the message, tells the asker it was not delivered, and hands the task back with the cause', async () => {
    const parent = await startOn('Held elsewhere lead')
    // A lead mid-turn hears every edge of its subtasks, a "stopped" one included
    // (an idle one would only be woken for completed and error).
    await updateSessionRecord(parent.sid, { process_status: 'running' })
    const target = await startOn('Held elsewhere')
    await updateTaskRaw(target.taskId, { parent_task_id: parent.taskId }, { source: 'test' })
    await reaped(target.sid)
    // It had parked itself, as the real one had.
    await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${target.taskId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': target.sid },
      body: JSON.stringify({ phase: 'WAITING' }),
    })
    daemon.injectStartFault(REFUSAL, SESSION_LIVE)
    const startsBefore = daemon.getCommandHistoryFor('start').filter((c) => c.payload.sid === target.sid).length
    const rq = await ask(target.taskId, 'The CRD call is settled: go ahead.')

    // The asker hears at once that nothing was delivered, and why. No quote.
    await vi.waitFor(() => expect(noticesFor(rq)).toHaveLength(1), { timeout: 20_000 })
    const notice = noticesFor(rq)[0]
    // Plain words: the user is in it, the task is fine, the message waits.
    expect(notice).toContain('NOT BEEN DELIVERED yet')
    expect(notice).toContain('most likely the user working in it in a terminal')
    expect(notice).toContain('has this session open in a terminal right now (Claude Code pid 4087')
    expect(notice).toContain('The task is fine, not broken.')
    expect(notice).toContain('Do not move the work elsewhere or close the task.')
    expect(notice).not.toContain('Its turn ended')
    expect(notice).not.toContain('its last message')
    expect(await requestOf(rq)).toMatchObject({ status: 'notified', outcome: 'error' })

    // The message is kept (parked with the cause), not retried in a loop.
    resetCache()
    const queue = await getQueue(target.sid)
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ status: 'parked' })
    expect(queue[0].parkedReason).toMatch(/^Not delivered yet: the user \(or someone\) has this session open in a terminal right now \(Claude Code pid 4087/)

    // The task waits on the user, and says what to fix; the session is stopped, not "running".
    await vi.waitFor(async () => expect((await getTask(target.taskId))?.phase).toBe('NEED_ACTION'), { timeout: 10_000 })
    await syncUserStatuses(new Set([target.taskId]))
    const status = (await getTask(target.taskId)) as { user_status?: { state: string; ask?: string } }
    expect(status.user_status?.state).toBe('needs')
    expect(status.user_status?.ask).toMatch(/^The user \(or someone\) has its session open in a terminal right now \(Claude Code pid 4087 on this machine\), so a message to it waits\. The task is fine/)
    const rec = await getSessionByClaudeId(target.sid)
    expect(rec?.process_status).toBe('stopped')
    expect(rec?.status_reason).toBe('message_not_delivered')
    // Kept on the record, so a handoff leaves the task open (transfer/source-in-use.ts).
    await vi.waitFor(async () => expect((await getSessionByClaudeId(target.sid))?.heldElsewhere).toMatchObject({ host: '__local__', pid: 4087, holder: 'terminal' }))

    // The health monitor's next pass must not turn it into a "turn ended" or a death:
    // one start only, and the phase stays where the refusal put it.
    await new Promise((r) => setTimeout(r, 35_000))
    expect(daemon.getCommandHistoryFor('start').filter((c) => c.payload.sid === target.sid).length - startsBefore).toBe(1)
    expect(noticesFor(rq)).toHaveLength(1)
    expect((await getSessionByClaudeId(target.sid))?.process_status).toBe('stopped')
    // Its lead is not told it failed: the user is working in it, nothing is broken.
    // (Its own park above told it "waiting"; nothing since says it stopped or failed.)
    expect((await subtaskNoticesTo(parent.sid, target.taskId)).join('\n')).not.toMatch(/outcome="(stopped|error)"/)

    // Once the other process is gone, Retry delivers the same row and the session answers.
    daemon.injectStartFault(null)
    expect(await unparkMessage(target.sid, queue[0].id)).toBe(true)
    bus.emit(EventNames.SESSION_SEND, { sessionId: target.sid, taskId: target.taskId, message: queue[0].message }, ['session-runner'], { source: 'web-ui-retry' })
    await vi.waitFor(async () => {
      resetCache()
      expect(await getQueue(target.sid)).toEqual([])
      expect(daemon.getCommandHistoryFor('start').filter((c) => c.payload.sid === target.sid && c.payload.resume)
        .some((c) => String(c.payload.message ?? '').includes('The CRD call is settled'))
        || daemon.getFifoWrites().some((w) => w.sid === target.sid && w.message.includes('The CRD call is settled'))).toBe(true)
    }, { timeout: 30_000 })
  }, 150_000)
})

describe('the resumed CLI exits before it reads the message', () => {
  it('keeps the message (parked with the CLI\'s words) and tells the asker it was not delivered', async () => {
    const parent = await startOn('Cannot resume lead')
    // A lead between turns hears its subtasks (a stopped one is never woken).
    await updateSessionRecord(parent.sid, { process_status: 'idle' })
    const victim = await startOn('Cannot resume')
    await updateTaskRaw(victim.taskId, { parent_task_id: parent.taskId }, { source: 'test' })
    const wrapper = path.join(WALNUT_HOME, 'die-on-resume.mjs')
    // Only this session's resume dies; every other CLI (the asker's) is the normal mock.
    await fs.writeFile(wrapper, [
      `if (process.argv.includes('--resume') && process.argv.includes(${JSON.stringify(victim.sid)})) {`,
      `  process.stderr.write('Error: could not load the conversation\\n'); process.exit(1)`,
      '}',
      `await import(${JSON.stringify(MOCK_CLI)})`,
    ].join('\n'))
    daemon.setCliCommand(wrapper)
    try {
      await reaped(victim.sid)
      const rq = await ask(victim.taskId, 'Second decision.')
      await vi.waitFor(() => expect(noticesFor(rq)).toHaveLength(1), { timeout: 20_000 })
      const notice = noticesFor(rq)[0]
      expect(notice).toContain('NOT DELIVERED')
      expect(notice).toContain('exited with code 1 while resuming this session')
      expect(notice).not.toContain('It hit an ERROR before replying')

      resetCache()
      const queue = await getQueue(victim.sid)
      expect(queue.map((m) => m.status)).toEqual(['parked'])
      expect(queue[0].parkedReason).toContain('could not load the conversation')
      await vi.waitFor(async () => expect((await getTask(victim.taskId))?.phase).toBe('NEED_ACTION'), { timeout: 10_000 })
      await syncUserStatuses(new Set([victim.taskId]))
      const status = (await getTask(victim.taskId)) as { user_status?: { ask?: string } }
      expect(status.user_status?.ask).toMatch(/^A message to it was not delivered: Claude Code exited with code 1/)
      // Its lead hears it errored, with the cause, and is not handed an older turn's words.
      await vi.waitFor(async () => expect((await subtaskNoticesTo(parent.sid, victim.taskId)).length).toBeGreaterThan(0), { timeout: 20_000 })
      const toLead = (await subtaskNoticesTo(parent.sid, victim.taskId)).join('\n')
      expect(toLead).toContain('outcome="error"')
      expect(toLead).toContain('could not load the conversation')
      expect(toLead).not.toContain('its last message')
    } finally {
      daemon.setCliCommand(MOCK_CLI)
    }
  }, 120_000)
})

describe('a 110 MB session', () => {
  it('resumes, takes the message and answers; the notice quotes the new turn, not the old one', async () => {
    const big = await startOn('Big session')
    // The CLI's own transcript, at the size of the incident's (108 MB), ending in an
    // old answer the asker must never be handed as the reply.
    const dir = path.join(os.homedir(), '.claude', 'projects', WALNUT_HOME.replace(/[^a-zA-Z0-9]/g, '-'))
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${big.sid}.jsonl`)
    const filler = 'x'.repeat(10_000)
    const rows: string[] = []
    let parent: string | null = null
    for (let i = 0; i < 11_000; i++) {
      const uuid = randomUUID()
      rows.push(JSON.stringify({
        type: i % 2 ? 'assistant' : 'user', uuid, parentUuid: parent, sessionId: big.sid, cwd: WALNUT_HOME,
        timestamp: new Date(Date.now() - (11_000 - i) * 1000).toISOString(),
        message: i % 2
          ? { id: `msg_${i}`, role: 'assistant', content: [{ type: 'text', text: i === 10_999 ? 'OLD ANSWER FROM HOURS AGO' : filler }] }
          : { role: 'user', content: filler },
      }))
      parent = uuid
    }
    await fs.writeFile(file, rows.join('\n') + '\n')
    expect((await fs.stat(file)).size).toBeGreaterThan(100 * 1024 * 1024)

    await reaped(big.sid)
    // The resumed CLI files its turn in that transcript, as Claude Code does.
    process.env.MOCK_CLAUDE_PERSIST_DIR = path.join(os.homedir(), '.claude', 'projects')
    process.env.MOCK_CLAUDE_PERSIST_SESSIONS = big.sid
    try {
      const rq = await ask(big.taskId, 'Third decision.')
      await vi.waitFor(async () => {
        resetCache()
        expect(await getQueue(big.sid)).toEqual([])
        expect(noticesFor(rq)).toHaveLength(1)
      }, { timeout: 45_000 })
      expect(await requestOf(rq)).toMatchObject({ status: 'notified', outcome: 'completed' })
      const notice = noticesFor(rq)[0]
      expect(notice).toContain('Its turn ended WITHOUT an explicit reply')
      expect(notice).toContain('--- its last message')
      expect(notice).not.toContain('NOT DELIVERED')
      expect(notice).not.toContain('OLD ANSWER FROM HOURS AGO')
    } finally {
      delete process.env.MOCK_CLAUDE_PERSIST_DIR
      delete process.env.MOCK_CLAUDE_PERSIST_SESSIONS
      // The fixture sits in the account's own Claude Code store: never leave 110 MB there.
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
