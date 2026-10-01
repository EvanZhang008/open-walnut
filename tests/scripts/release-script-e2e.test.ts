/**
 * `npm run release` end to end, in a throwaway repository with a bare origin and
 * a fake `gh` that answers the CI question.
 *
 * The case that matters most: this repository's own worktree is never clean
 * (several agents work in it at once), so a release must succeed with unrelated
 * uncommitted and staged work present, commit ONLY the three release files, and
 * leave that other work exactly as it was. Also: CI red / still running stops it,
 * an unanswerable CI question does not, edits to a release file stop it, and a
 * dry run changes nothing.
 */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = path.resolve(__dirname, '../..')

/** No inherited GIT_* (a hook exports GIT_DIR, which outranks cwd) and no user git config. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Release Test', GIT_AUTHOR_EMAIL: 'release@example.test',
    GIT_COMMITTER_NAME: 'Release Test', GIT_COMMITTER_EMAIL: 'release@example.test',
    ...extra,
  }
}

let tmp: string
let work: string
let origin: string
let fakeBin: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: work, env: cleanEnv(), encoding: 'utf8' }).trim()
}

/**
 * `ci` is what the fake gh reports for any commit: green | red | pending | none | broken.
 * Async, so a slow run (git under load) never blocks the vitest worker.
 */
function release(ci: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['scripts/release.mjs', ...args], {
      cwd: work,
      encoding: 'utf8',
      env: cleanEnv({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_GH_CI: ci }),
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

const FAKE_GH = `#!/usr/bin/env node
const ci = process.env.FAKE_GH_CI
const endpoint = process.argv[3] || ''
if (ci === 'broken') { process.stderr.write('gh: not logged in\\n'); process.exit(4) }
const out = (o) => process.stdout.write(JSON.stringify(o))
if (endpoint.includes('/jobs')) out({ jobs: [{ name: 'CI OK', conclusion: ci === 'green' ? 'success' : 'failure' }] })
else if (ci === 'none') out({ workflow_runs: [] })
else out({ workflow_runs: [{ id: 1, head_sha: 'x', created_at: '2026-10-01T00:00:00Z', html_url: 'https://example.test/runs/1',
  status: ci === 'pending' ? 'in_progress' : 'completed', conclusion: ci === 'pending' ? null : (ci === 'green' ? 'success' : 'failure') }] })
`

const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n\n## [0.5.1] - 2026-09-28\n\n- Old.\n'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-release-e2e-'))
  work = path.join(tmp, 'work')
  origin = path.join(tmp, 'origin.git')
  fakeBin = path.join(tmp, 'bin')
  fs.mkdirSync(path.join(work, 'scripts'), { recursive: true })
  fs.mkdirSync(fakeBin)
  fs.writeFileSync(path.join(fakeBin, 'gh'), FAKE_GH, { mode: 0o755 })
  for (const f of ['release.mjs', 'ci-gate.mjs']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(work, 'scripts', f))
  const pkg = { name: 'open-walnut', version: '0.5.1', scripts: { release: 'node scripts/release.mjs' } }
  fs.writeFileSync(path.join(work, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  const lock = { name: 'open-walnut', version: '0.5.1', lockfileVersion: 3, requires: true, packages: { '': { name: 'open-walnut', version: '0.5.1' } } }
  fs.writeFileSync(path.join(work, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
  fs.writeFileSync(path.join(work, 'CHANGELOG.md'), CHANGELOG)
  fs.writeFileSync(path.join(work, 'notes.txt'), 'committed\n')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: cleanEnv() })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main')
  // Somebody else's work in progress: one unstaged edit, one staged new file.
  fs.writeFileSync(path.join(work, 'notes.txt'), 'committed\nhalf-written by a peer\n')
  fs.writeFileSync(path.join(work, 'staged.txt'), 'staged by a peer\n')
  git('add', 'staged.txt')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('npm run release in a shared, dirty worktree', { timeout: 120_000 }, () => {
  it('commits only the release files, tags, pushes atomically, and leaves other work untouched', async () => {
    const before = git('status', '--porcelain')
    const head = git('rev-parse', 'HEAD')
    const r = await release('green', 'patch')
    expect(r.code, r.out).toBe(0)

    expect(git('log', '-1', '--format=%s')).toBe('release: 0.5.2')
    expect(git('rev-parse', 'HEAD^')).toBe(head)
    expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['CHANGELOG.md', 'package-lock.json', 'package.json'])
    expect(git('rev-parse', 'v0.5.2^{commit}')).toBe(git('rev-parse', 'HEAD'))
    expect(git('cat-file', '-t', 'v0.5.2')).toBe('tag')

    const pkg = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8'))
    const lock = JSON.parse(fs.readFileSync(path.join(work, 'package-lock.json'), 'utf8'))
    expect([pkg.version, lock.version, lock.packages[''].version]).toEqual(['0.5.2', '0.5.2', '0.5.2'])
    const changelog = fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8')
    expect(changelog).toMatch(/## \[Unreleased\]\n\n## \[0\.5\.2\] - \d{4}-\d{2}-\d{2}\n\n### Added\n\n- A thing\./)

    // The peer's work: same status lines, same contents, the staged file still staged.
    expect(git('status', '--porcelain')).toBe(before)
    expect(fs.readFileSync(path.join(work, 'notes.txt'), 'utf8')).toBe('committed\nhalf-written by a peer\n')
    expect(git('diff', '--cached', '--name-only')).toBe('staged.txt')

    // Origin has both.
    const remote = execFileSync('git', ['ls-remote', origin], { env: cleanEnv(), encoding: 'utf8' })
    expect(remote).toContain(`${git('rev-parse', 'HEAD')}\trefs/heads/main`)
    expect(remote).toContain('refs/tags/v0.5.2')

    // A second run has nothing to release.
    const again = await release('green', 'patch')
    expect(again.code).toBe(1)
    expect(again.out).toContain('is empty')
  })

  it('stops on CI that failed, is still running, or never ran, and changes nothing', async () => {
    const head = git('rev-parse', 'HEAD')
    const cases: Array<[string, string]> = [
      ['red', 'CI did not pass'],
      ['pending', 'CI is still running'],
      ['none', 'no CI run found'],
    ]
    for (const [ci, message] of cases) {
      const r = await release(ci, 'patch')
      expect(r.code, ci).toBe(1)
      expect(r.out).toContain(message)
      expect(git('rev-parse', 'HEAD')).toBe(head)
      expect(git('tag', '--list')).toBe('')
    }
    expect(JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')).version).toBe('0.5.1')
  })

  it('goes on when GitHub cannot be asked (the workflow checks again before publishing)', async () => {
    const r = await release('broken', 'minor', '--no-push')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('could not ask GitHub')
    expect(git('log', '-1', '--format=%s')).toBe('release: 0.6.0')
    // --no-push: origin still at the old commit, no tag there.
    const remote = execFileSync('git', ['ls-remote', origin], { env: cleanEnv(), encoding: 'utf8' })
    expect(remote).not.toContain('v0.6.0')
    expect(r.out).toContain('git push --atomic origin main v0.6.0')
  })

  it('refuses while a release file has uncommitted edits', async () => {
    fs.appendFileSync(path.join(work, 'CHANGELOG.md'), '\n- Still writing this.\n')
    const r = await release('green', 'patch')
    expect(r.code).toBe(1)
    expect(r.out).toContain('uncommitted edits to the release files')
    expect(r.out).toContain('CHANGELOG.md')
  })

  it('a dry run writes, commits, tags and pushes nothing', async () => {
    const head = git('rev-parse', 'HEAD')
    const status = git('status', '--porcelain')
    const r = await release('green', 'patch', '--dry-run')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('would commit "release: 0.5.2"')
    expect(r.out).toContain('nothing was written, committed, tagged or pushed')
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('status', '--porcelain')).toBe(status)
    expect(git('tag', '--list')).toBe('')
  })

  it('refuses when main is not at origin/main', async () => {
    fs.writeFileSync(path.join(work, 'other.txt'), 'x\n')
    git('add', 'other.txt')
    git('commit', '-q', '-m', 'local only')
    const r = await release('green', 'patch')
    expect(r.code).toBe(1)
    expect(r.out).toContain('main is not at origin/main')
  })
})
