/**
 * A session whose working folder is gone keeps working (src/core/sessions/folder-gone.ts).
 *
 * 2026-10-30: a task's session ran in a notes folder the user later reorganized away. A
 * peer task's message to it was parked as "Working directory no longer exists", Retry
 * failed the same way, and nothing offered a way on, although Claude Code had the
 * conversation. Now the refusal records the gone folder, and continuing moves the
 * conversation to the task's own directory (never recreating the old folder) and sends
 * what waited; with the history gone too, a new conversation for the task carries it.
 *
 * What's real: server, routes, queue, records, task dirs, the transcript files (under the
 * test's fake HOME). Mocked: constants, the daemon (MockDaemon), the CLI (mock-claude.mjs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-folder-gone'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getQueue, resetCache, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { getCronService } from '../../src/web/routes/cron.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../src/core/session-file-reader.js'
import { localClaudeProjectsDir } from '../../src/core/claude-config-dir.js'
import { localTaskDirRoot } from '../../src/core/sessions/task-dir-place.js'
import { sendWhereFoldersCameBack } from '../../src/core/sessions/folder-back.js'

let server: Server
let daemon: MockDaemon
let port: number
let scratch: string

const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${p}`, init)
const post = (p: string) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

async function startIn(title: string, cwd: string): Promise<{ taskId: string; sid: string }> {
  const taskId = (await addTask({ title, project: 'Test' })).task.id
  const sid = (await sessionRunner.startSession({ taskId, cwd, message: 'Ready', project: 'Test', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
  daemon.simulateDeath(sid, 0)
  await updateSessionRecord(sid, { process_status: 'stopped' })
  return { taskId, sid }
}

/** The conversation Claude Code keeps for `sid` in `cwd`'s project dir, with a subagent beside it. */
async function writeTranscript(sid: string, cwd: string): Promise<string> {
  const dir = path.join(localClaudeProjectsDir(), encodeProjectPath(cwd))
  await fs.mkdir(path.join(dir, sid, 'subagents'), { recursive: true })
  await fs.writeFile(path.join(dir, sid, 'subagents', 'agent-a.jsonl'), '{}\n')
  const file = path.join(dir, `${sid}.jsonl`)
  await fs.writeFile(file, JSON.stringify({ type: 'user', cwd, sessionId: sid, message: { role: 'user', content: 'remember PINEAPPLE' } }) + '\n')
  return file
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false)

/** Every line that reached `sid`'s CLI after the `since` mark: a resume's start line, a send, a FIFO write. */
function linesTo(sid: string, since: { start: number; send: number; fifo: number }): Array<{ cwd?: string; message: string }> {
  return [
    ...daemon.getCommandHistoryFor('start').slice(since.start).filter((c) => c.payload.sid === sid).map((c) => ({ cwd: c.payload.cwd as string, message: String(c.payload.message ?? '') })),
    ...daemon.getCommandHistoryFor('send').slice(since.send).filter((c) => c.payload.sid === sid).map((c) => ({ message: String(c.payload.message ?? '') })),
    ...daemon.getFifoWrites().slice(since.fifo).filter((w) => w.sid === sid).map((w) => ({ message: w.message })),
  ]
}
const mark = () => ({ start: daemon.getCommandHistoryFor('start').length, send: daemon.getCommandHistoryFor('send').length, fifo: daemon.getFifoWrites().length })

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-folder-gone-'))
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.rm(scratch, { recursive: true, force: true })
})

describe('the folder is gone, the conversation is not', () => {
  it('parks the message, records the gone folder, and continues in the task directory with the history', async () => {
    const oldCwd = path.join(scratch, 'Projects', 'garden')
    await fs.mkdir(oldCwd, { recursive: true })
    const { taskId, sid } = await startIn('Garden planner', oldCwd)
    await updateTaskRaw(taskId, { cwd: oldCwd }, { source: 'test' })
    const transcript = await writeTranscript(sid, oldCwd)
    await fs.rm(path.join(scratch, 'Projects'), { recursive: true, force: true })

    // The message the incident lost: refused on the folder, kept, and the folder recorded.
    await sendMessageToSession(sid, 'Please send me the planting list', { source: 'user' })
    await vi.waitFor(async () => {
      resetCache()
      const rows = await getQueue(sid)
      expect(rows.map((m) => m.status)).toEqual(['parked'])
      expect(rows[0].parkedReason).toMatch(/Working directory no longer exists/)
      expect((await getSessionByClaudeId(sid))?.cwdGone).toMatchObject({ cwd: oldCwd, history: 'found' })
    }, { timeout: 15_000 })
    const taskDir = path.join(localTaskDirRoot(), taskId)
    expect((await getSessionByClaudeId(sid))?.cwdGone?.newCwd).toBe(taskDir)
    // The session is not left claiming it runs (the start never happened).
    await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.process_status).not.toBe('running'), { timeout: 10_000 })

    // Retry no longer spawns into the gone folder: it answers with the way on.
    const retry = await post(`/api/sessions/${sid}/retry`)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ status: 'folder_gone', sessionId: sid, cwdGone: { cwd: oldCwd, history: 'found' } })
    // Restart says the same instead of failing in the spawn.
    const restart = await post(`/api/sessions/${sid}/restart`)
    expect(restart.status).toBe(409)
    expect(await restart.json()).toMatchObject({ code: 'folder_gone' })

    const startsBefore = mark()
    const res = await post(`/api/sessions/${sid}/continue-in-new-folder`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'continued', sessionId: sid, cwd: taskDir, from: oldCwd, history: 'kept', sent: 1 })

    // The conversation moved to where the CLI looks for the new folder; the old folder was not made again.
    // The CLI names a project dir by the folder's real path (the temp dir is a symlink on macOS).
    const realTaskDir = await fs.realpath(taskDir)
    const moved = path.join(localClaudeProjectsDir(), encodeProjectPath(realTaskDir), `${sid}.jsonl`)
    expect(await exists(moved)).toBe(true)
    expect(await exists(transcript)).toBe(false)
    expect(await exists(path.join(localClaudeProjectsDir(), encodeProjectPath(realTaskDir), sid, 'subagents', 'agent-a.jsonl'))).toBe(true)
    expect(await exists(oldCwd)).toBe(false)

    const record = await getSessionByClaudeId(sid)
    expect(record?.cwd).toBe(taskDir)
    expect(record?.cwdGone).toBeUndefined()
    expect(record?.folderMoved).toMatchObject({ from: oldCwd, to: taskDir, told: true })
    const task = await getTask(taskId)
    expect(task.cwd).toBe(taskDir)
    expect(task.cwd_missing).toBeFalsy()

    // The waiting message goes out in the new folder, as a resume of the same session, the notice first.
    await vi.waitFor(() => {
      const start = daemon.getCommandHistoryFor('start').slice(startsBefore.start).find((c) => c.payload.sid === sid)
      expect(start).toBeDefined()
      expect(start!.payload.cwd).toBe(taskDir)
      expect((start!.payload.args as string[]).join(' ')).toContain(`--resume ${sid}`)
      // A cold resume writes its first line in the start or right after the init.
      const msg = linesTo(sid, startsBefore).map((l) => l.message).find((m) => m.includes('Please send me the planting list'))
      expect(msg).toContain('outcome="folder-moved"')
      expect(msg).toContain(`Your working folder ${oldCwd} no longer exists`)
      expect(msg!.indexOf('outcome="folder-moved"')).toBeLessThan(msg!.indexOf('Please send me the planting list'))
    }, { timeout: 15_000 })
    await vi.waitFor(async () => { resetCache(); expect(await getQueue(sid)).toEqual([]) }, { timeout: 15_000 })

    // Told once: the next message carries no second notice.
    const before = mark()
    await sendMessageToSession(sid, 'And one more thing', { source: 'user' })
    await vi.waitFor(() => {
      const lines = linesTo(sid, before)
      expect(lines.some((l) => l.message.includes('And one more thing'))).toBe(true)
      expect(lines.some((l) => l.message.includes('outcome="folder-moved"'))).toBe(false)
    }, { timeout: 15_000 })

    // Pressing the button again is refused: the folder it runs in is there.
    const again = await post(`/api/sessions/${sid}/continue-in-new-folder`)
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ code: 'folder_present' })
  }, 90_000)

  it('a session moved with nothing waiting tells its next message, once', async () => {
    const oldCwd = path.join(scratch, 'quiet')
    await fs.mkdir(oldCwd, { recursive: true })
    const { sid } = await startIn('Quiet one', oldCwd)
    await writeTranscript(sid, oldCwd)
    await fs.rm(oldCwd, { recursive: true, force: true })
    const res = await post(`/api/sessions/${sid}/continue-in-new-folder`)
    expect(await res.json()).toMatchObject({ status: 'continued', sent: 0 })
    expect((await getSessionByClaudeId(sid))?.folderMoved?.told).toBeFalsy()
    const before = mark()
    await sendMessageToSession(sid, 'hello again', { source: 'user' })
    await vi.waitFor(() => {
      const lines = linesTo(sid, before)
      const line = lines.find((l) => l.message.includes('hello again'))
      expect(line?.message).toContain('outcome="folder-moved"')
    }, { timeout: 15_000 })
    await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.folderMoved?.told).toBe(true), { timeout: 10_000 })
  }, 60_000)
})

describe('the folder and the history are both gone', () => {
  it('starts a new conversation for the task in its directory, carrying what waited', async () => {
    const oldCwd = path.join(scratch, 'vanished')
    await fs.mkdir(oldCwd, { recursive: true })
    const { taskId, sid } = await startIn('History lost', oldCwd)
    await fs.rm(oldCwd, { recursive: true, force: true })
    await sendMessageToSession(sid, 'Where is the review?', { source: 'user' })
    await vi.waitFor(async () => {
      expect((await getSessionByClaudeId(sid))?.cwdGone).toMatchObject({ cwd: oldCwd, history: 'missing' })
    }, { timeout: 15_000 })

    const before = daemon.getCommandHistoryFor('start').length
    const res = await post(`/api/sessions/${sid}/continue-in-new-folder`)
    expect(res.status).toBe(200)
    const taskDir = path.join(localTaskDirRoot(), taskId)
    expect(await res.json()).toMatchObject({ status: 'started', oldSessionId: sid, taskId, cwd: taskDir, history: 'fresh', carried: 1 })
    await vi.waitFor(() => {
      const start = daemon.getCommandHistoryFor('start').slice(before).find((c) => c.payload.sid !== sid)
      expect(start).toBeDefined()
      expect(start!.payload.cwd).toBe(taskDir)
      const msg = String(start!.payload.message)
      expect(msg).toContain('neither does that conversation\'s history')
      expect(msg).toContain('Where is the review?')
    }, { timeout: 15_000 })
    const old = await getSessionByClaudeId(sid)
    expect(old?.archived).toBe(true)
    resetCache()
    expect(await getQueue(sid)).toEqual([])
    expect(await exists(oldCwd)).toBe(false)
  }, 60_000)
})

describe('a working folder that is a link to another place (2026-11-20, the notes moved into one tree)', () => {
  it('delivers into a link, and what waited goes on the Retry once the folder answers again', async () => {
    // The old place is a link into the tree, as the move leaves notes/<folder>.
    const real = path.join(scratch, 'artifacts', 'projects', 'Cove', 'notes')
    await fs.mkdir(real, { recursive: true })
    const oldCwd = path.join(scratch, 'notes', 'cove')
    await fs.mkdir(path.dirname(oldCwd), { recursive: true })
    await fs.symlink(real, oldCwd)
    const { taskId, sid } = await startIn('Cove notes', oldCwd)
    await updateTaskRaw(taskId, { cwd: oldCwd }, { source: 'test' })
    await writeTranscript(sid, oldCwd)

    // A message into the link goes out, in that folder.
    let since = mark()
    await sendMessageToSession(sid, 'Through the link', { source: 'user' })
    await vi.waitFor(() => expect(linesTo(sid, since).some((l) => l.message.includes('Through the link'))).toBe(true), { timeout: 15_000 })
    await vi.waitFor(async () => { resetCache(); expect(await getQueue(sid)).toEqual([]) }, { timeout: 15_000 })
    daemon.simulateDeath(sid, 0)
    await updateSessionRecord(sid, { process_status: 'stopped' })

    // Between the move and the links the place is not there: the message waits, the folder is marked gone.
    await fs.unlink(oldCwd)
    await sendMessageToSession(sid, 'While the place was missing', { source: 'user' })
    await vi.waitFor(async () => {
      resetCache()
      expect((await getQueue(sid)).map((m) => m.status)).toEqual(['parked'])
      expect((await getSessionByClaudeId(sid))?.cwdGone).toMatchObject({ cwd: oldCwd })
    }, { timeout: 15_000 })

    // The user's status reads it not delivered (a folder of his own, which Walnut does not make
    // again): from then on it is his to send, never sent by itself (review round two, N2: words he
    // typed again would go twice). The link is made again; the start's look clears the folder's
    // mark and sends nothing; his Retry sends it, in the same folder.
    const { syncUserStatuses } = await import('../../src/core/user-status-sync.js')
    await syncUserStatuses(new Set([taskId]))
    await vi.waitFor(async () => { resetCache(); expect((await getQueue(sid))[0]?.folderWait).toBeUndefined() }, { timeout: 15_000 })
    await fs.symlink(real, oldCwd)
    since = mark()
    expect(await sendWhereFoldersCameBack()).toMatchObject({ sessions: [sid], messages: 0 })
    const { sendQueuedNow } = await import('../../src/core/sessions/send-now.js')
    resetCache()
    expect(await sendQueuedNow({ sessionId: sid, messageId: (await getQueue(sid))[0]!.id, source: 'web-ui-retry', unpark: true })).toMatchObject({ sent: true })
    await vi.waitFor(() => {
      const start = daemon.getCommandHistoryFor('start').slice(since.start).find((c) => c.payload.sid === sid)
      expect(start?.payload.cwd).toBe(oldCwd)
      expect(linesTo(sid, since).some((l) => l.message.includes('While the place was missing'))).toBe(true)
    }, { timeout: 15_000 })
    const record = await getSessionByClaudeId(sid)
    expect(record?.cwdGone).toBeUndefined()
    expect(record?.cwd).toBe(oldCwd)
    await vi.waitFor(async () => { resetCache(); expect(await getQueue(sid)).toEqual([]) }, { timeout: 15_000 })
    // Nothing more to send: a second look sends nothing.
    expect(await sendWhereFoldersCameBack()).toMatchObject({ sessions: [], messages: 0 })
  }, 90_000)
})

describe('the start\'s look takes back only what the gap stopped', () => {
  it('leaves an old mark, a finished task and a stop a person made alone, and arms a trigger stopped on its folder', async () => {
    const real = path.join(scratch, 'artifacts', 'projects', 'Ledger', 'notes')
    await fs.mkdir(real, { recursive: true })
    const place = path.join(scratch, 'notes', 'ledger')
    await fs.symlink(real, place)
    const mk = async (title: string) => {
      const s = await startIn(title, place)
      await fs.unlink(place)
      await sendMessageToSession(s.sid, `${title}: waiting`, { source: 'user' })
      await vi.waitFor(async () => { resetCache(); expect((await getSessionByClaudeId(s.sid))?.cwdGone).toBeDefined() }, { timeout: 15_000 })
      await fs.symlink(real, place)
      return s
    }
    const old = await mk('Old mark')
    const gone = (await getSessionByClaudeId(old.sid))!.cwdGone!
    await updateSessionRecord(old.sid, { cwdGone: { ...gone, at: new Date(Date.now() - 3 * 86_400_000).toISOString() } } as never)
    const done = await mk('Finished task')
    await updateTaskRaw(done.taskId, { phase: 'COMPLETE' } as never, { source: 'test' })

    // A trigger Walnut stopped because its folder was missing, and one a person paused.
    const service = getCronService()!
    const owner = (await addTask({ title: 'Ledger watcher', project: 'Test' })).task.id
    const base = { enabled: true, schedule: { kind: 'every', everyMs: 300_000 }, sessionTarget: 'main', payload: { kind: 'systemEvent', text: 'go' }, executor: { type: 'session', config: { target: owner } } }
    const stopped = await service.add({ ...base, name: 'Ledger watch', check: { run: 'echo \'{"fire": false}\'', host: '__local__', cwd: place } } as never)
    const paused = await service.add({ ...base, name: 'Paused watch', check: { run: 'echo \'{"fire": false}\'', host: '__local__', cwd: place } } as never)
    for (let i = 1; i <= 5; i++) {
      await service.applyTriggerChecked({ type: 'trigger.checked', id: stopped.id, atMs: Date.now(), outcome: 'error', error: `cwd does not exist: ${place}`, durationMs: 1, nextRunAtMs: Date.now() + 300_000, consecutiveErrors: i } as never)
    }
    expect((await service.list({ includeDisabled: true })).find((j) => j.id === stopped.id)?.enabled).toBe(false)
    await service.update(paused.id, { enabled: false })

    const report = await sendWhereFoldersCameBack()
    expect(report.sessions).not.toContain(old.sid)
    expect(report.sessions).not.toContain(done.sid)
    expect(report.triggers).toEqual([stopped.id])
    resetCache()
    expect((await getQueue(old.sid)).map((m) => m.status)).toEqual(['parked'])
    expect((await getQueue(done.sid)).map((m) => m.status)).toEqual(['parked'])
    const jobs = await service.list({ includeDisabled: true })
    expect(jobs.find((j) => j.id === stopped.id)?.enabled).toBe(true)
    expect(jobs.find((j) => j.id === paused.id)?.enabled).toBe(false)
    await service.remove(stopped.id); await service.remove(paused.id)
  }, 90_000)
})


describe('a folder of the user\'s own comes back by a way no remake knows of', () => {
  // 2026-11-24: rows parked on a gone folder stayed parked after the folder was back
  // (src/core/sessions/folder-wait.ts). A folder Walnut does not make again (not a task's workspace)
  // reads not delivered in the user's status, so the row then waits for his Retry instead of riding
  // along with his next message: he may have typed it again (review round two, N2). The ride itself
  // is pinned on a host's session in tests/e2e/host-judge-folder-back-e2e.test.ts and in
  // tests/core/sessions/folder-wait.test.ts.
  it('the row shown as not delivered waits for the Retry and goes once; a row an older Walnut parked waits too', async () => {
    const cwd = path.join(scratch, 'handmade', 'orchard')
    await fs.mkdir(cwd, { recursive: true })
    const { taskId, sid } = await startIn('Orchard planner', cwd)
    await writeTranscript(sid, cwd)
    await fs.rm(cwd, { recursive: true, force: true })

    // A row an older Walnut parked on the folder: the same words, no mark.
    const { enqueueMessage, parkMessages } = await import('../../src/core/session-message-queue.js')
    const { mutateStore } = await import('../../src/core/session-queue-store.js')
    const older = await enqueueMessage(sid, 'An older park', { sentBy: 'person' })
    await parkMessages([older], { reason: `Working directory no longer exists: ${cwd}`, code: 'cwd_missing' })
    await mutateStore((s) => { delete s.queues[sid]!.find((m) => m.id === older.id)!.folderWait })

    await sendMessageToSession(sid, 'Sent while the folder was gone', { source: 'user' })
    await vi.waitFor(async () => {
      resetCache()
      expect((await getQueue(sid)).map((m) => `${m.message.includes('An older park') ? 'older' : 'waited'}:${m.status}`))
        .toEqual(['older:parked', 'waited:parked'])
    }, { timeout: 15_000 })
    // The user's status reads it not delivered: from then on it is his to send again.
    const { syncUserStatuses } = await import('../../src/core/user-status-sync.js')
    await syncUserStatuses(new Set([taskId]))
    await vi.waitFor(async () => {
      resetCache()
      expect((await getQueue(sid)).map((m) => m.folderWait === true)).toEqual([false, false])
    }, { timeout: 15_000 })
    const waited = (await getQueue(sid)).find((m) => m.message.includes('Sent while the folder was gone'))!

    // Made again by hand: no remake, no button, no host restart. His next message goes alone.
    await fs.mkdir(cwd, { recursive: true })
    await writeTranscript(sid, cwd)
    const since = mark()
    await sendMessageToSession(sid, 'Sent after the folder came back', { source: 'user' })
    await vi.waitFor(() => {
      expect(linesTo(sid, since).some((l) => l.message.includes('Sent after the folder came back'))).toBe(true)
    }, { timeout: 20_000 })
    expect(linesTo(sid, since).some((l) => l.message.includes('Sent while the folder was gone'))).toBe(false)
    resetCache()
    expect((await getQueue(sid)).filter((m) => m.status === 'parked').map((m) => m.id).sort()).toEqual([older.id, waited.id].sort())

    // His Retry on the bubble sends it, once.
    const { sendQueuedNow } = await import('../../src/core/sessions/send-now.js')
    expect(await sendQueuedNow({ sessionId: sid, messageId: waited.id, source: 'web-ui-retry', unpark: true })).toMatchObject({ sent: true })
    await vi.waitFor(() => {
      expect(linesTo(sid, since).filter((l) => l.message.includes('Sent while the folder was gone'))).not.toHaveLength(0)
    }, { timeout: 20_000 })
    const sends = daemon.getCommandHistoryFor('send').slice(since.send).filter((c) => c.payload.sid === sid)
    expect(new Set(sends.filter((c) => String(c.payload.message).includes('Sent while the folder was gone')).map((c) => c.payload.uuid)).size).toBe(1)
    expect(linesTo(sid, since).some((l) => l.message.includes('An older park'))).toBe(false)
  }, 90_000)
})
