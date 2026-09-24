/**
 * POST /api/v1/conversations/:id/messages on a CLOUD REPLICA — the chat turn is
 * relayed to the primary, because a turn runs in a `claude` CLI session and only
 * the primary has one.
 *
 * Real startServer with CLOUD_MODE forced, and a real /bridge socket driven
 * through the actual attachBridge/handleFrame path — so the hello handshake,
 * the `session.control` uplink framing, the reverse `mobile-event` downlink, the
 * __local__ trust gate and the kind allowlist are all exercised for real. The
 * test process plays the PRIMARY's daemon: it answers the uplink RPC and pushes
 * frames back, which is exactly the contract the real primary implements.
 *
 * What each case pins down:
 *  - the uplink carries (agentId, conversationId, text, turnId) to the primary;
 *  - downlink deltas + message-end reach THIS conversation's SSE stream, with
 *    the answering engine stamped on the terminal frame;
 *  - the replica writes NO chat history for a relayed turn (the primary is the
 *    single writer — two writers would double every message under git-sync);
 *  - bridge down ends the turn with the SSE `error` the phone already unlocks on,
 *    and still writes nothing here: this box is not a cloud-exec host, so it has
 *    no engine of its own (the companion's own fallback, when it IS one, is
 *    pinned in api-v1-chat-cloud-fallback.test.ts);
 *  - an IMAGE turn relays too: the bytes ride the `image.save` daemon lane and
 *    the control RPC carries only host PATHS (base64 in a control frame is the
 *    1009 oversized-frame kill), the replica stages nothing on its own disk, and
 *    an image that will not stage takes the whole turn down the same error path.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-chat-relay-cloud', { CLOUD_MODE: true }))

// Nothing is mocked beyond the constants: a replica has no engine to reach, so
// every path in this file either relays or reports that it could not.

import { WALNUT_HOME, IMAGES_DIR, MOBILE_STAGED_IMAGES_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { createConversation } from '../../../src/core/conversations.js'
import { resetChatTurnRelayState } from '../../../src/web/routes/chat-turn-relay.js'
import { listCloudTurns } from '../../../src/core/cloud-chat-outbox.js'
import { getSessionByLane } from '../../../src/core/session-tracker.js'
import { cloudChatLaneKey } from '../../../src/core/sessions/cloud-chat-lane.js'

let server: HttpServer
let port: number
let deviceToken: string

/** Must stay in step with PRIMARY_UNREACHABLE_MESSAGE in routes/api-v1.ts — the
 *  phone shows this string verbatim, so it is part of the contract. */
const PRIMARY_UNREACHABLE =
  "Walnut's primary is unreachable; the replica cannot answer on its own. Try again when the primary is back."

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

// ── Fake bridge socket standing in for the PRIMARY's daemon ──

interface UplinkFrame {
  id: number
  cmd: string
  action?: string
  params?: Record<string, unknown>
  /** `image.save` puts its args at the frame's top level, not under `params`. */
  data?: string
  mediaType?: string
}

/** Stand in for the daemon's `image.save`: generated filename, fixed staging
 *  dir, no caller path component — the same contract the real command holds. */
let stagedCounter = 0
async function stageImageLikeDaemon(frame: UplinkFrame): Promise<Record<string, unknown>> {
  const ext = frame.mediaType === 'image/jpeg' ? 'jpg' : 'png'
  const buf = Buffer.from(String(frame.data ?? ''), 'base64')
  await fs.mkdir(MOBILE_STAGED_IMAGES_DIR, { recursive: true })
  const filePath = path.join(MOBILE_STAGED_IMAGES_DIR, `170000000${stagedCounter++}-abcd1234.${ext}`)
  await fs.writeFile(filePath, buf)
  return { ok: true, path: filePath, size: buf.length }
}

class FakePrimaryDaemon extends EventEmitter {
  /** Uplink RPCs the cloud sent us. */
  received: UplinkFrame[] = []
  /** Reply factory for `session.control` — set per test. */
  onControl: ((frame: UplinkFrame) => Record<string, unknown>) | null = null
  /**
   * Reply factory for `image.save`. Default: behave like a real daemon —
   * validate nothing here (the real one is covered against the actual binary in
   * tests/e2e/daemon-bridge-image-save-e2e.test.ts) and write the bytes into
   * THIS process's staging dir, which is what makes the primary-side adoption in
   * the same process a genuine end-to-end read rather than a stub.
   */
  onImageSave: ((frame: UplinkFrame) => Promise<Record<string, unknown>>) | null = null

  send(payload: string): void {
    const frame = JSON.parse(payload) as UplinkFrame
    this.received.push(frame)
    if (frame.cmd === 'session.control' && this.onControl) {
      const reply = this.onControl(frame)
      // Answer on the next tick, like a real round trip.
      setTimeout(() => this.inbound({ id: frame.id, ...reply }), 0)
      return
    }
    if (frame.cmd === 'image.save') {
      const handler = this.onImageSave ?? stageImageLikeDaemon
      void handler(frame).then((reply) => this.inbound({ id: frame.id, ...reply }))
    }
  }

  close(): void { this.emit('close') }

  inbound(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }

  /** Push one chat-turn SSE frame down the reverse `mobile-event` lane. */
  pushChatFrame(conversationId: string, turnId: string, event: string, data: unknown): void {
    this.inbound({
      ev: 'mobile-event',
      kind: 'chat-turn-frame',
      data: { conversationId, turnId, event, data },
    })
  }

  /** Wait for the uplink relay RPC for a given action. */
  async waitForControl(action: string, timeoutMs = 10_000): Promise<UplinkFrame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.received.find((f) => f.cmd === 'session.control' && f.action === action)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`uplink ${action} never arrived`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

function connectFakePrimary(): FakePrimaryDaemon {
  const ws = new FakePrimaryDaemon()
  attachBridge(ws as never, 'bridge-local')
  ws.inbound({ ev: 'hello', hostAlias: '__local__', version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

// ── Minimal SSE client ──

interface SseEvt { event: string; data: Record<string, unknown> }

async function connectSse(url: string): Promise<{
  events: SseEvt[]
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}> {
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
            if (waiters[i].pred(evt)) {
              waiters[i].resolve(evt)
              waiters.splice(i, 1)
            }
          }
        }
      }
    } catch { /* aborted */ }
  })()
  return {
    events,
    waitFor: (pred, timeoutMs = 10_000) => {
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

/** 1×1 PNG — real image bytes, small enough that compression early-exits. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function postMessage(
  conversationId: string,
  text: string,
  images?: Array<{ data: string; mediaType: string }>,
): Promise<{ status: number; turnId: string }> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(images ? { images } : {}) }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, turnId: (body as { turnId?: string }).turnId ?? '' }
}

/** Files the REPLICA saved into its own chat image store. Must stay empty for a
 *  relayed turn: the primary owns the bytes exactly as it owns the history. */
async function listReplicaImageStore(): Promise<string[]> {
  try {
    const names = await fs.readdir(IMAGES_DIR)
    // The staging dir is written by our FAKE DAEMON (playing the primary's host,
    // same process), so it is not a replica-side write.
    return names.filter((n) => n !== 'mobile' && n !== 'remote')
  } catch {
    return []
  }
}

/** The replica's own copy of a conversation's chat history (must stay empty
 *  for a relayed turn — the primary is the single writer). */
async function readReplicaHistory(conversationId: string): Promise<unknown[]> {
  const file = path.join(WALNUT_HOME, 'conversations', 'general', `${conversationId}.json`)
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as { entries?: unknown[] }
    return raw.entries ?? []
  } catch {
    return []
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.rm(IMAGES_DIR, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  const device = await createDevice('chat-relay-cloud-test-phone')
  deviceToken = device.token
}, 60_000)

afterAll(async () => {
  closeAllBridges()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(IMAGES_DIR, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  closeAllBridges()
  resetChatTurnRelayState()
  await fs.rm(IMAGES_DIR, { recursive: true, force: true }).catch(() => {})
})

describe('a relayed chat turn runs on the primary\'s engine', () => {
  it('uplinks the turn and streams the primary\'s answer onto this conversation\'s SSE', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { accepted: true, engine: 'claude-code' } })

    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      const posted = await postMessage(conv.id, 'what engine are you?')
      expect(posted.status).toBe(202)

      // ── Uplink: the primary got the whole turn, on the box-level relay sid ──
      const uplink = await primary.waitForControl('server.chat.turn')
      expect(uplink.params).toEqual({
        agentId: 'general',
        conversationId: conv.id,
        text: 'what engine are you?',
        turnId: posted.turnId,
      })

      // ── Downlink: the primary's frames reach the phone's SSE stream ──
      primary.pushChatFrame(conv.id, posted.turnId, 'message-start', { turnId: posted.turnId })
      await sse.waitFor((e) => e.event === 'message-start')

      primary.pushChatFrame(conv.id, posted.turnId, 'text-delta', { delta: 'Claude ' })
      primary.pushChatFrame(conv.id, posted.turnId, 'text-delta', { delta: 'Code.' })
      await sse.waitFor((e) => e.event === 'text-delta' && e.data.delta === 'Code.')

      primary.pushChatFrame(conv.id, posted.turnId, 'tool', { name: 'Read', detail: 'notes.md' })
      const tool = await sse.waitFor((e) => e.event === 'tool')
      expect(tool.data.name).toBe('Read')

      primary.pushChatFrame(conv.id, posted.turnId, 'message-end', {
        turnId: posted.turnId, fullText: 'Claude Code.',
      })
      const end = await sse.waitFor((e) => e.event === 'message-end')
      expect(end.data.fullText).toBe('Claude Code.')
      // The whole point: the answer came from the primary's claude-code engine.
      expect(end.data.engine).toBe('claude-code')

      // ── Single writer: the replica persisted NOTHING for this turn ──
      // (the primary owns chat-history for a relayed turn; both writing would
      // double every message once git-sync converged)
      expect(await readReplicaHistory(conv.id)).toEqual([])
      // ...and a relayed turn never touches the companion's own fallback path:
      // no banked outbox entry, no companion lane.
      expect(await listCloudTurns({ conversationId: conv.id })).toEqual([])
      expect(await getSessionByLane(cloudChatLaneKey('general', conv.id))).toBeNull()
    } finally {
      sse.close()
      primary.close()
    }
  }, 40_000)

  it('the primary\'s 409 rides through as an SSE error, and does NOT run a second turn locally', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({
      ok: true,
      result: { accepted: false, reason: 'turn_active', message: 'A turn is already active on this conversation' },
    })

    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      expect((await postMessage(conv.id, 'hi')).status).toBe(202)
      const err = await sse.waitFor((e) => e.event === 'error')
      expect(String(err.data.message)).toContain('already active')
      // No local fallback turn: nothing was persisted here.
      expect(await readReplicaHistory(conv.id)).toEqual([])
    } finally {
      sse.close()
      primary.close()
    }
  }, 40_000)

  it('drops a downlink frame that names an event outside the allowlist', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { accepted: true, engine: 'claude-code' } })

    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      const posted = await postMessage(conv.id, 'hi')
      await primary.waitForControl('server.chat.turn')
      const before = sse.events.length

      primary.pushChatFrame(conv.id, posted.turnId, 'evil-event', { x: 1 })
      await new Promise((r) => setTimeout(r, 300))
      expect(sse.events.length).toBe(before)

      // Stream still healthy for a legitimate frame afterwards.
      primary.pushChatFrame(conv.id, posted.turnId, 'text-delta', { delta: 'ok' })
      await sse.waitFor((e) => e.event === 'text-delta' && e.data.delta === 'ok')
    } finally {
      sse.close()
      primary.close()
    }
  }, 40_000)
})

describe('an image turn also runs on the primary\'s engine', () => {
  it('stages the bytes on the primary and puts only PATHS in the control RPC', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { accepted: true, engine: 'claude-code' } })

    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      const posted = await postMessage(conv.id, 'what is in this picture?', [
        { data: TINY_PNG_BASE64, mediaType: 'image/png' },
        { data: TINY_PNG_BASE64, mediaType: 'image/png' },
      ])
      expect(posted.status).toBe(202)

      const uplink = await primary.waitForControl('server.chat.turn')

      // ── The rule this whole change exists to hold ──
      // Bytes went over the dedicated image lane, one RPC per picture; the
      // control frame carries ~60-byte paths. Base64 in a control frame is the
      // oversized-frame (1009) close that kills every in-flight RPC on the
      // shared bridge socket, so this assertion is the feature's safety net.
      const saves = primary.received.filter((f) => f.cmd === 'image.save')
      expect(saves).toHaveLength(2)
      expect(saves[0].data).toBe(TINY_PNG_BASE64)

      const paths = uplink.params?.imagePaths as string[]
      expect(paths).toHaveLength(2)
      for (const p of paths) expect(path.dirname(p)).toBe(MOBILE_STAGED_IMAGES_DIR)
      expect(JSON.stringify(uplink.params)).not.toContain(TINY_PNG_BASE64.slice(0, 40))

      // ── Single owner: the replica staged NOTHING in its own image store ──
      // (the fake daemon writes the staging dir on the primary's behalf; the
      // replica's own chat-image dir must be untouched, exactly like history)
      expect(await listReplicaImageStore()).toEqual([])

      // The turn then behaves like any relayed turn: primary's frames, primary's
      // engine on the terminal frame, and zero history written here.
      primary.pushChatFrame(conv.id, posted.turnId, 'message-end', {
        turnId: posted.turnId, fullText: 'A 1×1 pixel.',
      })
      const end = await sse.waitFor((e) => e.event === 'message-end')
      expect(end.data.engine).toBe('claude-code')
      expect(await readReplicaHistory(conv.id)).toEqual([])
    } finally {
      sse.close()
      primary.close()
    }
  }, 40_000)

  it('the primary can actually read back what the replica staged, and refuses anything else', async () => {
    // Closes the loop the pure-unit test cannot: the paths here were produced by
    // the daemon stand-in from bytes that really crossed the relay, and they are
    // fed to the REAL primary-side code rather than hand-written fixtures.
    const primary = connectFakePrimary()
    let relayedParams: Record<string, unknown> | undefined
    primary.onControl = (frame) => {
      relayedParams = frame.params
      return { ok: true, result: { accepted: true, engine: 'claude-code' } }
    }

    const conv = await createConversation('general')
    try {
      await postMessage(conv.id, 'describe it', [{ data: TINY_PNG_BASE64, mediaType: 'image/png' }])
      await primary.waitForControl('server.chat.turn')

      const { adoptRelayedImagePaths } = await import('../../../src/web/routes/images.js')
      const adopted = await adoptRelayedImagePaths(relayedParams!.imagePaths as unknown[])
      expect(adopted).not.toBeNull()
      expect(adopted!.savedImages).toHaveLength(1)
      // Adopted into the answering box's OWN store (IMAGES_DIR root), which is
      // what makes GET /api/images/:filename and history hydration work.
      expect(path.dirname(adopted!.savedImages[0].filePath)).toBe(IMAGES_DIR)
      await expect(fs.access(adopted!.savedImages[0].filePath)).resolves.toBeUndefined()

      // The primary's own ACCEPT handler refuses a path outside the staging dir,
      // and refuses it BEFORE starting a turn — the gate is not caller-trusted,
      // because these paths arrive from another box over the network.
      const { handlePrimaryChatTurnRelay } = await import('../../../src/web/routes/chat-turn-relay.js')
      const refused = await handlePrimaryChatTurnRelay({
        agentId: 'general', conversationId: conv.id, text: 'read this',
        turnId: 'turn-evil-path', imagePaths: [path.join(WALNUT_HOME, 'config.yaml')],
      })
      expect(refused.accepted).toBe(false)
      expect(refused.reason).toBe('images_unavailable')
    } finally {
      primary.close()
    }
  }, 40_000)

  it('a staging refusal ends the WHOLE turn with the unreachable error', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { accepted: true, engine: 'claude-code' } })
    // An old daemon that predates image.save. The turn must not be relayed
    // text-only — a "what is this?" without the picture is a wrong answer.
    primary.onImageSave = async () => ({ ok: false, error: 'unknown command: image.save' })

    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      expect((await postMessage(conv.id, 'what is this?', [
        { data: TINY_PNG_BASE64, mediaType: 'image/png' },
      ])).status).toBe(202)

      const err = await sse.waitFor((e) => e.event === 'error', 30_000)
      expect(String(err.data.message)).toBe(PRIMARY_UNREACHABLE)
      expect(sse.events.some((e) => e.event === 'message-end')).toBe(false)

      // The turn never went on the wire, and the replica kept nothing: no picture
      // in its image store, no history row. An unanswerable turn must not leave a
      // half-turn behind for git-sync to hand the primary later.
      expect(primary.received.some((f) => f.action === 'server.chat.turn')).toBe(false)
      expect(await listReplicaImageStore()).toEqual([])
      expect(await readReplicaHistory(conv.id)).toEqual([])
    } finally {
      sse.close()
      primary.close()
    }
  }, 60_000)
})

describe('degradation: no bridge → the replica says it cannot answer', () => {
  it('ends the turn with the unreachable SSE error and writes nothing', async () => {
    // No bridge connected at all: callPrimaryControl fails with BridgeOfflineError.
    // This replica is not a cloud-exec host, so it has no engine of its own and
    // the honest answer is to say so, on the ONE channel the phone unlocks its
    // composer on. A turn that ends with neither message-end nor error leaves the
    // composer spinning. `toContain`: when the relay layer can prove nothing was
    // sent, the message also says WHY this box cannot answer (cloud exec off).
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      expect((await postMessage(conv.id, 'hello with no bridge')).status).toBe(202)

      const err = await sse.waitFor((e) => e.event === 'error', 30_000)
      expect(String(err.data.message)).toContain(PRIMARY_UNREACHABLE)
      expect(sse.events.some((e) => e.event === 'message-end')).toBe(false)

      // Nothing on this box's disk: the primary is the single writer for every
      // turn, answered or not, so a reconnect cannot resurrect a ghost half-turn.
      expect(await readReplicaHistory(conv.id)).toEqual([])
      expect(await listCloudTurns({ conversationId: conv.id })).toEqual([])
    } finally {
      sse.close()
    }
  }, 60_000)
})

/**
 * The model pill's engine question is relayed too.
 *
 * A relayed turn runs on the primary, so "which engine answers this
 * conversation, and on which lane session" are facts about the PRIMARY. A replica
 * answering from its own config named a model no turn would ever use, so the
 * phone's model pill showed either the wrong model or, with no model to name,
 * nothing at all.
 */
describe('the chat engine question is answered by the box that answers the turn', () => {
  async function getEngine(conversationId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(apiUrl(`/api/v1/chat/engine?conversationId=${conversationId}`), {
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
  }

  async function mintEngineSession(conversationId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(apiUrl(`/api/v1/chat/engine/session?conversationId=${conversationId}`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
  }

  it('GET relays and reports the PRIMARY lane, without asking it to mint', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({
      ok: true,
      result: { engine: 'lane', sessionId: 'primary-lane-1', cwd: '/Users/x/.open-walnut', host: '' },
    })

    const conv = await createConversation('general')
    const got = await getEngine(conv.id)
    expect(got.status).toBe(200)
    // The PRIMARY's answer, verbatim — not this replica's own config.
    expect(got.body.engine).toBe('lane')
    expect(got.body.sessionId).toBe('primary-lane-1')

    const uplink = primary.received.find((f) => f.action === 'server.chat.engine')
    expect(uplink, 'the engine question must cross the bridge').toBeTruthy()
    expect(uplink!.params).toEqual({ agentId: 'general', conversationId: conv.id })
    // No `ensure` on a GET: a poll or a prefetch must never spawn a CLI.
    expect(uplink!.params).not.toHaveProperty('ensure')
  }, 30_000)

  it('POST asks the primary to MINT, carrying ensure:true', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({
      ok: true,
      result: { engine: 'lane', sessionId: 'primary-lane-2', cwd: '/Users/x/.open-walnut', host: '' },
    })

    const conv = await createConversation('general')
    const minted = await mintEngineSession(conv.id)
    expect(minted.status).toBe(200)
    expect(minted.body.sessionId).toBe('primary-lane-2')

    const uplink = primary.received.find((f) => f.action === 'server.chat.engine')
    expect(uplink!.params).toMatchObject({ agentId: 'general', conversationId: conv.id, ensure: true })
  }, 30_000)

  it('bridge down → 503 primary_unreachable, never this box\'s own config', async () => {
    // No bridge at all. Answering from this box's config was once treated as
    // honest degradation, but the mislabelled pill outlives the outage — it told
    // the phone the model was fixed by "the server's config" and locked the
    // control with that reason. A retryable 503 is the true answer.
    const conv = await createConversation('general')
    const got = await getEngine(conv.id)
    expect(got.status).toBe(503)
    expect((got.body.error as { code: string }).code).toBe('primary_unreachable')
    expect(got.body.retry).toBe(true)
    expect(got.body.engine).toBeUndefined()
  }, 30_000)
})
