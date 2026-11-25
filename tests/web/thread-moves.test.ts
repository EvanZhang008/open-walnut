/**
 * A card that leaves the group on screen leaves a line in its place (web/src/components/org/thread-moves.ts;
 * 2026-11-21, a review on his data: his reply, a choice or Reopen moved a card out of view with no word).
 * One rule for every move, read from the groups before and after:
 *  - a card that left a group on screen (Needs you and Done always, a folded group while he opened
 *    it) leaves a line at its old place, naming where it went; one that leaves a folded group leaves none;
 *  - a card new to the list, one deleted, one that stayed, and one that moved between two groups
 *    not on screen leave none;
 *  - opening a fold keeps the lines on show; folding the group a line stands in takes it away;
 *  - a read that caught the pane up (opened again, a reconnect) draws no line: he never saw those moves;
 *  - a line on show always names where its card is now: a card that moves on out of sight renames
 *    it, one back where it left or gone from the list takes it away;
 *  - his own Acknowledge leaves no line, from any screen (2026-11-25, the user: "直接消失就好了"):
 *    read from the card (ackedAt, or closed acked by him), so every way he acknowledges is covered.
 * The browser flow is tests/e2e/browser/thread-groups-folds.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import type { ThreadGroup } from '../../src/core/org/thread-groups.js'
import { movesBetween, placesOf, shownGroups, stepMoves, type PlacedCard } from '../../web/src/components/org/thread-moves'

type G = Record<ThreadGroup, PlacedCard[]>
const empty = (): G => ({ needs: [], read: [], working: [], waiting: [], known: [], done: [], archived: [] })
const c = (id: string) => ({ id, title: `Card ${id}` })
function groups(parts: Partial<G>): G { return { ...empty(), ...parts } }
/** On screen with these folds opened. */
const on = (...opened: ThreadGroup[]) => shownGroups(new Set(opened))

describe('the line a moved card leaves', () => {
  it('a card that leaves the group on screen leaves a line at its place, naming where it went', () => {
    const before = placesOf(groups({ needs: [c('a'), c('b'), c('c')] }))
    const after = placesOf(groups({ needs: [c('a'), c('c')], working: [c('b')] }))
    // Needs you is always on screen: into a folded group (Working), out of sight.
    expect(movesBetween(before, after, on())).toEqual([{ id: 'b', title: 'Card b', from: 'needs', to: 'working', index: 1 }])
    expect(movesBetween(before, after, on('working'))).toEqual([{ id: 'b', title: 'Card b', from: 'needs', to: 'working', index: 1 }])
    // Reopen from Closed, from Archived: only from a fold he opened.
    const closed = placesOf(groups({ done: [c('d')], archived: [c('e')] }))
    const reopened = placesOf(groups({ working: [c('d'), c('e')] }))
    expect(movesBetween(closed, reopened, on('done')).map((m) => [m.id, m.to])).toEqual([['d', 'working']])
    expect(movesBetween(closed, reopened, on('archived')).map((m) => [m.id, m.to])).toEqual([['e', 'working']])
    expect(movesBetween(closed, reopened, on()).map((m) => m.id)).toEqual([])
  })

  it('a new card, a deleted one, one that stayed and one moved out of sight leave none', () => {
    const before = placesOf(groups({ needs: [c('a')], working: [c('b')], waiting: [c('x')] }))
    const after = placesOf(groups({ needs: [c('n'), c('a')], waiting: [c('b')] }))
    // a stayed (its index moved, not its group), n is new, x was deleted; b moved Working to Waiting.
    expect(movesBetween(before, after, on())).toEqual([])
    expect(movesBetween(before, after, on('working')).map((m) => m.id)).toEqual(['b'])
    expect(movesBetween(before, after, on('waiting'))).toEqual([])
  })

  it('which groups are on screen: Needs you and Done always, a folded group only while opened', () => {
    expect([...on()]).toEqual(['needs', 'read'])
    expect([...on('archived', 'working')]).toEqual(['needs', 'read', 'working', 'archived'])
  })

  it('a read that caught the pane up draws no line, and the next real move does', () => {
    // He looked at Needs you, left; a and b moved while he was away. The pane opens on the store's
    // old copy, then its first read (a catch-up: epoch 1) brings the new groups.
    const old = { places: placesOf(groups({ needs: [c('a'), c('b')] })), shown: on(), epoch: 0 }
    const caught = { places: placesOf(groups({ working: [c('a')], waiting: [c('b')] })), shown: on(), epoch: 1 }
    expect(stepMoves(old, caught, [])).toEqual([])
    // A reconnect read the same (epoch 2), lines already on show stay as they were.
    const line = { id: 'z', title: 'Card z', from: 'needs' as const, to: 'working' as const, index: 0 }
    const after = { places: placesOf(groups({ needs: [c('a')], waiting: [c('b')], working: [c('z')] })), shown: on(), epoch: 2 }
    expect(stepMoves(caught, after, [line])).toEqual([line])
    // Within one epoch, a real move draws its line.
    const moved = { places: placesOf(groups({ working: [c('a'), c('z')], waiting: [c('b')] })), shown: on(), epoch: 2 }
    expect(stepMoves(after, moved, []).map((m) => [m.id, m.to])).toEqual([['a', 'working']])
    // The first read of a pane draws none.
    expect(stepMoves(null, moved, [])).toEqual([])
  })

  it('a line on show names where its card is now, not where it went first', () => {
    // In Done he acknowledges a card with ack_means_known on: drawn in Closed at once (his click),
    // then the server keeps it open and it sits in Acknowledged, a folded group.
    const read = { places: placesOf(groups({ read: [c('a'), c('b')] })), shown: on(), epoch: 0 }
    const closed = { places: placesOf(groups({ read: [c('b')], done: [c('a')] })), shown: on(), epoch: 0 }
    const known = { places: placesOf(groups({ read: [c('b')], known: [c('a')] })), shown: on(), epoch: 0 }
    const first = stepMoves(read, closed, [])
    expect(first.map((m) => [m.id, m.from, m.to])).toEqual([['a', 'read', 'done']])
    const second = stepMoves(closed, known, first)
    expect(second.map((m) => [m.id, m.from, m.to, m.index])).toEqual([['a', 'read', 'known', 0]])
    // Nothing moved: the same lines, so nothing redraws.
    expect(stepMoves(known, { ...known }, second)).toBe(second)
    // A new title is read too.
    const renamed = { ...known, places: placesOf(groups({ read: [c('b')], known: [{ id: 'a', title: 'New name' }] })) }
    expect(stepMoves(known, renamed, second)[0]?.title).toBe('New name')
    // So does a read that caught the pane up: it adds no line but keeps each one true.
    const caught = { places: placesOf(groups({ read: [c('b')], working: [c('a')] })), shown: on(), epoch: 1 }
    expect(stepMoves(known, caught, second).map((m) => m.to)).toEqual(['working'])
    // Back in the group it left, or gone from the list: the line goes.
    expect(stepMoves(known, read, second)).toEqual([])
    expect(stepMoves(known, { ...known, places: placesOf(groups({ read: [c('b')] })) }, second)).toEqual([])
  })

  it('a fold opened or closed is not a move: opening keeps the lines, folding takes its own away', () => {
    // A card left Needs you for Working (folded): its line stands in Needs you.
    const a = { places: placesOf(groups({ needs: [c('a'), c('b')], working: [c('w')] })), shown: on(), epoch: 0 }
    const b = { ...a, places: placesOf(groups({ needs: [c('a')], working: [c('w'), c('b')] })) }
    const lines = stepMoves(a, b, [])
    expect(lines.map((m) => [m.id, m.from, m.to])).toEqual([['b', 'needs', 'working']])
    // He opens Working (Show): the line stays until it is dismissed; no move is read from the fold opening.
    const opened = { ...b, shown: on('working') }
    expect(stepMoves(b, opened, lines)).toBe(lines)
    // A card that left Working while it was opened leaves a line there; folding Working takes it away.
    const left = { ...opened, places: placesOf(groups({ needs: [c('a')], working: [c('b')], waiting: [c('w')] })) }
    const both = stepMoves(opened, left, lines)
    expect(both.map((m) => [m.id, m.from])).toEqual([['b', 'needs'], ['w', 'working']])
    // b's line stays (b is still away from Needs you, in Working), w's goes with its fold.
    expect(stepMoves(left, { ...left, shown: on() }, both).map((m) => m.id)).toEqual(['b'])
    // A card that moved out of a group in the same read it was opened gives no line.
    const c2 = { ...a, places: placesOf(groups({ needs: [c('a'), c('b')], done: [c('w')] })), shown: on('working') }
    expect(stepMoves(a, c2, [])).toEqual([])
  })
  it('his own Acknowledge leaves no line, from any screen; a move the node makes still does', () => {
    const at = '2026-11-25T02:00:00.000Z'
    const before = placesOf(groups({ read: [c('a'), c('b'), c('n')] }))
    // a: he acknowledged it (to Acknowledged); b: a second Acknowledge closed it; n: the node moved it to Working.
    const after = placesOf(groups({ read: [], known: [{ ...c('a'), ackedAt: at }], done: [{ ...c('b'), closed: { how: 'acked', by: 'human', at } }], working: [c('n')] }))
    expect(movesBetween(before, after, on()).map((m) => [m.id, m.to])).toEqual([['n', 'working']])
    // The node closing a card leaves its line: he did not make that move.
    const nodeClosed = placesOf(groups({ done: [{ ...c('a'), closed: { how: 'acked', by: 'agent', at } }] }))
    expect(movesBetween(placesOf(groups({ read: [c('a')] })), nodeClosed, on()).map((m) => m.id)).toEqual(['a'])
    // His answer to a Board choice or a letter closes its card the same way: not an Acknowledge, its line stays.
    const answered = placesOf(groups({ done: [{ ...c('a'), choice: { id: 'net-when' }, closed: { how: 'acked', by: 'human', at } }, { ...c('b'), letter: { id: 'l1' }, closed: { how: 'acked', by: 'human', at } }] }))
    expect(movesBetween(placesOf(groups({ needs: [c('a'), c('b')] })), answered, on()).map((m) => m.id)).toEqual(['a', 'b'])
    // An older Acknowledge of the card does not hide a later move the node makes.
    const old = placesOf(groups({ read: [{ ...c('a'), ackedAt: at }] }))
    expect(movesBetween(old, placesOf(groups({ working: [{ ...c('a'), ackedAt: at }] })), on()).map((m) => m.id)).toEqual(['a'])
  })

  it('a line on show goes once he acknowledges its card', () => {
    const a = { places: placesOf(groups({ read: [c('a')] })), shown: on('working'), epoch: 0 }
    const b = { ...a, places: placesOf(groups({ working: [c('a')] })) }
    const lines = stepMoves(a, b, [])
    expect(lines.map((m) => m.id)).toEqual(['a'])
    const acked = { ...b, places: placesOf(groups({ known: [{ ...c('a'), ackedAt: '2026-11-25T02:01:00.000Z' }] })) }
    expect(stepMoves(b, acked, lines)).toEqual([])
  })
})
