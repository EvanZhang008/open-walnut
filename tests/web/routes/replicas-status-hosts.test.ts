/**
 * GET /api/replicas/status, the section 13 fields (WP14,
 * docs/plan/walnut-replica-servers-impl.md): each kind's copy age (`ageMs`), and
 * per host that runs a server: the program running, any fallback, and the
 * host's journal as the replica last reported it (size, drainable and parked
 * counts, the oldest record). The real router and the real status modules; the
 * host-server manager's views are the one stand-in (its own tests drive it).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../../helpers/mock-constants.js'
import type { HostServerView } from '../../../src/core/host-server/manager.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-replicas-status-hosts', { CLOUD_MODE: false }))

const NOW = Date.UTC(2026, 9, 17, 8, 0, 0)
const views: HostServerView[] = [
  {
    hostKey: 'devbox', enabled: true, phase: 'running', since: NOW - 60_000, program: 'replica',
    daemon: { state: 'running', since: NOW - 60_000, restarts: 1, program: 'primary', reportAgeMs: 4_000 },
    server: { route: { kind: 'leader' }, journal: { records: 5, drainable: 3, bytes: 2048, blobBytes: 0, oldestAt: NOW - 90_000, lastDrainAt: null, lastAckSeq: 4 } },
  },
  {
    hostKey: 'buildbox', enabled: true, phase: 'running', since: NOW, program: 'fallback',
    daemon: { state: 'running', since: NOW, restarts: 3, program: 'fallback', fallback: { since: NOW - 1_000, until: NOW + 3_599_000, lastError: 'exited with code 1' } },
    server: { route: { kind: 'leader' } },
  },
  { hostKey: 'offbox', enabled: false, phase: 'off', since: 0 },
]
vi.mock('../../../src/core/host-server/index.js', () => ({ peekHostServerViews: () => views }))

import { replicasStatusRouter } from '../../../src/web/routes/replicas-status.js'
import { kindState, kindStatusOf, _resetReplicaStatusForTesting } from '../../../src/core/replication/replica-status.js'
import { hostJournalOf, hostReplicaStatuses } from '../../../src/core/replication/host-replica-status.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'

let server: Server | null = null
let port = 0

beforeAll(async () => {
  _resetServerRoleForTesting()
  _resetReplicaStatusForTesting()
  const { default: express } = await import('express')
  const app = express()
  app.use('/api', replicasStatusRouter)
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  _resetReplicaStatusForTesting()
})

describe('the section 13 status fields', () => {
  it('each kind says how old its copy is', () => {
    const st = kindState({ id: 'host:devbox', kind: 'host', label: 'devbox' }, 'tasks')
    expect(kindStatusOf(st, NOW).ageMs).toBeUndefined()
    st.syncedAt = NOW - 12_000
    expect(kindStatusOf(st, NOW).ageMs).toBe(12_000)
    // A host clock ahead of the Mac's never shows a negative age.
    st.syncedAt = NOW + 5_000
    expect(kindStatusOf(st, NOW).ageMs).toBe(0)
  })

  it('a host row: the program, the fallback, the journal with its parked count and oldest record', () => {
    const rows = hostReplicaStatuses(views, NOW)
    expect(rows.map((r) => r.hostKey)).toEqual(['devbox', 'buildbox'])
    expect(rows[0]).toMatchObject({
      program: 'replica', running: true, daemonState: 'running', restarts: 1, fallback: null, reportAgeMs: 4_000,
      journal: { records: 5, drainable: 3, parked: 2, bytes: 2048, oldestAt: NOW - 90_000, oldestAgeMs: 90_000, lastDrainAt: null },
    })
    expect(rows[1]).toMatchObject({ program: 'fallback', fallback: { lastError: 'exited with code 1' }, journal: null })
    expect(hostJournalOf({ records: 'x' }, NOW)).toBeNull()
    expect(hostJournalOf(null, NOW)).toBeNull()
  })

  it('GET /api/replicas/status carries the host rows beside the targets', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/replicas/status`)
    const body = await r.json() as { ok: boolean; targets: Array<{ id: string; kinds: Array<{ kind: string; ageMs?: number }> }>; hosts: Array<Record<string, unknown>> }
    expect(r.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.hosts.map((h) => h.hostKey)).toEqual(['devbox', 'buildbox'])
    expect(body.hosts[0]!.journal).toMatchObject({ records: 5, drainable: 3, parked: 2 })
    const tasks = body.targets.find((t) => t.id === 'host:devbox')!.kinds.find((k) => k.kind === 'tasks')!
    expect(typeof tasks.ageMs).toBe('number')
  })
})
