/**
 * What better-sqlite3 refused and bun:sqlite accepts without a word, refused
 * again (src/lib/sqlite-guards.ts, used by src/lib/sqlite.ts): a prepare() of
 * two statements (bun runs the first and drops the second) and a transaction
 * function that returns a promise (bun commits before its awaits run).
 * Every call site was checked first: none prepares two statements or passes
 * an async function to a transaction.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database, { type Database as DatabaseType } from '../../src/lib/sqlite.js'
import { hasSecondStatement } from '../../src/lib/sqlite-guards.js'

describe('hasSecondStatement: where a statement ends, as sqlite3_complete() reads it', () => {
  it('finds a second statement', () => {
    for (const sql of [
      'SELECT 1; SELECT 2',
      'SELECT 1;SELECT 2;',
      "INSERT INTO t VALUES ('a'); DELETE FROM t",
      'SELECT 1; -- a comment\nSELECT 2',
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END; SELECT 2',
      'SELECT 1; x',
    ]) expect(hasSecondStatement(sql), sql).toBe(true)
  })

  it('takes one statement with what better-sqlite3 allowed after it, and every ; that ends nothing', () => {
    for (const sql of [
      'SELECT 1',
      'SELECT 1;',
      'SELECT 1;;  ;\n',
      'SELECT 1; -- trailing comment',
      'SELECT 1; /* trailing\ncomment */ ;',
      ';; SELECT 1',
      "SELECT 'a;b', \"c;d\", [e;f], `g;h` FROM t",
      "SELECT 'it''s; fine'",
      'SELECT 1 -- ; not a statement\n',
      'SELECT /* ; */ 1',
      // A trigger body holds statements of its own; the trigger is one statement.
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO u VALUES (1); UPDATE u SET x = 2; END',
      'create temp trigger tr after delete on t begin select case when 1 then 2 end; end;',
      // Words that only look like the trigger keywords.
      'CREATE TABLE trigger_log (end_at TEXT, temp INTEGER); ',
      'SELECT "end" FROM t; ',
      '',
      '   ',
      'SELECT 1; /* unterminated',
      // Non-ASCII names are identifier characters.
      'SELECT été FROM t;',
    ]) expect(hasSecondStatement(sql), sql).toBe(false)
  })
})

describe('the shim refuses what better-sqlite3 refused', () => {
  let dir: string
  let db: DatabaseType
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sqlite-guards-'))
    db = new Database(path.join(dir, 'a.db'))
    db.exec('CREATE TABLE t (x INTEGER)')
  })
  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('prepare and pragma of two statements throw, and nothing of either runs', () => {
    expect(() => db.prepare('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)')).toThrow(RangeError)
    expect(() => db.prepare('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)')).toThrow('The supplied SQL string contains more than one statement')
    expect(() => db.pragma('user_version = 7; DROP TABLE t')).toThrow('more than one statement')
    expect(db.prepare('SELECT count(*) FROM t').pluck().get()).toBe(0)
    expect(db.pragma('user_version', { simple: true })).toBe(0)
    // exec() runs many statements, as in better-sqlite3.
    db.exec('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);')
    expect(db.prepare('SELECT count(*) FROM t; -- one statement').pluck().get()).toBe(2)
  })

  it('a transaction function that returns a promise throws, and the transaction rolls back', async () => {
    let resumed = false
    const tx = db.transaction(async () => {
      db.prepare('INSERT INTO t VALUES (1)').run()
      await Promise.resolve()
      resumed = true
    })
    expect(() => tx()).toThrow(new TypeError('Transaction function cannot return a promise'))
    expect(db.inTransaction).toBe(false)
    expect(db.prepare('SELECT count(*) FROM t').pluck().get()).toBe(0)
    await Promise.resolve()
    expect(resumed).toBe(true)
    // A function that returns a value still commits, in each mode, nested too.
    const add = db.transaction((n: number) => { db.prepare('INSERT INTO t VALUES (?)').run(n); return n })
    expect(add(1)).toBe(1)
    expect(add.immediate(2)).toBe(2)
    expect(db.transaction(() => add.deferred(3))()).toBe(3)
    expect(db.prepare('SELECT x FROM t ORDER BY x').pluck().all()).toEqual([1, 2, 3])
  })
})
