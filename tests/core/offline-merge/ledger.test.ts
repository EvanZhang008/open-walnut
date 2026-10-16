/**
 * The applied-ops ledger (src/core/offline-merge/ledger.ts), on a real sqlite file in a
 * temp home, alone and under the real drain (runOfflineHandover over journal-v2):
 *   - the key carries the host: host A and host B both holding `v1-<hash>` style ids
 *     from different journals apply both;
 *   - the same op id with a new rev applies (a coalesced save appended rev + 1);
 *   - two requests with the same op id, the second sent while the first is still in
 *     its handler, apply once and both get the first answer; a drain record whose op a
 *     forward is still applying waits for it and then applies nothing;
 *   - rows expire after 30 days.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-ledger'))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

import { LEDGER_TTL_MS, lookupApplied, recordApplied, reserveOp, _setLedgerFileForTesting } from '../../../src/core/offline-merge/ledger.js'
import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const SID = 'dddddddd-4444-4444-8444-444444444444'
let seq = 0

function rec(taskId: string, opId: string, value: unknown, rev = 1, field = 'priority', base: unknown = 'none'): Record<string, unknown> & { seq: number } {
  return { v: 2, seq: ++seq, at: Date.now(), kind: 'task-fields', opId, rev, actor: { kind: 'session', sid: SID }, op: 'task_update', taskId, fields: { [field]: { base, value } } }
}

async function drain(host: string, records: Array<Record<string, unknown> & { seq: number }>): Promise<number[]> {
  const acked: number[] = []
  let handed = false
  await runOfflineHandover({
    hostKey: host, journalV2: true,
    send: async (cmd, params) => {
      if (cmd === 'offline.ack') { acked.push(...((params?.seqs as number[]) ?? [])); return { ok: true } }
      if (cmd === 'offline.drain') { const r = handed ? [] : records; handed = true; return { ok: true, records: r, now: Date.now() } }
      return { ok: true }
    },
  })
  return acked
}

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _setHandoverBackoffForTesting([])
})

afterAll(() => {
  _setHandoverBackoffForTesting(null)
  _setLedgerFileForTesting(null)
  closeDb()
})

describe('applied-ops ledger', () => {
  it('cross-host: host A and host B both with v1-style ids from different journals apply both', async () => {
    const a = (await addTask({ title: 'On marina', project: 'Acme' })).task.id
    const b = (await addTask({ title: 'On acme', project: 'Acme' })).task.id
    const sameId = 'v1-0123456789abcdef'
    expect(await drain('marina', [rec(a, sameId, 'immediate')])).toHaveLength(1)
    expect(await drain('acme', [rec(b, sameId, 'backlog')])).toHaveLength(1)
    expect((await getTask(a)).priority).toBe('immediate')
    expect((await getTask(b)).priority).toBe('backlog')
    expect(lookupApplied({ hostKey: 'marina', home: WALNUT_HOME, opId: sameId, rev: 1 })).toMatchObject({ outcome: 'applied' })
    expect(lookupApplied({ hostKey: 'acme', home: WALNUT_HOME, opId: sameId, rev: 1 })).toMatchObject({ outcome: 'applied' })
    // The same host again: the ledger has it, nothing is applied.
    await drain('marina', [rec(a, sameId, 'important')])
    expect((await getTask(a)).priority).toBe('immediate')
  })

  it('the same op id with a new rev applies', async () => {
    const id = (await addTask({ title: 'Coalesced', project: 'Acme' })).task.id
    await drain('marina', [rec(id, 'op-coalesce-0001', 'immediate', 1, 'title', 'Coalesced')])
    await drain('marina', [rec(id, 'op-coalesce-0001', 'Coalesced twice', 2, 'title', 'Coalesced')])
    expect((await getTask(id)).title).toBe('Coalesced twice')
  })

  it('two requests with the same op id, the second while the first is in its handler: one apply, both get the first answer', async () => {
    const key = { hostKey: 'local', home: WALNUT_HOME, opId: 'op-inflight-ledger', rev: 1 }
    const first = reserveOp(key)
    expect(first.owner).toBe(true)
    const second = reserveOp(key)
    expect(second.owner).toBe(false)
    let applies = 0
    if (first.owner) { applies++; recordApplied(key, { outcome: 'applied', status: 201, body: '{"n":1}' }); first.finish({ outcome: 'applied', status: 201, body: '{"n":1}' }) }
    if (!second.owner) expect(await second.wait).toMatchObject({ status: 201, body: '{"n":1}' })
    expect(applies).toBe(1)
    // Once finished, a new request with the id is the owner again, and reads the stored answer first.
    expect(lookupApplied(key)).toMatchObject({ status: 201 })
  })

  it('a drain record whose op a forward is still applying waits for it, then applies nothing', async () => {
    const id = (await addTask({ title: 'Raced', project: 'Acme' })).task.id
    const key = { hostKey: 'marina', home: WALNUT_HOME, opId: 'op-forward-race1', rev: 1 }
    const forward = reserveOp(key)
    expect(forward.owner).toBe(true)
    const draining = drain('marina', [rec(id, 'op-forward-race1', 'immediate')])
    await new Promise((r) => setTimeout(r, 100))
    expect((await getTask(id)).priority).not.toBe('immediate')
    // The forward applies and records it (the middleware does this when its handler ends).
    recordApplied(key, { outcome: 'applied', status: 200 })
    if (forward.owner) forward.finish({ outcome: 'applied', status: 200 })
    expect(await draining).toHaveLength(1)
    expect((await getTask(id)).priority).not.toBe('immediate')
  })

  it('a row older than 30 days reads as absent', () => {
    const key = { hostKey: 'marina', home: WALNUT_HOME, opId: 'op-old-0000001', rev: 1 }
    recordApplied(key, { outcome: 'applied' }, 1_000)
    expect(lookupApplied(key, 1_000 + LEDGER_TTL_MS - 1)).not.toBeNull()
    expect(lookupApplied(key, 1_000 + LEDGER_TTL_MS)).toBeNull()
  })
})
