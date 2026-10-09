/**
 * Order while a lost send settles (matrix D1 2026-10-05). Both delivery paths
 * reach the CLI through RemoteSessionManager.writeMessage (injectMidTurn for a
 * mid-turn line, processNext for the stdin path). A line whose link closed
 * hears it at once (a closed socket fails every command still waiting on it,
 * daemon-connection.ts failPendingOn) and confirmSend asks the daemon again; a
 * later line must not go first meanwhile: not by its own send, and not by
 * reading the link as down and answering "not delivered" (which sends
 * processNext to stop and respawn the CLI around it). A daemon without
 * send-dedupe-v1 keeps the plain send and its own timer.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { sessionStops } from '../../src/core/sessions/session-stop.js'
import { SendOutcomeUnknownError } from '../../src/providers/delivery-failure.js'

type Sent = { cmd: string; params: Record<string, unknown>; args: number }

function fakeConn(o: { caps: string[]; loseFirst?: boolean; relinkMs?: number; timeoutFirst?: boolean }) {
  const sent: Sent[] = []
  let connected = true
  let instance = 'd-old'
  let first = true
  const conn = {
    get connected() { return connected },
    get daemonInstanceId() { return instance },
    hasCapability: (c: string) => o.caps.includes(c),
    async send(cmd: string, params: Record<string, unknown> = {}, ...rest: unknown[]) {
      sent.push({ cmd, params, args: 2 + rest.length })
      if (cmd === 'send' && first) {
        first = false
        if (o.timeoutFirst) throw new Error('daemon command timeout: send (30000ms)')
        if (o.loseFirst) {
          connected = false
          setTimeout(() => { connected = true; instance = 'd-new' }, o.relinkMs ?? 300)
          // What DaemonConnection.failPendingOn rejects with when the socket goes.
          throw new Error('daemon command lost: send: connection closed before __local__ answered [traceId=t1]')
        }
      }
      return { ok: true }
    },
  }
  return { conn, sent, lines: () => sent.filter((s) => s.cmd === 'send').map((s) => s.params.message) }
}

function manager(conn: unknown): RemoteSessionManager {
  const m = new RemoteSessionManager('sid-order', '__local__', null)
  Object.assign(m, { conn, _sid: 'sid-order', _hasPipe: true })
  return m
}

const marked = (text: string, id: string) => ({ markers: [{ message: text, messageId: id }], stopFence: null })

describe('RemoteSessionManager: a later line waits for a settling one', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a line written while the first one settles goes after it, and is not answered "not delivered"', async () => {
    vi.spyOn(sessionStops, 'fence').mockResolvedValue(null)
    const f = fakeConn({ caps: ['send-markers-v1', 'send-dedupe-v1', 'cron-supervision-v1'], loseFirst: true })
    const m = manager(f.conn)
    const settled: string[] = []
    const a = m.writeMessage('first', marked('first', 'qm-1')).then((ok) => { settled.push('first'); return ok })
    await new Promise((r) => setTimeout(r, 50))
    expect(f.conn.connected).toBe(false)
    // The link is down now: without the wait this answered false at once.
    const b = m.writeMessage('second', marked('second', 'qm-2')).then((ok) => { settled.push('second'); return ok })
    await expect(a).resolves.toBe(true)
    await expect(b).resolves.toBe(true)
    expect(settled).toEqual(['first', 'second'])
    expect(f.lines()).toEqual(['first', 'first', 'second'])
    // The first send is the plain one; its second copy is the same line with dedupe.
    const sends = f.sent.filter((s) => s.cmd === 'send')
    expect(sends[0].args).toBe(2)
    expect(sends[1].params).toMatchObject({ message: 'first', dedupe: true })
    expect(sends[2].params).not.toHaveProperty('dedupe')
  })

  it('a daemon without send-dedupe-v1: the plain send on its own timer, never sent again', async () => {
    vi.spyOn(sessionStops, 'fence').mockResolvedValue(null)
    const f = fakeConn({ caps: ['send-markers-v1', 'cron-supervision-v1'], timeoutFirst: true })
    const m = manager(f.conn)
    // The answer never came and nothing can ask about the line: outcome unknown (runner r3), not a resend.
    await expect(m.writeMessage('first', marked('first', 'qm-1'))).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]).toMatchObject({ cmd: 'send', args: 2 })
    expect(f.sent[0].params).toEqual({ sid: 'sid-order', message: 'first', stopFence: null, markers: [{ message: 'first', messageId: 'qm-1' }] })
  })

  it('a line without markers: the plain send even on a daemon that has send-dedupe-v1', async () => {
    const f = fakeConn({ caps: ['send-markers-v1', 'send-dedupe-v1'] })
    const m = manager(f.conn)
    await expect(m.writeMessage('hello')).resolves.toBe(true)
    expect(f.sent).toEqual([{ cmd: 'send', params: { sid: 'sid-order', message: 'hello' }, args: 2 }])
  })
})
