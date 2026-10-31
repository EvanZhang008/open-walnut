/**
 * /api/v1 file browsing — CLOUD_MODE (REPLICA) behavior. list / resolve-path
 * relay as box-level `server.files.*` actions (names-only metadata).
 *
 * file-content READS relay to the target host's daemon over the bridge via
 * the narrow `fs.readBounded` command (2MB cap + path sandbox enforced
 * HOST-SIDE — see src/web/routes/file-content-bridge.ts). The threat model
 * pinned here: traversal/secret paths refuse WITHOUT touching the bridge,
 * oversize → 413 too_large, bridge down → 503 bridge_offline, an old daemon
 * (no fs.readBounded) → 501 not_supported_cloud, and '' / absent host targets
 * the PRIMARY ('__local__'). WRITES still never ride the bridge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import type { Request, Response } from 'express'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-files-cloud', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
}))

import express from 'express'
import request from 'supertest'
import { filesV1Router } from '../../../src/web/routes/files-v1.js'
import { fileRawRouter } from '../../../src/web/routes/file-raw.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { serveBridgeMedia } from '../../../src/web/routes/file-content-bridge-media.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', filesV1Router)
  app.use('/api/file-raw', fileRawRouter)
  app.use(errorHandler)
  return app
}

/** One daemon-style fs.readBounded success reply. */
function daemonOk(content: string | Buffer) {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
  return { ok: true, data: buf.toString('base64'), encoding: 'base64', size: buf.length }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('files list/resolve relay on a REPLICA', () => {
  it('list relays server.files.list with path/host/showHidden', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { path: '/w', entries: [] } })
    const res = await request(createApp()).get('/api/v1/files/list?path=/w&host=devbox&showHidden=1')
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.files.list', sessionId: '__server__', params: { path: '/w', host: 'devbox', showHidden: true } },
      30_000,
    )
  })

  it('resolve-path relays server.files.resolve', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { path: '/w/x.md', resolved: true } })
    const res = await request(createApp()).get('/api/v1/files/resolve-path?rel=x.md&cwd=/w')
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.files.resolve', sessionId: '__server__', params: { rel: 'x.md', cwd: '/w' } },
      30_000,
    )
  })

  it('bridge offline → 503 bridge_offline', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/v1/files/list?path=/w')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })
})

describe('file-content bounded relay on a REPLICA', () => {
  it('remote-host JSON read relays fs.readBounded to that host and serves the payload', async () => {
    bridgeRequestMock.mockResolvedValue(daemonOk('# hello from devbox\n'))
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/readme.md&host=devbox')
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('# hello from devbox\n')
    expect(res.body.binary).toBe(false)
    expect(res.body.truncated).toBe(false)
    expect(typeof res.body.contentHash).toBe('string')
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      'devbox', 'fs.readBounded', { path: '/w/readme.md' }, expect.any(Number),
    )
  })

  it('raw=1 HTML read serves the bytes with text/html (the phone WKWebView path)', async () => {
    const html = '<!doctype html><h1>chart</h1>'
    bridgeRequestMock.mockResolvedValue(daemonOk(html))
    const res = await request(createApp()).get('/api/v1/file-content?path=/tmp/x/index.html&host=devbox&raw=1')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.text).toBe(html)
  })

  it("'' / absent host targets the PRIMARY ('__local__') daemon", async () => {
    bridgeRequestMock.mockResolvedValue(daemonOk('mac file'))
    const res = await request(createApp()).get('/api/v1/file-content?path=/Users/me/notes.txt')
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('mac file')
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'fs.readBounded', { path: '/Users/me/notes.txt' }, expect.any(Number),
    )
  })

  it('daemon EFBIG (over the 2MB cap) → 413 too_large with the friendly copy', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'fs.readBounded: too large (EFBIG)' })
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/whale.html&host=devbox&raw=1')
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('too_large')
    expect(res.body.error.message).toContain('open it on your Mac')
  })

  it('bridge offline → 503 bridge_offline (degraded, never a hang)', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/x.md&host=devbox')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('bridge request timeout → 503 bridge_offline too', async () => {
    bridgeRequestMock.mockRejectedValue(new Error('bridge request timed out: fs.readBounded → devbox'))
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/x.md&host=devbox')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('old daemon (unknown command / bridge allowlist refusal) → 501 not_supported_cloud', async () => {
    for (const error of [
      'unknown command: fs.readBounded',
      'command not permitted over bridge: fs.readBounded',
    ]) {
      bridgeRequestMock.mockResolvedValueOnce({ ok: false, error })
      const res = await request(createApp()).get('/api/v1/file-content?path=/w/x.html&host=devbox&raw=1')
      expect(res.status).toBe(501)
      expect(res.body.error.code).toBe('not_supported_cloud')
    }
  })

  it('daemon EDENIED (host-side sandbox) → 403 not_supported_cloud', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'fs.readBounded: path not permitted (EDENIED)' })
    const res = await request(createApp()).get(`/api/v1/file-content?path=${encodeURIComponent('/home/user/keys.txt')}&host=devbox`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_supported_cloud')
  })

  it('daemon ENOENT → the legacy 200-with-error viewer payload (JSON) and 404 (raw)', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: "fs.readBounded failed: ENOENT: no such file or directory, realpath '/w/gone.md' (ENOENT)" })
    const app = createApp()
    const json = await request(app).get('/api/v1/file-content?path=/w/gone.md&host=devbox')
    expect(json.status).toBe(200)
    expect(json.body.error).toBe('File not found')
    expect(json.body.content).toBeNull()
    const raw = await request(app).get('/api/v1/file-content?path=/w/gone.md&host=devbox&raw=1')
    expect(raw.status).toBe(404)
  })

  it('traversal attempt refuses WITHOUT touching the bridge', async () => {
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent('/w/../../etc/passwd')}&host=devbox`)
    expect(res.status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('replica-side secret pre-check refuses config.yaml WITHOUT touching the bridge', async () => {
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent('/w/config.yaml')}&host=devbox`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_supported_cloud')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('a replica-side oversized daemon reply is capped to 413 (stale-twin backstop)', async () => {
    // A daemon that somehow returns > 2MB must not be forwarded to the phone.
    bridgeRequestMock.mockResolvedValue(daemonOk(Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)))
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/big.txt&host=devbox')
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('too_large')
  })

  it('binary bytes from the daemon come back as the binary viewer payload (JSON mode)', async () => {
    bridgeRequestMock.mockResolvedValue(daemonOk(Buffer.from([0x00, 0x01, 0x02, 0x03])))
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/blob.bin&host=devbox')
    expect(res.status).toBe(200)
    expect(res.body.binary).toBe(true)
    expect(res.body.content).toBeNull()
  })

  it('a no-host read of a locally-present safe-root file stays LOCAL (no bridge hop)', async () => {
    const dir = path.join('/tmp/open-walnut', 'files-cloud-test')
    const p = path.join(dir, 'local.txt')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(p, 'replica-local bytes', 'utf-8')
    try {
      const res = await request(createApp()).get(`/api/v1/file-content?path=${encodeURIComponent(p)}`)
      expect(res.status).toBe(200)
      expect(res.body.content).toBe('replica-local bytes')
      expect(bridgeRequestMock).not.toHaveBeenCalled()
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// Byte-contract fixtures only: these bytes are not encoded, playable media.
const MEDIA_BYTES = Buffer.alloc(3 * 1024 * 1024 + 73)
for (let i = 0; i < MEDIA_BYTES.length; i++) MEDIA_BYTES[i] = i % 251
const MEDIA_VERSION = 'fixture-version'
function rangeReply(bytes: Buffer, params: Record<string, unknown>) {
  const offset = params.offset as number
  return { ok: true, encoding: 'base64', size: bytes.length, offset, mtimeMs: 123,
    version: MEDIA_VERSION, data: bytes.subarray(offset, offset + (params.length as number)).toString('base64') }
}
function mediaDaemon(bytes = MEDIA_BYTES) {
  bridgeRequestMock.mockImplementation(async (_host, _cmd, params) => rangeReply(bytes, params))
}
function binaryParser(res: NodeJS.ReadableStream, cb: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = []
  res.on('data', (chunk: Buffer) => chunks.push(chunk))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
  res.on('error', (err: Error) => cb(err, Buffer.concat(chunks)))
}
function rawMedia(ext = 'mp4', host = 'devbox') {
  return request(createApp()).get(`/api/v1/file-content?path=/w/bytes.${ext}&host=${host}&raw=1`)
    .buffer(true).parse(binaryParser)
}

/** An isolated HTTP listener, used to inspect abort and incomplete-body behavior. */
async function listenMedia<T>(run: (port: number) => Promise<T>): Promise<T> {
  const server = createApp().listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address() as { port: number }
    return await run(address.port)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
function interruptedBody(port: number): Promise<{ aborted: boolean; bytes: number }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/v1/file-content?path=/w/bytes.mp4&host=devbox&raw=1`, (res) => {
      let bytes = 0
      res.on('data', (b: Buffer) => { bytes += b.length })
      res.once('error', () => {})
      res.once('close', () => resolve({ aborted: !res.complete, bytes }))
    })
    req.once('error', reject)
  })
}

// 2026-10-31: the phone's HTML preview of a page of relative iframes. The
// replica answered the path-shaped URL with a 302 to the query-shaped one, so
// the document's URL lost its directory and every relative reference resolved
// to /api/v1/<name> (a 401 the phone read as "Not paired"). The path-shaped
// URL must be served IN PLACE, on both mounts, for the Mac and a remote host.
describe('path-shaped file-raw is served in place on a REPLICA (no redirect)', () => {
  const cases = [
    { url: '/api/v1/file-raw/local/Users/me/mock%20ups/index.html', host: '__local__', path: '/Users/me/mock ups/index.html' },
    { url: '/api/v1/file-raw/devbox/~/proj/index.html', host: 'devbox', path: '~/proj/index.html' },
    { url: '/api/file-raw/local/Users/me/proj/index.html', host: '__local__', path: '/Users/me/proj/index.html' },
    { url: '/api/file-raw/devbox/home/me/proj/index.html', host: 'devbox', path: '/home/me/proj/index.html' },
  ]
  for (const c of cases) {
    it(`${c.url} relays to ${c.host} and answers 200 text/html`, async () => {
      const html = '<!doctype html><iframe src="01-inbox-lines.html"></iframe>'
      bridgeRequestMock.mockResolvedValue(daemonOk(html))
      const res = await request(createApp()).get(c.url).redirects(0)
      expect(res.status).toBe(200)
      expect(res.headers.location).toBeUndefined()
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.text).toBe(html)
      expect(bridgeRequestMock).toHaveBeenCalledWith(c.host, 'fs.readBounded', { path: c.path }, expect.any(Number))
    })
  }

  it('a sibling the document references relatively resolves under the same route', async () => {
    bridgeRequestMock.mockResolvedValue(daemonOk('<p>one</p>'))
    const docUrl = new URL('http://companion/api/v1/file-raw/local/Users/me/proj/index.html')
    const sibling = new URL('01-inbox-lines.html', docUrl)
    const res = await request(createApp()).get(sibling.pathname).redirects(0)
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith('__local__', 'fs.readBounded', { path: '/Users/me/proj/01-inbox-lines.html' }, expect.any(Number))
  })

  it('download=1 still forces an attachment, and the sandbox still refuses a secret path before the bridge', async () => {
    bridgeRequestMock.mockResolvedValue(daemonOk('a,b\n'))
    const dl = await request(createApp()).get('/api/v1/file-raw/local/Users/me/x.csv?download=1')
    expect(dl.status).toBe(200)
    expect(dl.headers['content-disposition']).toContain('attachment')
    bridgeRequestMock.mockReset()
    const secret = await request(createApp()).get('/api/v1/file-raw/local/Users/me/.open-walnut/config.yaml')
    expect(secret.status).toBe(403)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })
})

describe('raw media uses guarded bridge chunks', () => {
  it('streams more than 2 MB byte-exact with sequential chunks, the raw host, and deadlines', async () => {
    mediaDaemon()
    const res = await rawMedia('mp4', 'named-host')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('video/mp4')
    expect(res.headers['content-length']).toBe(String(MEDIA_BYTES.length))
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(res.body).toEqual(MEDIA_BYTES)
    const calls = bridgeRequestMock.mock.calls
    expect(calls).toHaveLength(5)
    expect(calls[0]).toEqual(['named-host', 'fs.readBounded', { path: '/w/bytes.mp4', range: true, offset: 0, length: 0 }, 15_000])
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i][0]).toBe('named-host')
      expect(calls[i][1]).toBe('fs.readBounded')
      expect(calls[i][2]).toMatchObject({ range: true, expectedVersion: MEDIA_VERSION, offset: (i - 1) * 1024 * 1024 })
      expect(calls[i][2].length).toBeLessThanOrEqual(1024 * 1024)
      expect(calls[i][3]).toBe(15_000)
    }
  })

  it('seeks across chunk boundaries, supports suffix/open/clamped ranges, and repeats cleanly', async () => {
    mediaDaemon()
    for (const [header, start, end] of [
      ['bytes=17-2097172', 17, 2097172], ['bytes=-71', MEDIA_BYTES.length - 71, MEDIA_BYTES.length - 1],
      ['bytes=3145798-', 3145798, MEDIA_BYTES.length - 1], ['bytes=3145798-9999999', 3145798, MEDIA_BYTES.length - 1],
    ] as const) {
      const res = await rawMedia().set('Range', header)
      expect(res.status).toBe(206)
      expect(res.headers['content-range']).toBe(`bytes ${start}-${end}/${MEDIA_BYTES.length}`)
      expect(res.body).toEqual(MEDIA_BYTES.subarray(start, end + 1))
    }
  })

  it('uses a safe strong ETag and never resumes a new version under an old If-Range validator', async () => {
    let bytes = Buffer.from('first version bytes')
    let version = 'first|version\r\nunsafe-header-text'
    bridgeRequestMock.mockImplementation(async (_host, _cmd, params) => ({ ...rangeReply(bytes, params), version }))
    const first = await rawMedia()
    const etag = first.headers.etag
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/)
    const matching = await rawMedia().set('Range', 'bytes=2-4').set('If-Range', etag)
    expect(matching.status).toBe(206)
    expect(matching.body).toEqual(bytes.subarray(2, 5))
    version = 'second|version'
    bytes = Buffer.from('new replacement bytes')
    for (const validator of [etag, `W/${etag}`, 'Thu, 01 Jan 1970 00:00:00 GMT', 'invalid']) {
      const response = await rawMedia().set('Range', 'bytes=2-4').set('If-Range', validator)
      expect(response.status).toBe(200)
      expect(response.headers['content-range']).toBeUndefined()
      expect(response.headers.etag).not.toBe(etag)
      expect(response.body).toEqual(bytes)
    }
  })

  it('matching conditional validators avoid all media chunks', async () => {
    mediaDaemon()
    const first = await rawMedia().set('Range', 'bytes=0-1')
    const etag = first.headers.etag
    for (const validator of [etag, `W/${etag}`, '*']) {
      bridgeRequestMock.mockClear()
      const response = await rawMedia().set('If-None-Match', validator)
      expect(response.status).toBe(304)
      expect(response.headers.etag).toBe(etag)
      expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
    }
    expect((await rawMedia().set('If-None-Match', '"another-version"').set('Range', 'bytes=0-1')).status).toBe(206)
  })

  it('HEAD probes metadata only, ignoring range headers and preserving download', async () => {
    mediaDaemon()
    const res = await request(createApp()).head('/api/v1/file-content?path=/w/bytes.m4a&host=devbox&raw=1&download=1')
      .set('Range', 'bytes=20-39')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('audio/mp4')
    expect(res.headers['content-length']).toBe(String(MEDIA_BYTES.length))
    expect(res.headers['content-range']).toBeUndefined()
    expect(res.headers['content-disposition']).toContain('attachment;')
    expect(res.text).toBeUndefined()
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
  })

  it('returns 416 for unsatisfiable/invalid ranges and for a range on an empty file', async () => {
    mediaDaemon()
    for (const header of [`bytes=${MEDIA_BYTES.length}-`, 'bytes=9-2', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-1', 'bytes=0-9007199254740992', 'bytes=-9007199254740992', 'bytes=9007199254740992-']) {
      const res = await rawMedia().set('Range', header)
      expect(res.status).toBe(416)
      expect(res.headers['content-range']).toBe(`bytes */${MEDIA_BYTES.length}`)
    }
    mediaDaemon(Buffer.alloc(0))
    const empty = await rawMedia()
    expect(empty.status).toBe(200)
    expect(empty.headers['content-length']).toBe('0')
    expect(empty.body.length).toBe(0)
    const range = await rawMedia().set('Range', 'bytes=-3')
    expect(range.status).toBe(416)
    expect(range.headers['content-range']).toBe('bytes */0')
    expect(bridgeRequestMock.mock.calls.every((c) => c[2].length === 0)).toBe(true)
  })

  it('uses the range lane for each media extension but leaves JSON and document caps unchanged', async () => {
    for (const ext of ['mp4', 'm4v', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'ogg']) {
      mediaDaemon(Buffer.from([1, 2, 3]))
      expect((await rawMedia(ext)).status).toBe(200)
    }
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'fs.readBounded: too large (EFBIG)' })
    expect((await request(createApp()).get('/api/v1/file-content?path=/w/bytes.mp4&host=devbox')).status).toBe(413)
    expect((await rawMedia('pdf')).status).toBe(413)
    expect(bridgeRequestMock.mock.calls.at(-1)![2]).toEqual({ path: '/w/bytes.pdf' })
  })

  it('an old daemon\'s whole file within the 2 MB cap is served whole, as before the range lane', async () => {
    bridgeRequestMock.mockResolvedValue(daemonOk('old whole bytes'))
    const res = await rawMedia()
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('old whole bytes')
    expect(res.headers['content-length']).toBe('15')
    expect(res.headers['accept-ranges']).toBeUndefined()
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
  })

  it('old oversized whole-file replies or commands return 501, never interpreting whole data as a chunk', async () => {
    for (const reply of [daemonOk(Buffer.alloc(2 * 1024 * 1024 + 1)),
      { ok: false, error: 'unknown command: fs.readBounded' },
      { ok: false, error: 'fs.readBounded: too large (EFBIG)' }]) {
      bridgeRequestMock.mockResolvedValue(reply)
      const res = await rawMedia()
      expect(res.status, JSON.stringify({ reply, calls: bridgeRequestMock.mock.calls, body: res.body.toString() })).toBe(501)
      expect(JSON.parse(res.body.toString()).error.code).toBe('not_supported_cloud')
    }
  })

  it('preserves secret/not-found/offline failure mapping and rejects traversal before RPC', async () => {
    for (const [error, status] of [
      ['fs.readBounded: path not permitted (EDENIED)', 403], ['fs.readBounded failed (ENOENT)', 404],
    ] as const) {
      bridgeRequestMock.mockResolvedValue({ ok: false, error })
      expect((await rawMedia()).status).toBe(status)
    }
    bridgeRequestMock.mockRejectedValue(new Error('bridge request timed out'))
    expect((await rawMedia()).status).toBe(503)
    bridgeRequestMock.mockReset()
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/../secret.mp4&host=devbox&raw=1')
    expect(res.status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('cuts the stream on short, changed, oversized, wrong-offset, refused, or timed-out chunks; retry works', async () => {
    const bad = [
      (r: Record<string, unknown>) => ({ ...r, data: Buffer.from([1]).toString('base64') }),
      (r: Record<string, unknown>) => ({ ...r, version: 'new-version' }),
      (r: Record<string, unknown>) => ({ ...r, offset: 99 }),
      (r: Record<string, unknown>) => ({ ...r, data: Buffer.alloc(1024 * 1024 + 1).toString('base64') }),
      () => ({ ok: false, error: 'fs.readBounded: file changed (ESTALE)' }),
      () => { throw new Error('bridge request timed out') },
    ]
    for (const mutate of bad) {
      bridgeRequestMock.mockImplementation(async (_host, _cmd, p) => {
        const reply = rangeReply(MEDIA_BYTES, p)
        return p.offset >= 1024 * 1024 ? mutate(reply) : reply
      })
      await listenMedia(async (port) => {
        const result = await interruptedBody(port)
        expect(result).toEqual({ aborted: true, bytes: 1024 * 1024 })
      })
    }
    mediaDaemon()
    expect((await rawMedia().set('Range', 'bytes=0-9')).body).toEqual(MEDIA_BYTES.subarray(0, 10))
  })

  it('client abort during a pending read ends the route and starts no subsequent chunks', async () => {
    let release!: (value: unknown) => void
    let readStarted!: () => void
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    bridgeRequestMock.mockImplementation(async (_host, _cmd, p) => {
      if (p.length === 0) return rangeReply(MEDIA_BYTES, p)
      readStarted()
      return new Promise((resolve) => { release = resolve })
    })
    await listenMedia(async (port) => {
      const req = http.get(`http://127.0.0.1:${port}/api/v1/file-content?path=/w/bytes.mp4&host=devbox&raw=1`)
      req.on('error', () => {})
      const [res] = await once(req, 'response')
      res.on('error', () => {})
      const closed = new Promise<void>((resolve) => res.once('close', resolve))
      await started
      req.destroy()
      await closed
      release(rangeReply(MEDIA_BYTES, { offset: 0, length: 1024 * 1024 }))
    })
    expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
  })

  it('waits for response drain before the next chunk, and close releases backpressure', async () => {
    const { EventEmitter } = await import('node:events')
    const res = new EventEmitter() as EventEmitter & Response
    Object.assign(res, { destroyed: false, writableEnded: false })
    res.status = vi.fn(() => res)
    res.set = vi.fn(() => res)
    res.flushHeaders = vi.fn()
    let wrote!: () => void
    let written = new Promise<void>((resolve) => { wrote = resolve })
    res.write = vi.fn(() => { wrote(); return false })
    mediaDaemon()
    const work = serveBridgeMedia({ headers: {}, method: 'GET' } as Request, res, 'devbox', '/w/bytes.mp4', 'video/mp4', false)
    await written
    expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
    expect(res.listenerCount('drain')).toBe(1)
    written = new Promise<void>((resolve) => { wrote = resolve })
    res.emit('drain')
    await written
    expect(bridgeRequestMock).toHaveBeenCalledTimes(3)
    res.emit('close')
    await work
    expect(bridgeRequestMock).toHaveBeenCalledTimes(3)
    expect(res.listenerCount('drain')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('destroys a stream after 15s of backpressure and removes drain/close listeners', async () => {
    const { EventEmitter } = await import('node:events')
    const res = new EventEmitter() as EventEmitter & Response
    Object.assign(res, { destroyed: false, writableEnded: false })
    res.status = vi.fn(() => res)
    res.set = vi.fn(() => res)
    res.flushHeaders = vi.fn()
    res.write = vi.fn(() => false)
    res.destroy = vi.fn(() => { res.emit('close'); return res })
    mediaDaemon()
    vi.useFakeTimers()
    try {
      const work = serveBridgeMedia({ headers: {}, method: 'GET' } as Request, res, 'devbox', '/w/bytes.mp4', 'video/mp4', false)
      await vi.advanceTimersByTimeAsync(0)
      expect(res.write).toHaveBeenCalledTimes(1)
      expect(res.listenerCount('drain')).toBe(1)
      await vi.advanceTimersByTimeAsync(14_999)
      expect(res.destroy).not.toHaveBeenCalled()
      expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await work
      expect(res.destroy).toHaveBeenCalledTimes(1)
      expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
      expect(res.listenerCount('drain')).toBe(0)
      expect(res.listenerCount('close')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('enforces the 15s deadline even on a bridge promise that never settles', async () => {
    // Invoke the real streaming helper with a writable test response so fake
    // timers do not alter supertest or socket scheduling.
    const { EventEmitter } = await import('node:events')
    const res = new EventEmitter() as EventEmitter & Response
    Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false })
    res.status = vi.fn(() => res)
    res.set = vi.fn(() => res)
    res.flushHeaders = vi.fn()
    res.destroy = vi.fn(() => { res.emit('close'); return res })
    bridgeRequestMock.mockImplementation(async (_host, _cmd, p) => p.length === 0
      ? rangeReply(MEDIA_BYTES, p) : new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const work = serveBridgeMedia({ headers: {}, method: 'GET' } as Request, res, 'devbox', '/w/bytes.mp4', 'video/mp4', false)
      await vi.advanceTimersByTimeAsync(15_001)
      await work
      expect(res.destroy).toHaveBeenCalledTimes(1)
      expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
})

describe('file-content WRITE threat model on a REPLICA (unchanged)', () => {
  it('remote-host write still answers 501, never touches the bridge', async () => {
    const res = await request(createApp())
      .put('/api/v1/file-content')
      .send({ path: '/w/x.md', host: 'devbox', content: 'overwrite' })
    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('not_supported_cloud')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })
})
