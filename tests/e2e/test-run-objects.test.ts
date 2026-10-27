/**
 * A test run on the user's own Walnut makes test objects (src/core/test-run.ts), through a REAL
 * server with marking on (`WALNUT_TEST_RUN_MARK=1`; a test server ignores the marker otherwise).
 *
 * 2026-10-27: an Org chart acceptance run made 9 tasks and 6 projects on the live server, which
 * showed on the user's board and Org page while it ran, and its cleanup left 3 session records
 * with no task. Checked here: what a request carrying `x-walnut-test-run` creates is marked
 * (tasks, projects, a subtask filed later, Org VPs and projects), every general list leaves it
 * out while the test run's own reads see it unmarked, Main and a real project's lead are never
 * marked, the CLI's `WALNUT_TEST_RUN` marks too, deleting a test task takes its session records,
 * and the sweep removes idle test objects and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import fs from 'node:fs/promises'

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

let server: HttpServer
let port: number
const savedMark = process.env.WALNUT_TEST_RUN_MARK

const TEST = { 'x-walnut-test-run': 'e2e-probe' }

async function api(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, data: text ? JSON.parse(text) : null }
}

const listIds = async (headers: Record<string, string> = {}) =>
  ((await api('GET', '/api/tasks?fields=list', undefined, headers)).data.tasks as Array<{ id: string }>).map((t) => t.id)
const projectNames = async (headers: Record<string, string> = {}) =>
  ((await api('GET', '/api/projects', undefined, headers)).data.projects as Array<{ name: string }>).map((p) => p.name)
const rawTask = async (id: string) => {
  const { getTask } = await import('../../src/core/task-manager.js')
  return getTask(id)
}

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 90_000)

afterAll(async () => {
  await stopServer()
  if (savedMark === undefined) delete process.env.WALNUT_TEST_RUN_MARK
  else process.env.WALNUT_TEST_RUN_MARK = savedMark
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('test-run objects stay off the board', () => {
  let probe: string
  let child: string
  let real: string

  it('marks a task a test run creates, and the project it names, local and unpinned', async () => {
    const r = await api('POST', '/api/tasks', { title: 'Probe kiwi-anvil', project: 'Probe Room', pinned: true }, TEST)
    expect(r.status).toBe(201)
    probe = r.data.task.id
    const task = await rawTask(probe)
    expect(task).toMatchObject({ plugin_only: '@test-run', source: 'local', project: 'Probe Room' })
    expect(task.pinned).toBeFalsy()
    const { getProjectRecord } = await import('../../src/core/task-manager.js')
    expect((await getProjectRecord('Probe Room'))?.metadata?.test_run).toMatchObject({ label: 'e2e-probe' })
    real = (await api('POST', '/api/tasks', { title: 'Real kiwi-anvil', project: 'Real Room' })).data.task.id
    expect((await rawTask(real)).plugin_only).toBeUndefined()
  })

  it('marks a subtask of a test task, whoever files it', async () => {
    const r = await api('POST', '/api/tasks', { title: 'Probe child', parent_task_id: probe })
    expect(r.status).toBe(201)
    child = r.data.task.id
    expect((await rawTask(child)).plugin_only).toBe('@test-run')
  })

  it('leaves them out of the user\'s lists, the phone\'s and the Org tree', async () => {
    const ids = await listIds()
    expect(ids).toContain(real)
    expect(ids).not.toContain(probe)
    expect(ids).not.toContain(child)
    expect(await projectNames()).toContain('Real Room')
    expect(await projectNames()).not.toContain('Probe Room')
    const v1 = ((await api('GET', '/api/v1/tasks')).data.tasks as Array<{ id: string }>).map((t) => t.id)
    expect(v1).toContain(real)
    expect(v1).not.toContain(probe)
    expect(((await api('GET', '/api/v1/projects')).data.projects as Array<{ name: string }>).map((p) => p.name)).not.toContain('Probe Room')
  })

  it('shows them, unmarked, to the test run itself', async () => {
    const r = await api('GET', '/api/tasks?fields=list', undefined, TEST)
    const row = (r.data.tasks as Array<{ id: string; plugin_only?: string }>).find((t) => t.id === probe)
    expect(row).toBeDefined()
    expect(row!.plugin_only).toBeUndefined()
    expect(await projectNames(TEST)).toContain('Probe Room')
  })

  it('makes Org VPs and projects test objects, never Main or a real project\'s lead', async () => {
    const vp = await api('POST', '/api/v1/org/vps', { name: 'Probe VP' }, TEST)
    expect(vp.status).toBe(201)
    expect((await rawTask(vp.data.task.id)).plugin_only).toBe('@test-run')
    const proj = await api('POST', '/api/v1/org/projects', { name: 'Probe Org Room' }, TEST)
    expect(proj.status).toBe(201)
    expect((await rawTask(proj.data.task.id)).plugin_only).toBe('@test-run')
    expect(await projectNames()).not.toContain('Probe Org Room')
    // A VP named "Probe VP" gets the home project "Probe".
    expect(await projectNames()).not.toContain('Probe')
    // A real project's lead, made on its first contact from a test window, is a real lead.
    const lead = await api('POST', '/api/v1/org/projects', { name: 'Real Org Room' })
    expect((await rawTask(lead.data.task.id)).plugin_only).toBeUndefined()
    const main = await api('POST', '/api/v1/org/main', undefined, TEST)
    expect(main.status).toBeLessThan(300)
    const { listTasks } = await import('../../src/core/task-manager.js')
    const mainTask = (await listTasks()).find((t) => t.org_role === 'main')
    expect(mainTask?.plugin_only).toBeUndefined()
    const tree = (await api('GET', '/api/v1/org')).data.tree
    const names = (tree.projects as Array<{ project: string }>).map((p) => p.project)
    expect(names).toContain('Real Org Room')
    expect(names).not.toContain('Probe Org Room')
  })

  it('a test project real work moves into becomes the user\'s project for good', async () => {
    const made = await api('POST', '/api/tasks', { title: 'Probe in shared', project: 'Probe Shared' }, TEST)
    expect(await projectNames()).not.toContain('Probe Shared')
    const r = await api('POST', '/api/tasks', { title: 'Real in shared', project: 'Probe Shared' })
    expect((await rawTask(r.data.task.id)).plugin_only).toBeUndefined()
    const { getProjectRecord } = await import('../../src/core/task-manager.js')
    expect((await getProjectRecord('Probe Shared'))?.metadata?.test_run).toBeUndefined()
    expect(await projectNames()).toContain('Probe Shared')
    // It stays real after the real work leaves.
    expect((await api('DELETE', `/api/tasks/${r.data.task.id}`)).status).toBeLessThan(300)
    expect(await projectNames()).toContain('Probe Shared')
    expect((await api('DELETE', `/api/tasks/${made.data.task.id}`)).status).toBeLessThan(300)
  })

  it('a person\'s contact never reuses a hidden test lead', async () => {
    const vp = await api('POST', '/api/v1/org/projects', { name: 'Probe Lead Room' }, TEST)
    const testLead = vp.data.task.id
    const { ensureProjectLead } = await import('../../src/core/org/org-store.js')
    const lead = await ensureProjectLead('Probe Lead Room')
    expect(lead.id).not.toBe(testLead)
    expect((await rawTask(lead.id)).plugin_only).toBeUndefined()
    // The real lead made the project real; the test lead goes with the sweep.
    expect(await projectNames()).toContain('Probe Lead Room')
  })

  it('the CLI marks its writes with WALNUT_TEST_RUN', async () => {
    const { executeOp } = await import('../../src/ops/executor.js')
    process.env.WALNUT_TEST_RUN = 'cli-probe'
    try {
      const out = await executeOp('task_create', { title: 'CLI probe', project: 'Real Room', record_only: true },
        { apiBase: `http://localhost:${port}/api/v1`, origin: '__local__', callerMode: 'human' })
      expect(out.ok).toBe(true)
      const { listTasks } = await import('../../src/core/task-manager.js')
      const made = (await listTasks()).find((t) => t.title === 'CLI probe')
      expect(made?.plugin_only).toBe('@test-run')
    } finally {
      delete process.env.WALNUT_TEST_RUN
    }
  })

  it('deleting a test task removes its session records; a real task\'s are only unlinked', async () => {
    const st = await import('../../src/core/session-tracker.js')
    const r = await api('POST', '/api/tasks', { title: 'Probe with session' }, TEST)
    const withSession = r.data.task.id
    await st.createSessionRecord('test-run-sess-000001', withSession, '', '/tmp', { title: 'probe session', initialProcessStatus: 'stopped' })
    await st.createSessionRecord('real-run-sess-000001', real, 'Real Room', '/tmp', { title: 'real session', initialProcessStatus: 'stopped' })
    expect((await api('DELETE', `/api/tasks/${withSession}`)).status).toBeLessThan(300)
    expect(await st.getSessionByClaudeId('test-run-sess-000001')).toBeFalsy()
    const realCopy = (await api('POST', '/api/tasks', { title: 'Real to delete' })).data.task.id
    await st.createSessionRecord('real-run-sess-000002', realCopy, '', '/tmp', { title: 'real session 2', initialProcessStatus: 'stopped' })
    expect((await api('DELETE', `/api/tasks/${realCopy}`)).status).toBeLessThan(300)
    expect(await st.getSessionByClaudeId('real-run-sess-000002')).toBeTruthy()
    // A session older than the test task (an existing one a test linked to it) is only unlinked.
    await st.createSessionRecord('older-sess-00000001', 'nobody-yet', '', '/tmp', { title: 'older', initialProcessStatus: 'stopped' })
    await new Promise((r) => setTimeout(r, 15))
    const linked = (await api('POST', '/api/tasks', { title: 'Probe linking an old session' }, TEST)).data.task.id
    await st.updateSessionRecord('older-sess-00000001', { taskId: linked })
    expect((await api('DELETE', `/api/tasks/${linked}`)).status).toBeLessThan(300)
    expect(await st.getSessionByClaudeId('older-sess-00000001')).toBeTruthy()
  })

  it('the sweep removes idle test objects with their sessions, and nothing else', async () => {
    const st = await import('../../src/core/session-tracker.js')
    await st.createSessionRecord('test-run-sess-000002', probe, 'Probe Room', '/tmp', { title: 'probe 2', initialProcessStatus: 'stopped' })
    const { sweepTestRunsOnce } = await import('../../src/core/test-run-sweep.js')
    // Fresh: nothing goes.
    expect(await sweepTestRunsOnce(Date.now(), 6 * 3_600_000)).toEqual({ tasks: [], projects: [] })
    const later = Date.now() + 7 * 3_600_000
    const swept = await sweepTestRunsOnce(later, 6 * 3_600_000)
    expect(swept.tasks).toEqual(expect.arrayContaining([probe, child]))
    expect(swept.projects).toEqual(expect.arrayContaining(['Probe Room', 'Probe Org Room', 'Probe']))
    expect(swept.projects).not.toContain('Probe Shared')
    expect(swept.projects).not.toContain('Probe Lead Room')
    const { listTasks, getProjectRecord } = await import('../../src/core/task-manager.js')
    const left = await listTasks()
    expect(left.filter((t) => t.plugin_only === '@test-run')).toEqual([])
    expect(left.map((t) => t.id)).toContain(real)
    expect(left.some((t) => t.org_role === 'main')).toBe(true)
    expect(await getProjectRecord('Probe Room')).toBeNull()
    expect(await getProjectRecord('Real Room')).not.toBeNull()
    expect(await st.getSessionByClaudeId('test-run-sess-000002')).toBeFalsy()
    expect(await st.getSessionByClaudeId('real-run-sess-000001')).toBeTruthy()
    // A project name a test run used is free for real work afterwards (no tombstone).
    const again = await api('POST', '/api/tasks', { title: 'Real now', project: 'Probe Room' })
    expect(again.data.task.project).toBe('Probe Room')
  })
})
