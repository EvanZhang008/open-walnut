/**
 * When the companion's held phone sends drain, and in what order (round 3 of
 * the 2026-10-01 hop fix). Each case is a matrix cell round 2 still failed:
 *
 *  - ORDER (L5, D2, S5, W3): a held row never goes while a send of its session
 *    accepted before it is still being handed over, and rows sort by when the
 *    send reached the companion, not by when it was banked.
 *  - DRAINS (H5, H6, D1, B7): one host's stuck relay held back every other
 *    host's rows for its 45 s; a return the companion cannot see (the Mac
 *    reaching a host's daemon again) waited for the 60 s sweep; a pass that
 *    left rows waiting on a hop back within seconds waited 60 s too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-send-drain-r3', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
  addPrimaryBridgeConnectedHandler: () => () => {},
  addBridgeConnectedHandler: () => () => {},
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { enqueueSessionSend, flushSendQueue, listBankedSends, startSendQueueFlush } from '../../src/core/send-queue.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const relayed = (): string[] =>
  bridgeRequestMock.mock.calls.filter((c) => c[1] === 'session.message').map((c) => String(c[2].message))
async function until(ms: number, cond: () => boolean | Promise<boolean>): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await cond()) return true; await sleep(20) }
  return cond()
}
/** The relay answered; the row leaves the bank once its outcome is on disk (a durable write). */
const bankEmpties = (ms: number) => until(ms, async () => (await listBankedSends()).length === 0)
let hanging = true
const hang = async () => { while (hanging) await sleep(20) }

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  hanging = true
})

afterEach(async () => {
  hanging = false
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
  await flushSendQueue()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('order', () => {
  it('rows sort by when the send reached the companion, not by when it was banked', async () => {
    const now = Date.now()
    await enqueueSessionSend('s1', 'devbox', 'second', 'qm-mobile-srt000000002', null, { acceptedAt: now })
    // Held at its answer deadline, seconds after the later one was held behind it.
    await enqueueSessionSend('s1', 'devbox', 'first', 'qm-mobile-srt000000001', null, { acceptedAt: now - 8_000 })
    expect((await listBankedSends()).map((op) => op.message)).toEqual(['first', 'second'])
  })

  it('a held row waits while a send of its session accepted before it is still being handed over', async () => {
    const { enterSessionOrder } = await import('../../src/core/send-order.js')
    bridgeRequestMock.mockResolvedValue({ ok: true })
    const earlier = enterSessionOrder('s1', 'qm-mobile-inf000000001', Date.now() - 1_000)
    await enqueueSessionSend('s1', 'devbox', 'later', 'qm-mobile-inf000000002', null, { acceptedAt: Date.now(), provablyUnsent: true })
    // Another session's row is not held by it.
    await enqueueSessionSend('s2', 'devbox', 'other session', 'qm-mobile-inf000000003', null, { acceptedAt: Date.now(), provablyUnsent: true })
    await flushSendQueue()
    expect(relayed()).toEqual(['other session'])
    earlier.leave()
    await flushSendQueue()
    expect(relayed()).toEqual(['other session', 'later'])
  })
})

describe('drains', () => {
  it('a host whose relay is stuck does not hold back another host\'s rows', async () => {
    await enqueueSessionSend('s1', 'devbox', 'stuck host', 'qm-mobile-hst000000001', null, { acceptedAt: Date.now() - 5_000, provablyUnsent: true })
    await enqueueSessionSend('s2', 'buildbox', 'healthy host', 'qm-mobile-hst000000002', null, { acceptedAt: Date.now(), provablyUnsent: true })
    bridgeRequestMock.mockImplementation(async (host: string, cmd: string) => {
      if (cmd !== 'session.message') throw new Error('unexpected command: ' + cmd)
      if (host === 'devbox') { await hang(); return { ok: false, error: 'session.message: primary server timed out' } }
      return { ok: true }
    })
    const flushing = flushSendQueue()
    expect(await until(1_000, () => relayed().includes('healthy host')), 'the healthy host went at once').toBe(true)
    hanging = false
    await flushing
  })

  it('the Mac announcing that it reached a host again drains that host\'s rows at once', async () => {
    await enqueueSessionSend('s1', 'devbox', 'waited for the Mac', 'qm-mobile-ann000000001', null, { acceptedAt: Date.now(), provablyUnsent: true })
    bridgeRequestMock.mockResolvedValue({ ok: true })
    const { handleBridgeMobileEvent } = await import('../../src/web/routes/events-v1.js')
    handleBridgeMobileEvent('send-path-ready', { host: 'devbox' })
    expect(await until(1_000, () => relayed().length === 1)).toBe(true)
    expect(await bankEmpties(1_000)).toBe(true)
  })

  it('an announcement for a host with nothing held sends nothing', async () => {
    await enqueueSessionSend('s1', 'devbox', 'for devbox', 'qm-mobile-ann000000002', null, { acceptedAt: Date.now(), provablyUnsent: true })
    bridgeRequestMock.mockResolvedValue({ ok: true })
    const { handleBridgeMobileEvent } = await import('../../src/web/routes/events-v1.js')
    handleBridgeMobileEvent('send-path-ready', { host: 'buildbox' })
    await sleep(300)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('a pass that left a row waiting on a hop back within seconds drains again soon, not in 60 s', async () => {
    const triggers = startSendQueueFlush()
    try {
      await enqueueSessionSend('s1', 'devbox', 'the Mac is waking', 'qm-mobile-son000000001', null, { acceptedAt: Date.now(), provablyUnsent: true })
      bridgeRequestMock
        .mockResolvedValueOnce({ ok: false, error: 'session.message: primary server timed out' })
        .mockResolvedValue({ ok: true })
      await flushSendQueue()
      expect(relayed()).toHaveLength(1)
      expect(await until(3_500, () => relayed().length === 2), 'drained again on the short ladder').toBe(true)
      expect(await bankEmpties(1_000)).toBe(true)
    } finally {
      triggers.stop()
    }
  })
})
