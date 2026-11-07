/**
 * Every machine gate waits for free CPU, never for the load average alone.
 *
 * 2026-11-07: the Mac's 1-minute load sat at 27 to 53 on 14 cores for a whole day with 30 to
 * 48% of its CPU idle (endpoint agents keep threads runnable at little CPU). Three gates judged
 * the load alone and so never opened: lane B's simulator queue (1.2 per CPU, fixed in its own
 * repo), the iOS fleet (0.75 per CPU: a unit run waited 110 minutes) and vitest's admission
 * (load 20); Playwright's overload wait and the large run had the same rule at a higher bar.
 * They now judge idle CPU and keep the load only as a backstop (tests/setup/cpu-idle.ts).
 *
 * This lists every file that reads the load average and what it does with it. A new reader
 * fails here until it is listed: as a gate that also reads idle CPU, or as a report with why.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(__dirname, '../..')
const READS_LOAD = /os\.loadavg\(|\bloadavg\(\)|vm\.loadavg|\/proc\/loadavg/

/** Gates: each must read idle CPU too (the pattern names how). */
const GATES: Record<string, RegExp> = {
  'tests/setup/cpu-idle.ts': /cpuTicks\(\)/,
  'tests/setup/large-run.sh': /idle_pct\)/,
  'ios-native/tests/fleet/remote-run.sh': /fleet_cpu_busy "\$\(fleet_idle_pct/,
}

/** Readers that never hold a run on the load, with what they do. */
const REPORTS: Record<string, string> = {
  'scripts/bridge-monitor/collector.mjs': 'records the load in its samples',
  'scripts/desktop-health-monitor.sh': 'logs the load',
  'scripts/ios-perf/kb-loop-probe.sh': 'prints a warning that a timeout may be starvation, never waits',
  'scripts/pw-cleanup.sh': 'prints the load in its status',
  'src/core/sessions/auto-recover-env.ts': 'restart recovery goes one at a time above 3 per CPU and never stops (after 5 minutes it proceeds)',
  'src/core/stall-recorder-hold.ts': 'writes the load into a stall record',
  'src/providers/host-facts-core.ts': 'host_load reports the load beside cpuBusy, which gates read',
  'src/providers/host-vitals-core.ts': 'reports the host vitals',
  'src/web/server.ts': 'logs a warning at boot',
  'tests/core/memory-signals.test.ts': 'fixture text of sysctl output',
  'tests/e2e/browser/board-kanban-layout.spec.ts': 'writes the load into a timing annotation',
  'tests/e2e/browser/cpu-reference.ts': 'decides whether a timing is judged, never holds a run',
  'tests/e2e/browser/mail-grouping-live.spec.ts': 'writes the load into a timing annotation',
  'tests/e2e/session-snapshot-stress.test.ts': 'skips its own suite on a loaded machine, never holds another run',
  'tests/integration/journal-v2-twins.test.ts': 'decides whether a timing budget is judged',
}

/** Gates that read the load through a helper: each must judge idle CPU with it. */
const HELPER_GATES: Record<string, RegExp> = {
  'tests/e2e/browser/pw-concurrency.ts': /capacityVerdict\(measure\(\)/,
  'tests/setup/test-gate.ts': /idlePct = await cpuIdlePct\(/,
  'scripts/ios-fleet-test.sh': /idle < min_idle/,
}

function trackedFiles(): string[] {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'scripts', 'src', 'tests', 'ios-native', 'packages', 'desktop'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.split('\n').filter((f) => /\.(ts|tsx|mjs|cjs|js|sh|py)$/.test(f) && fs.existsSync(path.join(ROOT, f)))
}

describe('machine gates judge free CPU', () => {
  it('every file that reads the load average is a gate that reads idle CPU too, or a listed report', () => {
    const readers = trackedFiles().filter((f) => READS_LOAD.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    const unlisted = readers.filter((f) => !(f in GATES) && !(f in REPORTS))
    expect(unlisted, 'a new file reads the load average: gate on idle CPU (tests/setup/cpu-idle.ts) or list it in REPORTS with what it does').toEqual([])
    for (const [f, idle] of Object.entries(GATES)) {
      expect(readers, `${f} no longer reads the load: move it out of GATES`).toContain(f)
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), `${f} gates on the load without idle CPU`).toMatch(idle)
    }
    const gone = Object.keys(REPORTS).filter((f) => !readers.includes(f))
    expect(gone, 'listed readers that no longer read the load: remove them from REPORTS').toEqual([])
  })

  it('the gates that read the load through a helper judge idle CPU with it', () => {
    for (const [f, idle] of Object.entries(HELPER_GATES)) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), `${f} must judge idle CPU`).toMatch(idle)
    }
  })
})
