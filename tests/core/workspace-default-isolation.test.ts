/**
 * A code task starts in an isolated workspace by default (src/core/workspaces/default-isolation.ts):
 * which starts and folders count, which setting wins, and which provider makes it.
 * The settings, the host's detect answer and the task store are fakes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Task } from '../../src/core/types.js'
import type { WorkspaceCandidate } from '../../src/core/workspaces/types.js'
import {
  __setDefaultWorkspaceDepsForTesting, defaultProvider, defaultWorkspaceFor, draftDefaultAsk, isolationOn,
  NOT_NEW_WORK, notACodeFolder, notACodeTaskStart, readProjectIsolation,
} from '../../src/core/workspaces/default-isolation.js'
import { KEEP_SOURCES } from '../../src/core/sessions/start-placement.js'
import { EXPERIMENTAL_FEATURES } from '../../src/core/experimental.js'
import { checkLaunchDefaultsShape, ProjectSettingsError } from '../../src/core/sessions/project-launch-defaults.js'

const git: WorkspaceCandidate = { provider: 'git-worktree', displayName: 'Git worktree', priority: 10, builtin: true, claimed: true, root: '/r/app' }
const plugin: WorkspaceCandidate = {
  provider: 'monorepo', displayName: 'Monorepo workspace', priority: 50, builtin: false, claimed: true, root: '/r/ws',
  inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['fresh', 'reuse'], default: 'fresh' } } },
}
const needsPackages: WorkspaceCandidate = {
  ...plugin, inputSchema: { type: 'object', properties: { packages: { type: 'array', title: 'Packages' } }, required: ['packages'] },
}

function task(t: Partial<Task> = {}): Task {
  return { id: 't1', title: 'Fix parser', phase: 'TODO', project: 'App', session_ids: [], cwd: '/r/app', ...t } as unknown as Task
}

afterEach(() => __setDefaultWorkspaceDepsForTesting(null))

describe('which setting wins', () => {
  it('the start, then the project, then the global experiment', () => {
    expect(isolationOn({ globalOn: true })).toBe(true)
    expect(isolationOn({ globalOn: false })).toBe(false)
    expect(isolationOn({ globalOn: false, project: 'on' })).toBe(true)
    expect(isolationOn({ globalOn: true, project: 'off' })).toBe(false)
    expect(isolationOn({ globalOn: true, project: 'on', optOut: true })).toBe(false)
  })

  it('reads only on/off from the project, and refuses anything else on write', () => {
    expect(readProjectIsolation({ isolated_workspace: 'on' })).toBe('on')
    expect(readProjectIsolation({ isolated_workspace: 'off' })).toBe('off')
    expect(readProjectIsolation({ isolated_workspace: true })).toBeUndefined()
    expect(readProjectIsolation(null)).toBeUndefined()
    expect(() => checkLaunchDefaultsShape({ isolated_workspace: 'yes' })).toThrow(ProjectSettingsError)
    expect(checkLaunchDefaultsShape({ isolated_workspace: 'off' })).toEqual({ isolated_workspace: 'off' })
    expect(checkLaunchDefaultsShape({ isolated_workspace: undefined })).toEqual({ isolated_workspace: undefined })
  })

  it('ships as an experiment that is off unless the user turns it on', () => {
    expect(EXPERIMENTAL_FEATURES.find((f) => f.id === 'isolated_workspace_by_default')?.default).toBe(false)
  })
})

describe('which starts are a code task\'s new work', () => {
  it('a fresh ordinary task is', () => {
    expect(notACodeTaskStart(task(), { source: 'api-v1' })).toBeNull()
  })

  it.each([
    ['a start that names its own workspace', task(), { workspace: { provider: 'git-worktree' } }],
    ['an opt-out', task(), { noWorkspace: true }],
    ['a task with a workspace', task({ workspace: { provider: 'git-worktree', host: '__local__', anchor: '/r/app', repos: [], state: 'removed' } }), {}],
    ['a continue', task({ session_id: 's1' }), {}],
    ['a continue of an older task', task({ session_ids: ['s0'] }), {}],
    ['a complete task', task({ phase: 'COMPLETE' }), {}],
    ['a lead', task({ org_role: 'lead' }), {}],
    ['Main', task({ org_role: 'main' }), {}],
    ['a Walnut agent', task({ walnut_agent: true }), {}],
    ['a router area task', task({ router_area_id: 'a1' }), {}],
    ['an idle start', task(), { idle: true }],
    ['a confirmed launch', task(), { startAttemptId: '00000000-0000-4000-8000-000000000000' }],
  ] as const)('%s is not', (_name, t, params) => {
    expect(notACodeTaskStart(t, { source: 'api-v1', ...params })).not.toBeNull()
  })

  it('every source that continues, moves or recovers a session is excluded (the class, not a list copy)', () => {
    for (const source of KEEP_SOURCES) expect(notACodeTaskStart(task(), { source })).not.toBeNull()
    for (const source of NOT_NEW_WORK) expect(notACodeTaskStart(task(), { source })).not.toBeNull()
    expect(notACodeTaskStart(task(), { source: 'routine-run' })).not.toBeNull()
  })
})

describe('which folders', () => {
  it('a repository folder is; a task directory (its own or another task\'s) and a lead\'s workspace are not', () => {
    expect(notACodeFolder('/r/app/src', {})).toBeNull()
    expect(notACodeFolder('', {})).toMatch(/no folder/)
    expect(notACodeFolder('/state/tasks/t1/repo', { taskDirRoot: '/state/tasks' })).toMatch(/task directory/)
    // A host whose root Walnut has not heard: the default layout still counts.
    expect(notACodeFolder('/home/u/.local/state/open-walnut/tasks/other-task/open-walnut', {})).toMatch(/task directory/)
    expect(notACodeFolder('/h/.open-walnut-worktrees/app/lead-x/pkg', { workspaceRoots: ['/h/.open-walnut-worktrees/app/lead-x'] })).toMatch(/inside the workspace/)
    expect(notACodeFolder('/h/.open-walnut-worktrees/app/lead-xy', { workspaceRoots: ['/h/.open-walnut-worktrees/app/lead-x'] })).toBeNull()
  })
})

describe('which provider', () => {
  it('the claiming provider with the highest priority, a plugin over git, with its field defaults', () => {
    expect(defaultProvider([git, plugin]).pick).toEqual({ provider: 'monorepo', inputs: { mode: 'fresh' }, displayName: 'Monorepo workspace' })
    expect(defaultProvider([git, { ...plugin, claimed: false }]).pick).toEqual({ provider: 'git-worktree', inputs: {}, displayName: 'Git worktree' })
  })

  it('a plugin whose detect step suggested the required fields is the default after all', () => {
    expect(defaultProvider([git, { ...needsPackages, inputs: { packages: ['alpha'], stray: 'x' } }]).pick)
      .toEqual({ provider: 'monorepo', inputs: { packages: ['alpha'] }, displayName: 'Monorepo workspace' })
  })

  it('none when nothing claims the folder, or the top one needs fields nobody gave (never a lower one in its place)', () => {
    expect(defaultProvider([{ ...git, claimed: false }])).toEqual({ pick: null, why: 'no provider claims this folder' })
    expect(defaultProvider([git, needsPackages])).toEqual({ pick: null, why: 'Monorepo workspace needs Packages' })
  })
})

describe('defaultWorkspaceFor', () => {
  function deps(over: { global?: boolean; project?: 'on' | 'off'; candidates?: WorkspaceCandidate[]; degraded?: string; tasks?: Record<string, Task> } = {}) {
    const asked: Array<{ cwd: string; host: string }> = []
    __setDefaultWorkspaceDepsForTesting({
      globalOn: async () => over.global ?? true,
      projectIsolation: async () => over.project,
      candidates: async (cwd, host) => { asked.push({ cwd, host }); return { candidates: over.candidates ?? [git], ...(over.degraded ? { degraded: over.degraded } : {}) } },
      taskDirRoot: async () => '/state/tasks',
      listTasks: async () => Object.values(over.tasks ?? {}),
    })
    return asked
  }
  const place = (p: { cwd?: string; host?: string; createTaskDir?: boolean } = {}) => async () => ({ cwd: '/r/app', ...p })

  it('picks git for a repository folder on the start\'s host', async () => {
    const asked = deps()
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1' }, place({ host: 'dev' }))).toEqual({ host: 'dev', provider: 'git-worktree', inputs: {}, displayName: 'Git worktree' })
    expect(asked).toEqual([{ cwd: '/r/app', host: 'dev' }])
  })

  it('picks the plugin that claims the folder over git', async () => {
    deps({ candidates: [git, plugin] })
    expect((await defaultWorkspaceFor(task(), { source: 'api-v1' }, place()))?.provider).toBe('monorepo')
  })

  it('follows the settings: off globally, on for the project; on globally, off for the project or the start', async () => {
    deps({ global: false })
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1' }, place())).toBeNull()
    deps({ global: false, project: 'on' })
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1' }, place())).not.toBeNull()
    deps({ project: 'off' })
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1' }, place())).toBeNull()
    deps()
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1', noWorkspace: true }, place())).toBeNull()
  })

  it('never asks the host for a start that is not a code task\'s, or in a task directory', async () => {
    const asked = deps()
    expect(await defaultWorkspaceFor(task({ org_role: 'vp' }), { source: 'api-v1' }, place())).toBeNull()
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1' }, place({ createTaskDir: true, cwd: '/state/tasks/t1' }))).toBeNull()
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1' }, place({ cwd: '/state/tasks/lead/repo' }))).toBeNull()
    expect(asked).toEqual([])
  })

  it('a start inside another task\'s workspace (its lead\'s, say) shares it; one on another host does not count', async () => {
    const lead = task({ id: 'lead', workspace: { provider: 'monorepo', host: '__local__', anchor: '/r/ws', root: '/w/ws/lead', cwd: '/w/ws/lead', repos: [], state: 'ready' } })
    const gone = task({ id: 'gone', workspace: { provider: 'monorepo', host: '__local__', anchor: '/r/ws', root: '/w/ws/gone', repos: [], state: 'removed' } })
    deps({ tasks: { lead, gone }, candidates: [git, plugin] })
    expect(await defaultWorkspaceFor(task({ parent_task_id: 'lead' }), { source: 'api-v1' }, place({ cwd: '/w/ws/lead/src' }))).toBeNull()
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1' }, place({ cwd: '/w/ws/lead/src', host: 'dev' }))).not.toBeNull()
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1' }, place({ cwd: '/w/ws/gone/src' }))).not.toBeNull()
    expect(await defaultWorkspaceFor(task({ parent_task_id: 'lead' }), { source: 'api-v1' }, place({ cwd: '/r/app' }))).not.toBeNull()
  })

  it('a host that cannot say, or a place that cannot be resolved, starts in the folder', async () => {
    deps({ degraded: 'timeout' })
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1' }, place())).toBeNull()
    deps()
    expect(await defaultWorkspaceFor(task(), { source: 'api-v1' }, async () => { throw new Error('needs a cwd') })).toBeNull()
  })

  it('a draft that sent its default before the host answered gets the claiming provider, or none', async () => {
    deps({ candidates: [git, plugin] })
    expect(await draftDefaultAsk('/r/ws', '__local__')).toEqual({ provider: 'monorepo', inputs: { mode: 'fresh' } })
    deps({ candidates: [{ ...git, claimed: false }] })
    expect(await draftDefaultAsk('/r/plain', '__local__')).toBeNull()
    deps({ degraded: 'timeout' })
    expect(await draftDefaultAsk('/r/app', '__local__')).toBeNull()
  })
})
