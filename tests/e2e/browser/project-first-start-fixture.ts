/**
 * The fixture data both v6 draft specs share (project-first-start.spec.ts and
 * project-first-start-where.spec.ts): the fixture server's home, a stamp kept in that home, and
 * the projects made once per server (Marina: a git source; Acme: a plugin source; Life: none;
 * Acme gone: a git source a test removes; Notes: none, and none is ever added).
 *
 * One stamp per fixture server, kept in its home: a worker that restarts after a failure imports
 * the specs again, and a second set of projects on the same checkout would make its folder belong
 * to two projects (detection then names neither).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { PORT, SHOTS, makeProject } from './project-first-start-helpers'

export const fx = { home: '', stamp: '', MARINA: '', ACME: '', LIFE: '', GONE: '', NOTES: '' }
/** A project of the fixture that syncs to its outside service. */
export const SYNCED = 'Atlas'
export const SERVICE = 'plugin-a'
export const DEVBOX = { key: 'devbox', label: 'Dev box' }
export const APP = (): string => path.join(fx.home, 'ws-fixture', 'app')
/** A checkout of its own for the project whose source goes away, so it never shares APP's folder. */
export const GONE_REPO = (): string => path.join(fx.home, 'ws-fixture', 'gone-repo')
/** The checkout the Code source test gives Life: its own, so no other test's folder gets a second
 *  project (detection then names neither, whichever spec runs first). */
export const LIFE_REPO = (): string => path.join(fx.home, 'ws-fixture', 'life-repo')
export const PLAIN = (): string => path.join(fx.home, 'ws-fixture', `plain-${fx.stamp}`)
export const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString()

/** The specs' beforeAll: the names, and the projects on a fresh server. */
export async function setupFixture(request: APIRequestContext): Promise<void> {
  ;({ walnutHome: fx.home } = await discoverBrowserFixture(PORT))
  const real = fs.realpathSync(fx.home)
  if (!real.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error(`fixture home ${fx.home} is not a temp dir`)
  fs.mkdirSync(SHOTS, { recursive: true })
  const stampFile = path.join(fx.home, 'project-first-start.stamp')
  const fresh = !fs.existsSync(stampFile)
  if (fresh) fs.writeFileSync(stampFile, Date.now().toString(36))
  fx.stamp = fs.readFileSync(stampFile, 'utf8').trim()
  Object.assign(fx, { MARINA: `Marina ${fx.stamp}`, ACME: `Acme ${fx.stamp}`, LIFE: `Life ${fx.stamp}`, GONE: `Acme gone ${fx.stamp}`, NOTES: `Notes ${fx.stamp}` })
  fs.mkdirSync(PLAIN(), { recursive: true })
  if (!fresh) return
  await makeProject(request, fx.MARINA, { workspace_source: { provider: 'git-worktree', anchor: APP() } })
  await makeProject(request, fx.ACME, {
    default_cwd: path.join(fx.home, 'ws-fixture', 'multi'),
    workspace_source: { provider: 'fake-multirepo', inputs: { packages: ['alpha', 'beta'] } },
  })
  await makeProject(request, fx.LIFE, {})
  await makeProject(request, fx.NOTES, {})
  gitRepo(GONE_REPO())
  gitRepo(LIFE_REPO())
  await makeProject(request, fx.GONE, { workspace_source: { provider: 'git-worktree', anchor: GONE_REPO() } })
}

/** A one-commit git repository at `dir` (kept when it is there already). */
function gitRepo(dir: string): void {
  if (fs.existsSync(path.join(dir, '.git'))) return
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`)
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'init']]) {
    execFileSync('git', ['-c', 'user.name=Walnut Test', '-c', 'user.email=walnut-test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd: dir })
  }
}
