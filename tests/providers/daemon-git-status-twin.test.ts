/**
 * The source twin's `git.status` ('git-status-v1') answers exactly what the
 * shared core answers (createGitStatus, which the binary twin calls directly).
 *
 * daemon-source.ts is an embedded JS template: the handler text is cut out of
 * it and rebuilt with `new Function`, the `__CREATE_GIT_STATUS__` placeholder
 * filled with the core's own text as daemon-source does at build time. Every
 * repository is a fresh `git init` in one mkdtemp directory; HOME_DIR points
 * inside it, so `~` never means the real home.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createGitStatus, type ExecFn } from '../../src/providers/git-diff-core.js'

const ROOT = path.resolve(__dirname, '../..')

type Reply = { ok?: boolean; error?: string; repos?: unknown[] }

function extractTwin(homeDir: string): (cmd: Record<string, unknown>) => Promise<Reply> {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8')
  const start = src.indexOf('const DAEMON_SOURCE = `')
  expect(start).toBeGreaterThan(-1)
  const body = src.slice(src.indexOf('`', start) + 1, src.lastIndexOf('`'))
  // eslint-disable-next-line no-eval
  const twin = eval('`' + body + '`') as string
  const from = twin.indexOf('const gitStatus = (__CREATE_GIT_STATUS__)(')
  expect(from, 'git.status construction not found in the daemon template').toBeGreaterThan(-1)
  const handler = twin.indexOf('async function cmdGitStatus(', from)
  const end = twin.indexOf('\n}', handler)
  const text = twin.slice(from, end + 2).replace('__CREATE_GIT_STATUS__', createGitStatus.toString())
  let reply: Reply = {}
  const sendOk = (_ws: unknown, _id: unknown, data: Reply) => { reply = { ok: true, ...data } }
  const sendError = (_ws: unknown, _id: unknown, error: string) => { reply = { ok: false, error } }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('fs', 'execFile', 'HOME_DIR', 'sendOk', 'sendError', text + '\nreturn cmdGitStatus;') as
    (...a: unknown[]) => (ws: unknown, id: number, cmd: Record<string, unknown>) => Promise<void>
  const cmd = factory(fs, execFile, homeDir, sendOk, sendError)
  return async (c) => { reply = {}; await cmd(null, 1, c); return reply }
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
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-twin-')))
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

describe('source twin git.status', () => {
  it('answers what the core answers, for a ~ path too', async () => {
    const run = extractTwin(home)
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
    const reply = await extractTwin(home)({ dirs: [] })
    expect(reply).toEqual({ ok: false, error: 'git.status: missing dirs' })
  })
})
