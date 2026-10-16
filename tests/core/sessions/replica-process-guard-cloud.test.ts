/**
 * The replica process guard keys on placement host, not on role replica
 * (src/core/sessions/replica-process-guard.ts): the cloud companion is a
 * replica too, and with cloud exec it starts and stops its own sessions in its
 * own daemon. On placement cloud the guard refuses nothing, and every stop
 * funnel (sessions/owner-stop.ts) still asks the owning daemon. The "daemon"
 * is a fake connection that accepts everything and records what it was sent;
 * no pid here is signalled or probed by anyone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-replica-guard-cloud', { CLOUD_MODE: true }))

import { _resetServerRoleForTesting, isFollower, isHostReplica, placement, role } from '../../../src/core/server-role.js'
import { processActionsRefused, refuseProcessAction } from '../../../src/core/sessions/replica-process-guard.js'
import { ORPHAN_STOP_CAPABILITY, stopAcpThroughOwner, stopThroughOwner, sweepOrphansThroughOwner, type OwnerConnection } from '../../../src/core/sessions/owner-stop.js'
import { OWNER_HOME_CAPABILITY } from '../../../src/core/sessions/stop-provenance.js'
import type { SessionRecord } from '../../../src/core/types.js'

const ENV_KEYS = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString()
/** A pid no process is asked about: only the fake daemon below ever sees it. */
const PID = 424_242

function companionRow(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: 'sid-marina-cloud-1', taskId: 'task-marina-1', project: 'Marina', process_status: 'stopped', mode: 'default',
    startedAt: HOUR_AGO, lastActiveAt: HOUR_AGO, last_status_change: HOUR_AGO, messageCount: 3,
    status_reason: 'idle_timeout', status_changed_by: 'health-monitor', provider: 'cli', pid: PID, ...over,
  } as SessionRecord
}

function acceptingConn(): OwnerConnection & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    connected: true,
    hasCapability: (cap) => cap === ORPHAN_STOP_CAPABILITY || cap === OWNER_HOME_CAPABILITY,
    send: async (command) => { calls.push(command); return { ok: true, stopped: true } },
  }
}

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  // The companion: role replica, placement cloud (WALNUT_CLOUD_MODE=1, from the mocked constants).
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.WALNUT_ROLE = 'replica'
  _resetServerRoleForTesting()
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetServerRoleForTesting()
})

describe('on the companion (role replica, placement cloud) the guard refuses nothing', () => {
  it('is a replica that is not a host replica', () => {
    expect([role(), placement(), isFollower(), isHostReplica()]).toEqual(['replica', 'cloud', true, false])
    expect(refuseProcessAction('owner_stop:test', 'sid-marina-cloud-1')).toBe(false)
    expect(processActionsRefused()).toBe(false)
  })

  it('asks the owning daemon to stop its own session (stopThroughOwner)', async () => {
    const conn = acceptingConn()
    expect(await stopThroughOwner(companionRow(), 'user', 'test', { connection: async () => conn }, 'human')).toBe('stopped')
    expect(conn.calls).toEqual(['stop'])
  })

  it('asks the owning daemon to stop its own ACP worker (stopAcpThroughOwner)', async () => {
    const conn = acceptingConn()
    expect(await stopAcpThroughOwner(companionRow({ acpRuntimeId: 'acp-marina-1' }), 'test', { connection: async () => conn }, { ephemeral: false })).toBe('stopped')
    expect(conn.calls).toEqual(['acpStop'])
  })

  it('sweeps its own orphan through the owning daemon (sweepOrphansThroughOwner)', async () => {
    const conn = acceptingConn()
    const outcomes = await sweepOrphansThroughOwner([companionRow()], 'test', {
      connection: async () => conn,
      reread: async () => companionRow(),
      markExpectedTeardown: async () => undefined,
      now: () => Date.now(),
    })
    expect(outcomes).toEqual([{ sessionId: 'sid-marina-cloud-1', host: '__local__', pid: PID, result: 'ended' }])
    expect(conn.calls).toEqual(['stop'])
  })
})
