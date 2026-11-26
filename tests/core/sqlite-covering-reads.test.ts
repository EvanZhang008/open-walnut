/**
 * The reads that held the server's loop in a day's stalls (2026-11-24/25: 670 stall windows,
 * every statement below at 40 to 750 ms a call on the Mac) read from an index, never the table.
 *
 * Each family read a column that sits after a big one in its row (a note's body, a search doc's
 * note, a session's JSON payload), so SQLite walked every big value to reach it, or parsed every
 * session payload with json_extract. The fix is an index per family (created on open, so a file an
 * older build wrote gets it, and an older build keeps it up to date on its own writes). This file
 * runs each read the server runs, catches the SQL it prepares, and checks SQLite's plan for it: a
 * SCAN of the table or a lookup through the table's rowid is the old cost back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database, { type Database as DatabaseType } from '../../src/lib/sqlite.js'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-covering-reads'))
vi.mock('../../src/utils/session-liveness.js', () => ({ isSessionProcessAlive: async () => true }))

import { WALNUT_HOME } from '../../src/constants.js'
import { closeDb, getDb } from '../../src/core/session-db.js'
import {
  _resetSessionTrackerForTesting,
  getSessionByLane,
  listChatLaneSessions,
  listPendingSessionStops,
  listSessionsByLane,
  listTaskCompleteStops,
} from '../../src/core/session-tracker.js'
import { closeNotesIndexDb, getNotesIndexDb, listNotes, listNoteSyncMeta, upsertNote } from '../../src/core/notes-index.js'
import { createSearchIndex, docStampsOfKind, type SearchIndex } from '../../src/lib/hybrid-search/index.js'
import { docCards } from '../../src/lib/hybrid-search/db.js'
import { createWriter } from '../../src/lib/hybrid-search/writer.js'
import { replicaStates, replicaStatesOf } from '../../src/lib/hybrid-search/replica.js'
import { UsageTracker } from '../../src/core/usage/tracker.js'
import { buildLateIndexesNow } from '../../src/lib/sqlite-late-index.js'

/** Run `fn` and give back each SQL it prepared on `db` with SQLite's plan for it. */
function plansOf(db: DatabaseType, fn: () => unknown): Promise<Array<{ sql: string; plan: string }>> {
  const seen: string[] = []
  const prepare = db.prepare.bind(db)
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => { seen.push(sql); return prepare(sql) }) as typeof db.prepare)
  return Promise.resolve(fn()).then(() => {
    spy.mockRestore()
    return seen.filter((sql) => /^\s*SELECT/i.test(sql)).map((sql) => ({
      sql: sql.replace(/\s+/g, ' ').trim(),
      plan: (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | '),
    }))
  })
}

async function wipeHome(): Promise<void> {
  closeDb()
  closeNotesIndexDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
}

beforeEach(wipeHome)
afterEach(async () => {
  await wipeHome()
  vi.restoreAllMocks()
})

describe('sessions: the reads by a payload field use its index', () => {
  /** Rows as every writer leaves them, a malformed payload, a NULL one and upper-case look-alikes too. */
  function seed(db: DatabaseType): void {
    const insert = db.prepare('INSERT INTO sessions (claude_session_id, host, started_at, archived, payload) VALUES (?, ?, ?, ?, ?)')
    const rows: Array<[string, string | null, string, number, string | null]> = [
      ['s-chat-1', null, '2026-11-01', 0, JSON.stringify({ lane: 'chat:general:c1', stopRequest: { id: 'r1', state: 'pending' } })],
      ['s-chat-1-old', null, '2026-10-01', 1, JSON.stringify({ lane: 'chat:general:c1' })],
      ['s-chat-2', 'box', '2026-11-02', 0, JSON.stringify({ lane: 'chat:research:c2', taskCompleteStop: { at: '2026-11-02', state: 'undelivered' } })],
      ['s-side', 'box', '2026-11-03', 0, JSON.stringify({ lane: 'side:p:t', stopRequest: { id: 'r2', state: 'pending' } })],
      ['s-upper', null, '2026-11-04', 0, JSON.stringify({ lane: 'Chat:x', stopRequest: { id: 'r3', state: 'confirmed' } })],
      ['s-turn-end', null, '2026-11-05', 0, JSON.stringify({ taskCompleteStop: { at: '2026-11-05', state: 'turn_end' } })],
      ['s-broken', null, '2026-11-06', 0, '{"lane": "chat:general:c1", "stopRequest": {'],
      ['s-null', null, '2026-11-07', 0, null],
    ]
    for (const r of rows) insert.run(...r)
  }

  it('finds the same sessions as before, without parsing every payload', async () => {
    const db = getDb()!
    seed(db)
    const plans = await plansOf(db, async () => {
      expect((await listPendingSessionStops()).map((s) => s.claudeSessionId).sort()).toEqual(['s-chat-1', 's-side'])
      expect((await listPendingSessionStops('__local__')).map((s) => s.claudeSessionId)).toEqual(['s-chat-1'])
      expect((await listPendingSessionStops('box')).map((s) => s.claudeSessionId)).toEqual(['s-side'])
      expect((await listTaskCompleteStops({ state: 'turn_end' })).map((s) => s.claudeSessionId)).toEqual(['s-turn-end'])
      expect((await listTaskCompleteStops({ state: 'undelivered', host: 'box' })).map((s) => s.claudeSessionId)).toEqual(['s-chat-2'])
      expect((await getSessionByLane('chat:general:c1'))?.claudeSessionId).toBe('s-chat-1')
      expect((await listSessionsByLane('chat:general:c1')).map((s) => s.claudeSessionId)).toEqual(['s-chat-1-old', 's-chat-1'])
      // LIKE folds case: 'Chat:x' still counts, as it always did.
      expect((await listChatLaneSessions()).map((s) => s.claudeSessionId)).toEqual(['s-chat-1-old', 's-chat-1', 's-chat-2', 's-upper'])
    })
    const payloadReads = plans.filter((p) => p.sql.includes('json_extract(payload'))
    expect(payloadReads.length).toBeGreaterThanOrEqual(5)
    for (const p of payloadReads) {
      expect(p.plan, p.sql).toMatch(/USING INDEX sessions_payload_/)
      expect(p.plan, p.sql).not.toMatch(/SCAN sessions/)
    }
  })

  it('still takes a malformed payload: the indexes never raise on a write', () => {
    const db = getDb()!
    db.prepare('INSERT INTO sessions (claude_session_id, payload) VALUES (?, ?)').run('s-bad', '{not json')
    db.prepare('UPDATE sessions SET payload = ? WHERE claude_session_id = ?').run('{"lane": 1', 's-bad')
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  })
})

describe('notes index: the whole-table lists read an index, not the bodies', () => {
  it('lists every note the same, from a covering index', async () => {
    const db = getNotesIndexDb()!
    const notes = [
      { id: 'n2', path: 'b/beta.md', title: 'beta', frontmatter: 'walnut_locked: true\n', body: 'x'.repeat(20_000) },
      { id: 'n1', path: 'a/Alpha.md', title: 'Alpha', frontmatter: null, body: 'y'.repeat(20_000) },
      { id: 'n3', path: 'c/gamma.md', title: 'Gamma', frontmatter: 'tags: [a]\n', body: 'z' },
    ]
    for (const n of notes) upsertNote({ ...n, content_hash: `h-${n.id}`, created: null, modified: '2026-11-25T00:00:00Z', size: n.body.length, headings: '' }, [], [])
    const plans = await plansOf(db, () => {
      expect(listNoteSyncMeta().sort((x, y) => x.path.localeCompare(y.path))).toEqual([
        { path: 'a/Alpha.md', modified: '2026-11-25T00:00:00Z', size: 20_000 },
        { path: 'b/beta.md', modified: '2026-11-25T00:00:00Z', size: 20_000 },
        { path: 'c/gamma.md', modified: '2026-11-25T00:00:00Z', size: 1 },
      ])
      expect(listNotes().map((r) => r.id)).toEqual(['n1', 'n2', 'n3'])
    })
    expect(plans).toHaveLength(2)
    for (const p of plans) expect(p.plan, p.sql).toMatch(/USING COVERING INDEX idx_notes_(sync|list)/)
  })
})

describe('search index: the reads of short columns never walk a body', () => {
  let index: SearchIndex | null = null
  afterEach(() => { index?.close(); index = null })

  it('reads states, cards and stamps from covering indexes', async () => {
    index = createSearchIndex({ dbPath: ':memory:' })
    for (let i = 0; i < 30; i++) {
      index.upsert({ kind: i % 2 ? 'note' : 'task', ref: `r${i}`, title: `title ${i}`, summary: i % 3 ? 'has a summary' : '', note: 'body '.repeat(2_000), updatedAt: 1_700_000_000_000 + i })
    }
    const db = index.db
    const ids = (db.prepare('SELECT id FROM doc ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)
    const plans = await plansOf(db, () => {
      expect(replicaStates(db, 0, 64).map((r) => r.id)).toEqual(ids)
      expect(replicaStatesOf(db, ids.slice(0, 5)).map((r) => r.ref).sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
      const cards = docCards(db, [ids[1], ids[3], 999_999])
      expect(cards.map((c) => [c.ref, c.title, c.has_summary])).toEqual([['r1', 'title 1', 1], ['r3', 'title 3', 0]])
      expect(cards[0].updated_at).toBe(1_700_000_000_001)
      expect(docStampsOfKind(db, 'note').get('r5')).toBe(1_700_000_000_005)
    })
    const docReads = plans.filter((p) => !p.sql.includes('sqlite_master'))
    expect(docReads).toHaveLength(4)
    for (const p of docReads) expect(p.plan, p.sql).toMatch(/^SEARCH (doc|d) USING COVERING INDEX (doc_head|doc_kind_ref_updated)/)
  })
})

describe('search index: the vector state reads never read a vector', () => {
  // A doc_vec row is a 1 KB blob, past what a 4 KB page keeps in place, so reading one row's
  // vector (the zero-marker test) or even its key through the primary key costs an overflow page:
  // the backfill probe of 128 docs read 262 pages, a 500-doc replica state slice 2,769 (2026-11-25).
  let index: SearchIndex | null = null
  afterEach(() => { index?.close(); index = null })

  /** Four docs: complete vectors, the zero marker only, a partial set (no seq 0), none. */
  function seed(target: SearchIndex): Record<string, number> {
    const writer = createWriter(target.db)
    const ids: Record<string, number> = {}
    for (const [i, ref] of ['full', 'zero', 'partial', 'none'].entries()) {
      ids[ref] = target.upsert({ kind: 'note', ref, title: ref, note: 'body', updatedAt: 1_700_000_000_000 + i }).docId
    }
    writer.writeVectors(ids.full, [new Int8Array([1, 2, 3, 4]), new Int8Array([5, 6, 7, 8])])
    writer.writeVectors(ids.zero, [new Int8Array(4)])
    writer.writeVectorsResumable(ids.partial, new Map([[1, new Int8Array([1, 1, 1, 1])]]), 3)
    return ids
  }

  /** The reads under test; the writer is made before plansOf so its own statements are not counted. */
  function read(db: DatabaseType, ids: Record<string, number>, writer: ReturnType<typeof createWriter>): void {
    const refs = (page: { docs: Array<{ ref: string; zeroMarker?: boolean }> }) => page.docs.map((d) => `${d.ref}${d.zeroMarker ? ':zero' : ''}`).sort()
    expect(refs(writer.listDocsMissingVectors(10, null))).toEqual(['none', 'partial'])
    expect(refs(writer.listDocsMissingVectors(10, null, undefined, { retryZero: () => true }))).toEqual(['none', 'partial', 'zero:zero'])
    const states = Object.fromEntries(replicaStates(db, 0, 64).map((r) => [r.ref, r.vec]))
    expect(states).toEqual({ full: 'v', zero: 'z', partial: 'n', none: 'n' })
    expect(replicaStatesOf(db, [ids.zero, ids.full]).map((r) => r.vec).sort()).toEqual(['v', 'z'])
  }

  it('answers the backfill probe and replica states from the doc_vec partial indexes', async () => {
    index = createSearchIndex({ dbPath: ':memory:' })
    const ids = seed(index)
    const writer = createWriter(index.db)
    const plans = await plansOf(index.db, () => read(index!.db, ids, writer))
    const vecReads = plans.filter((p) => p.sql.includes('doc_vec'))
    expect(vecReads.length).toBeGreaterThanOrEqual(4)
    for (const p of vecReads) {
      // Presence from doc_vec_seq0 alone (covering), markers from doc_vec_zero (it holds only them):
      // any other way in reads a 1 KB row per doc.
      expect(p.plan, p.sql).toMatch(/USING COVERING INDEX doc_vec_seq0|USING INDEX doc_vec_zero/)
      expect(p.plan, p.sql).not.toMatch(/USING PRIMARY KEY|USING INDEX doc_vec_seq0/)
    }
  })

  it('reads the same on a file without them (INDEXED BY waits), then through them', async () => {
    const file = path.join(WALNUT_HOME, 'search.sqlite')
    const first = createSearchIndex({ dbPath: file })
    const ids = seed(first)
    first.db.exec('DROP INDEX doc_vec_seq0; DROP INDEX doc_vec_zero')
    first.close()
    index = createSearchIndex({ dbPath: file })
    const writer = createWriter(index.db)
    const before = await plansOf(index.db, () => read(index!.db, ids, writer))
    for (const p of before) expect(p.sql).not.toMatch(/INDEXED BY doc_vec/)
    expect(await buildLateIndexesNow()).toEqual(['doc_vec_seq0', 'doc_vec_zero'])
    const after = await plansOf(index.db, () => read(index!.db, ids, writer))
    for (const p of after.filter((x) => x.sql.includes('doc_vec'))) expect(p.plan, p.sql).toMatch(/INDEX doc_vec_(seq0|zero)/)
  })
})

describe('usage ledger: the turn-time reads use a covering index', () => {
  it('sums the same turns without reading the table', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cover-'))
    const tracker = new UsageTracker(path.join(dir, 'usage.sqlite'))
    try {
      tracker.record({ source: 'session', model: 'claude-sonnet-4-5', taskId: 't1', sessionId: 's1', duration_ms: 1_000 })
      tracker.record({ source: 'chat', model: 'claude-sonnet-4-5', sessionId: 's2', duration_ms: 500 })
      tracker.record({ source: 'agent', model: 'claude-sonnet-4-5', taskId: 't1', duration_ms: 9_000 })
      const db = (tracker as unknown as { getDb(): DatabaseType }).getDb()
      const today = new Date().toISOString().slice(0, 10)
      const plans = await plansOf(db, () => {
        expect(tracker.getTurnDurationsByDay(today)).toEqual([
          { date: today, taskId: '', durationMs: 500, turns: 1 },
          { date: today, taskId: 't1', durationMs: 1_000, turns: 1 },
        ])
        expect(tracker.getTurnDurationsBySession('9999-01-01').sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
          { date: today, taskId: 't1', sessionId: 's1', durationMs: 1_000 },
          { date: today, taskId: '', sessionId: 's2', durationMs: 500 },
        ])
      })
      expect(plans).toHaveLength(2)
      for (const p of plans) expect(p.plan, p.sql).toMatch(/USING COVERING INDEX idx_usage_turn_time/)
    } finally {
      tracker.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a file an older build wrote', () => {
  // Building an index over a table that has rows reads all of them (305 MB, 22 s cold on the
  // Mac's search index), so such a file gets it on a worker after the open, never in it.
  it('opens without building, reads the same meanwhile, then reads from the index', async () => {
    // An older build's notes index: the table and its first two indexes only.
    const file = path.join(WALNUT_HOME, 'notes-index.sqlite')
    const old = new Database(file)
    old.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content_hash TEXT NOT NULL,
      body TEXT NOT NULL, frontmatter TEXT, created TEXT, modified TEXT NOT NULL, size INTEGER NOT NULL, headings TEXT NOT NULL DEFAULT '');
      CREATE INDEX idx_notes_path ON notes(path); CREATE INDEX idx_notes_title ON notes(title COLLATE NOCASE);
      INSERT INTO notes VALUES ('n1', 'a.md', 'A', 'h', 'body', NULL, NULL, '2026-01-01', 4, '');`)
    old.close()
    const db = getNotesIndexDb()!
    const names = () => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes'`).all() as Array<{ name: string }>).map((r) => r.name)
    expect(names()).not.toContain('idx_notes_sync')
    const before = await plansOf(db, () => expect(listNoteSyncMeta()).toEqual([{ path: 'a.md', modified: '2026-01-01', size: 4 }]))
    expect(before[0].plan).toMatch(/SCAN notes/)
    expect(await buildLateIndexesNow()).toEqual(['idx_notes_sync', 'idx_notes_list'])
    expect(names()).toEqual(expect.arrayContaining(['idx_notes_sync', 'idx_notes_list']))
    const after = await plansOf(db, () => expect(listNoteSyncMeta()).toEqual([{ path: 'a.md', modified: '2026-01-01', size: 4 }]))
    expect(after[0].plan).toMatch(/USING COVERING INDEX idx_notes_sync/)
    closeNotesIndexDb()
    // The older build's own write, beside indexes it does not know.
    const again = new Database(file)
    again.prepare(`INSERT INTO notes (id, path, title, content_hash, body, modified, size) VALUES ('n2', 'b.md', 'B', 'h', 'b', '2026-01-02', 1)`).run()
    expect(again.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    again.close()
    expect(listNoteSyncMeta().map((r) => r.path).sort()).toEqual(['a.md', 'b.md'])
  })

  it('reads search cards and states without doc_head (INDEXED BY waits for it), then through it', async () => {
    const file = path.join(WALNUT_HOME, 'search.sqlite')
    const first = createSearchIndex({ dbPath: file })
    for (let i = 0; i < 5; i++) first.upsert({ kind: 'task', ref: `r${i}`, title: `title ${i}`, note: 'body', updatedAt: 1_700_000_000_000 + i })
    // As an older build left it: no doc_head, no doc_kind_ref_updated.
    first.db.exec('DROP INDEX doc_head; DROP INDEX doc_kind_ref_updated')
    first.close()
    const index = createSearchIndex({ dbPath: file })
    try {
      const db = index.db
      const ids = (db.prepare('SELECT id FROM doc ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)
      const read = () => {
        expect(docCards(db, ids.slice(0, 2)).map((c) => c.ref)).toEqual(['r0', 'r1'])
        expect(replicaStates(db, 0, 64)).toHaveLength(5)
        expect(replicaStatesOf(db, [ids[4]]).map((r) => r.ref)).toEqual(['r4'])
      }
      const before = await plansOf(db, read)
      for (const p of before) expect(p.sql).not.toMatch(/INDEXED BY doc_head/)
      expect(await buildLateIndexesNow()).toEqual(['doc_head', 'doc_kind_ref_updated'])
      const after = await plansOf(db, read)
      for (const p of after.filter((x) => x.sql.includes('FROM doc'))) expect(p.plan, p.sql).toMatch(/USING COVERING INDEX doc_head/)
    } finally {
      index.close()
    }
  })
})
