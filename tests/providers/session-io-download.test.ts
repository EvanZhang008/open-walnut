/**
 * Remote → local image download (the reverse image proxy).
 *
 * HISTORY: this suite used to test `downloadRemoteImage()` +
 * `rewriteRemoteImagePaths()` in session-io.ts, which shelled out to `scp`.
 * The daemon transport refactor (08182ce) deleted both — the download now rides
 * the daemon's `fs.read` RPC and the rewrite lives in
 * `RemoteSessionManager.processInbound()`, with the per-remote-path cache moved
 * from a caller-owned Map to the manager's own `_imageCache`. The BEHAVIOUR is
 * unchanged and still load-bearing: rewrite every remote image path to a local
 * one SYNCHRONOUSLY (so downstream events only ever see local paths) while the
 * bytes are fetched in the background.
 *
 * `findRemoteImagePaths` / `findImagePaths` still live in session-io.ts and are
 * covered here unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { findImagePaths, findRemoteImagePaths } from '../../src/providers/session-io.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR, REMOTE_IMAGES_DIR } from '../../src/constants.js'
import type { SshTarget } from '../../src/providers/session-io.js'

const tmpBase = WALNUT_HOME

const REMOTE_TARGET: SshTarget = { hostname: 'remote.example.com', user: 'admin', use_daemon: true }

/**
 * Minimal DaemonConnection stand-in — processInbound/downloadRemoteFile only use
 * `.connected` and `.send()`. Default: every fs.read returns `payload` bytes.
 */
function makeConn(
  sendImpl?: (cmd: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  return {
    connected: true,
    send: vi.fn(sendImpl ?? (async () => ({ ok: true, data: Buffer.from('remote-png-bytes').toString('base64') }))),
  }
}

function injectConn(mgr: RemoteSessionManager, conn: unknown): void {
  ;(mgr as unknown as { conn: unknown }).conn = conn
}

/** Paths the manager asked the daemon to read, in call order. */
function readPaths(conn: ReturnType<typeof makeConn>): string[] {
  return conn.send.mock.calls.filter((c) => c[0] === 'fs.read').map((c) => (c[1] as { path: string }).path)
}

/** Let the fire-and-forget downloadRemoteFile() promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 10))

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('findRemoteImagePaths', () => {
  it('finds absolute image paths in text', () => {
    const text = 'Screenshot at /tmp/open-walnut-images/abc123/screenshot.png and /home/user/photo.jpg'
    const paths = findRemoteImagePaths(text)
    expect(paths).toHaveLength(2)
    expect(paths).toContain('/tmp/open-walnut-images/abc123/screenshot.png')
    expect(paths).toContain('/home/user/photo.jpg')
  })

  it('deduplicates paths', () => {
    const text = '/tmp/img.png appears twice: /tmp/img.png'
    const paths = findRemoteImagePaths(text)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/tmp/img.png')
  })

  it('returns empty array for text without image paths', () => {
    const paths = findRemoteImagePaths('Hello world, no images here')
    expect(paths).toHaveLength(0)
  })

  it('matches various image extensions', () => {
    const text = '/a.png /b.jpg /c.jpeg /d.gif /e.webp /f.bmp /g.tiff'
    const paths = findRemoteImagePaths(text)
    expect(paths).toHaveLength(7)
  })

  it('does NOT require files to exist on local disk (unlike findLocalImagePaths)', () => {
    // Remote paths won't exist locally — that's fine, we don't stat them
    const text = '/nonexistent/path/remote-screenshot.png'
    const paths = findRemoteImagePaths(text)
    expect(paths).toHaveLength(1)
  })
})

describe('RemoteSessionManager download (daemon fs.read)', () => {
  it('reads the remote path via the daemon and writes the bytes locally', async () => {
    const mgr = new RemoteSessionManager('sid-dl', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)

    mgr.processInbound('Screenshot at /tmp/open-walnut-images/abc/screenshot.png', 'session-abc')
    await settle()

    expect(readPaths(conn)).toEqual(['/tmp/open-walnut-images/abc/screenshot.png'])
    expect(conn.send.mock.calls[0][1]).toMatchObject({ encoding: 'base64' })

    const localPath = path.join(REMOTE_IMAGES_DIR, 'session-abc', 'screenshot.png')
    expect(fs.readFileSync(localPath, 'utf-8')).toBe('remote-png-bytes')
  })

  it('creates the per-session local directory if missing', async () => {
    const mgr = new RemoteSessionManager('sid-mkdir', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    const localDir = path.join(REMOTE_IMAGES_DIR, 'session-nested')
    expect(fs.existsSync(localDir)).toBe(false)

    mgr.processInbound('See /tmp/remote.png', 'session-nested')
    await settle()

    expect(fs.existsSync(localDir)).toBe(true)
  })

  it('tolerates a failing download — the path is still rewritten', async () => {
    const mgr = new RemoteSessionManager('sid-dlfail', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn(async () => { throw new Error('daemon command timeout: fs.read') }))

    // Rewrite must NOT depend on the download: it happens synchronously so
    // downstream events never leak a remote path, and /api/local-image
    // re-fetches on demand if the background read lost the race.
    const result = mgr.processInbound('See /tmp/broken.png', 'session-fail')
    expect(result).toContain(path.join(REMOTE_IMAGES_DIR, 'session-fail', 'broken.png'))

    await expect(settle()).resolves.toBeUndefined()
    expect(fs.existsSync(path.join(REMOTE_IMAGES_DIR, 'session-fail', 'broken.png'))).toBe(false)
  })

  it('writes nothing when the daemon replies ok:false', async () => {
    const mgr = new RemoteSessionManager('sid-notok', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn(async () => ({ ok: false, error: 'fs.read failed: ENOENT' })))

    mgr.processInbound('See /tmp/missing.png', 'session-notok')
    await settle()

    expect(fs.existsSync(path.join(REMOTE_IMAGES_DIR, 'session-notok', 'missing.png'))).toBe(false)
  })
})

describe('RemoteSessionManager.processInbound (remote → local path rewrite)', () => {
  it('rewrites remote paths to local paths', () => {
    const mgr = new RemoteSessionManager('sid-rw', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    const result = mgr.processInbound(
      'Screenshot at /tmp/open-walnut-images/abc123/screenshot.png done.',
      'session-abc',
    )

    expect(result).toContain(path.join('images', 'remote', 'session-abc', 'screenshot.png'))
    expect(result).not.toContain('/tmp/open-walnut-images/')
  })

  it('caches paths to avoid re-downloading', async () => {
    const mgr = new RemoteSessionManager('sid-cache', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)

    mgr.processInbound('/tmp/img.png appears here', 'sess')
    await settle()
    expect(readPaths(conn)).toHaveLength(1)

    // Second pass over the same path: served from _imageCache, no second read.
    conn.send.mockClear()
    mgr.processInbound('/tmp/img.png appears here', 'sess')
    await settle()
    expect(readPaths(conn)).toHaveLength(0)
  })

  it('returns text unchanged when no image paths', () => {
    const mgr = new RemoteSessionManager('sid-noimg', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    const text = 'No images in this text.'
    expect(mgr.processInbound(text, 's')).toBe(text)
  })

  it('rewrites multiple paths in one call', () => {
    const mgr = new RemoteSessionManager('sid-rwmulti', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    const result = mgr.processInbound('/tmp/a.png and /tmp/b.jpg and /tmp/a.png again', 'session-multi')

    expect(result).not.toContain('/tmp/a.png')
    expect(result).not.toContain('/tmp/b.jpg')
    expect(result).toContain(path.join('images', 'remote', 'session-multi', 'a.png'))
    expect(result).toContain(path.join('images', 'remote', 'session-multi', 'b.jpg'))
    expect(mgr.imageCache.size).toBe(2)
  })

  it('skips download if local file already exists', async () => {
    const localDir = path.join(REMOTE_IMAGES_DIR, 'session-exists')
    fs.mkdirSync(localDir, { recursive: true })
    fs.writeFileSync(path.join(localDir, 'cached.png'), 'data')

    const mgr = new RemoteSessionManager('sid-exists', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)

    mgr.processInbound('/tmp/cached.png is already local', 'session-exists')
    await settle()

    expect(readPaths(conn)).toHaveLength(0)
  })

  it('handles paths with spaces in backticks', () => {
    const mgr = new RemoteSessionManager('sid-space', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    const result = mgr.processInbound(
      'See `/workplace/user/Screenshot 2026-02-17 at 11.12.47 PM.png` for details',
      'sess-space',
    )

    expect(result).not.toContain('/workplace/user/Screenshot 2026-02-17 at 11.12.47 PM.png')
    expect(result).toContain(path.join('images', 'remote', 'sess-space', 'Screenshot 2026-02-17 at 11.12.47 PM.png'))
    expect(mgr.imageCache.size).toBe(1)
  })

  it('handles paths with spaces in double quotes', () => {
    const mgr = new RemoteSessionManager('sid-dq', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    const result = mgr.processInbound('File at "/tmp/open-walnut-images/abc/My Screenshot.png" saved', 'sess-dq')

    expect(result).not.toContain('/tmp/open-walnut-images/abc/My Screenshot.png')
    expect(result).toContain(path.join('images', 'remote', 'sess-dq', 'My Screenshot.png'))
  })

  it('leaves already-local cache paths alone (no download loop)', async () => {
    const mgr = new RemoteSessionManager('sid-idem', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)

    // A path already under REMOTE_IMAGES_DIR is our OWN output. Re-downloading
    // it would ask the remote host for a local-only path (guaranteed ENOENT)
    // and, worse, nest images/remote/<sid>/images/remote/... on every pass.
    const already = path.join(REMOTE_IMAGES_DIR, 'sess-idem', 'already.png')
    const text = `See ${already}`

    expect(mgr.processInbound(text, 'sess-idem')).toBe(text)
    await settle()
    expect(readPaths(conn)).toHaveLength(0)
  })

  it('is a no-op for the local daemon (__local__ shares the filesystem)', () => {
    const mgr = new RemoteSessionManager('sid-localin', '__local__', null)
    const conn = makeConn()
    injectConn(mgr, conn)

    const text = 'See /tmp/local-only.png'
    expect(mgr.processInbound(text, 'sess-local')).toBe(text)
    expect(conn.send).not.toHaveBeenCalled()
  })
})

describe('findImagePaths (space-aware path detection)', () => {
  it('finds unquoted paths without spaces', () => {
    const paths = findImagePaths('/tmp/test.png and /home/user/photo.jpg')
    expect(paths).toHaveLength(2)
    expect(paths).toContain('/tmp/test.png')
    expect(paths).toContain('/home/user/photo.jpg')
  })

  it('finds backtick-quoted paths with spaces', () => {
    const paths = findImagePaths('See `/workplace/Screenshot 2026-02-17 at 11.12.47 PM.png` here')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/workplace/Screenshot 2026-02-17 at 11.12.47 PM.png')
  })

  it('finds double-quoted paths with spaces', () => {
    const paths = findImagePaths('File at "/tmp/My Folder/image file.png" done')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/tmp/My Folder/image file.png')
  })

  it('finds single-quoted paths with spaces', () => {
    const paths = findImagePaths("File at '/tmp/My Folder/image file.png' done")
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/tmp/My Folder/image file.png')
  })

  it('finds paths in JSON values', () => {
    const json = '{"file_path": "/workspace/remote/Screenshot 2026.png", "other": 123}'
    const paths = findImagePaths(json)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/workspace/remote/Screenshot 2026.png')
  })

  it('finds both quoted (spaced) and unquoted (no-space) paths in same text', () => {
    const text = 'Unquoted /tmp/simple.png and quoted `/home/user/My Screenshot.jpg` together'
    const paths = findImagePaths(text)
    expect(paths).toHaveLength(2)
    expect(paths).toContain('/tmp/simple.png')
    expect(paths).toContain('/home/user/My Screenshot.jpg')
  })

  it('deduplicates across quoted and unquoted matches', () => {
    const text = '/tmp/same.png and "/tmp/same.png" and `/tmp/same.png`'
    const paths = findImagePaths(text)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/tmp/same.png')
  })

  it('does not match non-image extensions', () => {
    const paths = findImagePaths('`/tmp/file.txt` and "/home/doc.pdf"')
    expect(paths).toHaveLength(0)
  })

  it('handles paths with spaces and nested directories', () => {
    const text = 'Screenshot saved to `/home/user/projects/my-app-main/src/my-app/Screenshot 2026-02-17 at 11.12.47 PM.png`'
    const paths = findImagePaths(text)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/home/user/projects/my-app-main/src/my-app/Screenshot 2026-02-17 at 11.12.47 PM.png')
  })

  it('returns empty for text without image paths', () => {
    expect(findImagePaths('Hello world')).toHaveLength(0)
  })
})
