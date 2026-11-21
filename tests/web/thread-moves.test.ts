/**
 * A card that leaves the group on screen leaves a line in its place (web/src/components/org/thread-moves.ts;
 * 2026-11-21, a review on his data: his reply, a choice or Reopen moved a card out of view with no word).
 * One rule for every move, read from the groups before and after:
 *  - a card that left a group the filter shows leaves a line at its old place, naming where it went;
 *  - under All the same (Archived is not shown under All, so a card that leaves it there leaves none);
 *  - a card new to the list, one deleted, one that stayed, and one that moved between two groups
 *    the filter does not show leave none.
 * The browser flow is tests/e2e/browser/thread-groups-filter.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import type { ThreadGroup } from '../../src/core/org/thread-groups.js'
import { filterShows, movesBetween, placesOf } from '../../web/src/components/org/thread-moves'

type G = Record<ThreadGroup, Array<{ id: string; title: string }>>
const empty = (): G => ({ needs: [], read: [], working: [], waiting: [], known: [], done: [], archived: [] })
const c = (id: string) => ({ id, title: `Card ${id}` })
function groups(parts: Partial<G>): G { return { ...empty(), ...parts } }

describe('the line a moved card leaves', () => {
  it('a card that leaves the group on screen leaves a line at its place, naming where it went', () => {
    const before = placesOf(groups({ needs: [c('a'), c('b'), c('c')] }))
    const after = placesOf(groups({ needs: [c('a'), c('c')], working: [c('b')] }))
    expect(movesBetween(before, after, 'needs')).toEqual([{ id: 'b', title: 'Card b', from: 'needs', to: 'working', index: 1 }])
    // Under All too: it is drawn elsewhere, maybe out of view.
    expect(movesBetween(before, after, 'all')).toEqual([{ id: 'b', title: 'Card b', from: 'needs', to: 'working', index: 1 }])
    // Reopen from Closed, from Archived (shown only on its own chip).
    const closed = placesOf(groups({ done: [c('d')], archived: [c('e')] }))
    const reopened = placesOf(groups({ working: [c('d'), c('e')] }))
    expect(movesBetween(closed, reopened, 'done').map((m) => [m.id, m.to])).toEqual([['d', 'working']])
    expect(movesBetween(closed, reopened, 'archived').map((m) => [m.id, m.to])).toEqual([['e', 'working']])
    expect(movesBetween(closed, reopened, 'all').map((m) => m.id)).toEqual(['d'])
  })

  it('a new card, a deleted one, one that stayed and one moved out of sight leave none', () => {
    const before = placesOf(groups({ needs: [c('a')], working: [c('b')], waiting: [c('x')] }))
    const after = placesOf(groups({ needs: [c('n'), c('a')], waiting: [c('b')] }))
    // a stayed (its index moved, not its group), n is new, x was deleted; b moved Working to Waiting.
    expect(movesBetween(before, after, 'needs')).toEqual([])
    expect(movesBetween(before, after, 'working').map((m) => m.id)).toEqual(['b'])
    expect(movesBetween(before, after, 'read')).toEqual([])
  })

  it('which groups a filter shows: All every one but Archived, a chip its own', () => {
    expect((['needs', 'read', 'working', 'waiting', 'known', 'done', 'archived'] as const).filter((g) => filterShows('all', g))).toEqual(['needs', 'read', 'working', 'waiting', 'known', 'done'])
    expect(filterShows('archived', 'archived')).toBe(true)
    expect(filterShows('needs', 'working')).toBe(false)
  })
})
