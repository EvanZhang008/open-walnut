/**
 * Per-worker runtime-directory isolation. Loaded via `setupFiles`, so it runs
 * INSIDE every vitest worker process before any test module is imported.
 *
 * Why setupFiles and not globalSetup
 * ----------------------------------
 * `globalSetup` runs in the vitest RUNNER process. Mutating `process.env` there
 * only reaches workers that vitest forks afterwards and inherits into — it is not
 * a reliable channel, and with `pool: 'forks'` a worker can already exist. Env
 * that MUST hold inside the worker has to be set inside the worker. This file is
 * that hook; `global-setup.ts` keeps the same defence for the runner process and
 * for anything the runner spawns directly.
 *
 * What it protects (2026-08-09 incident)
 * --------------------------------------
 * constants.ts derives the whole RUNTIME tree from one env var:
 *
 *     LOG_DIR             = process.env.WALNUT_DAEMON_DIR || '/tmp/open-walnut'
 *     SESSION_STREAMS_DIR = LOG_DIR/streams
 *     IMAGES_DIR          = LOG_DIR/images
 *
 * `OPEN_WALNUT_HOME` (the DATA dir) was isolated for tests; `WALNUT_DAEMON_DIR`
 * (the RUNTIME dir) was not. So all ~125 test files that call startServer() wrote
 * their logs, session streams and images into the PRODUCTION runtime dir, shared
 * live with the :3456 server.
 *
 * The damage was diagnostic, and severe. CLAUDE.md's entire log toolkit
 * (`scripts/walnut-logs.sh diagnose|trace|busstorm|…`) reads
 * /tmp/open-walnut/open-walnut-<date>.log. Test servers' output landed there
 * indistinguishable from production: 43 test servers' event-loop-stall lines and
 * 64 `SERVER EXIT: SIGTERM` records inside one afternoon. When the user's Mac
 * really did starve and macOS started killing their GUI apps, that log read as
 * "43 concurrent production servers" — the investigation chased a nonexistent
 * server-lifecycle bug through several wrong hypotheses before the interleaving
 * was spotted. A shared log file makes every future incident harder to read, so
 * the isolation belongs at the harness level, not in individual tests.
 *
 * Tests that manage their own runtime dir (the daemon suites, which set
 * WALNUT_DAEMON_DIR to a per-file tmp path) are left untouched.
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

/** The production runtime dir — the default when WALNUT_DAEMON_DIR is unset. */
const PROD_RUNTIME_DIR = '/tmp/open-walnut' // safe: comparison only

/** Marks a dir this harness created, so a worker can tell it apart from a
 *  deliberate per-test choice (the daemon suites set their own path). */
const HARNESS_PREFIX = 'open-walnut-test-runtime-'

const current = process.env.WALNUT_DAEMON_DIR

const pointsAtProduction =
  !current ||
  current === PROD_RUNTIME_DIR ||
  current.startsWith(PROD_RUNTIME_DIR + path.sep)

// A worker INHERITS whatever global-setup.ts put in the runner's env. That value
// carries the RUNNER's pid, so every worker would share one runtime dir — and the
// daemon's `WALNUT_DAEMON_DIR + '-streams'` SIBLING would be shared too, putting
// concurrent workers back to interleaving each other's streams. Re-isolate any
// harness-created dir that isn't already ours.
const ours = `${HARNESS_PREFIX}${process.pid}`
const inheritedFromRunner =
  !!current &&
  path.basename(current).startsWith(HARNESS_PREFIX) &&
  path.basename(current) !== ours

if (pointsAtProduction || inheritedFromRunner) {
  const testRuntime = path.join(os.tmpdir(), ours)
  fs.mkdirSync(testRuntime, { recursive: true })
  process.env.WALNUT_DAEMON_DIR = testRuntime
}
