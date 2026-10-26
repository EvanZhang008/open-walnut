import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { WALNUT_HOME } from '../../constants.js'
import { sqliteModuleFile } from '../../lib/sqlite.js'
import { readJsonFile, updateJsonFile, writeJsonFile } from '../../utils/fs.js'
import type { Disposable } from './disposable.js'
import { validatePluginId } from './ids.js'
import { sortedByName } from '../../lib/dir-order.js'

const DB_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const driver = require(workerData.driver)
const Database = typeof driver === 'function' ? driver : driver.default
const { bindByIndex, onlyTrailingNoise } = driver
if (typeof bindByIndex !== 'function' || typeof onlyTrailingNoise !== 'function') {
  throw new Error('Plugin database driver ' + workerData.driver + ' has no plugin parameter binding (bindByIndex)')
}
const directory = path.dirname(workerData.file)
fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
fs.chmodSync(directory, 0o700)
const db = new Database(workerData.file)
fs.chmodSync(workerData.file, 0o600)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

// A plugin's statement answers as better-sqlite3's did (the plugin API contract): its
// prepare refusals, get/all only on a statement that returns data, and its binding rules
// (packages/plugin-api/src/sqlite-binding.ts, shared with the fake database), handed to
// bun:sqlite as one value per parameter index.
function invoke(sql, method, params) {
  if (typeof sql === 'string' && onlyTrailingNoise(sql)) {
    throw new RangeError('The supplied SQL string contains no statements')
  }
  const statement = db.prepare(sql)
  if (method !== 'run' && !statement.reader) {
    throw new TypeError('This statement does not return data. Use run() instead')
  }
  const values = bindByIndex(sql, params)
  // The rules count parameters as better-sqlite3's SQLite does; a build that reads one more
  // form (Tcl's $a::b and $a(x), which the system SQLite keeps) would bind them elsewhere.
  if (statement.paramsCount !== values.length) {
    throw new RangeError('This SQL has ' + statement.paramsCount + ' parameters for SQLite here but ' + values.length + ' by the plugin API rules; name parameters with ?, ?NNN, :name, @name or $name')
  }
  return statement[method](values)
}

parentPort.on('message', ({ id, method, args }) => {
  try {
    let value
    if (method === 'exec') {
      db.exec(args.sql)
    } else if (method === 'run' || method === 'get' || method === 'all') {
      value = invoke(args.sql, method, args.params)
    } else if (method === 'migrate') {
      db.exec('CREATE TABLE IF NOT EXISTS _walnut_plugin_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
      const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM _walnut_plugin_migrations').get().version
      const pending = args.migrations.filter((migration) => migration.version > current).sort((a, b) => a.version - b.version)
      const apply = db.transaction(() => {
        for (const migration of pending) {
          db.exec(migration.sql)
          db.prepare('INSERT INTO _walnut_plugin_migrations(version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString())
        }
      })
      apply()
      value = pending.length ? pending[pending.length - 1].version : current
    } else if (method === 'batch') {
      // One message, one transaction: no other request of this plugin can land in the middle.
      let failedAt = -1
      const apply = db.transaction((statements) => {
        const results = []
        for (let index = 0; index < statements.length; index++) {
          failedAt = index
          const result = invoke(statements[index].sql, 'run', statements[index].params)
          results.push({ changes: result.changes, lastInsertRowid: result.lastInsertRowid })
        }
        failedAt = -1
        return results
      })
      try {
        value = apply(args.statements)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(failedAt >= 0
          ? 'Plugin database batch failed at statement ' + failedAt + ', nothing was written: ' + message
          : 'Plugin database batch failed, nothing was written: ' + message)
      }
    } else if (method === 'close') {
      db.close()
    } else {
      throw new Error('Unknown plugin database method: ' + method)
    }
    parentPort.postMessage({ id, ok: true, value })
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
`

// The worker shares no module with this thread, so it loads src/lib/sqlite.ts
// itself (dist/lib/sqlite.js in a build): the same bun:sqlite as the server.
const SQLITE_DRIVER_PATH = sqliteModuleFile()

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class PluginDatabaseClient implements Disposable {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private disposed = false
  private dead = false

  constructor(filePath: string, driverPath = SQLITE_DRIVER_PATH) {
    if (!driverPath) throw new Error('Plugin database driver not found (dist/lib/sqlite.js is missing from this build)')
    this.worker = new Worker(DB_WORKER_SOURCE, {
      eval: true,
      workerData: { file: filePath, driver: driverPath },
    })
    this.worker.on('message', (message: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.error ?? 'Plugin database request failed'))
    })
    this.worker.on('error', (error) => {
      this.dead = true
      this.failAll(error instanceof Error ? error : new Error(String(error)))
    })
    this.worker.on('exit', (code) => {
      if (this.disposed) return
      this.dead = true
      this.failAll(new Error(`Plugin database worker exited with code ${code}`))
    })
  }

  exec(sql: string): Promise<void> {
    return this.request('exec', { sql }) as Promise<void>
  }

  run(sql: string, params?: unknown): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    return this.request('run', { sql, params }) as Promise<{ changes: number; lastInsertRowid: number | bigint }>
  }

  get<T extends Record<string, unknown>>(sql: string, params?: unknown): Promise<T | undefined> {
    return this.request('get', { sql, params }) as Promise<T | undefined>
  }

  all<T extends Record<string, unknown>>(sql: string, params?: unknown): Promise<T[]> {
    return this.request('all', { sql, params }) as Promise<T[]>
  }

  migrate(migrations: Array<{ version: number; sql: string }>): Promise<number> {
    // A bad list is a rejected promise like every other failure here, never a synchronous throw.
    const versions = new Set<number>()
    for (const migration of migrations) {
      if (!Number.isInteger(migration.version) || migration.version < 1) return Promise.reject(new Error('Migration versions must be positive integers'))
      if (versions.has(migration.version)) return Promise.reject(new Error(`Duplicate migration version ${migration.version}`))
      versions.add(migration.version)
    }
    return this.request('migrate', { migrations }) as Promise<number>
  }

  /** Runs every statement with `run`, in order, in one transaction: all of them commit or none does. */
  batch(statements: Array<{ sql: string; params?: unknown }>): Promise<Array<{ changes: number; lastInsertRowid: number | bigint }>> {
    if (!Array.isArray(statements)) {
      return Promise.reject(new TypeError('Plugin database batch takes an array of { sql, params } statements'))
    }
    const copies: Array<{ sql: string; params?: unknown }> = []
    for (const [index, statement] of statements.entries()) {
      if (!statement || typeof statement !== 'object' || typeof (statement as { sql?: unknown }).sql !== 'string') {
        return Promise.reject(new TypeError(`Plugin database batch statement ${index} must be an object with a string sql`))
      }
      // Only the two fields cross to the worker, so an extra property can never fail the structured clone.
      copies.push({ sql: statement.sql, params: statement.params })
    }
    return this.request('batch', { statements: copies }) as Promise<Array<{ changes: number; lastInsertRowid: number | bigint }>>
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (!this.dead) {
      try { await this.requestRaw('close', {}, 2_000) } catch { /* terminate below */ }
    }
    await this.worker.terminate()
    this.dead = true
    this.failAll(new Error('Plugin database is closed'))
  }

  private request(method: string, args: unknown): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('Plugin database is closed'))
    if (this.dead) return Promise.reject(new Error('Plugin database worker is unavailable'))
    return this.requestRaw(method, args, 30_000)
  }

  private requestRaw(method: string, args: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Plugin database ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.worker.postMessage({ id, method, args })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        // Parameters that cannot be copied to the worker (a function, a symbol) fail this one
        // call. The worker is fine, so the plugin's later calls must keep working.
        if ((error as { name?: unknown } | null)?.name === 'DataCloneError') {
          reject(new TypeError(`Plugin database ${method} got parameters that cannot be sent to the database worker: ${(error as Error).message}`))
          return
        }
        this.dead = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function safeRelativeName(name: string): string {
  const normalized = name.trim().replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('\0')) {
    throw new Error(`Invalid Plugin storage path: ${JSON.stringify(name)}`)
  }
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error(`Invalid Plugin storage path: ${JSON.stringify(name)}`)
  }
  return segments.join('/')
}

async function ensurePrivateParent(root: string, filePath: string): Promise<void> {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(root, 0o700)
  if (directory !== root) await fs.chmod(directory, 0o700)
}

async function writeTextAtomic(filePath: string, value: string, mode?: number): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const temporary = path.join(dir, `.open-walnut-${crypto.randomBytes(8).toString('hex')}.tmp`)
  try {
    await fs.writeFile(temporary, value, { encoding: 'utf8', ...(mode ? { mode } : {}) })
    await fs.rename(temporary, filePath)
    if (mode) await fs.chmod(filePath, mode)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export class PluginStorage implements Disposable {
  private databaseClient: PluginDatabaseClient | null = null
  private disposed = false

  constructor(readonly dataDir: string) {}

  async readJson<T>(name: string, fallback: T): Promise<T> {
    this.assertActive()
    return readJsonFile(this.resolve(name), fallback)
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    this.assertActive()
    const file = this.resolve(name)
    await ensurePrivateParent(this.dataDir, file)
    return writeJsonFile(file, value, { mode: 0o600 })
  }

  async updateJson<T>(name: string, fallback: T, update: (current: T) => T | Promise<T>): Promise<T> {
    this.assertActive()
    const file = this.resolve(name)
    await ensurePrivateParent(this.dataDir, file)
    return updateJsonFile(file, fallback, update, { mode: 0o600 })
  }

  async readText(name: string): Promise<string | null> {
    this.assertActive()
    try { return await fs.readFile(this.resolve(name), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async writeText(name: string, value: string): Promise<void> {
    this.assertActive()
    const file = this.resolve(name)
    await ensurePrivateParent(this.dataDir, file)
    return writeTextAtomic(file, value, 0o600)
  }

  async delete(name: string): Promise<void> {
    this.assertActive()
    await fs.rm(this.resolve(name), { force: true })
  }

  async list(prefix = ''): Promise<string[]> {
    this.assertActive()
    const base = prefix ? this.resolve(prefix) : this.dataDir
    const output: string[] = []
    const queue = [base]
    while (queue.length > 0 && output.length < 1_000) {
      const current = queue.shift()!
      let entries
      try { entries = sortedByName(await fs.readdir(current, { withFileTypes: true })) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const entry of entries) {
        const absolute = path.join(current, entry.name)
        if (entry.isDirectory()) queue.push(absolute)
        else if (entry.isFile()) output.push(path.relative(this.dataDir, absolute).replace(/\\/g, '/'))
      }
    }
    return output.sort()
  }

  get database(): PluginDatabaseClient {
    this.assertActive()
    if (!this.databaseClient) {
      const file = this.resolve('plugin.sqlite')
      this.databaseClient = new PluginDatabaseClient(file)
    }
    return this.databaseClient
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.databaseClient?.dispose()
    this.databaseClient = null
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Plugin storage is closed')
  }

  private resolve(name: string): string {
    const relative = safeRelativeName(name)
    const absolute = path.resolve(this.dataDir, relative)
    const root = path.resolve(this.dataDir)
    if (!absolute.startsWith(root + path.sep)) throw new Error(`Plugin storage path escapes data directory: ${name}`)
    return absolute
  }
}

export class PluginSecretStore {
  private readonly filePath: string

  constructor(pluginId: string) {
    this.filePath = path.join(WALNUT_HOME, 'secrets', 'plugins', `${validatePluginId(pluginId)}.json`)
  }

  async get(name: string): Promise<string | undefined> {
    this.validateKey(name)
    return (await readJsonFile<Record<string, string>>(this.filePath, {}))[name]
  }

  async set(name: string, value: string): Promise<void> {
    this.validateKey(name)
    if (typeof value !== 'string') throw new Error('Plugin secret value must be a string')
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    await updateJsonFile<Record<string, string>>(this.filePath, {}, (current) => {
      current[name] = value
      return current
    }, { mode: 0o600 })
    await fs.chmod(path.dirname(this.filePath), 0o700)
    await fs.chmod(this.filePath, 0o600)
  }

  async delete(name: string): Promise<void> {
    this.validateKey(name)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    await fs.chmod(path.dirname(this.filePath), 0o700)
    await updateJsonFile<Record<string, string>>(this.filePath, {}, (current) => {
      delete current[name]
      return current
    }, { mode: 0o600 })
  }

  async keys(): Promise<string[]> {
    return Object.keys(await readJsonFile<Record<string, string>>(this.filePath, {})).sort()
  }

  private validateKey(name: string): void {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(name)) throw new Error(`Invalid Plugin secret key: ${JSON.stringify(name)}`)
  }
}
