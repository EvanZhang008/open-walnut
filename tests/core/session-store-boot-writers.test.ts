/**
 * The session snapshot survives the writes of a server's first minutes: every write section is
 * patched into the cached rows, none drops them, and the cached rows always equal a fresh scan.
 *
 * After a start the live server still scanned all ~7.7k session rows (~110 ms on its loop each)
 * about 50 times in 10 minutes (2026-11-25, `drops=unnamed:49`). The write lock compared how many
 * session rows a section changed (SQLite's count) with how many distinct ids it named, so a section
 * that wrote one row twice (a host channel batch with two changes of one session, the usual case)
 * read as a change nobody named and dropped the snapshot. The lock now asks SQLite which rows the
 * section changed (session-db.ts takeChangedSessionRows), so any writer on the store's connection is
 * patched, named or not, and nothing can go stale.
 *
 * The second half enumerates every SQL statement in src/ that writes the sessions table: each runs on
 * the store's write connection inside the write lock (SQLite records its rows) or is listed with why
 * the snapshot still sees it, so a new writer is reviewed before it lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-store-boot-writers'))

import {
  _dropSessionStoreCacheForTesting, _resetSessionTrackerForTesting, _sessionStoreStatsForTesting, _withSessionWriteLockForTesting,
  batchUpdateSessionRecords, createSessionRecord, deleteSessionRecords, listSessions, renameSessionId, scrubInheritedSessionPids,
  updateSessionRecord, updateSessionRecordConditionally,
} from '../../src/core/session-tracker.js'
import { applyHanded } from '../helpers/handed-rows.js'
import { closeDb, getDb, transactionWhenFree } from '../../src/core/session-db.js'
import { WALNUT_HOME } from '../../src/constants.js'
import type { SessionRecord } from '../../src/core/types.js'

const HOST = 'devbox'
const born = (sid: string, extra: Partial<SessionRecord> = {}): Record<string, unknown> => ({
  claudeSessionId: sid, taskId: '', project: 'p', process_status: 'running', mode: 'default', host: HOST, judge: 'host',
  startedAt: '2026-11-22T00:00:00.000Z', lastActiveAt: '2026-11-22T00:00:00.000Z', messageCount: 0, title: 'From host',
  statusRevision: 1, statusUpdatedAt: '2026-11-22T00:00:00.000Z', ...extra,
})
const stats = () => _sessionStoreStatsForTesting()
const byId = (rows: SessionRecord[]) => JSON.stringify([...rows].sort((a, b) => a.claudeSessionId.localeCompare(b.claudeSessionId)))

/** The cached rows equal what a fresh scan reads now; the fresh scan is undone from the counters. */
async function expectSnapshotMatchesStore(): Promise<void> {
  const cached = byId(await listSessions())
  _dropSessionStoreCacheForTesting()
  expect(cached).toBe(byId(await listSessions()))
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => { closeDb(); _resetSessionTrackerForTesting() })

describe('the session snapshot across the writers of a boot', () => {
  it('stays patched (one scan) and equal to a fresh scan through every kind of write section', async () => {
    for (let i = 1; i <= 4; i++) await createSessionRecord(`local-${i}`, '', 'p', '/w', { pid: 900000 + i })
    await applyHanded({ hostId: HOST, rows: [
      { sid: 'h1', born: true, patch: born('h1'), seq: 1 },
      { sid: 'h2', born: true, patch: born('h2'), seq: 2 },
    ], renames: [], cursor: { logId: 'L1', seq: 2 }, check: ['h1', 'h2'] })
    await listSessions()
    expect(stats().fullScans).toBe(1)

    // An inherited-pid scrub: one bulk UPDATE over every row that holds a pid.
    await scrubInheritedSessionPids(() => false, { home: WALNUT_HOME, productionHomes: [] })
    // A host channel batch with two changes of one session (a status change, then its message count).
    await applyHanded({ hostId: HOST, rows: [
      { sid: 'h1', patch: { process_status: 'idle' }, seq: 3 },
      { sid: 'h1', patch: { messageCount: 4 }, seq: 4 },
      { sid: 'h2', patch: { messageCount: 1 }, seq: 5 },
    ], renames: [], cursor: { logId: 'L1', seq: 5 } })
    // A rename in a batch: the old row deleted, the new one written.
    await applyHanded({ hostId: HOST, rows: [], renames: [{ from: 'h2', to: 'h2b', seq: 6 }], cursor: { logId: 'L1', seq: 6 } })
    // The health monitor's and the recovery's single and batched status writes.
    await updateSessionRecord('local-1', { title: 'recovered' })
    await batchUpdateSessionRecords(['local-2', 'local-3', 'local-2'], { process_status: 'stopped' })
    await updateSessionRecordConditionally('local-4', { title: 'reconciled' }, () => true)
    await renameSessionId('local-4', 'local-4b')
    await deleteSessionRecords(new Set(['local-3']))
    // A section whose writes no helper names (a bulk UPDATE through the store's connection).
    await _withSessionWriteLockForTesting(async () => {
      const lockWait = transactionWhenFree((handle) => {
        handle.prepare("UPDATE sessions SET title = 'bulk ' || claude_session_id WHERE process_status = 'stopped'").run()
      })
      if (lockWait instanceof Promise) await lockWait
    })

    expect(stats().dropUnnamed).toBe(0)
    expect(stats().fullScans).toBe(1)
    const rows = await listSessions()
    expect(rows.find((s) => s.claudeSessionId === 'h1')).toMatchObject({ process_status: 'idle', messageCount: 4 })
    expect(rows.some((s) => s.claudeSessionId === 'h2')).toBe(false)
    expect(rows.find((s) => s.claudeSessionId === 'local-2')?.title).toBe('bulk local-2')
    expect(rows.some((s) => s.claudeSessionId === 'local-3')).toBe(false)
    expect(rows.some((s) => s.claudeSessionId === 'local-4b')).toBe(true)
    expect(rows.every((s) => s.pid === undefined)).toBe(true)
    expect(stats().fullScans).toBe(1)
    await expectSnapshotMatchesStore()
  })

  it('a section that rolls back leaves the snapshot equal to the store, without a scan', async () => {
    await createSessionRecord('r1', '', 'p', '/w')
    await createSessionRecord('r2', '', 'p', '/w')
    await listSessions()
    await expect(_withSessionWriteLockForTesting(async () => {
      transactionWhenFree((handle) => {
        handle.prepare("UPDATE sessions SET title = 'never stored'").run()
        throw new Error('the section fails')
      })
    })).rejects.toThrow('the section fails')
    await updateSessionRecord('r2', { title: 'after' })
    expect(stats().fullScans).toBe(1)
    const rows = await listSessions()
    expect(rows.find((s) => s.claudeSessionId === 'r1')?.title).not.toBe('never stored')
    expect(rows.find((s) => s.claudeSessionId === 'r2')?.title).toBe('after')
    await expectSnapshotMatchesStore()
  })

  // Raw statements in the lock, so a missing DELETE trigger, or an UPDATE trigger that skips the old id, fails here.
  async function inLock(sql: string): Promise<void> {
    await _withSessionWriteLockForTesting(async () => {
      const lockWait = transactionWhenFree((handle) => { handle.prepare(sql).run() })
      if (lockWait instanceof Promise) await lockWait
    })
  }

  it('a raw DELETE in the lock leaves the snapshot equal to the store, without a scan', async () => {
    for (const id of ['d1', 'd2', 'd3']) await createSessionRecord(id, '', 'p', '/w')
    await listSessions()
    await inLock("DELETE FROM sessions WHERE claude_session_id IN ('d1', 'd3')")
    expect((await listSessions()).map((s) => s.claudeSessionId).sort()).toEqual(['d2'])
    expect(stats().fullScans).toBe(1)
    await expectSnapshotMatchesStore()
  })

  it('a raw UPDATE of the id in the lock (a rename) leaves no row under the old id, without a scan', async () => {
    await createSessionRecord('old-id', '', 'p', '/w', { title: 'renamed raw' })
    await createSessionRecord('other', '', 'p', '/w')
    await listSessions()
    await inLock("UPDATE sessions SET claude_session_id = 'new-id' WHERE claude_session_id = 'old-id'")
    const rows = await listSessions()
    expect(rows.map((s) => s.claudeSessionId).sort()).toEqual(['new-id', 'other'])
    expect(rows.find((s) => s.claudeSessionId === 'new-id')?.title).toBe('renamed raw')
    expect(stats().fullScans).toBe(1)
    await expectSnapshotMatchesStore()
  })

  it('a row with no id never fails its write (the recorder skips it)', async () => {
    await createSessionRecord('n1', '', 'p', '/w')
    await listSessions()
    await expect(_withSessionWriteLockForTesting(async () => {
      transactionWhenFree((handle) => {
        handle.prepare('INSERT INTO sessions (claude_session_id, project) VALUES (NULL, ?)').run('p')
        handle.prepare('UPDATE sessions SET project = ? WHERE claude_session_id IS NULL').run('q')
        handle.prepare('DELETE FROM sessions WHERE claude_session_id IS NULL').run()
      })
    })).resolves.toBeUndefined()
    expect(stats().fullScans).toBe(1)
    await expectSnapshotMatchesStore()
  })

  it('a write on the store connection outside the lock is patched in at the next read', async () => {
    await createSessionRecord('u1', '', 'p', '/w')
    await listSessions()
    getDb()!.prepare("UPDATE sessions SET title = 'outside the lock' WHERE claude_session_id = 'u1'").run()
    expect((await listSessions()).find((s) => s.claudeSessionId === 'u1')?.title).toBe('outside the lock')
    expect(stats().unlockedWrites).toBe(1)
    expect(stats().fullScans).toBe(1)
    await expectSnapshotMatchesStore()
  })

  it('a write on another connection still drops the snapshot (data_version), and the next read is fresh', async () => {
    await createSessionRecord('x1', '', 'p', '/w')
    await listSessions()
    const Database = (await import('../../src/lib/sqlite.js')).default
    const other = new Database(getDb()!.name)
    try { other.prepare("UPDATE sessions SET title = 'from a hook' WHERE claude_session_id = 'x1'").run() } finally { other.close() }
    expect((await listSessions()).find((s) => s.claudeSessionId === 'x1')?.title).toBe('from a hook')
    expect(stats().fullScans).toBe(2)
  })
})

// ── Every statement in src/ that writes the sessions table ──────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const WRITE = /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(?:main\.)?sessions\b|UPDATE\s+(?:OR\s+\w+\s+)?(?:main\.)?sessions\b|DELETE\s+FROM\s+(?:main\.)?sessions\b|REPLACE\s+INTO\s+(?:main\.)?sessions\b)/gi

/** In the write lock on the store's write connection: the lock reads its rows from SQLite. */
const IN_LOCK = 'runs inside withWriteLock on the store write connection: SQLite records the rows it changes (takeChangedSessionRows) and the lock patches them'
/** Writers the snapshot sees another way, by file and the function they are in, with why. */
const SNAPSHOT_SEES: Record<string, Record<string, string>> = {
  'src/core/session-tracker.ts': {
    scrubInheritedSessionPids: IN_LOCK,
    writeSessionRowSqlite: IN_LOCK,
    deleteSessionRowSqlite: IN_LOCK,
    batchUpdateSessionRecords: IN_LOCK,
    renameSessionId: IN_LOCK,
    retaskSessionRows: IN_LOCK,
    completeTaskSessions: IN_LOCK,
    deleteSessionRecords: IN_LOCK,
  },
  'src/core/session-db.ts': {
    applySessionCopy: "a replica's copy of the leader's rows: on a host through its own apply connection (a foreign commit: data_version drops the snapshot); the leader never runs it",
    writeCopyRow: "a host's claim or give-back of a copied row, on the copy's apply connection (a foreign commit)",
    applyCompanionSessionCopy: "the companion's own file of the Mac's sessions, never this store",
    ensureSessionStatusColumns: 'the schema backfill at open, before any snapshot exists',
  },
  'src/core/session-db-migration.ts': {
    '(any)': 'the one-time import of the legacy JSON store at first open, before any snapshot exists',
  },
  'src/core/leader/switch/session-hosts.ts': {
    moveSessionHosts: 'a leader switch, on a connection of its own to a file no server has open yet',
  },
  'src/hooks/on-compact.ts': {
    '(any)': "the on-compact hook process's own connection (a foreign commit: data_version drops the snapshot)",
  },
  'src/hooks/session-status-store.ts': {
    '(any)': "the on-stop hook process's own connection (a foreign commit: data_version drops the snapshot)",
  },
}

function enclosingFunction(lines: string[], at: number): string {
  for (let i = at; i >= 0; i--) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(lines[i]!)
    if (m) return m[1]!
  }
  return '(top level)'
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

function sessionWrites(): Array<{ file: string; line: number; fn: string; sql: string }> {
  const out: Array<{ file: string; line: number; fn: string; sql: string }> = []
  for (const abs of sourceFiles(path.join(ROOT, 'src'))) {
    const file = path.relative(ROOT, abs).split(path.sep).join('/')
    const lines = fs.readFileSync(abs, 'utf8').split('\n')
    lines.forEach((l, i) => {
      // Comments and log text name these statements too; only code counts.
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
      for (const m of l.matchAll(WRITE)) out.push({ file, line: i + 1, fn: enclosingFunction(lines, i), sql: m[1]! })
    })
  }
  return out
}

describe('every statement in src/ that writes the sessions table', () => {
  it('is in the write lock on the store connection, or listed with why the snapshot still sees it', () => {
    const writes = sessionWrites()
    expect(writes.length).toBeGreaterThan(10)
    const unlisted = writes.filter((w) => !SNAPSHOT_SEES[w.file]?.[w.fn] && !SNAPSHOT_SEES[w.file]?.['(any)'])
      .map((w) => `${w.file}:${w.line} ${w.sql} in ${w.fn}()`)
    expect(unlisted, 'a new writer of the sessions table: run it inside withWriteLock on sessionWriteHandle, or list it in SNAPSHOT_SEES with why the cached rows still see it').toEqual([])
  })

  it('lists no writer that no longer writes', () => {
    const present = new Set(sessionWrites().map((w) => `${w.file} ${w.fn}`))
    for (const [file, fns] of Object.entries(SNAPSHOT_SEES)) {
      for (const fn of Object.keys(fns)) {
        if (fn === '(any)') expect([...present].some((p) => p.startsWith(`${file} `)), file).toBe(true)
        else expect(present.has(`${file} ${fn}`), `${file} ${fn}`).toBe(true)
      }
    }
  })

  it('the store connection records the rows of every kind of write, and the lock patches from them', () => {
    const db = fs.readFileSync(path.join(ROOT, 'src/core/session-db.ts'), 'utf8')
    for (const kind of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(db).toMatch(new RegExp(`CREATE TEMP TRIGGER IF NOT EXISTS session_rows_changed_${kind.toLowerCase()} AFTER ${kind} ON main\\.sessions`))
    }
    const tracker = fs.readFileSync(path.join(ROOT, 'src/core/session-tracker.ts'), 'utf8')
    const settle = tracker.slice(tracker.indexOf('function settleSnapshot'), tracker.indexOf('function withWriteLock'))
    expect(settle).toMatch(/takeChangedSessionRows\(/)
  })
})
