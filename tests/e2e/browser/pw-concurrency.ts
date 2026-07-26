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
  const explicit = Number(process.env.PW_WORKERS)
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit)
  if (process.env.CI) return 4
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
 * Above this load-per-core, adding 4 browsers is what turns "slow" into "wedged".
 * 4× overcommit is already deep into thrashing on this box; the fixture's own boot
 * (measured 20s idle → 70s at load 133) blows the webServer budget well before it.
 */
const LOAD_PER_CORE_CEILING = 4

function loadPerCore(): number {
  return os.loadavg()[0] / Math.max(1, os.cpus().length)
}

/**
 * Wait out a machine that is ALREADY overloaded by something else (a concurrent
 * vitest suite, an Xcode build, iOS simulators). Observed at load 486 on 14 cores:
 * every spec failed on `page.waitForLoadState` timeouts and the run's own browsers
 * made it worse. Queuing is strictly better than adding fuel and failing anyway.
 *
 * Advisory: gives up after timeoutMs and lets the run proceed, because a
 * permanently busy machine must not mean tests can never run.
 */
export function waitForCapacitySync(timeoutMs = 10 * 60_000): void {
  if (process.env.PW_IGNORE_LOAD === '1' || process.env.CI) return
  const cores = Math.max(1, os.cpus().length)
  if (loadPerCore() <= LOAD_PER_CORE_CEILING) return

  const deadline = Date.now() + timeoutMs
  console.log(
    `[pw-concurrency] machine is overloaded (load ${os.loadavg()[0].toFixed(0)} on ${cores} cores) — ` +
      `waiting for it to settle before starting browsers. Check with: scripts/pw-cleanup.sh status`,
  )
  while (Date.now() < deadline) {
    sleepSync(5_000)
    if (loadPerCore() <= LOAD_PER_CORE_CEILING) {
      console.log(`[pw-concurrency] load settled to ${os.loadavg()[0].toFixed(0)} — starting`)
      return
    }
  }
  console.warn(
    `[pw-concurrency] still overloaded (load ${os.loadavg()[0].toFixed(0)}) after ` +
      `${Math.round(timeoutMs / 60_000)}m; running anyway — expect timeout-shaped failures that are ` +
      `NOT product bugs. Set PW_IGNORE_LOAD=1 to skip this wait.`,
  )
}

/**
 * Block until the fixture port is ours. Returns null if it gives up — fail open,
 * loudly. Synchronous on purpose (see file header).
 */
export function acquireSync(port: number, timeoutMs = 20 * 60_000): string | null {
  const deadline = Date.now() + timeoutMs
  let announced = false
  for (;;) {
    const held = tryAcquire(port)
    if (held) return held
    if (Date.now() > deadline) {
      console.warn(
        `[pw-concurrency] waited ${Math.round(timeoutMs / 60_000)}m for :${port}; proceeding anyway — ` +
          `expect interference from ${describeHolder(port)}. Clear with: scripts/pw-cleanup.sh clean`,
      )
      return null
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
 * support: that one still has its shell as parent.
 */
export function reapOrphanFixtureServer(port: number): void {
  for (const pid of listeners(port)) {
    if (ppidOf(pid) !== 1) continue
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
