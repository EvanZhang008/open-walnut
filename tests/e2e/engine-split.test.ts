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
  await updateConfig({
    defaults: { ...config.defaults, engine_split: [{ engine: 'claude' }, { engine: 'claude', model: 'sonnet' }] },
    // The automatic starts below share this machine's slots with the earlier cases' mock
    // sessions, which a slow runner may still have in a turn: by its size a small CI runner gets
    // 2 (src/core/hosts/placement.ts hostSlots), and "a start that waited" was refused with "no
    // room" (2026-11-10, CI). The slot rule is not under test here.
    session_limits: { local: 32 },
  })
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
        // Both entries are Claude Code here, so it suggests another model rather than another engine.
        .rejects.toThrow(/the engine split's pick for this task.*retry with model/)
    } finally { daemon.injectStartFault(null) }
    const first = (await task(placeholder.id)).engine_pick
    expect(first?.key).toBeTruthy()
    const retried = await startSessionForTask({ taskIdPrefix: placeholder.id, cwd: WALNUT_HOME, message: 'Ready', expectReply: false })
    expect(retried.enginePick).toMatchObject({ key: first!.key, reused: true })
    // The failure is kept after the retry replaced last_start, so the comparison still counts it.
    expect((await task(placeholder.id)).start_failures).toBe(1)
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
    // The losing start's pick took no turn: the next new task goes to the other entry.
    const next = await op('task_create', { title: 'After the double start', project: 'Marina', cwd: WALNUT_HOME, message: 'Ready' })
    expect(next.enginePick?.key).not.toBe(kept?.key)
  }, 60_000)

  it('shares only the projects it names: a task elsewhere runs on the default engine, a kept pick included', async () => {
    const config = await getConfig()
    await updateConfig({ defaults: { ...config.defaults, engine_split_projects: ['marina '] } })
    try {
      // Named in another case, with a stray space: still the project the split shares.
      const inside = await op('task_create', { title: 'Inside the split', project: 'Marina', cwd: WALNUT_HOME, message: 'Ready' })
      expect(inside.enginePick?.key).toBeTruthy()
      const outside = await op('task_create', { title: 'Org demo elsewhere', project: 'Lighthouse', cwd: WALNUT_HOME, message: 'Ready' })
      expect(outside.enginePick).toBeUndefined()
      expect(String(outside.outcome)).not.toContain('engine split')
      expect((await task(outside.id)).engine_pick).toBeUndefined()
      await expect.poll(async () => (await getSessionsForTask(outside.id)).length, { timeout: 20_000 }).toBeGreaterThan(0)
      const [record] = await getSessionsForTask(outside.id)
      expect(record?.cliModel ?? '').not.toMatch(/sonnet/i)
      // A pick kept from before the scope (or before the task moved) is not reused outside it.
      const moved = await op('task_create', { title: 'Moved out of the split', project: 'Lighthouse', record_only: true })
      await updateTaskRaw(moved.id, { engine_pick: { key: 'claude:sonnet', engine: 'claude', model: 'sonnet', at: new Date().toISOString() } })
      const replay = await startSessionForTask({ taskIdPrefix: moved.id, cwd: WALNUT_HOME, message: 'Ready', source: 'start-queue', expectReply: false })
      expect(replay.enginePick).toBeUndefined()
      await expect.poll(async () => (await getSessionsForTask(moved.id)).length, { timeout: 20_000 }).toBeGreaterThan(0)
      expect((await getSessionsForTask(moved.id))[0]?.cliModel ?? '').not.toMatch(/sonnet/i)
    } finally {
      const now = await getConfig()
      const { engine_split_projects: _p, ...rest } = now.defaults as typeof now.defaults & { engine_split_projects?: string[] }
      await updateConfig({ defaults: rest })
    }
  }, 60_000)

  it('a task completed before first_completed_at existed keeps its completion through a reopen, on both write paths', async () => {
    const old = '2026-10-01T10:00:00.000Z'
    for (const path of ['route', 'raw'] as const) {
      const t = await op('task_create', { title: `Legacy completion (${path})`, project: 'Legacy', record_only: true })
      // As an older Walnut left it: COMPLETE with completed_at and no first_completed_at.
      await updateTaskRaw(t.id, { phase: 'COMPLETE', status: 'done', completed_at: old, first_completed_at: null as unknown as string })
      expect((await task(t.id)).first_completed_at ?? null).toBeNull()
      if (path === 'route') expect((await api('PATCH', `/api/tasks/${t.id}`, { phase: 'IN_PROGRESS' })).status).toBe(200)
      else await updateTaskRaw(t.id, { phase: 'IN_PROGRESS' }, { source: 'api', reopenTerminal: true })
      expect((await task(t.id)).first_completed_at).toBe(old)
      // The next completion joins the list after the legacy first one, on the same path.
      if (path === 'route') expect((await api('PATCH', `/api/tasks/${t.id}`, { phase: 'COMPLETE' })).status).toBe(200)
      else await updateTaskRaw(t.id, { phase: 'COMPLETE', status: 'done', completed_at: new Date().toISOString() })
      const completions = (await task(t.id)).completions ?? []
      expect(completions).toHaveLength(2)
      expect(completions[0]).toBe(old)
    }
  }, 60_000)

  it('a CLI that got its pid and died before its first reply, then closed, is "never started", not finished work', async () => {
    const placeholder = await op('task_create', { title: 'CLI dies before first reply', project: 'Silent', record_only: true })
    daemon.setCliCommand(path.resolve(import.meta.dirname, '../helpers/cli-dies-before-reply.mjs'))
    try {
      await startSessionForTask({ taskIdPrefix: placeholder.id, cwd: WALNUT_HOME, message: 'Ready', expectReply: false })
      await expect.poll(async () => (await getSessionsForTask(placeholder.id))[0]?.process_status, { timeout: 30_000 }).toBe('error')
    } finally { daemon.setCliCommand(MOCK_CLI) }
    expect((await api('PATCH', `/api/tasks/${placeholder.id}`, { phase: 'COMPLETE' })).status).toBe(200)
    const r = await api('GET', '/api/usage/engines?project=Silent')
    expect(r.body.rows).toHaveLength(1)
    expect(r.body.rows[0]).toMatchObject({ done: 0, open: 0, notStarted: 1, errored: 1 })
    expect(r.body.tasks[0]).toMatchObject({ taskId: placeholder.id, notStarted: true })
  }, 90_000)

  it('a CLI that died before its first reply, closed, reopened and then really worked, is finished work with no reopen', async () => {
    const placeholder = await op('task_create', { title: 'Dies, then works', project: 'Revived', record_only: true })
    daemon.setCliCommand(path.resolve(import.meta.dirname, '../helpers/cli-dies-before-reply.mjs'))
    try {
      await startSessionForTask({ taskIdPrefix: placeholder.id, cwd: WALNUT_HOME, message: 'Ready', expectReply: false })
      await expect.poll(async () => (await getSessionsForTask(placeholder.id))[0]?.process_status, { timeout: 30_000 }).toBe('error')
    } finally { daemon.setCliCommand(MOCK_CLI) }
    expect((await api('PATCH', `/api/tasks/${placeholder.id}`, { phase: 'COMPLETE' })).status).toBe(200)
    expect((await api('PATCH', `/api/tasks/${placeholder.id}`, { phase: 'IN_PROGRESS' })).status).toBe(200)
    await startSessionForTask({ taskIdPrefix: placeholder.id, cwd: WALNUT_HOME, message: 'Try again', expectReply: false })
    // The retried run ends a real turn (Claude Code records it in its status moves and prompt cache facts).
    await expect.poll(async () => (await getSessionsForTask(placeholder.id)).some((s) =>
      !!s.promptCache?.requestAt || !!s.status_history?.some((h) => h.reason === 'turn_completed')), { timeout: 30_000 }).toBe(true)
    // Walnut kept when the first turn ran, after the reopen (the dead spawn had none).
    const reopenedAt = (await task(placeholder.id)).first_completed_at!
    const firstTurns = (await getSessionsForTask(placeholder.id)).map((x) => x.firstTurnAt).filter(Boolean) as string[]
    expect(firstTurns.length).toBeGreaterThan(0)
    expect(firstTurns.every((at) => at > reopenedAt)).toBe(true)
    expect((await api('PATCH', `/api/tasks/${placeholder.id}`, { phase: 'COMPLETE' })).status).toBe(200)
    expect((await task(placeholder.id)).completions).toHaveLength(2)
    const r = await api('GET', '/api/usage/engines?project=Revived')
    expect(r.body.rows).toHaveLength(1)
    expect(r.body.rows[0]).toMatchObject({ done: 1, notStarted: 0, reopens: 0 })
    expect(r.body.tasks[0]).toMatchObject({ taskId: placeholder.id, done: true, reopens: 0 })
    expect(r.body.tasks[0].notStarted).toBeFalsy()
  }, 120_000)

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
    expect(r.body.rows.reduce((n: number, x: { open: number; done: number }) => n + x.open + x.done, 0)).toBe(14)
    expect(r.body.taskCount).toBe(14)
    // Only the split's own picks: the starts that named an engine or a model drop out.
    const fair = await api('GET', '/api/usage/engines?project=Marina&split=1')
    expect(fair.body).toMatchObject({ splitOnly: true, taskCount: 12 })
    expect(r.body.tasks.some((t: { title: string }) => t.title === 'Review the change')).toBe(false)
    expect(r.body.projects).toEqual(expect.arrayContaining([{ project: 'Marina', tasks: expect.any(Number) }]))
  }, 60_000)
})

describe("the engine split and a project's launch defaults", () => {
  it("a project's default engine comes before the split; a project that sets only a mode keeps the split's pick", async () => {
    // Order: a named engine, the project's default engine, the split, the default engine.
    expect((await api('PUT', `/api/projects/${encodeURIComponent('Pinned Lab')}/metadata`, { default_engine: 'claude', default_model: 'haiku' })).status).toBe(200)
    const pinned = await op('task_create', { title: 'Project engine', project: 'Pinned Lab', cwd: WALNUT_HOME, message: 'Ready' })
    expect(pinned.enginePick).toBeUndefined()
    expect((await task(pinned.id)).engine_pick).toBeUndefined()
    expect((await task(pinned.id)).launch_source).toMatchObject({ engine: 'project', model: 'project', project: 'Pinned Lab' })

    expect((await api('PUT', `/api/projects/${encodeURIComponent('Mode Lab')}/metadata`, { default_mode: 'plan' })).status).toBe(200)
    const modeOnly = await op('task_create', { title: 'Project mode', project: 'Mode Lab', cwd: WALNUT_HOME, message: 'Ready' })
    expect(modeOnly.enginePick?.key).toBeTruthy()
    expect((await task(modeOnly.id)).launch_source).toMatchObject({ engine: 'global', model: 'global', mode: 'project' })
    const [record] = await getSessionsForTask(modeOnly.id)
    expect(record?.mode).toBe('plan')
  }, 60_000)
})
