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
    const build = indexOfOrFail('"$BUN_BIN" run web:build')
    const fileBuild = indexOfOrFail('scripts/build-binary.mjs" "${args[@]}"')
    const filesBuilt = indexOfOrFail('if build_files $FILE_TARGETS; then')
    const smoke = indexOfOrFail('Pre-kill smoke boot')
    const kill = indexOfOrFail('kill -15 $existing_pids')
    expect(smoke).toBeGreaterThan(dryRunExit) // dry run never reaches it
    expect(build).toBeGreaterThan(dryRunExit)
    expect(filesBuilt).toBeGreaterThan(build) // the file reuses the dist's web assets
    expect(fileBuild).toBeLessThan(filesBuilt)
    expect(smoke).toBeGreaterThan(filesBuilt) // it must boot the FRESH build
    expect(smoke).toBeLessThan(kill) // and fail before prod is touched
  })

  it('builds this machine\'s file and the Linux siblings in ONE build-binary run, reusing the dist\'s web assets', () => {
    expect(script).toMatch(/local -a args=\(--reuse-web --target "\$SELF_TARGET"\)/)
    expect(script).toMatch(/FILE_TARGETS="\$\{WALNUT_DEVPROD_FILE_TARGETS-linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl\}"/)
    // A failed sibling never blocks the deploy; a failed file for this machine aborts it, pre-kill.
    const retry = indexOfOrFail('building walnut-$SELF_TARGET alone')
    const abort = indexOfOrFail('Building the compiled file failed: deploy aborted')
    expect(abort).toBeLessThan(indexOfOrFail('kill -15 $existing_pids'))
    expect(retry).toBeLessThan(abort)
  })

  it('self-tests the staged file before the smoke boot, and a failed selftest aborts pre-kill', () => {
    const selftest = indexOfOrFail('"$SERVER_FILE" __selftest')
    const failed = indexOfOrFail('Self-test FAILED')
    const smoke = indexOfOrFail('Pre-kill smoke boot')
    expect(selftest).toBeLessThan(smoke)
    expect(script.slice(failed, smoke)).toMatch(/exit 1/)
    // Isolated like the smoke boot: its own home and daemon dir.
    const block = script.slice(script.lastIndexOf('SELFTEST_TMP="$(mktemp -d', selftest), selftest)
    expect(block).toMatch(/OPEN_WALNUT_HOME="\$SELFTEST_TMP\/home"/)
    expect(block).toMatch(/WALNUT_DAEMON_DIR="\$SELFTEST_TMP\/daemon"/)
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
  it('overrides the data dir, the daemon dir and the runtime tree to temp paths', () => {
    // Without WALNUT_DAEMON_DIR the smoke server attaches to (or version-bump
    // restarts) the PRODUCTION local daemon.
    expect(script).toMatch(/OPEN_WALNUT_HOME="\$SMOKE_TMP\/home"/)
    expect(script).toMatch(/WALNUT_DAEMON_DIR="\$SMOKE_TMP\/daemon"/)
    // The compiled file unpacks its tree into the smoke dir, not the stage the
    // production server runs from, and an inherited value is dropped first.
    expect(script).toMatch(/env -u VITEST -u OPEN_WALNUT_EPHEMERAL -u WALNUT_STREAMS_DIR -u WALNUT_RUNTIME_DIR/)
    expect(script).toMatch(/WALNUT_RUNTIME_DIR="\$SMOKE_TMP\/runtime"/)
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
    const body = script.slice(fn, script.indexOf('\n}\n', fn))
    // Whatever kind the last good build was: the compiled file or the Node dist.
    expect(body).toMatch(/lkg_rel="dist-bin\/walnut-\$MACHINE_TARGET"/)
    expect(body).toMatch(/lkg_rel="dist\/cli\.js"/)
    expect(body).toMatch(/launch_server "\$lkg_kind" "\$from\/\$lkg_rel"/)
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

  it('a crashing build never becomes the LKG: the live render check runs BEFORE the snapshot', () => {
    // 2026-09-18. The pre-kill smoke render runs against a TEMP data dir, so a
    // component that only mounts once there are real sessions never renders there
    // — a bundle built while such a component was half-saved passed the smoke
    // render and then crashed the live home page for ten minutes. The live check
    // closes that gap, and its position is the load-bearing part: snapshotting
    // first would make the crashing dist the thing a later failure rolls back TO.
    const live = indexOfOrFail('Live render FAILED')
    const snapshot = indexOfOrFail('if ! snapshot_lkg')
    expect(live).toBeLessThan(snapshot)
    const branch = script.slice(live, snapshot)
    expect(branch).toMatch(/stop_new_server|rollback_to_lkg/)
    expect(branch).toMatch(/rollback_to_lkg/)
    expect(branch).toMatch(/exit 1/)
  })

  it('the live render check probes the PRODUCTION port, after readiness', () => {
    // Against :$PORT, not the smoke port: the real data is the whole point.
    const ready = indexOfOrFail('if [[ "$ready" != "1" ]]; then')
    const call = indexOfOrFail('"http://localhost:$PORT/" --timeout-ms')
    expect(call).toBeGreaterThan(ready)
    expect(script.slice(0, call)).toContain('devprod-render-check.mjs')
  })

  it('an UNDETERMINED live render keeps the new server unless STRICT is set', () => {
    // A render check that cannot tell (no browser, page never settled under
    // machine load) must not roll back a healthy deploy — that would turn a busy
    // Mac into an outage of its own.
    const call = indexOfOrFail('"http://localhost:$PORT/" --timeout-ms')
    const fail = indexOfOrFail('Live render FAILED')
    const between = script.slice(call, fail)
    expect(between).toMatch(/live_render_rc"? == "2"/)
    expect(between).toMatch(/WALNUT_DEVPROD_RENDER_STRICT/)
    expect(between).toMatch(/live_render_rc=0/)
  })

  it('verifies a launchctl submit actually registered, with a nohup fallback', () => {
    // 2026-08-23: a submit silently created nothing and the readiness window
    // probed a server that never existed. The check asks the job's own domain.
    const check = indexOfOrFail('elif ! launchd_job_exists; then')
    const fallback = script.indexOf('use_launchd=0', check)
    expect(fallback).toBeGreaterThan(check)
  })
})

describe('the rollback snapshot survives a reboot', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../../scripts/dev-prod.sh'), 'utf-8')
  it('lives off the temp dir by default, is booted from a staged temp copy, and the old temp one is still read', () => {
    expect(script).toMatch(/^LKG_DIR="\$\{WALNUT_DEVPROD_LKG_DIR:-\$\{XDG_STATE_HOME:-\$HOME\/\.local\/state\}\/open-walnut\/open-walnut-lkg\}"$/m)
    const fn = script.slice(script.indexOf('rollback_to_lkg() {'))
    expect(fn).toMatch(/local rb="\$STAGE_ROOT\/open-walnut-stage\.\$\(date \+%s\)\.\$\$\.lkg"/)
    expect(fn).toMatch(/lkg="\$LKG_LEGACY_DIR"/)
    // A compiled-file snapshot is staged the same way, its runtime tree with it.
    expect(fn).toMatch(/clone_copy "\$lkg\/dist-bin" "\$rb\/dist-bin"/)
    expect(fn).toMatch(/clone_copy "\$lkg\/runtime" "\$rb\/runtime"/)
    // The stray-server sweep still recognises both launch shapes.
    expect(script).toContain('*"open-walnut-stage."*"/dist/cli.js"*')
    expect(script).toContain('*"open-walnut-lkg/dist/cli.js"*')
  })
})
