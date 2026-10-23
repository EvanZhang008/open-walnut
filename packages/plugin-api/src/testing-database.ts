import type { PluginDatabase, SqlRunResult, SqlStatement } from './server.js'

// The fake's `walnut.storage.database`: a real in-memory SQLite (Node's built-in node:sqlite)
// that answers the way the host's database does. The host runs better-sqlite3 in a worker, so
// every rule here restates one of the host's: values cross a structured clone, parameters bind
// by better-sqlite3's rules (bare names for :name, @name and $name, arrays as positional values,
// the same "Missing named parameter" and "Too few/many" refusals), errors arrive as a plain
// Error carrying only the message, rows are plain objects, and migrate/batch keep the host's
// table, ordering, transaction and messages.

// The few node:sqlite shapes used here, so the published types never depend on @types/node.
interface SqliteStatement {
  /** The text of the first statement only: node:sqlite compiles one and ignores the rest. */
  readonly sourceSQL: string
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Array<Record<string, unknown>>
  columns?(): unknown[]
  setAllowBareNamedParameters?(enabled: boolean): void
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

interface SqliteModule {
  DatabaseSync: new (location: string) => SqliteDatabase
}

interface NodeProcessLike {
  versions?: { node?: string }
  getBuiltinModule?: (id: string) => unknown
}

const MIGRATIONS_TABLE = 'CREATE TABLE IF NOT EXISTS _walnut_plugin_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'

/** Loaded on first use, so importing the testing module works on any runtime. */
function openSqlite(): SqliteDatabase {
  const proc = (globalThis as { process?: NodeProcessLike }).process
  let sqlite: SqliteModule | undefined
  try {
    sqlite = proc?.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined
  } catch {
    sqlite = undefined
  }
  if (typeof sqlite?.DatabaseSync !== 'function') {
    const running = proc?.versions?.node ? `Node.js ${proc.versions.node}` : 'this runtime'
    throw new Error(`createFakeWalnut's storage.database needs node:sqlite, built into Node.js 22.13 or later (23.4 or later on the 23 line); ${running} does not provide it`)
  }
  return new sqlite.DatabaseSync(':memory:')
}

// Parameter binding, by better-sqlite3's rules.

interface ParameterSlots {
  /** sqlite3_bind_parameter_count: the highest parameter index. */
  count: number
  /** Index to the name SQLite reports for it (with its prefix). An index with no name is anonymous. */
  names: Map<number, string>
}

function isIdChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 95 || code === 36 || code >= 0x80
}

/** What better-sqlite3 lets follow the one statement it prepares: whitespace, `;` and comments. */
function onlyTrailingNoise(tail: string): boolean {
  let i = 0
  while (i < tail.length) {
    const char = tail[i]
    if (char === ' ' || char === ';' || (char >= '\t' && char <= '\r')) {
      i++
    } else if (char === '/' && tail[i + 1] === '*') {
      const end = tail.indexOf('*/', i + 2)
      i = end < 0 ? tail.length : end + 2
    } else if (char === '-' && tail[i + 1] === '-') {
      const end = tail.indexOf('\n', i + 2)
      i = end < 0 ? tail.length : end + 1
    } else {
      return false
    }
  }
  return true
}

/**
 * SQLite's own numbering of `?`, `?NNN`, `:name`, `@name`, `$name` and `#name`, skipping literals
 * and comments. Without the TCL forms (`$a::b`, `$a(x)`): the host's SQLite build leaves them out.
 */
function parameterSlots(sql: string): ParameterSlots {
  const names = new Map<number, string>()
  const numbers = new Map<string, number>()
  let count = 0
  const add = (name: string, index: number) => {
    if (!numbers.has(name)) numbers.set(name, index)
    if (!names.has(index)) names.set(index, name)
  }
  let i = 0
  while (i < sql.length) {
    const char = sql[i]
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2)
      i = end < 0 ? sql.length : end + 1
    } else if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 2
    } else if (char === "'" || char === '"' || char === '`') {
      i++
      while (i < sql.length) {
        if (sql[i] === char) {
          if (sql[i + 1] !== char) break
          i++
        }
        i++
      }
      i++
    } else if (char === '[') {
      const end = sql.indexOf(']', i + 1)
      i = end < 0 ? sql.length : end + 1
    } else if (char === '?') {
      let end = i + 1
      while (end < sql.length && sql.charCodeAt(end) >= 48 && sql.charCodeAt(end) <= 57) end++
      if (end === i + 1) {
        count++
      } else {
        const index = Number(sql.slice(i + 1, end))
        if (index > count) count = index
        add(sql.slice(i, end), index)
      }
      i = end
    } else if (char === ':' || char === '@' || char === '$' || char === '#') {
      let end = i + 1
      while (end < sql.length && isIdChar(sql.charCodeAt(end))) end++
      const name = sql.slice(i, end)
      if (end > i + 1 && !numbers.has(name)) add(name, ++count)
      i = end
    } else if (isIdChar(sql.charCodeAt(i))) {
      // Identifiers, keywords and numbers: a `$` inside `a$b` is part of the name, not a parameter.
      while (i < sql.length && isIdChar(sql.charCodeAt(i))) i++
    } else {
      i++
    }
  }
  return { count, names }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function bindable(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || ArrayBuffer.isView(value)) return value
  throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null')
}

/** The host's `invoke` plus better-sqlite3's Binder, answered as node:sqlite arguments. */
function bindArguments(sql: string, params: unknown): unknown[] {
  const args = params === undefined ? [] : Array.isArray(params) ? params : [params]
  const slots = parameterSlots(sql)
  const named = [...slots.names]
    .map(([index, name]) => ({ index, name, key: name.slice(1) }))
    .sort((a, b) => a.index - b.index)
  const anonymousCount = slots.count - slots.names.size
  const positional: unknown[] = []
  let namedValues: Record<string, unknown> | undefined
  const bindAnonymous = (value: unknown) => {
    const bound = bindable(value)
    if (positional.length >= anonymousCount) throw new RangeError('Too many parameter values were provided')
    positional.push(bound)
  }
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const value of arg) bindAnonymous(value)
    } else if (isPlainObject(arg)) {
      if (namedValues) throw new TypeError('You cannot specify named parameters in two different objects')
      namedValues = {}
      for (const { name, key } of named) {
        if (!Object.prototype.hasOwnProperty.call(arg, key)) throw new RangeError(`Missing named parameter "${key}"`)
        namedValues[name] = bindable(arg[key])
      }
    } else if (arg && typeof arg === 'object' && !ArrayBuffer.isView(arg) && named.length) {
      throw new TypeError('Named parameters can only be passed within plain objects')
    } else {
      bindAnonymous(arg)
    }
  }
  const bound = positional.length + (namedValues ? named.length : 0)
  if (bound < slots.count) {
    if (!namedValues && named.length) throw new TypeError('Missing named parameters')
    throw new RangeError('Too few parameter values were provided')
  }
  // Exact names, so neither node:sqlite's bare-name nor its unknown-name option can change what binds where.
  return namedValues ? [namedValues, ...positional] : positional
}

// The database.

function plainError(error: unknown): Error {
  return new Error(error instanceof Error ? error.message : String(error))
}

export function createFakeDatabase(): PluginDatabase {
  let db: SqliteDatabase | undefined
  let totalChanges: SqliteStatement | undefined

  const open = (): SqliteDatabase => {
    if (!db) {
      db = openSqlite()
      totalChanges = db.prepare('SELECT total_changes() AS n')
    }
    return db
  }

  const prepare = (sql: string): SqliteStatement => {
    const statement = open().prepare(sql)
    let first: string
    try {
      first = statement.sourceSQL
    } catch {
      // node:sqlite hands back a finalized statement for SQL with nothing to run.
      throw new RangeError('The supplied SQL string contains no statements')
    }
    if (sql.startsWith(first) && !onlyTrailingNoise(sql.slice(first.length))) {
      throw new RangeError('The supplied SQL string contains more than one statement')
    }
    // Plugins pass bare keys (`{ at }` for `:at`), but bindArguments already maps each one to the
    // exact name SQLite sees. node:sqlite's own bare-name lookup stays off, said explicitly: it
    // would refuse `:a` beside `@a`, which better-sqlite3 binds from the same key.
    statement.setAllowBareNamedParameters?.(false)
    return statement
  }

  const changesNow = () => Number(totalChanges!.get()!.n)

  const run = (sql: string, params: unknown): SqlRunResult => {
    const statement = prepare(sql)
    const args = bindArguments(sql, params)
    const before = changesNow()
    const result = statement.run(...args)
    // better-sqlite3 reports 0 for a statement that changed nothing (a SELECT, DDL), where
    // sqlite3_changes() would still hold the previous write's count.
    return { changes: changesNow() === before ? 0 : Number(result.changes), lastInsertRowid: result.lastInsertRowid }
  }

  const reader = (sql: string): SqliteStatement => {
    const statement = prepare(sql)
    if (statement.columns && statement.columns().length === 0) throw new TypeError('This statement does not return data. Use run() instead')
    return statement
  }

  const transaction = <T>(work: () => T): T => {
    // A savepoint behaves as BEGIN outside a transaction and nests inside one, like better-sqlite3's transaction().
    open().exec('SAVEPOINT walnut_fake_transaction')
    try {
      const value = work()
      db!.exec('RELEASE walnut_fake_transaction')
      return value
    } catch (error) {
      try {
        db!.exec('ROLLBACK TO walnut_fake_transaction')
        db!.exec('RELEASE walnut_fake_transaction')
      } catch { /* SQLite already rolled the transaction back */ }
      throw error
    }
  }

  // Every method runs synchronously when called, so calls apply in call order, as the host's single worker does.
  const call = <T>(work: () => T): Promise<T> => {
    try {
      return Promise.resolve(work())
    } catch (error) {
      return Promise.reject(plainError(error))
    }
  }

  return {
    exec(sql) {
      return call(() => { open().exec(sql) })
    },
    run(sql, params) {
      return call(() => run(sql, structuredClone(params)))
    },
    get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown) {
      return call(() => {
        // Cloned first, as the host's request is before its worker sees the SQL.
        const values = structuredClone(params)
        const row = reader(sql).get(...bindArguments(sql, values))
        return (row === undefined ? undefined : { ...row }) as T | undefined
      })
    },
    all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown) {
      return call(() => {
        const values = structuredClone(params)
        return reader(sql).all(...bindArguments(sql, values)).map((row) => ({ ...row }) as T)
      })
    },
    migrate(migrations) {
      return call(() => {
        const versions = new Set<number>()
        for (const migration of migrations) {
          if (!Number.isInteger(migration.version) || migration.version < 1) throw new Error('Migration versions must be positive integers')
          if (versions.has(migration.version)) throw new Error(`Duplicate migration version ${migration.version}`)
          versions.add(migration.version)
        }
        const database = open()
        database.exec(MIGRATIONS_TABLE)
        const current = Number(database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM _walnut_plugin_migrations').get()!.version)
        const pending = structuredClone(migrations).filter((migration) => migration.version > current).sort((a, b) => a.version - b.version)
        transaction(() => {
          for (const migration of pending) {
            database.exec(migration.sql)
            database.prepare('INSERT INTO _walnut_plugin_migrations(version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString())
          }
        })
        return pending.length ? pending[pending.length - 1].version : current
      })
    },
    batch(statements: SqlStatement[]) {
      if (!Array.isArray(statements)) {
        return Promise.reject(new TypeError('Plugin database batch takes an array of { sql, params } statements'))
      }
      for (const [index, statement] of statements.entries()) {
        if (!statement || typeof statement !== 'object' || typeof (statement as { sql?: unknown }).sql !== 'string') {
          return Promise.reject(new TypeError(`Plugin database batch statement ${index} must be an object with a string sql`))
        }
      }
      return call(() => {
        const copies = statements.map(({ sql, params }) => ({ sql, params: structuredClone(params) }))
        let failedAt = -1
        try {
          return transaction(() => {
            const results = copies.map(({ sql, params }, index) => {
              failedAt = index
              return run(sql, params)
            })
            failedAt = -1
            return results
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(failedAt >= 0
            ? `Plugin database batch failed at statement ${failedAt}, nothing was written: ${message}`
            : `Plugin database batch failed, nothing was written: ${message}`)
        }
      })
    },
  }
}
