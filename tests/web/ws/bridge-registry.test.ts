/**
 * Cloud-side daemon bridge integration — real startServer({ port: 0 }) with
 * CLOUD_MODE, a bare `ws` client playing the daemon side of the /bridge
 * protocol, and a real phone-style SSE consumer.
 *
 * Covers: machine-token gate on /bridge (device token rejected, machine
 * accepted), machine token rejected on REST and /ws, hello registration →
 * status.bridgeHosts, POST send (this fake daemon predates session.message,
 * so the route falls back to the loss-safe direct sequence
 * status→send→appendUserMarker — marker strictly AFTER delivery),
 * daemon jsonl events reaching the phone SSE, 409 session_dead, disconnect →
 * 503 + bridge-offline, and same-host replacement (code 4000).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-test', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'

let server: HttpServer
let port: number
let machineToken: string
let deviceToken: string

const SID = 'bridge-test-session-01'
const HOST = 'testhost'

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

// ── Fake daemon: a ws client that answers the daemon RPC protocol ──

interface FakeDaemon {
  ws: WebSocket
  received: Array<Record<string, unknown>>
  closedWith: { code: number } | null
  send: (obj: Record<string, unknown>) => void
  close: () => void
}

function connectFakeDaemon(token: string, hostAlias: string, opts?: {
  alive?: boolean
  sendResult?: Record<string, unknown>
}): Promise<FakeDaemon> {
  const ws = new WebSocket(`ws://localhost:${port}/bridge?token=${token}`)
  const daemon: FakeDaemon = {
    ws,
    received: [],
    closedWith: null,
    send: (obj) => ws.send(JSON.stringify(obj)),
    close: () => ws.close(),
  }
  ws.on('close', (code) => { daemon.closedWith = { code } })
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>
    daemon.received.push(msg)
    const { id, cmd, sid } = msg as { id?: number; cmd?: string; sid?: string }
    if (typeof id !== 'number') return
    // Answer like a live daemon whose session SID exists and runs.
    if (cmd === 'status') {
      daemon.send({ id, ok: true, exists: sid === SID, alive: (sid === SID) && (opts?.alive ?? true), pid: 4242, state: 'running' })
    } else if (cmd === 'appendUserMarker') {
      daemon.send({ id, ok: true, size: 1024 })
    } else if (cmd === 'send') {
      daemon.send({ id, ...(opts?.sendResult ?? { ok: true }) })
    } else if (cmd === 'attach') {
      daemon.send({ id, ok: true, alive: true, offset: 0 })
    } else if (cmd === 'read-history') {
      daemon.send({
        id, ok: true, subagents: {},
        main: [
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello from web' }, timestamp: '2026-07-10T00:00:00Z' }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }, timestamp: '2026-07-10T00:00:01Z' }),
        ].join('\n'),
      })
    } else {
      daemon.send({ id, ok: false, error: `unknown command: ${cmd}` })
    }
  })
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      daemon.send({ ev: 'hello', hostAlias, version: 'test-1', instanceId: 'i-test', sids: [SID] })
      // Give the server a beat to register before tests fire requests.
      setTimeout(() => resolve(daemon), 150)
    })
    ws.on('error', reject)
  })
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await pred()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

// ── SSE consumer (same minimal client as api-v1-session-talk.test.ts) ──

interface SseEvt { event: string; data: Record<string, unknown> }
interface SseConn { events: SseEvt[]; waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>; close: () => void }

async function connectSse(url: string, headers?: Record<string, string>): Promise<SseConn> {
  const controller = new AbortController()
  const res = await fetch(url, { headers, signal: controller.signal })
  if (res.status !== 200 || !res.body) {
    controller.abort()
    throw new Error(`SSE connect failed: ${res.status}`)
  }
  const events: SseEvt[] = []
  const waiters: Array<{ pred: (e: SseEvt) => boolean; resolve: (e: SseEvt) => void }> = []
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
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue
            if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (!event) continue
          const evt: SseEvt = { event, data: data ? JSON.parse(data) : {} }
          events.push(evt)
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(evt)) { waiters[i].resolve(evt); waiters.splice(i, 1) }
          }
        }
      }
    } catch { /* aborted */ }
  })()
  return {
    events,
    waitFor: (pred, timeoutMs = 5000) => {
      const existing = events.find(pred)
      if (existing) return Promise.resolve(existing)
      return new Promise<SseEvt>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE waitFor timed out')), timeoutMs)
        waiters.push({ pred, resolve: (e) => { clearTimeout(timer); resolve(e) } })
      })
    },
    close: () => controller.abort(),
  }
}

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

  // Session projection file: the cloud endpoints look up session→host here.
  const projDir = path.join(WALNUT_HOME, 'sessions')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'projection.json'), JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: [{
      id: SID, host: HOST, process_status: 'running',
      started_at: '2026-07-10T00:00:00Z', last_active_at: '2026-07-10T00:00:00Z', message_count: 1,
    }],
  }))
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  _resetAuthRateLimitForTesting()
})

describe('machine token scoping', () => {
  it('machine token is REJECTED on REST routes', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      headers: { Authorization: `Bearer ${machineToken}` },
    })
    expect(res.status).toBe(401)
  })

  it('machine token is REJECTED on the /ws browser upgrade', async () => {
    const failed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${machineToken}`)
      ws.on('open', () => { ws.close(); resolve(false) })
      ws.on('error', () => resolve(true))
    })
    expect(failed).toBe(true)
  })

  it('device token is REJECTED on /bridge', async () => {
    const failed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/bridge?token=${deviceToken}`)
      ws.on('open', () => { ws.close(); resolve(false) })
      ws.on('error', () => resolve(true))
    })
    expect(failed).toBe(true)
  })
})

describe('bridge lifecycle + proxied send + streaming', () => {
  it('hello registers the host; status reports bridgeHosts; send proxies the 3-step sequence; jsonl reaches the phone SSE', async () => {
    const daemon = await connectFakeDaemon(machineToken, HOST)
    try {
      // status.bridgeHosts flips
      await waitFor(async () => {
        const res = await fetch(apiUrl('/api/v1/status'), { headers: { Authorization: `Bearer ${deviceToken}` } })
        const body = await res.json() as { bridgeHosts?: Array<{ hostAlias: string }> }
        return !!body.bridgeHosts?.some((b) => b.hostAlias === HOST)
      })

      // Phone opens the stream first → bridge-online + attach sent to daemon.
      const sse = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`), {
        Authorization: `Bearer ${deviceToken}`,
      })
      try {
        await sse.waitFor((e) => e.event === 'bridge-online')
        await waitFor(() => daemon.received.some((m) => m.cmd === 'attach' && m.sid === SID))

        // Send: 202. This fake daemon predates session.message (answers
        // unknown-command), so the route takes the direct fallback — which is
        // now LOSS-SAFE ordered: status → send → appendUserMarker. Marker
        // strictly AFTER the confirmed delivery (the old marker-first order
        // produced ghost user bubbles when the daemon died between the steps —
        // the 2026-08-13 data-loss family).
        const res = await fetch(apiUrl(`/api/v1/sessions/${SID}/messages`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
          body: JSON.stringify({ text: 'hello from the phone' }),
        })
        expect(res.status).toBe(202)
        const { messageId } = await res.json() as { messageId: string }
        expect(messageId).toMatch(/^qm-mobile-/)
        const cmds = daemon.received.filter((m) => typeof m.id === 'number').map((m) => m.cmd)
        expect(cmds).toContain('session.message') // durable relay attempted first
        const statusIdx = cmds.indexOf('status')
        const markerIdx = cmds.indexOf('appendUserMarker')
        const sendIdx = cmds.indexOf('send')
        expect(statusIdx).toBeGreaterThanOrEqual(0)
        expect(sendIdx).toBeGreaterThan(statusIdx)
        expect(markerIdx).toBeGreaterThan(sendIdx)
        const marker = daemon.received.find((m) => m.cmd === 'appendUserMarker')!
        expect(marker.message).toBe('hello from the phone')
        expect(marker.messageId).toBe(messageId)

        // Daemon pushes jsonl → phone sees SSE events (main lane only).
        daemon.send({ ev: 'jsonl', sid: SID, v: 100, line: JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } } }) })
        daemon.send({ ev: 'jsonl', sid: SID, v: 200, line: JSON.stringify({ type: 'assistant', parent_tool_use_id: 'tu-sub', message: { content: [{ type: 'tool_use', id: 'tu-x', name: 'SubagentTool' }] } }) })
        daemon.send({ ev: 'jsonl', sid: SID, v: 300, line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash' }] } }) })
        daemon.send({ ev: 'jsonl', sid: SID, v: 400, line: JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) })

        await sse.waitFor((e) => e.event === 'text-delta' && e.data.delta === 'Hi ')
        const tool = await sse.waitFor((e) => e.event === 'tool')
        expect(tool.data.name).toBe('Bash') // subagent lane filtered
        await sse.waitFor((e) => e.event === 'turn-end')
        expect(sse.events.some((e) => e.event === 'tool' && e.data.name === 'SubagentTool')).toBe(false)

        // fresh transcript rides the bridge (read-history)
        const tRes = await fetch(apiUrl(`/api/v1/sessions/${SID}/transcript?fresh=1`), {
          headers: { Authorization: `Bearer ${deviceToken}` },
        })
        expect(tRes.status).toBe(200)
        const transcript = await tRes.json() as { messages: Array<{ role: string; text: string }> }
        expect(transcript.messages.some((m) => m.role === 'assistant' && m.text === 'hi there')).toBe(true)
        expect(daemon.received.some((m) => m.cmd === 'read-history')).toBe(true)
      } finally {
        sse.close()
      }
    } finally {
      daemon.close()
    }
  })

  it('dead CLI → 409 session_dead', async () => {
    const daemon = await connectFakeDaemon(machineToken, HOST, { alive: false })
    try {
      const res = await fetch(apiUrl(`/api/v1/sessions/${SID}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
        body: JSON.stringify({ text: 'anyone home?' }),
      })
      expect(res.status).toBe(409)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('session_dead')
    } finally {
      daemon.close()
    }
  })

  it('no bridge → send is BANKED (202 queued), stream still 200 with bridge-offline event', async () => {
    // (no fake daemon connected for HOST at this point — previous tests closed theirs)
    await waitFor(async () => {
      const res = await fetch(apiUrl('/api/v1/status'), { headers: { Authorization: `Bearer ${deviceToken}` } })
      const body = await res.json() as { bridgeHosts?: Array<{ hostAlias: string }> }
      return !body.bridgeHosts?.some((b) => b.hostAlias === HOST)
    })

    const res = await fetch(apiUrl(`/api/v1/sessions/${SID}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ text: 'hello?' }),
    })
    // This assertion USED to be 503. With no socket the primary provably never
    // saw the message, so the replica now banks it (core/send-queue.ts) and
    // fast-accepts — a text send is never lost to a bridge outage, however long
    // it lasts (2026-08-20: a ~7-minute outage outlived the phone's own retry
    // budget and surfaced as "Not sent" on a healthy streaming session).
    expect(res.status).toBe(202)
    const body = await res.json() as { messageId: string; queued?: boolean }
    expect(body.messageId).toMatch(/^qm-mobile-/)
    expect(body.queued).toBe(true)
    // The STREAM still reports the honest transport state — accepting the write
    // must not paint the session as online.

    const sse = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`), {
      Authorization: `Bearer ${deviceToken}`,
    })
    try {
      await sse.waitFor((e) => e.event === 'bridge-offline')
    } finally {
      sse.close()
    }
  })

  it('second dial for the same host REPLACES the first (code 4000)', async () => {
    const first = await connectFakeDaemon(machineToken, HOST)
    const second = await connectFakeDaemon(machineToken, HOST)
    try {
      await waitFor(() => first.closedWith !== null)
      expect(first.closedWith?.code).toBe(4000)
      // The replacement serves requests.
      const res = await fetch(apiUrl(`/api/v1/sessions/${SID}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
        body: JSON.stringify({ text: 'still here?' }),
      })
      expect(res.status).toBe(202)
      expect(second.received.some((m) => m.cmd === 'send')).toBe(true)
    } finally {
      second.close()
      first.close()
    }
  })

  // Security regression (HIGH-3): a machine token is minted per host as
  // `bridge-<alias>`, so the token's device name IS its host identity. A hello
  // claiming a DIFFERENT hostAlias must be refused (code 4001) — otherwise a
  // leaked/reused token could evict and impersonate any other host's daemon.
  it('hello with a hostAlias that mismatches the token identity is REJECTED (code 4001)', async () => {
    const imposter = await connectFakeDaemon(machineToken, 'someone-elses-host')
    try {
      await waitFor(() => imposter.closedWith !== null)
      expect(imposter.closedWith?.code).toBe(4001)
      // It never entered the registry: the impersonated host is not listed.
      const res = await fetch(apiUrl('/api/v1/status'), {
        headers: { Authorization: `Bearer ${deviceToken}` },
      })
      const body = await res.json() as { bridgeHosts?: Array<{ hostAlias: string }> }
      expect(body.bridgeHosts?.some((b) => b.hostAlias === 'someone-elses-host')).toBeFalsy()
    } finally {
      imposter.close()
    }
  })
})
