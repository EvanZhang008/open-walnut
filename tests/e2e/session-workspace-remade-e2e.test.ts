/**
 * A session whose folder was its task's isolated workspace keeps working after the
 * completion cleanup removed that workspace (src/core/workspaces/remake.ts).
 *
 * 2026-11-16: two tasks on a dev host completed, their workspaces were cleaned up, and a
 * later message woke each one. Every resume stopped at "Working directory no longer
 * exists", the message stayed parked in the queue, and the work went to a new task. Now the
 * workspace is made again at the same path (same provider and name) and the message runs
 * there, the session told once that its folder was made again.
 *
 * What's real: server, queue, records, the workspace manager and its cleanup, the git
 * worktrees (MockDaemon runs the real workspace core), the transcript files. Mocked:
 * constants, the daemon's CLI side (mock-claude.mjs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-workspace-remade'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, completeTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getQueue, resetCache, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { mutateStore } from '../../src/core/session-queue-store.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../src/core/session-file-reader.js'
import { localClaudeProjectsDir } from '../../src/core/claude-config-dir.js'
import { requestWorkspace } from '../../src/core/workspaces/manager.js'
import { __setWorkspaceConnectionForTesting } from '../../src/core/workspaces/daemon-client.js'
import { remakeForGoneFolder } from '../../src/core/workspaces/remake.js'
import { localTaskDirRoot } from '../../src/core/sessions/task-dir-place.js'
import { getDirectDaemonConnection } from '../../src/providers/daemon-connection.js'
import type { Task } from '../../src/core/types.js'

let server: Server
let daemon: MockDaemon
let port: number
let scratch: string
let repo: string

const post = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const exists = (p: string) => fs.stat(p).then(() => true, () => false)

function linesTo(sid: string, since: { start: number; send: number; fifo: number }): Array<{ cwd?: string; message: string }> {
  return [
    ...daemon.getCommandHistoryFor('start').slice(since.start).filter((c) => c.payload.sid === sid).map((c) => ({ cwd: c.payload.cwd as string, message: String(c.payload.message ?? '') })),
    ...daemon.getCommandHistoryFor('send').slice(since.send).filter((c) => c.payload.sid === sid).map((c) => ({ message: String(c.payload.message ?? '') })),
    ...daemon.getFifoWrites().slice(since.fifo).filter((w) => w.sid === sid).map((w) => ({ message: w.message })),
  ]
}
const mark = () => ({ start: daemon.getCommandHistoryFor('start').length, send: daemon.getCommandHistoryFor('send').length, fifo: daemon.getFifoWrites().length })

/** A task with a ready git worktree, its session stopped in it, its transcript on disk. */
async function taskInWorkspace(title: string, anchor = repo): Promise<{ taskId: string; sid: string; cwd: string; createdAt: string }> {
  const taskId = (await addTask({ title, project: 'Test', cwd: anchor })).task.id
  await requestWorkspace(taskId, { provider: 'git-worktree', host: '__local__', anchor })
  let ws: Task['workspace']
  await vi.waitFor(async () => {
    ws = (await getTask(taskId)).workspace
    expect(ws?.state).toBe('ready')
  }, { timeout: 30_000 })
  const cwd = ws!.cwd!
  const sid = (await sessionRunner.startSession({ taskId, cwd, message: 'Ready', project: 'Test', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/), { timeout: 20_000 })
  daemon.simulateDeath(sid, 0)
  await updateSessionRecord(sid, { process_status: 'stopped' })
  const dir = path.join(localClaudeProjectsDir(), encodeProjectPath(cwd))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'user', cwd, sessionId: sid, message: { role: 'user', content: 'remember PINEAPPLE' } }) + '\n')
  return { taskId, sid, cwd, createdAt: ws!.created_at! }
}

/** Complete the task and wait for the cleanup to remove its workspace, folder and all. */
async function completeAndClean(taskId: string, cwd: string): Promise<void> {
  await completeTask(taskId)
  await vi.waitFor(async () => {
    expect((await getTask(taskId)).workspace?.state).toBe('removed')
  }, { timeout: 30_000 })
  expect(await exists(cwd)).toBe(false)
}

async function makeRepo(name: string): Promise<string> {
  const dir = path.join(scratch, name)
  await fs.mkdir(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

/** The state a refusal leaves: the message parked on the gone folder. */
async function parkOnGoneFolder(sid: string, cwd: string, message: string): Promise<void> {
  await mutateStore((s) => {
    s.queues[sid] = [{ id: `qm-${randomUUID()}`, sessionId: sid, message, status: 'parked', enqueuedAt: new Date().toISOString(), parkedAt: new Date().toISOString(), parkedReason: `Working directory no longer exists: ${cwd}` }]
  })
  resetCache()
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-ws-remade-')))
  repo = await makeRepo('repo')
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  __setWorkspaceConnectionForTesting(async () => getDirectDaemonConnection('__local__', `ws://127.0.0.1:${daemon.port}`))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
}, 120_000)

afterAll(async () => {
  __setWorkspaceConnectionForTesting(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.rm(scratch, { recursive: true, force: true })
})

describe('a woken task whose workspace a cleanup removed', () => {
  it('a message makes the workspace again at the same path, and runs there, told once', async () => {
    const { taskId, sid, cwd, createdAt } = await taskInWorkspace('Remade on a message')
    await completeAndClean(taskId, cwd)

    // The lead's follow-up the incident lost.
    const before = mark()
    await sendMessageToSession(sid, 'Follow-up from the lead: also fix the flaky test', { source: 'user' })
    await vi.waitFor(() => {
      const start = daemon.getCommandHistoryFor('start').slice(before.start).find((c) => c.payload.sid === sid)
      expect(start).toBeDefined()
      expect(start!.payload.cwd).toBe(cwd)
      expect((start!.payload.args as string[]).join(' ')).toContain(`--resume ${sid}`)
      const msg = linesTo(sid, before).map((l) => l.message).find((m) => m.includes('also fix the flaky test'))
      expect(msg).toContain('outcome="workspace-remade"')
      expect(msg!.indexOf('outcome="workspace-remade"')).toBeLessThan(msg!.indexOf('also fix the flaky test'))
    }, { timeout: 60_000 })
    expect(await exists(cwd)).toBe(true)
    const ws = (await getTask(taskId)).workspace
    expect(ws).toMatchObject({ state: 'ready', cwd, remade: { from: createdAt } })
    await vi.waitFor(async () => { resetCache(); expect(await getQueue(sid)).toEqual([]) }, { timeout: 15_000 })
    const record = await getSessionByClaudeId(sid)
    // Nothing offered "continue in a new folder": the session stays where it was.
    expect(record?.cwdGone).toBeUndefined()
    expect(record?.cwd).toBe(cwd)
    expect(record?.workspaceTold).toBe(createdAt)

    // Told once: the next message carries no second notice.
    daemon.simulateDeath(sid, 0)
    await updateSessionRecord(sid, { process_status: 'stopped' })
    const next = mark()
    await sendMessageToSession(sid, 'And one more thing', { source: 'user' })
    await vi.waitFor(() => {
      const lines = linesTo(sid, next)
      expect(lines.some((l) => l.message.includes('And one more thing'))).toBe(true)
      expect(lines.some((l) => l.message.includes('outcome="workspace-remade"'))).toBe(false)
    }, { timeout: 30_000 })
  }, 150_000)

  it('a message an older Walnut parked on the gone folder goes out when "Continue" is pressed, in the workspace made again', async () => {
    const { taskId, sid, cwd } = await taskInWorkspace('Stuck before the fix')
    await completeAndClean(taskId, cwd)
    // The state the incident left on disk: a parked row and the gone folder recorded.
    await parkOnGoneFolder(sid, cwd, 'The deep test failed on your land: fix it forward')
    await updateSessionRecord(sid, { cwdGone: { cwd, at: new Date().toISOString(), history: 'found' } })

    const before = mark()
    const res = await post(`/api/sessions/${sid}/continue-in-new-folder`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'continued', sessionId: sid, cwd, sent: 1 })
    await vi.waitFor(() => {
      const msg = linesTo(sid, before).map((l) => l.message).find((m) => m.includes('fix it forward'))
      expect(msg).toContain('outcome="workspace-remade"')
      const start = daemon.getCommandHistoryFor('start').slice(before.start).find((c) => c.payload.sid === sid)
      expect(start?.payload.cwd).toBe(cwd)
    }, { timeout: 60_000 })
    const record = await getSessionByClaudeId(sid)
    expect(record?.cwd).toBe(cwd)
    expect(record?.cwdGone).toBeUndefined()
    expect((await getTask(taskId)).workspace?.state).toBe('ready')
  }, 150_000)

  it('Retry on a message parked on the gone folder makes the workspace again and sends it', async () => {
    const { taskId, sid, cwd } = await taskInWorkspace('Retried after the fix')
    await completeAndClean(taskId, cwd)
    await parkOnGoneFolder(sid, cwd, 'Please rebase and land again')
    const before = mark()
    const res = await post(`/api/sessions/${sid}/retry`)
    expect(res.status).toBe(200)
    expect((await res.json()).status).not.toBe('folder_gone')
    await vi.waitFor(() => {
      const start = daemon.getCommandHistoryFor('start').slice(before.start).find((c) => c.payload.sid === sid)
      expect(start?.payload.cwd).toBe(cwd)
      const msg = linesTo(sid, before).map((l) => l.message).find((m) => m.includes('rebase and land again'))
      expect(msg).toBeDefined()
    }, { timeout: 60_000 })
    expect(await exists(cwd)).toBe(true)
    await vi.waitFor(async () => { resetCache(); expect(await getQueue(sid)).toEqual([]) }, { timeout: 15_000 })
    expect((await getSessionByClaudeId(sid))?.cwdGone).toBeUndefined()
  }, 150_000)

  it('a remake the spawn stopped waiting for still sends the parked message when it is ready', async () => {
    const { taskId, sid, cwd } = await taskInWorkspace('Slow remake')
    await completeAndClean(taskId, cwd)
    await parkOnGoneFolder(sid, cwd, 'Ship the release notes too')
    // The spawn's wait ran out (no wait here): the remake goes on, marked for what waits.
    const before = mark()
    expect(await remakeForGoneFolder(taskId, cwd, '__local__', { waitMs: 0, resume: true })).toBe('pending')
    await vi.waitFor(() => {
      const start = daemon.getCommandHistoryFor('start').slice(before.start).find((c) => c.payload.sid === sid)
      expect(start?.payload.cwd).toBe(cwd)
      expect(linesTo(sid, before).some((l) => l.message.includes('Ship the release notes too'))).toBe(true)
    }, { timeout: 60_000 })
    await vi.waitFor(async () => { resetCache(); expect(await getQueue(sid)).toEqual([]) }, { timeout: 15_000 })
    await vi.waitFor(async () => expect((await getTask(taskId)).workspace?.remade?.resume).toBeUndefined(), { timeout: 15_000 })
  }, 150_000)

  it('a remake that fails leaves the folder-gone way on, and the move says so', async () => {
    const own = await makeRepo('doomed-repo')
    const { taskId, sid, cwd } = await taskInWorkspace('Repo deleted too', own)
    await completeAndClean(taskId, cwd)
    // Its repository is gone as well: the workspace cannot be made again.
    await fs.rm(own, { recursive: true, force: true })
    await sendMessageToSession(sid, 'Where did the parser go?', { source: 'user' })
    await vi.waitFor(async () => {
      expect((await getSessionByClaudeId(sid))?.cwdGone).toMatchObject({ cwd, history: 'found' })
    }, { timeout: 60_000 })
    const before = mark()
    const res = await post(`/api/sessions/${sid}/continue-in-new-folder`)
    expect(res.status).toBe(200)
    const taskDir = path.join(localTaskDirRoot(), taskId)
    expect(await res.json()).toMatchObject({ status: 'continued', cwd: taskDir, sent: 1 })
    await vi.waitFor(() => {
      const msg = linesTo(sid, before).map((l) => l.message).find((m) => m.includes('Where did the parser go?'))
      expect(msg).toContain('outcome="folder-moved"')
    }, { timeout: 30_000 })
  }, 150_000)

  it('a folder deleted behind Walnut (the workspace still reads ready) is made again too', async () => {
    const { taskId, sid, cwd } = await taskInWorkspace('Deleted by hand')
    await updateTaskRaw(taskId, { phase: 'IN_PROGRESS' }, { source: 'test' })
    execFileSync('git', ['worktree', 'remove', '--force', cwd], { cwd: repo, stdio: 'ignore' })
    expect((await getTask(taskId)).workspace?.state).toBe('ready')

    const before = mark()
    await sendMessageToSession(sid, 'Keep going on the parser', { source: 'user' })
    // The resume starts in the folder made again (a write into the dead process does not count).
    await vi.waitFor(() => {
      const start = daemon.getCommandHistoryFor('start').slice(before.start).find((c) => c.payload.sid === sid)
      expect(start?.payload.cwd).toBe(cwd)
      expect((start!.payload.args as string[]).join(' ')).toContain(`--resume ${sid}`)
    }, { timeout: 60_000 })
    expect(await exists(cwd)).toBe(true)
    expect((await getTask(taskId)).workspace).toMatchObject({ state: 'ready', cwd })
    expect((await getSessionByClaudeId(sid))?.cwdGone).toBeUndefined()
  }, 150_000)
})
