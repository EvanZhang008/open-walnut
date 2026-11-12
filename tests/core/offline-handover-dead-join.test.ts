/**
 * A handover of a host runs once at a time, and a call while one runs joins it, but not one
 * riding a connection that is gone: its commands fail "not connected", and the new
 * connection that joined it failed with them (2026-11-12: a flaky test; a reconnect in
 * production does the same and waits 30 s for its next try).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-dead-join'))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../src/core/offline-handover.js'
import { closeDb } from '../../src/core/task-db.js'

function conn(alive: { up: boolean }, gate?: Promise<void>) {
  const sent: string[] = []
  return {
    sent,
    c: {
      hostKey: 'laptop', journalV2: true, alive: () => alive.up,
      send: async (cmd: string) => {
        sent.push(cmd)
        if (gate) await gate
        if (!alive.up) throw new Error('DaemonConnection not connected to laptop')
        if (cmd === 'offline.drain') return { ok: true, records: [], now: Date.now() }
        return { ok: true }
      },
    },
  }
}

beforeEach(() => { _resetOfflineHandoverForTesting(); _setHandoverBackoffForTesting([]) })
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('joining a running handover', () => {
  it('a call for a live connection joins the one that runs on a live connection', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const up = { up: true }
    const first = conn(up, gate)
    const second = conn(up)
    const a = runOfflineHandover(first.c)
    const b = runOfflineHandover(second.c)
    open()
    await Promise.all([a, b])
    expect(second.sent).toEqual([])
  })

  it('a new connection does not join a handover whose connection is gone: it runs its own after it', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const old = conn({ up: true }, gate)
    const fresh = conn({ up: true })
    const a = runOfflineHandover(old.c)
    ;(old.c as { alive: () => boolean }).alive = () => false
    const b = runOfflineHandover(fresh.c)
    open()
    await a.catch(() => undefined)
    await expect(b).resolves.toBeDefined()
    expect(fresh.sent).toContain('offline.drain')
  })
})
