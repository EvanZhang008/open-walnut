/**
 * The thread check's clock and its count of fixed repeats (src/core/org/thread-audit.ts): which
 * nodes a look checks, in what order, and which told repeats a pass may call fixed. Pure.
 */
import { describe, expect, it } from 'vitest'
import { AUDIT_EVERY_MS, dueNodes, standingRepeats } from '../../../src/core/org/thread-audit.js'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

describe('which nodes a look checks', () => {
  it('never checked first, then the longest unchecked; none checked or tried within 6 hours', () => {
    const last = { a: { lastPassAt: iso(AUDIT_EVERY_MS + 1000) }, b: { lastPassAt: iso(AUDIT_EVERY_MS + 9000) }, c: { lastPassAt: iso(1000) } }
    expect(dueNodes(['a', 'b', 'c', 'd'], last, new Map(), NOW)).toEqual(['d', 'b', 'a'])
    // Tried in this process (no open thread, or its counts not written): it waits its 6 hours too.
    expect(dueNodes(['a', 'b', 'c', 'd'], last, new Map([['d', NOW - 60_000], ['a', NOW - AUDIT_EVERY_MS]]), NOW)).toEqual(['b', 'a'])
  })
})

describe('which told repeats a pass may call fixed', () => {
  const told = {
    'repeat:th-1+th-2': { kind: 'repeat' as const, at: iso(1000) },
    'repeat:th-3+th-9': { kind: 'repeat' as const, at: iso(1000) },
    'repeat:th-4+th-8': { kind: 'repeat' as const, at: iso(1000) },
    'repeat:th-5+th-6': { kind: 'repeat' as const, at: iso(1000) },
    'stale:th-7': { kind: 'stale' as const, at: iso(1000) },
  }
  const ownIds = new Set(['th-1', 'th-2', 'th-3', 'th-4', 'th-5'])
  const ownOpen = new Set(['th-1', 'th-2', 'th-3', 'th-5'])

  it('stands when not judged, or when the task card is not in the tree read; fixed when a node card closed or both read open', () => {
    const treeOpen = new Set(['th-1', 'th-2', 'th-3', 'th-5', 'th-6'])
    const s = standingRepeats(told, new Set(['repeat:th-5+th-6']), ownIds, ownOpen, treeOpen)
    // th-1+th-2: both open, no longer one subject: fixed. th-3+th-9: th-9 not read: stands.
    // th-4+th-8: the node's th-4 closed: fixed. th-5+th-6: not judged this pass: stands.
    expect([...s].sort()).toEqual(['repeat:th-3+th-9', 'repeat:th-5+th-6'])
  })

  it('a node card merged away (gone from its file) is fixed, as the told record names the node\'s side', () => {
    const merged = { 'repeat:th-a+th-b': { kind: 'repeat' as const, at: iso(1000), on: ['th-a', 'th-b'] } }
    // th-b merged into th-a: gone from the node's file and from the tree.
    expect([...standingRepeats(merged, new Set(), new Set(['th-a']), new Set(['th-a']), new Set(['th-a']))]).toEqual([])
    // Without the record of its side, a card missing from the tree may be a task's not read: it stands.
    expect([...standingRepeats({ 'repeat:th-a+th-b': { kind: 'repeat' as const, at: iso(1000) } }, new Set(), new Set(['th-a']), new Set(['th-a']), new Set(['th-a']))]).toEqual(['repeat:th-a+th-b'])
  })

  it('a tree that could not be read keeps every told repeat standing, never fixed', () => {
    expect([...standingRepeats(told, new Set(), ownIds, ownOpen, null)].sort()).toEqual(['repeat:th-1+th-2', 'repeat:th-3+th-9', 'repeat:th-4+th-8', 'repeat:th-5+th-6'])
  })
})
