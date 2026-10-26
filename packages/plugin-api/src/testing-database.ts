import type { PluginDatabase, SqlRunResult, SqlStatement } from './server.js'
import { bindArguments, onlyTrailingNoise } from './sqlite-binding.js'

// The fake's `walnut.storage.database`: a real in-memory SQLite (Node's built-in node:sqlite)
// that answers the way the host's database does. The host runs its SQLite in a worker, so
// every rule here restates one of the host's: values cross a structured clone, parameters bind
// by better-sqlite3's rules (bare names for :name, @name and $name, arrays as positional values,
// the same "Missing named parameter" and "Too few/many" refusals; sqlite-binding.ts, which the
// host's worker binds through too), errors arrive as a plain Error carrying only the message,
// rows are plain objects, and migrate/batch keep the host's table, ordering, transaction and
// messages.

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
