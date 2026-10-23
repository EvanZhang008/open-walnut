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
 * bun also accepts what better-sqlite3 refuses (a boolean, get() on a write,
 * two statements in one prepare).
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  bunModule = require('bun:sqlite') as BunSqlite
  library = 'bun'
  if (process.platform === 'darwin') {
    library = 'system'
    // WALNUT_SQLITE_LIBRARY names the library (the compiled file ships one);
    // `system` keeps the Apple build on purpose.
    const wanted = process.env.WALNUT_SQLITE_LIBRARY
    if (wanted !== 'system') {
      const custom = wanted || builtSqliteLibrary()
      if (custom && fs.existsSync(custom)) {
        try {
          bunModule.Database.setCustomSQLite(custom)
        } catch {
          // Loaded already in this process (a worker thread after its parent),
          // and by this same code, so with this same library.
        }
        library = custom
      } else {
        libraryProblem = wanted
          ? `WALNUT_SQLITE_LIBRARY names no file (${wanted}): SQLite is the macOS system build, which behaves unlike Walnut's`
          : 'the upstream SQLite is not built (run `bun scripts/build-sqlite-dylib.mjs`): SQLite is the macOS system build, which behaves unlike Walnut\'s'
      }
    }
  }
  return bunModule
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
    const stmt = db.prepare('SELECT compile_options FROM pragma_compile_options')
    try {
      const opts = new Set(stmt.values().map((r) => String(r[0])))
      compiledDefaults = opts.has('DEFAULT_FOREIGN_KEYS') && opts.has('DEFAULT_CACHE_SIZE=-16000')
    } finally {
      stmt.finalize()
    }
  }
  return compiledDefaults
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
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeout))}`)
    if (!hasCompiledDefaults(this.db)) this.db.exec('PRAGMA foreign_keys = ON; PRAGMA cache_size = -16000')
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
    const stmt = this.handle().prepare(source)
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
    const stmt = this.handle().prepare(`PRAGMA ${source}`)
    try {
      if (options.simple) {
        const first = stmt.values()[0]
        return first ? asBuffer(first[0]) : undefined
      }
      return stmt.all().map(fixRow)
    } finally {
      stmt.finalize()
    }
  }

  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F> {
    return this.handle().transaction(fn)
  }

  async backup(destination: string, _options: BackupOptions = {}): Promise<{ totalPages: number; remainingPages: number }> {
    // VACUUM INTO writes a consistent copy (a read-only connection may make one too); it refuses an existing
    // file, which better-sqlite3's backup() overwrites, so it writes beside the target and renames over it.
    const dir = path.dirname(destination)
    await fs.promises.mkdir(dir, { recursive: true })
    const temp = path.join(dir, `.${path.basename(destination)}.${process.pid}.${Date.now()}.backup`)
    try {
      const vacuum = this.handle().prepare('VACUUM INTO ?')
      try { vacuum.run(temp) } finally { vacuum.finalize() }
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
