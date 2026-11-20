/**
 * The real workspace core over temp git repositories, shared by the workspace-core
 * test files.
 *
 * MACHINE SAFETY: every repository, worktree, provider workspace and HOME lives
 * under ONE temp dir each fixture creates (`ROOT`); `inTemp` asserts it before any
 * spawn. HOME and WALNUT_WORKTREES_ROOT are set explicitly (never inherited from
 * the shell that runs the tests) to the temp HOME and its worktrees folder.
 */
import { expect } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWorkspaceCore, type WorkspaceCoreDeps } from '../../src/providers/workspace-core.js'

export const PROVIDER = path.resolve(__dirname, '../fixtures/workspace-providers/fake-multirepo/provider.mjs')

export function workspaceCoreFixture(prefix: string) {
  const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

  function inTemp(p: string): string {
    const abs = path.resolve(p)
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error(`refusing to touch ${abs}: outside the test temp dir`)
    return abs
  }

  function sh(args: string[], cwd: string): string {
    inTemp(cwd)
    return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
      cwd, encoding: 'utf8', env: { ...process.env, HOME: path.join(ROOT, 'home') },
    }).trim()
  }

  let seq = 0
  function makeRepo(name = `repo${++seq}`): string {
    const dir = inTemp(path.join(ROOT, 'repos', name))
    fs.mkdirSync(dir, { recursive: true })
    sh(['init', '-q'], dir)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'pkg', 'b.txt'), 'b\n')
    sh(['add', '.'], dir)
    sh(['commit', '-qm', 'init'], dir)
    return dir
  }

  function makeCore(extra: Partial<WorkspaceCoreDeps> = {}) {
    const home = inTemp(path.join(ROOT, 'home'))
    fs.mkdirSync(home, { recursive: true })
    return createWorkspaceCore({
      spawn: spawn as unknown as WorkspaceCoreDeps['spawn'],
      fs,
      path,
      homedir: () => home,
      // A poisoned redirect: if the core inherited it, git would address another repository.
      env: { ...process.env, HOME: home, WALNUT_WORKTREES_ROOT: path.join(home, '.open-walnut-worktrees'), GIT_DIR: path.join(ROOT, 'not-a-repo'), GIT_WORK_TREE: path.join(ROOT, 'nowhere') },
      stateDir: inTemp(path.join(ROOT, 'state')),
      killGroup: (pid, signal) => { process.kill(-pid, signal as NodeJS.Signals) },
      ...extra,
    })
  }

  type Core = ReturnType<typeof makeCore>

  async function waitJob(core: Core, jobId: string, ms = 20_000): Promise<Record<string, unknown>> {
    const until = Date.now() + ms
    for (;;) {
      const r = await core.handle('workspace.job', { jobId }) as { job: Record<string, unknown> | null }
      if (r.job && r.job.state !== 'running') return r.job
      if (Date.now() > until) throw new Error('job did not finish: ' + JSON.stringify(r.job))
      await new Promise((res) => setTimeout(res, 50))
    }
  }

  let jobSeq = 0
  const jid = () => `job-${Date.now()}-${++jobSeq}`

  async function createGit(core: Core, anchor: string, name: string, extra: Record<string, unknown> = {}) {
    const jobId = jid()
    const started = await core.handle('workspace.create', { provider: 'git-worktree', jobId, anchor, name, ...extra })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    return waitJob(core, jobId)
  }

  function cleanup(): void {
    inTemp(ROOT)
    fs.rmSync(ROOT, { recursive: true, force: true })
  }

  return { ROOT, inTemp, sh, makeRepo, makeCore, waitJob, jid, createGit, cleanup }
}

export type WorkspaceCore = ReturnType<ReturnType<typeof workspaceCoreFixture>['makeCore']>
