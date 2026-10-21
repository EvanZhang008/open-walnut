/**
 * A send whose answer never came is not a refusal (connection-matrix S8).
 *
 * The host took the request but its reply arrived after the 30 s command
 * timeout. Reading that as "not delivered" made the runner stop the healthy
 * CLI and --resume the same line, which then ran twice. The manager now asks
 * the daemon again with `dedupe` (send-dedupe-v1): the daemon writes the line
 * only if the CLI lacks it, so the answer is the delivery itself, once. When no
 * answer comes at all, or the daemon cannot dedupe, it throws
 * SendOutcomeUnknownError instead of returning false.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { BudgetPausedError, SendHeldError, SendOutcomeUnknownError } from '../../src/providers/delivery-failure.js'
import { markLinkFailure } from '../../src/providers/link-failure.js'
import fs from 'node:fs'
import { sessionStops, SessionStopSupersededError } from '../../src/core/sessions/session-stop.js'

const fallback = vi.hoisted(() => ({ ephemeral: false, send: vi.fn(), permission: vi.fn(), connect: vi.fn(), links: [] as Array<{
  connected: boolean; fromOffset: () => number; emit: (event: Record<string, unknown>) => void; close: ReturnType<typeof vi.fn>;
}> }))
vi.mock('../../src/core/cloud-ingest.js', () => ({ postToCloudSessionSend: fallback.send, postToCloudSessionPermission: fallback.permission }))
vi.mock('../../src/providers/cloud-session-link.js', () => ({
  CloudSessionLink: class {
    connected = false
    close = vi.fn(() => { this.connected = false })
    constructor(_host: string, _sid: string, public fromOffset: () => number, public emit: (event: Record<string, unknown>) => void) {
      fallback.links.push(this)
    }
    private attached: Record<string, unknown> | null = null
    async connect() {
      if (this.connected && this.attached) return this.attached
      const reply = await fallback.connect()
      this.connected = true
      this.attached = reply
      this.emit({ ev: 'attached', ...reply })
      return reply
    }
  },
}))
vi.mock('../../src/constants.js', async () => {
  const { createMockConstants } = await import('../helpers/mock-constants.js')
  return { ...createMockConstants('send-confirm'), get IS_EPHEMERAL() { return fallback.ephemeral } }
})

type Reply = Record<string, unknown> | Error

function fakeConn(replies: Reply[], capabilities = ['send-markers-v1', 'send-dedupe-v1']) {
  const sent: Array<{ cmd: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    conn: {
      connected: true,
      hasCapability: (c: string) => capabilities.includes(c),
      send: vi.fn(async (cmd: string, payload: Record<string, unknown>) => {
        sent.push({ cmd, payload })
        const next = replies.shift() ?? new Error('daemon command timeout: send (30000ms)')
        if (next instanceof Error) throw next
        return next
      }),
    },
  }
}

function manager(conn: unknown): RemoteSessionManager {
  // No ssh target and no direct url: a private connection, never redialled here.
  const mgr = new RemoteSessionManager('sid-1', '__local__', null)
  Object.assign(mgr as unknown as Record<string, unknown>, { conn, _sid: 'sid-1' })
  return mgr
}

const markers = [{ message: 'hello', messageId: 'qm-1' }]
const timeout = () => new Error('daemon command timeout: send (30000ms)')

describe('RemoteSessionManager: a send whose answer never came', () => {
  const deadline = RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS
  beforeEach(() => {
    fallback.ephemeral = false
    fallback.send.mockReset().mockResolvedValue(null)
    fallback.permission.mockReset().mockResolvedValue({ ok: true })
    fallback.connect.mockReset().mockResolvedValue({ ok: true, alive: true })
    fallback.links.length = 0
  })
  afterEach(() => {
    RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS = deadline
    vi.restoreAllMocks()
  })

  it('holds an initialized session with no connection without dispatching or reporting process death', async () => {
    for (const disconnected of [null, { connected: false, send: vi.fn() }]) {
      const mgr = manager(disconnected)
      const onExit = vi.fn()
      const onDispatch = vi.fn()
      const prepare = vi.spyOn(mgr, 'prepareOutbound')
      Object.assign(mgr, { _onExit: onExit, _hasPipe: true, _pid: 77 })
      const error = await mgr.writeMessage('hello', { uuid: 'u-1', markers, onDispatch }).catch((err) => err)
      expect(error).toBeInstanceOf(SendHeldError)
      expect(error.message).toBe('Not sent yet: waiting for the connection to the session host')
      expect(prepare).not.toHaveBeenCalled()
      expect(onDispatch).not.toHaveBeenCalled()
      expect(onExit).not.toHaveBeenCalled()
      expect(mgr.hasPipe).toBe(true)
      expect(mgr.pid).toBe(77)
      if (disconnected) expect(disconnected.send).not.toHaveBeenCalled()
      prepare.mockRestore()
    }
  })

  it('an uninitialized session still returns false instead of waiting on a host connection', async () => {
    const mgr = new RemoteSessionManager('sid-1', '__local__', null)
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(false)
  })

  it('holds a tagged connection failure during preparation without dispatching the user line', async () => {
    const { conn, sent } = fakeConn([{ ok: true }])
    const mgr = manager(conn)
    const onExit = vi.fn()
    const onDispatch = vi.fn()
    Object.assign(mgr, { _onExit: onExit, _hasPipe: true })
    vi.spyOn(mgr, 'prepareOutbound').mockRejectedValueOnce(markLinkFailure(new Error('host connection unavailable'), 'no-link'))
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, onDispatch })).rejects.toBeInstanceOf(SendHeldError)
    expect(sent).toEqual([])
    expect(onDispatch).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(true)
    expect(sent).toEqual([{ cmd: 'send', payload: { sid: 'sid-1', message: 'hello', uuid: 'u-1', markers } }])
  })

  it.each([
    ['tagged no-link', markLinkFailure(new Error('host connection unavailable'), 'no-link')],
    ['legacy not connected', new Error('DaemonConnection not connected to __local__')],
  ])('holds %s after preparation and sends the same uuid once after recovery', async (_label, failure) => {
    const { conn, sent } = fakeConn([{ ok: true }])
    const mgr = manager(conn)
    const onExit = vi.fn()
    Object.assign(mgr, { _onExit: onExit, _hasPipe: true, _pid: 77 })
    const prepare = vi.spyOn(mgr, 'prepareOutbound')
    // The connection rejects before putting a command on the wire, as DaemonConnection.send does.
    conn.send.mockImplementationOnce(async () => { throw failure })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    expect(prepare).toHaveBeenCalledOnce()
    expect(sent).toEqual([])
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
    expect(mgr.pid).toBe(77)
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(true)
    expect(sent).toEqual([{ cmd: 'send', payload: { sid: 'sid-1', message: 'hello', uuid: 'u-1', markers } }])
    expect(onExit).not.toHaveBeenCalled()
  })

  it('a confirmed session death still returns false and reports the actual process exit', async () => {
    const { conn, sent } = fakeConn([{ ok: false, reason: 'session_dead', exitCode: 0 }])
    const mgr = manager(conn)
    const onExit = vi.fn()
    Object.assign(mgr, { _onExit: onExit, _hasPipe: true })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(false)
    expect(sent.map((row) => row.cmd)).toEqual(['send'])
    expect(onExit).toHaveBeenCalledExactlyOnceWith(0)
    expect(mgr.hasPipe).toBe(false)
  })

  it('uses the cloud send for a disconnected remote host under the same uuid without synthetic markers', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    const onDispatch = vi.fn()
    const onFate = vi.fn()
    const onExit = vi.fn()
    Object.assign(mgr, { _sid: 'sid-1', _hasPipe: true, _pid: 77, _onExit: onExit })
    const synthetic = vi.spyOn(mgr, 'writeSyntheticUserEvent')
    fallback.send.mockResolvedValueOnce({ ok: true, duplicate: true, fate: 'waiting', state: 'queued' })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, onDispatch, onFate })).resolves.toBe(true)
    expect(fallback.send).toHaveBeenCalledExactlyOnceWith({
      host: 'remote-box', sessionId: 'sid-1', message: 'hello', uuid: 'u-1', markers, stopFence: null,
    })
    expect(onDispatch).toHaveBeenCalledOnce()
    expect(onFate).toHaveBeenCalledExactlyOnceWith({ fate: 'waiting', state: 'queued' })
    expect(synthetic).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.pid).toBe(77)
    expect(mgr.hasPipe).toBe(true)
    expect(mgr.lastPreparedOutbound).toBe('hello')
  })

  it('a cloud send passes through the same stop fence before dispatch', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    const onDispatch = vi.fn()
    const dispatch = vi.spyOn(sessionStops, 'dispatch').mockRejectedValueOnce(new SessionStopSupersededError('Session stopped'))
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, stopFence: 'stop-1', onDispatch })).rejects.toBeInstanceOf(SessionStopSupersededError)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith('sid-1', 'stop-1', expect.any(Function))
    expect(onDispatch).not.toHaveBeenCalled()
    expect(fallback.send).not.toHaveBeenCalled()
  })

  it('a cloud no-link rejection is held and never turns into a refused write', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    const onExit = vi.fn()
    Object.assign(mgr, { _sid: 'sid-1', _hasPipe: true, _onExit: onExit })
    fallback.send.mockRejectedValueOnce(markLinkFailure(new Error('no cloud connection'), 'no-link'))
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    expect(fallback.send).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
  })

  it('a definitely unsent native request tries the cloud route once and preserves cut reporting', async () => {
    const { conn, sent } = fakeConn([{ ok: true }])
    conn.send.mockImplementationOnce(async () => { conn.connected = false; throw markLinkFailure(new Error('host connection unavailable'), 'no-link') })
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { conn, _sid: 'sid-1', _hasPipe: true })
    fallback.send.mockResolvedValueOnce({ ok: true, cut: true })
    const onCut = vi.fn()
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, onCut })).resolves.toBe(true)
    expect(sent).toEqual([])
    expect(conn.send).toHaveBeenCalledOnce()
    expect(fallback.send).toHaveBeenCalledOnce()
    expect(fallback.send.mock.calls[0][0]).toMatchObject({ message: 'hello', uuid: 'u-1' })
    expect(onCut).toHaveBeenCalledOnce()
  })

  it('a missing cloud path holds the same line until the native connection returns', async () => {
    const { conn, sent } = fakeConn([{ ok: true }])
    conn.connected = false
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { conn, _sid: 'sid-1', _hasPipe: true })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    expect(fallback.send).toHaveBeenCalledOnce()
    expect(sent).toEqual([])
    conn.connected = true
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload.uuid).toBe('u-1')
    expect(fallback.send).toHaveBeenCalledOnce()
  })

  it('a cloud answer lost in flight stays unknown and holds a later concurrent line without another request', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    const onExit = vi.fn()
    Object.assign(mgr, { _sid: 'sid-1', _hasPipe: true, _onExit: onExit })
    let reject!: (error: Error) => void
    fallback.send.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r }))
    const first = mgr.writeMessage('first', { uuid: 'u-1', markers: [{ message: 'first', messageId: 'qm-1' }] })
    const second = mgr.writeMessage('second', { uuid: 'u-2', markers: [{ message: 'second', messageId: 'qm-2' }] })
    const firstCheck = expect(first).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    const secondCheck = expect(second).rejects.toBeInstanceOf(SendHeldError)
    await vi.waitFor(() => expect(fallback.send).toHaveBeenCalledOnce())
    reject(new SendOutcomeUnknownError('cloud request timed out'))
    await firstCheck
    await secondCheck
    expect(fallback.send).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
    fallback.send.mockResolvedValueOnce({ ok: true, duplicate: true, fate: 'ran' })
    await expect(mgr.writeMessage('first', { uuid: 'u-1', markers: [{ message: 'first', messageId: 'qm-1' }] })).resolves.toBe(true)
    expect(fallback.send.mock.calls[1][0]).toMatchObject({ message: 'first', uuid: 'u-1' })
  })

  it('a lost cloud answer is deduped under the same uuid if the native connection returns', async () => {
    const { conn, sent } = fakeConn([{ ok: true, duplicate: true, fate: 'ran' }])
    conn.connected = false
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { conn, _sid: 'sid-1', _hasPipe: true })
    fallback.send.mockRejectedValueOnce(new SendOutcomeUnknownError('cloud request timed out'))
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    expect(sent).toEqual([])
    conn.connected = true
    const onFate = vi.fn()
    // The queue retains the line uuid and retries with dedupe after an unknown send.
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, dedupe: true, onFate })).resolves.toBe(true)
    expect(sent).toEqual([{ cmd: 'send', payload: { sid: 'sid-1', message: 'hello', uuid: 'u-1', markers, dedupe: true } }])
    expect(onFate).toHaveBeenCalledExactlyOnceWith({ fate: 'ran' })
    expect(fallback.send).toHaveBeenCalledOnce()
  })

  it('an ambiguous native send confirms with the daemon rather than switching to cloud', async () => {
    const { conn, sent } = fakeConn([timeout(), { ok: true, duplicate: true }])
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { conn, _sid: 'sid-1' })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(true)
    expect(sent.map((s) => s.cmd)).toEqual(['send', 'send'])
    expect(fallback.send).not.toHaveBeenCalled()
  })

  it.each(['__local__', '__cloudbox__'])('never uses the cloud route for %s', async (host) => {
    const mgr = new RemoteSessionManager('sid-1', host, null)
    Object.assign(mgr, { _sid: 'sid-1' })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    expect(fallback.send).not.toHaveBeenCalled()
  })

  it('never uses the cloud route from an ephemeral server or an uninitialized session', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    fallback.ephemeral = true
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    fallback.ephemeral = false
    Object.assign(mgr, { _sid: null })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(false)
    expect(fallback.send).not.toHaveBeenCalled()
  })

  it.each([{ markers }, { uuid: 'u-1' }, { uuid: 'u-1', markers: [] }])('requires a stable uuid and markers for cloud delivery (%j)', async (options) => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    await expect(mgr.writeMessage('hello', options)).rejects.toBeInstanceOf(SendHeldError)
    expect(fallback.send).not.toHaveBeenCalled()
  })

  it('never sends a local image over the cloud route without uploading it', async () => {
    // A file fact only: no local file is created or read and no daemon is contacted.
    const stat = vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats)
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    await expect(mgr.writeMessage('see /tmp/image.png', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    expect(fallback.send).not.toHaveBeenCalled()
    stat.mockRestore()
  })

  it('a held image blocks a later concurrent cloud text until both retry in native order', async () => {
    const { conn, sent } = fakeConn([{ ok: true }, { ok: true }])
    conn.connected = false
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { conn, _sid: 'sid-1', _hasPipe: true })
    // File identity only, without reading an actual image or sending to a real daemon.
    const stat = vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats)
    const image = 'see /tmp/image.png'
    const imageOpts = { uuid: 'u-image', markers: [{ message: image, messageId: 'qm-image' }] }
    const textOpts = { uuid: 'u-text', markers: [{ message: 'then answer', messageId: 'qm-text' }] }
    const outcomes = await Promise.allSettled([
      mgr.writeMessage(image, imageOpts),
      mgr.writeMessage('then answer', textOpts),
    ])
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(SendHeldError)
    }
    expect(fallback.send).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    stat.mockRestore()
    conn.connected = true
    vi.spyOn(mgr, 'prepareOutbound').mockImplementation(async (text) => text)
    await expect(Promise.all([
      mgr.writeMessage(image, imageOpts),
      mgr.writeMessage('then answer', textOpts),
    ])).resolves.toEqual([true, true])
    expect(sent.map((s) => ({ message: s.payload.message, uuid: s.payload.uuid }))).toEqual([
      { message: image, uuid: 'u-image' },
      { message: 'then answer', uuid: 'u-text' },
    ])
    expect(fallback.send).not.toHaveBeenCalled()
  })

  it.each([77, 2])('forwards a valid lostPid %s through the cloud rewrite path', async (lostPid) => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    fallback.send.mockResolvedValueOnce({ ok: true })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, lostPid })).resolves.toBe(true)
    expect(fallback.send).toHaveBeenCalledExactlyOnceWith({
      host: 'remote-box', sessionId: 'sid-1', message: 'hello', uuid: 'u-1', markers, stopFence: null, lostPid,
    })
  })

  it.each([undefined, -1, 0, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('omits an invalid lostPid %s from the cloud payload', async (lostPid) => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    fallback.send.mockResolvedValueOnce({ ok: true })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, lostPid })).resolves.toBe(true)
    expect(fallback.send).toHaveBeenCalledOnce()
    expect(fallback.send.mock.calls[0][0]).not.toHaveProperty('lostPid')
  })

  it('a cloud identity refusal is held without clearing the pipe or stopping the live process', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    const onExit = vi.fn()
    Object.assign(mgr, { _sid: 'sid-1', _hasPipe: true, _onExit: onExit })
    fallback.send.mockResolvedValueOnce({ ok: false, reason: 'identity_mismatch' })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    expect(fallback.send).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
  })

  it('a daemon death returned through cloud waits for native recovery without a stop or cold resume', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    const onExit = vi.fn()
    Object.assign(mgr, { _sid: 'sid-1', _hasPipe: true, _onExit: onExit })
    fallback.send.mockResolvedValueOnce({ ok: false, reason: 'session_dead', exitCode: 0 })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    expect(fallback.send).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
  })

  it('a dead cloud attachment holds the line without sending, clearing the pipe, or reporting death', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    const onExit = vi.fn()
    Object.assign(mgr, { _sid: 'sid-1', _hasPipe: true, _onExit: onExit })
    fallback.connect.mockResolvedValueOnce({ ok: true, alive: false, state: 'dead' })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    expect(fallback.send).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
  })

  it('rediscovers a missing native registry without changing mode and retries the same line with dedupe', async () => {
    const { conn, sent } = fakeConn([
      { ok: false, reason: 'not_found' },
      { ok: true, alive: true, pid: 88, currentOffset: 100 },
      { ok: true, duplicate: true, fate: 'waiting' },
    ])
    const mgr = manager(conn)
    const onExit = vi.fn()
    const onFate = vi.fn()
    Object.assign(mgr, { _onExit: onExit, _hasPipe: true, _fileSize: 50, _cursorValid: true })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, onFate })).resolves.toBe(true)
    expect(sent.map((s) => s.cmd)).toEqual(['send', 'attach', 'send'])
    expect(sent[1].payload).toEqual({ sid: 'sid-1', fromOffset: 50 })
    expect(sent[2].payload).toEqual({ sid: 'sid-1', message: 'hello', uuid: 'u-1', markers, dedupe: true })
    expect(mgr.pid).toBe(88)
    expect(mgr.tailOffset).toBe(100)
    expect(onFate).toHaveBeenCalledExactlyOnceWith({ fate: 'waiting' })
    expect(onExit).not.toHaveBeenCalled()
  })

  it('a rediscovery dead reply is not enough until the daemon send explicitly confirms session death', async () => {
    const { conn, sent } = fakeConn([
      { ok: false, reason: 'not_found' }, { ok: true, alive: false, state: 'dead' },
      { ok: false, reason: 'session_dead', exitCode: 0 },
    ])
    const mgr = manager(conn)
    const onExit = vi.fn()
    Object.assign(mgr, { _onExit: onExit, _hasPipe: true })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(false)
    expect(sent.map((s) => s.cmd)).toEqual(['send', 'attach', 'send'])
    expect(onExit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it.each([{ ok: false }, { ok: true }, { ok: true, alive: false, state: 'unknown' }, new Error('attach failed')])('holds an inconclusive rediscovery (%j) without another send or a process exit', async (reply) => {
    const { conn, sent } = fakeConn([{ ok: false, reason: 'not_found' }, reply])
    const mgr = manager(conn)
    const onExit = vi.fn()
    Object.assign(mgr, { _onExit: onExit, _hasPipe: true })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    expect(sent.map((s) => s.cmd)).toEqual(['send', 'attach'])
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
  })

  it('a rediscovered retry whose acknowledgement is lost uses the existing confirmation path', async () => {
    const { conn, sent } = fakeConn([
      { ok: false, reason: 'not_found' }, { ok: true, alive: true, pid: 88 }, timeout(),
      { ok: true, duplicate: true, fate: 'ran' },
    ])
    await expect(manager(conn).writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(true)
    expect(sent.map((s) => s.cmd)).toEqual(['send', 'attach', 'send', 'send'])
    expect(sent.slice(2).every((s) => s.payload.uuid === 'u-1' && s.payload.dedupe === true)).toBe(true)
  })

  it('the cloud link feeds exact raw events through the existing parser and never rewinds a catch-up cursor', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    const onOutput = vi.fn()
    Object.assign(mgr, { _sid: 'sid-1', _onOutput: onOutput })
    fallback.connect.mockImplementationOnce(async () => {
      fallback.links[0].emit({ ev: 'jsonl', sid: 'sid-1', v: 100, line: JSON.stringify({ type: 'assistant', uuid: 'a1' }) })
      return { ok: true, alive: true, pid: 88, currentOffset: 50 }
    })
    fallback.send.mockResolvedValueOnce({ ok: true })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(true)
    expect(mgr.pid).toBe(88)
    expect(mgr.tailOffset).toBe(100)
    expect(onOutput).toHaveBeenCalledExactlyOnceWith({ line: JSON.stringify({ type: 'assistant', uuid: 'a1' }), v: 100 })
    fallback.links[0].emit({ ev: 'jsonl', sid: 'sid-1', v: 100, line: JSON.stringify({ type: 'assistant', uuid: 'a1' }) })
    expect(onOutput).toHaveBeenCalledOnce()
  })

  it('native recovery closes the independent cloud link on its next event', async () => {
    const { conn } = fakeConn([{ ok: true }])
    conn.connected = false
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { conn, _sid: 'sid-1' })
    fallback.send.mockResolvedValueOnce({ ok: true })
    await mgr.writeMessage('hello', { uuid: 'u-1', markers })
    conn.connected = true
    ;(mgr as unknown as { handleDaemonEvent(event: Record<string, unknown>): void }).handleDaemonEvent({ ev: 'jsonl', sid: 'sid-1', v: 100, line: '{}' })
    expect(fallback.links[0].close).toHaveBeenCalledOnce()
  })

  it('detach cancels a pending cloud attachment so a late reply cannot revive the manager or send the line', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1', _pid: 77, _hasPipe: false })
    let resolve!: (reply: Record<string, unknown>) => void
    fallback.connect.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const write = mgr.writeMessage('hello', { uuid: 'u-1', markers })
    const rejected = expect(write).rejects.toBeInstanceOf(SendHeldError)
    await vi.waitFor(() => expect(fallback.connect).toHaveBeenCalledOnce())
    mgr.detach()
    resolve({ ok: true, alive: true, pid: 88 })
    await rejected
    expect(fallback.links[0].close).toHaveBeenCalledOnce()
    expect(mgr.pid).toBe(77)
    expect(mgr.hasPipe).toBe(false)
    expect(fallback.send).not.toHaveBeenCalled()
  })

  it('pending cloud permissions are restored once and only allow or deny answers go through the narrow permission API', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    const onOutput = vi.fn()
    Object.assign(mgr, { _sid: 'sid-1', _onOutput: onOutput })
    const pendingCtrl = { reqId: 'req-1', toolName: 'AskUserQuestion', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [] } } }
    fallback.connect.mockResolvedValueOnce({ ok: true, alive: true, pendingCtrl })
    fallback.send.mockResolvedValueOnce({ ok: true })
    await mgr.writeMessage('hello', { uuid: 'u-1', markers })
    expect(onOutput).toHaveBeenCalledOnce()
    expect(JSON.parse(onOutput.mock.calls[0][0].line)).toEqual({ type: 'control_request', request_id: 'req-1', request: pendingCtrl.request })
    await expect(mgr.writeRaw(JSON.stringify({ type: 'control_request', request_id: 'settings', request: { subtype: 'get_settings' } }))).resolves.toBe(false)
    expect(fallback.permission).not.toHaveBeenCalled()
    await expect(mgr.writeRaw(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: { command: 'ignored', answers: { Question: 'Yes' } } } } }))).resolves.toBe(true)
    expect(fallback.permission).toHaveBeenCalledExactlyOnceWith({ host: 'remote-box', sessionId: 'sid-1', requestId: 'req-1', allow: true, answers: { Question: 'Yes' } })
  })

  it('arbitrary rewritten tool input is not sent through cloud permission answers', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    fallback.connect.mockResolvedValueOnce({ ok: true, alive: true, pendingCtrl: { reqId: 'req-1', toolName: 'Bash', request: { subtype: 'can_use_tool', tool_name: 'Bash' } } })
    fallback.send.mockResolvedValueOnce({ ok: true })
    await mgr.writeMessage('hello', { uuid: 'u-1', markers })
    await expect(mgr.writeRaw(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: { command: 'ignored', answers: { Question: 'ignored' } } } } }))).resolves.toBe(true)
    expect(fallback.permission).toHaveBeenCalledExactlyOnceWith({ host: 'remote-box', sessionId: 'sid-1', requestId: 'req-1', allow: true })
  })

  it('a cloud rewrite whose answer was lost is confirmed without repeating lostPid, including after native recovery', async () => {
    const { conn, sent } = fakeConn([{ ok: true, duplicate: true, fate: 'waiting' }], ['send-markers-v1', 'send-dedupe-v1', 'send-lost-line-v1'])
    conn.connected = false
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { conn, _sid: 'sid-1' })
    fallback.send.mockRejectedValueOnce(new SendOutcomeUnknownError('cloud answer lost'))
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, dedupe: true, lostPid: 77 })).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    fallback.send.mockResolvedValueOnce({ ok: true, duplicate: true, fate: 'waiting' })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, dedupe: true, lostPid: 77 })).resolves.toBe(true)
    expect(fallback.send.mock.calls[0][0].lostPid).toBe(77)
    expect(fallback.send.mock.calls[1][0]).not.toHaveProperty('lostPid')
    conn.connected = true
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, dedupe: true, lostPid: 77 })).resolves.toBe(true)
    expect(sent[0].payload).not.toHaveProperty('lostPid')
  })

  it('a cloud rewrite proven not sent retains its rewrite eligibility', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, lostPid: 77 })).rejects.toBeInstanceOf(SendHeldError)
    fallback.send.mockResolvedValueOnce({ ok: true })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, lostPid: 77 })).resolves.toBe(true)
    expect(fallback.send.mock.calls.map((call) => call[0].lostPid)).toEqual([77, 77])
  })

  it('a late success for permission A keeps the newer pending permission B', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    fallback.connect.mockResolvedValueOnce({ ok: true, alive: true, pendingCtrl: { reqId: 'req-a', toolName: 'Bash', request: { subtype: 'can_use_tool', tool_name: 'Bash' } } })
    fallback.send.mockResolvedValueOnce({ ok: true })
    await mgr.writeMessage('hello', { uuid: 'u-1', markers })
    let resolve!: (reply: Record<string, unknown>) => void
    fallback.permission.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const answer = (id: string) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'allow' } } })
    const first = mgr.writeRaw(answer('req-a'))
    await vi.waitFor(() => expect(fallback.permission).toHaveBeenCalledOnce())
    fallback.links[0].emit({ ev: 'jsonl', sid: 'sid-1', v: 100, line: JSON.stringify({ type: 'control_request', request_id: 'req-b', request: { subtype: 'can_use_tool', tool_name: 'Bash' } }) })
    resolve({ ok: true })
    await expect(first).resolves.toBe(true)
    await expect(mgr.writeRaw(answer('req-b'))).resolves.toBe(true)
    expect(fallback.permission.mock.calls.map((call) => call[0].requestId)).toEqual(['req-a', 'req-b'])
  })

  it('a cached cloud attachment cannot restore an already answered prompt on a later send', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    const onOutput = vi.fn()
    Object.assign(mgr, { _sid: 'sid-1', _onOutput: onOutput })
    fallback.connect.mockResolvedValueOnce({ ok: true, alive: true, pendingCtrl: { reqId: 'req-a', toolName: 'Bash', request: { subtype: 'can_use_tool', tool_name: 'Bash' } } })
    fallback.send.mockResolvedValue({ ok: true })
    await mgr.writeMessage('first', { uuid: 'u-1', markers })
    await mgr.writeRaw(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req-a', response: { behavior: 'allow' } } }))
    await mgr.writeMessage('second', { uuid: 'u-2', markers })
    expect(fallback.connect).toHaveBeenCalledOnce()
    expect(onOutput).toHaveBeenCalledOnce()
  })

  it('a live scoped cloud stream overrides an old native disconnect without changing the process identity', async () => {
    const { conn } = fakeConn([{ ok: true, alive: true }])
    conn.connected = false
    Object.assign(conn, { disconnectedSince: Date.now() - 10 * 60_000 })
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { conn, _sid: 'sid-1', _pid: 77 })
    fallback.connect.mockResolvedValueOnce({ ok: true, alive: true, pid: 77 })
    fallback.send.mockResolvedValueOnce({ ok: true })
    await mgr.writeMessage('hello', { uuid: 'u-1', markers })
    await expect(mgr.isAlive()).resolves.toBe(true)
    expect(mgr.pid).toBe(77)
    conn.connected = true
    await expect(mgr.isAlive()).resolves.toBe(true)
    expect(fallback.links[0].close).toHaveBeenCalledOnce()
    expect(mgr.pid).toBe(77)
  })

  it('a dead rediscovered process on an old daemon is checked again even without dedupe support', async () => {
    const { conn, sent } = fakeConn([
      { ok: false, reason: 'not_found' }, { ok: true, alive: false, state: 'dead' },
      { ok: false, reason: 'session_dead', exitCode: 0 },
    ], ['send-markers-v1'])
    await expect(manager(conn).writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(false)
    expect(sent.map((call) => call.cmd)).toEqual(['send', 'attach', 'send'])
    expect(sent[2].payload.uuid).toBe('u-1')
  })

  it('a new read-past proof for the same pid and uuid permits one more cloud rewrite', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    fallback.send.mockRejectedValueOnce(new SendOutcomeUnknownError('first rewrite answer lost'))
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, lostPid: 77, lostGeneration: 1 })).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    fallback.send.mockResolvedValue({ ok: true, duplicate: true, fate: 'waiting' })
    await mgr.writeMessage('hello', { uuid: 'u-1', markers, lostPid: 77, lostGeneration: 1 })
    await mgr.writeMessage('hello', { uuid: 'u-1', markers, lostPid: 77, lostGeneration: 2 })
    await mgr.writeMessage('hello', { uuid: 'u-1', markers, lostPid: 77, lostGeneration: 2 })
    expect(fallback.send.mock.calls.map((call) => call[0].lostPid)).toEqual([77, undefined, 77, undefined])
    expect(fallback.send.mock.calls.every((call) => !('lostGeneration' in call[0]))).toBe(true)
  })

  it.each(['not_found', 'not found', 'identity_mismatch', 'EAGAIN'])('a raw %s refusal never clears the live pipe or reports exit', async (reason) => {
    const { conn } = fakeConn([{ ok: false, reason }])
    const mgr = manager(conn)
    const onExit = vi.fn()
    Object.assign(mgr, { _hasPipe: true, _onExit: onExit })
    await expect(mgr.writeRaw('{}')).resolves.toBe(false)
    expect(mgr.hasPipe).toBe(true)
    expect(onExit).not.toHaveBeenCalled()
  })

  it('a native prompt can establish its first cloud link when the answer follows a native disconnect', async () => {
    const { conn } = fakeConn([])
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { conn, _sid: 'sid-1' })
    ;(mgr as unknown as { handleDaemonEvent(event: Record<string, unknown>): void }).handleDaemonEvent({
      ev: 'jsonl', sid: 'sid-1', v: 10, line: JSON.stringify({ type: 'control_request', request_id: 'req-a', request: { subtype: 'can_use_tool', tool_name: 'Bash' } }),
    })
    conn.connected = false
    await expect(mgr.writeRaw(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req-a', response: { behavior: 'allow' } } }))).resolves.toBe(true)
    expect(fallback.connect).toHaveBeenCalledOnce()
    expect(fallback.permission).toHaveBeenCalledExactlyOnceWith({ host: 'remote-box', sessionId: 'sid-1', requestId: 'req-a', allow: true })
  })

  it('an acknowledged permission retry for A can reach daemon dedupe after newer B arrives', async () => {
    const mgr = new RemoteSessionManager('sid-1', 'remote-box', null)
    Object.assign(mgr, { _sid: 'sid-1' })
    fallback.connect.mockResolvedValueOnce({ ok: true, alive: true, pendingCtrl: { reqId: 'req-a', toolName: 'Bash', request: { subtype: 'can_use_tool', tool_name: 'Bash' } } })
    fallback.send.mockResolvedValueOnce({ ok: true })
    await mgr.writeMessage('hello', { uuid: 'u-1', markers })
    const answer = (id: string) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'allow' } } })
    fallback.permission.mockRejectedValueOnce(new SendOutcomeUnknownError('A answer lost'))
    await expect(mgr.writeRaw(answer('req-a'))).resolves.toBe(false)
    fallback.links[0].emit({ ev: 'jsonl', sid: 'sid-1', v: 10, line: JSON.stringify({ type: 'control_request', request_id: 'req-b', request: { subtype: 'can_use_tool', tool_name: 'Bash' } }) })
    await expect(mgr.writeRaw(answer('req-a'))).resolves.toBe(true)
    await expect(mgr.writeRaw(answer('req-b'))).resolves.toBe(true)
    expect(fallback.permission.mock.calls.map((call) => call[0].requestId)).toEqual(['req-a', 'req-a', 'req-b'])
  })

  it('asks again with dedupe and reports what the daemon knows of the line', async () => {
    const { conn, sent } = fakeConn([timeout(), { ok: true, duplicate: true, fate: 'waiting' }])
    const mgr = manager(conn)
    const fates: unknown[] = []
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers, onFate: (f) => fates.push(f) })).resolves.toBe(true)
    expect(sent.map((s) => s.cmd)).toEqual(['send', 'send'])
    expect(sent[0].payload.dedupe).toBeUndefined()
    // The SAME line: same uuid, same markers, now with dedupe.
    expect(sent[1].payload).toMatchObject({ sid: 'sid-1', message: 'hello', uuid: 'u-1', markers, dedupe: true })
    expect(fates).toEqual([{ fate: 'waiting' }])
    // Never a stop: the CLI is usually alive and already answering the line.
    expect(sent.some((s) => s.cmd === 'stop')).toBe(false)
  })

  it('each confirm attempt has a short timeout of its own, so a reachable daemon answers in seconds', async () => {
    const { conn } = fakeConn([timeout(), { ok: true, duplicate: true, fate: 'ran', state: 'started' }])
    const fates: unknown[] = []
    await expect(manager(conn).writeMessage('hello', { uuid: 'u-1', markers, onFate: (f) => fates.push(f) })).resolves.toBe(true)
    expect(conn.send.mock.calls[1][2]).toBe(RemoteSessionManager.SEND_CONFIRM_ATTEMPT_MS)
    expect(RemoteSessionManager.SEND_CONFIRM_ATTEMPT_MS).toBeLessThanOrEqual(10_000)
    expect(RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS).toBeLessThanOrEqual(60_000)
    expect(fates).toEqual([{ fate: 'ran', state: 'started' }])
  })

  it('G5: a Stop ends the confirm at once (the stopped line is never delivered after it)', async () => {
    let stopped = false
    const { conn, sent } = fakeConn([timeout(), timeout(), timeout(), timeout(), timeout()])
    const t0 = Date.now()
    const run = manager(conn).writeMessage('hello', { uuid: 'u-1', markers, isStopped: () => stopped })
    setTimeout(() => { stopped = true }, 300)
    await expect(run).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(sent.length).toBeLessThanOrEqual(2)
  })

  it('G4: a line queued behind the one being confirmed is told it waits, then is held, not written', async () => {
    RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS = 1_500
    const { conn, sent } = fakeConn([timeout(), timeout(), timeout(), timeout()])
    const mgr = manager(conn)
    const held: string[] = []
    const first = mgr.writeMessage('one', { uuid: 'u-1', markers: [{ message: 'one', messageId: 'qm-1' }] })
    const second = mgr.writeMessage('two', { uuid: 'u-2', markers: [{ message: 'two', messageId: 'qm-2' }], onHeld: () => held.push('two') })
    await expect(first).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    await expect(second).rejects.toBeInstanceOf(SendHeldError)
    expect(held).toEqual(['two'])
    // Order kept: 'two' never reached the daemon ahead of (or instead of) 'one'.
    expect(sent.every((s) => s.payload.message === 'one')).toBe(true)
    // A line sent after that goes out normally.
    conn.send.mockImplementationOnce(async (cmd: string, payload: Record<string, unknown>) => { sent.push({ cmd, payload }); return { ok: true } })
    await expect(mgr.writeMessage('three', { uuid: 'u-3', markers: [{ message: 'three', messageId: 'qm-3' }] })).resolves.toBe(true)
  })

  it('a socket that closed with the send pending is asked about the same way', async () => {
    const { conn, sent } = fakeConn([new Error('connection closed'), { ok: true }])
    await expect(manager(conn).writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(true)
    expect(sent[1].payload.dedupe).toBe(true)
  })

  it('r5 F1: a resend written behind a cut copy of the line tells the caller (onCut) before it resolves', async () => {
    const { conn, sent } = fakeConn([new Error('connection closed'), { ok: true, cut: true }])
    const order: string[] = []
    const run = manager(conn).writeMessage('hello', { uuid: 'u-1', markers, onCut: () => order.push('cut') })
    await expect(run.then((ok) => { order.push('resolved'); return ok })).resolves.toBe(true)
    expect(sent[1].payload.dedupe).toBe(true)
    expect(order).toEqual(['cut', 'resolved'])
  })

  it('r5 F1: a plain ok, or a duplicate, never reports a cut', async () => {
    for (const reply of [{ ok: true }, { ok: true, duplicate: true, fate: 'waiting' }]) {
      const { conn } = fakeConn([new Error('connection closed'), reply])
      const onCut = vi.fn()
      await expect(manager(conn).writeMessage('hello', { uuid: 'u-1', markers, onCut })).resolves.toBe(true)
      expect(onCut).not.toHaveBeenCalled()
    }
  })

  it('keeps asking through more silence, then gives up with SendOutcomeUnknownError, never false', async () => {
    RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS = 1_500
    const { conn, sent } = fakeConn([timeout(), timeout(), timeout(), timeout()])
    await expect(manager(conn).writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(sent.slice(1).every((s) => s.payload.dedupe === true)).toBe(true)
  })

  it('a daemon that cannot dedupe is not asked again: the outcome is reported unknown', async () => {
    const { conn, sent } = fakeConn([timeout()], ['send-markers-v1'])
    await expect(manager(conn).writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    expect(sent).toHaveLength(1)
  })

  it('a budget refusal never falls back to a fresh process or fires a process exit', async () => {
    const { conn, sent } = fakeConn([{ ok: false, reason: 'budget_paused' }]);
    const mgr = manager(conn);
    const onExit = vi.fn(); Object.assign(mgr as unknown as Record<string, unknown>, { _onExit: onExit, _hasPipe: true });
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(BudgetPausedError);
    expect(sent.map(row => row.cmd)).toEqual(['send']);
    expect(onExit).not.toHaveBeenCalled();
  });
  it.each(['not_found', 'not found', 'identity_mismatch', 'not_owned', 'EAGAIN', 'unknown_refusal'])('holds a %s refusal without declaring the process dead', async (reason) => {
    const { conn, sent } = fakeConn([{ ok: false, reason }])
    const mgr = manager(conn)
    const onExit = vi.fn()
    Object.assign(mgr, { _hasPipe: true, _onExit: onExit })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).rejects.toBeInstanceOf(SendHeldError)
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
    expect(sent.map((s) => s.cmd)).toEqual(reason === 'not_found' || reason === 'not found' ? ['send', 'attach'] : ['send'])
  })

  it.each(['ENXIO', 'partial_write', 'partial write'])('retains cold recovery for the terminal %s verdict', async (reason) => {
    const { conn } = fakeConn([{ ok: false, reason }])
    const mgr = manager(conn)
    const onExit = vi.fn()
    Object.assign(mgr, { _hasPipe: true, _onExit: onExit })
    await expect(mgr.writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(false)
    expect(onExit).toHaveBeenCalledExactlyOnceWith(1)
    expect(mgr.hasPipe).toBe(false)
  })

  it('a later line waits for the unanswered one: lines reach the daemon in order', async () => {
    const { conn, sent } = fakeConn([timeout(), { ok: true, duplicate: true }, { ok: true }])
    const mgr = manager(conn)
    const first = mgr.writeMessage('one', { uuid: 'u-1', markers: [{ message: 'one', messageId: 'qm-1' }] })
    const second = mgr.writeMessage('two', { uuid: 'u-2', markers: [{ message: 'two', messageId: 'qm-2' }] })
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(sent.map((s) => s.payload.message)).toEqual(['one', 'one', 'two'])
  })

  it('a caller resending a line that went out before sends dedupe on the first try', async () => {
    const { conn, sent } = fakeConn([{ ok: true, duplicate: true, fate: 'dropped', state: 'discarded' }])
    const fates: unknown[] = []
    await expect(manager(conn).writeMessage('hello', { uuid: 'u-1', markers, dedupe: true, onFate: (f) => fates.push(f) })).resolves.toBe(true)
    expect(sent[0].payload.dedupe).toBe(true)
    // 'discarded' is reported as it is, never as taken.
    expect(fates).toEqual([{ fate: 'dropped', state: 'discarded' }])
  })

  it('a rewrite of a lost line carries lostPid once; asking whether THAT write landed never does', async () => {
    const caps = ['send-markers-v1', 'send-dedupe-v1', 'send-lost-line-v1']
    const { conn, sent } = fakeConn([timeout(), { ok: true, duplicate: true, fate: 'waiting' }], caps)
    await expect(manager(conn).writeMessage('hello', { uuid: 'u-1', markers, dedupe: true, lostPid: 77 })).resolves.toBe(true)
    expect(sent[0].payload).toMatchObject({ dedupe: true, lostPid: 77 })
    // A lostPid here would set aside the record of the rewrite just made and write a third copy.
    expect(sent[1].payload.dedupe).toBe(true)
    expect(sent[1].payload.lostPid).toBeUndefined()
  })
})
