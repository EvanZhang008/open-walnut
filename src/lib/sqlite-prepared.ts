/**
 * One compiled statement per connection and SQL text, kept while the connection lives: for the
 * statements a hot path runs many times a second (the leader's apply of a host's channel frames,
 * session-tracker.ts applyHostChannelBatch), where compiling the same text each time was a tenth
 * of the leader's CPU. Only fixed SQL texts: the cache holds one entry per text.
 *
 * A plucked statement is its own entry (pluck changes the statement it is called on). A closed
 * connection's statements throw as the connection does; a reopened store is a new connection.
 */
import type { Database, Statement } from './sqlite.js'

const cache = new WeakMap<Database, Map<string, Statement>>()

export function prepared(handle: Database, sql: string, mode: 'object' | 'pluck' = 'object'): Statement {
  let byText = cache.get(handle)
  if (!byText) { byText = new Map(); cache.set(handle, byText) }
  const key = mode === 'pluck' ? `p\u0000${sql}` : sql
  let stmt = byText.get(key)
  if (!stmt) {
    stmt = handle.prepare(sql) as Statement
    if (mode === 'pluck') stmt.pluck()
    byText.set(key, stmt)
  }
  return stmt
}
