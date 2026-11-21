/**
 * Every thread shape the groups can be asked about (src/core/org/thread-groups.ts threadGroupOf):
 * state x closed (none, now, a day ago) x snoozed x asked in a task x acked (no, not placed, placed
 * in each place) x listed. Shared by the group tests (tests/core/org/thread-groups.test.ts) and the
 * card badge guard (tests/web/thread-badge.test.ts), so a new shape reaches both.
 */
import { THREAD_STATES, type OrgThread } from '../../../src/core/org/threads-model.js'
import { ARCHIVE_AFTER_MS } from '../../../src/core/org/thread-groups.js'

export const NOW = Date.parse('2026-11-20T12:00:00.000Z')
export const ago = (ms: number) => new Date(NOW - ms).toISOString()

/** Every shape: state x closed (none, now, a day ago) x snoozed x asked in a task x acked (no, not placed, placed in each place) x listed. */
export function threadShapes(): Array<{ t: OrgThread; listed: boolean; name: string }> {
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

