/**
 * A person's own `/ws` socket runs the methods registered with `personCall` as a person's own call
 * (src/web/ws/handler.ts, core/session-channel/person-call.ts), read from its upgrade by the rule a
 * person's `/api` request is read by (web/routes/person-caller.ts isPersonCaller), so the in-app
 * terminal opens on a revoked host for its person as revoked-reach.ts promises (review round 1, S3).
 * A session's socket, the CLI's, a browser under automation's, another method, and work that
 * outlives the call never carry the mark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { attachWss, closeWss, registerMethod, rpcRunsAsPerson } from '../../../src/web/ws/handler.js'
import { inPersonCall } from '../../../src/core/session-channel/person-call.js'
import type { WsFrame } from '../../../src/web/ws/protocol.js'

let server: HttpServer
let port = 0
let later: Promise<boolean> | null = null

beforeAll(async () => {
  server = createServer()
  attachWss(server)
  registerMethod('test:person-probe', async () => {
    await Promise.resolve()
    // Work the call leaves behind (a stream's later frames): read once the call has answered.
    later = new Promise((r) => setTimeout(() => r(inPersonCall()), 20))
    return { person: inPersonCall() }
  }, { personCall: true })
  registerMethod('test:plain-probe', async () => ({ person: inPersonCall() }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { const a = server.address(); port = typeof a === 'object' && a ? a.port : 0; r() }))
})
afterAll(async () => {
  closeWss()
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())))
})

async function call(method: string, headers: Record<string, string> = {}): Promise<boolean> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j) })
  try {
    const id = `req-${Math.random().toString(36).slice(2)}`
    const answer = new Promise<WsFrame>((r) => ws.on('message', (d) => { const f = JSON.parse(d.toString()) as WsFrame; if (f.type === 'res' && f.id === id) r(f) }))
    ws.send(JSON.stringify({ type: 'req', id, method, payload: {} }))
    const f = await answer as WsFrame & { ok?: boolean; payload?: { person?: boolean } }
    expect(f.ok, JSON.stringify(f)).toBe(true)
    return f.payload?.person === true
  } finally {
    ws.close()
  }
}

describe('a person\'s own /ws socket', () => {
  it('runs a personCall method as a person\'s own call, and only while the call runs', async () => {
    expect(await call('test:person-probe')).toBe(true)
    expect(await later).toBe(false)
  })

  it('never for another method', async () => {
    expect(await call('test:plain-probe')).toBe(false)
  })

  it('never for a session\'s socket, the CLI\'s, or a browser under automation\'s', async () => {
    expect(await call('test:person-probe', { 'x-walnut-caller-sid': 'a-session' })).toBe(false)
    expect(await call('test:person-probe', { 'x-walnut-caller-kind': 'agent' })).toBe(false)
    expect(await call('test:person-probe', { 'user-agent': 'Mozilla/5.0 HeadlessChrome/120.0' })).toBe(false)
  })

  it('the in-app terminal\'s open is such a method', async () => {
    const { registerTerminalRpc } = await import('../../../src/web/terminal/register.js')
    if (await registerTerminalRpc()) expect(rpcRunsAsPerson('terminal:open')).toBe(true)
    else {
      // No pty here: the registration is read from the source instead.
      const src = await import('node:fs/promises').then((f) => f.readFile(new URL('../../../src/web/terminal/register.ts', import.meta.url), 'utf8'))
      expect(src).toMatch(/registerMethod\('terminal:open'[\s\S]*?\n  \}, \{ personCall: true \}\)/)
    }
    expect(rpcRunsAsPerson('terminal:input')).toBe(false)
  })
})
