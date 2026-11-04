/**
 * scripts/dev-prod.sh writes the planned-restart marker (src/core/planned-restart.ts) so
 * the outgoing server's feature-node journal says "deploy", not a bare SIGTERM. Written
 * only after every guard passed (the drain is the last one), before the first stop, and
 * never by a dry run. The writer runs here on its own against a temp HOME.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parsePlannedRestart } from '../../src/core/planned-restart.js'

const REPO = path.join(import.meta.dirname, '..', '..')
const script = fs.readFileSync(path.join(REPO, 'scripts', 'dev-prod.sh'), 'utf-8')

function writer(): string {
  const start = script.indexOf('PLANNED_RESTART_FILE=')
  const fnStart = script.indexOf('write_planned_restart() {', start)
  const fnEnd = script.indexOf('\n}\n', fnStart)
  expect(start).toBeGreaterThan(-1)
  expect(fnEnd).toBeGreaterThan(fnStart)
  return script.slice(start, fnEnd + 3)
}

let home = ''
afterEach(() => { if (home) fs.rmSync(home, { recursive: true, force: true }) })

function run(env: Record<string, string>): string {
  return execFileSync('bash', ['-c', `set -euo pipefail\n${writer()}\nwrite_planned_restart\necho WROTE`], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, encoding: 'utf-8',
  })
}

describe('dev-prod.sh planned-restart marker', () => {
  it('writes { at, reason: deploy, build } into the data home\'s local/, readable by the server', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-devprod-plan-'))
    fs.mkdirSync(path.join(home, '.open-walnut'))
    expect(run({ HOME: home, REPO_ROOT: REPO })).toContain('WROTE')
    const raw = fs.readFileSync(path.join(home, '.open-walnut', 'local', 'planned-restart.json'), 'utf8')
    const parsed = parsePlannedRestart(raw, Date.now())
    expect(parsed?.reason).toBe('deploy')
    const head = execFileSync('git', ['-C', REPO, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf-8' }).trim()
    expect(parsed?.build).toBe(head)
    expect(fs.readdirSync(path.join(home, '.open-walnut', 'local'))).toEqual(['planned-restart.json'])
  })

  it('writes a rehearsal\'s marker into the rehearsal\'s home, and nothing at all without a data home', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-devprod-plan-'))
    fs.mkdirSync(path.join(home, 'rehearsal'))
    run({ HOME: home, REPO_ROOT: REPO, REHEARSAL_HOME: path.join(home, 'rehearsal') })
    expect(fs.existsSync(path.join(home, 'rehearsal', 'local', 'planned-restart.json'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.open-walnut'))).toBe(false)
    // No data home, no git: still exit 0 and write nothing (a deploy never fails on it).
    const bare = path.join(home, 'bare')
    fs.mkdirSync(bare)
    expect(run({ HOME: bare, REPO_ROOT: path.join(home, 'nowhere') })).toContain('WROTE')
    expect(fs.readdirSync(bare)).toEqual([])
  })

  it('is written after the last guard (the drain) and before the first stop, never on the dry-run path', () => {
    const call = script.indexOf('\nwrite_planned_restart\n')
    const drain = script.indexOf('\ndrain_active_turns\n')
    const dryRunExit = script.indexOf('[dry-run] stopping before build, server kill and launch')
    const launchdRemove = script.indexOf('  if ! remove_launchd_job; then\n', script.indexOf('  use_launchd=1\n'))
    const killExisting = script.indexOf('kill -15 $existing_pids')
    for (const at of [call, drain, dryRunExit, launchdRemove, killExisting]) expect(at).toBeGreaterThan(-1)
    expect(script.indexOf('\nwrite_planned_restart\n', call + 1)).toBe(-1)
    expect(call).toBeGreaterThan(drain)
    expect(call).toBeGreaterThan(dryRunExit)
    expect(call).toBeLessThan(launchdRemove)
    expect(call).toBeLessThan(killExisting)
  })
})
