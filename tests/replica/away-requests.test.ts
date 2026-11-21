/**
 * The reply requests a host replica shows while the Mac is away (src/replica/away-requests.ts):
 * its requests copy with the `row` and `settle` records of this host's journal folded over it,
 * so request_get finds a request the host's daemon opened alone and open_items lists the
 * caller's open requests both ways, as the daemon's own away answers did (opRequestGet,
 * opOpenItems). The overlay keeps those records (overlay.ts keyOfRecord `requests`), and the
 * request readers fold them in through session-requests.ts installAwayRequests.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-away-requests'))

import { WALNUT_HOME } from '../../src/constants.js'
import { foldAwayRequests } from '../../src/replica/away-requests.js'
import { createOverlay, keyOfRecord } from '../../src/replica/overlay.js'
import {
  getSessionRequest, installAwayRequests, pendingRequestsForTarget, pendingRequestsFromSession, type SessionRequest,
} from '../../src/core/session-requests.js'
import { requestOfRow } from '../../src/core/offline-merge/request-row.js'

const ASKER = 'aaaaaaaa-1111-4111-8111-000000000001'
const TARGET = 'bbbbbbbb-2222-4222-8222-000000000002'
const T0 = Date.parse('2026-11-21T09:00:00Z')

const copyRow = (id: string, over: Partial<SessionRequest> = {}): SessionRequest => ({
  id, fromSessionId: ASKER, toSessionId: TARGET, toTaskId: 'mtask-target', preview: 'Is the marina build green?',
  status: 'pending', createdAt: new Date(T0).toISOString(), deadlineAt: T0 + 3_600_000, ...over,
})
const rowRecord = (seq: number, id: string, over: Record<string, unknown> = {}) => ({
  v: 1, seq, at: T0 + seq * 1_000, kind: 'row',
  row: { id, fromSessionId: ASKER, toSessionId: TARGET, toTaskId: 'mtask-target', preview: 'Asked while away', status: 'pending', createdAt: new Date(T0 + seq * 1_000).toISOString(), deadlineAt: T0 + 7_200_000, messageId: 'qm-offline-0011', ...over },
})
const settleRecord = (seq: number, requestId: string) => ({ v: 1, seq, at: T0 + seq * 1_000, kind: 'settle', requestId, status: 'replied' })
const entry = (r: Record<string, unknown>) => ({ kind: String(r.kind), seq: r.seq as number, at: r.at as number, record: r })

afterEach(() => {
  installAwayRequests(null)
  fs.rmSync(path.join(WALNUT_HOME, 'session-requests.json'), { force: true })
})

describe('foldAwayRequests', () => {
  it('adds a request the daemon opened, shows a copy\'s request answered here as replied, and keeps the rest', () => {
    const copy = [copyRow('rq-aaaaaa000001'), copyRow('rq-aaaaaa000002')]
    const out = foldAwayRequests(copy, [entry(rowRecord(5, 'rq-bbbbbb000001')), entry(settleRecord(6, 'rq-aaaaaa000002'))])
    expect(out.map((r) => [r.id, r.status])).toEqual([['rq-aaaaaa000001', 'pending'], ['rq-aaaaaa000002', 'replied'], ['rq-bbbbbb000001', 'pending']])
    expect(out[1]!.settledAt).toBe(new Date(T0 + 6_000).toISOString())
    // Shown in the very shape the Mac's drain imports it in.
    expect(out[2]).toEqual(requestOfRow(rowRecord(5, 'rq-bbbbbb000001').row as never))
  })

  it('a row\'s newest record wins; a copy row the Mac already settled keeps its final status', () => {
    const later = foldAwayRequests([], [entry(rowRecord(9, 'rq-bbbbbb000001', { status: 'notified', outcome: 'completed' })), entry(rowRecord(4, 'rq-bbbbbb000001'))])
    expect(later).toEqual([expect.objectContaining({ id: 'rq-bbbbbb000001', status: 'notified' })])
    const settled = foldAwayRequests([copyRow('rq-bbbbbb000001', { status: 'replied' })], [entry(rowRecord(4, 'rq-bbbbbb000001'))])
    expect(settled).toEqual([expect.objectContaining({ id: 'rq-bbbbbb000001', status: 'replied' })])
    // Nothing of the journal: the copy as it is; a record that is no request row is passed over.
    const copy = [copyRow('rq-aaaaaa000001')]
    expect(foldAwayRequests(copy, [])).toBe(copy)
    expect(foldAwayRequests(copy, [entry({ seq: 3, at: T0, kind: 'row', row: { id: 'not-a-request' } })])).toEqual(copy)
  })
})

describe('the overlay keeps a request\'s records', () => {
  it('row and settle records key the request, pending and then awaiting the copy, so the fold sees them', async () => {
    expect(keyOfRecord(rowRecord(1, 'rq-bbbbbb000001'))).toEqual({ kind: 'requests', id: 'rq-bbbbbb000001' })
    expect(keyOfRecord(settleRecord(2, 'rq-aaaaaa000002'))).toEqual({ kind: 'requests', id: 'rq-aaaaaa000002' })
    expect(keyOfRecord({ kind: 'delivery', seq: 3 })).toBeNull()
    let records: Array<Record<string, unknown>> = [rowRecord(1, 'rq-bbbbbb000001'), settleRecord(2, 'rq-aaaaaa000002')]
    const overlay = createOverlay({ fetchPending: async () => ({ records: [...records], nextSeq: 3 }), now: () => T0 })
    await overlay.refresh()
    expect(foldAwayRequests([copyRow('rq-aaaaaa000002')], overlay.entries()).map((r) => [r.id, r.status])).toEqual([['rq-aaaaaa000002', 'replied'], ['rq-bbbbbb000001', 'pending']])
    // The Mac took them: still shown until its copy holds them (or ten minutes pass).
    records = []
    await overlay.refresh()
    expect(overlay.watching('requests').sort()).toEqual(['rq-aaaaaa000002', 'rq-bbbbbb000001'])
    expect(foldAwayRequests([], overlay.entries()).map((r) => r.id)).toEqual(['rq-bbbbbb000001'])
    overlay.stored('requests', ['rq-bbbbbb000001', 'rq-aaaaaa000002'], T0 + 1)
    expect(overlay.entries()).toEqual([])
    overlay.close()
  })
})

describe('the request readers on a host replica', () => {
  it('request_get finds the daemon\'s own request, and both sides of open_items list it', async () => {
    fs.mkdirSync(WALNUT_HOME, { recursive: true })
    fs.writeFileSync(path.join(WALNUT_HOME, 'session-requests.json'), JSON.stringify({ requests: [copyRow('rq-aaaaaa000001')] }))
    // Nothing installed (the Mac, the companion): the store alone.
    expect(await getSessionRequest('rq-bbbbbb000001')).toBeUndefined()
    installAwayRequests(async (rows) => foldAwayRequests(rows, [entry(rowRecord(5, 'rq-bbbbbb000001'))]))
    expect(await getSessionRequest('rq-bbbbbb000001')).toMatchObject({ id: 'rq-bbbbbb000001', status: 'pending', fromSessionId: ASKER })
    expect((await pendingRequestsFromSession(ASKER)).map((r) => r.id).sort()).toEqual(['rq-aaaaaa000001', 'rq-bbbbbb000001'])
    expect((await pendingRequestsForTarget({ sessionId: TARGET })).map((r) => r.id).sort()).toEqual(['rq-aaaaaa000001', 'rq-bbbbbb000001'])
    // A fold that fails answers the store as it is.
    installAwayRequests(async () => { throw new Error('daemon gone') })
    expect((await pendingRequestsFromSession(ASKER)).map((r) => r.id)).toEqual(['rq-aaaaaa000001'])
  })
})
