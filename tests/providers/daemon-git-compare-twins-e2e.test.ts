/**
 * The Changed tab's whole-repo comparisons ('git-compare-v1') in both daemon
 * twins booted for real: git.diff with the 'branch' and 'commit' bases and a
 * names-only list, git.refs, the ref guard, and the old bases unchanged. The
 * source twin runs git-diff-core.ts from its injected text, the standalone twin
 * imports it: one answer from both is the parity this pins.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the repository live under one temp
 * dir (asserted before any spawn); no CLI is started; the daemon is SIGKILLed
 * after each test.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard.js'

const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
let scriptDir = ''
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [path.join(scriptDir, 'daemon.cjs'), '--start']] },
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
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-gc-twins-src-'))
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
    PATH: guardedPath([], '/usr/bin:/bin'),
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
    onDaemonEarlyExit(proc!, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
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

function git(args: string[], cwd: string, home: string): string {
  inRoot(cwd)
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: home, GIT_DIR: undefined } as NodeJS.ProcessEnv,
  }).trim()
}

describe('git compare in both daemon twins', () => {
  for (const twin of TWINS) {
    it(`${twin.name}: branch and commit bases, names-only list, git.refs, ref guard`, async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-gc-twins-')))
      const home = path.join(root, 'home')
      const daemonDir = path.join(root, 'daemon')
      const repo = path.join(root, 'repos', 'app')
      fs.mkdirSync(home, { recursive: true })
      fs.mkdirSync(repo, { recursive: true })
      git(['init', '-q'], repo, home)
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
      git(['add', '.'], repo, home)
      git(['commit', '-qm', 'init'], repo, home)
      const init = git(['rev-parse', 'HEAD'], repo, home)
      git(['checkout', '-qb', 'feature'], repo, home)
      fs.writeFileSync(path.join(repo, 'a.txt'), 'A\n')
      fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n')
      git(['add', '.'], repo, home)
      git(['commit', '-qm', 'feature work'], repo, home)
      const c1 = git(['rev-parse', 'HEAD'], repo, home)
      fs.writeFileSync(path.join(repo, 'b.txt'), 'b2\n')

      await boot(twin, home, daemonDir)
      const hello = await rpc({ cmd: 'hello' })
      expect(hello.capabilities).toContain('git-compare-v1')

      const branch = await rpc({ cmd: 'git.diff', base: 'branch', cwd: repo })
      expect(branch.ok, JSON.stringify(branch)).toBe(true)
      expect(branch.compare, JSON.stringify(branch).slice(0, 600)).toMatchObject({ base: 'branch', ref: 'main', isDefault: true, baseSha: init })
      expect((branch.files as Array<Record<string, unknown>>).map((f) => [f.relPath, f.before, f.after])).toEqual([
        ['a.txt', 'a\n', 'A\n'], ['b.txt', '', 'b2\n'],
      ])

      const light = await rpc({ cmd: 'git.diff', base: 'branch', cwd: repo, namesOnly: true })
      const lf = light.files as Array<Record<string, unknown>>
      expect(lf.map((f) => [f.relPath, f.before, f.after])).toEqual([['a.txt', '', ''], ['b.txt', '', '']])
      expect(lf[1]!.sig).toBe(git(['hash-object', 'b.txt'], repo, home))

      const commit = await rpc({ cmd: 'git.diff', base: 'commit', cwd: repo, commit: c1.slice(0, 8) })
      expect(commit.compare).toMatchObject({ base: 'commit', baseSha: init, commit: { sha: c1, subject: 'feature work' } })
      expect((commit.files as Array<Record<string, unknown>>).map((f) => [f.relPath, f.after])).toEqual([['a.txt', 'A\n'], ['b.txt', 'b\n']])

      const missing = await rpc({ cmd: 'git.diff', base: 'branch', cwd: repo, ref: 'nope' })
      expect(missing).toMatchObject({ ok: true, missing: 'ref', files: [] })
      const refused = await rpc({ cmd: 'git.diff', base: 'branch', cwd: repo, ref: '--output=x' })
      expect(refused.ok).toBe(false)
      expect(String(refused.error)).toMatch(/Not a branch name/)
      expect(fs.existsSync(path.join(repo, 'x'))).toBe(false)

      // The old bases answer as before.
      const unc = await rpc({ cmd: 'git.diff', base: 'uncommitted', cwd: repo })
      expect((unc.files as Array<Record<string, unknown>>).map((f) => [f.relPath, f.before, f.after])).toEqual([['b.txt', 'b\n', 'b2\n']])

      const refs = await rpc({ cmd: 'git.refs', cwd: repo })
      expect(refs).toMatchObject({ ok: true, repoRoot: repo, current: 'feature', defaultRef: 'main', head: c1 })
      expect((refs.refs as Array<Record<string, unknown>>).map((r) => r.name).sort()).toEqual(['feature', 'main'])
      expect((refs.commits as Array<Record<string, unknown>>).map((c) => [c.sha, c.onBranch])).toEqual([[c1, true], [init, false]])
      const notRepo = await rpc({ cmd: 'git.refs', cwd: home })
      expect(notRepo).toMatchObject({ ok: true, repoRoot: null })
    }, 120_000)
  }
})
