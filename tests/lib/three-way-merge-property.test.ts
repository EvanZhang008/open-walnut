/**
 * Property runs of the three-way merge (docs/plan/walnut-replica-servers-impl.md WP11):
 * seeded random documents and random line and word edits on each side.
 *
 *   - a one-sided edit merges to that side, verbatim; merge(base, x, x) == x
 *   - disjoint edits (separated by an untouched line) merge cleanly and the result is
 *     exactly both edits applied
 *   - no base line both sides kept is ever dropped, in order, whatever the outcome
 *     (in a conflict: in both resolutions); every whole line a side added is in the
 *     merge (clean) or in that side's resolution (conflict)
 *   - a diff over `maxEditLength` gives the same one-region answer on every run
 *
 * Runs: WALNUT_SIM_RUNS (default 2,000; the large run is 100,000), seed WALNUT_SIM_SEED.
 * A failure prints its run and seed so it replays alone.
 */
import { describe, it, expect } from 'vitest'
import { threeWayMerge } from '../../src/lib/three-way-merge'

const RUNS = Number(process.env.WALNUT_SIM_RUNS) || 2_000
const SEED = Number(process.env.WALNUT_SIM_SEED) || 0x5eed11

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'marina', 'acme', 'river', 'stone', 'cloud', 'lamp']

type Op =
  | { k: 'keep' }
  | { k: 'delete' }
  | { k: 'replace'; line: string }
  | { k: 'word'; line: string }

interface Side {
  /** Per base line: what the side did to it. */
  ops: Op[]
  /** Lines inserted before base line i (i = n: at the end). */
  inserts: Map<number, string[]>
}

function makeBase(rnd: () => number, run: number): string[] {
  const n = Math.floor(rnd() * 24)
  return Array.from({ length: n }, (_, i) => {
    const words = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => WORDS[Math.floor(rnd() * WORDS.length)])
    return `b${run}x${i} ${words.join(' ')}`
  })
}

/** Random edits of `base` by side `tag`, on the lines `allowed` says (and insertion points it allows). */
function makeSide(rnd: () => number, base: string[], tag: string, allowed: (i: number) => boolean, rate: number): Side {
  let fresh = 0
  const ops: Op[] = base.map((line, i) => {
    if (!allowed(i) || rnd() > rate) return { k: 'keep' }
    const r = rnd()
    if (r < 0.3) return { k: 'delete' }
    // A replaced line shares no word with any line (a shared word would merge word by word).
    if (r < 0.65) { const n = fresh++; return { k: 'replace', line: `${tag}r${n} ${tag}z${n}` } }
    const parts = line.split(' ')
    const at = 1 + Math.floor(rnd() * Math.max(1, parts.length - 1))
    parts[Math.min(at, parts.length - 1)] = `${tag}w${fresh++}`
    return { k: 'word', line: parts.join(' ') }
  })
  const inserts = new Map<number, string[]>()
  for (let i = 0; i <= base.length; i++) {
    if (!allowed(i) || rnd() > rate / 2) continue
    inserts.set(i, Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => `${tag}i${fresh++}`))
  }
  return { ops, inserts }
}

function render(base: string[], s: Side): string[] {
  const out: string[] = []
  for (let i = 0; i <= base.length; i++) {
    out.push(...(s.inserts.get(i) ?? []))
    if (i === base.length) break
    const op = s.ops[i]
    if (op.k === 'keep') out.push(base[i])
    else if (op.k === 'replace' || op.k === 'word') out.push(op.line)
  }
  return out
}

/** Both sides applied (they touch disjoint lines). */
function both(base: string[], a: Side, b: Side): string[] {
  const out: string[] = []
  for (let i = 0; i <= base.length; i++) {
    out.push(...(a.inserts.get(i) ?? []), ...(b.inserts.get(i) ?? []))
    if (i === base.length) break
    const op = a.ops[i].k !== 'keep' ? a.ops[i] : b.ops[i]
    if (op.k === 'keep') out.push(base[i])
    else if (op.k === 'replace' || op.k === 'word') out.push(op.line)
  }
  return out
}

const text = (lines: string[], trail: boolean): string => (lines.length ? lines.join('\n') + (trail ? '\n' : '') : '')

/** Whether `want` appears in `lines` in order (not necessarily next to each other). */
function inOrder(lines: string[], want: string[]): boolean {
  let j = 0
  for (const l of lines) if (j < want.length && l === want[j]) j++
  return j === want.length
}

function touched(s: Side, i: number): boolean {
  return s.ops[i].k !== 'keep'
}

describe('three-way merge properties', () => {
  it(`holds over ${RUNS} seeded runs (seed ${SEED})`, () => {
    let clean = 0
    let conflicted = 0
    let disjoint = 0
    for (let run = 0; run < RUNS; run++) {
      const rnd = mulberry32(SEED + run)
      const where = `run ${run} seed ${SEED} (replay: WALNUT_SIM_SEED=${SEED + run} WALNUT_SIM_RUNS=1)`
      const baseLines = makeBase(rnd, run)
      const trail = rnd() < 0.8
      const base = text(baseLines, trail)
      // One side only, and the same edit on both: that side, verbatim.
      const solo = text(render(baseLines, makeSide(rnd, baseLines, 's', () => true, 0.3)), trail)
      expect(threeWayMerge(base, solo, base), where).toEqual({ ok: true, merged: solo })
      expect(threeWayMerge(base, base, solo), where).toEqual({ ok: true, merged: solo })
      expect(threeWayMerge(base, solo, solo), where).toEqual({ ok: true, merged: solo })

      // Disjoint: A on lines 0 mod 4 (and the points before them), B on lines 2 mod 4.
      const da = makeSide(rnd, baseLines, 'a', (i) => i % 4 === 0, 0.6)
      const db = makeSide(rnd, baseLines, 'b', (i) => i % 4 === 2, 0.6)
      // An insertion before line 4k+2 by B touches nothing of A; one at the very end only from A.
      const dm = threeWayMerge(base, text(render(baseLines, da), trail), text(render(baseLines, db), trail))
      const want = text(both(baseLines, da, db), trail)
      expect(dm, where).toEqual({ ok: true, merged: want })
      disjoint++

      // Anything: the lines both kept survive, in order; added lines are never lost.
      const a = makeSide(rnd, baseLines, 'p', () => true, 0.35)
      const b = makeSide(rnd, baseLines, 'q', () => true, 0.35)
      const ra = render(baseLines, a)
      const rb = render(baseLines, b)
      const r = threeWayMerge(base, text(ra, trail), text(rb, trail))
      const keptByBoth = baseLines.filter((_, i) => !touched(a, i) && !touched(b, i))
      const addedA = ra.filter((l) => /^p[ri]\d/.test(l))
      const addedB = rb.filter((l) => /^q[ri]\d/.test(l))
      if (r.ok) {
        clean++
        const out = r.merged.split('\n')
        expect(inOrder(out, keptByBoth), where).toBe(true)
        for (const l of [...addedA, ...addedB]) expect(out, where).toContain(l)
      } else {
        conflicted++
        const oursOut = r.oursText.split('\n')
        const theirsOut = r.theirsText.split('\n')
        expect(inOrder(oursOut, keptByBoth) && inOrder(theirsOut, keptByBoth), where).toBe(true)
        for (const l of addedA) expect(oursOut, where).toContain(l)
        for (const l of addedB) expect(theirsOut, where).toContain(l)
        expect(r.regions.length, where).toBe(r.conflicts)
      }

      // Over the step budget: one region over the whole document, the same every time.
      if (baseLines.length >= 6) {
        const wa = text(baseLines.map((l) => `${l} A`), trail)
        const wb = text(baseLines.map((l) => `${l} B`), trail)
        const first = threeWayMerge(base, wa, wb, { maxEditLength: 4 })
        expect(first, where).toMatchObject({ ok: false, conflicts: 1, overBudget: true, oursText: wa, theirsText: wb })
        expect(JSON.stringify(threeWayMerge(base, wa, wb, { maxEditLength: 4 })), where).toBe(JSON.stringify(first))
      }
    }
    console.log(`[three-way-merge-property] ${RUNS} runs, seed ${SEED}: ${disjoint} disjoint merges exact, random pairs ${clean} clean and ${conflicted} conflicting, no kept or added line lost`)
    expect(clean + conflicted).toBe(RUNS)
  }, 600_000)
})
