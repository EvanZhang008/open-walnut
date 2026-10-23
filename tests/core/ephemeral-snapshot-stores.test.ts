/**
 * `dev:ephemeral` must carry today's tasks and sessions. The copy filter skips
 * every SQLite file, so the snapshot used to boot on a months-old tasks.json with
 * no sessions at all, and every "real density" check on it proved nothing. The
 * stores are now copied with VACUUM INTO over a read-only connection: rows still
 * in the WAL ride along, and the live file is never written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database, { type Database as DatabaseType } from '../../src/lib/sqlite.js'
import { copyDataSnapshot, snapshotStoreDatabases } from '../../src/commands/ephemeral-snapshot.js'

let root: string
let home: string
let dest: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-snapshot-stores-'))
  home = path.join(root, 'home')
  dest = path.join(root, 'snapshot')
  fs.mkdirSync(path.join(home, 'tasks'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** A live WAL store holding rows that have not been checkpointed yet. */
function liveStore(rel: string, rows: string[]): DatabaseType {
  const db = new Database(path.join(home, rel))
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
  const put = db.prepare('INSERT INTO t (id) VALUES (?)')
  for (const r of rows) put.run(r)
  return db
}

function ids(file: string): string[] {
  const db = new Database(file, { readonly: true })
  try { return (db.prepare('SELECT id FROM t ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id) } finally { db.close() }
}

describe('ephemeral snapshot stores', () => {
  it('copies the task and session stores, WAL rows included, while the owner still holds them open', () => {
    const tasks = liveStore(path.join('tasks', 'tasks.sqlite'), ['task-a', 'task-b'])
    const sessions = liveStore('sessions.sqlite', ['sess-1'])
    expect(fs.statSync(path.join(home, 'sessions.sqlite-wal')).size).toBeGreaterThan(0)
    const liveBefore = fs.statSync(path.join(home, 'tasks', 'tasks.sqlite')).mtimeMs

    copyDataSnapshot(home, dest)

    expect(ids(path.join(dest, 'tasks', 'tasks.sqlite'))).toEqual(['task-a', 'task-b'])
    expect(ids(path.join(dest, 'sessions.sqlite'))).toEqual(['sess-1'])
    // One self-contained file each: no WAL or shm sidecar copied beside it.
    expect(fs.existsSync(path.join(dest, 'sessions.sqlite-wal'))).toBe(false)
    // The owner keeps writing to its own file, unaffected.
    tasks.prepare('INSERT INTO t (id) VALUES (?)').run('task-c')
    expect(fs.statSync(path.join(home, 'tasks', 'tasks.sqlite')).mtimeMs).toBe(liveBefore)
    tasks.close()
    sessions.close()
  })

  it('leaves out indexes and private stores, and skips a store that is missing', () => {
    liveStore('search.sqlite', ['x']).close()
    liveStore('notes-index.sqlite', ['x']).close()

    copyDataSnapshot(home, dest)

    expect(fs.existsSync(path.join(dest, 'search.sqlite'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'notes-index.sqlite'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'sessions.sqlite'))).toBe(false)
  })

  it('a store that cannot be read is left out, and the rest still copies', () => {
    fs.writeFileSync(path.join(home, 'sessions.sqlite'), 'not a database')
    liveStore(path.join('tasks', 'tasks.sqlite'), ['task-a']).close()
    fs.mkdirSync(dest, { recursive: true })

    const copied = snapshotStoreDatabases(home, dest)

    expect(copied).toEqual([path.join('tasks', 'tasks.sqlite')])
    expect(fs.existsSync(path.join(dest, 'sessions.sqlite'))).toBe(false)
  })
})
