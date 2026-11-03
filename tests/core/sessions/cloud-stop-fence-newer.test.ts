/**
 * The phone's stop fence (src/core/sessions/cloud-stop-fence.ts) reads a stop that ended unconfirmed
 * (`failed`, session-stop.ts) as settled: a phone note of the same stop that still says pending must
 * not keep the session's sends refused as "stop pending" for the note's whole horizon.
 */
import { describe, it, expect } from 'vitest'
import { newerStop } from '../../../src/core/sessions/cloud-stop-fence.js'

describe('newerStop', () => {
  const pending = { id: 's1', state: 'pending', requestedAt: '2026-11-03T08:00:00.000Z' }
  it('one stop seen twice: its settled copy wins, confirmed or failed, whichever side it is on', () => {
    for (const state of ['confirmed', 'failed']) {
      const settled = { ...pending, state }
      expect(newerStop(settled, pending)?.state).toBe(state)
      expect(newerStop(pending, settled)?.state).toBe(state)
    }
  })
  it('two stops: the later ask wins', () => {
    const later = { id: 's2', state: 'pending', requestedAt: '2026-11-03T09:00:00.000Z' }
    expect(newerStop({ ...pending, state: 'failed' }, later)?.id).toBe('s2')
  })
})
