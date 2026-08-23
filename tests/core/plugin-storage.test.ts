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
