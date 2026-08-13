/**
 * Regression lock: a test process must NEVER resolve its runtime paths (logs,
 * session streams, images) into the production /tmp/open-walnut/ tree.
 *
 * The 2026-08-09 incident
 * -----------------------
 * constants.ts derives the whole runtime tree from ONE env var:
 *
 *     LOG_DIR             = process.env.WALNUT_DAEMON_DIR || '/tmp/open-walnut'
 *     SESSION_STREAMS_DIR = LOG_DIR/streams
 *     IMAGES_DIR          = LOG_DIR/images
 *
 * The test harness isolated OPEN_WALNUT_HOME (the DATA dir) but not
 * WALNUT_DAEMON_DIR (the RUNTIME dir). 113 of the 120 test files that call
 * startServer() happened to be saved by createMockConstants(), which overrides
 * LOG_DIR itself — but the 7 that don't wrote their server logs straight into the
 * live production log file, /tmp/open-walnut/open-walnut-<date>.log.
 *
 * That file is what every diagnostic in CLAUDE.md reads
 * (`scripts/walnut-logs.sh diagnose|trace|busstorm|…`). Test-server output sitting
 * in it is indistinguishable from production: on 2026-08-09 it contained 64
 * `SERVER EXIT: SIGTERM` records and 43 concurrent event-loop-stall emitters from
 * test servers. When the user's Mac genuinely starved and macOS began killing
 * their GUI applications, that log read as "43 concurrent production servers" and
 * sent the investigation through several wrong root causes before the interleaving
 * was noticed.
 *
 * Hence this lock: assert the invariant at the harness level, in the same worker
 * a real test runs in. If someone removes runtime-dir-isolation.ts from
 * setupFiles, or reorders it after a module that freezes the constants, this
 * fails immediately instead of silently poisoning the next incident's evidence.
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'

const PROD_RUNTIME_DIR = '/tmp/open-walnut' // safe: comparison only

function isUnderProduction(p: string): boolean {
  return p === PROD_RUNTIME_DIR || p.startsWith(PROD_RUNTIME_DIR + path.sep)
}

describe('test runtime-dir isolation', () => {
  it('WALNUT_DAEMON_DIR does not point into the production runtime dir', () => {
    const dir = process.env.WALNUT_DAEMON_DIR
    expect(dir, 'WALNUT_DAEMON_DIR must be set by tests/setup/runtime-dir-isolation.ts').toBeTruthy()
    expect(
      isUnderProduction(dir!),
      `WALNUT_DAEMON_DIR=${dir} resolves into the production runtime dir — test logs would ` +
      `interleave into /tmp/open-walnut/open-walnut-<date>.log and corrupt incident evidence`,
    ).toBe(false)
  })

  it('the constants derived from it stay out of production (LOG_DIR / streams / images)', async () => {
    const { LOG_DIR, SESSION_STREAMS_DIR, IMAGES_DIR } = await import('../../src/constants.js')
    for (const [name, dir] of Object.entries({ LOG_DIR, SESSION_STREAMS_DIR, IMAGES_DIR })) {
      expect(
        isUnderProduction(dir),
        `${name}=${dir} is inside the production runtime dir`,
      ).toBe(false)
    }
  })

  it('the daemon streams sibling (WALNUT_DAEMON_DIR + "-streams") is also isolated', () => {
    // daemon-source.ts derives STREAMS_DIR as `DAEMON_DIR + '-streams'` — a
    // SIBLING, not a child. A non-pid-suffixed runtime dir would therefore be
    // shared across concurrent workers even though the dir itself looked isolated.
    const sibling = `${process.env.WALNUT_DAEMON_DIR}-streams`
    expect(isUnderProduction(sibling), `${sibling} is inside the production runtime dir`).toBe(false)
    expect(
      sibling.includes(String(process.pid)),
      `${sibling} is not per-process — concurrent workers would share one streams dir`,
    ).toBe(true)
  })
})
