/**
 * The zod rules Walnut keeps across zod's own changes (src/lib/zod-rules.ts), and
 * the ratchets that keep every schema on them:
 * - no schema uses zod's datetime() (it refuses minute-only times since zod 4.5);
 * - every list in every op's input has a size bound (GHSA-mrhx-c7xc-m3w5);
 * - an op call with an oversized record or list is refused before zod walks it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { COLLECTION_MAX, isoDateTime, LIST_MAX, oversizedCollection, utf16String, withSeconds } from '../../src/lib/zod-rules.js'
import { getOp, listOps } from '../../src/ops/index.js'
import { parseOpArgs } from '../../src/ops/executor.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

describe('isoDateTime', () => {
  const s = isoDateTime()
  it.each([
    ['2026-10-22T12:30Z', '2026-10-22T12:30:00Z'],
    ['2026-10-22T12:30+05:30', '2026-10-22T12:30:00+05:30'],
    ['2024-02-29T12:30-00:00', '2024-02-29T12:30:00-00:00'],
    ['2026-10-22T12:30:15Z', '2026-10-22T12:30:15Z'],
    ['2026-10-22T12:30:15.123+01:00', '2026-10-22T12:30:15.123+01:00'],
  ])('takes %s as zod 4.3 did, and reads it as %s', (given, read) => {
    expect(s.parse(given)).toBe(read)
    expect(new Date(read).getTime()).toBe(new Date(given).getTime())
  })
  it.each(['2026-10-22', '2026-10-22T12:30', '2023-02-29T12:30Z', '2026-13-01T00:00Z', '2026-10-22T24:00Z', '2026-10-22 12:30Z', ''])('refuses %j', (given) => {
    expect(s.safeParse(given).success).toBe(false)
  })
  it('withSeconds leaves a time that has seconds alone', () => {
    expect(withSeconds('2026-10-22T12:30:00.5Z')).toBe('2026-10-22T12:30:00.5Z')
  })
})

describe('utf16String', () => {
  const four = '\u{1F600}\u{1F600}' // 2 code points, 4 UTF-16 units
  it('counts UTF-16 units, as JS .length does', () => {
    expect(utf16String(4).safeParse(four).success).toBe(true)
    expect(utf16String(3).safeParse(four).success).toBe(false)
    // zod's own count since 4.5 is code points: this is the difference the helper keeps.
    expect(z.string().max(3).safeParse(four).success).toBe(true)
  })
  it('reports too_big', () => {
    const r = utf16String(3).safeParse(four)
    expect(r.success).toBe(false)
    expect(r.error!.issues[0].code).toBe('too_big')
  })
})

describe('oversizedCollection', () => {
  it('finds a list or an object over the bound, at its path', () => {
    expect(oversizedCollection({ a: [1, 2, 3] }, 2)).toBe('a')
    expect(oversizedCollection({ a: { b: { x: 1, y: 2, z: 3 } } }, 2)).toBe('a.b')
    expect(oversizedCollection([[1], [1, 2, 3]], 2)).toBe('[1]')
    expect(oversizedCollection({ a: [1, 2], b: 'x'.repeat(10_000) }, 2)).toBeNull()
  })
  it('walks a deep value without recursion, and many small collections pass', () => {
    let deep: unknown = 1
    for (let i = 0; i < 200_000; i++) deep = [deep]
    expect(oversizedCollection(deep)).toBeNull()
    expect(oversizedCollection({ rows: Array.from({ length: 200 }, () => Array.from({ length: 600 }, () => ({}))) })).toBeNull()
  })
  it('an op call holding a huge record is refused before zod parses it', () => {
    const op = getOp('api')!
    const big = Object.fromEntries(Array.from({ length: COLLECTION_MAX + 1 }, (_, i) => [`k${i}`, i]))
    const r = parseOpArgs(op, { method: 'POST', path: '/api/x', body: big })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/body: more than 100000 entries/)
  })
  it('a list over an op\'s bound costs one issue, not one per element', () => {
    const op = getOp('task_update')!
    const r = parseOpArgs(op, { id: 'x', tags: Array.from({ length: LIST_MAX + 1 }, () => 5) })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message.split('; ')).toHaveLength(1)
  })
})

/** Every list schema in a zod tree with no size bound, by path. */
function unboundedLists(schema: unknown, at: string, seen = new Set<unknown>()): string[] {
  const def = (schema as { _zod?: { def?: Record<string, any> } })?._zod?.def
  if (!def || seen.has(schema)) return []
  seen.add(schema)
  const out: string[] = []
  const checks = ((def.checks ?? []) as Array<{ _zod?: { def?: { check?: string } } }>).map((c) => c._zod?.def?.check)
  if (def.type === 'array' && !checks.includes('max_length') && !checks.includes('length_equals')) out.push(at)
  if (def.type === 'array') out.push(...unboundedLists(def.element, `${at}[]`, seen))
  if (def.type === 'object') for (const [k, v] of Object.entries(def.shape ?? {})) out.push(...unboundedLists(v, `${at}.${k}`, seen))
  if (def.type === 'union') for (const o of def.options ?? []) out.push(...unboundedLists(o, at, seen))
  if (def.type === 'record') out.push(...unboundedLists(def.valueType, `${at}{}`, seen))
  for (const k of ['innerType', 'in', 'out']) if (def[k]) out.push(...unboundedLists(def[k], at, seen))
  if (def.type === 'lazy') out.push(...unboundedLists(def.getter(), at, seen))
  return out
}

describe('ratchets', () => {
  it('every list in every op\'s input has a size bound', () => {
    const ops = listOps({ includeDeprecated: true })
    expect(ops.length).toBeGreaterThan(100)
    const missing = ops.flatMap((op) => Object.entries(op.input ?? {}).flatMap(([k, v]) => unboundedLists(v, `${op.name}.${k}`)))
    expect(missing).toEqual([])
  })

  it('no schema uses zod\'s datetime(), which refuses minute-only times since zod 4.5', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(path.join(ROOT, 'src'))
    const using = files
      .filter((f) => !f.endsWith(path.join('lib', 'zod-rules.ts')))
      .filter((f) => /from ['"]zod/.test(fs.readFileSync(f, 'utf8')))
      .filter((f) => /\.datetime\(|z\.iso\.datetime/.test(fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')))
      .map((f) => path.relative(ROOT, f))
    expect(using).toEqual([])
  })
})
