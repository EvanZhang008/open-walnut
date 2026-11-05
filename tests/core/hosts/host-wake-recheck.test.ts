/**
 * startHostWakeRedial (src/core/hosts/host-connect-action.ts) wires the link recheck into the wake
 * and network signals: after a wake, a link that died out of sight is asked at once whether it
 * answers (2026-11-05 review: the first wiring, on the event-loop monitor, almost never fired on
 * the Mac, whose monotonic clock runs through sleep).
 *
 * MACHINE SAFETY: the signal and the links are stand-ins; no timer, socket or process.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-wake-recheck'))

const seen = vi.hoisted(() => ({ deps: null as null | { recheck?: (k: string) => void }, asked: [] as unknown[] }))
vi.mock('../../../src/core/hosts/host-wake-signal.js', () => ({
  startHostWakeSignal: (deps: { recheck?: (k: string) => void }) => { seen.deps = deps; return { stop: () => {} } },
}))
vi.mock('../../../src/core/hosts/host-credential-signal.js', () => ({
  startHostCredentialSignal: () => ({ stop: () => {} }),
  newestLoginFileMtime: async () => null,
}))
vi.mock('../../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/daemon-connection.js')>()),
  recheckQuietLinks: async (o: unknown) => { seen.asked.push(o); return {} },
}))

import { startHostWakeRedial } from '../../../src/core/hosts/host-connect-action.js'

describe('the wake redial', () => {
  it('asks every link still up on every signal, however lately heard, with a short deadline, the signal counted once', async () => {
    // Review 4: a link heard within 5 s was skipped, though what it said may have crossed before the
    // path died (bytes in flight at the sleep are read on waking).
    const stop = await startHostWakeRedial(() => ({}))
    expect(typeof seen.deps?.recheck).toBe('function')
    seen.deps!.recheck!('wake')
    await vi.waitFor(() => expect(seen.asked).toHaveLength(1))
    // host-wake-signal.ts counted it already (noteHostSignal): the recheck must not count it again.
    expect(seen.asked[0]).toEqual({ quietMs: 0, deadlineMs: 3_000, signalNoted: true })
    stop()
  })
})
