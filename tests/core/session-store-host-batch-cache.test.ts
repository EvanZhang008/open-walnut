/**
 * A locked section that writes session rows by id AND rows of the store's other tables (a host
 * channel batch: its position, turn ends, hand-over marks) patches the session snapshot; it does
 * not drop it. The guard counted every row the connection changed (total_changes), so the
 * channel's own position row read as a session row nobody named and every batch dropped the
 * snapshot: 1,314 full scans of 7.4k rows in 21 minutes on the live server (2026-11-23,
 * 147 s of its loop, about one a second). A session row that changes with no writer naming it is
 * patched too: SQLite records every row the connection changes (session-db.ts takeChangedSessionRows).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-store-host-batch'))

import { _resetSessionTrackerForTesting, _sessionStoreStatsForTesting, createSessionRecord, getSessionByClaudeId, listSessions, updateSessionRecord } from '../../src/core/session-tracker.js'
import { applyHanded } from '../helpers/handed-rows.js'
import { closeDb, getDb } from '../../src/core/session-db.js'
import { writeHandOverMark } from '../../src/core/session-channel/handover-marks.js'
import { WALNUT_HOME } from '../../src/constants.js'
import type { SessionRecord } from '../../src/core/types.js'

const HOST = 'devbox'
const scans = () => _sessionStoreStatsForTesting().fullScans
const born = (sid: string, extra: Partial<SessionRecord> = {}): Record<string, unknown> => ({
  claudeSessionId: sid, taskId: '', project: 'p', process_status: 'running', mode: 'default', host: HOST, judge: 'host',
  startedAt: '2026-11-22T00:00:00.000Z', lastActiveAt: '2026-11-22T00:00:00.000Z', messageCount: 0, title: 'From host',
  statusRevision: 1, statusUpdatedAt: '2026-11-22T00:00:00.000Z', ...extra,
})

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => { closeDb(); _resetSessionTrackerForTesting() })

describe('the session snapshot across a host channel batch', () => {
  it('a batch that writes rows and the channel position patches the snapshot, no rescan', async () => {
    await applyHanded({ hostId: HOST, rows: [{ sid: 'p1', born: true, patch: born('p1'), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 }, check: ['p1'] })
    await createSessionRecord('local-1', '', 'p', '/w')
    await listSessions()
    const before = scans()
    for (let i = 2; i <= 6; i++) {
      await applyHanded({ hostId: HOST, rows: [{ sid: 'p1', born: false, patch: { messageCount: i }, seq: i }], renames: [], cursor: { logId: 'L1', seq: i }, check: ['p1'] })
      expect((await listSessions()).find((s) => s.claudeSessionId === 'p1')?.messageCount).toBe(i)
    }
    expect(scans()).toBe(before)
  })

  it('a batch with two changes of one session patches it once, no rescan', async () => {
    // The live server's 50 scans after a start (2026-11-25): one row written twice read as a row nobody named.
    await applyHanded({ hostId: HOST, rows: [{ sid: 'p1', born: true, patch: born('p1'), seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 }, check: ['p1'] })
    await listSessions()
    const before = scans()
    await applyHanded({ hostId: HOST, rows: [
      { sid: 'p1', patch: { process_status: 'idle' }, seq: 2 },
      { sid: 'p1', patch: { messageCount: 7 }, seq: 3 },
    ], renames: [], cursor: { logId: 'L1', seq: 3 } })
    expect((await listSessions()).find((s) => s.claudeSessionId === 'p1')).toMatchObject({ process_status: 'idle', messageCount: 7 })
    expect(scans()).toBe(before)
    expect(_sessionStoreStatsForTesting().dropUnnamed).toBe(0)
  })

  it('a batch that also ends a hand-over (another table) still patches', async () => {
    await createSessionRecord('h1', '', 'p', '/w', { host: HOST, judge: 'host' } as never)
    await listSessions()
    const before = scans()
    writeHandOverMark({ sid: 'h1', host: HOST, kind: 'resume', since: 1 })
    await applyHanded({ hostId: HOST, rows: [{ sid: 'h1', patch: { messageCount: 3 }, seq: 1 }], renames: [], cursor: { logId: 'L1', seq: 1 } })
    expect((await listSessions()).find((s) => s.claudeSessionId === 'h1')?.messageCount).toBe(3)
    expect(scans()).toBe(before)
  })

  it('a session row changed that no writer named is patched in, read as stored, with no rescan', async () => {
    await createSessionRecord('a1', '', 'p', '/w')
    await createSessionRecord('a2', '', 'p', '/w')
    await listSessions()
    const before = scans()
    // A section that names a1, while a2 changes on the same connection with no note.
    const db = getDb()!
    const original = db.prepare.bind(db)
    let sneaked = false
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const stmt = original(sql)
      if (!sneaked && /INSERT OR REPLACE INTO sessions|UPDATE sessions/.test(sql)) {
        sneaked = true
        original("UPDATE sessions SET title = 'changed behind the notes' WHERE claude_session_id = 'a2'").run()
      }
      return stmt
    }) as typeof db.prepare)
    try { await updateSessionRecord('a1', { title: 'named' }) } finally { spy.mockRestore() }
    expect(sneaked).toBe(true)
    const rows = await listSessions()
    expect(rows.find((s) => s.claudeSessionId === 'a2')?.title).toBe('changed behind the notes')
    expect(scans()).toBe(before)
    expect((await getSessionByClaudeId('a1'))?.title).toBe('named')
  })
})

describe('trigger bodies stay readable by every SQLite Walnut runs on', () => {
  // SQLite before 3.53 (the macOS system library, WALNUT_SQLITE_LIBRARY=system) refuses a
  // schema-qualified table inside a trigger body, and the store whose open made it would not open.
  it('no trigger in src/ names a schema inside its body', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const bad: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(e.name)) continue
        const text = fs.readFileSync(p, 'utf8')
        for (const m of text.matchAll(/CREATE\s+(?:TEMP\s+)?TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*?)\bEND\b/gi)) {
          if (/\b(?:UPDATE|INSERT\s+(?:OR\s+\w+\s+)?INTO|DELETE\s+FROM)\s+(?:temp|main)\./i.test(m[1]!)) bad.push(p)
        }
      }
    }
    walk(path.resolve(__dirname, '../../src'))
    expect(bad).toEqual([])
  })
})
