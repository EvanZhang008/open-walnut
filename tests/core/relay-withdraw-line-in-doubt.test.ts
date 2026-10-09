/**
 * A phone message whose line may already be in a CLI is never given back to
 * the companion (relay-fates.ts withdrawIn). Its row went back to pending with
 * the line's uuid kept (an unanswered send: revertIfQueued; a server restart
 * mid-delivery: loadQueue), so only this Mac, resending under that uuid, may
 * deliver it. Handed to the companion, it would go by the host's direct path
 * under another uuid and could run twice. A row whose delivery failed for sure
 * (revertToPending) is still given back, as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-relay-line-in-doubt'))

import {
  enqueueMessage, getQueue, loadQueue, markProcessing, parkIfQueued, resetCache, revertIfQueued, revertToPending,
  withdrawRelayedMessage,
} from '../../src/core/session-message-queue.js'
import { sessionStops } from '../../src/core/sessions/session-stop.js'
import { WALNUT_HOME } from '../../src/constants.js'

const SID = 'relay-doubt-session'
const ID = 'qm-mobile-doubt-1'

beforeEach(async () => {
  vi.spyOn(sessionStops, 'fence').mockResolvedValue(null)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
})

afterEach(async () => {
  vi.restoreAllMocks()
  resetCache()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

async function relayedAndSent() {
  await enqueueMessage(SID, 'from the phone', { id: ID, relayTaken: true })
  const batch = await markProcessing(SID)
  expect(batch.map((m) => m.id)).toEqual([ID])
  return batch
}

describe('withdrawing a relayed message whose line may be in a CLI', () => {
  it('after an unanswered send: "delivering", and the row stays here', async () => {
    const batch = await relayedAndSent()
    await revertIfQueued(batch)
    expect(await withdrawRelayedMessage(SID, ID)).toBe('delivering')
    expect((await getQueue(SID)).map((m) => [m.id, m.status, m.lineInDoubt])).toEqual([[ID, 'pending', true]])
  })

  it('after a server restart mid-delivery: "delivering"', async () => {
    await relayedAndSent()
    resetCache()
    await loadQueue()
    expect(await withdrawRelayedMessage(SID, ID)).toBe('delivering')
  })

  it('after a delivery that failed for sure: given back, as before', async () => {
    const batch = await relayedAndSent()
    await revertToPending(batch)
    expect(await withdrawRelayedMessage(SID, ID)).toBe('withdrawn')
    expect(await getQueue(SID)).toEqual([])
  })

  it('a line the CLI dropped for good is parked as a fresh line: "parked", the doubt gone with the uuid', async () => {
    const batch = await relayedAndSent()
    await revertIfQueued(batch)
    await parkIfQueued(batch, 'dropped', { freshLine: true })
    expect(await withdrawRelayedMessage(SID, ID)).toBe('parked')
    const [row] = await getQueue(SID)
    expect(row.lineUuid).toBeUndefined()
    expect(row.lineInDoubt).toBeUndefined()
  })
})
