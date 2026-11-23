/**
 * A list argument given one string is told it takes a list, with the list it meant, and never a
 * size error worded for the string.
 *
 * 2026-11-23: `thread_create {"supersedes":"th-..."}` answered "supersedes: Too big: expected
 * string to have <=12 characters"; the 12 was the list's most entries, and zod words a list's size
 * check for whatever value it got. The class: every top-level list argument of every op in the
 * catalog, enumerated from the registry, so a new one is checked as it lands.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { listOps, parseOpArgs } from '../../../src/ops/index.js'

/** The op's top-level keys whose schema is a list (z.array, maybe optional or nullable). */
function listKeys(input: z.ZodRawShape): string[] {
  return Object.entries(input).filter(([, s]) => {
    let t = s as z.ZodType
    for (let i = 0; i < 5 && t; i++) {
      if (t instanceof z.ZodArray) return true
      const inner = (t as { unwrap?: () => z.ZodType }).unwrap
      if (typeof inner !== 'function') return false
      t = inner.call(t)
    }
    return false
  }).map(([k]) => k)
}

describe('a list argument given one string', () => {
  const cases = listOps().flatMap((op) => listKeys(op.input).map((key) => ({ op, key })))

  it('the catalog has list arguments to check', () => {
    expect(cases.length).toBeGreaterThan(20)
    expect(cases.some((c) => c.op.name === 'thread_create' && c.key === 'supersedes')).toBe(true)
  })

  it('is told the key takes a list, with the items it gave, and no size error for the string', () => {
    const given = 'th-abc123def456,th-0123456789ab,th-fedcba987654'
    const wrong: string[] = []
    for (const { op, key } of cases) {
      const r = parseOpArgs(op, { [key]: given })
      if (r.ok) continue
      const about = r.message.split('; ').filter((part) => part.startsWith(`${key}: `) || part.startsWith(`${key} takes`))
      if (!about.length) continue
      if (about.some((part) => /characters/.test(part))) wrong.push(`${op.name}.${key}: ${about.join('; ')}`)
      else if (!about.some((part) => part.startsWith(`${key} takes a list, e.g. ["th-abc123def456","th-0123456789ab","th-fedcba987654"]`))) wrong.push(`${op.name}.${key}: ${about.join('; ')}`)
    }
    expect(wrong).toEqual([])
  })
})
