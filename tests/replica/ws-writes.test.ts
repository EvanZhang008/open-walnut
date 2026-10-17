/**
 * The WebSocket RPC away write of a host replica (src/replica/ws-writes.ts, plan
 * section 3 "WebSocket RPC writes", WP10): a console on this replica's own /ws sends
 * `session:send` to a session that runs on this host while the Mac is away.
 *
 * Real pieces end to end: the real /ws handler (src/web/ws/handler.ts attachWss, the
 * replica's setRpcAnswer seam) on a loopback server, the real wsWrites answer, the
 * real write port and overlay, and linkWrite over the REAL offline host and journal
 * v2 (offline-host-core.ts deliverHuman, the core of the twins' follower.send), its
 * delivery recorded where the daemon would write the CLI's stdin.
 *
 * Pinned: the frame's op id names the message (`qm-<opId>`), so a page that sends the
 * frame again, or a lost answer asked again under the same id, reaches the session
 * once; the answer is the HTTP twin's shape; a Mac session, pictures and an empty
 * message are refused with the words the console reads; an RPC no away row journals
 * goes on to the usual path.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { attachWss, closeWss, setRpcAnswer } from '../../src/web/ws/handler.js'
import type { WsFrame } from '../../src/web/ws/protocol.js'
import { JHOME, SID_A, SID_B, journalTmpDir, cleanupJournalDirs, journalHost, jslice, journalLines } from '../helpers/offline-journal-harness.js'
import { createOverlay } from '../../src/replica/overlay.js'
import { createWritePort, type TaskRow } from '../../src/replica/write-port.js'
import { wsWrites } from '../../src/replica/ws-writes.js'

const T0 = Date.parse('2026-10-14T12:00:00Z')

let server: HttpServer
let port = 0
const open: WebSocket[] = []

beforeAll(async () => {
  server = createServer()
  attachWss(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  setRpcAnswer(null)
  closeWss()
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

afterEach(async () => {
  setRpcAnswer(null)
  while (open.length) open.pop()?.close()
  cleanupJournalDirs()
  await new Promise((r) => setTimeout(r, 20))
})

/** A replica's away wiring for /ws (away-wiring.ts), over a real offline host. `lose`: which follower calls lose their answer. */
function rig(opts: { lose?: (n: number) => boolean } = {}) {
  const dir = journalTmpDir()
  const clock = { now: T0 }
  const delivered: Array<{ sid: string; body: string }> = []
  const { host } = journalHost(dir, clock, { deliver: async (sid, body) => { delivered.push({ sid, body }); return { ok: true } } })
  host.configure(jslice())
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = []
  let n = 0
  // The twin's gates passed: follower.send lands in deliverHuman (daemon-standalone.ts cmdFollowerSend).
  const request = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params: JSON.parse(JSON.stringify(params)) })
    const r = cmd === 'follower.send'
      ? await host.deliverHuman(JHOME, String(params.sid), params.text, params.messageId)
      : { ok: false as const, error: { code: 'not_found', message: 'no such command here' } }
    n++
    if (opts.lose?.(n)) throw new Error('follower.send: timed out')
    return r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error.message, errorKind: r.error.code }
  }
  const overlay = createOverlay({ fetchPending: async () => host.pendingFor(JHOME, 0) as never, now: () => clock.now })
  const port_ = createWritePort({
    task: async (id) => { await overlay.refresh(); return overlay.task(id, null) as TaskRow | null },
    board: async () => null,
    noteWritten: (e) => overlay.noteWritten(e),
    now: () => clock.now,
  })
  // SID_A runs on this host; SID_B is taken for a Mac session here.
  setRpcAnswer(wsWrites({ port: port_, sessionHere: async (sid) => sid === SID_A, linked: () => true, request, log: () => {} }))
  const deliveries = () => journalLines(dir).map((l) => JSON.parse(l)).filter((r) => r.kind === 'delivery')
  return { delivered, calls, deliveries }
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    open.push(ws)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

/** One RPC as the console's ws client sends it (web/src/api/ws.ts): its own frame id, the action's op id. */
function rpc(ws: WebSocket, method: string, payload: unknown, opId?: string): Promise<WsFrame & { type: 'res' }> {
  const id = `req-${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 5_000)
    const onMessage = (data: WebSocket.RawData) => {
      const f = JSON.parse(data.toString()) as WsFrame
      if (f.type === 'res' && f.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(f) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ type: 'req', id, method, payload, ...(opId ? { opId } : {}) }))
  })
}

describe('a /ws session:send while the Mac is away', () => {
  it('reaches the session on this host through follower.send, named by the frame\'s op id, once however often the page sends it', async () => {
    const r = rig()
    const ws = await connect()
    const first = await rpc(ws, 'session:send', { sessionId: SID_A, message: 'Ship it after the drill' }, 'op-ws-send-000001')
    expect(first).toMatchObject({ ok: true, payload: { delivered: true, messageId: 'qm-op-ws-send-000001', offline: true } })
    expect(r.calls).toEqual([{ cmd: 'follower.send', params: { sid: SID_A, text: 'Ship it after the drill', messageId: 'qm-op-ws-send-000001', opId: 'op-ws-send-000001' } }])
    expect(r.delivered).toEqual([{ sid: SID_A, body: 'Ship it after the drill' }])
    expect(r.deliveries()).toHaveLength(1)
    // The page sends the same action again (its retry keeps the op id): one message, the same answer.
    const again = await rpc(ws, 'session:send', { sessionId: SID_A, message: 'Ship it after the drill' }, 'op-ws-send-000001')
    expect(again).toMatchObject({ ok: true, payload: { delivered: true, messageId: 'qm-op-ws-send-000001' } })
    expect(r.delivered).toHaveLength(1)
    // A new action is a new message.
    const next = await rpc(ws, 'session:send', { sessionId: SID_A, message: 'And tag the build' }, 'op-ws-send-000002')
    expect(next).toMatchObject({ ok: true, payload: { messageId: 'qm-op-ws-send-000002' } })
    expect(r.delivered.map((d) => d.body)).toEqual(['Ship it after the drill', 'And tag the build'])
  })

  it('a lost answer is asked again under the same op id and the session gets the message once', async () => {
    const r = rig({ lose: (n) => n === 1 })
    const ws = await connect()
    const sent = await rpc(ws, 'session:send', { sessionId: SID_A, message: 'Answer lost on the way back' }, 'op-ws-send-lost01')
    expect(sent).toMatchObject({ ok: true, payload: { delivered: true, messageId: 'qm-op-ws-send-lost01' } })
    expect(r.calls.map((c) => c.params.messageId)).toEqual(['qm-op-ws-send-lost01', 'qm-op-ws-send-lost01'])
    expect(r.delivered).toEqual([{ sid: SID_A, body: 'Answer lost on the way back' }])
    expect(r.deliveries()).toHaveLength(1)
  })

  it('a frame with no op id gets one minted here; a Mac session, pictures and an empty message are refused with the words the console reads', async () => {
    const r = rig()
    const ws = await connect()
    const minted = await rpc(ws, 'session:send', { sessionId: SID_A, message: 'No op id on this frame' })
    expect(minted).toMatchObject({ ok: true, payload: { delivered: true, messageId: expect.stringMatching(/^qm-op-[0-9a-f]{16}$/) } })
    const mac = await rpc(ws, 'session:send', { sessionId: SID_B, message: 'hello' }, 'op-ws-send-mac001')
    expect(mac).toMatchObject({ ok: false, error: 'needs_leader: session_on_mac' })
    const pic = await rpc(ws, 'session:send', { sessionId: SID_A, message: 'see this', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] }, 'op-ws-send-pic001')
    expect(pic).toMatchObject({ ok: false, error: 'needs_leader: images_need_mac' })
    const empty = await rpc(ws, 'session:send', { sessionId: SID_A, message: '   ' }, 'op-ws-send-empty1')
    expect(empty).toMatchObject({ ok: false, error: 'text must be a non-empty string' })
    expect(r.delivered.map((d) => d.body)).toEqual(['No op id on this frame'])
    expect(r.calls).toHaveLength(1)
  })

  it('an RPC the away rows do not journal goes on to the usual path', async () => {
    rig()
    const ws = await connect()
    const interest = await rpc(ws, 'set-interest', { mode: 'global' })
    expect(interest.ok).toBe(true)
  })
})
