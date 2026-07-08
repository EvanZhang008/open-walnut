/**
 * Convergence sentinel — the pure diff at its core (P3-lite).
 *
 * Invariant: every streamed text msgId must appear in persisted history after
 * the turn ends. Direction is one-way (streamed ⊆ persisted); persisted ids
 * that never streamed are normal (replays, subagents, mid-turn reconnects).
 */
import { describe, it, expect } from 'vitest'
import { diffStreamedVsPersisted } from '../../../src/core/observability/stream-convergence.js'

describe('diffStreamedVsPersisted', () => {
  it('converged: every streamed id persisted', () => {
    const d = diffStreamedVsPersisted(['msg_a', 'msg_b'], new Set(['msg_a', 'msg_b', 'msg_older']))
    expect(d.missing).toEqual([])
    expect(d.checked).toBe(2)
  })

  it('flags streamed ids missing from history (the vanish class)', () => {
    const d = diffStreamedVsPersisted(['msg_a', 'msg_b'], new Set(['msg_a']))
    expect(d.missing).toEqual(['msg_b'])
    expect(d.checked).toBe(2)
  })

  it('extra persisted ids are NOT a violation (one-way check)', () => {
    const d = diffStreamedVsPersisted(['msg_a'], new Set(['msg_a', 'msg_x', 'msg_y']))
    expect(d.missing).toEqual([])
  })

  it('dedupes streamed ids: one message streamed as many blocks counts once', () => {
    // Text split across tool calls streams as several blocks of one msgId.
    const d = diffStreamedVsPersisted(['msg_a', 'msg_a', 'msg_a'], new Set<string>())
    expect(d.missing).toEqual(['msg_a'])
    expect(d.checked).toBe(1)
  })

  it('empty streamed set is vacuously converged', () => {
    const d = diffStreamedVsPersisted([], new Set(['msg_a']))
    expect(d.missing).toEqual([])
    expect(d.checked).toBe(0)
  })

  it('order/position is irrelevant — only id presence matters (/compact-proof)', () => {
    // A compact may reorder and renumber history arbitrarily; ids survive.
    const d = diffStreamedVsPersisted(['msg_b', 'msg_a'], new Set(['msg_a', 'msg_b']))
    expect(d.missing).toEqual([])
  })
})
