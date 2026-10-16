/**
 * Ratchet: every row write in task-manager.ts stamps per-field change times
 * (task-field-times.ts). The offline drain judges "newer" per field by `field_at`
 * (docs/plan/walnut-replica-servers-impl.md section 7); a write path that forgets it
 * makes a newer Mac edit lose to an older away write, without a word (WP9 review:
 * updateTasksBulk and the folder filing path did).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../src/core/task-manager.ts')
/** Whole-row copies that carry the writer's own field_at with the row. */
const EXEMPT = new Set(['applyTaskReplicaRows'])

function enclosingFunction(src: string, at: number): { name: string; body: string } {
  const re = /\n(?:export )?(?:async )?function (\w+)/g
  let name = '(top level)'
  let start = 0
  for (let m = re.exec(src); m && m.index < at; m = re.exec(src)) { name = m[1]; start = m.index }
  const next = src.slice(at).search(/\n(?:export )?(?:async )?function \w+/)
  return { name, body: src.slice(start, next === -1 ? src.length : at + next) }
}

describe('task-manager row writes stamp field_at', () => {
  it('every UPDATE tasks site sits in a function that calls stampedFieldTimes (or is a whole-row copy)', () => {
    const src = fs.readFileSync(SRC, 'utf8')
    const sites = [...src.matchAll(/UPDATE tasks SET/g)].map((m) => m.index!)
    expect(sites.length).toBeGreaterThan(2)
    const missing = sites.map((i) => enclosingFunction(src, i))
      .filter((f) => !EXEMPT.has(f.name) && !f.body.includes('stampedFieldTimes('))
      .map((f) => f.name)
    expect(missing).toEqual([])
  })

  it('writeStore stamps too (the whole-store path)', () => {
    const src = fs.readFileSync(SRC, 'utf8')
    expect(enclosingFunction(src, src.indexOf('async function writeStore(') + 10).body).toContain('stampedFieldTimes(')
  })
})
