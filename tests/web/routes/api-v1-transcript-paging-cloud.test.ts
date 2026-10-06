/**
 * Transcript paging on a cloud replica: relayed to the primary.
 *
 * 2026-10-04 report: on the phone, scrolling up in most sessions ended at a
 * folded "Ran 8 commands" line with nothing above it. The phone was paired to
 * the replica, which read a session as a 512 KB bridge tail (about the last 100
 * entries), never said `pageable`, and refused `before`. So the replica now
 * relays a rich or `before` read to the primary (`session.control` action
 * `transcript`) and answers with the primary's build.
 *
 * What each case pins: the uplink carries the cursors; the primary's page comes
 * back with `rich` / `pageable` added the way the primary's own route adds them;
 * when the primary cannot answer (no bridge, an older primary), the newest page
 * still comes from the synced file and does not say `pageable`, while an older
 * page is a 503 the phone shows as "try again" (never the newest tail again,
 * which a phone prepending it as "older" would show twice); an empty newest page
 * from the primary does not hide the synced copy.
 *
 * Real: startServer with CLOUD_MODE forced, a real /bridge socket through the
 * actual attachBridge/handleFrame path, device auth. The test process plays the
 * primary's daemon. Mocked: constants (temp dirs + CLOUD_MODE).
 *
 * Sibling (primary box, real JSONL, and the primary's half of the relay):
 * api-v1-transcript-paging.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-transcript-paging-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { _resetBridgeReadHistoryForTesting, noteSessionContentChanged } from '../../../src/web/ws/bridge-read-history.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { SESSION_TRANSCRIPTS_DIR } from '../../../src/core/session-projection.js'

let server: HttpServer
let port: number
let deviceToken: string

const SID = 'sess-paging-cloud-0001'
const SYNCED = { role: 'assistant', text: 'the synced tail', timestamp: '2026-01-01T00:10:00.000Z' }

interface UplinkFrame {
  id: number
  cmd: string
  action?: string
  sessionId?: string
  params?: Record<string, unknown>
}

/** Stand-in for the primary's daemon: answers `session.control` uplinks. */
class FakePrimaryDaemon extends EventEmitter {
  received: UplinkFrame[] = []
  onControl: ((frame: UplinkFrame) => Record<string, unknown>) | null = null

  send(payload: string): void {
    const frame = JSON.parse(payload) as UplinkFrame
    this.received.push(frame)
    if (frame.cmd === 'session.control' && this.onControl) {
      const reply = this.onControl(frame)
      setTimeout(() => this.inbound({ id: frame.id, ...reply }), 0)
    }
  }

  close(): void { this.emit('close') }

  inbound(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }

  transcriptFrames(): UplinkFrame[] {
    return this.received.filter((f) => f.cmd === 'session.control' && f.action === 'transcript')
  }
}

function connectFakePrimary(): FakePrimaryDaemon {
  const ws = new FakePrimaryDaemon()
  attachBridge(ws as never, 'bridge-local')
  ws.inbound({ ev: 'hello', hostAlias: '__local__', version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

/** A page as the primary's buildSessionTranscript shapes it. */
function primaryPage(texts: string[], truncated: boolean): Record<string, unknown> {
  return {
    version: 1, sessionId: SID, exportedAt: '2026-01-02T00:00:00.000Z', truncated,
    messages: texts.map((text, i) => ({
      role: 'assistant', text, timestamp: `2026-01-01T00:0${i}:00.000Z`,
    })),
  }
}

/** The primary answers `transcript` with these pages and refuses every other action, like an older box. */
function answerTranscript(page: (params: Record<string, unknown>) => Record<string, unknown>) {
  return (frame: UplinkFrame): Record<string, unknown> => frame.action === 'transcript'
    ? { ok: true, result: page(frame.params ?? {}) }
    : { error: `Unknown control action: ${frame.action}` }
}

async function getTranscript(qs: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${port}/api/v1/sessions/${SID}/transcript${qs}`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

const BEFORE = encodeURIComponent('2026-01-01T00:10:00.000Z')

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  await fs.mkdir(SESSION_TRANSCRIPTS_DIR, { recursive: true })
  await fs.writeFile(
    path.join(SESSION_TRANSCRIPTS_DIR, `${SID}.json`),
    JSON.stringify({ version: 1, sessionId: SID, exportedAt: '2026-01-01T00:00:00.000Z', truncated: true, messages: [SYNCED] }),
  )
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  deviceToken = (await createDevice('paging-test-phone')).token
}, 60_000)

afterAll(async () => {
  closeAllBridges()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  closeAllBridges()
  _resetBridgeReadHistoryForTesting()
})

describe('transcript paging on a replica', () => {
  it("relays the cursors and answers with the primary's page, pageable", async () => {
    const primary = connectFakePrimary()
    primary.onControl = answerTranscript((p) => primaryPage(
      p.before ? ['older one', 'older two'] : ['the opening ask', 'newest'], !!p.before))
    try {
      const newest = await getTranscript('?fresh=1&rich=1&visible=20')
      expect(newest.status).toBe(200)
      expect(newest.body).toMatchObject({ rich: true, pageable: true, truncated: false, sessionId: SID })
      expect((newest.body.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(['the opening ask', 'newest'])

      const older = await getTranscript(`?fresh=1&rich=1&visible=20&before=${BEFORE}`)
      expect(older.status).toBe(200)
      expect(older.body).toMatchObject({ rich: true, pageable: true, truncated: true })
      expect((older.body.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(['older one', 'older two'])

      const since = await getTranscript(`?fresh=1&rich=1&since=${BEFORE}`)
      expect(since.status).toBe(200)

      // The uplink carries what the phone asked for, cursors verbatim, nothing more.
      expect(primary.transcriptFrames().map((f) => [f.sessionId, f.params])).toEqual([
        [SID, { rich: true, visible: 20 }],
        [SID, { rich: true, visible: 20, before: '2026-01-01T00:10:00.000Z' }],
        [SID, { rich: true, since: '2026-01-01T00:10:00.000Z' }],
      ])
    } finally {
      primary.close()
    }
  }, 30_000)

  it('a burst of polls for one page is one relay, and new content reads again', async () => {
    const primary = connectFakePrimary()
    primary.onControl = answerTranscript(() => primaryPage(['newest'], false))
    try {
      const burst = await Promise.all(Array.from({ length: 6 }, () => getTranscript('?fresh=1&rich=1&visible=20')))
      for (const r of burst) expect(r.body.pageable).toBe(true)
      expect(primary.transcriptFrames()).toHaveLength(1)
      noteSessionContentChanged(SID)
      await getTranscript('?fresh=1&rich=1&visible=20')
      expect(primary.transcriptFrames()).toHaveLength(2)
    } finally {
      primary.close()
    }
  }, 30_000)

  it('no bridge: the newest page is the synced file, not pageable; an older page is a 503', async () => {
    const newest = await getTranscript('?fresh=1&rich=1&visible=20')
    expect(newest.status).toBe(200)
    expect(newest.body.messages).toEqual([SYNCED])
    expect(newest.body.rich).toBe(false)
    expect(newest.body.pageable).toBeUndefined()

    const older = await getTranscript(`?fresh=1&rich=1&before=${BEFORE}`)
    expect(older.status).toBe(503)
    expect((older.body.error as { code?: string })?.code).toBe('page_unavailable')
  }, 30_000)

  it('an older primary without the action degrades the same way', async () => {
    const primary = connectFakePrimary()
    primary.onControl = (frame) => ({ error: `Unknown control action: ${frame.action}` })
    try {
      const newest = await getTranscript('?fresh=1&rich=1&visible=20')
      expect(newest.status).toBe(200)
      expect(newest.body.messages).toEqual([SYNCED])
      expect(newest.body.pageable).toBeUndefined()

      const older = await getTranscript(`?fresh=1&rich=1&before=${BEFORE}`)
      expect(older.status).toBe(503)
      expect((older.body.error as { code?: string })?.code).toBe('page_unavailable')
      expect(primary.transcriptFrames()).toHaveLength(2)
    } finally {
      primary.close()
    }
  }, 30_000)

  it("an empty newest page from the primary does not hide the synced copy; an empty older page is the start", async () => {
    // The primary builds empty for a session whose JSONL is gone, and the synced
    // file may be the only copy left. An empty OLDER page is a real answer: the
    // conversation has nothing before the cursor.
    const primary = connectFakePrimary()
    primary.onControl = answerTranscript(() => primaryPage([], false))
    try {
      const newest = await getTranscript('?fresh=1&rich=1&visible=20')
      expect(newest.body.messages).toEqual([SYNCED])
      expect(newest.body.pageable).toBeUndefined()

      const older = await getTranscript(`?fresh=1&rich=1&before=${BEFORE}`)
      expect(older.status).toBe(200)
      expect(older.body).toMatchObject({ messages: [], truncated: false, pageable: true })
    } finally {
      primary.close()
    }
  }, 30_000)

  it('a malformed cursor is a 400 without waking the bridge, and a plain read is not relayed', async () => {
    const primary = connectFakePrimary()
    primary.onControl = answerTranscript(() => primaryPage(['newest'], false))
    try {
      const bad = await getTranscript('?fresh=1&rich=1&before=yesterday')
      expect(bad.status).toBe(400)
      expect((bad.body.error as { code?: string })?.code).toBe('invalid_before')
      // A slim read (the phone's cached first phase) stays the synced file, as before.
      const plain = await getTranscript('')
      expect(plain.body.messages).toEqual([SYNCED])
      expect(primary.transcriptFrames()).toHaveLength(0)
    } finally {
      primary.close()
    }
  }, 30_000)
})
