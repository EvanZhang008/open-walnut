/**
 * Line counts on a changed file ("+12 -3"): counted where the content is, kept
 * on the light list that ships without it. The exact count must match a real
 * line diff (the `diff` package is the reference), and a light record from a
 * host must keep the counts it came with instead of reading as 0/0.
 */
import { describe, it, expect } from 'vitest'
import { diffArrays } from 'diff'
import {
  countLineChanges,
  fileLineCounts,
  lineCountBudget,
  LIST_COUNT_MAX_STEPS,
  LIST_COUNT_MAX_CHARS,
  toLightChangesResult,
  type SessionChangesResult,
} from '../../src/providers/session-changes-core.js'

function referenceCounts(before: string, after: string): { additions: number; deletions: number } {
  const lines = (t: string) => {
    if (!t) return []
    const l = t.split('\n')
    if (l[l.length - 1] === '') l.pop()
    return l
  }
  let additions = 0
  let deletions = 0
  for (const part of diffArrays(lines(before), lines(after))) {
    if (part.added) additions += part.count ?? part.value.length
    else if (part.removed) deletions += part.count ?? part.value.length
  }
  return { additions, deletions }
}

/** Deterministic pseudo-random source, so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('countLineChanges', () => {
  it('counts ordinary edits exactly', () => {
    expect(countLineChanges('a\nb\nc\n', 'a\nb\nc\n')).toEqual({ additions: 0, deletions: 0 })
    expect(countLineChanges('', 'one\ntwo\n')).toEqual({ additions: 2, deletions: 0 })
    expect(countLineChanges('one\ntwo\n', '')).toEqual({ additions: 0, deletions: 2 })
    expect(countLineChanges('a\nOLD\nc\n', 'a\nNEW\nc\n')).toEqual({ additions: 1, deletions: 1 })
    expect(countLineChanges('a\nc\n', 'a\nb1\nb2\nc\n')).toEqual({ additions: 2, deletions: 0 })
  })

  it('treats a missing final newline as a changed last line, as a diff does', () => {
    expect(countLineChanges('a\nb', 'a\nb\n')).toEqual({ additions: 0, deletions: 0 })
    expect(countLineChanges('a\nb\n', 'a\nb\nc')).toEqual({ additions: 1, deletions: 0 })
  })

  it('matches a real line diff on random edits of a real-sized file', () => {
    const next = rng(42)
    const vocabulary = ['', '}', '  return x', 'const a = 1', 'if (ok) {', '// note', 'export function f() {', '你好']
    for (let round = 0; round < 60; round++) {
      const size = 20 + Math.floor(next() * 400)
      const before: string[] = []
      for (let i = 0; i < size; i++) before.push(vocabulary[Math.floor(next() * vocabulary.length)]! + (next() < 0.5 ? ` ${i}` : ''))
      const after = before.slice()
      const edits = 1 + Math.floor(next() * 25)
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(next() * (after.length + 1))
        const kind = next()
        if (kind < 0.35) after.splice(at, 1)
        else if (kind < 0.7) after.splice(at, 0, `inserted ${round}-${e}`)
        else after.splice(at, 1, `replaced ${round}-${e}`)
      }
      const b = before.join('\n') + '\n'
      const a = after.join('\n') + '\n'
      expect(countLineChanges(b, a), `round ${round}`).toEqual(referenceCounts(b, a))
    }
  })

  it('answers fast with a fair count for a whole-file rewrite past the exact limit', () => {
    const before = Array.from({ length: 6000 }, (_, i) => `old line ${i}`).join('\n') + '\n'
    const after = Array.from({ length: 5000 }, (_, i) => `new line ${i}`).join('\n') + '\n'
    const t0 = Date.now()
    expect(countLineChanges(before, after)).toEqual({ additions: 5000, deletions: 6000 })
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('fileLineCounts and the light list', () => {
  it('keeps the counts a light record from a host came with', () => {
    expect(fileLineCounts({ before: '', after: '', additions: 7, deletions: 2 })).toEqual({ additions: 7, deletions: 2 })
  })

  it('gives a light record without counts none, never a 0/0 that reads "no change"', () => {
    expect(fileLineCounts({ before: '', after: '' })).toEqual({})
  })

  it('strips content but keeps the counts', () => {
    const result: SessionChangesResult = {
      sessionId: 's',
      fileCount: 1,
      anyPartial: false,
      groups: [{
        repoRoot: '/r', label: 'r', kind: 'cwd',
        files: [{ filePath: '/r/a.ts', relPath: 'a.ts', before: 'a\nOLD\n', after: 'a\nNEW\nmore\n', status: 'modified', ops: 1, partial: false }],
      }],
    }
    const light = toLightChangesResult(result)
    const f = light.groups[0]!.files[0]!
    expect(f.before).toBe('')
    expect(f.after).toBe('')
    expect(f.additions).toBe(2)
    expect(f.deletions).toBe(1)
    // A second strip of the already-light list keeps them.
    const again = toLightChangesResult(light).groups[0]!.files[0]!
    expect([again.additions, again.deletions]).toEqual([2, 1])
  })

  it('one list shares one budget: past it the counts come from the cheap line multiset', () => {
    const rand = rng(7)
    const make = (n: number) => Array.from({ length: n }, () => `line ${Math.floor(rand() * 400)}`).join('\n') + '\n'
    const files = Array.from({ length: 20 }, () => ({ before: make(3000), after: make(3000) }))
    const budget = lineCountBudget()
    const counts = files.map((f) => fileLineCounts(f, {}, budget))
    // The walk stopped once the list's steps ran out, not 20 x 3M steps in.
    expect(budget.steps).toBe(0)
    expect(LIST_COUNT_MAX_STEPS).toBeLessThan(20 * 3_000_000)
    // Every file still has counts, never more than every line.
    for (const c of counts) {
      expect(c.additions).toBeGreaterThan(0)
      expect(c.additions! + c.deletions!).toBeLessThanOrEqual(6000)
    }
  })

  it('a list of hundreds of rewritten files holds the event loop tens of milliseconds, not seconds', () => {
    const file = (seed: number, lines: number) => ({
      before: Array.from({ length: lines }, (_, i) => `const v${seed}_${i} = ${i * 7} // old line ${i}`).join('\n'),
      after: Array.from({ length: lines }, (_, i) => `let w${seed}_${i} = ${i * 3} // new line ${i}`).join('\n'),
    })
    const files = Array.from({ length: 300 }, (_, i) => file(i, 1300))
    // Warm up, as a running server is.
    files.slice(0, 5).forEach((f) => fileLineCounts(f, {}, lineCountBudget()))
    const budget = lineCountBudget()
    const started = performance.now()
    const counts = files.map((f) => fileLineCounts(f, {}, budget))
    const ms = performance.now() - started
    const counted = counts.filter((c) => c.additions !== undefined)
    // The first files are counted, the rest go without numbers (never wrong ones).
    expect(counted.length).toBeGreaterThan(0)
    expect(counted.length).toBeLessThan(files.length)
    for (const c of counted) expect(c).toEqual({ additions: 1300, deletions: 1300 })
    expect(ms).toBeLessThan(400)
  })

  it('past the list\'s text budget the rest of its files go uncounted, never counted wrong', () => {
    const budget = lineCountBudget()
    budget.chars = 1000
    const small = { before: 'a\nb\n', after: 'a\nc\n' }
    expect(fileLineCounts(small, {}, budget)).toEqual({ additions: 1, deletions: 1 })
    const big = { before: 'x\n'.repeat(600), after: 'y\n'.repeat(600) }
    expect(fileLineCounts(big, {}, budget)).toEqual({})
    expect(LIST_COUNT_MAX_CHARS).toBeGreaterThan(1_000_000)
  })

  it('a CR at a line end is not part of the line, as on the phone: a CRLF to LF switch with one edit counts one', () => {
    expect(countLineChanges('one\r\ntwo\r\n', 'one\nNEW\n')).toEqual({ additions: 1, deletions: 1 })
    expect(countLineChanges('a\r\nb\r\n', 'a\nb\n')).toEqual({ additions: 0, deletions: 0 })
    expect(countLineChanges('a\r\nb\n', 'a\nb\r\nc\n')).toEqual({ additions: 1, deletions: 0 })
  })
})
