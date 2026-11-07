/**
 * Machine-wide admission control for Playwright browser runs.
 *
 * 2026-07-25 incident: the Mac wedged (load avg 225 on 14 cores, 1210 processes)
 * while several agent sessions each ran `npx playwright test`. Two independent
 * causes of unbounded fan-out — neither was a process leak:
 *
 *   1. `workers: undefined` locally → Playwright defaults to HALF THE CORES
 *      (7 here), and each worker holds its own Chromium. Measured on this box:
 *      7 workers = 28 chromium processes, 2.7 GB RSS (~385 MB per browser).
 *   2. Nothing coordinated between *runs*. CLAUDE.md tells every agent to verify
 *      with Playwright, so K concurrent sessions meant K × 28 browsers.
 *
 * Concurrent runs were never actually safe: most specs hardcode `localhost:3457`,
 * and `reuseExistingServer` makes a second run piggyback on the first run's
 * fixture server — one shared dataset, and whichever run finishes first tears the
 * server out from under the other. So the gate is an EXCLUSIVE lease on the
 * fixture port, with queueing, plus a worker cap inside each run.
 *
 * WHY THIS IS SYNCHRONOUS: Playwright starts the `webServer` plugin BEFORE
 * globalSetup (see webServerPlugin `_startProcess`), so a globalSetup gate is too
 * late — run #2's server would already be up (or already attached to run #1's)
 * before it ever queued. The only hook that runs earlier is loading the config
 * module itself, and a .ts config is transformed to CJS (no top-level await).
 * Hence a blocking wait via Atomics.wait, which parks the thread without spinning.
 *
 * The lease self-heals: a holder whose PID is gone (or whose lease outlived
 * LEASE_TTL_MS) is reclaimed, so a SIGKILLed run never wedges the gate. And it
 * fails open on timeout — a stuck gate must never be why tests can't run.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertMacBrakes, realCi } from '../../setup/mac-brakes.js'
import {
  type Capacity,
  capacityVerdict,
  cpuIdlePctSync,
  loadPerCore,
  MAX_LOAD_PER_CORE,
  MIN_IDLE_PCT,
  pctFromEnv,
} from '../../setup/cpu-idle.js'

/** Lease dir, shared by every Playwright run for this user. */
export const LEASE_DIR = process.env.PW_LEASE_DIR ?? path.join(os.tmpdir(), 'walnut-pw-lease')

/** A run that dies without releasing loses its lease after this long. */
export const LEASE_TTL_MS = 45 * 60_000

/**
 * Per-run worker cap. Each worker = one Chromium (~385 MB measured), so this is
 * really a memory budget. Leave headroom for the OS, prod on :3456, and the
 * fixture's own node/vite/daemon processes (~600 MB together).
 */
export function perRunWorkers(): number {
  // A Mac run with a brake off (PW_IGNORE_LOAD, PW_NO_GATE, PW_TEST_PORT, CI, more than one
  // worker) stops here, before the gate; and a Mac runs one browser at a time.
  assertMacBrakes()
  const explicit = Number(process.env.PW_WORKERS)
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)
  if (process.env.CI) return 4
  if (process.platform === 'darwin' && !realCi(process.env)) return 1
  const byCores = Math.max(1, Math.floor(os.cpus().length / 2) - 1)
  const byMemory = Math.max(1, Math.floor(os.totalmem() / (1024 ** 3) / 6))
  return Math.min(byCores, byMemory, 4)
}

type Lease = { pid: number; port: number; at: number; cwd: string }

function leaseFile(port: number): string {
  return path.join(LEASE_DIR, `port-${port}.lease`)
}

function readLease(file: string): Lease | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Lease>
    if (typeof raw?.pid !== 'number' || typeof raw?.at !== 'number') return null
    return { pid: raw.pid, port: Number(raw.port), at: raw.at, cwd: String(raw.cwd ?? '') }
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but owned by another uid; only ESRCH proves it's gone.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** Reclaim the lease if its holder died or it outlived the TTL. */
function reapStaleLease(port: number, now = Date.now()): void {
  const file = leaseFile(port)
  if (!fs.existsSync(file)) return
  const lease = readLease(file)
  const stale = !lease || now - lease.at > LEASE_TTL_MS || !pidAlive(lease.pid)
  if (!stale) return
  try {
    fs.unlinkSync(file)
  } catch {
    /* another run reclaimed it first */
  }
}

/** Non-blocking claim. `O_EXCL` create is the mutex — no lock ordering to get wrong. */
export function tryAcquire(port: number): string | null {
  fs.mkdirSync(LEASE_DIR, { recursive: true })
  reapStaleLease(port)
  const payload: Lease = { pid: process.pid, port, at: Date.now(), cwd: process.cwd() }
  try {
    fs.writeFileSync(leaseFile(port), JSON.stringify(payload), { flag: 'wx' })
    return leaseFile(port)
  } catch {
    return null
  }
}

export function describeHolder(port: number): string {
  const lease = readLease(leaseFile(port))
  if (!lease) return 'unknown run'
  return `pid ${lease.pid} (${Math.round((Date.now() - lease.at) / 60_000)}m, ${lease.cwd || 'unknown cwd'})`
}

export function release(file: string | null | undefined): void {
  if (!file) return
  try {
    // Only drop it if we still own it — a TTL reclaim may have reassigned it.
    if (readLease(file)?.pid === process.pid) fs.unlinkSync(file)
  } catch {
    /* already gone */
  }
}

/**
 * Keep our lease from aging out while we legitimately still hold it.
 *
 * The TTL exists for holders that died without releasing, but a real run can
 * outlive it — the full browser suite is 245 tests. Without a heartbeat, a long
 * run's lease would be judged stale and a second run would seize the port and
 * start racing it, which is the exact failure the lease prevents.
 *
 * Unref'd so it never keeps the process alive on its own.
 */
export function startLeaseHeartbeat(file: string | null): NodeJS.Timeout | null {
  if (!file) return null
  const timer = setInterval(
    () => {
      try {
        const lease = readLease(file)
        if (lease?.pid !== process.pid) return // reclaimed by someone else; stop touching it
        fs.writeFileSync(file, JSON.stringify({ ...lease, at: Date.now() } satisfies Lease))
      } catch {
        /* best-effort */
      }
    },
    Math.floor(LEASE_TTL_MS / 5),
  )
  timer.unref()
  return timer
}

/** Park the thread without burning CPU (no sync sleep in Node otherwise). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Free CPU is what a run needs, so the wait is on idle CPU (MIN_IDLE_PCT, 20%, with
 * WALNUT_MIN_IDLE_PCT to change it), sampled over two seconds. The load stays only as a
 * backstop: above 4 per core adding 4 browsers is what turns "slow" into "wedged", and
 * the fixture's own boot (measured 20s idle, 70s at load 133) blows the webServer budget.
 * The load alone misleads on the Mac: it sat at 27 to 53 on 14 cores with 30 to 48% of
 * the CPU idle (2026-11-07), endpoint agents keeping threads runnable at little CPU.
 */
function measureCapacity(): Capacity {
  return { idlePct: cpuIdlePctSync(2_000), loadPerCore: loadPerCore(), cores: Math.max(1, os.cpus().length) }
}

/**
 * Wait out a machine that is ALREADY overloaded by something else (a concurrent
 * vitest suite, an Xcode build, iOS simulators). Observed at load 486 on 14 cores:
 * every spec failed on `page.waitForLoadState` timeouts and the run's own browsers
 * made it worse. Queuing is strictly better than adding fuel and failing anyway.
 *
 * Still overloaded after timeoutMs, it throws and the run does not start: it used
 * to run anyway, and WebKit started at load 295 (2026-11-07), where every spec
 * fails on timeouts that are not product bugs. Run it again once the machine is
 * calmer; PW_IGNORE_LOAD=1 skips the wait (CI and clouddev's containers set it).
 */
export function waitForCapacitySync(timeoutMs = 10 * 60_000, measure: () => Capacity = measureCapacity): void {
  if (process.env.PW_IGNORE_LOAD === '1' || process.env.CI) return
  const bars = {
    minIdlePct: pctFromEnv(process.env.WALNUT_MIN_IDLE_PCT, MIN_IDLE_PCT),
    maxLoadPerCore: MAX_LOAD_PER_CORE,
  }
  let v = capacityVerdict(measure(), bars)
  if (v.ok) return

  const deadline = Date.now() + timeoutMs
  console.log(
    `[pw-concurrency] machine is overloaded (${v.why}): waiting for it to settle before starting browsers. ` +
      `Check with: scripts/pw-cleanup.sh status`,
  )
  while (Date.now() < deadline) {
    sleepSync(Math.min(5_000, Math.max(100, deadline - Date.now())))
    v = capacityVerdict(measure(), bars)
    if (v.ok) {
      console.log(`[pw-concurrency] settled (${v.why}): starting`)
      return
    }
  }
  throw new Error(
    `[pw-concurrency] still overloaded (${v.why}) after ` +
      `${Math.round(timeoutMs / 60_000)}m: this run did not start (its browsers would fail on timeouts ` +
      `that are not product bugs). Run it again once the machine is calmer (scripts/pw-cleanup.sh status).`,
  )
}

/** How long a run waits for a live holder of the port: PW_LEASE_WAIT_MIN, else 2 hours. */
export function leaseWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const min = Number(env.PW_LEASE_WAIT_MIN)
  return (Number.isFinite(min) && min > 0 ? min : 120) * 60_000
}

/**
 * Block until the fixture port is ours. Synchronous on purpose (see file header).
 *
 * Never runs beside a live holder: a holder that died or stopped its heartbeat is
 * reclaimed by tryAcquire, and a live one is waited for until timeoutMs, then this
 * throws and the run does not start. It used to proceed after 20 minutes, and a
 * WebKit run then started beside a live run's fixture server at load 294
 * (2026-11-07); two runs on one port stop each other's server.
 */
export function acquireSync(port: number, timeoutMs = leaseWaitMs()): string {
  const deadline = Date.now() + timeoutMs
  let announced = false
  for (;;) {
    const held = tryAcquire(port)
    if (held) return held
    if (Date.now() > deadline) {
      throw new Error(
        `[pw-concurrency] waited ${Math.round(timeoutMs / 60_000)}m for :${port}, and ` +
          `${describeHolder(port)} still holds it, alive: this run did not start (two runs on one ` +
          `fixture port stop each other's server). Run it again once that run ends ` +
          `(scripts/pw-cleanup.sh status shows it); PW_LEASE_WAIT_MIN sets the wait.`,
      )
    }
    if (!announced) {
      announced = true
      console.log(
        `[pw-concurrency] another Playwright run holds :${port} — ${describeHolder(port)}. Queuing ` +
          `(specs hardcode this port, so runs cannot safely overlap).`,
      )
    }
    sleepSync(1_000 + Math.floor(Math.random() * 1_000))
  }
}

/**
 * Cheap "is anything listening" probe. On a loaded machine with EDR hooks, `lsof`
 * walks every fd of every process and measured 12–37s here — far too slow to sit
 * in front of every run. A connect() attempt answers in ~200ms, so it gates the
 * expensive pid lookup below.
 */
function portBusy(port: number): boolean {
  try {
    execFileSync('nc', ['-z', '-G', '1', '127.0.0.1', String(port)], { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

function listeners(port: number): number[] {
  if (!portBusy(port)) return []
  try {
    return execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Bounded: a starved lsof must not stall the run indefinitely. Losing the
      // orphan sweep is survivable (webServer just reuses the stale server, the
      // old behavior); hanging the whole suite is not.
      timeout: 60_000,
    })
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 1)
  } catch {
    return [] // lsof exits 1 when nothing listens, or timed out
  }
}

function ppidOf(pid: number): number {
  try {
    return Number(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
    )
  } catch {
    return 0
  }
}

function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/**
 * The process to stop for an orphaned listener, or null when it is not one. A
 * fixture server runs as a child of itself (fixture-home.ts restarts the same
 * command with its own HOME), so the orphan is that parent when the parent is
 * the same command and launchd adopted it; SIGTERM to it reaches the child.
 */
export function orphanRoot(pid: number, ppid = ppidOf, command = commandOf): number | null {
  const parent = ppid(pid)
  if (parent === 1) return pid
  if (parent > 1 && ppid(parent) === 1 && command(parent) !== '' && command(parent) === command(pid)) return parent
  return null
}

/**
 * The pids browser fixture servers recorded as their own, `<tmp>/walnut-*\/owner.pid`
 * (tests/setup/stale-tmp.ts writeOwnerPid). The fixture port is shared with the
 * onboarding sandbox and anyone's hand-started server, so a listener counts as a
 * fixture's only when one recorded its pid.
 */
export function recordedFixturePids(tmp = os.tmpdir()): Set<number> {
  const out = new Set<number>()
  let names: string[] = []
  try {
    names = fs.readdirSync(tmp).filter((n) => n.startsWith('walnut-'))
  } catch {
    return out
  }
  for (const name of names) {
    try {
      const pid = Number(fs.readFileSync(path.join(tmp, name, 'owner.pid'), 'utf8').trim())
      if (Number.isInteger(pid) && pid > 1) out.add(pid)
    } catch {
      /* not a fixture home */
    }
  }
  return out
}

/**
 * Reap a fixture server orphaned by a SIGKILLed run.
 *
 * Must run BEFORE the webServer plugin, or `reuseExistingServer` silently
 * attaches this run to the stale server (stale SPA build, stale fixture data)
 * — and killing it afterwards would tear down the server this run is using.
 *
 * Only reparented-to-launchd listeners are reaped (ppid == 1). That's the precise
 * signature of an orphan and it deliberately spares a fixture server a developer
 * started by hand in another terminal, which `reuseExistingServer` is there to
 * support: that one still has its shell as parent. And only a listener a browser
 * fixture recorded as its own (recordedFixturePids): an orphan the onboarding
 * sandbox left on the same port is not this run's to stop.
 */
export function reapOrphanFixtureServer(port: number): void {
  const found = listeners(port)
  if (found.length === 0) return
  const recorded = recordedFixturePids()
  const own = found.filter((pid) => {
    if (recorded.has(pid)) return true
    console.log(`[pw-concurrency] left pid ${pid} on :${port} alone: no browser fixture recorded it (walnut-*/owner.pid)`)
    return false
  })
  const roots = own.map((pid) => orphanRoot(pid)).filter((p): p is number => p !== null)
  if (roots.length === 0) return
  for (const pid of roots) {
    console.log(`[pw-concurrency] reaping orphaned fixture server on :${port} (pid ${pid}) left by a killed run`)
    try {
      // SIGTERM only: test-server.ts's handler reaps its isolated daemon and
      // wipes its tmpdir. SIGKILL leaks both (see leaked-test-daemons incident).
      process.kill(pid, 'SIGTERM')
    } catch {
      /* raced with its own exit */
    }
  }
  // Wait for the port to actually free up, using the cheap probe only — the
  // expensive pid lookup already happened above.
  const until = Date.now() + 10_000
  while (Date.now() < until && portBusy(port)) sleepSync(250)
}
