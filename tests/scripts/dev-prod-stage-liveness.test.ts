/**
 * scripts/dev-prod.sh: a stage directory a live process runs from is never
 * reaped, and readiness proves the web app is servable.
 *
 * The outage this pins (2026-09-02): the deploy's stage-reap loop concluded
 * "every prior server is dead" from lsof/pgrep, and deleted the staged dist of
 * the STILL-RUNNING :3456 server. node already had cli.js in memory, so
 * /api/config kept answering while `/` and every hashed asset 404ed with
 * `ENOENT … /dist/web/static/index.html` — for four hours, reaching the user as
 * "the Mac app is laggy" (open windows ran on their in-memory bundle; every
 * lazy chunk and image was gone, and a reload would have shown raw JSON).
 *
 * Two rules come out of it: ask the PROCESS TABLE before deleting a directory
 * someone might be executing from, and never call a server "ready" on the
 * strength of an endpoint that answers out of memory.
 *
 * The reap loop and the readiness check only run in a real deploy (which would
 * target production), so the loop's guard is exercised here as extracted bash
 * against a live sleep process, and the rest is a content/ordering ratchet.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

/** The guard function, lifted from the script so the test runs the real code. */
function stageGuardSource(): string {
  const start = script.indexOf('stage_has_live_process() {')
  expect(start, 'stage_has_live_process must exist').toBeGreaterThan(-1)
  const end = script.indexOf('\n}\n', start)
  return script.slice(start, end + 3)
}

describe('stage reap guard', () => {
  it('reports the PID of a process running from the stage, and nothing for an idle stage', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-stage-guard-'))
    const live = path.join(tmp, 'open-walnut-stage.live')
    const idle = path.join(tmp, 'open-walnut-stage.idle')
    fs.mkdirSync(path.join(live, 'dist'), { recursive: true })
    fs.mkdirSync(path.join(idle, 'dist'), { recursive: true })
    // A process actually EXECUTING <live>/dist/cli.js, exactly like a deployed
    // server: a shell script stands in for the bundle, so the path is in the
    // command line the way ps reports it for real. (Passing the path as a spare
    // argument to `sleep` or `sh -c` does not work — BSD sleep rejects extra
    // operands, and sh exec-replaces itself for a single simple command, which
    // drops them from the command line. Both made this test pass vacuously.)
    fs.writeFileSync(path.join(live, 'dist', 'cli.js'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
    // The command line deliberately carries a DOUBLE slash after the temp root
    // and the caller passes the /private-prefixed twin of the same directory:
    // that is how this guard reads in production (TMPDIR ends in a slash, and
    // /var is a symlink to /private/var). The first version matched on the full
    // path, so it found nothing for the live server — a guard that looks right
    // and protects nothing. Pin both spellings.
    const doubleSlashed = live.replace(`${tmp}/`, `${tmp}//`)
    const privatePath = live.startsWith('/var/') ? `/private${live}` : live
    // The stage paths travel as positional parameters, never spelled inside the
    // script text: the script IS the wrapper bash's command line, and pgrep -f
    // searches command lines. On Linux the wrapper (a lower PID than the probe)
    // would be reported as "the live process" and the test would fail against a
    // correct guard; macOS hid the problem because ps cannot read an argv this
    // long there and shows the bare executable instead.
    const out = execFileSync('bash', ['-c', `
      set -uo pipefail
      ${stageGuardSource()}
      /bin/sh "$1"/dist/cli.js web --port 3456 >/dev/null 2>&1 &
      probe_pid=$!
      # Generous: under machine load the background shell needs a moment to be
      # visible in the process table, and a premature probe reads as "not live"
      # (which is the pass-vacuously direction, so it must not be tight).
      sleep 1
      live_hit="$(stage_has_live_process "$2" || true)"
      private_hit="$(stage_has_live_process "$3" || true)"
      idle_hit="$(stage_has_live_process "$4" || true)"
      kill "$probe_pid" 2>/dev/null || true
      echo "live=[$live_hit] private=[$private_hit] idle=[$idle_hit] probe=[$probe_pid] cmd=[$(ps -o command= -p $probe_pid || true)]"
    `, 'stage-guard', doubleSlashed, live, privatePath, idle], { encoding: 'utf-8' }).trim()

    const m = /live=\[(\d*)\] private=\[(\d*)\] idle=\[(\d*)\] probe=\[(\d+)\]/.exec(out)
    expect(m, `unexpected guard output: ${out}`).not.toBeNull()
    expect(m![1], `the live stage must report its PID despite the doubled slash: ${out}`).toBe(m![4])
    expect(m![2], `the /private twin of the same stage must match too: ${out}`).toBe(m![4])
    expect(m![3], `an unused stage must report nothing: ${out}`).toBe('')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('the reap loop consults the guard and skips a stage in use', () => {
    const reap = script.indexOf('for old_stage in "$STAGE_ROOT"/open-walnut-stage.*')
    expect(reap).toBeGreaterThan(-1)
    const body = script.slice(reap, script.indexOf('done', reap))
    expect(body).toMatch(/stage_has_live_process/)
    expect(body).toMatch(/continue/)
    // The rm must be reachable only after the guard said no.
    expect(body.indexOf('stage_has_live_process')).toBeLessThan(body.indexOf('rm -rf'))
  })
})

describe('readiness proves the web app is servable', () => {
  it('checks GET / for the SPA entry script after the /api/config poll', () => {
    const configPoll = script.indexOf('Server failed its bounded readiness check')
    const indexCheck = script.indexOf('cannot serve the web app')
    expect(indexCheck).toBeGreaterThan(configPoll)
    const check = script.slice(configPoll, indexCheck + 400)
    expect(check).toMatch(/curl[^\n]*http:\/\/localhost:\$PORT\//)
    expect(check).toMatch(/assets\/index-/)
    // A static-root break must roll back, not be reported and accepted.
    expect(check).toMatch(/rollback_to_lkg/)
    expect(check).toMatch(/exit 1/)
  })

  it('runs before the success stamp, so a broken deploy cannot look successful', () => {
    expect(script.indexOf('cannot serve the web app')).toBeLessThan(script.indexOf('SUCCESS_STAMP"\n'))
  })

  it('is valid bash', () => {
    execFileSync('bash', ['-n', SCRIPT])
  })
})
