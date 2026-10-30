/**
 * Ratchet for NO_AUTO_MAINTENANCE_ENV in tests/setup/git-env-isolation.ts: no git
 * a test runs leaves a detached `git maintenance` behind to write into a `.git`
 * the test is removing (2026-10-30: git-sync-plugin-files read "bad object HEAD"
 * on every macOS run with git 2.55).
 *
 * MACHINE SAFETY: repos are temp dirs; GIT_TRACE goes to a file inside them.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NO_AUTO_MAINTENANCE_ENV } from './git-env-isolation'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** The git commands a commit in a fresh repo starts, read from GIT_TRACE. */
function commandsOfCommit(env: NodeJS.ProcessEnv): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-no-maint-'))
  dirs.push(dir)
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    execFileSync('git', args, { cwd: repo, env: { ...env, ...extra }, stdio: 'pipe', timeout: 30_000 })
  run(['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  run(['add', '-A'])
  const trace = path.join(dir, 'trace.log')
  run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'a'], { GIT_TRACE: trace })
  return fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : ''
}

describe('a test\'s git leaves no process behind', () => {
  it('the setup turns automatic maintenance off for every git a test spawns', () => {
    for (const [k, v] of Object.entries(NO_AUTO_MAINTENANCE_ENV)) expect(process.env[k], k).toBe(v)
  })

  it('a commit under the test env starts no maintenance', () => {
    expect(commandsOfCommit({ ...process.env, ...NO_AUTO_MAINTENANCE_ENV })).not.toMatch(/maintenance run/)
  })

  it('without it this git does start one (so the setting is what keeps it off)', (ctx) => {
    const env = { ...process.env }
    for (const k of Object.keys(NO_AUTO_MAINTENANCE_ENV)) delete env[k]
    const trace = commandsOfCommit(env)
    // Git before 2.47 runs it attached or not at all: nothing to prove there.
    if (!/maintenance run/.test(trace)) ctx.skip()
    expect(trace).toMatch(/maintenance run --auto/)
  })
})
