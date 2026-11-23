/**
 * A host connection whose home-move declaration is held (a leader switch's commit not confirmed
 * in time, home-move.ts HomeMoveHeld) fails that attempt: the transport closes, the reconnect
 * backoff takes over, and a command waiting on the declaration fails too, so no frame from the
 * new data dir reaches the host before the move is declared (daemon-connection.ts
 * declareHomeMoveFirst). Any other failure of the declaration lets commands go on, as before.
 */
import { describe, expect, it, vi } from 'vitest'

const declare = vi.hoisted(() => ({ fn: (async () => {}) as () => Promise<void> }))
vi.mock('../../src/core/leader/primary-leader.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  declareHomeMove: () => declare.fn(),
}))
vi.mock('../../src/core/home-move.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // A leader switch may be due: the connect holds its commands for the declaration.
  settledHomeMove: () => undefined,
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { HomeMoveHeld, isHomeMoveHeld } from '../../src/core/home-move.js'
import { priv, state, TARGET } from '../helpers/daemon-connection-update-stubs.js'

function conn() {
  const c = new DaemonConnection('devbox', TARGET)
  state(c)._capabilities = ['leader-epoch-v1']
  const calls = { closed: 0, failed: [] as unknown[] }
  priv(c).closeTransport = () => { calls.closed++ }
  priv(c).failReconnect = async (err: unknown) => { calls.failed.push(err); return err }
  return { c, calls }
}

describe('a held home-move declaration fails the connection attempt', () => {
  it('HomeMoveHeld: the transport closes, the backoff retries, a waiting command fails with no frame', async () => {
    declare.fn = async () => { throw new HomeMoveHeld('s1', 124_000) }
    const { c, calls } = conn()
    const gate = priv(c).declareHomeMoveFirst() as Promise<void>
    state(c).homeMoveGate = gate
    const sent = await c.send('host.slice', { slice: {} }).catch((e: unknown) => e)
    expect(isHomeMoveHeld(sent), 'the command fails with the gate').toBe(true)
    expect(isHomeMoveHeld(await gate.catch((e: unknown) => e))).toBe(true)
    expect(calls.closed).toBe(1)
    expect(calls.failed.map(isHomeMoveHeld)).toEqual([true])
  })

  it('any other failure of the declaration: commands go on, the connection stays', async () => {
    declare.fn = async () => { throw new Error('host answered nothing') }
    const { c, calls } = conn()
    const gate = priv(c).declareHomeMoveFirst() as Promise<void>
    await expect(gate).resolves.toBeUndefined()
    expect(calls.closed).toBe(0)
    expect(calls.failed).toEqual([])
  })
})
