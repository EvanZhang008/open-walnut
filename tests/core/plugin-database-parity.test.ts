/**
 * The fake `walnut.storage.database` (`@open-walnut/plugin-api/testing`) must answer the way the
 * host's does, or a plugin test that passes against it proves nothing. This runs the same calls
 * against the host client (better-sqlite3 in a worker) and the fake (node:sqlite in memory) and
 * compares what each answered, values and refusals alike.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import { createFakeWalnut } from '../../packages/plugin-api/src/testing.js'
import type { PluginDatabase } from '../../packages/plugin-api/src/server.js'

let dir: string
let host: PluginDatabaseClient
let fake: PluginDatabase

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-database-parity-'))
  host = new PluginDatabaseClient(path.join(dir, 'plugin.sqlite'))
  fake = createFakeWalnut().api.storage.database
  for (const db of [host, fake]) {
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b BLOB)')
    await db.exec('CREATE TABLE x (a)')
  }
})

afterAll(async () => {
  await host?.dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

type Call = [method: 'run' | 'get' | 'all', sql: string, params?: unknown]

async function outcome(db: PluginDatabase, [method, sql, params]: Call): Promise<unknown> {
  try {
    return { ok: await (db[method] as (sql: string, params?: unknown) => Promise<unknown>)(sql, params) }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

// In order: each call sees the rows the earlier ones wrote, in both databases.
const CALLS: Call[] = [
  ['run', 'INSERT INTO t(a) VALUES (:a)', { a: 'colon' }],
  ['run', 'INSERT INTO t(a) VALUES (@a)', { a: 'at' }],
  ['run', 'INSERT INTO t(a) VALUES ($a)', { a: 'dollar' }],
  ['run', 'INSERT INTO t(a) VALUES (:a)', { ':a': 'prefixed key' }],
  ['run', 'INSERT INTO t(a) VALUES (:a)', { a: 'extra key', extra: 1 }],
  ['run', 'INSERT INTO t(a) VALUES (:a)', {}],
  ['run', 'INSERT INTO t(a) VALUES (:a)'],
  ['run', 'INSERT INTO t(a) VALUES (:a)', [{ a: 1 }, { a: 2 }]],
  ['run', 'INSERT INTO t(a, b) VALUES (?, ?)', ['blob', new Uint8Array([1, 2])]],
  ['run', 'INSERT INTO t(a, b) VALUES (?, ?)', ['too few']],
  ['run', 'INSERT INTO t(a) VALUES (?)', ['too', 'many']],
  ['run', 'INSERT INTO t(a) VALUES (?)'],
  ['run', 'INSERT INTO t(a) VALUES (?)', [true]],
  ['run', 'INSERT INTO t(a) VALUES (?)', [undefined]],
  ['run', 'INSERT INTO t(a) VALUES (?)', null],
  ['run', 'INSERT INTO t(a) VALUES (:a)', { a: undefined }],
  ['run', 'INSERT INTO t(a, b) VALUES (:a, ?)', [{ a: 'mixed' }, 'positional']],
  ['run', "INSERT INTO t(a) VALUES ('12:30 ? @x $y')"],
  ['run', 'INSERT INTO t(a) VALUES (?1)', { 1: 'numbered' }],
  ['run', 'INSERT INTO t(a) VALUES (?1)', ['numbered positional']],
  ['run', 'INSERT INTO t(a) VALUES (?3)', [{ 3: 'third' }, 'x', 'y']],
  ['run', 'INSERT INTO t(a) VALUES (?3)', ['x', 'y']],
  ['run', 'INSERT INTO t(a) VALUES (:a) -- :b ?\n', { a: 'line comment' }],
  ['run', 'INSERT INTO t(a) VALUES (:a) /* :b ? */', { a: 'block comment' }],
  ['run', 'INSERT INTO t("a") VALUES (:a)', { a: 'quoted' }],
  ['run', 'INSERT INTO t([a]) VALUES (:a)', { a: 'bracketed' }],
  ['run', 'INSERT INTO t(`a`) VALUES (:a || :a)', { a: 'twice' }],
  ['run', 'INSERT INTO x VALUES (#name)', { name: 1 }],
  ['run', 'CREATE TABLE u (id INTEGER PRIMARY KEY)'],
  ['run', 'SELECT 1'],
  ['run', 'UPDATE t SET a = a WHERE id = -1'],
  ['run', 'UPDATE t SET a = a'],
  ['run', 'NOT SQL'],
  ['run', ''],
  ['run', '-- nothing\n;'],
  ['run', 'SELECT 1; SELECT 2'],
  ['run', 'SELECT 1; -- trailing\n /* more */ ;'],
  ['run', 'CREATE TRIGGER tr AFTER INSERT ON x BEGIN SELECT 1; SELECT 2; END;'],
  ['run', 'CREATE TRIGGER tr2 AFTER INSERT ON x BEGIN SELECT 1; END; SELECT 3'],
  ['run', 'INSERT INTO u VALUES (1)'],
  ['run', 'INSERT INTO u VALUES (1)'],
  ['get', 'SELECT a, b FROM t WHERE b IS NOT NULL'],
  ['get', 'SELECT * FROM t WHERE id = -1'],
  ['get', 'INSERT INTO t(a) VALUES (1)'],
  ['all', 'SELECT id, a FROM t ORDER BY id'],
  ['all', 'SELECT id FROM t WHERE a LIKE :p ORDER BY id', { p: 'b%' }],
  ['get', "SELECT json_extract('{\"a\":1}', '$.a') AS v"],
  ['get', 'SELECT a$b FROM (SELECT 1 AS a$b)'],
  ['get', "SELECT 'it''s :x' AS v, :y AS w", { y: 2 }],
  ['get', 'SELECT :a AS x, @a AS y', { a: 5 }],
  // A non-ASCII parameter name (e with acute accent).
  ['get', 'SELECT :\u00e9 AS v', { '\u00e9': 3 }],
  ['get', 'SELECT ?2 AS a, ? AS b', [{ 2: 'two' }, 'one']],
  ['get', 'SELECT :a AS a, ?1 AS b', { a: 'shared index' }],
  ['get', 'SELECT ? AS x', [new Date(0)]],
  ['get', 'SELECT :a AS x', [new Date(0)]],
  ['get', 'SELECT ? AS v, ? AS w', [[1], 2]],
  ['get', 'SELECT ? AS x', [10n]],
  ['get', "SELECT x'0102' AS v, 1e5 AS w, 0x1F AS z"],
  ['get', 'SELECT last_insert_rowid() AS id'],
]

describe('the fake plugin database answers like the host', () => {
  it.each(CALLS.map((call, index) => ({ index, label: `${call[0]} ${JSON.stringify(call[1])}` })))('call $index: $label', async ({ index }) => {
    const call = CALLS[index]
    expect(await outcome(fake, call)).toEqual(await outcome(host, call))
  })

  it('agrees on a batch, its rollback and its error', async () => {
    const statements = [
      { sql: 'INSERT INTO t(a) VALUES (?)', params: ['batch one'] },
      { sql: 'INSERT INTO t(a) VALUES (:a)', params: { a: 'batch two' } },
      { sql: 'INSERT INTO u VALUES (1)' },
    ]
    const count = 'SELECT COUNT(*) AS n FROM t'
    const answers = async (db: PluginDatabase) => {
      const failed = await db.batch(statements).then((value) => ({ ok: value }), (error: Error) => ({ error: error.message }))
      const committed = await db.batch(statements.slice(0, 2))
      return { failed, committed, rows: await db.get(count) }
    }
    expect(await answers(fake)).toEqual(await answers(host))
  })

  it('agrees on a batch inside a transaction the plugin opened', async () => {
    const answers = async (db: PluginDatabase) => {
      await db.exec('BEGIN')
      await db.run('INSERT INTO t(a) VALUES (?)', ['outer'])
      const failed = await db.batch([
        { sql: 'INSERT INTO t(a) VALUES (?)', params: ['inner'] },
        { sql: 'INSERT INTO u VALUES (1)' },
      ]).catch((error: Error) => error.message)
      await db.exec('COMMIT')
      return { failed, rows: await db.all("SELECT a FROM t WHERE a IN ('outer', 'inner') ORDER BY id") }
    }
    expect(await answers(fake)).toEqual(await answers(host))
  })

  it('agrees on migrate', async () => {
    const migrations = [
      { version: 2, sql: 'ALTER TABLE m ADD COLUMN note TEXT' },
      { version: 1, sql: 'CREATE TABLE m (id INTEGER PRIMARY KEY)' },
    ]
    const answers = async (db: PluginDatabase) => ({
      first: await db.migrate(migrations),
      again: await db.migrate(migrations),
      broken: await db.migrate([{ version: 3, sql: 'NOT SQL' }]).catch((error: Error) => error.message),
      versions: await db.all('SELECT version FROM _walnut_plugin_migrations ORDER BY version'),
    })
    expect(await answers(fake)).toEqual(await answers(host))
  })
})
