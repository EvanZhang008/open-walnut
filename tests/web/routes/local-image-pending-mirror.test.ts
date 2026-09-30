/**
 * A remote session's picture must show on its FIRST render, not after a remount.
 *
 * Reported shape (2026-09-29, an image pasted into a remote-host session): the
 * user bubble showed a broken-image icon above the path. The server log had it:
 *
 *   18:03:48.327  GET /history            (the rewrite mints the mirror slot and
 *                                          starts its download, fire-and-forget)
 *   18:03:48.453  GET /api/local-image    → 404, "remote-image not found on host"
 *   18:03:48.380  (mtime) mirror bytes land on disk
 *
 * The <img> asked ~40ms before the bytes landed. The route found no file, then
 * asked the remote host for the MIRROR path itself (a hash-keyed local slot that
 * never exists on the host), got ENOENT, and answered 404. A browser never retries
 * a failed <img>, so the picture stayed broken until the panel remounted.
 *
 * Scenarios pinned here, all through the real route over real HTTP:
 *  - history replay hands out a slot whose download is slow → the request waits
 *    and gets the bytes (the reported race);
 *  - the same through the live stream rewrite (RemoteSessionManager.processInbound);
 *  - several <img> requests at once for one pending slot → every one gets 200;
 *  - history replay AND the live stream both mint the same slot mid-download →
 *    one remote read, not two;
 *  - a download that ends in not-found → a prompt 404, and a later replay can
 *    start a fresh download (nothing stays stuck as "pending");
 *  - a slot already on disk → served straight from disk, no daemon read;
 *  - the phone's /api/v1/media reads the same slots → it waits the same way.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-local-image-pending'))

const sendMock = vi.fn()
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => ({ send: sendMock }),
}))
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { remotehost: { hostname: 'remote.example.com', user: 'admin' } } }),
}))
// The route's "identical path on the remote host" fallback resolves a slot's
// session to its host. Answer like the real tracker does for a remote session.
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async () => ({ host: 'remotehost' }),
}))

import { WALNUT_HOME, REMOTE_IMAGES_DIR } from '../../../src/constants.js'
import { localImageRouter } from '../../../src/web/routes/local-image.js'
import { mediaV1Router } from '../../../src/web/routes/media-v1.js'
import { rewriteHistoryRemoteImages } from '../../../src/core/session-history.js'
import type { SessionHistoryMessage } from '../../../src/core/session-history.js'
import { RemoteSessionManager } from '../../../src/providers/remote-session-manager.js'
import { clearFailedFetches, sessionMirrorPath } from '../../../src/core/remote-image-mirror.js'
import type { SshTarget } from '../../../src/providers/session-io.js'

const SID = 'cf6046dc-0000-4477-a79c-4ea1f636bbd8'
/** Where prepareOutbound uploads a pasted image on the remote host. */
const UPLOADED = '/tmp/open-walnut-images/1790705022889-5699cb5ab1a0.png'
const PNG = Buffer.from('89504e470d0a1a0a-pasted-image-bytes')

let baseUrl = ''
let server: http.Server

beforeAll(async () => {
  const app = express()
  app.use('/api/local-image', localImageRouter)
  app.use('/api/v1', mediaV1Router)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  await fsp.rm(REMOTE_IMAGES_DIR, { recursive: true, force: true })
  sendMock.mockReset()
  clearFailedFetches()
})

/**
 * A daemon whose fs.read of UPLOADED answers after `delayMs` (with the bytes, or
 * with ENOENT when `uploadedExists` is false); every other path (the mirror path
 * included, which only exists on THIS machine) is ENOENT at once.
 */
function slowDaemon(delayMs: number, opts: { uploadedExists?: boolean } = {}) {
  const exists = opts.uploadedExists ?? true
  return async (cmd: string, params: { path: string }) => {
    if (cmd === 'fs.read') {
      if (params.path === UPLOADED) {
        await new Promise((r) => setTimeout(r, delayMs))
        if (exists) return { ok: true, data: PNG.toString('base64') }
      }
      return { ok: false, error: `ENOENT: no such file or directory, open '${params.path}'` }
    }
    if (cmd === 'fs.stat') {
      return params.path === UPLOADED && exists
        ? { ok: true, exists: true, mtimeMs: 1790705024295, size: PNG.length }
        : { ok: true, exists: false }
    }
    return { ok: false, error: 'unknown command' }
  }
}

const readsOf = (p: string) =>
  sendMock.mock.calls.filter((c) => c[0] === 'fs.read' && (c[1] as { path: string }).path === p).length

function userBubble(): SessionHistoryMessage[] {
  return [{
    role: 'user',
    text: `The user attached an image. Read this file for visual context:\n\n${UPLOADED}\n\nInvestigate this`,
    timestamp: '2026-09-29T18:03:43.000Z',
  } as SessionHistoryMessage]
}

/** Replay history the way GET /history does and return the slot the bubble names. */
async function replayHistory(): Promise<string> {
  const [msg] = await rewriteHistoryRemoteImages(userBubble(), 'remotehost', SID)
  const slot = sessionMirrorPath(SID, UPLOADED)
  expect(msg.text).toContain(slot)
  expect(msg.text).not.toContain(UPLOADED)
  return slot
}

const getImage = (p: string) => fetch(`${baseUrl}/api/local-image?path=${encodeURIComponent(p)}`)

function makeManager(): RemoteSessionManager {
  const target: SshTarget = { hostname: 'remote.example.com', user: 'admin', use_daemon: true }
  const mgr = new RemoteSessionManager(SID, 'remotehost', target)
  ;(mgr as unknown as { conn: unknown }).conn = { connected: true, send: sendMock }
  return mgr
}

describe('GET /api/local-image for a mirror slot that is still downloading', () => {
  it('waits for the history replay download instead of answering 404', async () => {
    sendMock.mockImplementation(slowDaemon(150))
    const slot = await replayHistory()
    expect(fs.existsSync(slot)).toBe(false) // the race: bytes are not here yet

    const res = await getImage(slot)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
    expect(res.headers.get('content-type')).toBe('image/png')
    // The route never asked the host for the mirror path: it only exists here.
    expect(readsOf(slot)).toBe(0)
  })

  it('waits for the live stream rewrite download too', async () => {
    sendMock.mockImplementation(slowDaemon(150))
    const mgr = makeManager()
    const text = mgr.processInbound(userBubble()[0].text!, SID)
    const slot = sessionMirrorPath(SID, UPLOADED)
    expect(text).toContain(slot)

    const res = await getImage(slot)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('answers every concurrent request for one pending slot', async () => {
    sendMock.mockImplementation(slowDaemon(150))
    const slot = await replayHistory()

    const all = await Promise.all([getImage(slot), getImage(slot), getImage(slot)])
    expect(all.map((r) => r.status)).toEqual([200, 200, 200])
    expect(readsOf(UPLOADED)).toBe(1)
  })

  it('shares one remote read between history replay and the live stream', async () => {
    sendMock.mockImplementation(slowDaemon(150))
    const slot = await replayHistory()
    makeManager().processInbound(userBubble()[0].text!, SID) // same slot, mid-download
    await replayHistory() // a second replay (refocus) while still downloading

    expect((await getImage(slot)).status).toBe(200)
    expect(readsOf(UPLOADED)).toBe(1)
  })

  it('answers 404 promptly when the download ends in not-found, and nothing stays pending', async () => {
    sendMock.mockImplementation(slowDaemon(150, { uploadedExists: false }))
    const slot = await replayHistory()
    expect(fs.existsSync(slot)).toBe(false)

    const started = Date.now()
    const res = await getImage(slot)
    expect(res.status).toBe(404)
    expect(Date.now() - started).toBeLessThan(2_000)
    // Having waited on the slot's own download, the route did not go on to ask
    // the host for the local mirror path (it cannot exist there).
    expect(readsOf(slot)).toBe(0)

    // The file shows up on the host later; once the miss window is over, a
    // replay starts a NEW download (the failed one is not still "pending").
    clearFailedFetches()
    sendMock.mockImplementation(slowDaemon(50))
    await replayHistory()
    const again = await getImage(slot)
    expect(again.status).toBe(200)
  })

  it('serves a slot already on disk without touching the daemon', async () => {
    const slot = sessionMirrorPath(SID, UPLOADED)
    await fsp.mkdir(REMOTE_IMAGES_DIR + '/' + SID, { recursive: true })
    await fsp.writeFile(slot, PNG)
    sendMock.mockImplementation(slowDaemon(0))

    const res = await getImage(slot)
    expect(res.status).toBe(200)
    expect(readsOf(UPLOADED)).toBe(0)
  })

  it('makes the phone route wait the same way', async () => {
    sendMock.mockImplementation(slowDaemon(150))
    const slot = await replayHistory()

    const res = await fetch(`${baseUrl}/api/v1/media?path=${encodeURIComponent(slot)}&session=${SID}`)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
    expect(readsOf(slot)).toBe(0)
  })
})
