/**
 * One compiled statement per connection and SQL text (src/lib/sqlite-prepared.ts): the same text
 * gives the same statement, a plucked one is its own, and another connection compiles its own.
 */
import { describe, expect, it } from 'vitest'
import Database from '../../src/lib/sqlite.js'
import { prepared } from '../../src/lib/sqlite-prepared.js'

describe('prepared', () => {
  it('compiles a text once per connection; pluck is its own entry; results are as a fresh statement gives them', () => {
    const a = new Database(':memory:')
    const b = new Database(':memory:')
    try {
      for (const db of [a, b]) {
        db.exec('CREATE TABLE t (k TEXT, v INTEGER)')
        db.prepare('INSERT INTO t VALUES (?, ?)').run('x', 1)
      }
      const sql = 'SELECT v FROM t WHERE k = ?'
      expect(prepared(a, sql)).toBe(prepared(a, sql))
      expect(prepared(a, sql, 'pluck')).not.toBe(prepared(a, sql))
      expect(prepared(b, sql)).not.toBe(prepared(a, sql))
      expect(prepared(a, sql).get('x')).toEqual({ v: 1 })
      expect(prepared(a, sql, 'pluck').get('x')).toBe(1)
      // The plain one is still plain after the plucked one ran.
      expect(prepared(a, sql).get('x')).toEqual({ v: 1 })
      expect(prepared(a, sql).get('nope')).toBeUndefined()
    } finally {
      a.close()
      b.close()
    }
  })
})
