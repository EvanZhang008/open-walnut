/**
 * A start requested by a worker session runs where the worker runs
 * (prepareLaunch in src/core/sessions/task-start.ts + inheritedLaunchPair).
 *
 * The rule: a task with no place of its own (no cwd on it or its parent chain,
 * no host or cwd in the request) that belongs to the caller's project takes the
 * caller's host AND cwd as one pair. Anything named or recorded wins, another
 * project uses its own defaults, and the Personal AI is never a source.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-start-caller'))
const mocks = vi.hoisted(() => ({
  getTask: vi.fn(), getProjectMetadata: vi.fn(), linkSession: vi.fn(), updateTaskRaw: vi.fn(),
  getSessionsForTask: vi.fn(), createSessionRecord: vi.fn(), updateSessionRecord: vi.fn(), deleteSessionRecords: vi.fn(),
  resolveCaller: vi.fn(), startSession: vi.fn(), getConfig: vi.fn(), ensureTaskDirOnHost: vi.fn(),
}))
vi.mock('../../src/core/sessions/task-dir-place.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/sessions/task-dir-place.js')>()),
  taskDirForHost: async (taskId: string, host?: string | null) => (host && host !== '__local__' && host !== 'local' ? `/home/me/.local/state/open-walnut/tasks/${taskId}` : `/Users/me/.local/state/open-walnut/tasks/${taskId}`),
  ensureTaskDirOnHost: mocks.ensureTaskDirOnHost,
}))
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: mocks.getTask, getProjectMetadata: mocks.getProjectMetadata, linkSession: mocks.linkSession,
  updateTaskRaw: mocks.updateTaskRaw, listFolderLabels: async () => new Map(),
}))
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: mocks.getSessionsForTask,
  createSessionRecord: mocks.createSessionRecord,
  updateSessionRecord: mocks.updateSessionRecord,
  deleteSessionRecords: mocks.deleteSessionRecords,
}))
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ resolveCaller: mocks.resolveCaller }))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: mocks.getConfig }))
vi.mock('../../src/providers/claude-code-session.js', () => ({ sessionRunner: { startSession: mocks.startSession } }))

import { startSessionForTask } from '../../src/core/sessions/task-start.js'
import { __setFolderExistsForTesting } from '../../src/core/sessions/launch-place.js'

const CALLER_TASK = { id: 't-caller', title: 'Refactor the fixture', project: 'marina' }
const tasks: Record<string, Record<string, unknown>> = {}

function callerSession(extra: Record<string, unknown> = {}) {
  mocks.resolveCaller.mockResolvedValue({
    kind: 'session',
    record: { claudeSessionId: 'sid-caller', taskId: CALLER_TASK.id, host: '', cwd: '/repo/marina', ...extra },
  })
}

async function launchOf(task: Record<string, unknown>, params: Record<string, unknown> = {}) {
  tasks[task.id as string] = task
  await startSessionForTask({ taskIdPrefix: task.id as string, source: 'test', callerSid: 'sid-caller', expectReply: false, ...params })
  const launch = mocks.startSession.mock.calls.at(-1)![0] as { cwd: string; host?: string }
  // Local is spelled '' or undefined by the launcher; compare places, not spellings.
  return { cwd: launch.cwd, host: launch.host || '' }
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const k of Object.keys(tasks)) delete tasks[k]
  tasks[CALLER_TASK.id] = CALLER_TASK
  mocks.getTask.mockImplementation(async (id: string) => {
    const t = tasks[id]
    if (!t) throw new Error(`No task found matching ID prefix "${id}"`)
    return t
  })
  mocks.getProjectMetadata.mockResolvedValue({ default_cwd: '/srv/project-default' })
  mocks.getSessionsForTask.mockResolvedValue([])
  mocks.updateTaskRaw.mockResolvedValue({ changed: true })
  mocks.updateSessionRecord.mockResolvedValue({})
  mocks.getConfig.mockResolvedValue({ hosts: { devbox: { hostname: 'devbox.invalid' } } })
  mocks.startSession.mockImplementation(async (data: { preassignedSessionId: string }) => ({ claudeSessionId: data.preassignedSessionId }))
  mocks.ensureTaskDirOnHost.mockImplementation(async (taskId: string, host?: string) => ({ path: `/home/me/.local/state/open-walnut/tasks/${taskId}`, host: host ?? '__local__' }))
  callerSession()
  // Which folders exist on which host (a recorded cwd set for a host before any session ran there).
  remoteFolders.clear()
  __setFolderExistsForTesting(async (host, dir) => remoteFolders.has(`${host}:${dir}`))
})
const remoteFolders = new Set<string>()

describe('a worker starting another task of its own project', () => {
  it('with no place of its own: the caller cwd, on the caller host', async () => {
    const launch = await launchOf({ id: 't-sib', title: 'Sibling', project: 'marina' })
    expect(launch).toMatchObject({ cwd: '/repo/marina', host: '' })
  })

  it('a remote caller brings its host along with its cwd', async () => {
    callerSession({ host: 'devbox', cwd: '/home/me/marina' })
    const launch = await launchOf({ id: 't-sib', title: 'Sibling', project: 'MARINA' })
    expect(launch).toMatchObject({ cwd: '/home/me/marina', host: 'devbox' })
  })

  it('a task with its own cwd keeps it and the project host', async () => {
    const launch = await launchOf({ id: 't-sib', title: 'Sibling', project: 'marina', cwd: '/repo/own' })
    expect(launch).toMatchObject({ cwd: '/repo/own', host: '' })
  })

  it('a parent chain cwd also counts as a place of its own', async () => {
    tasks['t-parent'] = { id: 't-parent', title: 'Parent', project: 'marina', cwd: '/repo/parent' }
    const launch = await launchOf({ id: 't-child', title: 'Child', project: 'marina', parent_task_id: 't-parent' })
    expect(launch.cwd).toBe('/repo/parent')
  })

  it('an explicit host or cwd in the request wins and the pair never splits', async () => {
    callerSession({ host: 'devbox', cwd: '/home/me/marina' })
    const named = await launchOf({ id: 't-a', title: 'A', project: 'marina' }, { host: '__local__' })
    expect(named).toMatchObject({ host: '', cwd: '/srv/project-default' })
    const pathOnly = await launchOf({ id: 't-b', title: 'B', project: 'marina' }, { cwd: '/explicit' })
    expect(pathOnly).toMatchObject({ host: '', cwd: '/explicit' })
  })
})

describe('no inheritance', () => {
  it('for a task in another project: that project\'s defaults', async () => {
    const launch = await launchOf({ id: 't-acme', title: 'Acme', project: 'acme' })
    expect(launch).toMatchObject({ cwd: '/srv/project-default', host: '' })
  })

  it('from the Personal AI', async () => {
    tasks[CALLER_TASK.id] = { ...CALLER_TASK, walnut_agent: true }
    const launch = await launchOf({ id: 't-sib', title: 'Sibling', project: 'marina' })
    expect(launch.cwd).toBe('/srv/project-default')
  })

  it('from a human or external caller', async () => {
    mocks.resolveCaller.mockResolvedValue({ kind: 'human' })
    expect((await launchOf({ id: 't-1', title: 'One', project: 'marina' })).cwd).toBe('/srv/project-default')
    mocks.resolveCaller.mockResolvedValue({ kind: 'external' })
    expect((await launchOf({ id: 't-2', title: 'Two', project: 'marina' })).cwd).toBe('/srv/project-default')
  })

  it('when the caller host is no longer configured: project defaults, not a 400', async () => {
    callerSession({ host: 'retired-box', cwd: '/home/me/marina' })
    const launch = await launchOf({ id: 't-sib', title: 'Sibling', project: 'marina' })
    expect(launch).toMatchObject({ cwd: '/srv/project-default', host: '' })
  })
})

// 2026-10-31: a lead on the Mac created a task with host "clouddev" and no cwd; its start took the
// lead's Mac folder through the parent chain and died on a path that exists only on the Mac.
describe('a start that names another host never takes a folder from another machine', () => {
  const taskDir = (id: string) => `/home/me/.local/state/open-walnut/tasks/${id}`

  it('a parent chain cwd (a folder on the project\'s default host) stays behind: the task directory there', async () => {
    tasks['t-lead'] = { id: 't-lead', title: 'Lead', project: 'marina', cwd: '/Users/me/marina' }
    const launch = await launchOf({ id: 't-sub', title: 'Sub', project: 'marina', parent_task_id: 't-lead' }, { host: 'devbox' })
    expect(launch).toEqual({ cwd: taskDir('t-sub'), host: 'devbox' })
    expect(mocks.ensureTaskDirOnHost).toHaveBeenCalledWith('t-sub', 'devbox')
  })

  it('the task\'s own recorded cwd and the project default_cwd stay behind too', async () => {
    expect(await launchOf({ id: 't-own', title: 'Own', project: 'marina', cwd: '/Users/me/own' }, { host: 'devbox' }))
      .toEqual({ cwd: taskDir('t-own'), host: 'devbox' })
    expect(await launchOf({ id: 't-def', title: 'Def', project: 'marina' }, { host: 'devbox' }))
      .toEqual({ cwd: taskDir('t-def'), host: 'devbox' })
  })

  it('a folder that lives on the named host is kept: the project default on its default host, a cwd a session ran in there', async () => {
    mocks.getProjectMetadata.mockResolvedValue({ default_host: 'devbox', default_cwd: '/home/me/marina' })
    expect(await launchOf({ id: 't-d', title: 'D', project: 'marina' }, { host: 'devbox' })).toEqual({ cwd: '/home/me/marina', host: 'devbox' })
    mocks.getProjectMetadata.mockResolvedValue({ default_cwd: '/srv/project-default' })
    // The parent recorded a folder its own session worked in on devbox.
    tasks['t-ran'] = { id: 't-ran', title: 'Ran', project: 'marina', cwd: '/home/me/ran' }
    mocks.getSessionsForTask.mockImplementation(async (id: string) => (id === 't-ran'
      ? [{ claudeSessionId: 's-ran', taskId: 't-ran', host: 'devbox', cwd: '/home/me/ran/sub', process_status: 'idle', lastActiveAt: '2026-10-30T00:00:00Z' }]
      : []))
    expect(await launchOf({ id: 't-kid', title: 'Kid', project: 'marina', parent_task_id: 't-ran' }, { host: 'devbox' }))
      .toEqual({ cwd: '/home/me/ran', host: 'devbox' })
    // The same parent's folder never rides to this Mac.
    expect(await launchOf({ id: 't-kid2', title: 'Kid', project: 'marina', parent_task_id: 't-ran' }, { host: '__local__' }))
      .toEqual({ cwd: '/srv/project-default', host: '' })
  })

  it('a cwd set for the named host before any session ran there is kept when it exists there', async () => {
    remoteFolders.add('devbox:/home/me/set-by-hand')
    expect(await launchOf({ id: 't-hand', title: 'Hand', project: 'marina', cwd: '/home/me/set-by-hand' }, { host: 'devbox' }))
      .toEqual({ cwd: '/home/me/set-by-hand', host: 'devbox' })
  })

  it('a start with no host keeps the recorded folder on the default host, as before', async () => {
    tasks['t-lead'] = { id: 't-lead', title: 'Lead', project: 'marina', cwd: '/Users/me/marina' }
    expect(await launchOf({ id: 't-sub2', title: 'Sub', project: 'marina', parent_task_id: 't-lead' })).toEqual({ cwd: '/Users/me/marina', host: '' })
    expect(mocks.ensureTaskDirOnHost).not.toHaveBeenCalled()
  })
})
