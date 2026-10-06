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
import { describe, it, expect, afterEach, vi } from 'vitest'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { SendHeldError, SendOutcomeUnknownError } from '../../src/providers/delivery-failure.js'

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
  afterEach(() => { RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS = deadline })

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

  it('a refusal is still a refusal (false): the process is gone and the caller may respawn', async () => {
    const { conn } = fakeConn([{ ok: false, reason: 'not_found' }])
    await expect(manager(conn).writeMessage('hello', { uuid: 'u-1', markers })).resolves.toBe(false)
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
