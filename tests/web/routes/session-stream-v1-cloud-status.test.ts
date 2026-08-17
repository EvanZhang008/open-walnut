/**
 * Cloud-side session status truth — regression tests for the 2026-08-16
 * "header says Idle while Thinking…" and "Mac unreachable on ONE healthy
 * session" incidents. Real startServer({ port: 0 }) in CLOUD_MODE, a bare
 * `ws` client playing the PRIMARY box's daemon on /bridge (machine token,
 * hostAlias __local__), and a real phone-style SSE consumer.
 *
 * Covers:
 *  1. daemon jsonl `session_state_changed` lines → `status` frames on the
 *     session's conversation stream (running / idle / requires_action). The
 *     old forwardJsonlLine dropped them, so the phone header froze on
 *     whatever status the page attached with.
 *  2. `mobile-event session-upsert` frames echo an authoritative `status`
 *     frame onto the session's OWN stream channel — the only status lane that
 *     covers ACP/codex sessions (no tailable <sid>.jsonl).
 *  3. A per-session attach refusal (daemon answers ok:false — ACP journal,
 *     dead CLI) keeps the stream ONLINE: the bridge socket is healthy, sends
 *     and polling work. The old catch flipped it to bridge-offline → the
 *     phone painted "Mac unreachable — read-only" on one healthy session
 *     while its neighbors streamed.
 *  4. No bridge at all still reports bridge-offline (the fix must not eat the
 *     real offline signal).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-status', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'

let server: HttpServer
let port: number
let machineToken: string
/** Machine token bound to the remote exec host (hello hostAlias must match). */
let remoteMachineToken: string
let deviceToken: string

const SID = 'cloud-status-claude-01'
/** Second session on the same host whose attach the daemon REFUSES (the
 *  ACP/codex shape: journal keyed by runtimeId, no <sid>.jsonl to tail). */
const REFUSED_SID = 'cloud-status-codex-02'
/** Session mapped to a host that never dials — the true-offline control. */
const OFFLINE_SID = 'cloud-status-offline-03'
/** STOPPED session on a remote exec host (field case 3, 2026-08-17): the CLI
 *  was idle-reaped and its stream files unlinked, so the daemon refuses the
 *  attach — while the host itself is healthy and its bridge socket is live.
 *  Must stay ONLINE (the synced transcript renders; "host unreachable"
 *  was a lie). */
const STOPPED_SID = 'cloud-status-stopped-04'
const REMOTE_HOST = 'remotebox'

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

// ── Fake primary daemon: answers the RPC protocol over /bridge ──

interface FakeDaemon {
  ws: WebSocket
  received: Array<Record<string, unknown>>
  send: (obj: Record<string, unknown>) => void
  close: () => void
}

function connectFakeDaemon(token: string, hostAlias: string): Promise<FakeDaemon> {
  const ws = new WebSocket(`ws://localhost:${port}/bridge?token=${token}`)
  const daemon: FakeDaemon = {
    ws,
    received: [],
    send: (obj) => ws.send(JSON.stringify(obj)),
    close: () => ws.close(),
  }
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>
    daemon.received.push(msg)
    const { id, cmd, sid } = msg as { id?: number; cmd?: string; sid?: string }
    if (typeof id !== 'number') return
    if (cmd === 'attach') {
      // Per-session refusals: codex-shaped sid (journal keyed by runtimeId)
      // and reaped/stopped sid (stream files unlinked); success elsewhere.
      if (sid === REFUSED_SID || sid === STOPPED_SID) {
        daemon.send({ id, ok: false, error: `attach: session not found: ${sid}` })
      } else {
        daemon.send({ id, ok: true, alive: true, offset: 0 })
      }
    } else if (cmd === 'ping') {
      daemon.send({ id, ok: true })
    } else {
      daemon.send({ id, ok: false, error: `unknown command: ${cmd}` })
    }
  })
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      daemon.send({ ev: 'hello', hostAlias, version: 'test-1', instanceId: 'i-test', sids: [] })
      setTimeout(() => resolve(daemon), 150)
    })
    ws.on('error', reject)
  })
}

// ── Minimal SSE consumer (same shape as bridge-registry.test.ts) ──

interface SseEvt { event: string; data: Record<string, unknown> }
interface SseConn { events: SseEvt[]; waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>; close: () => void }

async function connectSse(url: string): Promise<SseConn> {
  const controller = new AbortController()
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${deviceToken}` },
    signal: controller.signal,
  })
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
  // The primary box's daemon registers as __local__ (token 'bridge-local').
  ;({ token: machineToken } = await createDevice('bridge-local', { kind: 'machine' }))
  ;({ token: remoteMachineToken } = await createDevice(`bridge-${REMOTE_HOST}`, { kind: 'machine' }))

  // Projection: host '' = the primary box → resolves to '__local__'.
  const projDir = path.join(WALNUT_HOME, 'sessions')
  await fs.mkdir(projDir, { recursive: true })
  const row = (id: string, host: string, processStatus = 'idle') => ({
    id, host, process_status: processStatus,
    started_at: '2026-08-16T00:00:00Z', last_active_at: '2026-08-16T00:00:00Z', message_count: 1,
  })
  await fs.writeFile(path.join(projDir, 'projection.json'), JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: [
      row(SID, ''), row(REFUSED_SID, ''), row(OFFLINE_SID, 'neverdials'),
      row(STOPPED_SID, REMOTE_HOST, 'stopped'),
    ],
  }))
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('cloud conversation stream: status truth', () => {
  it('forwards CLI session_state_changed lines as status frames (running → idle → requires_action)', async () => {
    const daemon = await connectFakeDaemon(machineToken, '__local__')
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`))
    try {
      await sse.waitFor((e) => e.event === 'bridge-online')

      const stateLine = (state: string) => JSON.stringify({
        type: 'system', subtype: 'session_state_changed', state, session_id: SID,
      })
      daemon.send({ ev: 'jsonl', sid: SID, v: 100, line: stateLine('running') })
      await sse.waitFor((e) => e.event === 'status' && e.data.processStatus === 'running')

      daemon.send({ ev: 'jsonl', sid: SID, v: 200, line: stateLine('idle') })
      await sse.waitFor((e) => e.event === 'status' && e.data.processStatus === 'idle')

      // Paused on a permission prompt = still a live turn (same projection
      // as session-snapshot-apply's waiting → running).
      daemon.send({ ev: 'jsonl', sid: SID, v: 300, line: stateLine('requires_action') })
      const statuses = () => sse.events.filter((e) => e.event === 'status').map((e) => e.data.processStatus)
      await sse.waitFor((e) => e.event === 'status' && statuses().length >= 3)
      expect(statuses()).toEqual(['running', 'idle', 'running'])
    } finally {
      sse.close()
      daemon.close()
    }
  })

  it('echoes mobile-event session-upsert as a status frame on the session channel (ACP lane)', async () => {
    const daemon = await connectFakeDaemon(machineToken, '__local__')
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`))
    try {
      await sse.waitFor((e) => e.event === 'bridge-online')
      const before = sse.events.filter((e) => e.event === 'status').length

      daemon.send({
        ev: 'mobile-event', kind: 'session-upsert',
        data: { id: SID, host: '', process_status: 'running', started_at: 'x', last_active_at: 'y', message_count: 2 },
      })
      await sse.waitFor((e) => e.event === 'status' && e.data.processStatus === 'running')

      daemon.send({
        ev: 'mobile-event', kind: 'session-upsert',
        data: { id: SID, host: '', process_status: 'idle', started_at: 'x', last_active_at: 'y', message_count: 2 },
      })
      await sse.waitFor((e) =>
        e.event === 'status' && e.data.processStatus === 'idle'
        && sse.events.filter((ev) => ev.event === 'status').length >= before + 2)
    } finally {
      sse.close()
      daemon.close()
    }
  })

  it('a per-session attach refusal stays ONLINE (bridge socket healthy)', async () => {
    const daemon = await connectFakeDaemon(machineToken, '__local__')
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${REFUSED_SID}/stream`))
    try {
      // The daemon refused the attach — but the bridge is up, sends work,
      // transcripts poll. bridge-offline here is the "Mac unreachable on a
      // healthy session" lie.
      const first = await sse.waitFor((e) => e.event === 'bridge-online' || e.event === 'bridge-offline')
      expect(first.event).toBe('bridge-online')
      // The daemon really did see and refuse the attach (per-session shape).
      expect(daemon.received.some((m) => m.cmd === 'attach' && m.sid === REFUSED_SID)).toBe(true)
    } finally {
      sse.close()
      daemon.close()
    }
  })

  it('a STOPPED/reaped session on a healthy remote host stays ONLINE (field case 3)', async () => {
    // The host's daemon has a live bridge socket, but the session's CLI was
    // idle-reaped and its stream files unlinked — attach refuses. The page
    // must stay online: the synced transcript renders and sends can resume
    // the session; "host unreachable — read-only" was the lie.
    const daemon = await connectFakeDaemon(remoteMachineToken, REMOTE_HOST)
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${STOPPED_SID}/stream`))
    try {
      const first = await sse.waitFor((e) => e.event === 'bridge-online' || e.event === 'bridge-offline')
      expect(first.event).toBe('bridge-online')
      expect(daemon.received.some((m) => m.cmd === 'attach' && m.sid === STOPPED_SID)).toBe(true)
    } finally {
      sse.close()
      daemon.close()
    }
  })

  it('no bridge for the host still reports bridge-offline (real offline signal survives)', async () => {
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${OFFLINE_SID}/stream`))
    try {
      const first = await sse.waitFor((e) => e.event === 'bridge-online' || e.event === 'bridge-offline')
      expect(first.event).toBe('bridge-offline')
    } finally {
      sse.close()
    }
  })
})
