/**
 * recheckSession — "at least when I open it, it should go check whether it's
 * connected" (user report 2026-09-03: a remote session's record sat in
 * process_status 'error' with a stale "Connection lost — unable to reach remote
 * host" for over two hours AFTER the tunnel reconnected, while the same host's
 * files opened fine in the Files tab).
 *
 * Contract pinned here:
 *   - no message is sent, nothing is spawned, no --resume;
 *   - it uses ONLY an already-pooled daemon connection (never dials);
 *   - the record converges through applySnapshot (the C2 projection), never a
 *     hand-patched process_status — a legacy category-① write is what the gate
 *     drops whole, which is how the freeze happened;
 *   - it degrades to a clear "couldn't check" answer (no pooled connection,
 *     RPC timeout, positively-terminal cause).
 *
 * Real session-tracker + real snapshot projection over an isolated tmp
 * WALNUT_HOME. Only the daemon transport and the live-runner registry are faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-recheck'))

// Daemon transport: partial mock so only the two pool lookups are ours. The
// steering state is hoisted because vitest lifts the factory above the imports.
const daemon = vi.hoisted(() => {
  const calls: Array<[string, Record<string, unknown> | undefined, number | undefined]> = []
  return {
    calls,
    connected: false,
    pooled: false,
    /** What `send` does: resolve a value, reject, or never settle. */
    behavior: 'ok-empty' as 'ok-empty' | 'reply' | 'reject' | 'hang',
    reply: {} as Record<string, unknown>,
    send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
      calls.push([cmd, params, timeoutMs])
      if (daemon.behavior === 'hang') return new Promise(() => { /* never settles */ })
      if (daemon.behavior === 'reject') return Promise.reject(new Error('DaemonConnection not connected'))
      if (daemon.behavior === 'reply') return Promise.resolve(daemon.reply)
      return Promise.resolve({ ok: false })
    },
  }
})
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/daemon-connection.js')>()
  return {
    ...actual,
    isDaemonConnected: () => daemon.connected,
    getPooledSnapshotConnection: () => (daemon.pooled ? { send: daemon.send } : null) as never,
  }
})

// applySnapshot syncs a live runner's in-memory status when one exists.
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { findSessionByClaudeId: () => undefined },
}))

import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import {
  createSessionRecord,
  getSessionByClaudeId,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { getQueue } from '../../src/core/session-message-queue.js'
import {
  setSnapshotModeForTests,
  _resetSnapshotGateForTests,
  _resetSnapshotApplyForTests,
} from '../../src/core/session-snapshot-apply.js'
import { recheckSession } from '../../src/core/sessions/session-lifecycle.js'
import { SessionControlError } from '../../src/core/sessions/session-controls.js'

function snap(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    v: 5_000,
    cliState: 'idle',
    turnActive: false,
    pendingPermission: null,
    gatingBgCount: 0,
    teamActive: false,
    cronActive: false,
    lastResult: null,
    pid: null,
    exitCode: null,
    ...overrides,
  }
}

/** The frozen shape from the incident: a remote session stuck in 'error' with an
 *  unreachability claim written by the health monitor. */
async function seedFrozenRemoteSession(sid: string): Promise<void> {
  await createSessionRecord(sid, 'task-rechk', 'proj', '/tmp/rechk', {
    host: 'devhost', initialProcessStatus: 'error',
  })
  await updateSessionRecord(sid, {
    errorMessage: 'Connection lost — unable to reach remote host',
    status_reason: 'remote_unreachable',
    status_changed_by: 'health-monitor',
  } as never)
}

function captureLaunchEvents(): { events: BusEvent[]; stop: () => void } {
  const events: BusEvent[] = []
  bus.subscribe('session-runner', (event) => {
    if (event.name === EventNames.SESSION_SEND || event.name === EventNames.SESSION_START) {
      events.push(event)
    }
  })
  return { events, stop: () => bus.unsubscribe('session-runner') }
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  setSnapshotModeForTests('enforce')
  bus.clear()
  daemon.calls.length = 0
  daemon.connected = false
  daemon.pooled = false
  daemon.behavior = 'ok-empty'
  daemon.reply = {}
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  setSnapshotModeForTests(null)
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('recheckSession — authoritative pull', () => {
  it('converges the frozen error record through applySnapshot and sends nothing', async () => {
    const sid = 'rechk-converge'
    await seedFrozenRemoteSession(sid)
    daemon.connected = true
    daemon.pooled = true
    daemon.behavior = 'reply'
    daemon.reply = { ok: true, snapshot: snap({ cliState: 'idle', v: 9_000 }) }

    const cap = captureLaunchEvents()
    let res: Awaited<ReturnType<typeof recheckSession>>
    try {
      res = await recheckSession(sid)
      expect(cap.events).toHaveLength(0)          // nothing spawned, nothing sent
    } finally {
      cap.stop()
    }

    expect(res).toMatchObject({
      sessionId: sid, checked: true, reachable: true, alive: true, processStatus: 'idle',
    })
    expect(await getQueue(sid)).toHaveLength(0)
    expect(daemon.calls).toHaveLength(1)
    expect(daemon.calls[0]?.[0]).toBe('getState')
    expect(daemon.calls[0]?.[1]).toMatchObject({ sid })

    const rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status).toBe('idle')
    // The C2 projection is the writer — proof this is not a hand-patch.
    expect(rec?.status_changed_by).toBe('snapshot')
    expect(rec?.status_reason).toBe('snapshot_projection')
    expect(rec?.errorMessage ?? null).toBeNull()
  })

  it('reports a genuinely dead CLI as alive:false and converges to stopped', async () => {
    const sid = 'rechk-dead'
    await seedFrozenRemoteSession(sid)
    daemon.connected = true
    daemon.pooled = true
    daemon.behavior = 'reply'
    daemon.reply = {
      ok: true,
      snapshot: snap({
        cliState: 'dead', v: 9_100, exitCode: 0,
        lastResult: { isError: false, endOffset: 9_000 },
      }),
    }

    const res = await recheckSession(sid)
    expect(res).toMatchObject({ checked: true, reachable: true, alive: false, processStatus: 'stopped' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('stopped')
  })

  it('passes the RPC deadline to the daemon command', async () => {
    const sid = 'rechk-deadline'
    await seedFrozenRemoteSession(sid)
    daemon.connected = true
    daemon.pooled = true
    daemon.behavior = 'reply'
    daemon.reply = { ok: true, snapshot: snap() }

    await recheckSession(sid)
    expect(daemon.calls[0]?.[2]).toBe(5_000)
  })
})

describe('recheckSession — degraded answers', () => {
  it('no pooled connection → checked:false, record untouched, nothing dialed', async () => {
    const sid = 'rechk-nopool'
    await seedFrozenRemoteSession(sid)
    daemon.connected = false
    daemon.pooled = false

    const res = await recheckSession(sid)
    expect(res).toMatchObject({
      sessionId: sid, checked: false, reachable: false,
      reason: 'no_pooled_connection', processStatus: 'error', infraClaim: true,
    })
    expect(daemon.calls).toEqual([])
    const rec = await getSessionByClaudeId(sid)
    expect(rec?.process_status).toBe('error')
    expect(rec?.errorMessage).toContain('Connection lost')
  })

  it('reports reachable:true even when the pooled daemon cannot answer getState', async () => {
    // The banner's honesty case: the tunnel is up (pooled + connected) but that
    // daemon predates snapshot-v1, so there is nothing authoritative to pull.
    const sid = 'rechk-reachable-nosnap'
    await seedFrozenRemoteSession(sid)
    daemon.connected = true
    daemon.pooled = false

    const res = await recheckSession(sid)
    expect(res).toMatchObject({ checked: false, reachable: true, reason: 'no_pooled_connection', infraClaim: true })
  })

  it('a positively TERMINAL cause is never re-examined', async () => {
    const sid = 'rechk-terminal'
    await createSessionRecord(sid, 'task-rechk-t', 'proj', '/tmp/rechk', {
      host: 'devhost', initialProcessStatus: 'error',
    })
    await updateSessionRecord(sid, {
      errorMessage: 'The model refused the request',
      status_reason: 'user_stopped',
      status_changed_by: 'user',
    } as never)
    daemon.connected = true
    daemon.pooled = true

    const res = await recheckSession(sid)
    expect(res).toMatchObject({ checked: false, reason: 'terminal_error', infraClaim: false })
    expect(daemon.calls).toEqual([])
  })

  it('an ok reply with no snapshot degrades instead of throwing', async () => {
    const sid = 'rechk-nosnapshot'
    await seedFrozenRemoteSession(sid)
    daemon.connected = true
    daemon.pooled = true
    daemon.behavior = 'reply'
    daemon.reply = { ok: true }

    const res = await recheckSession(sid)
    expect(res).toMatchObject({ checked: false, reachable: true, reason: 'no_snapshot', processStatus: 'error' })
  })

  it('a rejected RPC degrades instead of throwing', async () => {
    const sid = 'rechk-rpcfail'
    await seedFrozenRemoteSession(sid)
    daemon.connected = true
    daemon.pooled = true
    daemon.behavior = 'reject'

    const res = await recheckSession(sid)
    expect(res).toMatchObject({ checked: false, reason: 'rpc_failed', processStatus: 'error' })
  })

  it('a hung RPC times out at the deadline instead of pinning the response', async () => {
    const sid = 'rechk-timeout'
    await seedFrozenRemoteSession(sid)
    daemon.connected = true
    daemon.pooled = true
    daemon.behavior = 'hang'

    vi.useFakeTimers()
    const pending = recheckSession(sid)
    await vi.advanceTimersByTimeAsync(5_001)
    const res = await pending
    vi.useRealTimers()

    expect(res).toMatchObject({ checked: false, reason: 'timeout', processStatus: 'error' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('error')
  })

  it('unknown session → 404 SessionControlError', async () => {
    await expect(recheckSession('no-such-session')).rejects.toBeInstanceOf(SessionControlError)
  })
})
