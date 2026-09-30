/**
 * scripts/dev-prod.sh: a deploy never leaves a KeepAlive job relaunching a
 * duplicate server.
 *
 * 2026-09-25, 02:42 to 09:36Z: the deploy killed the server the Mac app had
 * started, the Mac app's auto-restart spawned a replacement one second later, and
 * that replacement won the instance lock. Readiness passed (the Mac app's server
 * answered), while the deploy's own `launchctl submit` job exited as a duplicate
 * and launchd relaunched it about every 11s for seven hours.
 *
 * Two halves, both pinned here:
 *   - the job tells the server its label (WALNUT_LAUNCHD_LABEL), so a losing
 *     server removes its own job (src/core/launchd-self-remove.ts);
 *   - after readiness the script checks WHO serves the port, and removes a job
 *     that provably is not serving. The block is executed with stubbed
 *     `launchctl` / listener probes: nothing here touches launchd or a port.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

const BLOCK_START = '# ── Foreign supervisor: is :$PORT served by THIS deploy\'s job?'
const BLOCK_END = '# /api/config answers out of memory'

function block(): string {
  const a = script.indexOf(BLOCK_START)
  const b = script.indexOf(BLOCK_END, a)
  expect(a, 'foreign-supervisor block present').toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  return script.slice(a, b)
}

interface Stub { listener?: string; job?: 'absent' | 'nopid' | string; useLaunchd?: 0 | 1 }

function run(stub: Stub): { status: number | null; stdout: string; stderr: string } {
  const prelude = [
    'set -euo pipefail',
    'PORT=35999',
    'LAUNCH_LABEL=com.example.walnut-test',
    `use_launchd=${stub.useLaunchd ?? 1}`,
    `STUB_LISTENER='${stub.listener ?? ''}'`,
    `STUB_JOB='${stub.job ?? 'absent'}'`,
    'listener_pids() { if [[ -n "$STUB_LISTENER" ]]; then echo "$STUB_LISTENER"; fi; }',
    // `launchctl list <label>` exits 113 for an unknown label.
    'launchctl() {',
    '  if [[ "$1" == list ]]; then',
    '    if [[ "$STUB_JOB" == absent ]]; then return 113; fi',
    '    printf \'{\\n\\t"Label" = "%s";\\n\' "$2"',
    '    if [[ "$STUB_JOB" != nopid ]]; then printf \'\\t"PID" = %s;\\n\' "$STUB_JOB"; fi',
    '    echo "};"',
    '    return 0',
    '  fi',
    '  echo "UNEXPECTED launchctl $*"; return 1',
    '}',
    'ps() { echo "node /repo/dist/cli.js web --port 3456"; }',
    'remove_launchd_job() { echo REMOVED_JOB; }',
  ].join('\n')
  const r = spawnSync('bash', ['-c', `${prelude}\n${block()}\necho DONE`], { encoding: 'utf-8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('dev-prod.sh names its launchd job to the server', () => {
  it('passes WALNUT_LAUNCHD_LABEL in the submitted job environment', () => {
    const submit = script.slice(script.indexOf('submit_launchd_job() {'), script.indexOf('# The job\'s live PID'))
    expect(submit).toMatch(/WALNUT_LAUNCHD_LABEL="\$LAUNCH_LABEL" \\\n\s+"\$NODE_BIN" "\$1" web --port "\$PORT"/)
  })
})

describe('dev-prod.sh foreign-supervisor check', () => {
  it('runs after readiness passed and before the dist becomes last-known-good', () => {
    const readinessFail = script.indexOf('Server failed its bounded readiness check.')
    const check = script.indexOf(BLOCK_START)
    const lkg = script.indexOf('if ! snapshot_lkg; then')
    expect(readinessFail).toBeGreaterThan(-1)
    expect(lkg).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(readinessFail)
    expect(check).toBeLessThan(lkg)
    // It goes through the helper, so the first raw `launchctl remove` (which the
    // portability ratchets order after the drain) stays where it is.
    expect(block()).not.toMatch(/launchctl remove/)
  })

  it('leaves a job alone when its own process is the listener', () => {
    const r = run({ listener: '4242', job: '4242' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('DONE')
    expect(r.stdout).not.toContain('REMOVED_JOB')
    expect(r.stderr).toBe('')
  })

  it('removes the job when another process serves the port (the 2026-09-25 shape)', () => {
    const r = run({ listener: '4242', job: '5151' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('REMOVED_JOB')
    expect(r.stderr).toMatch(/served by PID 4242, not by launchd job 'com\.example\.walnut-test' \(PID 5151\)/)
  })

  it('removes a registered job that has no process (between KeepAlive relaunches)', () => {
    const r = run({ listener: '4242', job: 'nopid' })
    expect(r.stdout).toContain('REMOVED_JOB')
    expect(r.stderr).toMatch(/\(PID none\)/)
  })

  it('removes nothing when the job is not registered (it already removed itself)', () => {
    const r = run({ listener: '4242', job: 'absent' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('DONE')
    expect(r.stdout).not.toContain('REMOVED_JOB')
  })

  it('removes nothing when no listener could be read (a failed probe is not evidence)', () => {
    const r = run({ listener: '', job: '5151' })
    expect(r.stdout).toContain('DONE')
    expect(r.stdout).not.toContain('REMOVED_JOB')
  })

  it('does nothing on the nohup path (Linux)', () => {
    const r = run({ listener: '4242', job: '5151', useLaunchd: 0 })
    expect(r.stdout).toContain('DONE')
    expect(r.stdout).not.toContain('REMOVED_JOB')
  })
})
