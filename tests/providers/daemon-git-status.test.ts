/**
 * The daemon's `git.status` handler ('git-status-v1') answers exactly what the
 * shared core answers (createGitStatus), for a `~` path too.
 *
 * Runs the daemon's own git module (daemon-git.ts, createDaemonGit) with node's execFile
 * and a reply that records the answer, and compares it with the core run directly.
 * Every repository is a fresh `git init` in one mkdtemp directory; its homeDir
 * points inside it, so `~` never means the real home.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createDaemonGit } from '../../src/providers/daemon-git.js'
import { createGitStatus, type ExecFn } from '../../src/providers/git-diff-core.js'

type Reply = { ok?: boolean; error?: string; repos?: unknown[] }

function extractHandler(homeDir: string): (cmd: Record<string, unknown>) => Promise<Reply> {
  const fns = createDaemonGit<null>({
    daemonEnv: process.env,
    HOME_DIR: homeDir,
    execFileCb: execFile,
  })
  return async (c) => { const a = await fns.answers['git.status']!(c, null); return a.ok ? { ok: true, ...a.data } : { ok: false, error: a.error } }
}

const exec: ExecFn = (argv, cwd) => new Promise((resolve) => {
  execFile(argv[0]!, argv.slice(1), { cwd, encoding: 'utf-8' }, (err, stdout, stderr) => {
    resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? 1 : 0 })
  })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' })

let home: string
let repo: string

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-daemon-')))
  repo = path.join(home, 'code', 'app')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'one\ntwo\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'one\nTWO\nthree\n')
  fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'b\n')
})

afterAll(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('daemon git.status', () => {
  it('answers what the core answers, for a ~ path too', async () => {
    const run = extractHandler(home)
    const reply = await run({ dirs: ['~/code/app/src', path.join(home, 'nowhere')] })
    expect(reply.ok).toBe(true)
    const core = await createGitStatus({
      exec,
      readText: async (abs, max) => {
        const st = fs.statSync(abs)
        return st.size > max ? { tooBig: true } : { text: fs.readFileSync(abs, 'utf-8') }
      },
    }).status([repo])
    expect(reply.repos).toEqual(core)
    expect(core[0]).toMatchObject({ repoRoot: repo, branch: 'main', files: 2, untracked: 1, insertions: 3, deletions: 1 })
  })

  it('refuses a call with no directories', async () => {
    const reply = await extractHandler(home)({ dirs: [] })
    expect(reply).toEqual({ ok: false, error: 'git.status: missing dirs' })
  })
})

// The daemon's runGit (daemon-git.ts) gives a git the read-only env only in a data home under a leader switch
// (lib/leader-home-gate.ts readOnlyGitEnv). 2026-11-26: with optional locks off for every repo, a touched file stayed
// stale in the index for good, so every status hashed it again (98 to 131 s a run on a 20 GB home).
describe('daemon git.status and the index of the repo it reads', () => {
  const cleanRepo = (name: string, marker?: string) => {
    const dir = path.join(home, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    git(dir, 'init', '-q', '-b', 'main')
    if (marker) {
      fs.mkdirSync(path.join(dir, 'local', 'leader-switch'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'local', 'leader-switch', 'handed-over.json'), marker)
      fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'local/\n')
    }
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'init')
    // Same content, an mtime an hour back (never racy): the index's stat data is stale.
    const earlier = new Date(Date.now() - 3_600_000)
    fs.utimesSync(path.join(dir, 'a.txt'), earlier, earlier)
    return { dir, index: path.join(dir, '.git', 'index') }
  }

  // The env each git of the handler got (node's execFile underneath).
  const recordingHandler = () => {
    const envs: Array<Record<string, string | undefined> | undefined> = []
    const fns = createDaemonGit<null>({
      daemonEnv: process.env,
      HOME_DIR: home,
      execFileCb: ((file: string, args: string[], opts: { env?: Record<string, string | undefined> }, cb: never) => {
        envs.push(opts.env)
        return execFile(file, args, opts as never, cb)
      }) as never,
    })
    return { envs, run: async (dirs: string[]) => (await fns.answers['git.status']!({ dirs }, null)).ok }
  }

  it('an unmarked repo: its gits get the env they always got (none given: the daemon\'s own, optional locks as git has them)', async () => {
    expect(process.env.GIT_OPTIONAL_LOCKS).toBeUndefined()
    const { dir } = cleanRepo('free')
    const { envs, run } = recordingHandler()
    expect(await run([dir])).toBe(true)
    expect(envs.length).toBeGreaterThan(0)
    expect(envs.every((e) => e === undefined)).toBe(true)
  })

  it('a home under a leader switch: its gits get the read-only env and leave the index byte for byte as it was', async () => {
    for (const state of ['switching', 'handed-over']) {
      const { dir, index } = cleanRepo(`marked-${state}`, JSON.stringify({ state }))
      const before = fs.readFileSync(index)
      const { envs, run } = recordingHandler()
      expect(await run([dir])).toBe(true)
      expect(fs.readFileSync(index).equals(before), state).toBe(true)
      expect(envs.length).toBeGreaterThan(0)
      for (const e of envs) {
        expect(e?.GIT_OPTIONAL_LOCKS, state).toBe('0')
        // Appended after the config the test env carries (tests/setup/git-env-isolation.ts).
        const n = Number(e?.GIT_CONFIG_COUNT) - 1
        expect([e?.[`GIT_CONFIG_KEY_${n}`], e?.[`GIT_CONFIG_VALUE_${n}`]], state).toEqual(['diff.autoRefreshIndex', 'false'])
      }
    }
  })
})
