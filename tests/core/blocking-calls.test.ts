/**
 * Blocking-call ledger (src/core/blocking-calls.ts): a probe-late line names the
 * synchronous SQLite statements and child process starts that ran in its hold,
 * with their caller, so a 0.3 to 2 s hold is explained without a CPU profile
 * (2026-11-18 19:14: four holds of 279 to 632 ms in 15 s named nothing).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
    // A site needs a call of SITE_MIN_MS: the next test covers it with the threshold at 1 ms.
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

describe('a write that waits', () => {
  // On the Mac a one-row session INSERT that takes 0.03 ms on its own took up to
  // 504 ms in the server: the line must say whether the thread ran or waited, and on what.
  it('says the thread was off the CPU, and starts no lsof from the write (a child start holds the loop too)', async () => {
    const warn = vi.spyOn(log.web, 'warn').mockImplementation(() => {})
    installBlockingCallTiming()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocking-lock-'))
    const file = path.join(dir, 'held.sqlite')
    const db = Database(file)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)')
    // Another process takes the write lock and keeps it 600 ms.
    const holder = spawn(process.execPath, ['-e', `
      const { Database } = require('bun:sqlite')
      const db = new Database(${JSON.stringify(file)})
      db.exec('BEGIN IMMEDIATE'); db.exec("INSERT INTO t (b) VALUES ('held')")
      console.log('locked')
      setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0) }, 600)
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((resolve) => holder.stdout!.on('data', (d) => { if (String(d).includes('locked')) resolve() }))
    const from = performance.now()
    function writesTheSessionRow(): void { db.prepare('INSERT INTO t (b) VALUES (?)').run('mine') }
    writesTheSessionRow()
    const got = blockingCallsWithin(from, performance.now())
    await new Promise<void>((resolve) => holder.on('exit', () => resolve()))
    try {
      const insert = got?.calls.find((c) => c.what.startsWith('INSERT INTO t'))
      expect(insert?.maxMs).toBeGreaterThanOrEqual(300)
      expect(insert?.wait).toBeDefined()
      expect(insert!.wait!.cpuMs).toBeLessThan(insert!.maxMs / 4)
      // No child was started for it: the ledger holds no spawn in the write's span.
      expect(got?.calls.some((c) => c.kind === 'spawn')).toBe(false)
      expect(warn.mock.calls.some((c) => c[0] === 'sqlite: slow write, the processes that had the database open')).toBe(false)
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('samples CPU only for writes, never for reads', () => {
    installBlockingCallTiming()
    _setBlockingThresholdsForTesting({ minMs: 0, siteMs: 1_000 })
    const db = Database(':memory:')
    db.exec('CREATE TABLE t (a INTEGER)')
    const from = performance.now()
    db.prepare('INSERT INTO t VALUES (1)').run()
    db.prepare('SELECT * FROM t').all()
    const got = blockingCallsWithin(from, performance.now(), 10)
    db.close()
    expect(got!.calls.find((c) => c.what.startsWith('INSERT'))?.wait).toBeDefined()
    expect(got!.calls.find((c) => c.what.startsWith('SELECT'))?.wait).toBeUndefined()
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
    // From the probe's deadline to its late tick: the calls that held it past the deadline, no more.
    expect(line!.blocking!.ms).toBeGreaterThanOrEqual(line!.lateByMs * 0.8)
    expect(line!.blocking!.ms).toBeLessThanOrEqual(line!.lateByMs + 1)
  }, 15_000)
})
