/**
 * A claim of a clock routine's run (clock-routine-v1): a run the host no longer
 * holds was given back with its clock, so the server's own timer runs that slot,
 * or it was acked already. Either way the server must not deliver it from the
 * fire event too, so `unknown` reads as wait for a clock run, and as server (an
 * old fire nobody holds) for a check trigger's.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { claimSeqs } from '../../../src/core/routines/trigger-events.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../../src/core/routines/trigger-daemon.js'

function daemonAnswering(reply: Record<string, unknown>): TriggerDaemon {
  return {
    host: 'devbox',
    capabilitiesKnown: true,
    hasCapability: () => true,
    send: vi.fn().mockResolvedValue({ ok: true, ...reply }),
  }
}

afterEach(() => setTriggerDaemonLookupForTest(null))

describe('claiming a clock run', () => {
  const reply = { claimed: [1], unknown: [2, 3], busy: [4], host: [] }

  it('a run the host no longer holds is never delivered by the server', async () => {
    setTriggerDaemonLookupForTest(() => daemonAnswering(reply))
    const v = await claimSeqs('devbox', 'job-1', 'e1', [1, 2, 3, 4], { clock: true })
    expect(v.get(1)).toEqual({ kind: 'server' })
    expect(v.get(2)).toMatchObject({ kind: 'wait' })
    expect(v.get(3)).toMatchObject({ kind: 'wait' })
    expect(v.get(4)).toMatchObject({ kind: 'wait' })
  })

  it('a check trigger’s fire the host does not know is the server’s, as before', async () => {
    setTriggerDaemonLookupForTest(() => daemonAnswering(reply))
    const v = await claimSeqs('devbox', 'job-1', 'e1', [1, 2, 3, 4])
    expect(v.get(2)).toEqual({ kind: 'server' })
    expect(v.get(3)).toEqual({ kind: 'server' })
  })
})
