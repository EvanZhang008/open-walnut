/**
 * The leader reads a host-judged session's turn from its host (src/core/sessions/turn-run-host.ts):
 * the retriers run on the host, so the leader's own rows know nothing of them. At a turn end the
 * host's stamp (`hostTakenBy`) answers turnEndTakenBy; after it, the host's waits answer turnRunNow
 * and the mid-work readers. A session no host judges reads the leader's rows as before, and a
 * stamped reason this server does not know is not taken.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setHostTurnSource } from '../../../src/core/sessions/turn-run-host.js'
import { __setTurnRetrierForTesting, turnEndAnsweredNothing, turnEndTakenBy, turnMidWorkNow, turnRunNow } from '../../../src/core/sessions/turn-run.js'
import type { SessionRecord } from '../../../src/core/types.js'

const HOST = 'cccccccc-3333-4333-8333-cccccccccccc'
const MINE = 'dddddddd-4444-4444-8444-dddddddddddd'
const rec = (sid: string) => ({ claudeSessionId: sid, process_status: 'idle' } as SessionRecord)

afterEach(async () => {
  setHostTurnSource(null)
  await __setTurnRetrierForTesting('auto_continue', null)
})

describe('a host-judged session\'s turn is its host\'s', () => {
  it('a turn end takes the host\'s stamped answer, whatever this server\'s rows say', async () => {
    await __setTurnRetrierForTesting('auto_continue', { reason: 'auto_continue', sources: [], takes: () => true, wait: () => null })
    expect(await turnEndTakenBy({ event: 'result', sessionId: HOST, isError: true, hostTakenBy: 'safeguard_switch', record: null })).toBe('safeguard_switch')
    expect(await turnEndTakenBy({ event: 'result', sessionId: HOST, isError: true, hostTakenBy: null, record: null })).toBeNull()
    // Unstamped (the leader's own session): its rows answer.
    expect(await turnEndTakenBy({ event: 'result', sessionId: MINE, isError: true, record: null })).toBe('auto_continue')
    // A reason this server does not know: not taken from the stamp.
    expect(await turnEndTakenBy({ event: 'result', sessionId: HOST, isError: true, hostTakenBy: 'from_the_future' as never, record: null })).toBe('auto_continue')
  })

  it('the waits after it are the host\'s, for the status words and the mid-work readers', async () => {
    setHostTurnSource((sid) => sid === HOST ? { waits: [{ reason: 'context_recovery' }, { reason: 'from_the_future' as never }], stops: [] } : null)
    const run = turnRunNow(rec(HOST))
    expect(run.wait).toEqual({ reason: 'context_recovery' })
    expect(run.waits.map((w) => w.reason)).toEqual(['context_recovery'])
    expect(turnMidWorkNow(HOST)).toBe('context_recovery')
    expect(turnRunNow(rec(MINE)).wait).toBeNull()
  })

  it('a host that says nothing holds its turn end only by its stamp', async () => {
    setHostTurnSource((sid) => sid === HOST ? { waits: [], stops: [] } : null)
    expect(await turnEndAnsweredNothing(HOST, { event: 'result', isError: true, hostTakenBy: 'safeguard_switch' })).toBe('safeguard_switch')
    expect(await turnEndAnsweredNothing(HOST, { event: 'result', isError: true, hostTakenBy: 'auto_continue' })).toBeNull()
  })
})
