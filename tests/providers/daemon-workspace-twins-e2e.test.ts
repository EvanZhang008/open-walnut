/**
 * Task workspaces ('workspace-v1') in both daemon twins booted for real: the
 * built-in git worktree and a plugin provider (the fake multi-repo fixture)
 * created, probed and removed through the daemon's own command surface, the
 * allowlist push and its stale answer, and the bridge refusal.
 *
 * MACHINE SAFETY: HOME, the daemon dir, every repository and every workspace
 * live under one temp dir (asserted before any spawn); no CLI is started; the
 * daemon is SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const PROVIDER = path.resolve(__dirname, '../fixtures/workspace-providers/fake-multirepo/provider.mjs')
let scriptDir = ''
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: 'source twin (node)', command: () => [process.execPath, [path.join(scriptDir, 'daemon.cjs'), '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

let root = ''
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1

function inRoot(p: string): string {
  const abs = path.resolve(p)
  if (!root || !abs.startsWith(root + path.sep)) throw new Error(`refusing ${abs}: outside the test temp dir`)
  return abs
}

beforeAll(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ws-twins-src-'))
  fs.writeFileSync(path.join(scriptDir, 'daemon.cjs'), getDaemonSource())
})

afterAll(() => { if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true }) })

afterEach(async () => {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => { const t = setTimeout(resolve, 10_000); proc!.once('exit', () => { clearTimeout(t); resolve() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

async function boot(twin: Twin, home: string, daemonDir: string): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    HOME: inRoot(home),
    WALNUT_DAEMON_DIR: inRoot(daemonDir),
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    // A redirect the daemon must NOT pass on to git.
    GIT_DIR: path.join(root, 'not-a-repo'),
  }
  delete env.WALNUT_WORKTREES_ROOT
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws!.off('message', onMessage); resolve(msg) }
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify({ id, ...cmd }))
  })
}

async function job(jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const r = await rpc({ cmd: 'workspace.job', jobId })
    const j = r.job as Record<string, unknown> | null
    if (!j) throw new Error('job unknown: ' + jobId)
    if (j.state !== 'running') return j
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error('job never finished')
}

function git(args: string[], cwd: string, home: string): string {
  inRoot(cwd)
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: home, GIT_DIR: undefined } as NodeJS.ProcessEnv,
  }).trim()
}

describe('task workspaces in both daemon twins', () => {
  for (const twin of TWINS) {
    it(`${twin.name}: git worktree and a multi-repo plugin provider, created, probed and removed`, async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ws-twins-')))
      const home = path.join(root, 'home')
      const daemonDir = path.join(root, 'daemon')
      const repo = path.join(root, 'repos', 'app')
      fs.mkdirSync(home, { recursive: true })
      fs.mkdirSync(repo, { recursive: true })
      git(['init', '-q'], repo, home)
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
      git(['add', '.'], repo, home)
      git(['commit', '-qm', 'init'], repo, home)

      await boot(twin, home, daemonDir)
      const hello = await rpc({ cmd: 'hello' })
      expect(hello.capabilities).toContain('workspace-v1')

      // ── git-worktree ──
      const det = await rpc({ cmd: 'workspace.detect', anchor: repo })
      expect(det.ok).toBe(true)
      expect((det.candidates as Array<Record<string, unknown>>)[0]).toMatchObject({ provider: 'git-worktree', claimed: true, root: repo })
      const started = await rpc({ cmd: 'workspace.create', provider: 'git-worktree', jobId: 'job-git-1', anchor: repo, name: 'Twin task 1' })
      expect(started).toMatchObject({ ok: true, jobId: 'job-git-1' })
      const made = await job('job-git-1')
      expect(made.state, JSON.stringify(made)).toBe('done')
      const res = made.result as { root: string; branch: string; sourceRepo: string; repos: unknown[]; baseRef: unknown }
      expect(res.root).toBe(path.join(home, '.open-walnut-worktrees', 'app', 'twin-task-1'))
      expect(res.branch).toBe('walnut/twin-task-1')
      expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], res.root, home)).toBe('walnut/twin-task-1')
      const status = await rpc({ cmd: 'workspace.status', provider: 'git-worktree', root: res.root, repos: res.repos, branch: res.branch, sourceRepo: res.sourceRepo, baseRef: res.baseRef })
      expect(status.probe).toMatchObject({ clean: true, merged: true })
      fs.writeFileSync(path.join(res.root, 'dirty.txt'), 'x')
      const kept = await rpc({ cmd: 'workspace.remove', provider: 'git-worktree', jobId: 'job-git-rm1', root: res.root, repos: res.repos, branch: res.branch, sourceRepo: res.sourceRepo, baseRef: res.baseRef, anchor: repo, deleteBranch: 'if-merged', requireMerged: true })
      expect(kept.ok).toBe(true)
      expect(await job('job-git-rm1')).toMatchObject({ state: 'failed', code: 'not_clean' })
      expect(fs.existsSync(path.join(res.root, 'dirty.txt'))).toBe(true)
      fs.rmSync(path.join(res.root, 'dirty.txt'))
      await rpc({ cmd: 'workspace.remove', provider: 'git-worktree', jobId: 'job-git-rm2', root: res.root, repos: res.repos, branch: res.branch, sourceRepo: res.sourceRepo, baseRef: res.baseRef, anchor: repo, deleteBranch: 'if-merged', requireMerged: true })
      expect(await job('job-git-rm2')).toMatchObject({ state: 'done', result: { removed: true, branchDeleted: true } })
      expect(fs.existsSync(res.root)).toBe(false)

      // ── plugin provider ──
      const spec = {
        id: 'fake-multirepo', displayName: 'Fake multi-repo', priority: 50, markers: ['fake-workspace.json'],
        command: [process.execPath, '{script}'], script: { name: 'provider.mjs', content: fs.readFileSync(PROVIDER, 'utf8') },
      }
      const stale = await rpc({ cmd: 'workspace.create', provider: 'fake-multirepo', providersHash: 'h1', jobId: 'job-p-0', anchor: repo, name: 'x' })
      expect(stale).toMatchObject({ ok: false, code: 'providers_stale' })
      expect(await rpc({ cmd: 'workspace.configure', config: { version: 1, hash: 'h1', providers: [spec] } })).toMatchObject({ ok: true, changed: true })
      expect(await rpc({ cmd: 'workspace.configure', config: { version: 1, hash: 'h1', providers: [spec] } })).toMatchObject({ ok: true, changed: false })
      // The adapter landed in the daemon's state dir, owner-only.
      const adapter = path.join(daemonDir, 'workspace-providers', 'fake-multirepo.mjs')
      expect((fs.statSync(adapter).mode & 0o777).toString(8)).toBe('700')
      const pStart = await rpc({ cmd: 'workspace.create', provider: 'fake-multirepo', providersHash: 'h1', jobId: 'job-p-1', anchor: repo, name: 'Multi One', inputs: { packages: ['alpha', 'beta'] } })
      expect(pStart.ok, JSON.stringify(pStart)).toBe(true)
      const pMade = await job('job-p-1')
      expect(pMade.state, JSON.stringify(pMade)).toBe('done')
      const pRes = pMade.result as { root: string; repos: Array<{ path: string; name: string }> }
      expect(pRes.root).toBe(path.join(home, 'fake-workspaces', 'multi-one'))
      expect(pRes.repos.map((r) => r.name)).toEqual(['alpha', 'beta'])
      const pDet = await rpc({ cmd: 'workspace.detect', anchor: path.join(pRes.root, 'src', 'beta'), providersHash: 'h1' })
      expect((pDet.candidates as Array<Record<string, unknown>>).find((c) => c.provider === 'fake-multirepo')).toMatchObject({ claimed: true, root: pRes.root })
      await rpc({ cmd: 'workspace.remove', provider: 'fake-multirepo', providersHash: 'h1', jobId: 'job-p-rm', root: pRes.root, repos: pRes.repos, requireMerged: true })
      expect(await job('job-p-rm')).toMatchObject({ state: 'done', result: { removed: true, rootGone: true } })

      // ── a refused path never reaches git ──
      const refused = await rpc({ cmd: 'workspace.create', provider: 'git-worktree', jobId: 'job-home', anchor: home, name: 'h' })
      expect(refused.ok).toBe(true)
      const homeJob = await job('job-home')
      expect(homeJob).toMatchObject({ state: 'failed', code: 'forbidden_path' })
      expect(String(homeJob.error)).toMatch(/the home folder/)
    }, 120_000)
  }

  it('the bridge allowlist does not name any workspace command (both twins)', () => {
    for (const file of ['../../src/providers/daemon-source.ts', '../../src/providers/daemon-standalone.ts']) {
      const text = fs.readFileSync(path.resolve(__dirname, file), 'utf8')
      const m = text.match(/BRIDGE_ALLOWED_COMMANDS = new Set(?:<[^>]*>)?\(\[([\s\S]*?)\]\)/)
      expect(m, file).toBeTruthy()
      expect(m![1]).not.toMatch(/workspace\./)
    }
  })
})
