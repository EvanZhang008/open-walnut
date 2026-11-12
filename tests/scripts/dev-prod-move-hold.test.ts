/**
 * A task move production starts while a deploy builds holds the deploy's stop of production, not
 * only the queue before the build (2026-11-12: a build took 28 minutes at a load of 70, a move
 * began 18 minutes into it, and the restart cut that move). scripts/dev-prod.sh calls
 * dq_hold_moves (scripts/lib/deploy-queue.sh) right before it stops the old server: it waits while
 * a live marker names a move, at most WALNUT_DEPLOY_MOVE_HOLD_SECS from the start of that wait, and
 * says which task. A forced deploy does not wait, and a dry run never gets there. The waiting runs
 * here in the Mac's own bash 3.2 (/bin/bash) where there is one.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const REPO = path.join(import.meta.dirname, '..', '..')
const LIB = path.join(REPO, 'scripts', 'lib', 'deploy-queue.sh')
const script = fs.readFileSync(path.join(REPO, 'scripts', 'dev-prod.sh'), 'utf-8')
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-devprod-move-hold-'))
afterAll(() => { if (root.includes('walnut-devprod-move-hold-')) fs.rmSync(root, { recursive: true, force: true }) })

let n = 0
function movesDir(): string {
  const d = path.join(root, String(++n), 'running-switches')
  fs.mkdirSync(d, { recursive: true })
  return d
}
/** A live server's marker (this test's process stands in for the server). */
function marker(dir: string, task: string, at = Math.floor(Date.now() / 1000)): string {
  const f = path.join(dir, task)
  fs.writeFileSync(f, `${process.pid} ${at} ${task} 0123abcdef01 move to cloud\n`)
  return f
}
/** `cmd` in bash with the queue library sourced, as dev-prod.sh sources it (set -euo pipefail). */
function bash(cmd: string, env: Record<string, string>): Promise<{ code: number; out: string; ms: number }> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const p = spawn(BASH, ['-c', `set -euo pipefail\n. "${LIB}"\n${cmd}`], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, WALNUT_DEPLOY_MOVE_POLL_SECS: '1', ...env },
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => resolve({ code: code ?? -1, out, ms: Date.now() - t0 }))
  })
}

describe('dev-prod.sh holds the stop for a move that started during the build', () => {
  it('a marker that appeared after the queue looked holds the stop until the move ends', async () => {
    const dir = movesDir()
    const env = { WALNUT_DEPLOY_MOVES_DIR_TEST: dir, WALNUT_DEPLOY_MOVE_HOLD_SECS: '60' }
    // The queue looked before the build: no move then.
    expect((await bash('printf "[%s]" "$(dq_moving)"', env)).out).toBe('[]')
    // During the build a move starts; it ends 2.5 s after the stop began to wait.
    const m = marker(dir, 'mvtask-build')
    const held = bash('dq_hold_moves; echo STOPS', env)
    setTimeout(() => fs.rmSync(m, { force: true }), 2_500)
    const r = await held
    expect(r.code, r.out).toBe(0)
    expect(r.ms).toBeGreaterThanOrEqual(2_400)
    expect(r.ms).toBeLessThan(20_000)
    expect(r.out).toMatch(/production runs a move \(task mvtask-build \(move to cloud\)\): stopping it waits for the move to end, until .* at the latest/)
    expect(r.out).toMatch(/the move ended: production stops now\nSTOPS\n$/)
  }, 60_000)

  it('the hold is bounded, counted from when the stop began to wait', async () => {
    const dir = movesDir()
    // A marker whose age never passes the hold (its clock ahead): only the hold's own bound ends it.
    marker(dir, 'mvtask-long', Math.floor(Date.now() / 1000) + 600)
    const r = await bash('dq_hold_moves; echo STOPS', { WALNUT_DEPLOY_MOVES_DIR_TEST: dir, WALNUT_DEPLOY_MOVE_HOLD_SECS: '3' })
    expect(r.code, r.out).toBe(0)
    expect(r.ms).toBeGreaterThanOrEqual((3 - 1) * 1_000) // date +%s counts whole seconds
    expect(r.ms).toBeLessThan(20_000)
    expect(r.out).toMatch(/the move \(task mvtask-long \(move to cloud\)\) still runs at the end of its 3s hold: production stops, and the move runs again after the restart\nSTOPS\n$/)
  }, 60_000)

  it('no live move: no wait and no line; a dead server\'s or an old marker holds nothing', async () => {
    const dir = movesDir()
    fs.writeFileSync(path.join(dir, 'mvtask-dead'), `999999 ${Math.floor(Date.now() / 1000)} mvtask-dead 0123abcdef01 move to cloud\n`)
    marker(dir, 'mvtask-old', Math.floor(Date.now() / 1000) - 3_600)
    const r = await bash('dq_hold_moves; echo STOPS', { WALNUT_DEPLOY_MOVES_DIR_TEST: dir, WALNUT_DEPLOY_MOVE_HOLD_SECS: '1800' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toBe('STOPS\n')
    expect(r.ms).toBeLessThan(5_000)
  })

  it('dev-prod.sh waits right before the stop: after the build, smoke boot and plugin check, never forced, never on a dry run', () => {
    const at = (s: string) => { const i = script.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
    const hold = at('if [[ "${WALNUT_DEVPROD_FORCE:-0}" != "1" ]]; then dq_hold_moves; fi')
    expect(script.match(/dq_hold_moves;/g)).toHaveLength(1)
    expect(at('. "$REPO_ROOT/scripts/lib/deploy-queue.sh"')).toBeLessThan(hold)
    expect(hold).toBeGreaterThan(at('[dry-run] stopping before build, server kill and launch'))
    expect(hold).toBeGreaterThan(at('# ── Pre-kill smoke boot'))
    expect(hold).toBeGreaterThan(at('# ── Pre-kill plugin load check'))
    expect(hold).toBeLessThan(at('\ndrain_active_turns\n'))
    expect(hold).toBeLessThan(at('kill -15 $existing_pids'))
    // One reader of the markers: dev-prod.sh reuses the queue's, never a copy of it.
    const readers = ['scripts/dev-prod.sh', 'scripts/deploy-committed.sh', 'scripts/lib/deploy-queue.sh']
      .filter((f) => /running-switches/.test(fs.readFileSync(path.join(REPO, f), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')))
    expect(readers).toEqual(['scripts/lib/deploy-queue.sh'])
    expect(fs.readFileSync(LIB, 'utf8').match(/^dq_moving\(\) \{/gm)).toHaveLength(1)
  })
})
