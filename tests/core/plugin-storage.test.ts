import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('plugin-storage-test'))

import { WALNUT_HOME } from '../../src/constants.js'
import { PluginDatabaseClient, PluginSecretStore, PluginStorage } from '../../src/core/plugins/plugin-storage.js'

let storage: PluginStorage

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  storage = new PluginStorage(path.join(WALNUT_HOME, 'plugin-data', 'sample'))
})

afterEach(async () => {
  await storage.dispose()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('PluginStorage', () => {
  it('atomically reads, writes, updates, and lists owner-scoped files', async () => {
    await storage.writeJson('state/count.json', { count: 1 })
    await storage.updateJson('state/count.json', { count: 0 }, (current) => ({ count: current.count + 1 }))
    await storage.writeText('notes/readme.txt', 'hello')

    expect(await storage.readJson('state/count.json', { count: 0 })).toEqual({ count: 2 })
    expect(await storage.readText('notes/readme.txt')).toBe('hello')
    expect(await storage.list()).toEqual(['notes/readme.txt', 'state/count.json'])
    expect((await fs.stat(storage.dataDir)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(storage.dataDir, 'state', 'count.json'))).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.join(storage.dataDir, 'notes', 'readme.txt'))).mode & 0o777).toBe(0o600)
  })

  it('rejects traversal and absolute paths', async () => {
    await expect(storage.writeJson('../escape.json', {})).rejects.toThrow('Invalid Plugin storage path')
    await expect(storage.readText('/tmp/escape')).rejects.toThrow('Invalid Plugin storage path')
    await expect(storage.delete('folder/../../escape')).rejects.toThrow('Invalid Plugin storage path')
  })

  it('does not recreate resources after disposal', async () => {
    const database = storage.database
    await database.exec('CREATE TABLE state (id INTEGER PRIMARY KEY)')

    await storage.dispose()

    expect(() => storage.database).toThrow('Plugin storage is closed')
    await expect(storage.writeJson('state.json', {})).rejects.toThrow('Plugin storage is closed')
    await expect(database.exec('SELECT 1')).rejects.toThrow('Plugin database is closed')
  })

  it('loads the database driver independently of the process cwd', async () => {
    const previousCwd = process.cwd()
    const alternateCwd = path.join(WALNUT_HOME, 'alternate-cwd')
    const isolated = new PluginStorage(path.join(WALNUT_HOME, 'plugin-data', 'cwd-test'))
    await fs.mkdir(alternateCwd, { recursive: true })
    try {
      process.chdir(alternateCwd)
      await isolated.database.exec('CREATE TABLE state (id INTEGER PRIMARY KEY)')
      expect(await isolated.database.get<{ value: number }>('SELECT 1 AS value')).toEqual({ value: 1 })
    } finally {
      process.chdir(previousCwd)
      await isolated.dispose()
    }
  })

  it('fails immediately after its database worker dies', async () => {
    const database = new PluginDatabaseClient(
      path.join(WALNUT_HOME, 'plugin-data', 'dead.sqlite'),
      path.join(WALNUT_HOME, 'missing-driver.cjs'),
    )
    await expect(database.exec('SELECT 1')).rejects.toThrow()
    const started = Date.now()
    await expect(database.exec('SELECT 1')).rejects.toThrow('Plugin database worker is unavailable')
    expect(Date.now() - started).toBeLessThan(1_000)
    await database.dispose()
  })

  it('runs migrations and queries in the async database worker', async () => {
    expect(await storage.database.migrate([
      { version: 1, sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)' },
    ])).toBe(1)
    const result = await storage.database.run('INSERT INTO items(value) VALUES (?)', ['first'])

    expect(result.changes).toBe(1)
    expect(await storage.database.get<{ value: string }>('SELECT value FROM items WHERE id = ?', [1])).toEqual({ value: 'first' })
    expect(await storage.database.all<{ value: string }>('SELECT value FROM items')).toEqual([{ value: 'first' }])
    expect(await storage.database.migrate([
      { version: 1, sql: 'CREATE TABLE items (id INTEGER)' },
      { version: 2, sql: 'ALTER TABLE items ADD COLUMN note TEXT' },
    ])).toBe(2)
    expect((await fs.stat(storage.dataDir)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(storage.dataDir, 'plugin.sqlite'))).mode & 0o777).toBe(0o600)
  })
})

describe('PluginDatabaseClient bad input', () => {
  it('a parameter the worker cannot receive fails that call only; the database keeps working', async () => {
    const db = storage.database
    await db.exec('CREATE TABLE t (v TEXT)')
    await expect(db.run('INSERT INTO t (v) VALUES (?)', [() => 'not data'])).rejects.toThrow(/cannot be sent to the database worker/)
    await expect(db.batch([{ sql: 'INSERT INTO t (v) VALUES (?)', params: [Symbol('x')] as never }])).rejects.toThrow(/cannot be sent/)
    await db.run('INSERT INTO t (v) VALUES (?)', ['still here'])
    expect(await db.all('SELECT v FROM t')).toEqual([{ v: 'still here' }])
  })

  it('a bad migration list rejects instead of throwing', async () => {
    const db = storage.database
    let thrown: unknown = null
    let pending: Promise<number> | undefined
    try {
      pending = db.migrate([{ version: 0, sql: 'SELECT 1' }])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeNull()
    await expect(pending).rejects.toThrow('Migration versions must be positive integers')
    await expect(db.migrate([{ version: 1, sql: 'SELECT 1' }, { version: 1, sql: 'SELECT 2' }])).rejects.toThrow('Duplicate migration version 1')
  })
})

describe('PluginDatabaseClient.batch', () => {
  const insert = (value: string) => ({ sql: 'INSERT INTO items(value) VALUES (?)', params: [value] })
  const values = async () => (await storage.database.all<{ value: string }>('SELECT value FROM items ORDER BY id')).map((row) => row.value)

  beforeEach(async () => {
    await storage.database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)')
  })

  it('commits every statement in order and answers one result each', async () => {
    const results = await storage.database.batch([
      insert('a'),
      { sql: 'INSERT INTO items(value) VALUES (:value)', params: { value: 'b' } },
      { sql: "UPDATE items SET value = value || '!'" },
    ])

    expect(results).toEqual([
      { changes: 1, lastInsertRowid: 1 },
      { changes: 1, lastInsertRowid: 2 },
      { changes: 2, lastInsertRowid: 2 },
    ])
    expect(await values()).toEqual(['a!', 'b!'])
  })

  it('rolls the whole batch back when one statement fails and names its index', async () => {
    await expect(storage.database.batch([insert('a'), insert('a'), insert('c')]))
      .rejects.toThrow('Plugin database batch failed at statement 1, nothing was written: UNIQUE constraint failed: items.value')
    expect(await values()).toEqual([])

    // A binding error and a statement that does not compile name their index the same way.
    await expect(storage.database.batch([{ sql: 'INSERT INTO items(value) VALUES (:value)', params: {} }]))
      .rejects.toThrow('batch failed at statement 0, nothing was written: Missing named parameter "value"')
    await expect(storage.database.batch([insert('x'), insert('y'), { sql: 'INSERT INTO nowhere VALUES (1)' }]))
      .rejects.toThrow('batch failed at statement 2, nothing was written: no such table: nowhere')
    expect(await values()).toEqual([])

    // The database stays usable after a rollback.
    await storage.database.batch([insert('after')])
    expect(await values()).toEqual(['after'])
  })

  it('lets a later statement use the row id an earlier one created', async () => {
    await storage.database.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, tag TEXT NOT NULL)')
    await storage.database.run('INSERT INTO items(value) VALUES (?)', ['existing'])

    const results = await storage.database.batch([
      insert('parent'),
      { sql: 'INSERT INTO tags(item_id, tag) VALUES (last_insert_rowid(), ?)', params: ['first'] },
      { sql: "INSERT INTO tags(item_id, tag) VALUES ((SELECT id FROM items WHERE value = 'parent'), :tag)", params: { tag: 'second' } },
    ])

    expect(results.map((result) => result.lastInsertRowid)).toEqual([2, 1, 2])
    expect(await storage.database.all('SELECT items.value, tags.tag FROM tags JOIN items ON items.id = tags.item_id ORDER BY tags.id'))
      .toEqual([{ value: 'parent', tag: 'first' }, { value: 'parent', tag: 'second' }])
  })

  it('answers [] for an empty batch', async () => {
    expect(await storage.database.batch([])).toEqual([])
    expect(await values()).toEqual([])
  })

  it('rejects malformed input before anything runs', async () => {
    const database = storage.database
    await expect(database.batch('INSERT INTO items(value) VALUES (1)' as never)).rejects.toThrow('Plugin database batch takes an array of { sql, params } statements')
    await expect(database.batch([insert('a'), { params: ['b'] } as never])).rejects.toThrow('Plugin database batch statement 1 must be an object with a string sql')
    await expect(database.batch([null as never])).rejects.toThrow('Plugin database batch statement 0 must be an object with a string sql')
    await expect(database.batch([{ sql: 42 } as never])).rejects.toThrow('Plugin database batch statement 0 must be an object with a string sql')
    expect(await values()).toEqual([])

    // Only sql and params cross to the worker: an extra property never breaks the batch.
    expect(await database.batch([{ ...insert('a'), describe: () => 'not cloneable' } as never])).toHaveLength(1)
    expect(await values()).toEqual(['a'])
  })

  it('applies a run() issued while a batch is pending before or after it, never inside it', async () => {
    const failing = [...Array.from({ length: 500 }, (_, index) => insert(`bulk-${index}`)), insert('bulk-0')]
    const before = storage.database.run('INSERT INTO items(value) VALUES (?)', ['before'])
    const rolledBack = storage.database.batch(failing)
    const during = storage.database.run('INSERT INTO items(value) VALUES (?)', ['during'])

    await expect(rolledBack).rejects.toThrow('batch failed at statement 500')
    await before
    await during
    expect(await values()).toEqual(['before', 'during'])

    const committed = storage.database.batch([insert('one'), insert('two')])
    const next = storage.database.run('INSERT INTO items(value) VALUES (?)', ['next'])
    const [batchResults, nextResult] = await Promise.all([committed, next])
    // Both batch rows got their ids before the concurrent insert: it ran after the commit.
    expect(nextResult.lastInsertRowid).toBe(Number(batchResults[1].lastInsertRowid) + 1)
    expect(await values()).toEqual(['before', 'during', 'one', 'two', 'next'])
  })

  it('rejects once the storage is closed', async () => {
    const database = storage.database
    await storage.dispose()
    await expect(database.batch([insert('a')])).rejects.toThrow('Plugin database is closed')
  })
})

describe('PluginSecretStore', () => {
  it('stores secrets outside sync with mode 0600', async () => {
    const secrets = new PluginSecretStore('sample')
    await secrets.set('sample_key', 'fixture-value')

    expect(await secrets.get('sample_key')).toBe('fixture-value')
    expect(await secrets.keys()).toEqual(['sample_key'])
    const directory = path.join(WALNUT_HOME, 'secrets', 'plugins')
    const file = path.join(directory, 'sample.json')
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)

    await secrets.delete('sample_key')
    expect(await secrets.get('sample_key')).toBeUndefined()
  })

  it('rejects keys that could escape or confuse redaction', async () => {
    const secrets = new PluginSecretStore('sample')
    await expect(secrets.set('../token', 'value')).rejects.toThrow('Invalid Plugin secret key')
    await expect(secrets.set('space token', 'value')).rejects.toThrow('Invalid Plugin secret key')
  })
})
