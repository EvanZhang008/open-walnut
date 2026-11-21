/**
 * The groups of a node's Threads in the user's own words (src/core/org/thread-groups.ts; 2026-11-20,
 * the user: "No Need you, Done, waiting / snoozed, Acknowlegde, closed, archived", then of
 * Acknowledge: "if I ack and ai should determine if it should go to closed or wait or wip", "keep
 * Acknowledged, simpler").
 *
 *  - The groups are exactly Needs you, Done, Working, Waiting / Snoozed, Acknowledged, Closed,
 *    Archived, plus All, which shows every group but Archived.
 *  - Every thread shape the model can hold (each state, closed or not and how long ago, snoozed,
 *    asked in a task, acknowledged and not placed yet or placed in each place, listed or not) is in
 *    exactly one group, and the old groups map without a loss: To read to Done, Known to
 *    Acknowledged, Working or Waiting / Snoozed, Done to Closed (or Archived once a day old). A thread of a task below
 *    (`owner`) is left out of the mapping check: its line is another change's (thread-groups.ts).
 */
import { describe, expect, it } from 'vitest'
import { THREAD_STATES, type OrgThread } from '../../../src/core/org/threads-model.js'
import { ALL_SHOWS, ARCHIVE_AFTER_MS, THREAD_GROUPS, THREAD_GROUP_LABELS, groupThreads, threadGroupOf, threadStateOf, type ThreadGroup } from '../../../src/core/org/thread-groups.js'
import { isKnown } from '../../../src/core/org/thread-known.js'
import { snoozedNow } from '../../../src/core/org/thread-view.js'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

/** The groups as they were before 2026-11-20 (needs, read, known, working, waiting, done), owner line aside. */
function oldGroupOf(t: OrgThread, listed: boolean): string {
  if (t.closed) return 'done'
  if (snoozedNow(t, NOW)) return 'waiting'
  if (t.askedIn && !t.askedIn.answered) return 'waiting'
  if (t.state === 'needs') return 'needs'
  if (t.state === 'answered') return listed ? 'read' : 'waiting'
  if (isKnown(t)) return 'known'
  if (t.state === 'pending') return 'waiting'
  return 'working'
}

/** Where each old group may land now. */
const OLD_TO_NEW: Record<string, readonly ThreadGroup[]> = {
  needs: ['needs'], read: ['read'], known: ['known', 'working', 'waiting'], working: ['working'], waiting: ['waiting'], done: ['done', 'archived'],
}

/** Every shape: state x closed (none, now, a day ago) x snoozed x asked in a task x acked (no, not placed, placed in each place) x listed. */
function shapes(): Array<{ t: OrgThread; listed: boolean; name: string }> {
  const out: Array<{ t: OrgThread; listed: boolean; name: string }> = []
  let n = 0
  for (const state of THREAD_STATES) {
    for (const closed of [undefined, ago(60_000), ago(ARCHIVE_AFTER_MS)]) {
      for (const snoozed of [false, true]) {
        for (const asked of [undefined, false, true]) {
          for (const ack of [undefined, 'working', 'waiting', 'closed', 'none']) {
            for (const listed of [false, true]) {
              const t = {
                id: `th-${(n++).toString(16).padStart(12, '0')}`, title: 'Seed trays', state, createdAt: ago(3_600_000), updatedAt: ago(60_000),
                messages: [{ id: 'tm-aaaaaaaaaaaa', at: ago(3_000_000), text: 'Order seed trays', via: 'chat' as const }],
                ...(closed ? { closed: { how: 'acked' as const, at: closed, by: 'human' } } : {}),
                ...(snoozed ? { snoozed: { until: new Date(NOW + 3_600_000).toISOString(), at: ago(60_000) } } : {}),
                ...(asked !== undefined ? { askedIn: { task: 't-1', title: 'Trays', ask: 'Which size?', via: 'owner' as const, ...(asked ? { answered: true } : {}) } } : {}),
                ...(ack ? { ackedAt: ago(1_000_000), ...(ack !== 'none' ? { ackPlaced: { to: ack as 'working', by: 'node' as const, at: ago(900_000) } } : {}) } : {}),
              } as OrgThread
              out.push({ t, listed, name: `${state} closed=${!!closed} snoozed=${snoozed} asked=${asked} ack=${ack} listed=${listed}` })
            }
          }
        }
      }
    }
  }
  return out
}

describe('the groups of his Threads', () => {
  it('are exactly Needs you, Done, Working, Waiting / Snoozed, Acknowledged, Closed and Archived, in that order', () => {
    expect(THREAD_GROUPS).toEqual(['needs', 'read', 'working', 'waiting', 'known', 'done', 'archived'])
    expect(THREAD_GROUPS.map((g) => THREAD_GROUP_LABELS[g])).toEqual(['Needs you', 'Done', 'Working', 'Waiting / Snoozed', 'Acknowledged', 'Closed', 'Archived'])
    // All shows every group but Archived, which shows only on its own chip.
    expect(ALL_SHOWS).toEqual(['needs', 'read', 'working', 'waiting', 'known', 'done'])
  })

  it('every thread shape is in exactly one group, and the old groups map without a loss', () => {
    const all = shapes()
    expect(all.length).toBe(THREAD_STATES.length * 3 * 2 * 3 * 5 * 2)
    for (const { t, listed, name } of all) {
      const g = threadGroupOf(t, listed, NOW)
      expect(THREAD_GROUPS, name).toContain(g)
      expect(OLD_TO_NEW[oldGroupOf(t, listed)], `${name}: was ${oldGroupOf(t, listed)}, now ${g}`).toContain(g)
    }
    // groupThreads puts each in one group, none lost.
    const ts = all.filter((x) => !x.listed).map((x) => x.t)
    const groups = groupThreads(ts, NOW)
    expect(Object.values(groups).flat()).toHaveLength(ts.length)
    expect(new Set(Object.values(groups).flat().map((t) => t.id)).size).toBe(ts.length)
  })

  it('a thread he acknowledged is in Acknowledged until placed, then where it was placed', () => {
    const held = (to?: 'working' | 'waiting', at = ago(5e5)) => ({ id: 'th-bbbbbbbbbbbb', title: 'Trays', state: 'pending', createdAt: ago(9e6), updatedAt: ago(1e6), messages: [], ackedAt: ago(1e6), ...(to ? { ackPlaced: { to, by: 'node', at } } : {}) }) as OrgThread
    expect(threadGroupOf(held(), false, NOW)).toBe('known')
    expect(threadGroupOf(held('working'), false, NOW)).toBe('working')
    expect(threadGroupOf(held('waiting'), false, NOW)).toBe('waiting')
    // A placement from before this Acknowledge does not count: it is deciding again.
    expect(threadGroupOf(held('waiting', ago(2e6)), false, NOW)).toBe('known')
    // A task's Board chip reads one in Acknowledged as waiting: nothing there is his.
    expect(threadStateOf([held()], NOW)?.state).toBe('waiting')
  })

  it('a closed thread is Closed for a day, then Archived', () => {
    const closed = (at: string) => ({ id: 'th-cccccccccccc', title: 'Trays', state: 'answered', createdAt: ago(9e7), updatedAt: at, messages: [], closed: { how: 'acked', at, by: 'human' } }) as OrgThread
    expect(threadGroupOf(closed(ago(ARCHIVE_AFTER_MS - 1)), false, NOW)).toBe('done')
    expect(threadGroupOf(closed(ago(ARCHIVE_AFTER_MS)), false, NOW)).toBe('archived')
  })

  it('a task reads its first open group: needs > read > working > waiting, never a closed one', () => {
    const th = (id: string, state: string, extra: Partial<OrgThread> = {}) => ({ id, title: id, state, createdAt: ago(9e6), updatedAt: ago(1e6), messages: [], ...extra }) as OrgThread
    expect(threadStateOf([th('w', 'pending'), th('k', 'working')], NOW)?.state).toBe('working')
    expect(threadStateOf([th('w', 'pending')], NOW)?.state).toBe('waiting')
    expect(threadStateOf([th('c', 'answered', { closed: { how: 'acked', at: ago(1e5), by: 'human' } as never })], NOW)).toBeNull()
  })
})
