/**
 * The SQLite contract (src/lib/sqlite.ts): the better-sqlite3 API the code was
 * written against, over bun:sqlite, behaving as the code relies on.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database, {
  builtSqliteLibrary, sqliteLibrary, sqliteLibraryProblem, sqliteModuleFile, type Database as DatabaseType,
} from '../../src/lib/sqlite.js'
import { DYLIB, SQLITE_VERSION, stampIsCurrent } from '../../scripts/build-sqlite-dylib.mjs'

let dir: string
let db: DatabaseType

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sqlite-'))
  db = new Database(path.join(dir, 'a.db'))
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, b BLOB); CREATE TABLE u (x)')
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('sqlite on bun', () => {
  it('runs, reads a row, a missing row is undefined, and a BLOB is a Buffer', () => {
    const res = db.prepare('INSERT INTO t (name, b) VALUES (?, ?)').run('a', Buffer.from('hi'))
    expect(res).toMatchObject({ changes: 1 })
    expect(Number(res.lastInsertRowid)).toBe(1)
    const row = db.prepare('SELECT * FROM t WHERE id = ?').get(1) as { name: string; b: Buffer }
    expect(row.name).toBe('a')
    expect(Buffer.isBuffer(row.b)).toBe(true)
    expect(row.b.toString('utf8')).toBe('hi')
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get(99)).toBeUndefined()
  })

  it('binds named parameters from an object without their prefix, and positional ones from an array', () => {
    db.prepare('INSERT INTO t (name) VALUES (@name)').run({ name: 'x' })
    db.prepare('INSERT INTO t (name) VALUES ($name)').run({ name: 'y' })
    db.prepare('INSERT INTO t (name) VALUES (:name)').run({ name: 'z' })
    db.prepare('INSERT INTO t (name) VALUES (?)').run(['w'])
    expect(db.prepare('SELECT name FROM t ORDER BY id').pluck().all()).toEqual(['x', 'y', 'z', 'w'])
    expect(db.prepare('SELECT count(*) FROM t WHERE name IN (?, ?)').pluck().get('x', 'w')).toBe(2)
  })

  it('pluck, raw, iterate and the statement facts', () => {
    db.prepare('INSERT INTO t (name) VALUES (?)').run('a')
    db.prepare('INSERT INTO t (name) VALUES (?)').run('b')
    expect(db.prepare('SELECT id, name FROM t ORDER BY id').raw().all()).toEqual([[1, 'a'], [2, 'b']])
    expect(db.prepare('SELECT name FROM t ORDER BY id').pluck().get()).toBe('a')
    expect(db.prepare('SELECT name FROM t WHERE id = 9').pluck().get()).toBeUndefined()
    expect([...db.prepare('SELECT id FROM t ORDER BY id').iterate()]).toEqual([{ id: 1 }, { id: 2 }])
    const select = db.prepare('SELECT 1 AS v')
    expect(select.reader).toBe(true)
    expect(select.source).toBe('SELECT 1 AS v')
    expect(db.prepare('DELETE FROM t WHERE id = 9').reader).toBe(false)
  })

  it('pragma: rows, or the first value with simple; the busy timeout defaults to 5 s', () => {
    expect(db.pragma('journal_mode = WAL')).toEqual([{ journal_mode: 'wal' }])
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    const quick = new Database(path.join(dir, 'b.db'), { timeout: 250 })
    expect(quick.pragma('busy_timeout', { simple: true })).toBe(250)
    quick.close()
  })

  it('foreign keys are on and the page cache is 16 MB, as better-sqlite3 compiles its SQLite', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('cache_size', { simple: true })).toBe(-16000)
    db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id) ON DELETE CASCADE)')
    db.exec('INSERT INTO p VALUES (1); INSERT INTO c VALUES (1)')
    db.exec('DELETE FROM p')
    expect(db.prepare('SELECT count(*) FROM c').pluck().get()).toBe(0)
    expect(() => db.exec('INSERT INTO c VALUES (2)')).toThrow()
  })

  it('a database whose file is deleted while open keeps answering, as better-sqlite3 does', () => {
    const sub = path.join(dir, 'gone')
    fs.mkdirSync(sub)
    const g = new Database(path.join(sub, 'g.db'))
    g.pragma('journal_mode = WAL')
    g.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)')
    fs.rmSync(sub, { recursive: true, force: true })
    fs.mkdirSync(sub)
    // The macOS system SQLite answers SQLITE_IOERR_VNODE here (src/lib/sqlite.ts).
    expect(() => g.prepare('INSERT INTO t VALUES (2)').run(), `SQLite library: ${sqliteLibrary()}`).not.toThrow()
    expect(g.prepare('SELECT count(*) FROM t').pluck().get()).toBe(2)
    g.close()
  })

  it('names the SQLite it runs on', () => {
    if (process.platform !== 'darwin') expect(sqliteLibrary()).toBe('bun')
    else if (process.env.WALNUT_SQLITE_LIBRARY === 'system') expect(sqliteLibrary()).toBe('system')
    else expect(sqliteLibrary()).toBe(process.env.WALNUT_SQLITE_LIBRARY || builtSqliteLibrary())
  })

  it('a transaction commits, rolls back on a throw, nests, and has its modes', () => {
    const add = db.transaction((x: number) => { db.prepare('INSERT INTO u VALUES (?)').run(x) })
    add(1)
    expect(() => db.transaction(() => { db.prepare('INSERT INTO u VALUES (2)').run(); throw new Error('boom') })()).toThrow('boom')
    const outer = db.transaction(() => {
      db.prepare('INSERT INTO u VALUES (3)').run()
      try { db.transaction(() => { db.prepare('INSERT INTO u VALUES (4)').run(); throw new Error('inner') })() } catch { /* the inner one rolls back alone */ }
      return db.inTransaction
    })
    expect(outer()).toBe(true)
    expect(db.inTransaction).toBe(false)
    expect(db.prepare('SELECT x FROM u ORDER BY x').pluck().all()).toEqual([1, 3])
    expect(typeof add.immediate).toBe('function')
    add.immediate(5)
    expect(db.prepare('SELECT count(*) FROM u').pluck().get()).toBe(3)
  })

  it('a constraint failure carries the SQLite code', () => {
    db.prepare('INSERT INTO t (name) VALUES (?)').run('a')
    let code: unknown
    try { db.prepare('INSERT INTO t (name) VALUES (?)').run('a') } catch (err) { code = (err as { code?: unknown }).code }
    expect(code).toBe('SQLITE_CONSTRAINT_UNIQUE')
  })

  it('opens read-only, refuses a missing file when it must exist, and reports itself', () => {
    db.prepare('INSERT INTO t (name) VALUES (?)').run('a')
    const ro = new Database(path.join(dir, 'a.db'), { readonly: true, fileMustExist: true })
    expect(ro.readonly).toBe(true)
    expect(ro.prepare('SELECT name FROM t').pluck().get()).toBe('a')
    expect(() => ro.prepare('INSERT INTO t (name) VALUES (?)').run('b')).toThrow()
    ro.close()
    expect(ro.open).toBe(false)
    expect(() => new Database(path.join(dir, 'missing.db'), { fileMustExist: true })).toThrow()
    expect(() => new Database(path.join(dir, 'missing.db'), { readonly: true })).toThrow()
    expect(fs.existsSync(path.join(dir, 'missing.db'))).toBe(false)
    expect(db.name).toBe(path.join(dir, 'a.db'))
    expect(db.open).toBe(true)
    const mem = new Database(':memory:')
    expect(mem.memory).toBe(true)
    mem.close()
  })

  it('backup writes a consistent copy over an older database, from a read-only connection too', async () => {
    db.pragma('journal_mode = WAL')
    db.prepare('INSERT INTO t (name) VALUES (?)').run('a')
    const dest = path.join(dir, 'snap', 'copy.db')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const stale = new Database(dest)
    stale.exec('CREATE TABLE stale (x); INSERT INTO stale VALUES (1)')
    stale.close()
    const ro = new Database(path.join(dir, 'a.db'), { readonly: true, fileMustExist: true })
    await ro.backup(dest)
    ro.close()
    const copy = new Database(dest, { readonly: true })
    expect(copy.prepare('SELECT name FROM t').pluck().all()).toEqual(['a'])
    expect(copy.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'stale'").pluck().get()).toBe(0)
    copy.close()
    // No temp file left beside it (a WAL-mode copy may carry its -wal/-shm once opened).
    expect(fs.readdirSync(path.dirname(dest)).filter((f) => !/-(wal|shm)$/.test(f))).toEqual(['copy.db'])
  })

  it('serialize gives the database bytes as a Buffer', () => {
    db.prepare('INSERT INTO t (name) VALUES (?)').run('a')
    const bytes = db.serialize()
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3')
  })

  it('stores and reads non-ASCII text and large integers as better-sqlite3 does', () => {
    // Latin accent, CJK and an astral-plane emoji.
    const text = 'caf\u00e9 \u4efb\u52a1 \u{1F330}'
    db.prepare('INSERT INTO t (name) VALUES (?)').run(text)
    expect(db.prepare('SELECT name FROM t').pluck().get()).toBe(text)
    expect(db.prepare('SELECT 4102444800000 AS v').pluck().get()).toBe(4102444800000)
  })

  it('close releases the database at once, with statements still alive: the WAL is merged and a statement then throws', () => {
    const file = path.join(dir, 'c.db')
    const c = new Database(file)
    c.pragma('journal_mode = WAL')
    c.exec('CREATE TABLE t (x)')
    const insert = c.prepare('INSERT INTO t VALUES (?)')
    insert.run(1)
    c.transaction(() => { insert.run(2) }).immediate()
    const select = c.prepare('SELECT x FROM t')
    expect(select.all()).toEqual([{ x: 1 }, { x: 2 }])
    expect(fs.existsSync(`${file}-wal`)).toBe(true)
    c.close()
    expect(c.open).toBe(false)
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('c.db'))).toEqual(['c.db'])
    expect(() => insert.run(2)).toThrow('The database connection is not open')
    expect(() => select.get()).toThrow('The database connection is not open')
    expect(() => c.prepare('SELECT 1')).toThrow('The database connection is not open')
    expect(() => c.exec('SELECT 1')).toThrow('The database connection is not open')
    expect(() => c.close()).not.toThrow()
    const again = new Database(file, { readonly: true })
    // Read-only after the last writer closed, so with no -wal on disk.
    expect(again.prepare('SELECT x FROM t').pluck().all()).toEqual([1, 2])
    again.close()
  })
})

// Ratchet: on macOS, bun must never quietly run on the Apple system SQLite.
describe.runIf(process.platform === 'darwin')('the upstream SQLite macOS bun loads', () => {
  it('is built and current (scripts/build-sqlite-dylib.mjs, run by postinstall)', () => {
    expect(stampIsCurrent(), `run: bun scripts/build-sqlite-dylib.mjs (wants SQLite ${SQLITE_VERSION} at ${DYLIB})`).toBe(true)
    expect(builtSqliteLibrary()).toBe(DYLIB)
  })

  it.runIf(process.env.WALNUT_SQLITE_LIBRARY !== 'system')('is what this bun process runs on', () => {
    expect(sqliteLibraryProblem()).toBeNull()
    expect(db.prepare('SELECT sqlite_version()').pluck().get()).toBe(process.env.WALNUT_SQLITE_LIBRARY ? expect.any(String) : SQLITE_VERSION)
    const opts = db.prepare('SELECT compile_options FROM pragma_compile_options').pluck().all()
    expect(opts).toEqual(expect.arrayContaining(['DEFAULT_FOREIGN_KEYS', 'DEFAULT_CACHE_SIZE=-16000', 'DQS=0', 'ENABLE_FTS5']))
  })

  it('is found from a bundle that inlined src/lib/sqlite.ts, and null when it is not built', () => {
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sqlite-dylib-'))
    try {
      expect(builtSqliteLibrary(path.join(pkg, 'dist', 'web', 'server.js'))).toBeNull()
      const lib = path.join(pkg, 'vendor', 'sqlite', 'darwin', 'libsqlite3.dylib')
      fs.mkdirSync(path.dirname(lib), { recursive: true })
      fs.writeFileSync(lib, '')
      for (const bundle of ['dist/cli.js', 'dist/web/server.js', 'dist/integrations/mail/index.js', 'src/lib/sqlite.ts']) {
        expect(builtSqliteLibrary(path.join(pkg, bundle)), bundle).toBe(lib)
      }
    } finally {
      fs.rmSync(pkg, { recursive: true, force: true })
    }
  })
})

describe('sqliteModuleFile: the file a worker loads to get this module', () => {
  it('is this very file when unbundled', () => {
    expect(sqliteModuleFile()).toBe(path.resolve(import.meta.dirname, '../../src/lib/sqlite.ts'))
    expect(sqliteModuleFile('/x/src/lib/sqlite.ts')).toBe('/x/src/lib/sqlite.ts')
    expect(sqliteModuleFile('/x/dist/lib/sqlite.js')).toBe('/x/dist/lib/sqlite.js')
  })

  it('is dist/lib/sqlite.js from any bundle that inlined it, and null when the build has none', () => {
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sqlite-layout-'))
    try {
      const built = path.join(pkg, 'dist', 'lib', 'sqlite.js')
      for (const bundle of ['dist/cli.js', 'dist/web/server.js', 'dist/integrations/mail/index.js', '.plugin-cache/p-1.mjs']) {
        expect(sqliteModuleFile(path.join(pkg, bundle)), bundle).toBeNull()
      }
      fs.mkdirSync(path.dirname(built), { recursive: true })
      fs.writeFileSync(built, '')
      for (const bundle of ['dist/cli.js', 'dist/web/server.js', 'dist/integrations/mail/index.js', '.plugin-cache/p-1.mjs']) {
        expect(sqliteModuleFile(path.join(pkg, bundle)), bundle).toBe(built)
      }
    } finally {
      fs.rmSync(pkg, { recursive: true, force: true })
    }
  })
})

describe('a process on Node', () => {
  it('cannot open a database, and the first open says to run Walnut on bun', async () => {
    const bun = process.versions.bun
    vi.resetModules()
    delete (process.versions as { bun?: string }).bun
    try {
      const fresh = await import('../../src/lib/sqlite.js')
      expect(() => new fresh.default(':memory:')).toThrow(/Walnut runs on bun.*Run it with bun/)
      expect(() => fresh.sqliteLibrary()).toThrow(/Walnut runs on bun/)
    } finally {
      ;(process.versions as { bun?: string }).bun = bun
      vi.resetModules()
    }
  })
})
