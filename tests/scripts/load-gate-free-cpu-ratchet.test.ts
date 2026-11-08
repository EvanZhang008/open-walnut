/**
 * Every machine gate waits for free CPU, never for the load average alone.
 *
 * 2026-11-07: the Mac's 1-minute load sat at 27 to 53 on 14 cores for a whole day with 30 to
 * 48% of its CPU idle (endpoint agents keep threads runnable at little CPU). Three gates judged
 * the load alone and so never opened: lane B's simulator queue (1.2 per CPU, fixed in its own
 * repo), the iOS fleet (0.75 per CPU: a unit run waited 110 minutes) and vitest's admission
 * (load 20); Playwright's overload wait and the large run had the same rule at a higher bar.
 * They now judge idle CPU too. 2026-11-08, the Operations VP: free CPU is only an extra condition,
 * never a replacement for the load line (at a backstop of 4 per core a lease booted at load 48 and
 * the load went to 377), so every gate also keeps the line of 2 per core (28 on 14 cores) and
 * waits while memory is tight, the rule of lane B's machine-gate.sh (tests/setup/cpu-idle.ts).
 *
 * The load line is the load of our own work (2026-11-08: a call app and security agents held the
 * Mac's load at 40 to 80 for hours with a third of the CPU idle, and lane B and the fleet stayed
 * shut): every gate judges the share our processes hold (scripts/lib/own-load.sh, ownLoadPerCore).
 *
 * This lists every file that reads the load average and what it does with it. A new reader
 * fails here until it is listed: as a gate that also reads idle CPU, or as a report with why.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(__dirname, '../..')
// The load average itself, a host's 1-minute load as host_load reports it, or the
// restart recovery's load reading.
const READS_LOAD = /os\.loadavg\(|\bloadavg\(\)|vm\.loadavg|\/proc\/loadavg|\.load\[0\]|loadPerCpu\(/

/** Gates: each must read idle CPU too (the pattern names how). */
const GATES: Record<string, RegExp> = {
  'tests/setup/cpu-idle.ts': /cpuTicks\(\)/,
  'tests/setup/large-run.sh': /idle_pct\)/,
  'ios-native/tests/fleet/remote-run.sh': /fleet_cpu_busy "\$\(fleet_idle_pct/,
}

/** Each gate's load line of 2 per core and its memory check (the pattern names how). */
const LOAD_LINE_AND_MEMORY: Record<string, RegExp[]> = {
  'tests/setup/cpu-idle.ts': [/MAX_LOAD_PER_CORE = 2\n/, /const mem = c\.memory \? memoryTightWhy\(c\.memory\)/],
  'tests/setup/large-run.sh': [/\$\(cores\) \* 2 \)\)/, /elif \[\[ -n "\$\(mem_tight\)" \]\]/],
  'ios-native/tests/fleet/remote-run.sh': [/MAX_LOAD=2;/, /"\$MAX_LOAD" "\$\(fleet_mem\)"\)/],
  'scripts/ios-fleet-test.sh': [/MAX_LOAD=2;/],
  'tests/e2e/browser/pw-concurrency.ts': [/maxLoadPerCore: MAX_LOAD_PER_CORE,/, /memory: readMemorySync\(\)/],
  'tests/setup/test-gate.ts': [/: MAX_LOAD_PER_CORE,/, /memory = readMemorySync\(\)/],
}

/** Each gate judges our own share of the load (the pattern names how; cpu-idle.ts defines it). */
const OWN_SHARE: Record<string, RegExp> = {
  'tests/setup/cpu-idle.ts': /export function ownLoadPerCore\(/,
  'tests/setup/large-run.sh': /own_load "\$l" 1 "\$max_load"; l=\$OWN_LOAD/,
  'ios-native/tests/fleet/remote-run.sh': /own_load "\$LOAD1" "\$CPUS" "\$MAX_LOAD"; LOAD1=\$OWN_LOAD/,
  'scripts/ios-fleet-test.sh': /tried after the others, its own check counts our share of its load/,
  'tests/e2e/browser/pw-concurrency.ts': /const load = ownLoadPerCore\(\)/,
  'tests/setup/test-gate.ts': /load = ownLoadPerCore\(undefined, MAX_LOAD > 0/,
}

/**
 * Walnut's own start gates (2026-11-08: no session started on the Mac for an hour at a load near
 * 98, mostly a music app and a security agent): each judges the load by our own share of it
 * (hosts/own-load.ts), and where it refuses a start, also by CPU busy and memory (the patterns).
 */
const START_GATES: Record<string, RegExp[]> = {
  'src/core/hosts/own-load.ts': [/t\.ours \+ t\.others/],
  'src/core/hosts/placement.ts': [/const own = ownLoadPerCpu\(load, caps\.loadPerCpu\)/, /if \(judged >= caps\.loadPerCpu \* 2\)/, /load\.cpuBusy >= caps\.cpuBusy/, /memShare <= caps\.memAvailShare\) view\.fullReasons/, /return ownLoadPerCpu\(\{ load: \[os\.loadavg\(\)\[0\]\]/],
  'src/core/sessions/auto-recover-env.ts': [/placement\.localLoadPerCpu\(line\)/],
  'src/core/session-auto-recover.ts': [/this\.deps\.loadPerCpu\(this\.cfg\.maxLoadPerCpu\)/],
}

/** Readers that never hold a run on the load, with what they do. */
const REPORTS: Record<string, string> = {
  'scripts/bridge-monitor/collector.mjs': 'records the load in its samples',
  'scripts/desktop-health-monitor.sh': 'logs the load',
  'scripts/ios-perf/kb-loop-probe.sh': 'prints a warning that a timeout may be starvation, never waits',
  'scripts/pw-cleanup.sh': 'prints the load in its status',
  'src/core/stall-recorder-hold.ts': 'writes the load into a stall record',
  'src/providers/host-facts-core.ts': 'host_load reports the load beside cpuBusy and our own share of the runnable threads, which gates read',
  'src/providers/host-vitals-core.ts': 'reports the host vitals',
  'src/web/server.ts': 'logs a warning at boot',
  'tests/core/hosts/placement.test.ts': 'compares localLoadPerCpu with the load it scales',
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
    const unlisted = readers.filter((f) => !(f in GATES) && !(f in REPORTS) && !(f in START_GATES))
    expect(unlisted, 'a new file reads the load average: gate on idle CPU (tests/setup/cpu-idle.ts) or list it in REPORTS with what it does').toEqual([])
    for (const [f, idle] of Object.entries(GATES)) {
      expect(readers, `${f} no longer reads the load: move it out of GATES`).toContain(f)
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), `${f} gates on the load without idle CPU`).toMatch(idle)
    }
    const gone = Object.keys(REPORTS).filter((f) => !readers.includes(f))
    expect(gone, 'listed readers that no longer read the load: remove them from REPORTS').toEqual([])
  })

  it('every gate keeps the load line of 2 per core and waits on tight memory: free CPU never replaces them', () => {
    for (const f of [...Object.keys(GATES), ...Object.keys(HELPER_GATES)]) expect(LOAD_LINE_AND_MEMORY, `${f} has no load line listed`).toHaveProperty([f])
    for (const [f, pats] of Object.entries(LOAD_LINE_AND_MEMORY)) {
      for (const p of pats) expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), `${f} lost its load line or memory check`).toMatch(p)
    }
  })

  it('every gate judges the load line by our own share of the load', () => {
    for (const f of [...Object.keys(GATES), ...Object.keys(HELPER_GATES)]) expect(OWN_SHARE, `${f} does not judge our share of the load`).toHaveProperty([f])
    for (const [f, p] of Object.entries(OWN_SHARE)) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), `${f} judges the whole load again`).toMatch(p)
    }
  })

  it("Walnut's start gates judge our own share of the load, with CPU busy and memory where they refuse", () => {
    const readers = trackedFiles().filter((f) => READS_LOAD.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    for (const [f, pats] of Object.entries(START_GATES)) {
      expect(readers, `${f} no longer reads the load: move it out of START_GATES`).toContain(f)
      for (const p of pats) expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), `${f} judges the whole load again`).toMatch(p)
    }
    // host_load's share and the gates' twins use one pattern for what is ours.
    const twin = (f: string, re: RegExp) => re.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'))?.[1]
    const ts = twin('tests/setup/cpu-idle.ts', /export const OWN_LOAD_RE =\s*\/(.*)\/\n/)
    expect(ts).toBeTruthy()
    expect(twin('src/providers/host-facts-core.ts', /var OWN_RE = \/(.*)\/\n/)).toBe(ts)
  })

  it("every reader of host_load's load per CPU also reads our own share of it", () => {
    // A gate or a picker reading host_load's view (loadPerCpu), in the server, a script or the
    // web app, would judge the whole load again (2026-11-08 review: the fleet's pick and the Move
    // to host menu read only loadPerCpu).
    const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'scripts', 'src', 'web/src', 'packages'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const files = r.stdout.split('\n').filter((f) => /\.(ts|tsx|mjs|cjs|js|sh|py)$/.test(f) && fs.existsSync(path.join(ROOT, f)))
    const blind = files.filter((f) => {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      return /loadPerCpu\b/.test(text.replace(/ownLoadPerCpu|localLoadPerCpu|maxLoadPerCpu|caps\.loadPerCpu|loadPerCpu: num\(/g, '')) && !(f in START_GATES) && !/ownLoadPerCpu|ownThreads/.test(text)
    })
    expect(blind, "these read host_load's loadPerCpu without our own share (ownLoadPerCpu or ownThreads)").toEqual([])
  })

  it('the gates that read the load through a helper judge idle CPU with it', () => {
    for (const [f, idle] of Object.entries(HELPER_GATES)) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), `${f} must judge idle CPU`).toMatch(idle)
    }
  })
})
