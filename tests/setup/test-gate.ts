/**
 * Machine-wide admission control for vitest runs — the vitest counterpart of
 * tests/e2e/browser/pw-gate.ts.
 *
 * Per-run caps (maxWorkers + per-worker heap) bound ONE run at ~8GB, but K
 * concurrent agent sessions each running `npm test` stack K × 8GB — observed
 * 2026-07-25: three simultaneous runs = 13 live fork workers while the machine
 * was already swapping. Nothing coordinated between runs; this gate does.
 *
 * Design (deliberately approximate, always fails open):
 *   - A "run group" = one logical test invocation. scripts/test-parallel.mjs
 *     launches 6 tiers in parallel as ONE group (they share WALNUT_TEST_RUN_ID);
 *     a bare `npx vitest run` is its own group (keyed by runner pid).
 *   - Each group registers a dir under $TMPDIR/walnut-vitest-gate/ with one
 *     pid file per runner process. A group is "live" if any of its pids is.
 *   - At most MAX_GROUPS live groups may run; later groups poll-wait, log a
 *     clear "queuing" line, and proceed anyway after WAIT_TIMEOUT (a stuck
 *     gate must never be why tests can't run).
 *   - Self-heals: groups whose pids are all dead (SIGKILLed runner) or whose
 *     registration outlived GROUP_TTL are swept before counting.
 *
 * Escape hatches: WALNUT_VITEST_GATE=0 disables; WALNUT_VITEST_SLOTS=N resizes.
 * CI is exempt (runners are already isolated machines).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const GATE_DIR = process.env.WALNUT_VITEST_GATE_DIR ?? path.join(os.tmpdir(), 'walnut-vitest-gate')
/**
 * How many logical test runs may be in flight machine-wide.
 *
 * 1 (default): one run at a time. A run is already capped at maxWorkers(4) ×
 * 2GB heap ≈ 8GB, so this keeps the whole test workload under ~10GB including
 * the runner processes. 2 slots would allow ~16GB, which on this 48GB box —
 * shared with the prod server, browsers, simulators and ~3GB of mandated
 * security agents — was enough to reach swap during the 2026-07-25 incident.
 * Serializing costs wall-clock, not throughput: a queued run starts the moment
 * the other finishes, and each run still uses all 4 workers.
 */
const MAX_GROUPS = (() => {
  const n = Number(process.env.WALNUT_VITEST_SLOTS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
})()
const GROUP_TTL_MS = 45 * 60_000
const WAIT_TIMEOUT_MS = 15 * 60_000
const POLL_MS = 3_000

/**
 * Load-aware admission (added after the 2026-08-09 incidents): a slot being
 * free does not mean the MACHINE is free. Four times that day the box sat at
 * load 60-95 (14 cores) from security agents + recovery storms; admitting a
 * test run at that point was the last straw that starved Finder, upon which
 * loginwindow tore down the user's whole GUI session ("all my apps closed").
 * So: with the slot in hand, still wait while 1-min loadavg exceeds the cap.
 * Fail-open stays (a busy-forever box must not block tests permanently), but
 * the wait gives recovery storms time to drain instead of piling on.
 */
const MAX_LOAD = (() => {
  const n = Number(process.env.WALNUT_VITEST_MAX_LOAD)
  return Number.isFinite(n) && n > 0 ? n : 20
})()
const LOAD_WAIT_TIMEOUT_MS = 10 * 60_000

/** One logical invocation. test-parallel exports this so all 6 tiers share a slot. */
function runId(): string {
  return process.env.WALNUT_TEST_RUN_ID ?? `pid-${process.pid}`
}

function groupDir(id: string): string {
  return path.join(GATE_DIR, `run-${id}`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** A group is live if any registered runner pid is alive and it's within TTL. */
function groupLive(dir: string, now: number): boolean {
  let stat: fs.Stats
  try { stat = fs.statSync(dir) } catch { return false }
  if (now - stat.mtimeMs > GROUP_TTL_MS) return false
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return false }
  return entries.some((f) => {
    const pid = Number(f.replace(/\.pid$/, ''))
    return Number.isFinite(pid) && pid > 0 && pidAlive(pid)
  })
}

function sweepAndCount(now: number): { live: string[]; mine: boolean } {
  let dirs: string[] = []
  try { dirs = fs.readdirSync(GATE_DIR).filter((d) => d.startsWith('run-')) } catch { return { live: [], mine: false } }
  const live: string[] = []
  const myDir = `run-${runId()}`
  let mine = false
  for (const d of dirs) {
    const full = path.join(GATE_DIR, d)
    if (groupLive(full, now)) {
      live.push(d)
      if (d === myDir) mine = true
    } else {
      // dead group — sweep it so it never counts against the budget again
      try { fs.rmSync(full, { recursive: true, force: true }) } catch {}
    }
  }
  return { live, mine }
}

function register(): void {
  const dir = groupDir(runId())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${process.pid}.pid`), String(Date.now()))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 1-minute load average, or 0 if unreadable (fail open). */
function loadAvg1m(): number {
  try {
    return os.loadavg()[0] ?? 0
  } catch {
    return 0
  }
}

/** Wait for the machine itself to calm down before starting a run. */
async function waitForSaneLoad(): Promise<void> {
  const deadline = Date.now() + LOAD_WAIT_TIMEOUT_MS
  let announced = false
  for (;;) {
    const load = loadAvg1m()
    if (load <= MAX_LOAD) {
      if (announced) console.log(`[vitest-gate] load ${load.toFixed(1)} ≤ ${MAX_LOAD} — starting`)
      return
    }
    if (Date.now() >= deadline) {
      console.warn(`[vitest-gate] load still ${load.toFixed(1)} after ${LOAD_WAIT_TIMEOUT_MS / 60_000}min — proceeding anyway (fail open)`)
      return
    }
    if (!announced) {
      announced = true
      console.log(
        `[vitest-gate] machine load ${load.toFixed(1)} > ${MAX_LOAD} — waiting for it to drain before starting tests ` +
        `(starving the GUI tears down the user's session; see 2026-08-09 incidents). WALNUT_VITEST_MAX_LOAD overrides.`,
      )
    }
    await sleep(POLL_MS)
  }
}

/** Await a slot (or timeout → fail open). Call from vitest globalSetup. */
export async function acquireTestSlot(): Promise<void> {
  if (process.env.WALNUT_VITEST_GATE === '0' || process.env.CI) return
  try {
    fs.mkdirSync(GATE_DIR, { recursive: true })
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    let announced = false
    for (;;) {
      const now = Date.now()
      const { live, mine } = sweepAndCount(now)
      // Our group already holds a slot (sibling tier of the same run) → join it.
      if (mine || live.length < MAX_GROUPS) {
        // Slot free ≠ machine free: also wait out machine-wide load spikes
        // BEFORE registering, so queued runs behind us keep seeing the true
        // group count while we hold nothing.
        await waitForSaneLoad()
        register()
        if (announced) console.log('[vitest-gate] slot acquired — starting')
        return
      }
      if (now >= deadline) {
        console.warn(`[vitest-gate] wait timed out after ${WAIT_TIMEOUT_MS / 60_000}min — proceeding anyway (fail open)`)
        await waitForSaneLoad()
        register()
        return
      }
      if (!announced) {
        announced = true
        console.log(
          `[vitest-gate] ${live.length} test run(s) already active on this machine (${live.join(', ')}) — queuing to avoid memory stacking. WALNUT_VITEST_GATE=0 skips.`,
        )
      }
      await sleep(POLL_MS)
    }
  } catch (err) {
    // Never block tests on gate bugs.
    console.warn('[vitest-gate] gate error — proceeding:', (err as Error).message)
  }
}

/** Release our pid from the group; last one out removes the group dir. */
export function releaseTestSlot(): void {
  if (process.env.WALNUT_VITEST_GATE === '0' || process.env.CI) return
  try {
    const dir = groupDir(runId())
    try { fs.unlinkSync(path.join(dir, `${process.pid}.pid`)) } catch {}
    let rest: string[] = []
    try { rest = fs.readdirSync(dir) } catch { return }
    if (rest.length === 0) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  } catch {}
}
