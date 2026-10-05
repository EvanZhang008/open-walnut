/**
 * scripts/deploy-committed.sh deploys a COMMIT, never the shared working tree:
 * it clones the commit into a temp dir, links the checkout's dependencies (the
 * npm workspace packages excepted: those must be the committed ones), and runs
 * the clone's dev-prod.sh with WALNUT_DEVPROD_SERVE_ROOT pointing back at the
 * checkout. Pinned here against a throwaway repo whose dev-prod.sh is a stub that
 * reports what it saw, so nothing is built and no server is touched.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { gitChildEnv } from '../../src/lib/git-env.js'

const WRAPPER = path.join(import.meta.dirname, '..', '..', 'scripts', 'deploy-committed.sh')
const roots: string[] = []

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitChildEnv(), stdio: 'pipe' }).toString().trim()

/** The stub records where it ran and what the workspace and dependency links resolve to. */
const STUB = `#!/usr/bin/env bash
# knows WALNUT_DEVPROD_SERVE_ROOT
set -euo pipefail
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd -P)"
{
  echo "serve=$WALNUT_DEVPROD_SERVE_ROOT"
  echo "here=$here"
  echo "cwd=$(pwd -P)"
  echo "ws=$(cd node_modules/@acme/lib && pwd -P)"
  echo "ws_file=$(cat node_modules/@acme/lib/index.js)"
  echo "dep=$(cd node_modules/leftpad && pwd -P)"
  echo "scoped_dep=$(cd node_modules/@acme/other && pwd -P)"
  echo "web_dep=$(cd web/node_modules && pwd -P)"
  echo "app=$(cat app.txt)"
  echo "dry=\${WALNUT_DEVPROD_DRY_RUN:-}"
} > "$WALNUT_TEST_REPORT"
`

function fixture(opts: { stub?: string } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-committed-')))
  roots.push(root)
  const repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'packages', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'web'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'open-walnut', workspaces: ['packages/lib'] }))
  fs.writeFileSync(path.join(repo, 'packages', 'lib', 'package.json'), JSON.stringify({ name: '@acme/lib' }))
  fs.writeFileSync(path.join(repo, 'packages', 'lib', 'index.js'), 'committed lib\n')
  fs.writeFileSync(path.join(repo, 'web', 'index.html'), '<p>app</p>\n')
  fs.writeFileSync(path.join(repo, 'app.txt'), 'committed app\n')
  fs.copyFileSync(WRAPPER, path.join(repo, 'scripts', 'deploy-committed.sh'))
  fs.writeFileSync(path.join(repo, 'scripts', 'dev-prod.sh'), opts.stub ?? STUB)
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A')
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base')
  // The checkout's dependencies, as npm lays them out: a workspace link into its own packages/.
  fs.mkdirSync(path.join(repo, 'node_modules', 'leftpad'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'node_modules', '@acme', 'other'), { recursive: true })
  fs.symlinkSync('../../packages/lib', path.join(repo, 'node_modules', '@acme', 'lib'))
  fs.mkdirSync(path.join(repo, 'web', 'node_modules'), { recursive: true })
  // A peer's uncommitted edits: neither may reach the build.
  fs.writeFileSync(path.join(repo, 'app.txt'), 'half-written app\n')
  fs.writeFileSync(path.join(repo, 'packages', 'lib', 'index.js'), 'half-written lib\n')
  const tmp = path.join(root, 'tmp')
  fs.mkdirSync(tmp)
  return { repo, tmp, report: path.join(root, 'report.txt') }
}

function run(f: ReturnType<typeof fixture>, env: Record<string, string> = {}, args: string[] = []) {
  const r = spawnSync('bash', [path.join(f.repo, 'scripts', 'deploy-committed.sh'), ...args], {
    cwd: f.repo,
    encoding: 'utf-8',
    env: { ...gitChildEnv(), TMPDIR: f.tmp, WALNUT_TEST_REPORT: f.report, ...env },
  })
  const report = fs.existsSync(f.report)
    ? Object.fromEntries(fs.readFileSync(f.report, 'utf-8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    : null
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report }
}

describe('deploy-committed.sh', () => {
  it('builds the committed tree in a clone and serves as the checkout', () => {
    const f = fixture()
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const rep = r.report!
    expect(rep.serve).toBe(f.repo)
    expect(rep.here).toMatch(new RegExp(`^${f.tmp}/open-walnut-build\\.[0-9a-f]{12}\\.\\d+$`))
    expect(rep.cwd).toBe(rep.here)
    // Committed content only: the peer's edits stay in the checkout.
    expect(rep.app).toBe('committed app')
    expect(rep.ws).toBe(path.join(rep.here, 'packages', 'lib'))
    expect(rep.ws_file).toBe('committed lib')
    // Everything else resolves from the checkout's node_modules.
    expect(rep.dep).toBe(path.join(f.repo, 'node_modules', 'leftpad'))
    expect(rep.scoped_dep).toBe(path.join(f.repo, 'node_modules', '@acme', 'other'))
    expect(rep.web_dep).toBe(path.join(f.repo, 'web', 'node_modules'))
    expect(rep.dry).toBe('1')
    // The clone is gone, the checkout untouched.
    expect(fs.existsSync(rep.here)).toBe(false)
    expect(fs.readFileSync(path.join(f.repo, 'app.txt'), 'utf-8')).toBe('half-written app\n')
    expect(git(f.repo, 'status', '--porcelain')).toBe('M app.txt\n M packages/lib/index.js'.trim())
    expect(git(f.repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('deploys a named commit, and keeps the clone on request', () => {
    const f = fixture()
    const first = git(f.repo, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(f.repo, 'app.txt'), 'second app\n')
    git(f.repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-am', 'second')
    const later = run(f, { WALNUT_DEPLOY_KEEP_BUILD: '1' })
    expect(later.status).toBe(0)
    expect(later.report!.app).toBe('second app')
    expect(later.stdout).toMatch(/Build clone kept: /)
    expect(fs.existsSync(later.report!.here)).toBe(true)
    const earlier = run(f, {}, [first])
    expect(earlier.status).toBe(0)
    expect(earlier.report!.app).toBe('committed app')
  })

  it('refuses a ref that is not a commit, and a commit whose dev-prod.sh predates the serve root', () => {
    const f = fixture()
    const bad = run(f, {}, ['no-such-ref'])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/Not a commit in .*: no-such-ref/)
    const old = fixture({ stub: '#!/usr/bin/env bash\necho "would serve from the clone" > "$WALNUT_TEST_REPORT"\n' })
    const r = run(old)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/predates WALNUT_DEVPROD_SERVE_ROOT/)
    expect(r.report).toBeNull()
    expect(fs.readdirSync(old.tmp)).toEqual([])
  })

  it('passes the stub\'s failure through and still removes the clone', () => {
    const f = fixture({ stub: '#!/usr/bin/env bash\n# WALNUT_DEVPROD_SERVE_ROOT\necho "build failed" >&2\nexit 7\n' })
    const r = run(f)
    expect(r.status).toBe(7)
    expect(r.stderr).toMatch(/build failed/)
    expect(fs.readdirSync(f.tmp)).toEqual([])
  })
})
