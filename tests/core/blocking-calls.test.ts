/**
 * Blocking-call ledger (src/core/blocking-calls.ts): a probe-late line names the
 * synchronous SQLite statements and child process starts that ran in its hold,
 * with their caller, so a 0.3 to 2 s hold is explained without a CPU profile
 * (2026-11-18 19:14: four holds of 279 to 632 ms in 15 s named nothing).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import Database from '../../src/lib/sqlite.js'
import {
  blockingCallsWithin,
  callerSite,
  installBlockingCallTiming,
  noteBlockingCall,
  sqlLabel,
  _resetBlockingCallsForTesting,
  _setBlockingThresholdsForTesting,
} from '../../src/core/blocking-calls.js'
import { startEventLoopMonitor, stopEventLoopMonitor } from '../../src/core/event-loop-monitor.js'
import { log } from '../../src/logging/index.js'

const SLOW_SQL = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) FROM c'

/** A statement that holds the thread at least `ms` (sized on this machine). */
function holdWithSqlite(db: ReturnType<typeof Database>, ms: number): void {
  const stmt = db.prepare(SLOW_SQL)
  const start = performance.now()
  while (performance.now() - start < ms) stmt.get(400_000)
}

afterEach(() => {
  _resetBlockingCallsForTesting()
  stopEventLoopMonitor()
  vi.restoreAllMocks()
})

describe('blocking-call ledger', () => {
  it('records a slow SQLite statement with its SQL and its caller', () => {
    installBlockingCallTiming()
    const db = Database(':memory:')
    const from = performance.now()
    function readsTheWholeTable(): void { holdWithSqlite(db, 150) }
    readsTheWholeTable()
    const got = blockingCallsWithin(from, performance.now())
    db.close()
    expect(got).not.toBeNull()
    const top = got!.calls[0]
    expect(top.kind).toBe('sqlite')
    expect(top.what).toBe(sqlLabel(SLOW_SQL))
    expect(got!.ms).toBeGreaterThanOrEqual(100)
    // Every call here is under 100 ms on a fast machine, so only the long ones carry a site; the group with one names the caller.
    const withSite = got!.calls.find((c) => c.site)
    if (withSite) expect(withSite.site).toMatch(/readsTheWholeTable|holdWithSqlite/)
  })

  it('names the caller of a call of SITE_MIN_MS or more', () => {
    installBlockingCallTiming()
    _setBlockingThresholdsForTesting({ minMs: 1, siteMs: 1 })
    const db = Database(':memory:')
    const from = performance.now()
    function writesTheSessionRow(): void { db.prepare(SLOW_SQL).get(300_000) }
    writesTheSessionRow()
    const got = blockingCallsWithin(from, performance.now())
    db.close()
    expect(got!.calls[0].site).toMatch(/writesTheSessionRow/)
  })

  it('counts a transaction and the statements inside it once', () => {
    installBlockingCallTiming()
    const db = Database(':memory:')
    const from = performance.now()
    db.transaction(() => { holdWithSqlite(db, 120) })()
    const to = performance.now()
    const got = blockingCallsWithin(from, to)
    db.close()
    expect(got!.calls.map((c) => c.what)).toContain('transaction')
    expect(got!.ms).toBeLessThanOrEqual(Math.ceil(to - from))
  })

  it('times the synchronous start of a child process through every child_process entry', async () => {
    installBlockingCallTiming()
    _setBlockingThresholdsForTesting({ minMs: 0, siteMs: 0 })
    const from = performance.now()
    function pollsGitStatus(): Promise<void> {
      return new Promise((resolve) => { execFile('git', ['--version'], () => resolve()) })
    }
    await pollsGitStatus()
    const got = blockingCallsWithin(from, performance.now())
    const spawn = got?.calls.find((c) => c.kind === 'spawn')
    expect(spawn?.what).toBe('git --version')
    expect(spawn?.site).toMatch(/pollsGitStatus/)
  })

  it('leaves calls outside the span out and keeps nothing under the threshold', () => {
    const t = performance.now()
    noteBlockingCall('sqlite', 'SELECT 1', t - 5_000, 300)
    noteBlockingCall('sqlite', 'SELECT 2', t, 5)
    expect(blockingCallsWithin(t - 1_000, t + 1_000)).toBeNull()
  })

  it('reads a caller site from a stack', () => {
    const stack = 'Error\n    at noteTimed (/x/src/core/blocking-calls.ts:1:1)\n    at <anonymous> (/$bunfs/root/walnut:9:9)\n    at run (/x/src/lib/sqlite.ts:2:2)\n    at writeSessionRowSqlite (/x/src/core/session-tracker.ts:1850:7)\n    at /x/src/core/session-tracker.ts:1724:9\n    at upsert (/x/a.ts:3:3)\n    at more (/x/b.ts:4:4)'
    expect(callerSite(stack)).toBe('writeSessionRowSqlite session-tracker.ts:1850 < session-tracker.ts:1724 < upsert a.ts:3')
  })
})

describe('probe-late line', () => {
  // The guard: a hold made of SQLite work names it on the line every reader of
  // the logs (scripts/walnut-logs.sh stalls) sees.
  it('carries the statements that held the loop', async () => {
    const warn = vi.spyOn(log.web, 'warn').mockImplementation(() => {})
    vi.spyOn(log.web, 'info').mockImplementation(() => {})
    installBlockingCallTiming()
    startEventLoopMonitor()
    const db = Database(':memory:')
    await new Promise((r) => setTimeout(r, 50))
    holdWithSqlite(db, 1_600)
    for (let i = 0; i < 100 && !warn.mock.calls.some((c) => c[0] === 'event-loop blocked (probe late)'); i++) {
      await new Promise((r) => setTimeout(r, 30))
    }
    db.close()
    const line = warn.mock.calls.find((c) => c[0] === 'event-loop blocked (probe late)')?.[1] as
      { lateByMs: number; blocking?: { ms: number; calls: Array<{ kind: string; what: string }> } } | undefined
    expect(line).toBeDefined()
    expect(line!.blocking?.calls[0]).toMatchObject({ kind: 'sqlite', what: sqlLabel(SLOW_SQL) })
    expect(line!.blocking!.ms).toBeGreaterThanOrEqual(line!.lateByMs * 0.8)
  }, 15_000)
})
