/**
 * How full a host's journal got while the Mac was away (`offline.drain` reply `fill`,
 * src/core/offline-merge/journal-fill.ts), against the real notification store of a temp home:
 *   - a host that refused writes, or held 80% of its room, raises ONE Walnut Health item per
 *     host (never a popup: audienceOf says health), whatever how many drains report it;
 *   - the rounds of one drain count together (the highest peak, every refusal);
 *   - a later drain below the mark with nothing refused recovers it;
 *   - an older daemon (no fill) raises nothing;
 *   - a store that hangs never holds the drain: its records are taken and acked.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-journal-fill'))
const hooks = vi.hoisted(() => ({ upsert: null as null | ((...a: unknown[]) => Promise<unknown>) }))
vi.mock('../../../src/core/notifications/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/notifications/store.js')>()
  return { ...real, upsertNotification: (...a: unknown[]) => (hooks.upsert ? hooks.upsert(...a) : (real.upsertNotification as (...x: unknown[]) => Promise<unknown>)(...a)) }
})

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { findNotification, listNotifications } from '../../../src/core/notifications/store.js'
import { audienceOf } from '../../../src/core/notifications/audience.js'
import { _resetJournalFillForTesting, journalFillKey } from '../../../src/core/offline-merge/journal-fill.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { closeDb } from '../../../src/core/task-db.js'

type Fill = { records: number; max: number; peak: number; refused: number }

/**
 * A host journal of plain request settles (no task needed) whose replies carry `fills`, one per
 * round. A round past the list carries none: a host counts each reply since its last one.
 */
function journal(hostKey: string, rounds: Array<{ records: Array<Record<string, unknown>>; fill?: Fill }>) {
  let round = 0
  const acked: number[] = []
  return {
    acked,
    conn: {
      hostKey, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') {
          const r = rounds[Math.min(round, rounds.length - 1)]
          const fill = round < rounds.length ? r.fill : undefined
          const pending = r.records.filter((x) => !acked.includes(x.seq as number))
          round++
          return { ok: true, records: pending, now: Date.now(), ...(fill ? { fill } : {}) }
        }
        if (cmd === 'offline.ack') acked.push(...((p?.seqs as number[]) ?? []))
        return { ok: true }
      },
    },
  }
}

let seqN = 100
const settle = () => ({ v: 1, seq: ++seqN, at: Date.now(), kind: 'settle', requestId: `rq-fill-${seqN}` })
/** Lets the never-awaited item write finish. */
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)) }

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  _resetJournalFillForTesting()
  _setHandoverBackoffForTesting([1, 1])
  hooks.upsert = null
})
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('a host journal that came near full while the Mac was away', () => {
  it('raises one Walnut Health item per host, and a later drain below the mark recovers it', async () => {
    await runOfflineHandover(journal('devbox', [{ records: [settle()], fill: { records: 3, max: 1000, peak: 850, refused: 0 } }]).conn as never)
    await flush()
    const first = await findNotification(journalFillKey('devbox'))
    expect(first).toMatchObject({ kind: 'operation-error', severity: 'warning', recoveryKey: 'offline-journal:devbox', host: 'devbox' })
    expect(first!.title).toContain('came near full')
    expect(first!.body).toContain('850 of the 1000')
    expect(first!.body).toContain('a plugin job')
    expect(first!.resolved).toBeUndefined()
    // Walnut's to look into, never a popup for the person.
    expect(audienceOf(first!)).toBe('health')

    // Refused writes on the next drain: still one item, now saying so.
    await runOfflineHandover(journal('devbox', [{ records: [settle()], fill: { records: 1000, max: 1000, peak: 1000, refused: 7 } }]).conn as never)
    await flush()
    const items = (await listNotifications()).feed.filter((n) => n.dedupKey === journalFillKey('devbox'))
    expect(items).toHaveLength(1)
    expect(items[0].title).toContain('refused 7 writes')

    // A drain that finds the journal low with nothing refused retires it.
    await runOfflineHandover(journal('devbox', [{ records: [settle()], fill: { records: 2, max: 1000, peak: 40, refused: 0 } }]).conn as never)
    await flush()
    expect((await findNotification(journalFillKey('devbox')))?.resolved).toBe('recovered')
  })

  it('counts the rounds of one drain together: a peak in the first round is not hidden by an empty last one', async () => {
    const records = [settle(), settle()]
    await runOfflineHandover(journal('acme-box', [
      { records, fill: { records: 900, max: 1000, peak: 950, refused: 0 } },
      { records: [], fill: { records: 0, max: 1000, peak: 1, refused: 0 } },
    ]).conn as never)
    await flush()
    expect((await findNotification(journalFillKey('acme-box')))?.title).toContain('came near full')
  })

  it('an older daemon (no fill) and a low fill raise nothing', async () => {
    await runOfflineHandover(journal('quiet-box', [{ records: [settle()] }]).conn as never)
    await runOfflineHandover(journal('calm-box', [{ records: [settle()], fill: { records: 5, max: 1000, peak: 700, refused: 0 } }]).conn as never)
    await flush()
    expect(await findNotification(journalFillKey('quiet-box'))).toBeNull()
    expect(await findNotification(journalFillKey('calm-box'))).toBeNull()
  })

  it('never holds the drain: a store that does not answer still lets every record be taken and acked', async () => {
    hooks.upsert = () => new Promise(() => {})
    const records = [settle(), settle(), settle()]
    const j = journal('stuck-box', [{ records, fill: { records: 1000, max: 1000, peak: 1000, refused: 12 } }])
    const result = await runOfflineHandover(j.conn as never)
    expect(result.records).toBe(3)
    expect(j.acked.sort()).toEqual(records.map((r) => r.seq).sort())
  })
})
