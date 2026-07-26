/**
 * The admission gate, engaged at config-load time.
 *
 * Playwright loads the config in the runner process AND once per worker process,
 * and it starts the `webServer` plugin before globalSetup — so the runner's config
 * load is the ONLY hook early enough to (a) queue behind another run and (b) reap
 * an orphaned fixture server before `reuseExistingServer` can attach to it.
 *
 * See pw-concurrency.ts for the incident this prevents.
 */

import {
  acquireSync,
  describeHolder,
  reapOrphanFixtureServer,
  release,
  startLeaseHeartbeat,
  waitForCapacitySync,
} from './pw-concurrency.js'

/**
 * Workers re-load the config; only the runner may hold the lease. Playwright sets
 * TEST_WORKER_INDEX in workers (workerMain.js), so its absence identifies the runner.
 */
function isWorkerProcess(): boolean {
  return process.env.TEST_WORKER_INDEX !== undefined
}

/**
 * Only gate real test runs. `--list`, `show-report`, codegen and friends load the
 * config too, and must not queue for a port they'll never bind.
 */
function isRealRun(): boolean {
  const argv = process.argv.slice(2)
  if (!argv.includes('test')) return false
  return !argv.some((a) => a === '--list' || a === '--help')
}

let engaged = false

export function engageGate(port: number): void {
  if (engaged || isWorkerProcess() || !isRealRun() || process.env.PW_NO_GATE === '1') return
  engaged = true

  const started = Date.now()
  const lease = acquireSync(port)
  if (lease) {
    const waited = Math.round((Date.now() - started) / 1000)
    console.log(`[pw-concurrency] holding :${port}${waited > 1 ? ` after ${waited}s in queue` : ''}`)
  } else {
    console.warn(`[pw-concurrency] running WITHOUT the :${port} lease — ${describeHolder(port)} may interfere`)
  }

  // Now that no other run may own the port, any listener still on it is debris
  // from a killed run. Reap before webServer's reuseExistingServer sees it.
  reapOrphanFixtureServer(port)

  // Hold off if something ELSE is already saturating the machine (a concurrent
  // vitest suite, Xcode, simulators). Done while holding the lease so we don't
  // lose our place in line, and after the reap so we don't wait on our own debris.
  waitForCapacitySync()

  // The full suite (245 tests) can outlive the lease TTL; heartbeat so no other
  // run mistakes a live holder for a dead one and seizes the port mid-run.
  startLeaseHeartbeat(lease)

  // Release on normal exit only — deliberately NO SIGINT/SIGTERM handlers.
  //
  // Registering JS signal handlers here would override Node's default terminate
  // behavior, and the gate's waits are synchronous (Atomics.wait / sync polling):
  // signals are dispatched by the event loop, which a sync loop never reaches, so
  // the handler could not run AND the default kill would be suppressed. Verified:
  // a queued run then ignored SIGTERM entirely and kept its lease.
  //
  // Letting the default kill happen is strictly better — the lease carries our
  // PID, and the next run reclaims any lease whose holder is gone (reapStaleLease),
  // so an abruptly killed run frees the port immediately rather than after the TTL.
  process.once('exit', () => release(lease))
}
