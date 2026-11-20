/**
 * The leader's pairing of removed keys with added keys (core/replication/manifest-moves.ts):
 * the move's map first, then the note id, then the same body; each key used once.
 */
import { describe, it, expect } from 'vitest'
import { mergeMoves, pairMoves, recordMoves, vaultMoveLookups, type MovableEntry } from '../../../src/core/replication/manifest-moves.js'
import type { MoveMap } from '../../../src/core/artifacts/unify/map.js'

const e = (k: string, h: string, extra: Partial<MovableEntry> = {}): MovableEntry => ({ k, h, n: 10, ...extra })
const byKey = (list: MovableEntry[]) => new Map(list.map((x) => [x.k, x]))
const MAP: MoveMap = { exact: { 'notes/clash.md': 'notes/notes/clash.md' }, rules: [{ from: 'acme/', to: 'projects/Acme/notes/' }, { from: '', to: 'notes/' }] }

describe('pairMoves', () => {
  it('pairs by the map: a rule, an exact entry, and the old place of a key the record names', () => {
    const before = byKey([e('acme/a.md', 'h1'), e('family/b.md', 'h2'), e('notes/clash.md', 'h3'), e('Old Case/c.md', 'h4')])
    const now = [e('projects/Acme/notes/a.md', 'x1'), e('notes/family/b.md', 'x2'), e('notes/notes/clash.md', 'x3'), e('renamed/c.md', 'x4')]
    const look = { ...vaultMoveLookups(MAP), before: (k: string) => (k === 'renamed/c.md' ? 'old case/c.md' : null) }
    expect(pairMoves(before, now, look).sort()).toEqual([
      ['Old Case/c.md', 'renamed/c.md'],
      ['acme/a.md', 'projects/Acme/notes/a.md'],
      ['family/b.md', 'notes/family/b.md'],
      ['notes/clash.md', 'notes/notes/clash.md'],
    ])
  })

  it('then by the same note id, only when one added key has it', () => {
    const before = byKey([e('a.md', 'h1', { m: { id: 'n_one' } }), e('b.md', 'h2', { m: { id: 'n_two' } }), e('c.md', 'h3')])
    const now = [e('x/a.md', 'z1', { m: { id: 'n_one' } }), e('y/b.md', 'z2', { m: { id: 'n_two' } }), e('z/b.md', 'z3', { m: { id: 'n_two' } })]
    expect(pairMoves(before, now)).toEqual([['a.md', 'x/a.md']])
  })

  it('then by the same hash and size, one to one', () => {
    const before = byKey([e('a.md', 'same'), e('b.md', 'same'), e('c.md', 'same'), e('d.md', 'other', { n: 3 })])
    const now = [e('n/a.md', 'same'), e('n/b.md', 'same'), e('n/d.md', 'other', { n: 4 })]
    const pairs = pairMoves(before, now)
    expect(pairs).toEqual([['a.md', 'n/a.md'], ['b.md', 'n/b.md']])
  })

  it('never two olds onto one new, nor one old onto two news, across the passes', () => {
    const before = byKey([e('acme/a.md', 'h', { m: { id: 'n_a' } }), e('b.md', 'h', { m: { id: 'n_a' } }), e('c.md', 'h')])
    const now = [e('projects/Acme/notes/a.md', 'h', { m: { id: 'n_a' } }), e('d.md', 'h')]
    const pairs = pairMoves(before, now, vaultMoveLookups(MAP))
    expect(pairs).toEqual([['acme/a.md', 'projects/Acme/notes/a.md'], ['b.md', 'd.md']])
    expect(new Set(pairs.map((p) => p[0])).size).toBe(pairs.length)
    expect(new Set(pairs.map((p) => p[1])).size).toBe(pairs.length)
  })

  it('pairs nothing when nothing was removed or nothing was added (a leader that lost its store names no new keys)', () => {
    const before = byKey([e('a.md', 'h1'), e('b.md', 'h2')])
    expect(pairMoves(before, [])).toEqual([])
    expect(pairMoves(before, [e('a.md', 'h1'), e('b.md', 'h2'), e('c.md', 'h1')])).toEqual([])
    // A key kept is never paired, even when another added key has its body.
    expect(pairMoves(before, [e('a.md', 'h1'), e('copy-of-a.md', 'h1')])).toEqual([])
  })
})

describe('recordMoves and mergeMoves', () => {
  it('names each key\'s place before the move, once; none without a record', () => {
    const before = (k: string) => ({ 'projects/Acme/notes/a.md': 'acme/a.md', 'notes/b.md': 'b.md' } as Record<string, string>)[k] ?? null
    expect(recordMoves([e('projects/Acme/notes/a.md', 'h'), e('notes/b.md', 'h'), e('drawings/new.md', 'h'), e('notes/b.md', 'h')], { before }))
      .toEqual([['acme/a.md', 'projects/Acme/notes/a.md'], ['b.md', 'notes/b.md']])
    expect(recordMoves([e('a.md', 'h')], {})).toEqual([])
    expect(recordMoves([e('a.md', 'h')], vaultMoveLookups(null))).toEqual([])
  })

  it('merging keeps the first list\'s pair for a key both name', () => {
    expect(mergeMoves([['a', 'x']], [['a', 'y'], ['b', 'x'], ['c', 'z']])).toEqual([['a', 'x'], ['c', 'z']])
  })
})
