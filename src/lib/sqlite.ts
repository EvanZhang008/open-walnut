/**
 * SQLite for Walnut: the one place that opens a database
 * (docs/plan/walnut-single-binary.md).
 *
 * Walnut runs on bun, whose SQLite is built in (`bun:sqlite`, no native
 * module to compile). The rest of the code keeps the better-sqlite3 API it was
 * written against, which this module provides over bun:sqlite. Until no Node
 * build of Walnut is left, a process running on Node gets better-sqlite3 itself.
 *
 * What bun:sqlite does differently, and what this module does about it:
 *  - no busy timeout by default (better-sqlite3 waits 5 s): set from `timeout`;
 *  - a missing row is `null` (better-sqlite3: `undefined`): mapped back;
 *  - a BLOB is a Uint8Array (better-sqlite3: a Buffer): wrapped as a Buffer, no copy;
 *  - no `pragma`, `pluck`, `raw`, `backup`: provided here;
 *  - named parameters need their `@`/`$`/`:` prefix unless the database is
 *    opened `strict`, which it always is (an object's keys bind without one).
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** True when this process runs on bun. */
export const ON_BUN = typeof (process.versions as { bun?: string }).bun === 'string'

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
  columnNames: string[]
  toString(): string
}

interface BunDatabase {
  prepare(sql: string): BunStatement
  exec(sql: string): unknown
  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>
  serialize(name?: string): Uint8Array
  close(throwOnError?: boolean): void
  inTransaction: boolean
  filename: string
}

type BunDatabaseClass = new (filename: string, options?: Record<string, boolean>) => BunDatabase

let bunDatabaseClass: BunDatabaseClass | null = null
function bunSqlite(): BunDatabaseClass {
  bunDatabaseClass ??= (require('bun:sqlite') as { Database: BunDatabaseClass }).Database
  return bunDatabaseClass
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

class SqliteStatement implements Statement {
  private mode: 'object' | 'pluck' | 'raw' = 'object'
  constructor(private readonly stmt: BunStatement, readonly source: string) {}

  get reader(): boolean {
    return this.stmt.columnNames.length > 0
  }

  run(...params: unknown[]): RunResult {
    return this.stmt.run(...bindArgs(params))
  }

  get(...params: unknown[]): unknown {
    if (this.mode === 'object') return fixRow(this.stmt.get(...bindArgs(params)))
    const first = this.stmt.values(...bindArgs(params))[0]
    if (!first) return undefined
    return this.mode === 'pluck' ? asBuffer(first[0]) : fixValues(first)
  }

  all(...params: unknown[]): unknown[] {
    if (this.mode === 'object') {
      const rows = this.stmt.all(...bindArgs(params))
      for (const row of rows) fixRow(row)
      return rows
    }
    const rows = this.stmt.values(...bindArgs(params))
    return this.mode === 'pluck' ? rows.map((r) => asBuffer(r[0])) : rows.map(fixValues)
  }

  *iterate(...params: unknown[]): IterableIterator<unknown> {
    if (this.mode === 'object') {
      for (const row of this.stmt.iterate(...bindArgs(params))) yield fixRow(row)
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
  readonly name: string
  readonly readonly: boolean
  readonly memory: boolean

  constructor(filename = ':memory:', options: Options = {}) {
    const Bun = bunSqlite()
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
    this.db = new Bun(filename, flags)
    const timeout = options.timeout ?? 5000
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeout))}`)
  }

  get open(): boolean {
    return this.isOpen
  }

  get inTransaction(): boolean {
    return this.db.inTransaction
  }

  prepare(source: string): SqliteStatement {
    return new SqliteStatement(this.db.prepare(source), source)
  }

  exec(source: string): this {
    this.db.exec(source)
    return this
  }

  pragma(source: string, options: PragmaOptions = {}): unknown {
    const stmt = this.db.prepare(`PRAGMA ${source}`)
    if (options.simple) {
      const first = stmt.values()[0]
      return first ? asBuffer(first[0]) : undefined
    }
    return stmt.all().map(fixRow)
  }

  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F> {
    return this.db.transaction(fn)
  }

  async backup(destination: string, _options: BackupOptions = {}): Promise<{ totalPages: number; remainingPages: number }> {
    // VACUUM INTO writes a consistent copy (a read-only connection may make one too); it refuses an existing
    // file, which better-sqlite3's backup() overwrites, so it writes beside the target and renames over it.
    const dir = path.dirname(destination)
    await fs.promises.mkdir(dir, { recursive: true })
    const temp = path.join(dir, `.${path.basename(destination)}.${process.pid}.${Date.now()}.backup`)
    try {
      this.db.prepare('VACUUM INTO ?').run(temp)
      await fs.promises.rename(temp, destination)
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => {})
    }
    const pages = this.pragma('page_count', { simple: true })
    return { totalPages: typeof pages === 'number' ? pages : 0, remainingPages: 0 }
  }

  serialize(options: { attached?: string } = {}): Buffer {
    return asBuffer(this.db.serialize(options.attached ?? 'main')) as Buffer
  }

  close(): this {
    if (this.isOpen) {
      this.isOpen = false
      this.db.close()
    }
    return this
  }
}

// ── the constructor everyone imports ────────────────────────────────────────

function resolveConstructor(): DatabaseConstructor {
  if (ON_BUN) {
    const ctor = function (this: unknown, filename?: string, options?: Options) {
      return new SqliteDatabase(filename, options)
    }
    return ctor as unknown as DatabaseConstructor
  }
  return require('better-sqlite3') as DatabaseConstructor
}

const Database: DatabaseConstructor = resolveConstructor()
export default Database
