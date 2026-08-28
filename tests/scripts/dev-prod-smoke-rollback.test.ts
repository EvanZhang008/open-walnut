/**
 * scripts/dev-prod.sh: pre-kill smoke boot + last-known-good (LKG) rollback.
 *
 * Two outage shapes these guard against (2026-08-22/23):
 *   1. A dist built from a broken working tree hangs in module init and never
 *      binds — the old flow discovered that only AFTER killing the healthy prod
 *      server. The smoke boot must run the fresh dist, fully isolated, BEFORE
 *      the kill, so a bad build fails the deploy with prod still serving.
 *   2. A readiness failure after the kill used to leave :3456 dark until a
 *      human noticed. The failure branch must roll back to the last dist that
 *      passed readiness.
 *
 * Everything here is a static ordering/content ratchet plus a syntax check —
 * the smoke/rollback paths themselves only run in a real (non-dry-run) deploy,
 * which would target production :3456.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

function indexOfOrFail(needle: string, from = 0): number {
  const i = script.indexOf(needle, from)
  expect(i, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(-1)
  return i
}

describe('dev-prod.sh smoke boot ordering', () => {
  it('is valid bash', () => {
    execFileSync('bash', ['-n', SCRIPT])
  })

  it('runs after the build and BEFORE the prod-server kill', () => {
    const dryRunExit = indexOfOrFail('nothing was deployed')
    const build = indexOfOrFail('npm run web:build')
    const smoke = indexOfOrFail('Pre-kill smoke boot')
    const kill = indexOfOrFail('kill -15 $existing_pids')
    expect(smoke).toBeGreaterThan(dryRunExit) // dry run never reaches it
    expect(smoke).toBeGreaterThan(build) // it must boot the FRESH dist
    expect(smoke).toBeLessThan(kill) // and fail before prod is touched
  })

  it('aborts the deploy (prod untouched) when the smoke boot fails', () => {
    const smoke = indexOfOrFail('Smoke boot FAILED')
    const kill = indexOfOrFail('kill -15 $existing_pids')
    expect(smoke).toBeLessThan(kill)
    // The failure branch must exit, not fall through to the kill.
    const branch = script.slice(smoke, kill)
    expect(branch).toMatch(/exit 1/)
  })
})

describe('dev-prod.sh smoke boot isolation', () => {
  it('overrides BOTH the data dir and the daemon dir to temp paths', () => {
    // Without WALNUT_DAEMON_DIR the smoke server attaches to (or version-bump
    // restarts) the PRODUCTION local daemon.
    expect(script).toMatch(/OPEN_WALNUT_HOME="\$SMOKE_TMP\/home"/)
    expect(script).toMatch(/WALNUT_DAEMON_DIR="\$SMOKE_TMP\/daemon"/)
  })

  it('temp home is NOT named open-walnut-* (resolveOpenWalnutHome would silently revert it to prod data)', () => {
    const mktempLine = script.split('\n').find((l) => l.includes('SMOKE_TMP="$(mktemp -d'))
    expect(mktempLine).toBeDefined()
    expect(mktempLine).toContain('walnut-smoke.')
    expect(mktempLine).not.toContain('open-walnut-')
  })

  it('never boots the smoke server on the production port', () => {
    // The smoke launch line must use the derived probe port, and the derivation
    // stays in a range that cannot collide with :3456.
    expect(script).toMatch(/web --port "\$smoke_port"/)
    expect(script).toMatch(/20000 \+ \$\$ % 20000/)
  })

  it('reaps the smoke daemon with an input floor (never signals pid <= 1)', () => {
    // 2026-08-09 kill(-1) class: any pid read from a file gets a numeric check
    // and a floor in the implementation before any signal is sent.
    expect(script).toMatch(/\[\[ "\$dpid" =~ \^\[0-9\]\+\$ \]\] && \(\( 10#\$dpid > 1 \)\)/)
    // ...and only a process that still looks like a daemon.
    expect(script).toMatch(/case "\$dcmd" in/)
  })

  it('can be skipped explicitly for emergencies', () => {
    expect(script).toMatch(/WALNUT_DEVPROD_SKIP_SMOKE/)
  })
})

describe('dev-prod.sh last-known-good rollback', () => {
  it('snapshots the dist only AFTER readiness passed', () => {
    const readyGate = indexOfOrFail('if [[ "$ready" != "1" ]]; then')
    const snapshot = indexOfOrFail('if ! snapshot_lkg', readyGate)
    // The snapshot call sits after the failure branch, i.e. only a dist that
    // just served /api/config at nice 0 earns LKG status.
    expect(snapshot).toBeGreaterThan(readyGate)
    expect(script.slice(readyGate, snapshot)).toMatch(/exit 1/)
  })

  it('readiness failure rolls back to the LKG dist before exiting', () => {
    const fail = indexOfOrFail('Server failed its bounded readiness check')
    const snapshot = indexOfOrFail('if ! snapshot_lkg')
    const branch = script.slice(fail, snapshot)
    expect(branch).toMatch(/rollback_to_lkg/)
    expect(branch).toMatch(/exit 1/) // the deploy itself still fails
  })

  it('EVERY post-kill failure exit rolls back (process death and nice abort too)', () => {
    // The readiness timeout was the only path that rolled back; the other two
    // post-kill exits left :3456 dark with no rollback at all.
    const fn = indexOfOrFail('rollback_to_lkg() {')
    expect(script.slice(fn)).toMatch(/launch_server "\$LKG_DIR\/dist\/cli\.js"/)
    for (const marker of [
      'Server process exited before becoming ready.',
      'deployment aborted.',
      'Server failed its bounded readiness check.',
    ]) {
      const at = indexOfOrFail(marker)
      const exitAt = indexOfOrFail('exit 1', at)
      expect(
        script.slice(at, exitAt),
        `failure exit after ${JSON.stringify(marker)} must call rollback_to_lkg`,
      ).toMatch(/rollback_to_lkg/)
    }
  })

  it('verifies a launchctl submit actually registered, with a nohup fallback', () => {
    // 2026-08-23: a submit silently created nothing and the readiness window
    // probed a server that never existed.
    const check = indexOfOrFail('launchctl list "$LAUNCH_LABEL"')
    const fallback = script.indexOf('use_launchd=0', check)
    expect(fallback).toBeGreaterThan(check)
  })
})
