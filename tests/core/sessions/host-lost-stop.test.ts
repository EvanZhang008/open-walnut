/**
 * A stop on a host that does not answer a fresh connect (sessions/host-lost.ts): the session
 * is stopped here at once, its stop stays pending (no message reaches it from here), and the
 * host's reconnect ends the process and records that. 2026-11-07: task_stop on a laptop that
 * went offline answered "its host has not confirmed it yet" for a day, and the task was stuck.
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionStopCoordinator, STOP_OFFLINE_MAX_MS, type SessionStopConnection, type SessionStopDeps } from '../../../src/core/sessions/session-stop.js'
import { HOST_LOST_STOP_MAX_MS, isHostLostStopError, type HostReach } from '../../../src/core/sessions/host-lost.js'
import type { SessionRecord } from '../../../src/core/types.js'

type StopRequest = NonNullable<SessionRecord['stopRequest']>
const clone = <T>(v: T): T => structuredClone(v)
const settled = () => new Promise((r) => setTimeout(r, 0))

function record(sid: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: sid, taskId: `task-${sid}`, project: 'Marina', process_status: 'running', mode: 'default',
    startedAt: '2026-11-07T00:00:00.000Z', lastActiveAt: '2026-11-07T00:10:00.000Z', messageCount: 4, pid: 4242, host: 'laptop', ...over,
  } as SessionRecord
}

function harness(records: SessionRecord[], reach: () => HostReach) {
  const store = new Map(records.map((r) => [r.claudeSessionId, clone(r)]))
  const conns = new Map<string, SessionStopConnection | null>()
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const write = (sid: string, updates: Partial<SessionRecord>): SessionRecord => {
    const next = { ...clone(store.get(sid)!), ...clone(updates) } as SessionRecord
    for (const k of Object.keys(updates) as Array<keyof SessionRecord>) if (updates[k] === undefined) delete next[k]
    store.set(sid, clone(next))
    return clone(next)
  }
  const sameStop = (sid: string, request: StopRequest) => {
    const cur = store.get(sid)
    return cur?.stopRequest?.id === request.id && cur.stopRequest.state === 'pending'
  }
  const probe = vi.fn(async () => reach())
  const deps: SessionStopDeps = {
    get: async (sid) => (store.has(sid) ? clone(store.get(sid)!) : null),
    save: async (sid, updates) => write(sid, updates),
    confirm: async (sid, request) => (sameStop(sid, request) ? write(sid, {
      stopRequest: request,
      ...(request.state === 'confirmed' ? { process_status: 'stopped' as const, pid: undefined, status_reason: 'user_terminated' as const, status_changed_by: 'user' as const } : {}),
    }) : null),
    lost: async (sid, request, hostLost) => (sameStop(sid, request) ? write(sid, {
      stopRequest: request, hostLost, process_status: 'stopped', pid: undefined, status_reason: 'user_terminated', status_changed_by: 'user',
    }) : null),
    probe,
    pending: async (host) => [...store.values()].filter((r) => r.stopRequest?.state === 'pending' && (r.host ?? '__local__') === host).map(clone),
    park: async () => {},
    connection: async (host) => conns.get(host) ?? null,
    changed: () => {},
    schedule: (fn, ms) => { const e = { fn, ms, cancelled: false }; scheduled.push(e); return () => { e.cancelled = true } },
  }
  return { deps, store, scheduled, probe, conns, read: (sid: string) => clone(store.get(sid)!), build: () => new SessionStopCoordinator(deps) }
}

const daemon = (reply: Record<string, unknown> = { ok: true, stopped: true }) => {
  const send = vi.fn(async () => reply)
  return { conn: { connected: true, send, hasCapability: () => true } as SessionStopConnection, send }
}

describe('a stop on a host that cannot be reached', () => {
  it('stops the session here, records who and why, keeps the stop pending and fences messages', async () => {
    const h = harness([record('s1')], () => ({ reachable: false, error: 'ssh: connect timed out' }))
    const c = h.build()
    const request = await c.request('s1', 'human')
    expect(request.state).toBe('pending')
    expect(isHostLostStopError(request.error)).toBe(true)
    const rec = h.read('s1')
    expect(rec).toMatchObject({ process_status: 'stopped', status_reason: 'user_terminated', hostLost: { host: 'laptop', why: 'ssh: connect timed out', by: 'human' } })
    expect(rec.pid).toBeUndefined()
    await expect(c.fence('s1')).rejects.toThrow(/laptop could not be reached.*task_move/s)
    // No retries against a host that is gone: only its deadline, a week from the ask.
    const live = h.scheduled.filter((e) => !e.cancelled)
    expect(live).toHaveLength(1)
    expect(live[0]!.ms).toBeGreaterThan(STOP_OFFLINE_MAX_MS)
    expect(live[0]!.ms).toBeLessThanOrEqual(HOST_LOST_STOP_MAX_MS)
  })

  it('a host whose fresh connect comes up takes the stop now, nothing lost', async () => {
    let up = false
    const h = harness([record('s1')], () => (up ? { reachable: true } : { reachable: false, error: 'down' }))
    const d = daemon()
    // The connect the probe made is what connection() then finds.
    h.deps.probe = vi.fn(async () => { up = true; h.conns.set('laptop', d.conn); return { reachable: true } as const })
    const request = await h.build().request('s1')
    expect(request.state).toBe('confirmed')
    expect(d.send).toHaveBeenCalledWith('stop', expect.objectContaining({ sid: 's1' }), 10_000)
    expect(h.read('s1').hostLost).toBeUndefined()
  })

  it('the host coming back ends the process first and records it; the session takes messages again', async () => {
    const h = harness([record('s1')], () => ({ reachable: false, error: 'down' }))
    const c = h.build()
    await c.request('s1', 'task:lead-1')
    const d = daemon({ ok: true, stopped: true })
    await c.flush('laptop', d.conn)
    expect(d.send).toHaveBeenCalledTimes(1)
    expect(d.send.mock.calls[0]![1]).toMatchObject({ sid: 's1', reason: 'user' })
    const rec = h.read('s1')
    expect(rec.stopRequest?.state).toBe('confirmed')
    expect(rec.hostLost?.endedAt).toBeTruthy()
    expect(rec.hostLost?.by).toBe('task:lead-1')
    await expect(c.fence('s1')).resolves.toBe(rec.stopRequest!.id)
  })

  it('a second stop of a lost session keeps its first record and asks nothing new of the host', async () => {
    const h = harness([record('s1')], () => ({ reachable: false, error: 'down' }))
    const c = h.build()
    await c.request('s1', 'human')
    const first = h.read('s1').hostLost!
    await settled()
    await c.request('s1', 'task:other')
    expect(h.read('s1').hostLost).toEqual(first)
    expect(h.scheduled.filter((e) => !e.cancelled)).toHaveLength(1)
  })

  it('a lost stop whose host never comes back fails at its deadline; a restart arms that deadline again', async () => {
    const h = harness([record('s1')], () => ({ reachable: false, error: 'down' }))
    const c = h.build()
    await c.request('s1')
    const restarted = new SessionStopCoordinator({ ...h.deps, pendingAll: async () => [h.read('s1')] })
    expect(await restarted.resumeDeadlines()).toBe(1)
    const armed = h.scheduled.filter((e) => !e.cancelled)
    expect(armed.every((e) => e.ms > STOP_OFFLINE_MAX_MS)).toBe(true)
    armed[0]!.fn()
    await vi.waitFor(() => expect(h.read('s1').stopRequest?.state).toBe('failed'))
  })

  it('a host that is only slow to answer the stop (connected) is never called lost', async () => {
    const h = harness([record('s1')], () => ({ reachable: false, error: 'must not be asked' }))
    h.conns.set('laptop', daemon({ ok: false, error: 'stop: process liveness is unknown; refusing to signal' }).conn)
    const request = await h.build().request('s1')
    expect(h.probe).not.toHaveBeenCalled()
    expect(request.state).toBe('pending')
    expect(isHostLostStopError(request.error)).toBe(false)
    expect(h.read('s1').hostLost).toBeUndefined()
  })
})
