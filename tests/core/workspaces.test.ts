/**
 * Task workspaces, server half (src/core/workspaces/): the provider registry,
 * the cleanup decisions, the manager's job driving and cleanup, and the start
 * path helpers. The daemon, the task store and the clock are fakes; nothing here
 * spawns git (workspace-core.test.ts covers the host side for real).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Task } from '../../src/core/types.js'
import type { TaskWorkspace, WorkspaceProbeSummary } from '../../src/core/workspaces/types.js'
import {
  __setWorkspacePluginSourceForTesting, validateInputs, workspaceProviderCatalog, sanitizeInputSchema,
} from '../../src/core/workspaces/registry.js'
import { belongsToWorkspace, cleanupDecision, workspaceName } from '../../src/core/workspaces/decisions.js'
import {
  __setWorkspaceManagerDepsForTesting, __settleWorkspaceDriver,
  removeWorkspaceManually, requestWorkspace, retryWorkspace, removalPreview,
} from '../../src/core/workspaces/manager.js'
import { __settleCompletionCheck, onTaskCompleted, onTaskDeleted, onTaskSessionStopped, resumeWorkspaces } from '../../src/core/workspaces/cleanup.js'
import { deferTaskStart, workspaceLaunchPlan, workspaceStartPlace } from '../../src/core/workspaces/launch.js'
import { recordedCwd } from '../../src/core/sessions/task-start.js'
import { workspaceEventAction } from '../../src/core/workspaces/watch.js'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ws-server-')))

let current: Fake | null = null

/** End every job a test left running, so no driver outlives the fakes it was built on. */
async function drain(): Promise<void> {
  const f = current
  if (!f) return
  for (const [id, t] of f.tasks) {
    const ws = t.workspace
    if (ws?.job_id && (ws.state === 'creating' || ws.state === 'removing')) {
      f.jobs.set(ws.job_id, { state: 'failed', error: 'test over' })
      await __settleWorkspaceDriver(id)
    }
  }
}

afterEach(async () => {
  await drain()
  current = null
  __setWorkspacePluginSourceForTesting(null)
  __setWorkspaceManagerDepsForTesting(null)
})

function writePlugin(name: string, providers: unknown[], files: Record<string, string> = {}): string {
  const dir = path.join(TMP, 'plugins', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ apiVersion: 1, id: name, name, version: '1.0.0', capabilities: { workspace: { providers } } }))
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content)
  return dir
}

describe('registry', () => {
  it('compiles plugin providers from local manifests, with the adapter script read from the plugin folder', async () => {
    const dir = writePlugin('multi', [
      { id: 'multi-repo', displayName: 'Multi', priority: 50, markers: ['ws.json'], command: ['node', '{script}'], script: 'p.mjs',
        inputSchema: { properties: { packages: { type: 'array', title: 'Packages' }, junk: { type: 'object' } }, required: ['packages', 'nope'] } },
      { id: 'git-worktree', command: ['x'] },
      { id: 'no-script', command: ['node', '{script}'] },
      { id: 'escape', command: ['node', '{script}'], script: '../outside.mjs' },
    ], { 'p.mjs': 'console.log(1)\n' })
    fs.writeFileSync(path.join(TMP, 'plugins', 'outside.mjs'), 'x')
    writePlugin('dupe', [{ id: 'multi-repo', command: ['y'] }])
    __setWorkspacePluginSourceForTesting(async () => [
      { id: 'multi', pluginDir: dir, capabilities: ['workspace'] },
      { id: 'dupe', pluginDir: path.join(TMP, 'plugins', 'dupe'), capabilities: ['workspace'] },
      { id: 'other', pluginDir: dir, capabilities: ['sync'] },
    ])
    const cat = await workspaceProviderCatalog()
    expect(cat.providers.map((p) => p.id)).toEqual(['multi-repo', 'git-worktree'])
    expect(cat.config.providers).toHaveLength(1)
    expect(cat.config.providers[0]).toMatchObject({ id: 'multi-repo', command: ['node', '{script}'], script: { name: 'p.mjs', content: 'console.log(1)\n' }, markers: ['ws.json'] })
    expect(cat.providers[0].inputSchema).toEqual({ type: 'object', properties: { packages: { type: 'array', title: 'Packages', items: { type: 'string' } } }, required: ['packages'] })
    expect(cat.warnings.join('\n')).toMatch(/invalid provider id "git-worktree"/)
    expect(cat.warnings.join('\n')).toMatch(/no-script: command names \{script\} but the provider declares no script/)
    expect(cat.warnings.join('\n')).toMatch(/escape: script \.\.\/outside\.mjs is not a file inside the plugin folder/)
    expect(cat.warnings.join('\n')).toMatch(/provider id multi-repo is already taken/)
    expect(cat.config.hash).toMatch(/^[0-9a-f]{16}$/)
    // The same manifests hash the same.
    __setWorkspacePluginSourceForTesting(async () => [{ id: 'multi', pluginDir: dir, capabilities: ['workspace'] }])
    expect((await workspaceProviderCatalog()).config.hash).toBe(cat.config.hash)
  })

  it('with no plugins there is only git-worktree and an empty allowlist', async () => {
    __setWorkspacePluginSourceForTesting(async () => [])
    const cat = await workspaceProviderCatalog()
    expect(cat.providers.map((p) => p.id)).toEqual(['git-worktree'])
    expect(cat.config.providers).toEqual([])
  })

  it('validates inputs against the schema', () => {
    const schema = sanitizeInputSchema({ properties: { packages: { type: 'array', title: 'Packages' }, mode: { type: 'string', enum: ['fresh', 'reuse'] }, quick: { type: 'boolean' } }, required: ['packages'] })
    expect(validateInputs(schema, { packages: 'alpha, beta gamma', extra: 1 })).toEqual({ packages: ['alpha', 'beta', 'gamma'] })
    expect(validateInputs(schema, {})).toBe('Packages is required')
    expect(validateInputs(schema, { packages: ['a'], mode: 'other' })).toBe('mode must be one of: fresh, reuse')
    expect(validateInputs(schema, { packages: ['a'], quick: 'yes' })).toBe('quick must be on or off')
    expect(validateInputs(undefined, { anything: 1 })).toEqual({})
  })
})

const probe = (p: Partial<WorkspaceProbeSummary>): WorkspaceProbeSummary => ({ rootExists: true, clean: true, merged: true, problems: [], repos: [], ...p })
/** This server's WALNUT_HOME (realpath), and another Walnut's: a test server over copied tasks. */
const HOME_A = '/data/walnut-a'
const HOME_B = '/data/walnut-b'
const gitWs: TaskWorkspace = { provider: 'git-worktree', host: '__local__', home: HOME_A, anchor: '/r/repo', root: '/h/.open-walnut-worktrees/repo/x', cwd: '/h/.open-walnut-worktrees/repo/x', branch: 'walnut/x', repos: [], state: 'ready' }
const pluginWs: TaskWorkspace = { ...gitWs, provider: 'multi', branch: undefined, root: '/h/ws/x', cwd: '/h/ws/x' }

describe('cleanup decisions', () => {
  it('completion and deletion remove only clean, merged work', () => {
    for (const trigger of ['complete', 'delete'] as const) {
      expect(cleanupDecision(gitWs, probe({}), trigger).action).toBe('remove')
      expect(cleanupDecision(gitWs, probe({ clean: false, problems: ['x: 2 uncommitted changes'] }), trigger)).toMatchObject({ action: 'keep', reason: 'x: 2 uncommitted changes' })
      expect(cleanupDecision(gitWs, probe({ merged: false, problems: ['branch has commits'] }), trigger)).toMatchObject({ action: 'keep' })
      expect(cleanupDecision(pluginWs, probe({ merged: false, problems: ['a: has commits that are not pushed'] }), trigger)).toMatchObject({ action: 'keep' })
    }
  })
  it('by hand: dirty refused; unmerged git keeps the branch after a confirm; unpushed plugin work refused', () => {
    expect(cleanupDecision(gitWs, probe({ clean: false, problems: ['dirty'] }), 'manual').action).toBe('keep')
    const unmerged = cleanupDecision(gitWs, probe({ merged: false, branchMerged: false }), 'manual')
    expect(unmerged).toMatchObject({ action: 'confirm', requireMerged: false })
    expect(unmerged.plan.join(' ')).toMatch(/Keeps branch walnut\/x/)
    expect(cleanupDecision(gitWs, probe({ branchMerged: true }), 'manual').plan.join(' ')).toMatch(/Deletes branch walnut\/x/)
    expect(cleanupDecision(pluginWs, probe({ merged: false }), 'manual').action).toBe('keep')
    expect(cleanupDecision(pluginWs, probe({ repos: [{ path: '/h/ws/x/src/a', name: 'a', dirty: false, changes: 0, unreadable: false, merged: true, exists: true }] }), 'manual').plan[0]).toMatch(/with 1 repository \(a\)/)
    const two = [{ path: '/h/ws/x/src/a', name: 'a', dirty: false, changes: 0, unreadable: false, merged: true, exists: true }, { path: '/h/ws/x/src/b', name: 'b', dirty: false, changes: 0, unreadable: false, merged: true, exists: true }]
    expect(cleanupDecision(pluginWs, probe({ repos: two }), 'manual').plan[0]).toMatch(/with 2 repositories \(a, b\)/)
  })
  it('a root already gone is just forgotten', () => {
    expect(cleanupDecision(gitWs, probe({ rootExists: false, clean: false }), 'complete').action).toBe('remove')
  })
  it('the confirm plan names the ignored entries a removal deletes too', () => {
    const repo = { path: gitWs.root!, dirty: false, changes: 0, unreadable: false, merged: true, exists: true, ignored: ['.env', 'dist/'], ignoredCount: 9 }
    expect(cleanupDecision(gitWs, probe({ repos: [repo] }), 'manual').plan.join(' '))
      .toMatch(/Also deletes 9 entries git ignores, which no commit holds: \.env, dist\/, and 7 more\./)
    expect(cleanupDecision(gitWs, probe({ repos: [{ ...repo, ignored: undefined, ignoredCount: undefined }] }), 'manual').plan.join(' ')).not.toMatch(/ignores/)
  })
  it('names a workspace after the work, not the placeholder title', () => {
    expect(workspaceName({ id: 'muq1-ab', title: 'Session: repo' }, 'Fix the login redirect loop on Safari please')).toBe('fix-the-login-redirect-loop-on-muq1-ab')
    expect(workspaceName({ id: 'muq1-ab', title: 'Refactor the parser' })).toBe('refactor-the-parser-muq1-ab')
    expect(workspaceName({ id: 'muq1-ab', title: '' })).toBe('muq1-ab')
  })
  it('knows which places belong to a workspace', () => {
    expect(belongsToWorkspace(gitWs, undefined)).toBe(true)
    expect(belongsToWorkspace(gitWs, '/r/repo/')).toBe(true)
    expect(belongsToWorkspace(gitWs, '/h/.open-walnut-worktrees/repo/x/pkg')).toBe(true)
    expect(belongsToWorkspace(gitWs, '/r/other')).toBe(false)
  })
})

// ── manager, over a fake store + daemon ──

interface Fake {
  tasks: Map<string, Task>
  calls: Array<{ cmd: string; params: Record<string, unknown> }>
  jobs: Map<string, Record<string, unknown> | null>
  launched: Array<{ taskId: string; cwd?: string; via: string }>
  notes: Array<{ title: string; body: string }>
  probe: WorkspaceProbeSummary
  busy: boolean
  live: boolean
  launchError?: string
  createReply?: Record<string, unknown>
  /** Runs while the host probes (a reopen racing the completion cleanup). */
  duringProbe?: () => void
}

function fake(): Fake {
  const f: Fake = { tasks: new Map(), calls: [], jobs: new Map(), launched: [], notes: [], probe: probe({}), busy: false, live: false }
  current = f
  let n = 0
  __setWorkspacePluginSourceForTesting(async () => [])
  __setWorkspaceManagerDepsForTesting({
    getTask: async (id) => (f.tasks.has(id) ? structuredClone(f.tasks.get(id)!) : null),
    write: async (id, fn) => {
      const t = f.tasks.get(id)
      if (!t) return null
      const next = fn(t.workspace, t)
      if (!next) return null
      const updated = { ...t, workspace: next }
      f.tasks.set(id, updated)
      return structuredClone(updated)
    },
    rpc: async (_host, cmd, params) => {
      f.calls.push({ cmd, params })
      if (cmd === 'workspace.create') {
        if (f.createReply) return f.createReply
        // Like the daemon: a job id it already knows answers with that job, it does not start over.
        const known = f.jobs.get(String(params.jobId))
        if (known) return { ok: true, jobId: params.jobId, state: known.state, existing: true }
        f.jobs.set(String(params.jobId), { state: 'running', progress: 'Cloning alpha' })
        return { ok: true, jobId: params.jobId, state: 'running' }
      }
      if (cmd === 'workspace.job') return { ok: true, job: f.jobs.has(String(params.jobId)) ? f.jobs.get(String(params.jobId)) : null }
      if (cmd === 'workspace.status') {
        f.duringProbe?.()
        return { ok: true, probe: f.probe }
      }
      if (cmd === 'workspace.remove') {
        // Like the daemon: it probes again and refuses what would lose work.
        const job = !f.probe.clean ? { state: 'failed', error: `kept: ${f.probe.problems.join('; ')}`, code: 'not_clean' }
          : params.requireMerged === true && !f.probe.merged ? { state: 'failed', error: `kept: ${f.probe.problems.join('; ')}`, code: 'not_merged' }
            : { state: 'done', result: { removed: true, branchKept: params.requireMerged === false } }
        f.jobs.set(String(params.jobId), job)
        return { ok: true, jobId: params.jobId, state: 'running' }
      }
      return { ok: false, error: 'unexpected ' + cmd }
    },
    launch: async (task, ws, pending) => {
      if (f.launchError) throw new Error(f.launchError)
      f.launched.push({ taskId: task.id, cwd: ws.cwd, via: pending.via })
    },
    sessionBusy: async () => f.busy,
    hasLiveSession: async () => f.live,
    notify: async (n2) => { f.notes.push({ title: n2.title, body: n2.body }) },
    listTasks: async () => [...f.tasks.values()],
    walnutHome: async () => HOME_A,
    cloudMode: () => false,
    now: () => 1_700_000_000_000,
    sleep: async () => { await new Promise((r) => setImmediate(r)) },
    jobId: () => `job-${++n}`,
  })
  return f
}

function addTask(f: Fake, t: Partial<Task> & { id: string }): Task {
  const task = { title: 'Fix parser', status: 'todo', phase: 'TODO', project: '', priority: 'none', created_at: '', updated_at: '', source: 'local', cwd: '/r/repo', ...t } as unknown as Task
  f.tasks.set(task.id, task)
  return task
}

/** Let the driver tick until the job's fake state is picked up. */
async function finishJob(f: Fake, taskId: string, job: Record<string, unknown> | null) {
  const ws = f.tasks.get(taskId)!.workspace!
  // The driver starts the job a few awaits after the request answers: settle the
  // job only once the host was asked, or the start would overwrite it.
  for (let i = 0; i < 200 && !f.calls.some((c) => c.cmd === 'workspace.create' && c.params.jobId === ws.job_id); i++) {
    await new Promise((r) => setImmediate(r))
  }
  f.jobs.set(ws.job_id!, job)
  await __settleWorkspaceDriver(taskId)
}

describe('manager', () => {
  let f: Fake
  beforeEach(() => { f = fake() })

  it('requests, creates, records the result and starts the waiting session in it', async () => {
    addTask(f, { id: 't1' })
    const pending = { via: 'quick-start' as const, message: 'go', at: 'now' }
    const t = await requestWorkspace('t1', { provider: 'git-worktree', anchor: '/r/repo', inputs: { baseRef: 'main' }, pending })
    expect(t.workspace).toMatchObject({ state: 'creating', provider: 'git-worktree', host: '__local__', home: HOME_A, anchor: '/r/repo', inputs: { baseRef: 'main' }, name: 'fix-parser-t1' })
    // Progress lands on the task while the job runs.
    for (let i = 0; i < 20 && !f.tasks.get('t1')!.workspace!.progress?.startsWith('Cloning'); i++) await new Promise((r) => setImmediate(r))
    expect(f.tasks.get('t1')!.workspace!.progress).toBe('Cloning alpha')
    expect(f.calls.find((c) => c.cmd === 'workspace.create')!.params).toMatchObject({ provider: 'git-worktree', anchor: '/r/repo', baseRef: 'main', name: 'fix-parser-t1' })
    await finishJob(f, 't1', { state: 'done', result: { root: '/w/repo/x', cwd: '/w/repo/x/pkg', branch: 'walnut/x', sourceRepo: '/r/repo', baseRef: { name: 'main', sha: 'abc' }, repos: [{ path: '/w/repo/x' }] } })
    const ws = f.tasks.get('t1')!.workspace!
    expect(ws).toMatchObject({ state: 'ready', root: '/w/repo/x', cwd: '/w/repo/x/pkg', branch: 'walnut/x', source_repo: '/r/repo' })
    expect(ws.pending_start).toBeUndefined()
    expect(ws.progress).toBeUndefined()
    expect(f.launched).toEqual([{ taskId: 't1', cwd: '/w/repo/x/pkg', via: 'quick-start' }])
  })

  it('a failed creation shows the provider error; Retry starts a new job and keeps the name', async () => {
    addTask(f, { id: 't2' })
    await requestWorkspace('t2', { provider: 'git-worktree', anchor: '/r/repo' })
    await finishJob(f, 't2', { state: 'failed', error: 'git worktree add failed: fatal: bad', code: 'git_failed' })
    expect(f.tasks.get('t2')!.workspace).toMatchObject({ state: 'failed', error: 'git worktree add failed: fatal: bad', error_code: 'git_failed' })
    const name = f.tasks.get('t2')!.workspace!.name
    await retryWorkspace('t2')
    const ws = f.tasks.get('t2')!.workspace!
    expect(ws).toMatchObject({ state: 'creating', name })
    expect(ws.error).toBeUndefined()
    expect(ws.job_id).not.toBe(f.calls[0].params.jobId)
  })

  it('a job the host forgot fails with a Retry message, never hangs', async () => {
    addTask(f, { id: 't3' })
    await requestWorkspace('t3', { provider: 'git-worktree', anchor: '/r/repo' })
    await finishJob(f, 't3', null)
    expect(f.tasks.get('t3')!.workspace).toMatchObject({ state: 'failed', error_code: 'lost' })
    expect(f.tasks.get('t3')!.workspace!.error).toMatch(/no record of this job/)
  })

  it('a refused start fails at once with the host reason', async () => {
    addTask(f, { id: 't3b' })
    f.createReply = { ok: false, error: 'workspace providers are not configured on this host yet', code: 'unknown_provider' }
    await requestWorkspace('t3b', { provider: 'git-worktree', anchor: '/r/repo' })
    await __settleWorkspaceDriver('t3b')
    expect(f.tasks.get('t3b')!.workspace).toMatchObject({ state: 'failed', error_code: 'unknown_provider' })
  })

  it('a session that cannot start in a ready workspace keeps its launch for Retry', async () => {
    addTask(f, { id: 't4' })
    f.launchError = 'host gate refused'
    await requestWorkspace('t4', { provider: 'git-worktree', anchor: '/r/repo', pending: { via: 'task-start', message: 'm', at: 'now' } })
    await finishJob(f, 't4', { state: 'done', result: { root: '/w/x', cwd: '/w/x', repos: [] } })
    expect(f.tasks.get('t4')!.workspace).toMatchObject({ state: 'ready', launch_error: 'host gate refused', pending_start: { via: 'task-start' } })
    f.launchError = undefined
    await retryWorkspace('t4')
    for (let i = 0; i < 50 && f.tasks.get('t4')!.workspace!.launch_error !== undefined; i++) await new Promise((r) => setImmediate(r))
    expect(f.launched).toHaveLength(1)
    expect(f.tasks.get('t4')!.workspace!.launch_error).toBeUndefined()
  })

  it('refuses a second request while one is in flight, and an unknown provider or a missing required input', async () => {
    addTask(f, { id: 't5' })
    await requestWorkspace('t5', { provider: 'git-worktree', anchor: '/r/repo' })
    await expect(requestWorkspace('t5', { provider: 'git-worktree' })).rejects.toMatchObject({ status: 409, code: 'busy' })
    addTask(f, { id: 't6' })
    await expect(requestWorkspace('t6', { provider: 'nope' })).rejects.toMatchObject({ status: 400, code: 'unknown-provider' })
    addTask(f, { id: 't7', cwd: undefined })
    await expect(requestWorkspace('t7', { provider: 'git-worktree' })).rejects.toMatchObject({ status: 400, code: 'no-folder' })
  })

  const ready = (id: string, extra: Partial<TaskWorkspace> = {}): Task => addTask(f, { id, phase: 'COMPLETE' as never, workspace: { ...gitWs, ...extra } })

  it('completion removes a clean, merged workspace (daemon re-checks with requireMerged)', async () => {
    ready('c1')
    await onTaskCompleted('c1')
    await __settleWorkspaceDriver('c1')
    expect(f.tasks.get('c1')!.workspace).toMatchObject({ state: 'removed' })
    expect(f.calls.find((c) => c.cmd === 'workspace.remove')!.params).toMatchObject({ requireMerged: true, deleteBranch: 'if-merged', root: gitWs.root })
  })

  it('completion keeps dirty or unmerged work and says why', async () => {
    ready('c2')
    f.probe = probe({ clean: false, problems: ['repo: 3 uncommitted changes'] })
    await onTaskCompleted('c2')
    expect(f.tasks.get('c2')!.workspace).toMatchObject({ state: 'kept', kept_reason: 'repo: 3 uncommitted changes' })
    expect(f.calls.some((c) => c.cmd === 'workspace.remove')).toBe(false)
  })

  it('a live session (idle too) holds the cleanup back; its stop runs it, never a kill', async () => {
    ready('c3')
    f.live = true
    await onTaskCompleted('c3')
    expect(f.tasks.get('c3')!.workspace).toMatchObject({ state: 'ready' })
    expect(f.calls).toHaveLength(0)
    f.live = false
    await onTaskSessionStopped('c3')
    await __settleWorkspaceDriver('c3')
    expect(f.tasks.get('c3')!.workspace).toMatchObject({ state: 'removed' })
  })

  it('a reopen while the host probes wins: the locked write sees the task is no longer complete', async () => {
    ready('c5')
    f.duringProbe = () => { f.tasks.set('c5', { ...f.tasks.get('c5')!, phase: 'IN_PROGRESS' as never }) }
    await onTaskCompleted('c5')
    expect(f.calls.some((c) => c.cmd === 'workspace.remove')).toBe(false)
    expect(f.tasks.get('c5')!.workspace).toMatchObject({ state: 'ready' })
    // A dirty probe is not written as "kept" onto a reopened task either.
    ready('c6')
    f.probe = probe({ clean: false, problems: ['repo: 1 uncommitted change'] })
    f.duringProbe = () => { f.tasks.set('c6', { ...f.tasks.get('c6')!, phase: 'IN_PROGRESS' as never }) }
    await onTaskCompleted('c6')
    expect(f.tasks.get('c6')!.workspace).toMatchObject({ state: 'ready' })
  })

  it('a workspace that finishes after its task completed starts nothing and is cleaned up', async () => {
    addTask(f, { id: 'c7', phase: 'COMPLETE' as never })
    await requestWorkspace('c7', { provider: 'git-worktree', anchor: '/r/repo', pending: { via: 'quick-start', message: 'go', at: 'now' } })
    await finishJob(f, 'c7', { state: 'done', result: { root: gitWs.root, cwd: gitWs.cwd, branch: 'walnut/x', repos: [] } })
    await __settleCompletionCheck('c7')
    await __settleWorkspaceDriver('c7')
    expect(f.launched).toEqual([])
    expect(f.tasks.get('c7')!.workspace).toMatchObject({ state: 'removed' })
    expect(f.tasks.get('c7')!.workspace!.pending_start).toBeUndefined()
  })

  it('boot runs the completion cleanup a stop or a restart left waiting', async () => {
    ready('c8')
    await resumeWorkspaces()
    await __settleCompletionCheck('c8')
    await __settleWorkspaceDriver('c8')
    expect(f.tasks.get('c8')!.workspace).toMatchObject({ state: 'removed' })
  })

  it('completion does nothing for a reopened task', async () => {
    ready('c4')
    f.tasks.set('c4', { ...f.tasks.get('c4')!, phase: 'IN_PROGRESS' as never })
    await onTaskCompleted('c4')
    expect(f.calls).toHaveLength(0)
  })

  it('a deleted task with unsaved work leaves its workspace and a notification', async () => {
    const t = ready('d1')
    f.tasks.delete('d1')
    f.probe = probe({ merged: false, problems: ['branch walnut/x has commits that are not merged or pushed anywhere'] })
    await onTaskDeleted(t)
    expect(f.notes).toHaveLength(1)
    expect(f.notes[0].body).toMatch(/still holds work: branch walnut\/x has commits/)
    expect(f.calls.some((c) => c.cmd === 'workspace.remove')).toBe(false)
  })

  it('manual removal answers at once without a server probe; the host refuses dirty work and the row says why', async () => {
    addTask(f, { id: 'm1', workspace: { ...gitWs } })
    f.probe = probe({ clean: false, problems: ['repo: 1 uncommitted change'] })
    const started = await removeWorkspaceManually('m1')
    expect(started.workspace).toMatchObject({ state: 'removing' })
    expect(f.calls.some((c) => c.cmd === 'workspace.status')).toBe(false)
    await __settleWorkspaceDriver('m1')
    expect(f.tasks.get('m1')!.workspace).toMatchObject({ state: 'ready', error: 'Not removed: repo: 1 uncommitted change' })
    f.probe = probe({ merged: false, branchMerged: false })
    const preview = await removalPreview('m1')
    expect(preview.decision.action).toBe('confirm')
    await removeWorkspaceManually('m1')
    await __settleWorkspaceDriver('m1')
    expect(f.calls.filter((c) => c.cmd === 'workspace.remove')[1].params).toMatchObject({ requireMerged: false })
    expect(f.tasks.get('m1')!.workspace).toMatchObject({ state: 'removed', branch_kept: true })
  })

  it('a plugin workspace removed by hand still requires pushed work', async () => {
    addTask(f, { id: 'm2', workspace: { ...pluginWs } })
    f.probe = probe({ merged: false, problems: ['a: 1 commit on local branches is not pushed'] })
    await removeWorkspaceManually('m2')
    await __settleWorkspaceDriver('m2')
    expect(f.calls.find((c) => c.cmd === 'workspace.remove')!.params).toMatchObject({ requireMerged: true })
    expect(f.tasks.get('m2')!.workspace).toMatchObject({ state: 'ready', error: 'Not removed: a: 1 commit on local branches is not pushed' })
  })

  it('a workspace another Walnut made (copied tasks, the real HOME) is never resumed, launched, cleaned up or removed here', async () => {
    const theirs = { ...gitWs, home: HOME_B }
    addTask(f, { id: 'p1', workspace: { ...theirs, state: 'creating', job_id: 'job-theirs', root: undefined, cwd: undefined } })
    addTask(f, { id: 'p2', workspace: { ...theirs, pending_start: { via: 'task-start', message: 'm', at: 'now' } } })
    addTask(f, { id: 'p3', phase: 'COMPLETE' as never, workspace: { ...theirs } })
    addTask(f, { id: 'p4', workspace: { ...gitWs, home: undefined } })
    await resumeWorkspaces()
    await onTaskCompleted('p3')
    await onTaskDeleted(f.tasks.get('p3')!)
    for (const id of ['p1', 'p2', 'p3']) await __settleWorkspaceDriver(id)
    expect(f.calls).toEqual([])
    expect(f.launched).toEqual([])
    expect(f.notes).toEqual([])
    const refusal = { status: 409, code: 'other-walnut', message: `This workspace was made by another Walnut (${HOME_B}), so this one will not change it.` }
    await expect(removeWorkspaceManually('p3')).rejects.toMatchObject(refusal)
    await expect(removalPreview('p3')).rejects.toMatchObject(refusal)
    await expect(retryWorkspace('p2')).rejects.toMatchObject({ status: 409, code: 'other-walnut' })
    // A row that does not say who made it fails closed.
    await expect(removeWorkspaceManually('p4')).rejects.toMatchObject({ status: 409, code: 'other-walnut' })
    expect(f.calls).toEqual([])
    // A new session in a copied ready workspace is ordinary use.
    expect(workspaceStartPlace(f.tasks.get('p2')!, {})).toEqual({ cwd: theirs.cwd, host: '' })
  })

  it('boot picks up a creation a restart interrupted', async () => {
    addTask(f, { id: 'b1', workspace: { ...gitWs, state: 'creating', job_id: 'job-old', root: undefined, cwd: undefined } })
    f.jobs.set('job-old', { state: 'done', result: { root: '/w/b1', cwd: '/w/b1', repos: [] } })
    await resumeWorkspaces()
    await __settleWorkspaceDriver('b1')
    expect(f.tasks.get('b1')!.workspace).toMatchObject({ state: 'ready', root: '/w/b1' })
  })
})

describe('start paths', () => {
  it('a ready workspace is where a start runs, as a cwd + host pair', () => {
    const task = { workspace: { ...gitWs, host: 'devbox', cwd: '/w/x/pkg' } }
    expect(workspaceStartPlace(task, {})).toEqual({ cwd: '/w/x/pkg', host: 'devbox' })
    expect(workspaceStartPlace(task, { cwd: '/r/repo' })).toEqual({ cwd: '/w/x/pkg', host: 'devbox' })
    expect(workspaceStartPlace(task, { cwd: gitWs.root + '/sub' })).toEqual({ cwd: gitWs.root + '/sub', host: 'devbox' })
    // Another folder, or another host, named explicitly: the start goes there.
    expect(workspaceStartPlace(task, { cwd: '/elsewhere' })).toBeNull()
    expect(workspaceStartPlace(task, { host: 'other' })).toBeNull()
    expect(workspaceStartPlace({ workspace: { ...gitWs, state: 'creating' } }, {})).toBeNull()
    expect(workspaceStartPlace({ workspace: { ...gitWs, host: '__local__' } }, {})).toEqual({ cwd: gitWs.cwd, host: '' })
  })

  it('recordedCwd prefers the task\'s ready workspace', async () => {
    expect(await recordedCwd({ id: 'x', project: '', cwd: '/r/repo', workspace: { ...gitWs } })).toBe(gitWs.cwd)
    expect(await recordedCwd({ id: 'x', project: '', cwd: '/r/repo', workspace: { ...gitWs, state: 'removed' } })).toBe('/r/repo')
  })

  it('a removed workspace is made again on the next start (same provider, inputs and name), never skipped', async () => {
    const f = fake()
    const task = addTask(f, { id: 's5', phase: 'IN_PROGRESS' as never, workspace: { ...gitWs, state: 'removed', name: 'fix-parser-s5', inputs: { baseRef: 'dev' } } })
    const r = await deferTaskStart(task, { message: 'again', source: 'task-start' })
    expect(r).toMatchObject({ taskId: 's5', preparing: true })
    expect(f.tasks.get('s5')!.workspace).toMatchObject({ state: 'creating', name: 'fix-parser-s5', inputs: { baseRef: 'dev' }, home: HOME_A, pending_start: { message: 'again' } })
    expect(f.tasks.get('s5')!.workspace!.root).toBeUndefined()
    expect(f.calls.find((c) => c.cmd === 'workspace.create')!.params).toMatchObject({ provider: 'git-worktree', name: 'fix-parser-s5', baseRef: 'dev', anchor: '/r/repo' })
    expect(await recordedCwd({ id: 'x', project: '', cwd: '/r/repo', workspace: { ...gitWs, state: 'removed' } })).toBe('/r/repo')
  })

  it('a launch whose workspace request is refused records a failed row holding the launch, for Retry', async () => {
    const f = fake()
    const task = addTask(f, { id: 's6', cwd: 'relative/folder' })
    const plan = await workspaceLaunchPlan({ workspace: { provider: 'git-worktree' } }, { cwd: 'relative/folder', isWalnutAgent: false })
    const answer = await plan!.begin!(task, { message: 'go' })
    expect(answer).toMatchObject({ taskId: 's6', preparing: false, workspaceError: expect.stringMatching(/needs the task's folder/) })
    expect(f.tasks.get('s6')!.workspace).toMatchObject({ state: 'failed', error_code: 'no-folder', home: HOME_A, pending_start: { via: 'quick-start', message: 'go' } })
  })

  it('a task_start of a task whose workspace is not ready waits for it', async () => {
    const f = fake()
    const task = addTask(f, { id: 's1', workspace: { ...gitWs, state: 'failed', error: 'x', root: undefined, cwd: undefined } })
    const r = await deferTaskStart(task, { message: 'do it', source: 'task-start' })
    expect(r).toEqual({ taskId: 's1', title: 'Fix parser', started: false, preparing: true })
    expect(f.tasks.get('s1')!.workspace).toMatchObject({ state: 'creating', pending_start: { via: 'task-start', message: 'do it' } })
    await expect(deferTaskStart(addTask(f, { id: 's2', workspace: { ...gitWs, state: 'removing' } }), { source: 'x' })).rejects.toMatchObject({ statusCode: 409 })
    expect(await deferTaskStart(addTask(f, { id: 's3', workspace: { ...gitWs } }), { source: 'x' })).toBeNull()
    expect(await deferTaskStart(addTask(f, { id: 's4' }), { source: 'x' })).toBeNull()
  })

  it('the quick-start plan refuses bad requests before any task exists, and defers a good one', async () => {
    fake()
    expect(await workspaceLaunchPlan({}, { cwd: '/r/repo', isWalnutAgent: false })).toBeNull()
    expect(await workspaceLaunchPlan({ workspace: { provider: 'nope' } }, { cwd: '/r/repo', isWalnutAgent: false }))
      .toMatchObject({ refuse: { status: 400, body: { code: 'unknown-provider' } } })
    expect(await workspaceLaunchPlan({ workspace: { provider: 'git-worktree' } }, { cwd: '', isWalnutAgent: true }))
      .toMatchObject({ refuse: { status: 400 } })
    const plan = await workspaceLaunchPlan({ workspace: { provider: 'git-worktree', inputs: { baseRef: 'dev' } } }, { cwd: '/r/repo', isWalnutAgent: false })
    expect(plan?.defer).toBe(true)
  })
})

describe('watch', () => {
  const withWs = { id: 't1', workspace: { provider: 'git-worktree', state: 'ready' } } as unknown as Task
  it('a session that stops asks a waiting completion cleanup to run', () => {
    expect(workspaceEventAction({ name: 'session:status-changed', data: { taskId: 't1', process_status: 'stopped' } })).toEqual({ action: 'session-stopped', taskId: 't1' })
    expect(workspaceEventAction({ name: 'session:status-changed', data: { taskId: 't1', process_status: 'idle' } })).toBeNull()
    expect(workspaceEventAction({ name: 'session:status-changed', data: { taskId: null, process_status: 'stopped' } })).toBeNull()
  })
  it('a move into COMPLETE from any path (the board\'s PATCH included) asks for the completion cleanup', () => {
    // PATCH phase COMPLETE emits task:updated + task:phase-changed, never task:completed.
    expect(workspaceEventAction({ name: 'task:phase-changed', data: { task: withWs, oldPhase: 'NEED_ACTION', newPhase: 'COMPLETE' } }))
      .toEqual({ action: 'complete', task: withWs })
    expect(workspaceEventAction({ name: 'task:phase-changed', data: { task: withWs, oldPhase: 'COMPLETE', newPhase: 'IN_PROGRESS' } })).toBeNull()
    expect(workspaceEventAction({ name: 'task:updated', data: { task: withWs } })).toBeNull()
    expect(workspaceEventAction({ name: 'task:deleted', data: { id: 't1', task: withWs } })).toEqual({ action: 'delete', task: withWs })
    expect(workspaceEventAction({ name: 'task:phase-changed', data: { task: { id: 't2' }, oldPhase: 'TODO', newPhase: 'COMPLETE' } })).toBeNull()
  })
})
