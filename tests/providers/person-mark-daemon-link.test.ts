/**
 * A daemon link dialed inside a person's request never acts as that person (R3-S1 of the C7 revoke
 * review; core/session-channel/person-call.ts).
 *
 * The person clicks Connect now, or a route's read dials a host that was not linked yet: the link's
 * socket is made inside that request. On a revoked host only a person's own call may send a command
 * that runs a process there or hands it data (`exec.run`, an allowing `sendRaw`, a stream's opening).
 * So the link's own events, its reconnects and its streams must never carry the request's mark:
 * while the request still runs, and after it ended. A real DaemonConnection on a real ws socket to a
 * small daemon here; every wait is on the frame or the callback itself, never a clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type net from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-person-mark-daemon-link'))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { gateSessionCommand } from '../../src/providers/ephemeral-session-gate.js'
import { asPersonCall, inPersonCall, markPersonRequest } from '../../src/core/session-channel/person-call.js'
import { HostRevokedError, setRevokedHosts } from '../../src/core/session-channel/revoked-hosts.js'

const HOST = 'devbox'
const ALLOW = { sid: 's-1', raw: JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow' } } }) }

let wss: WebSocketServer
let url = ''
const clients: WebSocket[] = []
/** Every command frame the daemon got, by name. */
const got: string[] = []
let heard: (cmd: string) => void = () => {}

beforeEach(async () => {
  got.length = 0
  clients.length = 0
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  wss.on('connection', (ws: WebSocket) => {
    clients.push(ws)
    ws.on('message', (raw) => {
      let frame: { id?: number; cmd?: string }
      try { frame = JSON.parse(raw.toString()) } catch { return }
      if (frame.cmd) { got.push(frame.cmd); heard(frame.cmd) }
      // stream.open is a stream frame (no id): no answer, the test only reads that it arrived.
      if (typeof frame.id === 'number') ws.send(JSON.stringify({ id: frame.id, ok: true }))
    })
  })
  await new Promise<void>((r) => wss.on('listening', () => r()))
  url = `ws://127.0.0.1:${(wss.address() as net.AddressInfo).port}`
})

afterEach(async () => {
  setRevokedHosts([])
  await new Promise<void>((r) => wss.close(() => r()))
})

/** What the link's own event handler manages to send: each person-only command, sent or refused. */
async function handlerSends(conn: DaemonConnection): Promise<string[]> {
  const out: string[] = []
  await new Promise<void>((resolve) => {
    const off = conn.onEvent(() => {
      off()
      void (async () => {
        for (const [cmd, params] of [['exec.run', { command: 'true' }], ['sendRaw', ALLOW]] as const) {
          try { await conn.send(cmd, params); out.push(`${cmd}: sent`) } catch (err) { out.push(`${cmd}: ${err instanceof HostRevokedError ? 'refused' : String(err)}`) }
        }
        resolve()
      })()
    })
    for (const c of clients) c.send(JSON.stringify({ ev: 'session_state', sid: 's-1', state: 'running' }))
  })
  return out
}

describe('a daemon link dialed inside a person\'s request', () => {
  it('its events send nothing only a person may, during the request and after it, once the host is revoked', async () => {
    const conn = new DaemonConnection(HOST, null)
    const res = new EventEmitter()
    try {
      const during = await new Promise<{ own: string; link: string[] }>((resolve, reject) => {
        markPersonRequest(res, () => {
          void (async () => {
            await conn.connectDirect(url)
            setRevokedHosts([HOST])
            // The person's own call still runs as the person: its exec.run goes.
            await conn.send('exec.run', { command: 'true' })
            const own = inPersonCall() ? 'person' : 'not a person'
            // The link's event arrives while the request is still open.
            resolve({ own, link: await handlerSends(conn) })
          })().catch(reject)
        })
      })
      // The request ends; the link lives on.
      res.emit('finish')
      const after = await handlerSends(conn)
      // Both phases read together: the dial outside the mark covers the first, the mark's end the second.
      expect({ own: during.own, during: during.link, after }).toEqual({
        own: 'person', during: ['exec.run: refused', 'sendRaw: refused'], after: ['exec.run: refused', 'sendRaw: refused'],
      })
      expect(got.filter((c) => c === 'exec.run' || c === 'sendRaw')).toEqual(['exec.run'])
    } finally { conn.disconnect() }
  })

  it('a reconnect asked for inside a person\'s request runs outside the mark', async () => {
    const conn = new DaemonConnection(HOST, null)
    setRevokedHosts([HOST])
    let attempt!: (v: string) => void
    const ran = new Promise<string>((r) => { attempt = r })
    // The attempt's own dial is stood in for: what matters is the context the reconnect timer runs
    // it in, which every socket, process and timer of the new link inherits.
    Object.assign(conn as unknown as Record<string, unknown>, {
      reconnect: async () => {
        // The command gate every frame to the host passes (DaemonConnection.send).
        try { gateSessionCommand({ host: HOST }, 'exec.run', {}, false); attempt('sent') } catch (err) { attempt(err instanceof HostRevokedError ? 'refused' : String(err)) }
      },
    })
    const res = new EventEmitter()
    try {
      markPersonRequest(res, () => {
        // A wake or a person's Connect now while the loop waits: the timer is made here, in the request.
        ;(conn as unknown as { scheduleReconnect(ms: number): void }).scheduleReconnect(0)
      })
      // The request is still open when the attempt runs: it must not be the person.
      expect(await ran).toBe('refused')
    } finally { res.emit('finish'); conn.disconnect() }
  })

  it('a stream\'s opening on it (a port, a terminal) goes only for a person\'s own call', async () => {
    const conn = new DaemonConnection(HOST, null)
    try {
      await conn.connectDirect(url)
      setRevokedHosts([HOST])
      const endpoint = (conn as unknown as { streamEndpoint(): { openPort(port: number, host: string): Promise<unknown> } }).streamEndpoint()
      await expect(endpoint.openPort(8080, '127.0.0.1')).rejects.toThrow(/stream\.open refused: there only a person's own call runs it/)
      expect(got).not.toContain('stream.open')
      const arrived = new Promise<void>((r) => { heard = (cmd) => { if (cmd === 'stream.open') r() } })
      const opening = asPersonCall(() => endpoint.openPort(8080, '127.0.0.1'))
      opening.catch(() => { /* ended with the link below */ })
      await arrived
      expect(got.filter((c) => c === 'stream.open')).toHaveLength(1)
    } finally { heard = () => {}; conn.disconnect() }
  })
})
