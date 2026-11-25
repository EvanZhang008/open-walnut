/**
 * What the thread check remembers and counts (src/core/org/thread-audit-store.ts): a told finding
 * stays while it is found, is counted fixed once it is not, the day rows add up per node and kind,
 * and days past 60, verdicts past 14 days and nodes not checked in 60 days are dropped. Pure, plus
 * one locked write through a temp home.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-thread-audit-store'))

import type { AuditFinding } from '../../../src/core/org/thread-audit-rules.js'
import {
  DAYS_KEPT, countsView, dayOf, emptyNode, normalizeAudit, readAudit, recordPass, settleTold, trimAudit, updateAudit, zeroKinds, type AuditFile,
} from '../../../src/core/org/thread-audit-store.js'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const DAY = 24 * 3_600_000
const f = (kind: AuditFinding['kind'], id: string): AuditFinding => ({ kind, key: `${kind}:${id}`, thread: { id, title: 'Fence', state: 'answered', taskId: 'n1' }, why: 'test' })
const empty = (): AuditFile => normalizeAudit(null)

describe('told and fixed', () => {
  it('a told finding found again stays; one not found is fixed; a repeat not judged this pass stands; the ones told now are stamped', () => {
    const node = { ...emptyNode(), told: {
      'stale:th-1': { kind: 'stale' as const, at: new Date(NOW - DAY).toISOString() },
      'thin:th-2': { kind: 'thin' as const, at: new Date(NOW - DAY).toISOString() },
      'repeat:th-3+th-4': { kind: 'repeat' as const, at: new Date(NOW - DAY).toISOString() },
      'repeat:th-5+th-6': { kind: 'repeat' as const, at: new Date(NOW - DAY).toISOString() },
    } }
    const r = settleTold(node, [f('stale', 'th-1'), f('unasked', 'th-7')], new Set(['repeat:th-3+th-4']), [f('unasked', 'th-7')], NOW)
    expect(Object.keys(r.node.told).sort()).toEqual(['repeat:th-3+th-4', 'stale:th-1', 'unasked:th-7'])
    expect(r.node.told['stale:th-1'].at).toBe(new Date(NOW - DAY).toISOString())
    expect(r.node.told['unasked:th-7']).toEqual({ kind: 'unasked', at: new Date(NOW).toISOString() })
    expect(r.fixed).toEqual({ ...zeroKinds(), thin: 1, repeat: 1 })
  })
})

describe('the day rows', () => {
  it('add up per day, node and kind, with the model calls and their milliseconds', () => {
    let file = recordPass(empty(), 'n1', emptyNode(), { found: [f('stale', 'a'), f('thin', 'b')], reported: [f('stale', 'a')], fixed: zeroKinds(), calls: 1, callMs: 1200 }, NOW)
    file = recordPass(file, 'n1', emptyNode(), { found: [f('stale', 'a')], reported: [], fixed: { ...zeroKinds(), thin: 1 }, calls: 0, callMs: 0 }, NOW + 1000)
    file = recordPass(file, 'n2', emptyNode(), { found: [f('repeat', 'c')], reported: [f('repeat', 'c')], fixed: zeroKinds(), calls: 1, callMs: 800 }, NOW + 2000)
    const row = file.days[dayOf(NOW)].n1
    expect(row).toMatchObject({ passes: 2, calls: 1, callMs: 1200 })
    expect(row.found).toMatchObject({ stale: 2, thin: 1 })
    expect(row.reported).toMatchObject({ stale: 1, thin: 0 })
    expect(row.fixed).toMatchObject({ thin: 1 })
    expect(file.nodes.n1.lastPassAt).toBe(new Date(NOW + 1000).toISOString())
    const view = countsView(file, { days: 7 }, NOW)
    expect(view.totals).toMatchObject({ passes: 3, calls: 2, callMs: 2000 })
    expect(view.totals.found).toMatchObject({ repeat: 1, stale: 2, thin: 1 })
    expect(countsView(file, { days: 7, task: 'n2' }, NOW).totals.passes).toBe(1)
    expect(countsView(file, { days: 7, task: 'none' }, NOW).days).toEqual([])
  })

  it('keeps 60 days: older days, verdicts past 14 days and nodes not checked in 60 days go', () => {
    const old = new Date(NOW - (DAYS_KEPT + 1) * DAY).toISOString()
    const file: AuditFile = {
      version: 1,
      days: { [dayOf(NOW - DAYS_KEPT * DAY)]: {}, [dayOf(NOW - (DAYS_KEPT - 1) * DAY)]: {}, [dayOf(NOW)]: {} },
      nodes: {
        gone: { ...emptyNode(), lastPassAt: old },
        kept: { ...emptyNode(), lastPassAt: new Date(NOW).toISOString(), judged: {
          'repeat:a+b': { verdict: 'same', sig: 's', at: new Date(NOW - 15 * DAY).toISOString() },
          'repeat:c+d': { verdict: 'different', sig: 's', at: new Date(NOW - 13 * DAY).toISOString() },
        } },
      },
    }
    const t = trimAudit(file, NOW)
    expect(Object.keys(t.days).sort()).toEqual([dayOf(NOW - (DAYS_KEPT - 1) * DAY), dayOf(NOW)])
    expect(Object.keys(t.nodes)).toEqual(['kept'])
    expect(Object.keys(t.nodes.kept.judged)).toEqual(['repeat:c+d'])
  })

  it('a malformed file reads as empty, and a write goes through the lock', async () => {
    expect(normalizeAudit({ nodes: { x: { told: 'bad' } }, days: [] })).toEqual({ version: 1, nodes: { x: { told: {}, judged: {} } }, days: {} })
    await updateAudit((cur) => recordPass(cur, 'n1', emptyNode(), { found: [], reported: [], fixed: zeroKinds(), calls: 0, callMs: 0 }, Date.now()))
    expect((await readAudit()).nodes.n1.lastPassAt).toBeTruthy()
  })
})
