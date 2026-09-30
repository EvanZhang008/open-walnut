/**
 * The replica under a phone's refetch storm and a flapping bridge.
 *
 * Field shape (replica logs, 2026-09-26 16:25 to 16:35Z): one session's fresh
 * transcript was requested 854 times in ten minutes, up to 130 times inside one
 * second, and every request did its own 512KB `read-history` over the bridge.
 * Meanwhile the Mac's bridge dropped and redialed about 70 times a day (median
 * hole 1.4s), and every flap put a `bridge-offline` and a `bridge-online` into
 * each open session's replay buffer, forever.
 *
 * Real: startServer in CLOUD_MODE, the /bridge socket, the registry, SSE
 * channels, the transcript route. The daemon is a bare `ws` client that speaks
 * the daemon's RPC protocol and counts what it is asked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-storm', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { OFFLINE_ANNOUNCE_DELAY_MS } from '../../../src/web/ws/bridge-presence.js'
import { READ_HISTORY_PER_HOST, _resetBridgeReadHistoryForTesting } from '../../../src/web/ws/bridge-read-history.js'
import { REPLICA_CHUNK_BYTES } from '../../../src/web/ws/bridge-wire.js'
import { log } from '../../../src/logging/index.js'

let server: HttpServer
let port: number
let machineToken: string
let deviceToken: string

const HOST = 'stormhost'
const SID = 'storm-session-0001'
const OTHERS = ['storm-session-a', 'storm-session-b', 'storm-session-c', 'storm-session-d', 'storm-session-e']
const READ_DELAY_MS = 250

const apiUrl = (p: string): string => `http://localhost:${port}${p}`
const auth = (): Record<string, string> => ({ Authorization: `Bearer ${deviceToken}` })

interface FakeDaemon {
  received: Array<Record<string, unknown>>
  readsInFlight: number
  peakReadsInFlight: number
  send: (obj: Record<string, unknown>) => void
  jsonl: (sid: string, line: Record<string, unknown>) => void
  close: () => Promise<void>
}

/** `uplink`: speak like a paced daemon (hello.uplink, chunked replies once asked). */
function connectFakeDaemon(opts?: { uplink?: boolean }): Promise<FakeDaemon> {
  const ws = new WebSocket(`ws://localhost:${port}/bridge?token=${machineToken}`)
  let readSeq = 0
  let chunkBytes = 0
  let cidSeq = 0
  const reply = (obj: Record<string, unknown>): void => {
    const frame = JSON.stringify(obj)
    if (chunkBytes <= 0 || frame.length <= chunkBytes) { ws.send(frame); return }
    const n = Math.ceil(frame.length / (chunkBytes / 2))
    const cid = `c${++cidSeq}`
    for (let i = 0; i < n; i++) {
      ws.send(JSON.stringify({ ev: 'chunk', cid, i, n, part: frame.slice(i * (chunkBytes / 2), (i + 1) * (chunkBytes / 2)) }))
    }
  }
  const daemon: FakeDaemon = {
    received: [],
    readsInFlight: 0,
    peakReadsInFlight: 0,
    send: (obj) => ws.send(JSON.stringify(obj)),
    jsonl: (sid, line) => ws.send(JSON.stringify({ ev: 'jsonl', sid, line: JSON.stringify(line) })),
    close: () => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) { resolve(); return }
      ws.once('close', () => resolve())
      ws.close()
    }),
  }
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>
    daemon.received.push(msg)
    const { id, cmd } = msg as { id?: number; cmd?: string }
    if (typeof id !== 'number') return
    if (cmd === 'attach') { daemon.send({ id, ok: true, alive: true, offset: 0 }); return }
    if (cmd === 'ping') { daemon.send({ id, ok: true }); return }
    if (cmd === 'bridge.peer') { chunkBytes = Number(msg.chunkBytes) || 0; daemon.send({ id, ok: true, chunkBytes }); return }
    if (cmd === 'read-history') {
      const n = ++readSeq
      daemon.readsInFlight++
      daemon.peakReadsInFlight = Math.max(daemon.peakReadsInFlight, daemon.readsInFlight)
      setTimeout(() => {
        daemon.readsInFlight--
        reply({
          id, ok: true, subagents: {},
          main: [
            JSON.stringify({ type: 'user', message: { role: 'user', content: 'question' }, timestamp: '2026-09-26T00:00:00Z' }),
            JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] }, timestamp: '2026-09-26T00:00:01Z' }),
            // Bulk, as a real 512KB tail read carries: forces a chunked reply.
            ...(opts?.uplink ? [JSON.stringify({ type: 'system', subtype: 'noise', text: 'n'.repeat(600 * 1024) })] : []),
          ].join('\n'),
        })
      }, READ_DELAY_MS)
      return
    }
    daemon.send({ id, ok: false, error: `unknown command: ${cmd}` })
  })
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      daemon.send({
        ev: 'hello', hostAlias: HOST, version: 'test-1', instanceId: 'i-storm', sids: [SID],
        ...(opts?.uplink ? { uplink: 1, connId: 'i-storm.7' } : {}),
      })
      setTimeout(() => resolve(daemon), 150)
    })
    ws.on('error', reject)
  })
}

const reads = (d: FakeDaemon, sid?: string): number =>
  d.received.filter((m) => m.cmd === 'read-history' && (!sid || m.sid === sid)).length

interface SseEvt { id: string | null; event: string; data: Record<string, unknown> }
interface Sse { events: SseEvt[]; waitFor: (p: (e: SseEvt) => boolean, ms?: number) => Promise<SseEvt>; close: () => void }

async function connectSse(sid: string): Promise<Sse> {
  const controller = new AbortController()
  const res = await fetch(apiUrl(`/api/v1/sessions/${sid}/stream`), { headers: auth(), signal: controller.signal })
  if (res.status !== 200 || !res.body) throw new Error(`SSE connect failed: ${res.status}`)
  const events: SseEvt[] = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          let id: string | null = null
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4)
            else if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (event) events.push({ id, event, data: data ? JSON.parse(data) : {} })
        }
      }
    } catch { /* aborted */ }
  })()
  const waitFor = async (pred: (e: SseEvt) => boolean, ms = 5_000): Promise<SseEvt> => {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = events.find(pred)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error('SSE waitFor timed out: ' + JSON.stringify(events.map((e) => e.event)))
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return { events, waitFor, close: () => controller.abort() }
}

async function transcript(sid: string): Promise<{ status: number; body: { messages?: Array<{ text: string }> } }> {
  const res = await fetch(apiUrl(`/api/v1/sessions/${sid}/transcript?fresh=1`), { headers: auth() })
  return { status: res.status, body: await res.json() as { messages?: Array<{ text: string }> } }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const presenceEvents = (s: Sse): SseEvt[] => s.events.filter((e) => e.event === 'bridge-online' || e.event === 'bridge-offline')

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  ;({ token: deviceToken } = await createDevice('phone'))
  ;({ token: machineToken } = await createDevice(`bridge-${HOST}`, { kind: 'machine' }))
  const projDir = path.join(WALNUT_HOME, 'sessions')
  await fs.mkdir(projDir, { recursive: true })
  const row = (id: string) => ({
    id, host: HOST, process_status: 'running',
    started_at: '2026-09-26T00:00:00Z', last_active_at: '2026-09-26T00:00:00Z', message_count: 1,
  })
  await fs.writeFile(path.join(projDir, 'projection.json'), JSON.stringify({
    version: 1, exportedAt: new Date().toISOString(), sessions: [row(SID), ...OTHERS.map(row)],
  }))
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  _resetAuthRateLimitForTesting()
  _resetBridgeReadHistoryForTesting()
})

describe('a transcript storm costs one bridge read', () => {
  it('140 parallel fresh reads of one session produce ONE read-history, then reuse it until the session changes', async () => {
    const daemon = await connectFakeDaemon()
    const sse = await connectSse(SID)
    try {
      await sse.waitFor((e) => e.event === 'bridge-online')
      const wave = await Promise.all(Array.from({ length: 140 }, () => transcript(SID)))
      expect(wave.every((r) => r.status === 200)).toBe(true)
      expect(new Set(wave.map((r) => JSON.stringify(r.body.messages))).size).toBe(1)
      expect(wave[0].body.messages?.map((m) => m.text)).toEqual(['question', 'answer 1'])
      expect(reads(daemon, SID)).toBe(1)

      // Inside the cache window and with nothing new: still one read.
      const again = await Promise.all(Array.from({ length: 20 }, () => transcript(SID)))
      expect(again.every((r) => r.body.messages?.[1]?.text === 'answer 1')).toBe(true)
      expect(reads(daemon, SID)).toBe(1)

      // A new transcript line reaches the session: the next read is fresh.
      daemon.jsonl(SID, { type: 'assistant', message: { content: [{ type: 'text', text: 'more' }] } })
      await sleep(100)
      const after = await Promise.all(Array.from({ length: 30 }, () => transcript(SID)))
      expect(reads(daemon, SID)).toBe(2)
      expect(after.every((r) => r.body.messages?.[1]?.text === 'answer 2')).toBe(true)
    } finally {
      sse.close()
      await daemon.close()
    }
  }, 60_000)

  it(`never runs more than ${READ_HISTORY_PER_HOST} reads against one host at a time`, async () => {
    const daemon = await connectFakeDaemon()
    try {
      const all = await Promise.all(OTHERS.flatMap((sid) => Array.from({ length: 10 }, () => transcript(sid))))
      expect(all.every((r) => r.status === 200)).toBe(true)
      expect(reads(daemon)).toBe(OTHERS.length)
      expect(daemon.peakReadsInFlight).toBeLessThanOrEqual(READ_HISTORY_PER_HOST)
      expect(daemon.peakReadsInFlight).toBeGreaterThan(0)
    } finally {
      await daemon.close()
    }
  }, 60_000)
})

describe('bridge presence on the phone stream', () => {
  it('a redial inside the grace window says nothing; a real outage says offline once, then online once', async () => {
    let daemon = await connectFakeDaemon()
    const sse = await connectSse(SID)
    try {
      await sse.waitFor((e) => e.event === 'bridge-online')
      expect(presenceEvents(sse)).toHaveLength(1) // the attach frame

      // A routine flap: gone for ~0.5s.
      await daemon.close()
      await sleep(500)
      daemon = await connectFakeDaemon()
      await sleep(OFFLINE_ANNOUNCE_DELAY_MS + 500)
      expect(presenceEvents(sse)).toHaveLength(1)
      // The redial still re-attached the page (its jsonl reaches the phone).
      expect(daemon.received.some((m) => m.cmd === 'attach' && m.sid === SID)).toBe(true)

      // A real outage: gone past the grace window.
      await daemon.close()
      const off = await sse.waitFor((e) => e.event === 'bridge-offline', OFFLINE_ANNOUNCE_DELAY_MS + 3_000)
      // A live frame keeps its id (the phone refreshes on an id-bearing online,
      // and treats an id-less one as a fresh attach); it is just never buffered.
      expect(off.id).not.toBeNull()
      daemon = await connectFakeDaemon()
      const on = await sse.waitFor((e) => e.event === 'bridge-online' && e !== sse.events[0], 5_000)
      expect(on.id).not.toBeNull()
      expect(presenceEvents(sse).map((e) => e.event)).toEqual(['bridge-online', 'bridge-offline', 'bridge-online'])

      // A phone that reconnects its stream now is replayed NONE of that.
      const late = await connectSse(SID)
      try {
        await late.waitFor((e) => e.event === 'bridge-online')
        await sleep(300)
        // Only its own id-less attach frame: neither live frame was buffered.
        expect(presenceEvents(late)).toHaveLength(1)
        expect(presenceEvents(late)[0].id).toBeNull()
        expect(late.events.some((e) => e.id === off.id || e.id === on.id)).toBe(false)
      } finally {
        late.close()
      }
    } finally {
      sse.close()
      await daemon.close()
    }
  }, 60_000)

  it('a page opened during the grace window is told online, and hears the offline if the host stays gone', async () => {
    let daemon = await connectFakeDaemon()
    const first = await connectSse(SID)
    try {
      await first.waitFor((e) => e.event === 'bridge-online')
      await daemon.close()
      await sleep(300)
      const during = await connectSse(SID)
      try {
        const frame = await during.waitFor((e) => e.event === 'bridge-online' || e.event === 'bridge-offline')
        expect(frame.event).toBe('bridge-online')
        await during.waitFor((e) => e.event === 'bridge-offline', OFFLINE_ANNOUNCE_DELAY_MS + 3_000)
        daemon = await connectFakeDaemon()
        await during.waitFor((e) => e.event === 'bridge-online' && e !== frame, 5_000)
        expect(daemon.received.some((m) => m.cmd === 'attach' && m.sid === SID)).toBe(true)
      } finally {
        during.close()
      }
    } finally {
      first.close()
      await daemon.close()
    }
  }, 60_000)
})

describe('the session replay window starts at each turn', () => {
  it('a phone attaching mid-turn is replayed this turn only, and a permission pause is not a new turn', async () => {
    const daemon = await connectFakeDaemon()
    const live = await connectSse(SID)
    try {
      await live.waitFor((e) => e.event === 'bridge-online')
      const state = (s: string): void => daemon.jsonl(SID, { type: 'system', subtype: 'session_state_changed', state: s })
      const delta = (text: string): void => daemon.jsonl(SID, {
        type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      })
      state('running'); delta('first turn'); daemon.jsonl(SID, { type: 'result', subtype: 'success' }); state('idle')
      state('running'); delta('second turn, before the prompt'); state('requires_action'); state('running'); delta('after the prompt')
      await live.waitFor((e) => e.event === 'text-delta' && e.data.delta === 'after the prompt')
      expect(live.events.filter((e) => e.event === 'turn-start')).toHaveLength(2)

      const late = await connectSse(SID)
      try {
        await late.waitFor((e) => e.event === 'text-delta' && e.data.delta === 'after the prompt')
        const deltas = late.events.filter((e) => e.event === 'text-delta').map((e) => e.data.delta)
        expect(deltas).toEqual(['second turn, before the prompt', 'after the prompt'])
        expect(late.events.filter((e) => e.event === 'turn-start')).toHaveLength(1)
      } finally {
        late.close()
      }
    } finally {
      live.close()
      await daemon.close()
    }
  }, 60_000)
})

describe('the replica end of a paced daemon uplink', () => {
  it('asks for chunks, echoes marker seqs, reassembles a chunked reply, and logs the close with counts', async () => {
    const info = vi.spyOn(log.ws, 'info')
    const daemon = await connectFakeDaemon({ uplink: true })
    try {
      await sleep(200)
      const peer = daemon.received.find((m) => m.cmd === 'bridge.peer')
      expect(peer?.chunkBytes).toBe(REPLICA_CHUNK_BYTES)

      daemon.send({ ev: 'bridge-ping', ts: Date.now(), seq: 41 })
      await sleep(200)
      expect(daemon.received.some((m) => m.cmd === 'ping' && m.ackSeq === 41)).toBe(true)

      const r = await transcript(SID)
      expect(r.status).toBe(200)
      expect(r.body.messages?.map((m) => m.text).slice(0, 2)).toEqual(['question', 'answer 1'])
    } finally {
      await daemon.close()
    }
    // Earlier tests' sockets may log their own close after the spy went in: pick this one's.
    const closedLine = (): Record<string, unknown> | undefined => info.mock.calls
      .find((c) => c[0] === 'bridge host closed' && (c[1] as Record<string, unknown>)?.connId === 'i-storm.7')?.[1] as
        Record<string, unknown> | undefined
    for (let i = 0; i < 50 && !closedLine(); i++) await sleep(50)
    const closed = closedLine()
    info.mockRestore()
    expect(closed).toMatchObject({ hostAlias: HOST, connId: 'i-storm.7', initiator: 'remote', pendingRpcs: 0 })
    expect(closed?.bytesRead as number).toBeGreaterThan(600 * 1024)
    expect(closed?.maxInFrameBytes as number).toBeLessThanOrEqual(REPLICA_CHUNK_BYTES)
    expect(closed?.bytesWritten as number).toBeGreaterThan(0)
    expect(String(closed?.clientIp)).toMatch(/127\.0\.0\.1|::1/)
    expect(closed).toHaveProperty('loopP99Ms')
    expect(closed).toHaveProperty('wsError')
    expect(typeof closed?.code).toBe('number')
  }, 60_000)
})
