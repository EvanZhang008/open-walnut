/**
 * The minute sweep over every host (host-down-gauge.ts reportHostDownGauges) is what asks Walnut
 * Health about a host's update wait (daemon-update-wait-health.ts): a long wait is raised once
 * over many sweeps, and recovers at the first sweep after the update landed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { raised, recovered, conn } = vi.hoisted(() => ({
  raised: [] as Array<Record<string, unknown>>,
  recovered: [] as string[][],
  conn: { wait: null as Record<string, unknown> | null, connected: true },
}))
vi.mock('../../../src/core/notifications/store.js', () => ({
  upsertNotification: async (item: Record<string, unknown>) => { raised.push(item); return { record: item, outcome: 'inserted' } },
  recoverNotifications: async (keys: string[]) => { recovered.push(keys); return { recovered: [] } },
}))
vi.mock('../../../src/core/server-role.js', () => ({ isFollower: () => false }))
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: { devbox: { hostname: 'devbox.example.test', label: 'Dev box' } } }) }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonConnectState: (host: string) => ({ host, connected: conn.connected, phase: conn.connected ? 'connected' : 'reconnecting', phaseElapsedMs: 0, connectElapsedMs: 0, ...(conn.wait ? { daemonUpdateWait: conn.wait } : {}) }),
}))

import { reportHostDownGauges } from '../../../src/core/hosts/host-down-gauge.js'
import { _resetDaemonUpdateWaitHealthForTesting, daemonUpdateWaitKey } from '../../../src/core/hosts/daemon-update-wait-health.js'
import { LONG_POSTPONE_MS } from '../../../src/providers/daemon-update-wait.js'

const settle = () => new Promise((r) => setTimeout(r, 300))

beforeEach(() => {
  raised.length = 0
  recovered.length = 0
  conn.wait = null
  conn.connected = true
  _resetDaemonUpdateWaitHealthForTesting()
})

describe('the host sweep and an update that waits', () => {
  it('raises a long wait once over many sweeps, and recovers it once the update landed', async () => {
    conn.wait = { kind: 'postponed', why: 'waiting: service.handover: active ACP workers or relay requests must finish first', since: Date.now() - LONG_POSTPONE_MS - 60_000, expected: 'build-new' }
    for (let i = 0; i < 3; i++) await reportHostDownGauges()
    await vi.waitFor(() => expect(raised).toHaveLength(1), { timeout: 10_000 })
    await settle()
    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({ host: 'devbox', title: 'The daemon on Dev box still waits for its update' })
    // The link drops a while (its connect state has no wait then): the item stays as it is.
    const waiting = conn.wait
    conn.wait = null
    conn.connected = false
    await reportHostDownGauges()
    await settle()
    expect(recovered).toEqual([])
    conn.connected = true
    conn.wait = waiting
    await reportHostDownGauges()
    await settle()
    expect(raised).toHaveLength(1)
    conn.wait = null
    await reportHostDownGauges()
    await reportHostDownGauges()
    await vi.waitFor(() => expect(recovered).toEqual([[daemonUpdateWaitKey('devbox')]]), { timeout: 10_000 })
    await settle()
    expect(recovered).toHaveLength(1)
  })
})
