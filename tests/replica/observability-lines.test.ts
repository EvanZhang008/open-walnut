/**
 * Ratchet: the structured lines of section 13 of
 * docs/plan/walnut-replica-servers-impl.md exist in the source, each logged by
 * that exact name with the fields the plan names (WP14). A rename or a dropped
 * field fails here, and `scripts/walnut-logs.sh replica` (which reads them by
 * name) would otherwise go blind without a sound.
 *
 * Each entry: the line's name, where it is logged, and the fields its log call
 * must carry (a field given by a spread, `...result`, is named as such).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')

const LINES: Array<{ name: string; file: string; fields: string[] }> = [
  { name: 'replica presence', file: 'src/replica/front.ts', fields: ['answers', 'why', 'asOf', 'host', 'home'] },
  { name: 'replica forward', file: 'src/replica/dispatch.ts', fields: ['outcome', 'ms', 'bytes', 'opId', 'path'] },
  { name: 'replica away answer', file: 'src/replica/dispatch.ts', fields: ['route', 'cls', 'why'] },
  { name: 'journal append', file: 'src/providers/offline-host-core.ts', fields: ['home', 'kind', 'opId', 'actor', 'seq'] },
  { name: 'journal drain', file: 'src/core/offline-handover.ts', fields: ['...result', 'applied', 'merged', 'conflicts', 'drainId'] },
  { name: 'replica copy round', file: 'src/core/replication/kind-leader.ts', fields: ['kind', 'target', 'need', 'held', 'removed', 'ms'] },
  { name: 'offline merge conflict', file: 'src/core/offline-merge/conflict-log.ts', fields: ['kind', 'id', 'seq', 'drainId'] },
  { name: 'journal lock', file: 'src/providers/offline-journal-core.ts', fields: ['home', 'owner', 'outcome'] },
  { name: 'drain record failed', file: 'src/core/offline-handover.ts', fields: ['seq', 'kind', 'attempt', 'nextRetryMs'] },
  { name: 'forward stale refused', file: 'src/web/middleware/op-id.ts', fields: ['opId', 'ageMs'] },
]

/** The text of each log call naming `name`: from the name to the call's closing `})`. */
function callsOf(src: string, name: string): string[] {
  const out: string[] = []
  const needle = `'${name}'`
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
    const head = src.slice(Math.max(0, at - 80), at)
    if (!/(log\.\w+\.(info|warn|error)|deps\.log|opts\.log\?\.(info|warn))\(\s*('(info|warn|error)',\s*)?$/.test(head)) continue
    const end = src.indexOf('})', at)
    out.push(src.slice(at, end === -1 ? at + 600 : end + 2))
  }
  return out
}

describe('section 13 observability lines exist by name, with their fields', () => {
  for (const { name, file, fields } of LINES) {
    it(`${name} (${file})`, () => {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
      const calls = callsOf(src, name)
      expect(calls.length, `no log call named '${name}' in ${file}`).toBeGreaterThan(0)
      for (const call of calls) {
        for (const f of fields) {
          const ok = f.startsWith('...') ? call.includes(f) : new RegExp(`(^|[^\\w.])${f}(\\s*[:,}]|\\s*\\?\\?)`).test(call)
          expect(ok, `'${name}' in ${file} does not carry ${f}: ${call.slice(0, 300)}`).toBe(true)
        }
      }
    })
  }

  it('the old info and warn messages are gone (one name per line); the error lines stay', () => {
    const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
    expect(read('src/replica/front.ts')).not.toContain("'replica: presence'")
    expect(read('src/providers/offline-host-core.ts')).not.toContain("'offline host: follower write queued'")
    // An error line is a card in the notification center, keyed by its raw message: kept as it was.
    expect(read('src/core/offline-handover.ts').split("log.session.error('offline handover: record failed'").length - 1).toBe(2)
    expect(read('src/core/offline-handover.ts')).not.toContain("'offline handover: done'")
    expect(read('src/web/middleware/op-id.ts')).not.toContain("'op id: a forwarded write is too old and is not applied'")
  })

  it('walnut-logs.sh replica reads every one of them by name', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/walnut-logs.sh'), 'utf8')
    for (const { name } of LINES) expect(script, name).toContain(name)
  })
})
