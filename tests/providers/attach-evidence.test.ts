/**
 * readAttachEvidence: an on-demand attach (a send waits on it) gives the host's
 * optional reads one budget; the startup attach waits for them as before.
 * 2026-11-12, send.delivery: two first sends after a reboot waited 37 s and 102 s
 * on these reads before their lines were written.
 */
import { describe, it, expect, vi } from 'vitest'
import { readAttachEvidence, EVIDENCE_TIMEOUT, type AttachEvidenceDeps, type StreamEvidence } from '../../src/providers/attach-evidence.js'

const record = { claudeSessionId: 'sid-1', host: 'devbox', cwd: '/w', consumedOffset: 42 }
const fold = { fold: { turnEnded: true }, fileSize: 10 } as unknown as StreamEvidence

function never<T>(): Promise<T> { return new Promise<T>(() => {}) }
function after<T>(ms: number, v: T): Promise<T> { return new Promise((r) => setTimeout(() => r(v), ms)) }

function deps(over: Partial<AttachEvidenceDeps>): AttachEvidenceDeps {
  return {
    readCostState: async () => ({ totalCostUsd: 1.5 }),
    fetchStreamTailFold: async () => fold,
    now: () => Date.now(),
    ...over,
  }
}

describe('readAttachEvidence', () => {
  it('passes fast reads through, with the record\'s host, session and watermark', async () => {
    const readCostState = vi.fn(async () => ({ totalCostUsd: 2 }))
    const fetchStreamTailFold = vi.fn(async () => fold)
    const ev = await readAttachEvidence(record, { needCost: true, budgetMs: 5000 }, deps({ readCostState, fetchStreamTailFold }))
    expect(ev).toEqual({ cost: { kind: 'read', value: { totalCostUsd: 2 } }, stream: fold })
    expect(readCostState).toHaveBeenCalledWith('devbox', 'sid-1', '/w')
    expect(fetchStreamTailFold).toHaveBeenCalledWith('sid-1', 'devbox', { consumedOffset: 42 })
  })

  it('a host that never answers costs a send the budget, not the reads\' own timeouts', async () => {
    const t0 = Date.now()
    const ev = await readAttachEvidence(record, { needCost: true, budgetMs: 80 },
      deps({ readCostState: () => never(), fetchStreamTailFold: () => never() }))
    const took = Date.now() - t0
    expect(ev).toMatchObject({ cost: { kind: 'timeout' }, stream: EVIDENCE_TIMEOUT })
    // Both reads share ONE budget (they run together), not one each.
    expect(took).toBeLessThan(80 * 2)
  })

  it('keeps the read that answered in time when the other one is slow', async () => {
    const ev = await readAttachEvidence(record, { needCost: true, budgetMs: 80 },
      deps({ readCostState: () => after(5, { totalCostUsd: 3 }), fetchStreamTailFold: () => never() }))
    expect(ev.cost).toEqual({ kind: 'read', value: { totalCostUsd: 3 } })
    expect(ev.stream).toBe(EVIDENCE_TIMEOUT)
  })

  it('a failing read is its own outcome, and a late rejection after the budget is swallowed', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const ev = await readAttachEvidence(record, { needCost: true, budgetMs: 30 }, deps({
        readCostState: () => Promise.reject(new Error('cost boom')),
        fetchStreamTailFold: () => after(60, null).then(() => { throw new Error('late') }),
      }))
      expect(ev.cost).toEqual({ kind: 'failed', error: 'Error: cost boom' })
      expect(ev.stream).toBe(EVIDENCE_TIMEOUT)
      await after(80, null)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('a stream fetch that throws in time reads as evidence-fetch-threw', async () => {
    const ev = await readAttachEvidence(record, { needCost: false, budgetMs: 1000 },
      deps({ fetchStreamTailFold: () => Promise.reject(new Error('boom')) }))
    expect(ev).toEqual({ cost: { kind: 'not-needed' }, stream: 'evidence-fetch-threw' })
  })

  it('does not read the cost state when the record already seeds the watermark', async () => {
    const readCostState = vi.fn(async () => ({ totalCostUsd: 9 }))
    const ev = await readAttachEvidence(record, { needCost: false, budgetMs: 1000 }, deps({ readCostState }))
    expect(readCostState).not.toHaveBeenCalled()
    expect(ev.cost).toEqual({ kind: 'not-needed' })
  })

  it('startup (no budget) waits for slow reads, one after the other', async () => {
    const order: string[] = []
    const ev = await readAttachEvidence(record, { needCost: true }, deps({
      readCostState: async () => { order.push('cost:start'); await after(40, null); order.push('cost:end'); return { totalCostUsd: 4 } },
      fetchStreamTailFold: async () => { order.push('stream:start'); await after(40, null); return fold },
    }))
    expect(ev).toEqual({ cost: { kind: 'read', value: { totalCostUsd: 4 } }, stream: fold })
    expect(order).toEqual(['cost:start', 'cost:end', 'stream:start'])
    expect(ev.late).toBeUndefined()
  })

  it('hands over the answers that missed the budget, and none that made it', async () => {
    const ev = await readAttachEvidence(record, { needCost: true, budgetMs: 30 }, deps({
      readCostState: () => after(80, { totalCostUsd: 7 }),
      fetchStreamTailFold: () => after(5, fold),
    }))
    expect(ev.cost).toEqual({ kind: 'timeout' })
    expect(ev.stream).toBe(fold)
    expect(ev.late?.stream).toBeUndefined()
    await expect(ev.late?.cost).resolves.toEqual({ kind: 'read', value: { totalCostUsd: 7 } })
  })

  it('a late read that fails hands over its failure, never a rejection', async () => {
    const ev = await readAttachEvidence(record, { needCost: true, budgetMs: 20 }, deps({
      readCostState: () => after(50, null).then(() => { throw new Error('late cost') }),
      fetchStreamTailFold: () => after(50, null).then(() => { throw new Error('late stream') }),
    }))
    await expect(ev.late?.cost).resolves.toEqual({ kind: 'failed', error: 'Error: late cost' })
    await expect(ev.late?.stream).resolves.toBe('evidence-fetch-threw')
  })

  it('a reader that throws before it returns a promise is a failed read', async () => {
    const ev = await readAttachEvidence(record, { needCost: true, budgetMs: 1000 }, deps({
      readCostState: () => { throw new Error('sync') },
    }))
    expect(ev.cost).toEqual({ kind: 'failed', error: 'Error: sync' })
  })

  it('local sessions read from __local__', async () => {
    const readCostState = vi.fn(async () => null)
    await readAttachEvidence({ ...record, host: undefined }, { needCost: true, budgetMs: 1000 }, deps({ readCostState }))
    expect(readCostState).toHaveBeenCalledWith('__local__', 'sid-1', '/w')
  })
})
