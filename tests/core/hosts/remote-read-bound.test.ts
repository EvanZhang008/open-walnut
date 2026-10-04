/**
 * Request-path reads against a remote host answer within a deadline
 * (core/hosts/remote-read-bound.ts): a host that is still connecting never
 * pins a request for the length of its dial.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-read-bound'))

import {
  HOST_READ_DIAL_CAP_MS, HOST_RECONNECTING, HostReconnectingError, boundHostRead,
} from '../../../src/core/hosts/remote-read-bound.js'
import { SessionControlError } from '../../../src/core/sessions/session-controls.js'
import { daemonConnectWouldWait } from '../../../src/providers/daemon-connection.js'

const label = async (h: string) => (h === '__cloudbox__' ? 'Cloud' : h)
const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms))

describe('boundHostRead', () => {
  it('a local session reads as is, however long it takes', async () => {
    for (const host of [undefined, null, '', '__local__']) {
      let asked = false
      const v = await boundHostRead(host, () => later(60, 'local'), { wouldWait: () => { asked = true; return 'dialing' }, capMs: 10 })
      expect(v).toBe('local')
      expect(asked).toBe(false)
    }
  })

  it('a connected host is not capped', async () => {
    expect(await boundHostRead('__cloudbox__', () => later(80, 'read'), { wouldWait: () => 'connected', capMs: 10, label })).toBe('read')
  })

  it('a failure the pool already knows is the read\'s own answer', async () => {
    await expect(boundHostRead('devbox', () => Promise.reject(new Error('Connection to devbox failed 3s ago: timeout')), { wouldWait: () => 'fails-fast', capMs: 10, label }))
      .rejects.toThrow(/failed 3s ago/)
  })

  it('a dial already running: answers at once, without starting the read', async () => {
    let started = false
    const t0 = Date.now()
    const err = await boundHostRead('__cloudbox__', async () => { started = true; return 'x' }, { wouldWait: () => 'dialing', capMs: 5_000, label }).catch((e) => e)
    expect(Date.now() - t0).toBeLessThan(200)
    expect(started).toBe(false)
    expect(err).toBeInstanceOf(HostReconnectingError)
    expect(err).toBeInstanceOf(SessionControlError)
    expect(err).toMatchObject({ message: 'Reconnecting to Cloud', statusCode: 503, extra: { code: HOST_RECONNECTING, host: '__cloudbox__' } })
  })

  it('a cold host: the request starts the dial and waits at most the cap; the dial goes on', async () => {
    let settled = false
    let rejectLate!: (e: Error) => void
    const read = () => new Promise<string>((_resolve, reject) => { rejectLate = (e) => { settled = true; reject(e) } })
    const t0 = Date.now()
    const err = await boundHostRead('devbox', read, { wouldWait: () => 'cold', capMs: 150, label }).catch((e) => e)
    const took = Date.now() - t0
    expect(err).toBeInstanceOf(HostReconnectingError)
    expect(err.message).toBe('Reconnecting to devbox')
    expect(took).toBeGreaterThanOrEqual(140)
    expect(took).toBeLessThan(1_000)
    // The dial ending later (as a failure) is swallowed, not an unhandled rejection.
    rejectLate(new Error('upgrade timed out'))
    await later(20, null)
    expect(settled).toBe(true)
  })

  it('a cold host that answers inside the cap is an ordinary read', async () => {
    expect(await boundHostRead('devbox', () => later(20, 'fast'), { wouldWait: () => 'cold', capMs: 500, label })).toBe('fast')
  })

  it('the cap a request waits is short (5s)', () => {
    expect(HOST_READ_DIAL_CAP_MS).toBe(5_000)
  })

  it('reads the real pool: a host nothing ever dialled is cold', () => {
    expect(daemonConnectWouldWait('never-dialled-host')).toBe('cold')
  })
})
