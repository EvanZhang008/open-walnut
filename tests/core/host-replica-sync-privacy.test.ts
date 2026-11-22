/**
 * A host's notes and memory copy (host-replica.ts) drops a newly kept task's folder and the memory
 * files naming it a few seconds after the hold changes (host-private.ts onHostPrivacyChange), not
 * at the 5-minute sweep: making a task local fires no notes or memory event of its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const pushed = vi.hoisted(() => ({ hosts: 0, companion: 0 }))
vi.mock('../../src/providers/daemon-connection.js', () => ({ pushHostReplicaToAllHosts: () => { pushed.hosts++ } }))
vi.mock('../../src/core/host-replica.js', () => ({ syncCompanionHostReplica: async () => { pushed.companion++ } }))
vi.mock('../../src/core/server-role.js', () => ({ isFollower: () => false }))

import { startHostReplicaSync } from '../../src/core/host-replica-sync.js'

describe('the host copies of notes and memory follow a privacy change', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pushed.hosts = 0
    pushed.companion = 0
  })
  afterEach(() => { vi.useRealTimers() })

  it('a kept-set change pushes within the debounce, once per burst; stop unsubscribes', async () => {
    let fire: (() => void) | null = null
    let unsubscribed = false
    const sync = startHostReplicaSync({ onPrivacyChange: (fn) => { fire = fn; return () => { unsubscribed = true } } })
    expect(fire).not.toBeNull()
    fire!()
    fire!()
    await vi.advanceTimersByTimeAsync(3_100)
    expect(pushed.hosts).toBe(1)
    sync.stop()
    expect(unsubscribed).toBe(true)
  })
})
