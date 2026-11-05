/**
 * The engine split through a REAL server (core/agents/engine-split.ts): task starts that name
 * no engine take turns between the split's entries, each pick is kept on the task and named in
 * the start's outcome, a start that names its engine is the override, and GET /api/usage/engines
 * compares the work. Two Claude Code entries (one on another model) stand in for two engines,
 * because only the Claude CLI is mocked here; host availability is unit-tested.
 *
 * Mocked: constants, the daemon (MockDaemon), the CLI (mock-claude.mjs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { vi } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-engine-split'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { getConfig, updateConfig } from '../../src/core/config-manager.js'
import { getSessionsForTask } from '../../src/core/session-tracker.js'
import { updateTaskRaw } from '../../src/core/task-manager.js'
import { startSessionForTask } from '../../src/core/sessions/task-start.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
let server: HttpServer
let port: number
let daemon: MockDaemon

async function op(name: string, args: Record<string, unknown>): Promise<any> {
  const out = await executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN }) as { ok: boolean; result?: unknown; error?: unknown }
  if (!out.ok) throw new Error(`${name} failed: ${JSON.stringify(out)}`)
  return out.result
}
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}
const task = async (id: string) => (await api('GET', `/api/tasks/${id}`)).body.task

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  const config = await getConfig()
  await updateConfig({ defaults: { ...config.defaults, engine_split: [{ engine: 'claude' }, { engine: 'claude', model: 'sonnet' }] } })
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('the engine split', () => {
  it('alternates new task starts, keeps each pick, and says so in the outcome', async () => {
    const first = await op('task_create', { title: 'Split one', project: 'Marina', cwd: WALNUT_HOME, message: 'Ready' })
    const second = await op('task_create', { title: 'Split two', project: 'Marina', cwd: WALNUT_HOME, message: 'Ready' })
    expect(first.enginePick?.key).toBe('claude')
    expect(second.enginePick?.key).toBe('claude:sonnet')
    expect(second.enginePick?.shares).toEqual({ claude: 1, 'claude:sonnet': 0 })
    expect(String(second.outcome)).toContain('The engine split gave it claude:sonnet')
    expect((await task(first.id)).engine_pick).toMatchObject({ key: 'claude', engine: 'claude' })
    expect((await task(second.id)).engine_pick).toMatchObject({ key: 'claude:sonnet', model: 'sonnet' })
    // The second start ran on the model its entry names.
    const [record] = await getSessionsForTask(second.id)
    expect(record?.cliModel ?? '').toMatch(/sonnet/i)
    const [plain] = await getSessionsForTask(first.id)
    expect(plain?.cliModel ?? '').not.toMatch(/sonnet/i)
  }, 60_000)

  it('a start that names its engine or model is the override and takes no pick', async () => {
    const named = await op('task_create', { title: 'Named engine', project: 'Marina', cwd: WALNUT_HOME, message: 'Ready', engine: 'claude' })
    const model = await op('task_create', { title: 'Named model', project: 'Marina', cwd: WALNUT_HOME, message: 'Ready', model: 'opus' })
    for (const r of [named, model]) {
      expect(r.enginePick).toBeUndefined()
      expect((await task(r.id)).engine_pick).toBeUndefined()
    }
    // The override took no turn: the next plain start is still the one behind.
    const next = await op('task_create', { title: 'Split three', project: 'Marina', cwd: WALNUT_HOME, message: 'Ready' })
    expect(next.enginePick?.key).toBe('claude')
  }, 60_000)

  it("a reviewer subtask takes no turn of the split, so work tasks still alternate", async () => {
    const work = await op('task_create', { title: 'Work before review', project: 'Marina', cwd: WALNUT_HOME, message: 'Ready' })
    const review = await api('POST', '/api/tasks', { title: 'Review the change', priority: 'none', project: 'Marina', parent_task_id: work.id })
    const started = await startSessionForTask({ taskIdPrefix: review.body.task.id, cwd: WALNUT_HOME, message: 'Ready', expectReply: false })
    expect(started.enginePick).toBeUndefined()
    const next = await op('task_create', { title: 'Work after review', project: 'Marina', cwd: WALNUT_HOME, message: 'Ready' })
    expect(next.enginePick?.key).not.toBe(work.enginePick?.key)
  }, 60_000)

  it('a start that waited (the queue, a workspace) runs on the pick its first try made', async () => {
    const placeholder = await op('task_create', { title: 'Queued start', project: 'Marina', record_only: true })
    // Its first try picked Claude Code on another model, then waited in the running-subtask queue.
    await updateTaskRaw(placeholder.id, { engine_pick: { key: 'claude:sonnet', engine: 'claude', model: 'sonnet', at: new Date().toISOString() } })
    const replay = await startSessionForTask({ taskIdPrefix: placeholder.id, cwd: WALNUT_HOME, message: 'Ready', source: 'start-queue', expectReply: false })
    expect(replay.enginePick).toMatchObject({ key: 'claude:sonnet', reused: true })
    await expect.poll(async () => (await getSessionsForTask(placeholder.id))[0]?.cliModel ?? '', { timeout: 20_000 }).toMatch(/sonnet/i)
  }, 60_000)

  it('a start that failed before a turn is retried on the engine the split gave it', async () => {
    const placeholder = await op('task_create', { title: 'Failed first start', project: 'Marina', record_only: true })
    // The engine fails to start: the failure names the split's pick and the way to choose another engine.
    daemon.injectStartFault('mkfifo failed: injected')
    try {
      await expect(startSessionForTask({ taskIdPrefix: placeholder.id, cwd: WALNUT_HOME, message: 'Ready', expectReply: false }))
        .rejects.toThrow(/the engine split's pick for this task.*retry with engine/)
    } finally { daemon.injectStartFault(null) }
    const first = (await task(placeholder.id)).engine_pick
    expect(first?.key).toBeTruthy()
    const retried = await startSessionForTask({ taskIdPrefix: placeholder.id, cwd: WALNUT_HOME, message: 'Ready', expectReply: false })
    expect(retried.enginePick).toMatchObject({ key: first!.key, reused: true })
    // The failure is kept after the retry replaced last_start, so the comparison still counts it.
    expect((await task(placeholder.id)).start_failures ?? 0).toBeGreaterThanOrEqual(1)
    await expect.poll(async () => (await getSessionsForTask(placeholder.id)).at(-1)?.cliModel ?? '', { timeout: 20_000 })
      .toSatisfy((m: string) => /sonnet/i.test(m) === (first!.key === 'claude:sonnet'))
  }, 60_000)

  it('a kept pick the split no longer lists is picked again, not retried forever', async () => {
    const placeholder = await op('task_create', { title: 'Pick since removed', project: 'Marina', record_only: true })
    await updateTaskRaw(placeholder.id, { engine_pick: { key: 'claude:retired-model', engine: 'claude', model: 'retired-model', at: new Date().toISOString() } })
    const started = await startSessionForTask({ taskIdPrefix: placeholder.id, cwd: WALNUT_HOME, message: 'Ready', expectReply: false })
    expect(started.enginePick?.reused).toBeFalsy()
    expect(['claude', 'claude:sonnet']).toContain(started.enginePick?.key)
    expect((await task(placeholder.id)).engine_pick?.key).toBe(started.enginePick?.key)
  }, 60_000)

  it('two starts of one task at once keep one pick, the one its session runs on', async () => {
    const placeholder = await op('task_create', { title: 'Double start', project: 'Marina', record_only: true })
    const both = await Promise.allSettled([
      startSessionForTask({ taskIdPrefix: placeholder.id, cwd: WALNUT_HOME, message: 'Ready', expectReply: false }),
      startSessionForTask({ taskIdPrefix: placeholder.id, cwd: WALNUT_HOME, message: 'Ready', expectReply: false }),
    ])
    const started = both.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof startSessionForTask>>>[]
    expect(started.length).toBeGreaterThanOrEqual(1)
    // A start refused for another reason (here: the task is already starting) does not name the split's pick.
    for (const r of both) if (r.status === 'rejected') expect(String(r.reason)).not.toContain("engine split's pick")
    const kept = (await task(placeholder.id)).engine_pick
    expect(kept?.key).toBe(started[0].value.enginePick?.key)
    await expect.poll(async () => (await getSessionsForTask(placeholder.id)).length, { timeout: 20_000 }).toBeGreaterThan(0)
    const [record] = await getSessionsForTask(placeholder.id)
    expect(/sonnet/i.test(record?.cliModel ?? '')).toBe(kept?.key === 'claude:sonnet')
  }, 60_000)

  it('counts a reopen of a completed task and compares the work on GET /api/usage/engines', async () => {
    const done = await op('task_create', { title: 'Finish and reopen', project: 'Marina', cwd: WALNUT_HOME, message: 'Ready' })
    expect((await api('PATCH', `/api/tasks/${done.id}`, { phase: 'COMPLETE' })).status).toBe(200)
    expect((await api('PATCH', `/api/tasks/${done.id}`, { phase: 'IN_PROGRESS' })).status).toBe(200)
    expect((await task(done.id)).reopens).toBe(1)
    expect((await api('PATCH', `/api/tasks/${done.id}`, { phase: 'COMPLETE' })).status).toBe(200)
    const review = await api('POST', '/api/tasks', { title: 'Review the change', priority: 'none', project: 'Marina', parent_task_id: done.id })
    expect(review.status).toBe(201)

    const r = await api('GET', '/api/usage/engines?project=Marina')
    expect(r.status).toBe(200)
    expect(r.body.split).toMatchObject({ on: true, entries: [{ key: 'claude' }, { key: 'claude:sonnet' }] })
    // The mock CLI names its model "mock-model", so these read as Claude Code on an "Other" model.
    const finished = r.body.tasks.find((t: { taskId: string }) => t.taskId === done.id)
    expect(finished).toMatchObject({ done: true, reopens: 1, reviews: 1, split: true })
    const row = r.body.rows.find((x: { key: string }) => x.key === finished.key)
    expect(row).toMatchObject({ engine: 'claude', done: 1, reopens: 1, reviewsPerTask: 1 })
    expect(r.body.rows.reduce((n: number, x: { open: number; done: number }) => n + x.open + x.done, 0)).toBe(12)
    expect(r.body.taskCount).toBe(12)
    // Only the split's own picks: the starts that named an engine or a model drop out.
    const fair = await api('GET', '/api/usage/engines?project=Marina&split=1')
    expect(fair.body).toMatchObject({ splitOnly: true, taskCount: 10 })
    expect(r.body.tasks.some((t: { title: string }) => t.title === 'Review the change')).toBe(false)
    expect(r.body.projects).toEqual([{ project: 'Marina', tasks: expect.any(Number) }])
  }, 60_000)
})
