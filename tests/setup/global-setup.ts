/**
 * Vitest globalSetup — runs once before any test file in the worker pool.
 *
 * Sets WALNUT_HOME, WALNUT_DAEMON_DIR and NODE_ENV so that even child forks
 * (which inherit process.env) never resolve to the production ~/.open-walnut/
 * directory or the production /tmp/open-walnut/ runtime directory.
 *
 * This is Layer 1 of the production-data protection stack:
 *   L1: globalSetup env propagation (this file)
 *   L2: assertNotProductionPath() in constants.ts
 *   L3: hardcoded-path fixes in scripts/
 *   L4: lint grep guard
 *
 * ⚠️ WALNUT_DAEMON_DIR used to be left UNSET here, which isolated the data dir
 * but NOT the runtime dir. constants.ts derives LOG_DIR, SESSION_STREAMS_DIR and
 * IMAGES_DIR from `WALNUT_DAEMON_DIR || '/tmp/open-walnut'`, so all ~125 test
 * files that call startServer() wrote their logs, session streams and images into
 * the PRODUCTION runtime dir alongside the live :3456 server. Consequences seen on
 * 2026-08-09: test-server log lines interleaved into
 * /tmp/open-walnut/open-walnut-<date>.log, which is the file every diagnostic in
 * CLAUDE.md's log toolkit reads — 43 test servers' background-loop output appeared
 * there as if it were production, making a real machine-starvation incident
 * unreadable and sending the investigation down the wrong path entirely.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { acquireTestSlot, releaseTestSlot } from './test-gate';

/**
 * Fail fast when the running Node can't load better-sqlite3.
 *
 * The addon is compiled against one Node ABI (NODE_MODULE_VERSION), so running
 * the suite under a different Node makes every sqlite-backed test fail. Measured:
 * a single ABI mismatch produced 3003 error lines and ~300 failures across
 * task-manager / session-tracker / task-db, none of which name the real cause.
 * One clear abort in ~200ms beats minutes of misleading red.
 *
 * Unlike the server's preflight (src/core/native-abi-preflight.ts) this does NOT
 * auto-rebuild: test runs are machine-wide-serialized but can still overlap with
 * a server start, and two concurrent `npm rebuild`s on one node_modules is a
 * corruption risk. Tests report; only the server repairs.
 */
function assertNativeAbiMatches(): void {
  try {
    const req = createRequire(import.meta.url);
    const Database = req('better-sqlite3') as new (p: string) => { close(): void };
    new Database(':memory:').close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(message)) {
      return;  // Some other sqlite problem — let the individual tests report it.
    }
    throw new Error(
      `\n\nNative module ABI mismatch — the test suite cannot run under this Node.\n`
      + `  running Node: ${process.versions.node} (NODE_MODULE_VERSION ${process.versions.modules})\n`
      + `  better-sqlite3 was compiled for a different ABI.\n\n`
      + `Fix either side:\n`
      + `  npm rebuild better-sqlite3      # recompile for the Node you're using\n`
      + `  or switch to a Node matching package.json "engines" and re-run\n\n`
      + `Original error:\n${message}\n`,
    );
  }
}

export async function setup(): Promise<void> {
  assertNativeAbiMatches();

  // Machine-wide gate: a second concurrent vitest run queues instead of
  // stacking another ~8GB of fork workers (see tests/setup/test-gate.ts).
  await acquireTestSlot();

  const prodHome = path.join(os.homedir(), '.open-walnut'); // safe: production-path — comparison only
  const current = process.env.OPEN_WALNUT_HOME;

  // Runtime dir (logs / session streams / images) must be isolated too — it is a
  // SEPARATE env var from the data dir, and leaving it unset silently pointed every
  // test server at the production /tmp/open-walnut/. Done before the early-return
  // below so a caller-supplied OPEN_WALNUT_HOME still gets runtime isolation.
  isolateRuntimeDir();

  // If WALNUT_HOME is already set to a safe (non-production) path, keep it
  if (current && current !== prodHome && !current.startsWith(prodHome + path.sep)) {
    process.env.NODE_ENV = 'test';
    return;
  }

  // Force a temp dir that child forks will inherit
  const testHome = path.join(os.tmpdir(), 'open-walnut-test-global');
  fs.mkdirSync(testHome, { recursive: true });

  process.env.OPEN_WALNUT_HOME = testHome;
  process.env.NODE_ENV = 'test';
}

/** Production runtime dir — the default when WALNUT_DAEMON_DIR is unset. */
const PROD_RUNTIME_DIR = '/tmp/open-walnut'; // safe: comparison only

/**
 * Point WALNUT_DAEMON_DIR at a throwaway dir unless the caller already chose a
 * non-production one. Tests that need their own per-file runtime dir (the daemon
 * suites) still set it themselves and are left alone.
 *
 * This covers the RUNNER process and anything it spawns directly. Worker processes
 * get the same treatment from tests/setup/runtime-dir-isolation.ts (a setupFile),
 * because env set here does not reliably reach an already-forked worker. Both use
 * the same pid-suffixed shape so a daemon's `WALNUT_DAEMON_DIR + '-streams'`
 * sibling (see daemon-source.ts) also stays per-process.
 */
function isolateRuntimeDir(): void {
  const current = process.env.WALNUT_DAEMON_DIR;
  const isProd = !current
    || current === PROD_RUNTIME_DIR
    || current.startsWith(PROD_RUNTIME_DIR + path.sep);
  if (!isProd) return;

  const testRuntime = path.join(os.tmpdir(), `open-walnut-test-runtime-${process.pid}`);
  fs.mkdirSync(testRuntime, { recursive: true });
  process.env.WALNUT_DAEMON_DIR = testRuntime;
}

export function teardown(): void {
  releaseTestSlot();
}
