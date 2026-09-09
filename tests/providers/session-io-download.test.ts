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

import { findImagePaths, findRemoteImagePaths, findRelativeImageNames } from '../../src/providers/session-io.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { sessionMirrorPath, clearFailedFetches } from '../../src/core/remote-image-mirror.js'
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
  // The failed-fetch cache is module state shared by every case in this file: a
  // path one test deliberately fails would otherwise be skipped by the next.
  clearFailedFetches()
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

    const localPath = sessionMirrorPath('session-abc', '/tmp/open-walnut-images/abc/screenshot.png')
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
    expect(result).toContain(sessionMirrorPath('session-fail', '/tmp/broken.png'))

    await expect(settle()).resolves.toBeUndefined()
    expect(fs.existsSync(sessionMirrorPath('session-fail', '/tmp/broken.png'))).toBe(false)
  })

  it('writes nothing when the daemon replies ok:false', async () => {
    const mgr = new RemoteSessionManager('sid-notok', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn(async () => ({ ok: false, error: 'fs.read failed: ENOENT' })))

    mgr.processInbound('See /tmp/missing.png', 'session-notok')
    await settle()

    expect(fs.existsSync(sessionMirrorPath('session-notok', '/tmp/missing.png'))).toBe(false)
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

    expect(result).toContain(sessionMirrorPath('session-abc', '/tmp/open-walnut-images/abc123/screenshot.png'))
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
    expect(result).toContain(sessionMirrorPath('session-multi', '/tmp/a.png'))
    expect(result).toContain(sessionMirrorPath('session-multi', '/tmp/b.jpg'))
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
    expect(result).toContain(sessionMirrorPath('sess-space', '/workplace/user/Screenshot 2026-02-17 at 11.12.47 PM.png'))
    expect(mgr.imageCache.size).toBe(1)
  })

  it('handles paths with spaces in double quotes', () => {
    const mgr = new RemoteSessionManager('sid-dq', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    const result = mgr.processInbound('File at "/tmp/open-walnut-images/abc/My Screenshot.png" saved', 'sess-dq')

    expect(result).not.toContain('/tmp/open-walnut-images/abc/My Screenshot.png')
    expect(result).toContain(sessionMirrorPath('sess-dq', '/tmp/open-walnut-images/abc/My Screenshot.png'))
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

  it('does not corrupt a relative path in tool output into prefix + mirror slot', async () => {
    // End to end for the invented-path bug: before the boundary fix this line came
    // back as `M repo-part` + a mirror path, i.e. a string that starts in the repo
    // and ends in the mirror. Only the RELATIVE name may be rewritten, and it is
    // rewritten whole.
    const mgr = new RemoteSessionManager('sid-invent', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)

    const rel = 'repo-part/team/proj/docs/images/onboarding.png'
    const out = mgr.processInbound(` M ${rel}`, 'sess-invent', '/workspace/proj')
    await settle()

    // The corruption's signature: the repo prefix survives and the mirror path is
    // glued onto it. `REMOTE_IMAGES_DIR` is absolute, so the corrupted string is the
    // prefix immediately followed by it.
    expect(out).not.toContain(`repo-part${REMOTE_IMAGES_DIR}`)
    expect(out).toBe(` M ${sessionMirrorPath('sess-invent', `/workspace/proj/${rel}`)}`)
    // And the read that goes out is for a path that could actually exist.
    expect(readPaths(conn)).toEqual([`/workspace/proj/${rel}`])
  })

  it('leaves a path that merely CONTAINS a mirror slot alone', async () => {
    // The shape a streaming-edge rewrite left behind before excludeEdges existed:
    // a source-tree prefix glued onto a mirror slot. `startsWith(REMOTE_IMAGES_DIR)`
    // cannot see it, so every pass used to mint the path its OWN slot — basename
    // with two hash prefixes, undownloadable, retried on every replay.
    const mgr = new RemoteSessionManager('sid-glued', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)

    const sid = '11111111-2222-3333-4444-555555555555'
    const glued = `/workspace/marina/docs/images/tmp/open-walnut/images/remote/${sid}/aabbccdd11223344-diagram.png`
    const text = `See ${glued}`

    expect(mgr.processInbound(text, sid, '/workspace/marina/docs')).toBe(text)
    await settle()
    expect(readPaths(conn)).toHaveLength(0)
  })

  it('does not re-read a path the host said it does not have', async () => {
    // Nine failing reads per burst, every few minutes, for a reference that can
    // never resolve — the rewrite paths rebuild candidates from scratch each time,
    // so the only thing that can stop it is remembering the answer.
    const mgr = new RemoteSessionManager('sid-negcache', 'remotehost', REMOTE_TARGET)
    const conn = makeConn(async () => ({ ok: false, error: 'fs.read failed: no such file (ENOENT)' }))
    injectConn(mgr, conn)

    mgr.processInbound('See /tmp/never-there.png', 'sess-neg-a')
    await settle()
    expect(readPaths(conn)).toHaveLength(1)

    // A DIFFERENT session: its own _imageCache is empty, so only the shared
    // miss cache can stop the second attempt.
    const mgr2 = new RemoteSessionManager('sid-negcache2', 'remotehost', REMOTE_TARGET)
    injectConn(mgr2, conn)
    mgr2.processInbound('See /tmp/never-there.png', 'sess-neg-b')
    await settle()
    expect(readPaths(conn)).toHaveLength(1)
  })

  it('DOES retry a read it merely failed to deliver', async () => {
    // A transport failure says nothing about whether the file exists. Muting on it
    // would black out images after every restart or tunnel flap.
    const mgr = new RemoteSessionManager('sid-flaky', 'remotehost', REMOTE_TARGET)
    const conn = makeConn(async () => ({ ok: false, error: 'daemon command timeout: fs.read' }))
    injectConn(mgr, conn)

    mgr.processInbound('See /tmp/flaky.png', 'sess-flaky-a')
    await settle()
    const mgr2 = new RemoteSessionManager('sid-flaky2', 'remotehost', REMOTE_TARGET)
    injectConn(mgr2, conn)
    mgr2.processInbound('See /tmp/flaky.png', 'sess-flaky-b')
    await settle()

    expect(readPaths(conn)).toHaveLength(2)
  })

  it('a local write failure does not mute the remote path', async () => {
    // The bytes arrived; the mirror write is what broke (EACCES, ENOSPC). Blaming
    // the remote path for that would hide a perfectly good image.
    const mgr = new RemoteSessionManager('sid-writefail', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('EACCES') })
    try {
      mgr.processInbound('See /tmp/writefail.png', 'sess-wf-a')
      await settle()
    } finally {
      spy.mockRestore()
    }

    const mgr2 = new RemoteSessionManager('sid-writefail2', 'remotehost', REMOTE_TARGET)
    injectConn(mgr2, conn)
    mgr2.processInbound('See /tmp/writefail.png', 'sess-wf-b')
    await settle()
    expect(readPaths(conn)).toHaveLength(2)
  })

  it('does not corrupt a relative name that embeds a mirror slot (pass 2)', async () => {
    // The same corruption minus its leading slash is a valid multi-segment relative
    // name; joining it onto cwd invents a path no host has ever had.
    const mgr = new RemoteSessionManager('sid-relglued', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)

    const sid = '11111111-2222-3333-4444-555555555555'
    const rel = `images/tmp/open-walnut/images/remote/${sid}/aabbccdd11223344-diagram.png`
    const text = `See ${rel} here`

    expect(mgr.processInbound(text, sid, '/workspace/marina/docs')).toBe(text)
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

describe('an absolute path must START a token (the invented-path bug)', () => {
  // 2026-09-08, found on a live remote session: the unquoted matcher had no
  // left boundary, so `\/` matched any slash inside a longer token and a RELATIVE
  // path was read as an absolute one beginning at its first slash. Everything
  // downstream believed the invented path: its own mirror slot, a download that
  // could only fail, and — because the rewrite replaces the matched span — stored
  // text that begins in the source tree and ends in the mirror. The slot hash on
  // the real session recomputes from the invented path, which is how this was
  // pinned rather than guessed.

  it('does not invent an absolute path out of a relative one', () => {
    // The exact shape: a `git status --short` line in a tool result.
    const line = ' M repo-part/team/proj/docs/images/onboarding.png'
    expect(findImagePaths(line)).toEqual([])
    // It is a relative reference, and that matcher gets the WHOLE name — which is
    // what lets it be resolved against cwd and the transcript's path hints.
    expect(findRelativeImageNames(line)).toEqual(['repo-part/team/proj/docs/images/onboarding.png'])
  })

  it('does not invent one out of a single-directory relative name either', () => {
    // `images/architecture.png` used to yield `/architecture.png`, which is how a
    // stored path ended up as `<prefix>/images` + a mirror slot.
    expect(findImagePaths('see images/architecture.png here')).toEqual([])
  })

  it('still finds every shape a real transcript puts an absolute path in', () => {
    const cases: [string, string][] = [
      ['at /tmp/charts/a.png done', '/tmp/charts/a.png'],
      ['/tmp/a.png ready', '/tmp/a.png'],
      ['![x](/tmp/a.png)', '/tmp/a.png'],
      ['{"file_path": "/workspace/x/a.png"}', '/workspace/x/a.png'],
      ['path=/tmp/a.png', '/tmp/a.png'],
      ['[/tmp/a.png]', '/tmp/a.png'],
      ['<img src=/tmp/a.png>', '/tmp/a.png'],
    ]
    for (const [text, expected] of cases) {
      expect(findImagePaths(text), text).toEqual([expected])
    }
  })

  it('still finds two absolute paths separated only by a comma', () => {
    expect(findImagePaths('files: /tmp/a.png,/tmp/b.png')).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })

  it('accepts a path after ANY punctuation, because prose is not an allowlist', () => {
    // The guard is "the slash must not continue a token", expressed as a negative
    // lookbehind. The first version of this fix used an allowlist of permitted
    // preceding characters instead, and silently dropped every one of these — a
    // markdown-bolded path is ordinary in CLI prose, and losing it costs the image
    // inbound AND stops the file being uploaded outbound.
    for (const text of [
      'Saved to **/tmp/chart.png**',
      '|/tmp/chart.png|',
      'cmd;/tmp/chart.png',
      'x</tmp/chart.png>',
      '→/tmp/chart.png',
      '—/tmp/chart.png',
      '‘/tmp/chart.png’',
    ]) {
      expect(findImagePaths(text), text).toEqual(['/tmp/chart.png'])
    }
  })

  it('rejects a slash that continues a token, which is what defect #1 was', () => {
    for (const text of ['the file/tmp/a.png', '$HOME/tmp/a.png', './images/a.png']) {
      expect(findImagePaths(text), text).toEqual([])
    }
  })
})

describe('excludeEdges (streaming-delta split-path guard)', () => {
  // A path split across two streaming deltas leaves fragments at the chunk
  // edges. Each fragment matches as a complete path/filename on its own, and
  // rewriting it corrupts the text permanently (observed in production:
  // "weekly-trend.png" split into "…week" + "ly-trend.png" produced
  // "…week/tmp/open-walnut/images/remote/<sid>/ly-trend.png").

  it('drops an unquoted absolute path that ends exactly at text end', () => {
    expect(findImagePaths('see /tmp/charts/weekly-trend.png', { excludeEdges: true })).toHaveLength(0)
  })

  it('drops an absolute path that starts at text start', () => {
    expect(findImagePaths('/tmp/charts/img.png is ready', { excludeEdges: true })).toHaveLength(0)
  })

  it('keeps an absolute path fully interior to the chunk', () => {
    const paths = findImagePaths('see /tmp/charts/img.png here', { excludeEdges: true })
    expect(paths).toEqual(['/tmp/charts/img.png'])
  })

  it('drops a relative filename touching either edge', () => {
    // "ly-trend.png…" — the tail fragment of a split "weekly-trend.png"
    expect(findRelativeImageNames('ly-trend.png shows the data', { excludeEdges: true })).toHaveLength(0)
    expect(findRelativeImageNames('the chart is in weekly-trend.png', { excludeEdges: true })).toHaveLength(0)
  })

  it('keeps a relative filename fully interior to the chunk', () => {
    const names = findRelativeImageNames('open weekly-trend.png to see it', { excludeEdges: true })
    expect(names).toEqual(['weekly-trend.png'])
  })

  it('default (no opts) still matches edge paths — full-text rewrites need them', () => {
    expect(findImagePaths('see /tmp/charts/weekly-trend.png')).toHaveLength(1)
    expect(findRelativeImageNames('see weekly-trend.png')).toHaveLength(1)
  })
})

describe('processInbound streaming mode (split-path corruption repro)', () => {
  it('does NOT rewrite the tail fragment of a path split across deltas', async () => {
    const mgr = new RemoteSessionManager('sid-split', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    // Delta 1 ends mid-path; delta 2 starts with the remainder. In streaming
    // mode neither fragment may be rewritten.
    const d1 = mgr.processInbound('The chart is at /workspace/docs/week', 'sess-split', '/workspace', { streaming: true })
    const d2 = mgr.processInbound('ly-trend.png and shows the data', 'sess-split', '/workspace', { streaming: true })
    expect(d1).toBe('The chart is at /workspace/docs/week')
    expect(d2).toBe('ly-trend.png and shows the data')
    expect(d1 + d2).toContain('/workspace/docs/weekly-trend.png')
  })

  it('still rewrites interior paths in streaming mode', () => {
    const mgr = new RemoteSessionManager('sid-split2', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    const out = mgr.processInbound('saved /tmp/full-img.png just now', 'sess-int', undefined, { streaming: true })
    expect(out).toContain(sessionMirrorPath('sess-int', '/tmp/full-img.png'))
  })

  it('non-streaming call (turn-end / history) still rewrites edge paths', () => {
    const mgr = new RemoteSessionManager('sid-split3', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    const out = mgr.processInbound('saved to /tmp/edge-img.png', 'sess-edge')
    expect(out).toContain(sessionMirrorPath('sess-edge', '/tmp/edge-img.png'))
  })
})

describe('mirror sidecars (stale-image revalidation bookkeeping)', () => {
  it('downloadRemoteFile records a .src.json sidecar with host + remotePath', async () => {
    const mgr = new RemoteSessionManager('sid-sidecar', 'remotehost', REMOTE_TARGET)
    const conn = makeConn(async (cmd) => {
      if (cmd === 'fs.read') return { ok: true, data: Buffer.from('bytes-v1').toString('base64') }
      if (cmd === 'fs.stat') return { ok: true, exists: true, mtimeMs: 1234, size: 8 }
      return { ok: false }
    })
    injectConn(mgr, conn)

    mgr.processInbound('see /tmp/chart.png', 'sess-sc')
    await settle()

    const mirror = sessionMirrorPath('sess-sc', '/tmp/chart.png')
    const sidecar = JSON.parse(fs.readFileSync(mirror + '.src.json', 'utf-8'))
    expect(sidecar).toMatchObject({
      host: 'remotehost',
      remotePath: '/tmp/chart.png',
      remoteMtimeMs: 1234,
      remoteSize: 8,
    })
  })

  it('backfills a sidecar for a pre-existing mirror file (legacy download-once)', async () => {
    const mgr = new RemoteSessionManager('sid-backfill', 'remotehost', REMOTE_TARGET)
    injectConn(mgr, makeConn())

    // Simulate an old mirror file downloaded before sidecars existed.
    const mirror = path.join(REMOTE_IMAGES_DIR, 'sess-bf', 'old.png')
    fs.mkdirSync(path.dirname(mirror), { recursive: true })
    fs.writeFileSync(mirror, 'stale-bytes')

    mgr.processInbound('see /tmp/old.png', 'sess-bf')
    await settle()

    const sidecar = JSON.parse(fs.readFileSync(mirror + '.src.json', 'utf-8'))
    // Backfill marks size -1 (unknown) so the first revalidation re-downloads.
    expect(sidecar).toMatchObject({ host: 'remotehost', remotePath: '/tmp/old.png', remoteSize: -1 })
  })
})
