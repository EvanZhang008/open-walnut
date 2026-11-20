/**
 * The re-check of a kept workspace (`recheck: true`, 'workspace-recheck-v1'): the
 * host fetches first, then counts a commit whose patch is already on the upstream
 * (a review that merged it rebased, under a new hash) as merged, but only when the patch
 * is exactly the same (whitespace included). Real git, a bare "remote", the real provider
 * process. Everything else stays kept: commits not on the upstream, one that differs only
 * in whitespace, a fetch that fails, a merge commit, a plugin branch with no upstream. A
 * branch merged only by content keeps its branch; one merged by ancestry loses it. The
 * fetch never prompts (a fake ssh on PATH records how it was called).
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PROVIDER, workspaceCoreFixture, type WorkspaceCore } from './workspace-core-fixture.js'

const { ROOT, inTemp, sh, makeRepo, makeCore, waitJob, jid, createGit, cleanup } = workspaceCoreFixture('walnut-ws-recheck-')
afterAll(cleanup)

function commit(dir: string, file: string, text: string, msg: string): string {
  fs.writeFileSync(path.join(inTemp(dir), file), text)
  sh(['add', '.'], dir)
  sh(['commit', '-qm', msg], dir)
  return sh(['rev-parse', 'HEAD'], dir)
}

/**
 * A review merges `sha` from `from` onto the remote: another clone takes it, puts an
 * unrelated commit first (so the hash changes), cherry-picks it and pushes.
 */
function reviewMerges(remote: string, from: string, shas: string[], branch = 'main'): void {
  const reviewer = inTemp(path.join(ROOT, 'reviewers', `r${Date.now()}-${Math.random().toString(36).slice(2)}`))
  fs.mkdirSync(path.dirname(reviewer), { recursive: true })
  sh(['clone', '-q', remote, reviewer], ROOT)
  commit(reviewer, `other-${path.basename(reviewer)}.txt`, 'other\n', 'someone else')
  sh(['fetch', '-q', from, '+refs/heads/*:refs/remotes/task/*'], reviewer)
  for (const s of shas) sh(['cherry-pick', '-x', s], reviewer)
  sh(['push', '-q', 'origin', `HEAD:${branch}`], reviewer)
}

/** Someone else lands their own commit of `file` with `text` on the remote's main. */
function otherLands(remote: string, file: string, text: string): void {
  const other = inTemp(path.join(ROOT, 'reviewers', `o${Date.now()}-${Math.random().toString(36).slice(2)}`))
  fs.mkdirSync(path.dirname(other), { recursive: true })
  sh(['clone', '-q', remote, other], ROOT)
  commit(other, file, text, 'landed by review')
  sh(['push', '-q', 'origin', 'HEAD:main'], other)
}

describe('git-worktree re-check', () => {
  const core = makeCore()

  /** A checkout whose main tracks a bare remote, and a task worktree made from it. */
  async function made(name: string) {
    const seed = makeRepo(`${name}-seed`)
    const remote = inTemp(path.join(ROOT, 'remotes', `${name}.git`))
    fs.mkdirSync(path.dirname(remote), { recursive: true })
    sh(['clone', '-q', '--bare', seed, remote], ROOT)
    const repo = inTemp(path.join(ROOT, 'repos', name))
    sh(['clone', '-q', remote, repo], ROOT)
    const job = await createGit(core, repo, name)
    expect(job.state, JSON.stringify(job)).toBe('done')
    const r = job.result as { root: string; branch: string; sourceRepo: string; baseRef: { name?: string; sha?: string }; repos: Array<{ path: string }> }
    return { repo, remote, ...r }
  }
  type W = Awaited<ReturnType<typeof made>>
  const args = (w: W) => ({ provider: 'git-worktree', root: w.root, repos: w.repos, branch: w.branch, sourceRepo: w.sourceRepo, baseRef: w.baseRef, anchor: w.repo })
  const status = async (w: W, recheck: boolean) =>
    (await core.handle('workspace.status', { ...args(w), ...(recheck ? { recheck: true } : {}) }) as { probe: Record<string, unknown> }).probe
  async function remove(w: W, recheck: boolean) {
    const jobId = jid()
    const started = await core.handle('workspace.remove', { ...args(w), jobId, deleteBranch: 'if-merged', requireMerged: true, ...(recheck ? { recheck: true } : {}) })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    return waitJob(core, jobId, 60_000)
  }

  it('a commit a review merged under a new hash counts as merged only in a re-check, which fetches first', async () => {
    const w = await made('rebased')
    expect(w.baseRef.name).toBe('main')
    const sha = commit(w.root, 'feature.txt', 'feature\n', 'feature')
    reviewMerges(w.remote, w.repo, [sha])
    // The checkout has not fetched: by ancestry, and before any fetch, it is not merged.
    expect(await status(w, false)).toMatchObject({ clean: true, merged: false, branchMerged: false })
    expect(sh(['rev-list', '--count', 'main..origin/main'], w.repo)).toBe('0')
    const p = await status(w, true)
    expect(p).toMatchObject({ clean: true, merged: true, branchMerged: true, rechecked: true })
    expect(p.fetchFailed).toBeUndefined()
    // The fetch moved the remote-tracking ref; the commit itself is on it under another hash.
    expect(sh(['rev-list', '--count', 'main..origin/main'], w.repo)).toBe('2')
    expect(sh(['branch', '-r', '--contains', sha], w.repo)).toBe('')
    // A removal without the option still judges by ancestry and keeps it.
    expect(await remove(w, false)).toMatchObject({ state: 'failed', code: 'not_merged' })
    expect(fs.existsSync(w.root)).toBe(true)
    // The host's own probe before it deletes, with the option, accepts it.
    expect(p).toMatchObject({ branchMergedByContent: true })
    const done = await remove(w, true)
    expect(done.state, JSON.stringify(done)).toBe('done')
    // Merged only as a rebased copy: the folder goes, the branch (and its reflog) stays.
    expect(done.result).toMatchObject({ removed: true, rootGone: true, branchDeleted: false, branchKept: true, branchKeptReason: expect.stringMatching(/rebased copies/) })
    expect(fs.existsSync(w.root)).toBe(false)
    expect(sh(['rev-parse', '--verify', '-q', `refs/heads/${w.branch}`], w.repo)).toBe(sha)
  })

  it('a commit the upstream has only with other whitespace is not merged (git cherry alone would say it is)', async () => {
    const w = await made('whitespace')
    commit(w.root, 'ws.txt', 'if (x) {\n  go()\n}\n', 'indent by two')
    otherLands(w.remote, 'ws.txt', 'if (x) {\n    go()\n}\n')
    const p = await status(w, true)
    // The premise: cherry, which ignores whitespace, marks the local commit as on the upstream.
    expect(sh(['cherry', 'origin/main', w.branch], w.repo)).toMatch(/^- /)
    expect(p).toMatchObject({ clean: true, merged: false, branchMerged: false, rechecked: true })
    expect(p.branchMergedByContent).toBeUndefined()
    expect(await remove(w, true)).toMatchObject({ state: 'failed', code: 'not_merged' })
    expect(fs.existsSync(w.root)).toBe(true)
  })

  it('the same change landed exactly by someone else counts; merged by ancestry deletes the branch as before', async () => {
    const exact = await made('exact')
    commit(exact.root, 'ex.txt', 'if (x) {\n  go()\n}\n', 'mine')
    otherLands(exact.remote, 'ex.txt', 'if (x) {\n  go()\n}\n')
    expect(await status(exact, true)).toMatchObject({ merged: true, branchMerged: true, branchMergedByContent: true })

    const w = await made('ancestry')
    const sha = commit(w.root, 'anc.txt', 'anc\n', 'anc')
    sh(['push', '-q', 'origin', 'HEAD:main'], w.root)
    const p = await status(w, true)
    expect(p).toMatchObject({ clean: true, merged: true, branchMerged: true })
    expect(p.branchMergedByContent).toBeUndefined()
    const done = await remove(w, true)
    expect(done.state, JSON.stringify(done)).toBe('done')
    expect(done.result).toMatchObject({ removed: true, branchDeleted: true, branchKept: false })
    expect(() => sh(['rev-parse', '--verify', '-q', `refs/heads/${w.branch}`], w.repo)).toThrow()
    expect(sh(['branch', '-r', '--contains', sha], w.repo)).toMatch(/origin\/main/)
  })

  it('the fetch never prompts: no askpass, ssh in batch mode unless the user set their own ssh command', async () => {
    const bin = inTemp(path.join(ROOT, 'fake-bin'))
    fs.mkdirSync(bin, { recursive: true })
    const logFile = path.join(bin, 'ssh.log')
    // A fake ssh: records how git called it, then fails like an unreachable host.
    fs.writeFileSync(path.join(bin, 'ssh'), [
      '#!/bin/sh',
      `{ echo "args: $*"; echo "GIT_ASKPASS=[\${GIT_ASKPASS-unset}] SSH_ASKPASS=[\${SSH_ASKPASS-unset}] REQUIRE=[\${SSH_ASKPASS_REQUIRE-unset}] PROMPT=[\${GIT_TERMINAL_PROMPT-unset}]"; } >> '${logFile}'`,
      'exit 255', '',
    ].join('\n'), { mode: 0o755 })
    const home = path.join(ROOT, 'home')
    const prompting = makeCore({
      env: {
        ...process.env, HOME: home, WALNUT_WORKTREES_ROOT: path.join(home, '.open-walnut-worktrees'), PATH: `${bin}:${process.env.PATH}`,
        GIT_SSH_COMMAND: undefined, GIT_SSH: undefined, GIT_ASKPASS: '/nowhere/askpass', SSH_ASKPASS: '/nowhere/askpass',
      },
    })
    const w = await made('noprompt')
    sh(['remote', 'set-url', 'origin', 'ssh://git@example.invalid/noprompt.git'], w.repo)
    const probeWith = async () => (await prompting.handle('workspace.status', { ...args(w), recheck: true }) as { probe: Record<string, unknown> }).probe
    expect(await probeWith()).toMatchObject({ merged: true, fetchFailed: [w.sourceRepo] })
    const first = fs.readFileSync(logFile, 'utf8')
    expect(first).toMatch(/args: .*BatchMode=yes/)
    expect(first).toMatch(/GIT_ASKPASS=\[\] SSH_ASKPASS=\[unset\] REQUIRE=\[never\] PROMPT=\[0\]/)
    // The user's own ssh command is theirs: Walnut adds nothing to it.
    sh(['config', 'core.sshCommand', `${path.join(bin, 'ssh')} -o UserOwn=yes`], w.repo)
    fs.writeFileSync(logFile, '')
    await probeWith()
    const own = fs.readFileSync(logFile, 'utf8')
    expect(own).toMatch(/args: .*UserOwn=yes/)
    expect(own).not.toMatch(/BatchMode/)
  })

  it('commits the upstream does not have, all or some, stay unmerged and the workspace is kept', async () => {
    const w = await made('unmerged')
    const first = commit(w.root, 'one.txt', '1\n', 'one')
    commit(w.root, 'two.txt', '2\n', 'two')
    const none = await status(w, true)
    expect(none).toMatchObject({ clean: true, merged: false, branchMerged: false, rechecked: true })
    expect((none.problems as string[]).join(' ')).toMatch(/not merged or pushed anywhere/)
    reviewMerges(w.remote, w.repo, [first])
    expect(await status(w, true)).toMatchObject({ clean: true, merged: false, branchMerged: false })
    expect(await remove(w, true)).toMatchObject({ state: 'failed', code: 'not_merged' })
    expect(fs.existsSync(w.root)).toBe(true)
    expect(sh(['log', '--oneline', '-1', w.branch], w.repo)).toMatch(/two/)
  })

  it('a fetch that fails keeps it, and says why', async () => {
    const w = await made('nofetch')
    const sha = commit(w.root, 'f.txt', 'f\n', 'f')
    reviewMerges(w.remote, w.repo, [sha])
    sh(['remote', 'set-url', 'origin', path.join(ROOT, 'remotes', 'gone.git')], w.repo)
    const p = await status(w, true)
    expect(p).toMatchObject({ clean: true, merged: false, rechecked: true, fetchFailed: [w.sourceRepo] })
    expect((p.problems as string[]).join(' ')).toMatch(/could not fetch origin of /)
    expect(await remove(w, true)).toMatchObject({ state: 'failed', code: 'not_merged' })
    expect(fs.existsSync(w.root)).toBe(true)
  })

  it('a merge commit on the branch is never accepted by content (its resolution is its own)', async () => {
    const w = await made('merges')
    const a = commit(w.root, 'a2.txt', 'a2\n', 'a2')
    sh(['checkout', '-q', '-b', 'side', w.baseRef.sha!], w.repo)
    const b = commit(w.repo, 'b2.txt', 'b2\n', 'b2')
    sh(['checkout', '-q', 'main'], w.repo)
    sh(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], w.root)
    reviewMerges(w.remote, w.repo, [a, b])
    // Ancestry would not hold it either: side is a local branch, but the merge commit is on no other ref.
    expect(await status(w, true)).toMatchObject({ clean: true, merged: false, rechecked: true })
  })

  it('uncommitted work still keeps it in a re-check', async () => {
    const w = await made('dirty')
    const sha = commit(w.root, 'g.txt', 'g\n', 'g')
    reviewMerges(w.remote, w.repo, [sha])
    fs.writeFileSync(path.join(w.root, 'wip.txt'), 'wip\n')
    expect(await status(w, true)).toMatchObject({ clean: false, merged: true })
    expect(await remove(w, true)).toMatchObject({ state: 'failed', code: 'not_clean' })
    expect(fs.existsSync(path.join(w.root, 'wip.txt'))).toBe(true)
  })
})

describe('plugin workspace re-check', () => {
  const home = path.join(ROOT, 'home')
  async function configured() {
    const core = makeCore()
    const hash = `h-${Date.now()}-${Math.random()}`
    const spec = {
      id: 'fake-multirepo', displayName: 'Fake multi-repo', priority: 50, markers: ['fake-workspace.json'],
      command: [process.execPath, '{script}'], script: { name: 'provider.mjs', content: fs.readFileSync(PROVIDER, 'utf8') },
    }
    expect(await core.handle('workspace.configure', { config: { version: 1, hash, providers: [spec] } })).toMatchObject({ ok: true })
    return { core, hash }
  }
  async function create(core: WorkspaceCore, hash: string, name: string, packages: string[]) {
    const anchor = path.join(ROOT, 'repos')
    fs.mkdirSync(anchor, { recursive: true })
    const jobId = jid()
    const started = await core.handle('workspace.create', { provider: 'fake-multirepo', providersHash: hash, jobId, anchor, name, inputs: { packages } })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    const job = await waitJob(core, jobId, 30_000)
    expect(job.state, JSON.stringify(job)).toBe('done')
    return job.result as { root: string; repos: Array<{ path: string; name: string }> }
  }

  it('local commits a review merged rebased count as pushed only in a re-check; one that fails to fetch keeps it', async () => {
    const { core, hash } = await configured()
    const res = await create(core, hash, 'multi-recheck', ['Alpha', 'Beta'])
    const [alpha, beta] = res.repos.map((r) => r.path)
    const probe = async (recheck: boolean) => ((await core.handle('workspace.status', {
      provider: 'fake-multirepo', providersHash: hash, root: res.root, repos: res.repos, ...(recheck ? { recheck: true } : {}),
    })) as { probe: Record<string, any> }).probe
    const removeJob = async (recheck: boolean) => {
      const jobId = jid()
      await core.handle('workspace.remove', { provider: 'fake-multirepo', providersHash: hash, jobId, root: res.root, repos: res.repos, requireMerged: true, ...(recheck ? { recheck: true } : {}) })
      return waitJob(core, jobId, 60_000)
    }
    const sa = commit(alpha, 'x.txt', 'x\n', 'alpha work')
    const sb = commit(beta, 'y.txt', 'y\n', 'beta work')
    // Not on any remote yet: kept, with or without a re-check.
    expect(await probe(true)).toMatchObject({ clean: true, merged: false, rechecked: true })
    reviewMerges(path.join(home, 'fake-remotes', 'alpha.git'), alpha, [sa])
    const half = await probe(true)
    expect(half).toMatchObject({ clean: true, merged: false })
    expect(half.repos.find((r: any) => r.path === alpha)).toMatchObject({ merged: true, pushedByContent: true })
    expect(half.repos.find((r: any) => r.path === beta)).toMatchObject({ merged: false, unpushed: 1 })
    reviewMerges(path.join(home, 'fake-remotes', 'beta.git'), beta, [sb])
    expect(await probe(false)).toMatchObject({ merged: false })
    // A remote that cannot be fetched: that repository is judged by what is here.
    const url = sh(['remote', 'get-url', 'origin'], beta)
    sh(['remote', 'set-url', 'origin', path.join(home, 'fake-remotes', 'gone.git')], beta)
    const failed = await probe(true)
    expect(failed).toMatchObject({ clean: true, merged: false, fetchFailed: [beta] })
    expect(failed.problems.join(' ')).toMatch(/beta: could not fetch its remotes/)
    expect(await removeJob(true)).toMatchObject({ state: 'failed', code: 'not_merged' })
    sh(['remote', 'set-url', 'origin', url], beta)
    // A local branch with no upstream is never pushed by content, even with its patch upstream.
    sh(['branch', '-q', '--no-track', 'side', 'HEAD'], beta)
    expect(await probe(true)).toMatchObject({ merged: false })
    sh(['branch', '-q', '-D', 'side'], beta)
    // Both merged by content now: the host's own probe before the removal accepts it.
    expect(await probe(true)).toMatchObject({ clean: true, merged: true, rechecked: true })
    expect(await removeJob(false)).toMatchObject({ state: 'failed', code: 'not_merged' })
    const done = await removeJob(true)
    expect(done.state, JSON.stringify(done)).toBe('done')
    expect(fs.existsSync(res.root)).toBe(false)
  })
})
