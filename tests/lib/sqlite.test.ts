/**
 * The SQLite contract (src/lib/sqlite.ts): the better-sqlite3 API the code was
 * written against, over bun:sqlite, behaving as the code relies on.
 */
import { spawnSync } from 'node:child_process'
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

  it('a connection entering WAL mode syncs at checkpoints, as on better-sqlite3, unless it chose its own level', () => {
    // better-sqlite3 (and the built dylib) compile DEFAULT_WAL_SYNCHRONOUS=1; bun's own SQLite on Linux does not.
    // Read the level after a statement: the compiled-in default (the built dylib)
    // takes effect when the next transaction opens the WAL database, before that
    // transaction commits, so `PRAGMA synchronous` right after the switch still
    // says 2 there (2026-10-30, red on macOS since this test landed). The wrapper's
    // own NORMAL (bun's SQLite on Linux) is in place at once either way.
    expect(db.pragma('journal_mode = WAL', { simple: true })).toBe('wal')
    db.prepare('INSERT INTO t (name) VALUES (?)').run('wal')
    expect(db.pragma('synchronous', { simple: true })).toBe(1)
    const own = new Database(path.join(dir, 'own.db'))
    try {
      own.pragma('synchronous = FULL')
      expect(own.pragma('journal_mode = WAL')).toEqual([{ journal_mode: 'wal' }])
      own.prepare('SELECT count(*) FROM sqlite_master').get()
      expect(own.pragma('synchronous', { simple: true })).toBe(2)
    } finally {
      own.close()
    }
    // Rollback-journal mode keeps the library's own default (FULL on both).
    const plain = new Database(path.join(dir, 'plain.db'))
    try {
      expect(plain.pragma('synchronous', { simple: true })).toBe(2)
    } finally {
      plain.close()
    }
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

  it('backup copies a database file off the event loop, as better-sqlite3 did in steps', async () => {
    // VACUUM INTO is one call: on this thread a 750 MB database held every route
    // for 4.8 s. Here a database big enough that the copy takes a while, timed
    // on this thread first, then backed up while a timer measures the loop.
    db.exec("CREATE TABLE big (b BLOB); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000) INSERT INTO big SELECT randomblob(4000) FROM n")
    db.prepare('INSERT INTO t (name) VALUES (?)').run('kept')
    let t0 = performance.now()
    db.prepare('VACUUM INTO ?').run(path.join(dir, 'inline.db'))
    const inlineMs = performance.now() - t0
    let maxGap = 0
    let last = performance.now()
    const tick = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now }, 5)
    t0 = performance.now()
    try {
      await db.backup(path.join(dir, 'copy.db'))
    } finally {
      clearInterval(tick)
    }
    const backupMs = performance.now() - t0
    expect(maxGap, `loop held ${Math.round(maxGap)} ms of a ${Math.round(backupMs)} ms backup (${Math.round(inlineMs)} ms on this thread)`).toBeLessThan(inlineMs / 2)
    const copy = new Database(path.join(dir, 'copy.db'), { readonly: true })
    expect(copy.prepare('SELECT count(*) FROM big').pluck().get()).toBe(12000)
    expect(copy.prepare('SELECT name FROM t').pluck().all()).toEqual(['kept'])
    copy.close()
  })

  it('backup of an in-memory database copies it on this thread, and a failed copy rejects and leaves nothing', async () => {
    const mem = new Database(':memory:')
    mem.exec("CREATE TABLE m (x); INSERT INTO m VALUES ('in memory')")
    await mem.backup(path.join(dir, 'mem.db'))
    mem.close()
    const copy = new Database(path.join(dir, 'mem.db'), { readonly: true })
    expect(copy.prepare('SELECT x FROM m').pluck().get()).toBe('in memory')
    copy.close()
    // A file that is not a database: the worker's VACUUM INTO fails, and says why.
    const bad = path.join(dir, 'not-a-db.db')
    fs.writeFileSync(bad, Buffer.alloc(8192, 7))
    const opened = new Database(bad, { readonly: true, fileMustExist: true })
    const out = path.join(dir, 'out', 'copy.db')
    await expect(opened.backup(out)).rejects.toThrow(/not a database/)
    opened.close()
    expect(fs.readdirSync(path.dirname(out))).toEqual([])
  })

  it('a file that is not a database opens and refuses its first statement, also as the first open of a process', () => {
    // A fresh process: the compiled-defaults check runs at this very open, on this file.
    const bad = path.join(dir, 'first-open-not-a-db.db')
    fs.writeFileSync(bad, Buffer.alloc(8192, 7))
    const script = `import Database from ${JSON.stringify(path.resolve(import.meta.dirname, '../../src/lib/sqlite.ts'))}
const db = new Database(process.env.BAD)
console.log('opened')
try { db.prepare('SELECT 1 FROM sqlite_master').get() } catch (e) { console.log('refused ' + e.code) }`
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, BAD: bad }, encoding: 'utf8', timeout: 30_000 })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim().split('\n')).toEqual(['opened', 'refused SQLITE_NOTADB'])
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

  /** A fresh bun process that runs `body` (with SHIM, the absolute module path) and prints JSON. */
  const SHIM = path.resolve(import.meta.dirname, '../../src/lib/sqlite.ts')
  function inChild(body: string, env: Record<string, string> = {}): Record<string, unknown> {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
    if (!('WALNUT_SQLITE_LIBRARY' in env)) delete childEnv.WALNUT_SQLITE_LIBRARY
    const r = spawnSync(process.execPath, ['-e', `const SHIM = ${JSON.stringify(SHIM)};\n${body}`], { encoding: 'utf8', env: childEnv })
    expect(r.status, r.stderr).toBe(0)
    return JSON.parse(r.stdout.trim().split('\n').at(-1)!)
  }
  const REPORT = "console.log(JSON.stringify({ library: m.sqliteLibrary(), problem: m.sqliteLibraryProblem(), version: new m.default(':memory:').prepare('SELECT sqlite_version()').pluck().get() }))"

  it('is checked after loading: a bun:sqlite open that ran first is named, not reported as the built library', () => {
    // A direct open loads Apple's build, so the shim's setCustomSQLite can only refuse.
    const direct = inChild(`const { Database } = require('bun:sqlite'); new Database(':memory:').close(); const m = await import(SHIM); ${REPORT}`)
    expect(direct.library).toBe('system')
    expect(direct.version).not.toBe(SQLITE_VERSION)
    expect(direct.problem).toMatch(new RegExp(`^SQLite ${direct.version} was loaded before src/lib/sqlite\\.ts could load .*libsqlite3\\.dylib \\(a bun:sqlite open that skips it\\)`))
    // The shim alone loads and reports the built library.
    expect(inChild(`const m = await import(SHIM); ${REPORT}`)).toEqual({ library: DYLIB, problem: null, version: SQLITE_VERSION })
  })

  it('a worker thread after its parent finds the library loaded already, and it is the same one', () => {
    const worker = path.join(dir, 'worker.mjs')
    fs.writeFileSync(worker, `import { parentPort } from 'node:worker_threads'; const m = await import(${JSON.stringify(SHIM)}); parentPort.postMessage({ library: m.sqliteLibrary(), problem: m.sqliteLibraryProblem() })`)
    const body = `const m = await import(SHIM); new m.default(':memory:').close();
      const { Worker } = await import('node:worker_threads');
      const w = new Worker(${JSON.stringify(worker)});
      const got = await new Promise((resolve, reject) => { w.on('message', resolve); w.on('error', reject) });
      await w.terminate();
      console.log(JSON.stringify(got))`
    expect(inChild(body)).toEqual({ library: DYLIB, problem: null })
  })

  it('a library file that will not load fails the open in words, not later as a bare dlopen error', () => {
    const bad = path.join(dir, 'not-a-library.dylib')
    fs.writeFileSync(bad, 'not a mach-o file')
    const got = inChild(`const m = await import(SHIM); let error = null; try { new m.default(':memory:') } catch (e) { error = String(e.message) } console.log(JSON.stringify({ error }))`, { WALNUT_SQLITE_LIBRARY: bad })
    expect(got.error).toMatch(new RegExp(`^SQLite ${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} does not load: Error: dlopen`))
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
