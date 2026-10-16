/**
 * GET /api/v1/file-content on a CLOUD replica, for a path in the PRIMARY's data
 * dir (`~/.open-walnut/...`). That dir is git-synced to the replica, so when
 * the primary cannot send the bytes (offline, timed out, an old daemon, over
 * the 2 MB relay cap) the replica's copy answers. The primary's "not found"
 * and "refused" stay final, and no secret or symlink escape is ever served.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-files-replica-copy', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
const bridgeState = { connected: false }
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: bridgeState.connected }),
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
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { primaryDataDirRelPath } from '../../../src/web/routes/file-content-replica-copy.js'
import { attachmentDisposition } from '../../../src/web/routes/file-content.js'
import { mediaV1Router } from '../../../src/web/routes/media-v1.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', filesV1Router)
  app.use(errorHandler)
  return app
}

/** The path as the phone names it: the primary's home, not this box's. */
const MAC = '/Users/someone/.open-walnut'
const PDF_REL = 'notes/immigration/_attachment/official-documents/Approval-Notice-2026-10-14.pdf'
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 7), Buffer.from('\n%%EOF\n')])

function binaryParser(res: NodeJS.ReadableStream & { setEncoding?: unknown }, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

/** git in the temp data repo only: never inherit a GIT_DIR from the runner. */
function git(...args: string[]): void {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  execFileSync('git', ['-C', WALNUT_HOME, ...args], { env, stdio: 'ignore' })
}

/** A file on this box that did NOT come over git-sync. */
async function putUntracked(rel: string, content: string | Buffer): Promise<string> {
  const abs = path.join(WALNUT_HOME, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
  return abs
}

/** A file git-sync brought over (tracked in the data repo). */
async function putCopy(rel: string, content: string | Buffer): Promise<string> {
  const abs = await putUntracked(rel, content)
  git('add', '-f', '--', rel)
  return abs
}

function getRaw(p: string, extra = '') {
  return request(createApp())
    .get(`/api/v1/file-content?path=${encodeURIComponent(p)}&raw=1${extra}`)
    .buffer(true).parse(binaryParser)
}

const offline = () => bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
const daemonError = (error: string) => bridgeRequestMock.mockResolvedValue({ ok: false, error })

let outside: string
beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  git('init', '-q')
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'replica-copy-outside-'))
  bridgeRequestMock.mockReset()
  bridgeState.connected = false
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(outside, { recursive: true, force: true }).catch(() => {})
})

describe('the synced copy answers when the primary cannot', () => {
  it('primary offline: a notes PDF opens from the copy, byte for byte', async () => {
    await putCopy(PDF_REL, PDF_BYTES)
    offline()
    const res = await getRaw(`${MAC}/${PDF_REL}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.headers['x-walnut-served-from']).toBe('replica-copy')
    expect(Buffer.compare(res.body as Buffer, PDF_BYTES)).toBe(0)
    // The primary was asked first, with the path exactly as the phone sent it.
    expect(bridgeRequestMock).toHaveBeenCalledWith('__local__', 'fs.readBounded', { path: `${MAC}/${PDF_REL}` }, expect.any(Number))
  })

  it('primary offline: the same file downloads, Range works, and the request repeats cleanly', async () => {
    await putCopy(PDF_REL, PDF_BYTES)
    offline()
    for (let i = 0; i < 3; i++) {
      const res = await getRaw(`${MAC}/${PDF_REL}`, '&download=1')
      expect(res.status).toBe(200)
      expect(res.headers['content-disposition']).toContain('attachment;')
      expect((res.body as Buffer).length).toBe(PDF_BYTES.length)
    }
    const part = await getRaw(`${MAC}/${PDF_REL}`).set('Range', 'bytes=0-7')
    expect(part.status).toBe(206)
    expect((part.body as Buffer).toString()).toBe('%PDF-1.7')
  })

  it('a non-ASCII file name downloads (the header keeps an ASCII stand-in plus the UTF-8 name)', async () => {
    // Test data: a CJK file name (\u7b7e\u8bc1), the case Node used to refuse.
    const rel = 'notes/docs/\u7b7e\u8bc1 notice.pdf'
    await putCopy(rel, PDF_BYTES)
    offline()
    const res = await getRaw(`${MAC}/${rel}`, '&download=1')
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="__ notice.pdf"; filename*=UTF-8''${encodeURIComponent('\u7b7e\u8bc1 notice.pdf')}`,
    )
    expect((res.body as Buffer).length).toBe(PDF_BYTES.length)
  })

  it('primary timed out (bridge up, no answer): the copy answers', async () => {
    await putCopy('notes/a.md', '# hello')
    bridgeRequestMock.mockRejectedValue(new Error('bridge request timed out after 15000ms'))
    const res = await request(createApp()).get(`/api/v1/file-content?path=${encodeURIComponent(`${MAC}/notes/a.md`)}`)
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('# hello')
    // A copy that may trail the primary never becomes an editor's write token.
    expect(res.body.contentHash).toBeUndefined()
  })

  it('over the 2 MB relay cap: the copy streams the whole file even with the primary online', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 11, 1)
    await putCopy('notes/_attachment/797.pdf', big)
    daemonError('fs.readBounded: too large (EFBIG)')
    const res = await getRaw(`${MAC}/notes/_attachment/797.pdf`)
    expect(res.status).toBe(200)
    expect((res.body as Buffer).length).toBe(big.length)
  })

  it('an old primary daemon without the bounded read: the copy answers', async () => {
    await putCopy('notes/a.txt', 'plain')
    daemonError('unknown command: fs.readBounded')
    const res = await getRaw(`${MAC}/notes/a.txt`)
    expect(res.status).toBe(200)
    expect((res.body as Buffer).toString()).toBe('plain')
  })

  it('JSON viewer on a large text copy: truncated head, real size, no hash', async () => {
    const text = 'x'.repeat(3 * 1024 * 1024)
    await putCopy('notes/long.md', text)
    offline()
    const res = await request(createApp()).get(`/api/v1/file-content?path=${encodeURIComponent(`${MAC}/notes/long.md`)}`)
    expect(res.status).toBe(200)
    expect(res.body.truncated).toBe(true)
    expect(res.body.size).toBe(text.length)
    expect(res.body.content.length).toBe(512 * 1024)
    expect(res.body.contentHash).toBeUndefined()
  })

  it('JSON viewer on a binary copy says binary', async () => {
    await putCopy(PDF_REL, Buffer.from([0x25, 0x50, 0, 0, 1, 2]))
    offline()
    const res = await request(createApp()).get(`/api/v1/file-content?path=${encodeURIComponent(`${MAC}/${PDF_REL}`)}`)
    expect(res.body).toMatchObject({ binary: true, content: null, size: 6 })
  })

  it('a `~/.open-walnut/...` path maps the same way', async () => {
    await putCopy('notes/a.md', 'tilde')
    offline()
    const res = await getRaw('~/.open-walnut/notes/a.md')
    expect(res.status).toBe(200)
    expect((res.body as Buffer).toString()).toBe('tilde')
  })
})

describe('the primary stays the authority', () => {
  it('primary online: its bytes win over an older copy', async () => {
    await putCopy('notes/a.md', 'old copy')
    bridgeRequestMock.mockResolvedValue({ ok: true, data: Buffer.from('fresh').toString('base64'), encoding: 'base64', size: 5 })
    const res = await getRaw(`${MAC}/notes/a.md`)
    expect((res.body as Buffer).toString()).toBe('fresh')
    expect(res.headers['x-walnut-served-from']).toBeUndefined()
  })

  it('primary says not found: 404, the copy is not consulted', async () => {
    await putCopy('notes/gone.md', 'stale')
    daemonError('fs.readBounded failed: ENOENT: no such file (ENOENT)')
    const res = await getRaw(`${MAC}/notes/gone.md`)
    expect(res.status).toBe(404)
    expect((res.body as Buffer).toString()).not.toContain('stale')
  })

  it('primary refused: 403, the copy is not consulted', async () => {
    await putCopy('notes/x.md', 'nope')
    daemonError('fs.readBounded: path not permitted (EDENIED)')
    const res = await getRaw(`${MAC}/notes/x.md`)
    expect(res.status).toBe(403)
  })

  it('primary offline and no copy: the 503 is unchanged', async () => {
    offline()
    const res = await request(createApp()).get(`/api/v1/file-content?path=${encodeURIComponent(`${MAC}/notes/missing.pdf`)}&raw=1`)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('another host: its data dir is not synced here, so no copy', async () => {
    await putCopy('notes/a.md', 'mac copy')
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent('/home/dev/.open-walnut/notes/a.md')}&host=devbox&raw=1`)
    expect(res.status).toBe(503)
  })
})

describe('the copy never serves a secret or leaves the data dir', () => {
  const secrets = [
    'auth.json', 'secrets/token', 'sync/bridge-tokens.json', 'config.yaml', 'notes/.env',
    'notes/.env.local', 'notes/server.pem', 'notes/id_ed25519', '.git/config', 'notes/.ssh/key',
  ]
  for (const rel of secrets) {
    it(`refuses ${rel}`, async () => {
      await putCopy(rel, 'SECRET-BYTES')
      offline()
      const res = await getRaw(`${MAC}/${rel}`)
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect((res.body as Buffer).toString()).not.toContain('SECRET-BYTES')
    })
  }

  for (const rel of ['auth.json.bak', 'config.yaml.bak', 'config.yaml.backup-20260817', '.merge_file_1Hzq2w', 'plugin-data/slack/token.json', 'notes/local-only.md']) {
    it(`refuses ${rel}, present on this box but never synced`, async () => {
      await putUntracked(rel, 'SECRET-BYTES')
      offline()
      const res = await getRaw(`${MAC}/${rel}`)
      expect(res.status).toBe(503)
      expect((res.body as Buffer).toString()).not.toContain('SECRET-BYTES')
    })
  }

  it('a symlink in the copy pointing outside the data dir is not followed', async () => {
    const target = path.join(outside, 'private.txt')
    await fs.writeFile(target, 'OUTSIDE-BYTES')
    await fs.mkdir(path.join(WALNUT_HOME, 'notes'), { recursive: true })
    await fs.symlink(target, path.join(WALNUT_HOME, 'notes', 'link.txt'))
    git('add', '--', 'notes/link.txt') // tracked link: only the escape check can stop it
    offline()
    const res = await getRaw(`${MAC}/notes/link.txt`)
    expect(res.status).toBe(503)
    expect((res.body as Buffer).toString()).not.toContain('OUTSIDE-BYTES')
  })

  it('a directory is not a file', async () => {
    await fs.mkdir(path.join(WALNUT_HOME, 'notes', 'dir'), { recursive: true })
    offline()
    const res = await getRaw(`${MAC}/notes/dir`)
    expect(res.status).toBe(503)
  })

  it('traversal is refused before anything is read', async () => {
    const res = await getRaw(`${MAC}/notes/../../etc/passwd`)
    expect(res.status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/media with the primary offline', () => {
  function mediaApp() {
    const app = express()
    app.use('/api/v1', mediaV1Router)
    app.use(errorHandler)
    return app
  }

  it('an image in the primary data dir comes from the copy', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    await putCopy('images/1760000000-abc.png', png)
    const res = await request(mediaApp())
      .get(`/api/v1/media?path=${encodeURIComponent(`${MAC}/images/1760000000-abc.png`)}`)
      .buffer(true).parse(binaryParser)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(Buffer.compare(res.body as Buffer, png)).toBe(0)
  })

  it('the primary online and saying not found: 404, the copy is not used', async () => {
    await putCopy('images/deleted.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    bridgeState.connected = true
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'not found (ENOENT)' })
    const res = await request(mediaApp()).get(`/api/v1/media?path=${encodeURIComponent(`${MAC}/images/deleted.png`)}`)
    expect(res.status).toBe(404)
  })

  it('an image outside the data dir still 404s', async () => {
    const res = await request(mediaApp()).get(`/api/v1/media?path=${encodeURIComponent('/Users/someone/Desktop/x.png')}`)
    expect(res.status).toBe(404)
  })
})

describe('helpers', () => {
  it('primaryDataDirRelPath', () => {
    expect(primaryDataDirRelPath('/Users/a/.open-walnut/notes/x.md')).toBe('notes/x.md')
    expect(primaryDataDirRelPath('~/.open-walnut/images/1.png')).toBe('images/1.png')
    expect(primaryDataDirRelPath('/Users/a/.open-walnut')).toBeNull()
    expect(primaryDataDirRelPath('/Users/a/.open-walnut/')).toBeNull()
    expect(primaryDataDirRelPath('/Users/a/project/src/x.ts')).toBeNull()
    expect(primaryDataDirRelPath('/Users/a/.open-walnut/../x')).toBeNull()
    expect(primaryDataDirRelPath('/home/dev/.open-walnut/notes/x.md')).toBe('notes/x.md')
    expect(primaryDataDirRelPath('/root/.open-walnut/notes/x.md')).toBe('notes/x.md')
    // A temp data dir (test or ephemeral server) is not the primary's home.
    expect(primaryDataDirRelPath('/var/folders/ab/T/run-1/.open-walnut/notes/x.md')).toBeNull()
    expect(primaryDataDirRelPath('/Users/a/project/.open-walnut/notes/x.md')).toBeNull()
    expect(primaryDataDirRelPath('notes/x.md')).toBeNull()
  })

  it('attachmentDisposition keeps quotes and backslashes out of the plain name', () => {
    expect(attachmentDisposition('/a/re"port\\1.pdf')).toBe(
      `attachment; filename="re_port_1.pdf"; filename*=UTF-8''${encodeURIComponent('re"port\\1.pdf')}`,
    )
    expect(attachmentDisposition('/a/plain.pdf')).toBe(`attachment; filename="plain.pdf"; filename*=UTF-8''plain.pdf`)
  })
})
