/**
 * SQLite for Walnut: the one place that opens a database
 * (docs/plan/walnut-single-binary.md).
 *
 * Walnut runs only on bun, whose SQLite is built in (`bun:sqlite`, no native
 * module to compile). The rest of the code keeps the better-sqlite3 API it was
 * written against, which this module provides over bun:sqlite. A process on
 * Node cannot open a database at all: the first open says so.
 *
 * What bun:sqlite does differently, and what this module does about it:
 *  - no busy timeout by default (better-sqlite3 waits 5 s): set from `timeout`;
 *  - a missing row is `null` (better-sqlite3: `undefined`): mapped back;
 *  - a BLOB is a Uint8Array (better-sqlite3: a Buffer): wrapped as a Buffer, no copy;
 *  - no `pragma`, `pluck`, `raw`, `backup`: provided here;
 *  - named parameters need their `@`/`$`/`:` prefix unless the database is
 *    opened `strict`, which it always is (an object's keys bind without one);
 *  - close() keeps the connection open while a prepared statement is alive:
 *    close() finalizes them, and a statement used after close throws as in
 *    better-sqlite3;
 *  - on macOS bun loads the system SQLite, an Apple build. It fails every query
 *    on a database whose file was deleted or replaced while open
 *    (SQLITE_IOERR_VNODE, where better-sqlite3 carries on), keeps -wal and -shm
 *    after the last close, and refuses a read-only open of a WAL database with
 *    no -wal. So on macOS Walnut loads the upstream SQLite that
 *    scripts/build-sqlite-dylib.mjs compiles with better-sqlite3's options
 *    (vendor/sqlite/darwin/, or WALNUT_SQLITE_LIBRARY). Without it the server
 *    logs sqliteLibraryProblem(), the last two quirks are handled here
 *    (persistent WAL off per connection, the -wal created before a read-only
 *    open) and the first one stays;
 *  - better-sqlite3's compile options (foreign keys on, a 16 MB page cache) are
 *    set per connection on a library without them (bun's own on Linux).
 *
 * Left as is: a whole JS number binds as INTEGER on bun and as REAL in
 * better-sqlite3. Same value in INTEGER and REAL columns and in comparisons;
 * it differs only as TEXT ('3' vs '3.0'), in integer division and in json text.
 * bun also accepts what better-sqlite3 refuses (a boolean, get() on a write).
 * Two statements in one prepare, and a transaction function that returns a
 * promise, are refused here as better-sqlite3 refused them.
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { checkOneStatement, refusePromise } from './sqlite-guards.js'

// The plugin database contract's binding rules (better-sqlite3's), for the plugin database
// worker (src/core/plugins/plugin-storage.ts), which can load only this file. Nothing here binds
// through them: Walnut's own statements keep the binding below.
// The ignore is for TS6059 only (the plugin API's module is outside the server emit root, and
// every bundle inlines it); the names are checked: an export the module lacks fails the type check.
// @ts-ignore
import * as pluginBinding from '../../packages/plugin-api/src/sqlite-binding.js'
export const { bindByIndex, onlyTrailingNoise } = pluginBinding

const require = createRequire(import.meta.url)

/**
 * The file a worker thread loads to get this module (a worker shares nothing
 * with the bundle that starts it). Unbundled, that is this file. Inside a tsup
 * bundle (dist/cli.js, dist/web/server.js, dist/integrations/<id>/index.js)
 * it is the module's own build, dist/lib/sqlite.js, a few levels up; from a
 * plugin bundle in <package>/.plugin-cache, <package>/dist/lib/sqlite.js.
 * null when none is found. `here` is the file this code runs from (tests pass one).
 */
export function sqliteModuleFile(here: string = fileURLToPath(import.meta.url)): string | null {
  if (/^sqlite\.[cm]?[jt]s$/.test(path.basename(here))) return here
  let dir = path.dirname(here)
  for (let i = 0; i < 4; i++) {
    for (const candidate of [path.join(dir, 'lib', 'sqlite.js'), path.join(dir, 'dist', 'lib', 'sqlite.js')]) {
      if (fs.existsSync(candidate)) return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface Options {
  readonly?: boolean
  fileMustExist?: boolean
  /** Busy timeout in ms (default 5000, as better-sqlite3). */
  timeout?: number
  verbose?: (message?: unknown, ...more: unknown[]) => void
}

export interface PragmaOptions {
  simple?: boolean
}

export interface BackupOptions {
  attached?: string
  progress?: (info: { totalPages: number; remainingPages: number }) => number
}

export interface Statement<BindParameters extends unknown[] = unknown[], Result = unknown> {
  readonly source: string
  readonly reader: boolean
  run(...params: BindParameters): RunResult
  get(...params: BindParameters): Result | undefined
  all(...params: BindParameters): Result[]
  iterate(...params: BindParameters): IterableIterator<Result>
  pluck(toggle?: boolean): this
  raw(toggle?: boolean): this
}

export interface Transaction<F extends (...args: never[]) => unknown> {
  (...args: Parameters<F>): ReturnType<F>
  deferred(...args: Parameters<F>): ReturnType<F>
  immediate(...args: Parameters<F>): ReturnType<F>
  exclusive(...args: Parameters<F>): ReturnType<F>
}

export interface Database {
  readonly name: string
  readonly open: boolean
  readonly inTransaction: boolean
  readonly readonly: boolean
  readonly memory: boolean
  prepare<BindParameters extends unknown[] | object = unknown[], Result = unknown>(
    source: string,
  ): BindParameters extends unknown[] ? Statement<BindParameters, Result> : Statement<[BindParameters], Result>
  exec(source: string): this
  pragma(source: string, options?: PragmaOptions): unknown
  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>
  backup(destination: string, options?: BackupOptions): Promise<{ totalPages: number; remainingPages: number }>
  serialize(options?: { attached?: string }): Buffer
  close(): this
}

export interface DatabaseConstructor {
  new (filename?: string, options?: Options): Database
  (filename?: string, options?: Options): Database
}

// ── bun:sqlite ──────────────────────────────────────────────────────────────

interface BunStatement {
  run(...params: unknown[]): RunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  values(...params: unknown[]): unknown[][]
  iterate(...params: unknown[]): IterableIterator<unknown>
  finalize(): void
  columnNames: string[]
  paramsCount: number
  toString(): string
}

interface BunDatabase {
  prepare(sql: string): BunStatement
  exec(sql: string): unknown
  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>
  serialize(name?: string): Uint8Array
  fileControl(op: number, value: number): number
  close(throwOnError?: boolean): void
  inTransaction: boolean
  filename: string
}

type BunDatabaseClass = (new (filename: string, options?: Record<string, boolean>) => BunDatabase) & {
  setCustomSQLite(path: string): boolean
}
interface BunSqlite { Database: BunDatabaseClass; constants: Record<string, number> }

/** Where scripts/build-sqlite-dylib.mjs puts the upstream SQLite, under the package root. */
const BUILT_SQLITE = path.join('vendor', 'sqlite', 'darwin', 'libsqlite3.dylib')

/** The built upstream SQLite, found from this file or from the bundle that inlined it. */
export function builtSqliteLibrary(here: string = fileURLToPath(import.meta.url)): string | null {
  let dir = path.dirname(here)
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, BUILT_SQLITE)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

let bunModule: BunSqlite | null = null
let library = 'bun'
let libraryProblem: string | null = null
function bunSqlite(): BunSqlite {
  if (bunModule) return bunModule
  const bunVersion = (process.versions as { bun?: string }).bun
  if (typeof bunVersion !== 'string') {
    throw new Error(`Walnut runs on bun, whose SQLite is built in; this process runs on Node ${process.version}, which has none Walnut uses. Run it with bun (https://bun.sh).`)
  }
  // Kept only once the library checks out, so a file that would not load fails every open.
  const mod = require('bun:sqlite') as BunSqlite
  library = 'bun'
  libraryProblem = null
  if (process.platform === 'darwin') {
    library = 'system'
    // WALNUT_SQLITE_LIBRARY names the library (the compiled file ships one);
    // `system` keeps the Apple build on purpose.
    const wanted = process.env.WALNUT_SQLITE_LIBRARY
    if (wanted !== 'system') {
      const custom = wanted || builtSqliteLibrary()
      if (custom && fs.existsSync(custom)) {
        let refused: unknown = null
        try {
          mod.Database.setCustomSQLite(custom)
        } catch (err) {
          // Loaded already in this process: by this code in a worker thread's
          // parent (the same library), or by a bun:sqlite open that skipped this
          // file (Apple's). Or the file would not load. The check below says which.
          refused = err
        }
        const loaded = loadedSqlite(mod, custom, refused)
        if (loaded.isCustom) {
          library = custom
        } else {
          libraryProblem = `SQLite ${loaded.version} was loaded before src/lib/sqlite.ts could load ${custom} (a bun:sqlite open that skips it): this is the macOS system build, which behaves unlike Walnut's`
        }
      } else {
        libraryProblem = wanted
          ? `WALNUT_SQLITE_LIBRARY names no file (${wanted}): SQLite is the macOS system build, which behaves unlike Walnut's`
          : 'the upstream SQLite is not built (run `bun scripts/build-sqlite-dylib.mjs`): SQLite is the macOS system build, which behaves unlike Walnut\'s'
      }
    }
  }
  bunModule = mod
  return mod
}

/**
 * Which SQLite bun has loaded, checked rather than assumed: a library file
 * carries its own sqlite_source_id() string, and Apple's build (3.51.0 in
 * macOS 26, its id ending in "aapl") is not that file. Opens one in-memory
 * database; reads the file once per process (about 3 MB).
 */
function loadedSqlite(mod: BunSqlite, file: string, refused: unknown): { version: string; isCustom: boolean } {
  let db: BunDatabase
  try {
    db = new mod.Database(':memory:')
  } catch (err) {
    // Nothing is loaded: the file itself would not load (refused says why).
    throw new Error(`SQLite ${file} does not load: ${String(refused ?? err).split('\n')[0]}`)
  }
  try {
    const stmt = db.prepare('SELECT sqlite_version(), sqlite_source_id()')
    const [version, sourceId] = (stmt.values()[0] ?? []).map(String)
    stmt.finalize()
    return { version, isCustom: !!sourceId && fs.readFileSync(file).includes(Buffer.from(sourceId)) }
  } finally {
    db.close()
  }
}

/**
 * Which SQLite this process opens databases with: the library file it loaded
 * on macOS, 'system' for the Apple build there, or 'bun' for the one bun
 * carries elsewhere.
 */
export function sqliteLibrary(): string {
  bunSqlite()
  return library
}

/** Why this process runs on the macOS system SQLite without being asked to, or null. */
export function sqliteLibraryProblem(): string | null {
  bunSqlite()
  return libraryProblem
}

/**
 * better-sqlite3 compiles its SQLite with foreign keys on and a 16 MB page
 * cache; so does the built dylib. Another library (bun's own on Linux, the
 * macOS system one) gets both per connection. Read once per process.
 */
let compiledDefaults: boolean | null = null
function hasCompiledDefaults(db: BunDatabase): boolean {
  if (compiledDefaults === null) {
    // The pragma itself, not the pragma_compile_options table: a SELECT reads the schema,
    // which a file that is not a database refuses, and this runs at the first open.
    const stmt = db.prepare('PRAGMA compile_options')
    try {
      const opts = new Set(stmt.values().map((r) => String(r[0])))
      compiledDefaults = opts.has('DEFAULT_FOREIGN_KEYS') && opts.has('DEFAULT_CACHE_SIZE=-16000')
    } finally {
      stmt.finalize()
    }
  }
  return compiledDefaults
}

/**
 * better-sqlite3's SQLite (and the built dylib) is compiled with
 * DEFAULT_WAL_SYNCHRONOUS=1: a connection that enters WAL mode syncs at
 * checkpoints, not at every commit. bun's own on Linux syncs every commit, which
 * waits on the disk on the server's event loop. Read once per process.
 */
let walSyncDefault: boolean | null = null
function hasWalSyncDefault(db: BunDatabase): boolean {
  if (walSyncDefault === null) {
    const stmt = db.prepare('PRAGMA compile_options')
    try {
      walSyncDefault = stmt.values().some((r) => String(r[0]) === 'DEFAULT_WAL_SYNCHRONOUS=1')
    } finally {
      stmt.finalize()
    }
  }
  return walSyncDefault
}

/** A BLOB comes back as a Buffer over the same bytes, as better-sqlite3 gives it. */
function asBuffer(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value
}

function fixRow(row: unknown): unknown {
  if (row === null || typeof row !== 'object') return row ?? undefined
  const obj = row as Record<string, unknown>
  for (const key in obj) {
    const v = obj[key]
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) obj[key] = asBuffer(v)
  }
  return obj
}

/**
 * better-sqlite3's SQLite opens a WAL database read-only with no -wal file on
 * disk (it creates one); the macOS system SQLite refuses ("unable to open
 * database file"). Create the empty -wal it would have made, with the
 * database's own mode. Only for a WAL database: header bytes 18 and 19 are 2.
 */
function ensureWalFileForReadonly(file: string): void {
  try {
    const wal = `${file}-wal`
    if (fs.existsSync(wal)) return
    const header = Buffer.alloc(20)
    const fd = fs.openSync(file, 'r')
    try {
      if (fs.readSync(fd, header, 0, 20, 0) < 20 || header[18] !== 2 || header[19] !== 2) return
    } finally {
      fs.closeSync(fd)
    }
    fs.writeFileSync(wal, '', { flag: 'wx', mode: fs.statSync(file).mode & 0o777 })
  } catch {
    // The open itself reports any real problem.
  }
}

function fixValues(values: unknown[]): unknown[] {
  for (let i = 0; i < values.length; i++) values[i] = asBuffer(values[i])
  return values
}

/** better-sqlite3 binds an array as positional parameters, and an object beside them as named ones. */
function bindArgs(params: unknown[]): unknown[] {
  if (params.length === 1 && Array.isArray(params[0])) return params[0] as unknown[]
  if (params.some(Array.isArray)) return params.flatMap((p) => (Array.isArray(p) ? p : [p]))
  return params
}

/** better-sqlite3's error for any use of a closed database or of a statement prepared on one. */
function notOpen(): TypeError {
  return new TypeError('The database connection is not open')
}

class SqliteStatement implements Statement {
  private mode: 'object' | 'pluck' | 'raw' = 'object'
  constructor(private readonly stmt: BunStatement, readonly source: string, private readonly owner: SqliteDatabase) {}

  get reader(): boolean {
    return this.stmt.columnNames.length > 0
  }

  /** sqlite3_bind_parameter_count: the highest parameter index SQLite compiled. */
  get paramsCount(): number {
    return this.stmt.paramsCount
  }

  private live(): BunStatement {
    if (!this.owner.open) throw notOpen()
    return this.stmt
  }

  run(...params: unknown[]): RunResult {
    return this.live().run(...bindArgs(params))
  }

  get(...params: unknown[]): unknown {
    const stmt = this.live()
    if (this.mode === 'object') return fixRow(stmt.get(...bindArgs(params)))
    const first = stmt.values(...bindArgs(params))[0]
    if (!first) return undefined
    return this.mode === 'pluck' ? asBuffer(first[0]) : fixValues(first)
  }

  all(...params: unknown[]): unknown[] {
    const stmt = this.live()
    if (this.mode === 'object') {
      const rows = stmt.all(...bindArgs(params))
      for (const row of rows) fixRow(row)
      return rows
    }
    const rows = stmt.values(...bindArgs(params))
    return this.mode === 'pluck' ? rows.map((r) => asBuffer(r[0])) : rows.map(fixValues)
  }

  *iterate(...params: unknown[]): IterableIterator<unknown> {
    const stmt = this.live()
    if (this.mode === 'object') {
      for (const row of stmt.iterate(...bindArgs(params))) yield fixRow(row)
      return
    }
    // values() has no iterator form; the rare pluck/raw iterate reads them all.
    for (const v of this.all(...params)) yield v
  }

  pluck(toggle = true): this {
    this.mode = toggle ? 'pluck' : this.mode === 'pluck' ? 'object' : this.mode
    return this
  }

  raw(toggle = true): this {
    this.mode = toggle ? 'raw' : this.mode === 'raw' ? 'object' : this.mode
    return this
  }
}

/**
 * VACUUM INTO `temp` from the database file `file`, on a worker thread. One
 * call copies the whole database (4.8 s for a 750 MB one), and on the calling
 * thread it would hold the event loop, and every route, that long. The worker
 * opens its own read-only connection, so it copies the last commit while
 * writers go on (WAL); bun has loaded SQLite for this process already
 * (bunSqlite), so the worker's is the same library.
 */
const VACUUM_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { Database } = require('bun:sqlite')
try {
  const db = new Database(workerData.file, { readonly: true })
  try {
    db.exec('PRAGMA busy_timeout = ' + workerData.busyTimeout)
    const stmt = db.prepare('VACUUM INTO ?')
    try { stmt.run(workerData.temp) } finally { stmt.finalize() }
  } finally {
    db.close()
  }
  parentPort.postMessage({ ok: true })
} catch (error) {
  parentPort.postMessage({ ok: false, message: error && error.message ? error.message : String(error), code: error && error.code })
}
`

function vacuumIntoOffThread(file: string, temp: string, busyTimeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(VACUUM_WORKER, { eval: true, workerData: { file, temp, busyTimeout } })
    let settled = false
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      void worker.terminate()
      if (err) reject(err)
      else resolve()
    }
    worker.once('message', (m: { ok: boolean; message?: string; code?: string }) => {
      settle(m.ok ? undefined : Object.assign(new Error(m.message ?? 'VACUUM INTO failed'), m.code ? { code: m.code } : {}))
    })
    worker.once('error', (err) => settle(err instanceof Error ? err : new Error(String(err))))
    worker.once('exit', (code) => settle(new Error(`the SQLite backup worker exited with code ${code}`)))
  })
}

class SqliteDatabase {
  private readonly db: BunDatabase
  private isOpen = true
  // bun's close() leaves the connection open while any statement prepared on it
  // is alive (the WAL unmerged, -wal and -shm still on disk) until each is
  // garbage collected. better-sqlite3 closes at once, so close() finalizes them.
  private readonly statements = new Set<WeakRef<BunStatement>>()
  private readonly collected = new FinalizationRegistry<WeakRef<BunStatement>>((ref) => { this.statements.delete(ref) })
  readonly name: string
  readonly readonly: boolean
  readonly memory: boolean
  private readonly busyTimeout: number
  /** This connection set its own `synchronous` (the WAL default then stays out of it). */
  private syncSet = false

  constructor(filename = ':memory:', options: Options = {}) {
    const bun = bunSqlite()
    this.name = filename
    this.memory = filename === ':memory:' || filename === ''
    this.readonly = options.readonly === true
    const flags: Record<string, boolean> = { strict: true }
    if (this.readonly) flags.readonly = true
    else if (options.fileMustExist) { flags.readwrite = true; flags.create = false }
    else { flags.readwrite = true; flags.create = true }
    if (options.fileMustExist && !this.memory && !fs.existsSync(filename)) {
      throw Object.assign(new Error(`unable to open database file: ${filename}`), { code: 'SQLITE_CANTOPEN' })
    }
    if (this.readonly && !this.memory) ensureWalFileForReadonly(filename)
    this.db = new bun.Database(filename, flags)
    const timeout = options.timeout ?? 5000
    this.busyTimeout = Math.max(0, Math.floor(timeout))
    try {
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeout))}`)
      if (!hasCompiledDefaults(this.db)) {
        this.db.exec('PRAGMA foreign_keys = ON')
        // cache_size reads the schema, so a file that is not a database (or a corrupt one) would
        // refuse it here, at open (Linux, where bun's own SQLite lacks the compiled defaults).
        // better-sqlite3 opens such a file and refuses its first statement: keep that order.
        try { this.db.exec('PRAGMA cache_size = -16000') } catch (err) {
          if (!/^SQLITE_(NOTADB|CORRUPT)/.test(String((err as { code?: unknown }).code ?? ''))) throw err
        }
      }
    } catch (err) {
      // A connection that never became this object is closed here, not left to the collector.
      try { this.db.close() } catch { /* already unusable */ }
      throw err
    }
    // On macOS bun uses the system SQLite, which keeps a WAL database's -wal and
    // -shm files after the last connection closes; better-sqlite3's SQLite removes them.
    const persistWal = bun.constants.SQLITE_FCNTL_PERSIST_WAL
    if (!this.memory && persistWal !== undefined) {
      try { this.db.fileControl(persistWal, 0) } catch { /* a VFS without the control */ }
    }
  }

  get open(): boolean {
    return this.isOpen
  }

  get inTransaction(): boolean {
    return this.db.inTransaction
  }

  private handle(): BunDatabase {
    if (!this.isOpen) throw notOpen()
    return this.db
  }

  prepare(source: string): SqliteStatement {
    const handle = this.handle()
    checkOneStatement(source)
    const stmt = handle.prepare(source)
    const ref = new WeakRef(stmt)
    this.statements.add(ref)
    this.collected.register(stmt, ref)
    return new SqliteStatement(stmt, source, this)
  }

  exec(source: string): this {
    this.handle().exec(source)
    return this
  }

  pragma(source: string, options: PragmaOptions = {}): unknown {
    const handle = this.handle()
    checkOneStatement(`PRAGMA ${source}`)
    const stmt = handle.prepare(`PRAGMA ${source}`)
    let result: unknown
    try {
      if (options.simple) {
        const first = stmt.values()[0]
        result = first ? asBuffer(first[0]) : undefined
      } else {
        result = stmt.all().map(fixRow)
      }
    } finally {
      stmt.finalize()
    }
    if (/^\s*synchronous\s*=/i.test(source)) this.syncSet = true
    // Entering WAL mode: the sync level better-sqlite3's SQLite picks then (hasWalSyncDefault),
    // unless this connection chose one itself.
    else if (!this.syncSet && /^\s*journal_mode\s*=\s*wal\s*$/i.test(source) && !hasWalSyncDefault(handle)) {
      const mode = options.simple ? result : (result as Array<{ journal_mode?: unknown }>)[0]?.journal_mode
      if (String(mode).toLowerCase() === 'wal') handle.exec('PRAGMA synchronous = NORMAL')
    }
    return result
  }

  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F> {
    return this.handle().transaction(refusePromise(fn))
  }

  async backup(destination: string, _options: BackupOptions = {}): Promise<{ totalPages: number; remainingPages: number }> {
    // VACUUM INTO writes a consistent copy (a read-only connection may make one too); it refuses an existing
    // file, which better-sqlite3's backup() overwrites, so it writes beside the target and renames over it.
    // better-sqlite3 copied in steps between event-loop turns; VACUUM INTO is one call, so a database file
    // is copied on a worker thread (vacuumIntoOffThread). An in-memory one has no file to open there.
    const handle = this.handle()
    const dir = path.dirname(destination)
    await fs.promises.mkdir(dir, { recursive: true })
    const temp = path.join(dir, `.${path.basename(destination)}.${process.pid}.${Date.now()}.backup`)
    try {
      if (this.memory || handle.inTransaction) {
        const vacuum = handle.prepare('VACUUM INTO ?')
        try { vacuum.run(temp) } finally { vacuum.finalize() }
      } else {
        await vacuumIntoOffThread(this.name, temp, this.busyTimeout)
      }
      await fs.promises.rename(temp, destination)
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => {})
    }
    const pages = this.pragma('page_count', { simple: true })
    return { totalPages: typeof pages === 'number' ? pages : 0, remainingPages: 0 }
  }


  serialize(options: { attached?: string } = {}): Buffer {
    return asBuffer(this.handle().serialize(options.attached ?? 'main')) as Buffer
  }

  close(): this {
    if (this.isOpen) {
      this.isOpen = false
      for (const ref of this.statements) ref.deref()?.finalize()
      this.statements.clear()
      this.db.close()
    }
    return this
  }
}

// ── the constructor everyone imports ────────────────────────────────────────

/** Callable with or without `new`, as better-sqlite3's constructor is. */
const Database = function (this: unknown, filename?: string, options?: Options) {
  return new SqliteDatabase(filename, options)
} as unknown as DatabaseConstructor
export default Database
