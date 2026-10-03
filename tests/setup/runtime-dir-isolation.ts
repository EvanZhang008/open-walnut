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
 *
 * One runtime dir per worker, always (2026-10-02)
 * -----------------------------------------------
 * A dir the caller chose (CI sets one per job) used to be kept as is, so every
 * worker of the run shared it, and with it the local daemon's port file. The
 * next file's server then ADOPTED the daemon the previous file's server had
 * spawned, still alive for a moment after its worker exited, and that daemon
 * expanded `~` with the previous file's WALNUT_HOME_OVERRIDE: history, plans
 * and Changed read another test's home and found nothing (6 e2e failures that
 * only CI saw). Such a dir now holds one subdir per worker instead.
 *
 * The production SERVER gets the same treatment: prod-server-guard refuses any
 * connection to :3456 or to a socket in the production runtime dir, and fails
 * the test that tried (2026-09-29: a test's ops reached the live server).
 * Imported here so every config built on vitest.config.ts loads it.
 */
// Live opt-ins (WALNUT_LIVE_*, WALNUT_TEST_REAL_CLAUDE) count only in the live
// tier, so one the shell exported never turns this run live (live-tier-only.ts).
import './live-tier-only.js'
import './prod-server-guard.js'
// Sessions on a daemon the test did not start run the mock CLI, never `claude`.
import './claude-stand-in.js'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { RUNTIME_DIR_PREFIX, workerRuntimeDir } from './runtime-dir-choice.js'

// A worker INHERITS the runner's dir: global-setup.ts's (named for the RUNNER's
// pid) or one the caller chose. Kept as is, every worker would share it, the
// daemon's `WALNUT_DAEMON_DIR + '-streams'` sibling and port file included, so
// each worker moves to a dir of its own (runtime-dir-choice.ts).
const current = process.env.WALNUT_DAEMON_DIR
const ours = `${RUNTIME_DIR_PREFIX}${process.pid}`
const testRuntime = workerRuntimeDir(current, process.pid, os.tmpdir())

if (testRuntime) {
  fs.mkdirSync(testRuntime, { recursive: true })
  process.env.WALNUT_DAEMON_DIR = testRuntime
  // The dir is this worker's alone (pid-named), so it goes when the worker goes.
  // This covers a worker that exits on its own; the pool usually ends a worker
  // with a signal instead, which skips 'exit', so global-setup's setup/teardown
  // sweep is the path that actually reclaims most of them (by dead pid).
  // 2026-09-13: with neither, 26k of these had piled up in $TMPDIR.
  process.on('exit', () => {
    for (const dir of [testRuntime, `${testRuntime}-streams`]) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })
}

// Session daemons journal every CLI they start into ~/.open-walnut/local (see
// SPAWN_JOURNAL in daemon-standalone.ts), and test daemons inherit this env. A
// mock spawn has no transcript in ~/.claude, so its line is pure noise there:
// keep it in this worker's runtime dir, which the sweeps above reclaim. Re-point
// an inherited value too, so workers never share one file.
if (!process.env.WALNUT_SPAWN_JOURNAL || !process.env.WALNUT_SPAWN_JOURNAL.includes(ours)) {
  process.env.WALNUT_SPAWN_JOURNAL = path.join(os.tmpdir(), ours, 'spawn-journal.jsonl')
}

// Search v2 is default-ON (2026-08-26 cutover), and its semantic lane spawns an
// embed worker whose first query tries to LOAD (and, on a fresh temp
// WALNUT_HOME, download — ~600MB) the embedding model. No test needs that:
// keyword-only covers every route/tool contract, and the dedicated semantic
// tests use the fake worker fixture. Tests that really want the worker opt
// back in by setting this to '1' themselves.
if (process.env.WALNUT_SEARCH_V2_SEMANTIC === undefined) {
  process.env.WALNUT_SEARCH_V2_SEMANTIC = '0'
}

// Session daemons snapshot the working tree at every turn end of a session in
// a git repo (turn-snapshot-core.ts), writing hidden refs into that repo. A test
// daemon whose session runs in this checkout (or any real repo) must never do
// that, so test daemons inherit the kill switch. The snapshot tests drive the
// core directly against temp repos, and the browser fixture opts in for one
// temp root of its own.
if (process.env.WALNUT_TURN_SNAPSHOTS === undefined) {
  process.env.WALNUT_TURN_SNAPSHOTS = '0'
}
