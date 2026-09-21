/**
 * Behavioral test for the daemon's `git.ensureExcluded` ('git-exclude-v1'):
 * a file Walnut created inside a checkout is appended to .git/info/exclude
 * unless git already ignores it, and nothing tracked or committed is touched.
 *
 * Runs the SOURCE twin's function text (daemon-source.ts is an embedded JS
 * template that cannot be imported), rebuilt with `new Function` like the other
 * daemon tests. Every repository is a fresh `git init` inside one mkdtemp
 * directory; HOME_DIR points inside it too, so `~` never means the real home.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(__dirname, '../..')

type Reply = { ok?: boolean; error?: string; outcome?: string; excludeFile?: string }
type Cmd = Record<string, unknown>

function extractTwin(homeDir: string): (cmd: Cmd) => Promise<Reply> {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8')
  const start = src.indexOf('const DAEMON_SOURCE = `')
  expect(start).toBeGreaterThan(-1)
  const body = src.slice(src.indexOf('`', start) + 1, src.lastIndexOf('`'))
  // eslint-disable-next-line no-eval
  const twin = eval('`' + body + '`') as string
  const grab = (header: string): string => {
    const i = twin.indexOf(header)
    expect(i, `${header} not found in the daemon template`).toBeGreaterThan(-1)
    const end = twin.indexOf('\n}', i)
    return twin.slice(i, end + 2)
  }
  const parts = [
    grab('function gitFileExec('),
    grab('function gitFileExpandHome('),
    grab('async function cmdGitEnsureExcluded('),
    'return { cmdGitEnsureExcluded };',
  ]
  let reply: Reply = {}
  const sendOk = (_ws: unknown, _id: unknown, data: Reply) => { reply = { ok: true, ...data } }
  const sendError = (_ws: unknown, _id: unknown, error: string) => { reply = { ok: false, error } }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  // The twin's gitFileExec does `require('child_process')` at call time.
  const factory = new Function('path', 'fs', 'require', 'HOME_DIR', 'sendOk', 'sendError', parts.join('\n')) as
    (...a: unknown[]) => Record<string, (...a: unknown[]) => Promise<void>>
  const fns = factory(path, fs, createRequire(import.meta.url), homeDir, sendOk, sendError)
  return async (cmd: Cmd) => { reply = {}; await fns.cmdGitEnsureExcluded(null, 1, cmd); return reply }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const isIgnored = (cwd: string, rel: string): boolean => {
  try { execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd, stdio: 'ignore' }); return true } catch { return false }
}

let tmp: string
let home: string
let ensure: (cmd: Cmd) => Promise<Reply>
const dirs: string[] = []

function freshRepo(name: string): string {
  const repo = path.join(tmp, name)
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q')
  // No global excludes may leak into the verdicts; the user's real
  // ~/.config/git/ignore is exactly the thing this command exists to not rely on.
  git(repo, 'config', 'core.excludesFile', path.join(tmp, 'empty-excludes'))
  return repo
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-git-exclude-')))
  dirs.push(tmp)
  home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'empty-excludes'), '')
  ensure = extractTwin(home)
})

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

describe('daemon git.ensureExcluded', () => {
  it('appends the file to .git/info/exclude when git does not ignore it, and git then does', async () => {
    const repo = freshRepo('repo')
    fs.mkdirSync(path.join(repo, '.claude'))
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}')
    expect(isIgnored(repo, '.claude/settings.local.json')).toBe(false)
    const r = await ensure({ cwd: repo, path: path.join(repo, '.claude', 'settings.local.json') })
    expect(r).toMatchObject({ ok: true, outcome: 'added' })
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8')).toMatch(/\/\.claude\/settings\.local\.json\n$/)
    expect(isIgnored(repo, '.claude/settings.local.json')).toBe(true)
    // Nothing tracked, nothing in the working tree changed.
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(fs.existsSync(path.join(repo, '.gitignore'))).toBe(false)
  })

  it('answers already when a .gitignore rule covers the file, and appends nothing', async () => {
    const repo = freshRepo('ignored')
    fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n')
    fs.mkdirSync(path.join(repo, '.claude'))
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}')
    const r = await ensure({ cwd: repo, path: path.join(repo, '.claude', 'settings.local.json') })
    expect(r).toMatchObject({ ok: true, outcome: 'already' })
    expect(fs.existsSync(path.join(repo, '.git', 'info', 'exclude')) && fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8').includes('settings.local'))
      .toBe(false)
  })

  it('leaves an already-tracked file alone (excluding it would change nothing)', async () => {
    const repo = freshRepo('tracked')
    fs.mkdirSync(path.join(repo, '.claude'))
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}')
    git(repo, 'add', '.claude/settings.local.json')
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'track it')
    const r = await ensure({ cwd: repo, path: path.join(repo, '.claude', 'settings.local.json') })
    expect(r).toMatchObject({ ok: true, outcome: 'already' })
    expect(fs.existsSync(path.join(repo, '.git', 'info', 'exclude')) && fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8').includes('settings.local'))
      .toBe(false)
  })

  it('answers not-a-repo outside any checkout and refuses a path outside the repository', async () => {
    const plain = path.join(tmp, 'plain')
    fs.mkdirSync(plain)
    expect(await ensure({ cwd: plain, path: path.join(plain, 'x.json') })).toMatchObject({ ok: true, outcome: 'not-a-repo' })
    const repo = freshRepo('bounded')
    const outside = await ensure({ cwd: repo, path: path.join(tmp, 'elsewhere.json') })
    expect(outside.ok).toBe(false)
    expect(outside.error).toMatch(/outside the repository/)
  })

  it('works from a subdirectory cwd, expands ~ against HOME_DIR, and keeps an existing exclude file intact', async () => {
    const repo = freshRepo(path.join('home', 'proj'))
    fs.mkdirSync(path.join(repo, 'sub', '.claude'), { recursive: true })
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '# mine\n*.log')
    fs.writeFileSync(path.join(repo, 'sub', '.claude', 'settings.local.json'), '{}')
    const r = await ensure({ cwd: '~/proj/sub', path: '~/proj/sub/.claude/settings.local.json' })
    expect(r).toMatchObject({ ok: true, outcome: 'added' })
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8')).toBe('# mine\n*.log\n/sub/.claude/settings.local.json\n')
    expect(isIgnored(repo, 'sub/.claude/settings.local.json')).toBe(true)
  })

  it('accepts a checkout reached through a symlink (macOS /var and /tmp), where git reports the resolved path', async () => {
    const repo = freshRepo('real-repo')
    fs.mkdirSync(path.join(repo, '.claude'))
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}')
    const link = path.join(tmp, 'linked-repo')
    fs.symlinkSync(repo, link)
    // Both the cwd and the file path arrive through the link; `git rev-parse
    // --show-toplevel` answers with the real path, and the two must still agree.
    const r = await ensure({ cwd: link, path: path.join(link, '.claude', 'settings.local.json') })
    expect(r).toMatchObject({ ok: true, outcome: 'added' })
    expect(isIgnored(repo, '.claude/settings.local.json')).toBe(true)
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8')).toMatch(/\/\.claude\/settings\.local\.json\n$/)
    // A file that really is elsewhere is still refused, links or not.
    const outside = await ensure({ cwd: link, path: path.join(tmp, 'elsewhere.json') })
    expect(outside.error).toMatch(/outside the repository/)
  })

  it('validates its arguments before running git', async () => {
    expect((await ensure({ path: '/x' })).error).toMatch(/missing cwd/)
    expect((await ensure({ cwd: '/x' })).error).toMatch(/missing path/)
  })
})
