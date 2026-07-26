/**
 * Local → remote image upload: RemoteSessionManager.prepareOutbound().
 *
 * HISTORY: this suite used to test `transferImagesForRemoteSession()` in
 * session-io.ts, which shelled out to `ssh mkdir -p` + `scp`. The daemon
 * transport refactor (08182ce) deleted it — uploads now ride the daemon's
 * `fs.write` RPC over the existing WebSocket, so there is no SSH/SCP process
 * to spy on. The BEHAVIOUR under test is unchanged and still load-bearing:
 * find local images in the outbound text, put them on the remote host, rewrite
 * the paths, and on failure leave the text alone rather than pointing the CLI
 * at a file that isn't there.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import type { SshTarget } from '../../src/providers/session-io.js'

const tmpBase = WALNUT_HOME

const REMOTE_TARGET: SshTarget = { hostname: 'remote.example.com', user: 'admin', use_daemon: true }

type FsWriteCall = { path: string; data: string; encoding?: string }

/**
 * Minimal DaemonConnection stand-in. prepareOutbound only touches `.connected`
 * and `.send()`, so a plain object is enough — and it keeps this suite a unit
 * test (no WS server, no ports) like the SCP-mock version it replaces.
 */
function makeConn(sendImpl?: (cmd: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return {
    connected: true,
    send: vi.fn(sendImpl ?? (async () => ({ ok: true, written: true }))),
  }
}

/** Attach a fake connection without going through start() (which needs a daemon). */
function injectConn(mgr: RemoteSessionManager, conn: unknown): void {
  ;(mgr as unknown as { conn: unknown }).conn = conn
}

/** fs.write payloads seen by the daemon, in call order. */
function fsWrites(conn: ReturnType<typeof makeConn>): FsWriteCall[] {
  return conn.send.mock.calls
    .filter((c) => c[0] === 'fs.write')
    .map((c) => c[1] as FsWriteCall)
}

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('RemoteSessionManager.prepareOutbound (local → remote image upload)', () => {
  it('uploads the image via daemon fs.write and rewrites the path', async () => {
    const imgPath = path.join(tmpBase, 'dashboard.png')
    fs.writeFileSync(imgPath, 'fake-png-data')

    const mgr = new RemoteSessionManager('sid-upload', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)

    const result = await mgr.prepareOutbound(`Please analyze this screenshot: ${imgPath}`)

    const writes = fsWrites(conn)
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe('/tmp/open-walnut-images/dashboard.png')
    expect(writes[0].encoding).toBe('base64')
    // Bytes must survive the base64 round-trip — a mangled encoding would ship
    // a corrupt image that Claude silently fails to read.
    expect(Buffer.from(writes[0].data, 'base64').toString()).toBe('fake-png-data')

    expect(result).toBe('Please analyze this screenshot: /tmp/open-walnut-images/dashboard.png')
    expect(result).not.toContain(imgPath)
  })

  it('rewrites every occurrence of multiple images', async () => {
    const img1 = path.join(tmpBase, 'a.png')
    const img2 = path.join(tmpBase, 'b.jpg')
    fs.writeFileSync(img1, 'data1')
    fs.writeFileSync(img2, 'data2')

    const mgr = new RemoteSessionManager('sid-multi', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)

    const result = await mgr.prepareOutbound(`First: ${img1}\nSecond: ${img2}\nAgain: ${img1}`)

    expect(fsWrites(conn).map((w) => w.path).sort()).toEqual([
      '/tmp/open-walnut-images/a.png',
      '/tmp/open-walnut-images/b.jpg',
    ])
    expect(result).toBe(
      'First: /tmp/open-walnut-images/a.png\n' +
      'Second: /tmp/open-walnut-images/b.jpg\n' +
      'Again: /tmp/open-walnut-images/a.png',
    )
    expect(result).not.toContain(tmpBase)
  })

  it('keeps the local path when the daemon rejects the write (ok:false)', async () => {
    const imgPath = path.join(tmpBase, 'fail.png')
    fs.writeFileSync(imgPath, 'data')

    const mgr = new RemoteSessionManager('sid-reject', 'remotehost', REMOTE_TARGET)
    // send() RESOLVES {ok:false} on daemon-side errors (it only throws on
    // transport failure), so an `await` alone does NOT prove the file landed.
    // Rewriting anyway pointed the CLI at a path that was never written.
    const conn = makeConn(async () => ({ ok: false, error: 'fs.write failed: EACCES' }))
    injectConn(mgr, conn)

    const text = `See ${imgPath}`
    expect(await mgr.prepareOutbound(text)).toBe(text)
  })

  it('keeps the local path when the transport throws', async () => {
    const imgPath = path.join(tmpBase, 'throw.png')
    fs.writeFileSync(imgPath, 'data')

    const mgr = new RemoteSessionManager('sid-throw', 'remotehost', REMOTE_TARGET)
    const conn = makeConn(async () => { throw new Error('daemon command timeout: fs.write') })
    injectConn(mgr, conn)

    const text = `See ${imgPath}`
    expect(await mgr.prepareOutbound(text)).toBe(text)
  })

  it('is a no-op with no connection (message must not be mangled before start)', async () => {
    const imgPath = path.join(tmpBase, 'noconn.png')
    fs.writeFileSync(imgPath, 'data')

    const mgr = new RemoteSessionManager('sid-noconn', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    conn.connected = false
    injectConn(mgr, conn)

    const text = `See ${imgPath}`
    expect(await mgr.prepareOutbound(text)).toBe(text)
    expect(conn.send).not.toHaveBeenCalled()
  })

  it('skips upload entirely for the local daemon (__local__ shares the filesystem)', async () => {
    const imgPath = path.join(tmpBase, 'local.png')
    fs.writeFileSync(imgPath, 'data')

    const mgr = new RemoteSessionManager('sid-local', '__local__', null)
    const conn = makeConn()
    injectConn(mgr, conn)

    const text = `See ${imgPath}`
    expect(await mgr.prepareOutbound(text)).toBe(text)
    expect(conn.send).not.toHaveBeenCalled()
  })

  it('ignores paths that do not exist locally (no phantom uploads)', async () => {
    const mgr = new RemoteSessionManager('sid-phantom', 'remotehost', REMOTE_TARGET)
    const conn = makeConn()
    injectConn(mgr, conn)

    const text = 'Look at /nonexistent/never-written.png please'
    expect(await mgr.prepareOutbound(text)).toBe(text)
    expect(conn.send).not.toHaveBeenCalled()
  })
})
