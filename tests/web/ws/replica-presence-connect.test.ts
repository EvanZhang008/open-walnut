/**
 * A host replica's own /ws tells each new socket whether the Mac answers
 * (docs/plan/walnut-replica-servers-impl.md, WP7: `replica:presence` on connect
 * and on change). A console the replica just moved here with 4001 learns at
 * once that the Mac is away and whose copy it reads, before any other frame.
 * On every other server (the Mac, the companion) nothing is set and a new
 * socket gets no frame of it: their behaviour stays byte-identical.
 *
 * The real handler (attachWss) on a real HTTP server; real `ws` clients.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { attachWss, closeWss, setConnectEvent, broadcastEvent } from '../../../src/web/ws/handler.js'

let server: HttpServer
let port: number
const open: WebSocket[] = []

/** A client and every frame it gets, from the first one on. */
function client(): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const frames: Array<Record<string, unknown>> = []
    // Listening before `open`: a frame sent at connect is never missed.
    ws.on('message', (d) => frames.push(JSON.parse(String(d)) as Record<string, unknown>))
    open.push(ws)
    ws.on('open', () => resolve({ ws, frames }))
    ws.on('error', reject)
  })
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  server = createServer()
  attachWss(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as { port: number }).port
})

afterEach(() => {
  setConnectEvent(null)
  for (const ws of open.splice(0)) ws.terminate()
})

afterAll(async () => {
  closeWss()
  await new Promise<void>((r) => server.close(() => r()))
})

describe('replica:presence on connect', () => {
  it('a server that sets nothing (the Mac, the companion) sends no frame at connect', async () => {
    const { frames } = await client()
    await settle()
    expect(frames).toEqual([])
  })

  it('a host replica sends its presence as the first frame of every new socket', async () => {
    const presence = { answers: false, asOf: 1_800_000_000_000, host: 'devbox', hostKey: 'devbox', why: 'quiet' }
    setConnectEvent(() => ({ name: 'replica:presence', data: presence }))
    const a = await client()
    const b = await client()
    await settle()
    for (const c of [a, b]) {
      expect(c.frames[0]).toEqual({ type: 'event', name: 'replica:presence', data: presence, seq: 1 })
      expect(c.frames).toHaveLength(1)
    }
    // A later broadcast follows it, in order.
    broadcastEvent('replica:presence', { ...presence, answers: true, why: 'answers' })
    await settle()
    expect(a.frames.map((f) => (f.data as { answers: boolean }).answers)).toEqual([false, true])
    expect(a.frames[1]!.seq).toBe(2)
  })

  it('the event is read at each connect, so a socket gets the presence of that moment', async () => {
    let answers = false
    setConnectEvent(() => ({ name: 'replica:presence', data: { answers } }))
    const first = await client()
    answers = true
    const second = await client()
    await settle()
    expect((first.frames[0]!.data as { answers: boolean }).answers).toBe(false)
    expect((second.frames[0]!.data as { answers: boolean }).answers).toBe(true)
  })

  it('no event (null) or a source that throws: no frame, and the socket stays open', async () => {
    setConnectEvent(() => null)
    const quiet = await client()
    setConnectEvent(() => { throw new Error('front stopped') })
    const failing = await client()
    await settle()
    expect(quiet.frames).toEqual([])
    expect(failing.frames).toEqual([])
    expect(failing.ws.readyState).toBe(WebSocket.OPEN)
  })
})
