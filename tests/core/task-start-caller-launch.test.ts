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
  isFallbackFolder: async (cwd: string) => cwd.includes('/.local/state/open-walnut/tasks/'),
}))
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: mocks.getTask, getProjectMetadata: mocks.getProjectMetadata, linkSession: mocks.linkSession,
  updateTaskRaw: mocks.updateTaskRaw, listFolderLabels: async () => new Map(),
  listTasks: async () => Object.values(tasks),
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
    record: { mode: 'bypass', claudeSessionId: 'sid-caller', taskId: CALLER_TASK.id, host: '', cwd: '/repo/marina', ...extra },
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
  it('an Auto caller cannot launch a bypass child, even on another host', async () => {
    callerSession({ mode: 'auto' })
    tasks['t-sib'] = { id: 't-sib', title: 'Sibling', project: 'marina' }
    await expect(startSessionForTask({ taskIdPrefix: 't-sib', callerSid: 'sid-caller', mode: 'bypass', host: 'devbox', cwd: '/work', expectReply: false }))
      .rejects.toThrow('cannot start a task in bypass')
    expect(mocks.startSession).not.toHaveBeenCalled()
  })

  it('an unnamed child inherits Auto from its caller through the actual launcher', async () => {
    callerSession({ mode: 'auto' })
    await launchOf({ id: 't-sib', title: 'Sibling', project: 'marina' })
    expect(mocks.startSession.mock.calls.at(-1)![0].mode).toBe('auto')
  })

  it('with no place of its own: the caller cwd, on the caller host', async () => {
    const launch = await launchOf({ id: 't-sib', title: 'Sibling', project: 'marina' })
    expect(launch).toMatchObject({ cwd: '/repo/marina', host: '' })
  })

  it('a remote caller brings its host along with its cwd', async () => {
    callerSession({ host: 'devbox', cwd: '/home/me/marina' })
    const launch = await launchOf({ id: 't-sib', title: 'Sibling', project: 'MARINA' })
    expect(launch).toMatchObject({ cwd: '/home/me/marina', host: 'devbox' })
  })

  it('a caller in its own task directory hands on its host only: the new task works in its own directory there', async () => {
    // The project's default host is this Mac with a default folder; neither applies on devbox.
    callerSession({ host: 'devbox', cwd: '/home/me/.local/state/open-walnut/tasks/t-caller' })
    const remote = await launchOf({ id: 't-sib', title: 'Sibling', project: 'marina' })
    expect(remote).toEqual({ cwd: '/home/me/.local/state/open-walnut/tasks/t-sib', host: 'devbox' })
    expect(mocks.ensureTaskDirOnHost).toHaveBeenCalledWith('t-sib', 'devbox')
    callerSession({ host: '', cwd: '/Users/me/.local/state/open-walnut/tasks/t-caller' })
    mocks.getProjectMetadata.mockResolvedValue({})
    const local = await launchOf({ id: 't-sib2', title: 'Sibling', project: 'marina' })
    expect(local).toEqual({ cwd: '/Users/me/.local/state/open-walnut/tasks/t-sib2', host: '' })
  })

  it('a task with its own cwd keeps it and the project host', async () => {
    remoteFolders.add('__local__:/repo/own')
    const launch = await launchOf({ id: 't-sib', title: 'Sibling', project: 'marina', cwd: '/repo/own' })
    expect(launch).toMatchObject({ cwd: '/repo/own', host: '' })
  })

  it('a parent chain cwd also counts as a place of its own', async () => {
    remoteFolders.add('__local__:/repo/parent')
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

  it('from the Personal AI in its Ask project', async () => {
    tasks[CALLER_TASK.id] = { ...CALLER_TASK, walnut_agent: true, project: 'Ask Walnut' }
    const launch = await launchOf({ id: 't-sib', title: 'Sibling', project: 'marina' })
    expect(launch.cwd).toBe('/srv/project-default')
  })

  it('inherits the caller location after an Ask moves into a work project', async () => {
    tasks[CALLER_TASK.id] = { ...CALLER_TASK, walnut_agent: true }
    callerSession({ host: 'devbox', cwd: '/home/me/marina' })
    expect(await launchOf({ id: 't-sib', title: 'Sibling', project: 'marina' })).toMatchObject({ cwd: '/home/me/marina', host: 'devbox' })
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
    remoteFolders.add('__local__:/Users/me/marina')
    tasks['t-lead'] = { id: 't-lead', title: 'Lead', project: 'marina', cwd: '/Users/me/marina' }
    expect(await launchOf({ id: 't-sub2', title: 'Sub', project: 'marina', parent_task_id: 't-lead' })).toEqual({ cwd: '/Users/me/marina', host: '' })
    expect(mocks.ensureTaskDirOnHost).not.toHaveBeenCalled()
  })
})

// 2026-11-16: the project's default_host moved from this Mac to devbox; tasks made before, never
// started, still recorded the Mac checkout. Read as a folder on the new default host, their starts
// died on "Working directory no longer exists on devbox". A folder no session ran in is looked up
// on the host the start runs on.
describe('a recorded folder no session ran in is a place only on a host that has it', () => {
  const MAC = '/Users/me/marina'
  beforeEach(() => {
    mocks.getProjectMetadata.mockResolvedValue({ default_host: 'devbox', default_cwd: '/home/me/marina' })
    remoteFolders.add(`__local__:${MAC}`)
    // A person's start, or a lead's: no caller place to land beside.
    mocks.resolveCaller.mockResolvedValue({ kind: 'human' })
  })

  it('a worker on this Mac starting it keeps the recorded folder here: a recorded place wins over the caller\'s', async () => {
    callerSession()
    expect(await launchOf({ id: 't-oldw', title: 'Old', project: 'marina', cwd: MAC })).toEqual({ cwd: MAC, host: '' })
  })

  it('a folder missing everywhere stays the default host\'s, so the start fails loudly there, as before', async () => {
    expect(await launchOf({ id: 't-typo', title: 'Typo', project: 'marina', cwd: '/home/me/typo' }))
      .toEqual({ cwd: '/home/me/typo', host: 'devbox' })
    expect(await launchOf({ id: 't-typo2', title: 'Typo', project: 'marina', cwd: '/home/me/typo' }, { host: 'devbox' }))
      .toEqual({ cwd: '/home/me/typo', host: 'devbox' })
  })

  it('a Mac folder a parent\'s session ran in here gives way on the default host: an unnamed start stays there', async () => {
    tasks['t-macran'] = { id: 't-macran', title: 'Ran here', project: 'marina', cwd: MAC }
    mocks.getSessionsForTask.mockImplementation(async (id: string) => (id === 't-macran'
      ? [{ claudeSessionId: 's-mac', taskId: 't-macran', host: '__local__', cwd: MAC, process_status: 'idle', lastActiveAt: '2026-11-15T00:00:00Z' }]
      : []))
    expect(await launchOf({ id: 't-mackid', title: 'Kid', project: 'marina', parent_task_id: 't-macran' })).toEqual({ cwd: '/home/me/marina', host: 'devbox' })
    // A worker on this Mac starting it keeps the parent's folder here.
    callerSession()
    expect(await launchOf({ id: 't-mackid2', title: 'Kid', project: 'marina', parent_task_id: 't-macran' })).toEqual({ cwd: MAC, host: '' })
  })

  it('the same Mac folder that the default host also has is kept there', async () => {
    remoteFolders.add(`devbox:${MAC}`)
    expect(await launchOf({ id: 't-both', title: 'Both', project: 'marina', cwd: MAC })).toEqual({ cwd: MAC, host: 'devbox' })
  })

  it('a start on the default host, named or not, takes the project default_cwd there', async () => {
    expect(await launchOf({ id: 't-old', title: 'Old', project: 'marina', cwd: MAC }, { host: 'devbox' }))
      .toEqual({ cwd: '/home/me/marina', host: 'devbox' })
    expect(await launchOf({ id: 't-old2', title: 'Old', project: 'marina', cwd: MAC }))
      .toEqual({ cwd: '/home/me/marina', host: 'devbox' })
    // The same through the parent chain.
    tasks['t-oldlead'] = { id: 't-oldlead', title: 'Lead', project: 'marina', cwd: MAC }
    expect(await launchOf({ id: 't-oldkid', title: 'Kid', project: 'marina', parent_task_id: 't-oldlead' }))
      .toEqual({ cwd: '/home/me/marina', host: 'devbox' })
  })

  it('a recorded folder that is on the default host is kept', async () => {
    remoteFolders.add('devbox:/home/me/marina-wt')
    expect(await launchOf({ id: 't-wt', title: 'Wt', project: 'marina', cwd: '/home/me/marina-wt' }))
      .toEqual({ cwd: '/home/me/marina-wt', host: 'devbox' })
    expect(await launchOf({ id: 't-wt2', title: 'Wt', project: 'marina', cwd: '/home/me/marina-wt' }, { host: 'devbox' }))
      .toEqual({ cwd: '/home/me/marina-wt', host: 'devbox' })
  })

  it('a default host that cannot say keeps the recorded folder, as before', async () => {
    __setFolderExistsForTesting(async () => undefined)
    expect(await launchOf({ id: 't-quiet', title: 'Q', project: 'marina', cwd: '/home/me/marina-wt' }))
      .toEqual({ cwd: '/home/me/marina-wt', host: 'devbox' })
    expect(await launchOf({ id: 't-quiet2', title: 'Q', project: 'marina', cwd: '/home/me/marina-wt' }, { host: 'devbox' }))
      .toEqual({ cwd: '/home/me/marina-wt', host: 'devbox' })
  })

  it('a folder a session ran in on the default host is kept without asking the host', async () => {
    const probe = vi.fn(async () => false)
    __setFolderExistsForTesting(probe)
    tasks['t-ran2'] = { id: 't-ran2', title: 'Ran', project: 'marina', cwd: '/home/me/ran2' }
    mocks.getSessionsForTask.mockImplementation(async (id: string) => (id === 't-ran2'
      ? [{ claudeSessionId: 's-ran2', taskId: 't-ran2', host: 'devbox', cwd: '/home/me/ran2', process_status: 'idle', lastActiveAt: '2026-11-15T00:00:00Z' }]
      : []))
    expect(await launchOf({ id: 't-ran2kid', title: 'Kid', project: 'marina', parent_task_id: 't-ran2' }))
      .toEqual({ cwd: '/home/me/ran2', host: 'devbox' })
    expect(probe).not.toHaveBeenCalled()
  })
})

// 2026-11-16: the Walnut project's default host moved to a Linux dev host, but its lead's session
// ran on the Mac, and every task the lead started landed beside it on the Mac.
describe('a VP or lead hands on its place only on its project default host', () => {
  const LEAD = { ...CALLER_TASK, org_role: 'lead' }
  beforeEach(() => { tasks[CALLER_TASK.id] = LEAD })

  it('a lead on this Mac, project default host devbox: the project default_cwd on devbox', async () => {
    mocks.getProjectMetadata.mockResolvedValue({ default_host: 'devbox', default_cwd: '/home/me/marina' })
    expect(await launchOf({ id: 't-lw', title: 'Work', project: 'marina' })).toEqual({ cwd: '/home/me/marina', host: 'devbox' })
  })

  it('a lead\'s own recorded Mac folder down the parent chain gives way too', async () => {
    mocks.getProjectMetadata.mockResolvedValue({ default_host: 'devbox', default_cwd: '/home/me/marina' })
    remoteFolders.add('__local__:/repo/marina')
    tasks[CALLER_TASK.id] = { ...LEAD, cwd: '/repo/marina' }
    mocks.getSessionsForTask.mockImplementation(async (id: string) => (id === CALLER_TASK.id
      ? [{ claudeSessionId: 'sid-caller', taskId: CALLER_TASK.id, host: '__local__', cwd: '/repo/marina', process_status: 'idle', lastActiveAt: '2026-11-16T00:00:00Z' }]
      : []))
    expect(await launchOf({ id: 't-lw2', title: 'Work', project: 'marina', parent_task_id: CALLER_TASK.id }))
      .toEqual({ cwd: '/home/me/marina', host: 'devbox' })
  })

  it('a lead on the project default host, or a project with none, hands on its place as before', async () => {
    callerSession({ host: 'devbox', cwd: '/home/me/lead' })
    mocks.getProjectMetadata.mockResolvedValue({ default_host: 'devbox', default_cwd: '/home/me/marina' })
    expect(await launchOf({ id: 't-lw3', title: 'Work', project: 'marina' })).toEqual({ cwd: '/home/me/lead', host: 'devbox' })
    callerSession()
    mocks.getProjectMetadata.mockResolvedValue({ default_cwd: '/srv/project-default' })
    expect(await launchOf({ id: 't-lw4', title: 'Work', project: 'marina' })).toEqual({ cwd: '/repo/marina', host: '' })
  })

  it('a default host with no default_cwd: the task\'s own directory there; a default host gone: beside the lead', async () => {
    mocks.getProjectMetadata.mockResolvedValue({ default_host: 'devbox' })
    expect(await launchOf({ id: 't-lw6', title: 'Work', project: 'marina' }))
      .toEqual({ cwd: '/home/me/.local/state/open-walnut/tasks/t-lw6', host: 'devbox' })
    mocks.getProjectMetadata.mockResolvedValue({ default_host: 'gonebox', default_cwd: '/home/me/marina' })
    expect(await launchOf({ id: 't-lw7', title: 'Work', project: 'marina' })).toEqual({ cwd: '/repo/marina', host: '' })
  })

  it('a worker that is not a lead still keeps its pair off the default host', async () => {
    tasks[CALLER_TASK.id] = CALLER_TASK
    mocks.getProjectMetadata.mockResolvedValue({ default_host: 'devbox', default_cwd: '/home/me/marina' })
    expect(await launchOf({ id: 't-w5', title: 'Work', project: 'marina' })).toEqual({ cwd: '/repo/marina', host: '' })
  })
})
