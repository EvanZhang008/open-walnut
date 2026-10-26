/**
 * bindByIndex: the plugin database contract's binding (better-sqlite3's rules) shaped as one value
 * per SQLite parameter index, the form the host's worker hands bun:sqlite. The parity test
 * (plugin-database-parity.test.ts) compares the host with the fake call by call; this pins the
 * index mapping itself, and that both shapers of the one rule set refuse alike.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindArguments, bindByIndex } from '../../packages/plugin-api/src/sqlite-binding.js'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'

function refusal(work: () => unknown): { type: string; message: string } | null {
  try {
    work()
    return null
  } catch (error) {
    return { type: (error as Error).constructor.name, message: (error as Error).message }
  }
}

describe('bindByIndex', () => {
  it('fills a gap that ?NNN leaves with positional values, in index order', () => {
    // ?3 alone: SQLite counts 3 parameters, 1 and 2 anonymous.
    expect(bindByIndex('SELECT ?3', [{ 3: 'c' }, 'a', 'b'])).toEqual(['a', 'b', 'c'])
    expect(bindByIndex('SELECT ?3', ['a', 'b', { 3: 'c' }])).toEqual(['a', 'b', 'c'])
    expect(refusal(() => bindByIndex('SELECT ?3', ['a', 'b']))).toEqual({ type: 'TypeError', message: 'Missing named parameters' })
    expect(refusal(() => bindByIndex('SELECT ?3', [{ 3: 'c' }]))).toEqual({ type: 'RangeError', message: 'Too few parameter values were provided' })
    expect(refusal(() => bindByIndex('SELECT ?3', [{ 3: 'c' }, 'a', 'b', 'd']))).toEqual({ type: 'RangeError', message: 'Too many parameter values were provided' })
  })

  it('numbers a ? after ?2 as 3', () => {
    expect(bindByIndex('SELECT ?2 AS a, ? AS b', [{ 2: 'two' }, 'one', 'three'])).toEqual(['one', 'two', 'three'])
    expect(refusal(() => bindByIndex('SELECT ?2 AS a, ? AS b', [{ 2: 'two' }, 'one']))).toEqual({ type: 'RangeError', message: 'Too few parameter values were provided' })
  })

  it('binds a name used twice once, and the same key under two prefixes to both slots', () => {
    expect(bindByIndex('SELECT :a || :a', { a: 'v' })).toEqual(['v'])
    expect(bindByIndex('SELECT :a AS x, @a AS y, $a AS z', { a: 5 })).toEqual([5, 5, 5])
    // ?1 names the index :a already took.
    expect(bindByIndex('SELECT :a AS a, ?1 AS b', { a: 'shared' })).toEqual(['shared'])
  })

  it('puts named and positional values at their own indexes, whatever the argument order', () => {
    const sql = 'INSERT INTO t VALUES (:a, ?, @b, ?)'
    expect(bindByIndex(sql, [{ a: 1, b: 2 }, 'x', 'y'])).toEqual([1, 'x', 2, 'y'])
    expect(bindByIndex(sql, ['x', { b: 2, a: 1, extra: 'ignored' }, 'y'])).toEqual([1, 'x', 2, 'y'])
    expect(bindByIndex(sql, [['x', 'y'], { a: 1, b: 2 }])).toEqual([1, 'x', 2, 'y'])
  })

  it('answers exactly count values, none for literals and comments', () => {
    expect(bindByIndex("SELECT '12:30 ? @x', :a -- :b ?\n", { a: 1 })).toEqual([1])
    expect(bindByIndex('SELECT 1')).toEqual([])
    expect(bindByIndex('SELECT ?', null)).toEqual([null])
    expect(bindByIndex('SELECT ?, ?', [undefined, new Uint8Array([1])])).toEqual([null, new Uint8Array([1])])
  })

  it('refuses too few and too many positional values', () => {
    expect(refusal(() => bindByIndex('INSERT INTO t VALUES (?, ?)', ['one']))).toEqual({ type: 'RangeError', message: 'Too few parameter values were provided' })
    expect(refusal(() => bindByIndex('INSERT INTO t VALUES (?)', ['one', 'two']))).toEqual({ type: 'RangeError', message: 'Too many parameter values were provided' })
    expect(refusal(() => bindByIndex('INSERT INTO t VALUES (?)'))).toEqual({ type: 'RangeError', message: 'Too few parameter values were provided' })
  })

  it('refuses what better-sqlite3 refuses for named parameters', () => {
    expect(refusal(() => bindByIndex('SELECT :a', {}))).toEqual({ type: 'RangeError', message: 'Missing named parameter "a"' })
    expect(refusal(() => bindByIndex('SELECT :a', { ':a': 1 }))).toEqual({ type: 'RangeError', message: 'Missing named parameter "a"' })
    expect(refusal(() => bindByIndex('SELECT :a'))).toEqual({ type: 'TypeError', message: 'Missing named parameters' })
    expect(refusal(() => bindByIndex('SELECT :a', [{ a: 1 }, { a: 2 }]))).toEqual({ type: 'TypeError', message: 'You cannot specify named parameters in two different objects' })
    expect(refusal(() => bindByIndex('SELECT :a', [new Date(0)]))).toEqual({ type: 'TypeError', message: 'Named parameters can only be passed within plain objects' })
    expect(refusal(() => bindByIndex('SELECT ?', [true]))).toEqual({ type: 'TypeError', message: 'SQLite3 can only bind numbers, strings, bigints, buffers, and null' })
  })

  it('refuses a bigint outside 64 bits, which bun:sqlite would bind as 0', () => {
    expect(bindByIndex('SELECT ?, ?', [2n ** 63n - 1n, -(2n ** 63n)])).toEqual([2n ** 63n - 1n, -(2n ** 63n)])
    expect(refusal(() => bindByIndex('SELECT ?', [2n ** 63n]))).toEqual({ type: 'RangeError', message: 'The bound string, buffer, or bigint is too big' })
    expect(refusal(() => bindByIndex('SELECT :a', { a: -(2n ** 63n) - 1n }))).toEqual({ type: 'RangeError', message: 'The bound string, buffer, or bigint is too big' })
    // The fake leaves this one to node:sqlite, which refuses it in its own words.
    expect(bindArguments('SELECT ?', [2n ** 63n])).toEqual([2n ** 63n])
  })

  it('refuses exactly when bindArguments does, with the same class and message', () => {
    const cases: Array<[string, unknown]> = [
      ['SELECT :a', { a: 1 }], ['SELECT :a', {}], ['SELECT :a', { ':a': 1 }], ['SELECT :a', undefined],
      ['SELECT :a', [{ a: 1 }, { a: 2 }]], ['SELECT ?, ?', ['one']], ['SELECT ?', ['a', 'b']],
      ['SELECT ?', [true]], ['SELECT ?', [undefined]], ['SELECT ?', null], ['SELECT :a, ?', [{ a: 1 }, 'p']],
      ['SELECT ?1', { 1: 'n' }], ['SELECT ?1', ['n']], ['SELECT ?3', [{ 3: 't' }, 'x', 'y']], ['SELECT ?3', ['x', 'y']],
      ['SELECT ?2, ?', [{ 2: 'two' }, 'one']], ['SELECT ? AS x', [new Date(0)]], ['SELECT :a AS x', [new Date(0)]],
      ['SELECT ?, ?', [[1], 2]], ['SELECT ?', [10n]], ['SELECT #n', { n: 1 }], ['SELECT :\u00e9', { '\u00e9': 3 }],
    ]
    for (const [sql, params] of cases) {
      expect({ sql, params, refusal: refusal(() => bindByIndex(sql, params)) })
        .toEqual({ sql, params, refusal: refusal(() => bindArguments(sql, params)) })
    }
  })
})

describe('the host binds through bindByIndex', () => {
  let dir: string
  let host: PluginDatabaseClient

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-database-binding-'))
    host = new PluginDatabaseClient(path.join(dir, 'plugin.sqlite'))
  })

  afterAll(async () => {
    await host?.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('binds every index as better-sqlite3 would', async () => {
    // The ? after ?2 is index 3; the first positional value goes to index 1, which no text names.
    expect(await host.get('SELECT ?2 AS a, ? AS b', [{ 2: 'two' }, 'one', 'three'])).toEqual({ a: 'two', b: 'three' })
    expect(await host.get('SELECT ?1 AS a', [{ 1: 'one' }])).toEqual({ a: 'one' })
    expect(await host.get('SELECT ? AS a, ? AS b, ?3 AS c', [{ 3: 'c' }, 'a', 'b'])).toEqual({ a: 'a', b: 'b', c: 'c' })
    expect(await host.get('SELECT :a AS x, ? AS p, @a AS y', ['positional', { a: 'named' }])).toEqual({ x: 'named', p: 'positional', y: 'named' })
    expect(await host.get('SELECT typeof(?) AS t', [2n ** 63n - 1n])).toEqual({ t: 'integer' })
  })

  it('refuses a bigint outside 64 bits instead of writing 0', async () => {
    await expect(host.get('SELECT ? AS x', [2n ** 64n])).rejects.toThrow('The bound string, buffer, or bigint is too big')
  })

  it('refuses get and all on a statement that returns no data before binding it', async () => {
    await host.exec('CREATE TABLE IF NOT EXISTS w (a)')
    await expect(host.get('INSERT INTO w VALUES (:a)', {})).rejects.toThrow('This statement does not return data. Use run() instead')
    await expect(host.all('INSERT INTO w VALUES (1)')).rejects.toThrow('This statement does not return data. Use run() instead')
    expect(await host.get('SELECT COUNT(*) AS n FROM w')).toEqual({ n: 0 })
    expect(await host.get('INSERT INTO w VALUES (?) RETURNING a', ['returned'])).toEqual({ a: 'returned' })
  })

  it('refuses SQL with no statement in run, get, all and a batch', async () => {
    for (const sql of ['', '  ', ';', '-- nothing\n;', '/* nothing */']) {
      await expect(host.run(sql)).rejects.toThrow('The supplied SQL string contains no statements')
      await expect(host.get(sql)).rejects.toThrow('The supplied SQL string contains no statements')
      await expect(host.all(sql)).rejects.toThrow('The supplied SQL string contains no statements')
    }
    await expect(host.batch([{ sql: 'SELECT 1' }, { sql: ' ; ' }]))
      .rejects.toThrow('Plugin database batch failed at statement 1, nothing was written: The supplied SQL string contains no statements')
  })
})
