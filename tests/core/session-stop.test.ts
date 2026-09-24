// An unconfirmed stop must never look stopped: only an ok && stopped ACK writes stopped; everything else stays pending for a flush retry.
import { describe, it, expect, vi } from 'vitest'
import {
  SessionStopCoordinator,
  type SessionStopConnection,
  type SessionStopDeps,
} from '../../src/core/sessions/session-stop.js'
import type { SessionRecord } from '../../src/core/types.js'

type StopRequest = NonNullable<SessionRecord['stopRequest']>

const clone = <T>(value: T): T => structuredClone(value)

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeRecord(sid: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: sid,
    taskId: `task-${sid}`,
    project: 'Walnut',
    process_status: 'running',
    mode: 'default',
    startedAt: '2026-09-11T00:00:00.000Z',
    lastActiveAt: '2026-09-11T00:10:00.000Z',
    messageCount: 4,
    pid: 4242,
    activity: 'Editing files',
    host: 'devbox',
    ...over,
  }
}

// Each send hangs on a deferred by sequence number, using gates instead of sleep.
function makeConnection(log: string[], options: { connected?: boolean; auto?: Record<string, unknown> } = {}) {
  const entries: Deferred<void>[] = []
  const gates: Deferred<Record<string, unknown>>[] = []
  const at = <T>(list: Deferred<T>[], index: number): Deferred<T> => {
    while (list.length <= index) list.push(deferred<T>())
    return list[index]!
  }
  const calls: Array<{ command: string; args: Record<string, unknown>; timeoutMs?: number }> = []
  let seen = 0
  const send = vi.fn(async (command: string, args: Record<string, unknown>, timeoutMs?: number) => {
    const index = seen++
    calls.push({ command, args, timeoutMs })
    log.push(`send:${String(args.sid)}`)
    at(entries, index).resolve()
    return options.auto ?? at(gates, index).promise
  })
  const conn: SessionStopConnection = { connected: options.connected ?? true, send }
  return {
    conn,
    calls,
    send,
    entered: (index = 0) => at(entries, index).promise,
    reply: (index: number, value: Record<string, unknown>) => at(gates, index).resolve(value),
    fail: (index: number, cause: unknown) => at(gates, index).reject(cause),
  }
}

// Clone on both read and write: aliasing would hide the read→write race these tests are meant to catch.
function makeHarness(records: SessionRecord[]) {
  const store = new Map<string, SessionRecord>(records.map((r) => [r.claudeSessionId, clone(r)]))
  const conns = new Map<string, SessionStopConnection | null>()
  const log: string[] = []
  let afterGet: ((sid: string) => void) | null = null

  const write = (sid: string, updates: Partial<SessionRecord>): SessionRecord => {
    const current = store.get(sid)
    if (!current) throw new Error(`fake store: no record for ${sid}`)
    const next = { ...clone(current), ...clone(updates) } as SessionRecord
    for (const key of Object.keys(updates) as Array<keyof SessionRecord>) {
      if (updates[key] === undefined) delete next[key]
    }
    store.set(sid, clone(next))
    return clone(next)
  }

  const get = vi.fn(async (sid: string): Promise<SessionRecord | null> => {
    const found = store.get(sid)
    const snapshot = found ? clone(found) : null
    const hook = afterGet
    if (hook) { afterGet = null; hook(sid) }
    return snapshot
  })

  const save = vi.fn(async (sid: string, updates: Partial<SessionRecord>): Promise<SessionRecord> => {
    log.push(`save:${sid}`)
    return write(sid, updates)
  })

  // Mirror the real contract: a conditional update by request.id that writes the stopped state only when confirmed, so "confirm was called" does not mean the ACK succeeded.
  const confirm = vi.fn(async (sid: string, request: StopRequest): Promise<SessionRecord | null> => {
    log.push(`confirm:${sid}:${request.state}`)
    const current = store.get(sid)
    if (current?.stopRequest?.id !== request.id || current.stopRequest.state !== 'pending') return null
    return write(sid, {
      stopRequest: request,
      ...(request.state === 'confirmed'
        ? {
            process_status: 'stopped' as const,
            pid: undefined,
            errorMessage: undefined,
            activity: undefined,
            status_reason: 'user_terminated' as const,
            status_changed_by: 'user' as const,
          }
        : {}),
    })
  })

  // Mirror the listPendingSessionStops filter: pending + COALESCE(host,'__local__').
  const pending = vi.fn(async (host: string): Promise<SessionRecord[]> => (
    [...store.values()]
      .filter((r) => r.stopRequest?.state === 'pending' && (r.host ?? '__local__') === host)
      .map(clone)
  ))

  const park = vi.fn(async (sid: string) => { log.push(`park:${sid}`) })

  const connection = vi.fn(async (host: string): Promise<SessionStopConnection | null> => {
    log.push(`connection:${host}`)
    return conns.get(host) ?? null
  })

  const changed = vi.fn((record: SessionRecord) => {
    log.push(`changed:${record.claudeSessionId}:${record.stopRequest?.state}:${record.process_status}`)
  })

  const deps: SessionStopDeps = { get, save, confirm, pending, park, connection, changed }
  return {
    deps, log, store,
    get, save, confirm, pending, park, connection, changed,
    build: () => new SessionStopCoordinator(deps),
    read: (sid: string): SessionRecord => clone(store.get(sid)!),
    setConnection: (host: string, conn: SessionStopConnection | null) => { conns.set(host, conn) },
    // Simulate another process replacing the pending request.
    replaceStopRequest: (sid: string, request: StopRequest) => write(sid, { stopRequest: request }),
    // Make the replacement happen right after get returns, creating a race between re-read → write.
    afterNextGet: (fn: (sid: string) => void) => { afterGet = fn },
    confirmStates: () => confirm.mock.calls.map(([, request]) => request.state),
  }
}

const newRequest = (id: string): StopRequest => ({ id, requestedAt: '2026-09-11T00:20:00.000Z', state: 'pending' })

describe('SessionStopCoordinator.request', () => {
  it('saves pending, parks the queue, sends stop(reason=user), and only then confirms', async () => {
    const h = makeHarness([makeRecord('s1')])
    const remote = makeConnection(h.log)
    h.setConnection('devbox', remote.conn)
    const coordinator = h.build()

    const inFlight = coordinator.request('s1')
    await remote.entered()

    expect(h.log).toEqual(['save:s1', 'changed:s1:pending:running', 'park:s1', 'connection:devbox', 'send:s1'])
    expect(remote.calls).toEqual([{ command: 'stop', args: { sid: 's1', reason: 'user', stopRequestId: expect.any(String) }, timeoutMs: 10_000 }])
    const midFlight = h.read('s1')
    expect(midFlight.stopRequest?.state).toBe('pending')
    expect(midFlight.process_status).toBe('running')
    expect(midFlight.pid).toBe(4242)
    expect(h.confirm).not.toHaveBeenCalled()

    remote.reply(0, { ok: true, stopped: true })
    const result = await inFlight

    expect(result.state).toBe('confirmed')
    expect(h.confirmStates()).toEqual(['confirmed'])
    const [, confirmed] = h.confirm.mock.calls[0]!
    expect(confirmed).toEqual({ id: result.id, requestedAt: result.requestedAt, state: 'confirmed' })
    const stored = h.read('s1')
    expect(stored.stopRequest).toEqual({ id: result.id, requestedAt: result.requestedAt, state: 'confirmed' })
    expect(stored.process_status).toBe('stopped')
    expect(stored.pid).toBeUndefined()
    expect(stored.activity).toBeUndefined()
    expect(stored.status_reason).toBe('user_terminated')
    expect(stored.status_changed_by).toBe('user')
    expect(h.log.at(-1)).toBe('changed:s1:confirmed:stopped')
  })

  it('throws for an unknown session without saving or parking anything', async () => {
    const h = makeHarness([])
    await expect(h.build().request('ghost')).rejects.toThrow('Session not found')
    expect(h.save).not.toHaveBeenCalled()
    expect(h.park).not.toHaveBeenCalled()
    expect(h.connection).not.toHaveBeenCalled()
    expect(h.changed).not.toHaveBeenCalled()
  })

  it.each([
    ['no connection for the host', null],
    ['a connection that is not connected', 'disconnected' as const],
  ])('leaves the request pending when the host is offline (%s)', async (_name, kind) => {
    const h = makeHarness([makeRecord('s1')])
    const offline = kind === 'disconnected' ? makeConnection(h.log, { connected: false }) : null
    h.setConnection('devbox', offline?.conn ?? null)
    const coordinator = h.build()

    const result = await coordinator.request('s1')

    expect(result.state).toBe('pending')
    expect(result.error).toBe('Host unavailable; waiting for stop confirmation')
    expect(h.confirmStates()).toEqual(['pending'])
    if (offline) expect(offline.send).not.toHaveBeenCalled()
    expect(h.log).not.toContain('send:s1')
    const stored = h.read('s1')
    expect(stored.stopRequest).toEqual({ ...result })
    expect(stored.process_status).toBe('running')
    expect(stored.pid).toBe(4242)
    expect(stored.status_reason).toBeUndefined()
    expect(h.park).toHaveBeenCalledWith('s1')
  })

  it('aborts before parking and before any RPC when the pending save fails', async () => {
    const h = makeHarness([makeRecord('s1')])
    h.setConnection('devbox', makeConnection(h.log, { auto: { ok: true, stopped: true } }).conn)
    h.save.mockRejectedValueOnce(new Error('store unavailable'))

    await expect(h.build().request('s1')).rejects.toThrow('store unavailable')

    expect(h.park).not.toHaveBeenCalled()
    expect(h.connection).not.toHaveBeenCalled()
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.changed).not.toHaveBeenCalled()
    expect(h.read('s1').stopRequest).toBeUndefined()
  })

  it('aborts before any RPC when parking fails, leaving the saved request pending and clean', async () => {
    const h = makeHarness([makeRecord('s1')])
    const remote = makeConnection(h.log, { auto: { ok: true, stopped: true } })
    h.setConnection('devbox', remote.conn)
    h.park.mockRejectedValueOnce(new Error('queue locked'))

    await expect(h.build().request('s1')).rejects.toThrow('queue locked')

    expect(h.connection).not.toHaveBeenCalled()
    expect(remote.send).not.toHaveBeenCalled()
    expect(h.confirm).not.toHaveBeenCalled()
    const stored = h.read('s1')
    expect(stored.stopRequest?.state).toBe('pending')
    expect(stored.stopRequest?.error).toBeUndefined()
    expect(stored.process_status).toBe('running')
  })

  const nonAck: Array<{ name: string; reply?: Record<string, unknown>; fail?: unknown; error: string }> = [
    { name: 'ok but not stopped', reply: { ok: true, stopped: false }, error: 'Daemon did not confirm the stop' },
    { name: 'empty reply', reply: {}, error: 'Daemon did not confirm the stop' },
    { name: 'ok with a non-boolean stopped', reply: { ok: true, stopped: 'yes' }, error: 'Daemon did not confirm the stop' },
    { name: 'daemon error reply', reply: { ok: false, error: 'session already gone' }, error: 'session already gone' },
    { name: 'rpc timeout', fail: new Error('stop timed out after 10000ms'), error: 'stop timed out after 10000ms' },
    { name: 'non-Error throw', fail: 'socket closed', error: 'socket closed' },
  ]

  it.each(nonAck)('keeps the request pending with an error: $name', async ({ reply, fail, error }) => {
    const h = makeHarness([makeRecord('s1')])
    const remote = makeConnection(h.log)
    h.setConnection('devbox', remote.conn)

    const inFlight = h.build().request('s1')
    await remote.entered()
    if (fail !== undefined) remote.fail(0, fail)
    else remote.reply(0, reply!)
    const result = await inFlight

    expect(result.state).toBe('pending')
    expect(result.error).toBe(error)
    expect(h.confirmStates()).toEqual(['pending'])
    const stored = h.read('s1')
    expect(stored.stopRequest).toEqual({ id: result.id, requestedAt: result.requestedAt, state: 'pending', error })
    expect(stored.process_status).toBe('running')
    expect(stored.pid).toBe(4242)
  })

  it('keeps the request pending when an ACKed confirm write does not land', async () => {
    const h = makeHarness([makeRecord('s1')])
    h.setConnection('devbox', makeConnection(h.log, { auto: { ok: true, stopped: true } }).conn)
    h.confirm.mockResolvedValueOnce(null) // the conditional write did not match

    const result = await h.build().request('s1')

    expect(result.state).toBe('pending')
    expect(result.error).toBeUndefined()
    expect(h.confirmStates()).toEqual(['confirmed'])
    const stored = h.read('s1')
    expect(stored.stopRequest?.state).toBe('pending')
    expect(stored.process_status).toBe('running')
    expect(h.changed.mock.calls).toHaveLength(1)
    expect(h.log).not.toContain('changed:s1:confirmed:stopped')
  })

  it('falls back to a pending error when the confirmed write throws', async () => {
    const h = makeHarness([makeRecord('s1')])
    h.setConnection('devbox', makeConnection(h.log, { auto: { ok: true, stopped: true } }).conn)
    h.confirm.mockImplementationOnce(async () => { throw new Error('conditional write failed') })

    const result = await h.build().request('s1')

    expect(result).toMatchObject({ state: 'pending', error: 'conditional write failed' })
    expect(h.confirmStates()).toEqual(['confirmed', 'pending'])
    const stored = h.read('s1')
    expect(stored.stopRequest?.state).toBe('pending')
    expect(stored.stopRequest?.error).toBe('conditional write failed')
    expect(stored.process_status).toBe('running')
  })

  it('serializes concurrent requests and reuses the pending id', async () => {
    const h = makeHarness([makeRecord('s1')])
    const remote = makeConnection(h.log)
    h.setConnection('devbox', remote.conn)
    const coordinator = h.build()

    const first = coordinator.request('s1')
    const second = coordinator.request('s1')
    await remote.entered(0)

    expect(remote.send).toHaveBeenCalledTimes(1)
    expect(h.park).toHaveBeenCalledTimes(1)

    remote.reply(0, { ok: false, error: 'busy' })
    const firstResult = await first
    await remote.entered(1)
    remote.reply(1, { ok: true, stopped: true })
    const secondResult = await second

    expect(firstResult).toMatchObject({ state: 'pending', error: 'busy' })
    expect(secondResult).toMatchObject({ id: firstResult.id, state: 'confirmed' })
    expect(secondResult.requestedAt).toBe(firstResult.requestedAt)
    expect(h.log.filter((line) => line.startsWith('park:') || line.startsWith('send:'))).toEqual([
      'park:s1', 'send:s1', 'park:s1', 'send:s1',
    ])
    expect(h.read('s1').process_status).toBe('stopped')
  })
})

describe('SessionStopCoordinator late acknowledgements', () => {
  it('cannot confirm a stop after a different request replaced it', async () => {
    const h = makeHarness([makeRecord('s1')])
    const remote = makeConnection(h.log)
    h.setConnection('devbox', remote.conn)

    const inFlight = h.build().request('s1')
    await remote.entered()
    const replacement = newRequest('replacement-id')
    h.replaceStopRequest('s1', replacement)

    remote.reply(0, { ok: true, stopped: true })
    const result = await inFlight

    expect(h.confirmStates()).toEqual(['confirmed'])
    expect(h.confirm.mock.calls[0]![1].id).not.toBe(replacement.id)
    expect(result.state).toBe('pending')
    const stored = h.read('s1')
    expect(stored.stopRequest).toEqual(replacement)
    expect(stored.process_status).toBe('running')
    expect(h.log).not.toContain('changed:s1:confirmed:stopped')
  })

  it('does not stamp a late failure onto the newer request', async () => {
    const h = makeHarness([makeRecord('s1')])
    const remote = makeConnection(h.log)
    h.setConnection('devbox', remote.conn)

    const inFlight = h.build().request('s1')
    await remote.entered()
    const replacement = newRequest('replacement-id')
    h.replaceStopRequest('s1', replacement)

    remote.fail(0, new Error('tunnel closed'))
    const result = await inFlight

    expect(result).toEqual(replacement)
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.read('s1').stopRequest).toEqual(replacement)
  })

  it('does not clobber a newer request that lands between the re-read and the error write', async () => {
    const h = makeHarness([makeRecord('s1')])
    const remote = makeConnection(h.log)
    h.setConnection('devbox', remote.conn)

    const inFlight = h.build().request('s1')
    await remote.entered()
    const original = h.read('s1').stopRequest!
    const replacement = newRequest('raced-in-id')
    h.afterNextGet(() => { h.replaceStopRequest('s1', replacement) })

    remote.reply(0, { ok: false, error: 'busy' })
    const result = await inFlight

    expect(h.confirmStates()).toEqual(['pending'])
    expect(h.confirm.mock.calls[0]![1]).toEqual({ ...original, error: 'busy' })
    expect(result).toEqual(replacement)
    expect(result.error).toBeUndefined()
    const stored = h.read('s1')
    expect(stored.stopRequest).toEqual(replacement)
    expect(stored.stopRequest?.error).toBeUndefined()
    expect(stored.process_status).toBe('running')
  })
})

describe('SessionStopCoordinator.flush', () => {
  it('delivers a request saved by an earlier coordinator, over the connection it is handed', async () => {
    const h = makeHarness([makeRecord('s1')])
    h.setConnection('devbox', null)
    const first = await h.build().request('s1')
    expect(first.state).toBe('pending')
    const connectCalls = h.connection.mock.calls.length

    const reconnected = makeConnection(h.log, { auto: { ok: true, stopped: true } })
    await h.build().flush('devbox', reconnected.conn)

    expect(reconnected.calls).toEqual([{ command: 'stop', args: { sid: 's1', reason: 'user', stopRequestId: expect.any(String) }, timeoutMs: 10_000 }])
    expect(h.connection.mock.calls).toHaveLength(connectCalls)
    expect(h.confirmStates()).toEqual(['pending', 'confirmed'])
    const stored = h.read('s1')
    expect(stored.stopRequest).toEqual({ id: first.id, requestedAt: first.requestedAt, state: 'confirmed' })
    expect(stored.process_status).toBe('stopped')
    expect(await h.pending('devbox')).toEqual([])
  })

  it('only touches pending requests on the asked-for host', async () => {
    const h = makeHarness([
      makeRecord('s1', { stopRequest: newRequest('req-1') }),
      makeRecord('s2', { host: 'other-host', stopRequest: newRequest('req-2') }),
      makeRecord('s3', { stopRequest: { id: 'req-3', requestedAt: '2026-09-11T00:05:00.000Z', state: 'confirmed' } }),
      makeRecord('s4', { host: undefined, stopRequest: newRequest('req-4') }),
    ])
    const remote = makeConnection(h.log, { auto: { ok: true, stopped: true } })

    await h.build().flush('devbox', remote.conn)

    expect(remote.calls.map((call) => call.args.sid)).toEqual(['s1'])
    expect(h.log.filter((line) => line.startsWith('park:'))).toEqual(['park:s1'])
    expect(h.read('s1').process_status).toBe('stopped')
    for (const sid of ['s2', 's3', 's4']) {
      const untouched = h.read(sid)
      expect(untouched.process_status).toBe('running')
      expect(untouched.stopRequest?.error).toBeUndefined()
    }
    expect(h.read('s3').stopRequest?.state).toBe('confirmed')
  })

  it('treats a hostless session as the local host, for both the flush key and the connection lookup', async () => {
    const h = makeHarness([makeRecord('s1', { host: undefined })])
    h.setConnection('__local__', null)
    await h.build().request('s1')
    expect(h.connection).toHaveBeenCalledWith('__local__')

    const local = makeConnection(h.log, { auto: { ok: true, stopped: true } })
    await h.build().flush('__local__', local.conn)

    expect(local.calls.map((call) => call.args.sid)).toEqual(['s1'])
    expect(h.read('s1').process_status).toBe('stopped')
  })

  it('joins the in-flight request for the same sid instead of sending a second stop', async () => {
    const h = makeHarness([makeRecord('s1')])
    const remote = makeConnection(h.log)
    h.setConnection('devbox', remote.conn)
    const coordinator = h.build()

    const inFlight = coordinator.request('s1')
    await remote.entered(0)
    const flushed = coordinator.flush('devbox', remote.conn)

    remote.reply(0, { ok: true, stopped: true })
    const result = await inFlight
    await flushed

    expect(result.state).toBe('confirmed')
    expect(remote.send).toHaveBeenCalledTimes(1)
    expect(h.park).toHaveBeenCalledTimes(1)
    expect(h.confirmStates()).toEqual(['confirmed'])
    expect(h.read('s1').process_status).toBe('stopped')
  })

  it('is a no-op when the host has no pending stops', async () => {
    const h = makeHarness([makeRecord('s1')])
    const remote = makeConnection(h.log, { auto: { ok: true, stopped: true } })

    await h.build().flush('devbox', remote.conn)

    expect(remote.send).not.toHaveBeenCalled()
    expect(h.park).not.toHaveBeenCalled()
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.log).toEqual([])
  })
})

// A slow send (large image upload, reconnect) must not revive a session whose stop was confirmed meanwhile: re-check the fence before sending.
describe('SessionStopCoordinator fence + dispatch', () => {
  const confirmedRequest = (id: string): StopRequest => (
    { id, requestedAt: '2026-09-11T00:20:00.000Z', state: 'confirmed' }
  )

  it('reports the current stop id, and refuses to hand out a fence while one is pending', async () => {
    const h = makeHarness([
      makeRecord('s1'),
      makeRecord('s2', { stopRequest: confirmedRequest('stop-2') }),
      makeRecord('s3', { stopRequest: newRequest('stop-3') }),
    ])
    const coordinator = h.build()

    await expect(coordinator.fence('s1')).resolves.toBeNull()
    await expect(coordinator.fence('s2')).resolves.toBe('stop-2')
    await expect(coordinator.fence('ghost')).resolves.toBeNull()
    await expect(coordinator.fence('s3')).rejects.toThrow('Session stop is awaiting host confirmation')
  })

  it('refuses a pending-stop session at the fence, before the send is reached', async () => {
    const h = makeHarness([makeRecord('s1', { stopRequest: newRequest('stop-1') })])
    const send = vi.fn(async () => 'delivered')

    await expect(h.build().dispatch('s1', null, send)).rejects.toThrow('Session stop is awaiting host confirmation')
    expect(send).not.toHaveBeenCalled()
  })

  it('drops a send whose fence was captured before the stop was confirmed', async () => {
    const h = makeHarness([makeRecord('s1')])
    h.setConnection('devbox', makeConnection(h.log, { auto: { ok: true, stopped: true } }).conn)
    const coordinator = h.build()

    const fence = await coordinator.fence('s1')
    expect(fence).toBeNull()
    const stop = await coordinator.request('s1')
    expect(stop.state).toBe('confirmed')

    const send = vi.fn(async () => 'delivered')
    await expect(coordinator.dispatch('s1', fence, send))
      .rejects.toThrow('Session delivery was superseded by a stop request')
    expect(send).not.toHaveBeenCalled()

    const fresh = await coordinator.fence('s1')
    expect(fresh).toBe(stop.id)
    await expect(coordinator.dispatch('s1', fresh, send)).resolves.toBe('delivered')
    expect(send).toHaveBeenCalledTimes(1)
    await expect(coordinator.dispatch('s1', 'older-stop-id', send))
      .rejects.toThrow('Session delivery was superseded by a stop request')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('makes a stop wait for an in-flight dispatch to settle before it writes or sends', async () => {
    const h = makeHarness([makeRecord('s1')])
    const remote = makeConnection(h.log)
    h.setConnection('devbox', remote.conn)
    const coordinator = h.build()

    const upload = deferred<string>()
    const entered = deferred<void>()
    const send = vi.fn(async () => { h.log.push('dispatch:send'); entered.resolve(); return upload.promise })

    const fence = await coordinator.fence('s1')
    const dispatched = coordinator.dispatch('s1', fence, send)
    await entered.promise

    const getsBefore = h.get.mock.calls.length
    const stopping = coordinator.request('s1')
    await Promise.resolve() // yield two extra microtasks so a queued stop gets a chance to cut in
    await Promise.resolve()
    expect(h.get.mock.calls).toHaveLength(getsBefore)
    expect(h.save).not.toHaveBeenCalled()
    expect(h.park).not.toHaveBeenCalled()
    expect(remote.send).not.toHaveBeenCalled()

    upload.resolve('delivered')
    await expect(dispatched).resolves.toBe('delivered')
    await remote.entered(0)
    remote.reply(0, { ok: true, stopped: true })
    const stop = await stopping

    expect(stop.state).toBe('confirmed')
    expect(h.log).toEqual([
      'dispatch:send', 'save:s1', 'changed:s1:pending:running', 'park:s1',
      'connection:devbox', 'send:s1', 'confirm:s1:confirmed', 'changed:s1:confirmed:stopped',
    ])
    expect(h.read('s1').process_status).toBe('stopped')
  })

  it('is not blocked by a dispatch that failed', async () => {
    const h = makeHarness([makeRecord('s1')])
    h.setConnection('devbox', makeConnection(h.log, { auto: { ok: true, stopped: true } }).conn)
    const coordinator = h.build()

    const fence = await coordinator.fence('s1')
    const failing = coordinator.dispatch('s1', fence, async () => { throw new Error('upload failed') })
    const stopping = coordinator.request('s1')

    await expect(failing).rejects.toThrow('upload failed')
    await expect(stopping).resolves.toMatchObject({ state: 'confirmed' })
    expect(h.read('s1').process_status).toBe('stopped')
  })
})
