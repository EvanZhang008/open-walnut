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
  it('a host whose daemon moved to ~/.cache (read-only /tmp) gets images beside THAT dir', async () => {
    const imgPath = path.join(tmpBase, 'chart.png')
    fs.writeFileSync(imgPath, 'fake-png-data')
    const mgr = new RemoteSessionManager('sid-upload-fallback', 'remotehost', REMOTE_TARGET)
    const conn = { ...makeConn(), remoteDaemonDir: '/home/admin/.cache/open-walnut' }
    injectConn(mgr, conn)
    const result = await mgr.prepareOutbound(`look: ${imgPath}`)
    expect(fsWrites(conn)[0].path).toBe('/home/admin/.cache/open-walnut-images/chart.png')
    expect(result).toBe('look: /home/admin/.cache/open-walnut-images/chart.png')
  })

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

describe('RemoteSessionManager.prepareOutbound (Walnut-owned files to the remote host)', () => {
  // The local daemon files an upload with no task beside the task directories:
  // pointed into the temp home so `<state>/uploads` is tmpBase/uploads.
  let savedRoot: string | undefined
  beforeEach(() => {
    savedRoot = process.env.WALNUT_TASK_DIR_ROOT
    process.env.WALNUT_TASK_DIR_ROOT = path.join(tmpBase, 'tasks')
  })
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.WALNUT_TASK_DIR_ROOT
    else process.env.WALNUT_TASK_DIR_ROOT = savedRoot
  })

  const FILES = '[Files attached — open them from these paths]'

  function uploaded(id: string, name: string, data: string | Buffer): string {
    const dir = path.join(tmpBase, 'uploads', id)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, name)
    fs.writeFileSync(p, data)
    return p
  }

  /** A host that takes `upload.part`, finishing each upload on its last chunk. */
  function filesConn(onPart?: (payload: Record<string, unknown>) => Promise<void> | void) {
    const held = new Map<string, number>()
    return {
      ...makeConn(async (cmd, payload) => {
        if (cmd !== 'upload.part') return { ok: true }
        await onPart?.(payload)
        const got = (held.get(String(payload.uploadId)) ?? 0) + Buffer.from(String(payload.data), 'base64').length
        held.set(String(payload.uploadId), got)
        return got === payload.size
          ? { ok: true, staged: got, done: true, path: `/home/admin/.local/state/open-walnut/uploads/${payload.uploadId}/${payload.name}` }
          : { ok: true, staged: got }
      }),
      hasCapability: (cap: string) => cap === 'upload-part-v1',
    }
  }

  it('ships an attachment uploaded before the session existed and names the host copy', async () => {
    const local = uploaded('up-abcdefgh-1234', 'crash report.log', 'line 1\nline 2\n')
    const mgr = new RemoteSessionManager('sid-files', 'remotehost', REMOTE_TARGET)
    const conn = filesConn()
    injectConn(mgr, conn)
    const text = `${FILES}\n- ${local}\n\nwhy does it crash?`
    const out = await mgr.prepareOutbound(text)
    expect(out).toBe(`${FILES}\n- /home/admin/.local/state/open-walnut/uploads/up-abcdefgh-1234/crash report.log\n\nwhy does it crash?`)
    const part = conn.send.mock.calls.find((c) => c[0] === 'upload.part')![1] as Record<string, unknown>
    expect(Buffer.from(String(part.data), 'base64').toString()).toBe('line 1\nline 2\n')
    expect(part.uploadId).toBe('up-abcdefgh-1234')
  })

  it('names the session and its task, so the host files the copy under the task directory', async () => {
    const local = uploaded('up-abcdefgh-4321', 'notes.txt', 'n')
    const mgr = new RemoteSessionManager('sid-owner', 'remotehost', REMOTE_TARGET)
    const conn = filesConn()
    injectConn(mgr, conn)
    // What start() records before its first prepareOutbound.
    ;(mgr as unknown as { _sid: string; _taskId: string })._sid = 'sid-owner'
    ;(mgr as unknown as { _taskId: string })._taskId = 'task-77'
    await mgr.prepareOutbound(`${FILES}\n- ${local}\n\nread`)
    const part = conn.send.mock.calls.find((c) => c[0] === 'upload.part')![1] as Record<string, unknown>
    expect(part).toMatchObject({ sessionId: 'sid-owner', taskId: 'task-77', home: WALNUT_HOME })
  })

  it('a picture listed as a file goes through upload.part in chunks, never fs.write', async () => {
    // Over the picture lane's limit, so the composer listed it under the files header.
    const local = uploaded('up-abcdefgh-png1', 'chart.png', Buffer.alloc(3 * 1024 * 1024, 9))
    const mgr = new RemoteSessionManager('sid-bigpng', 'remotehost', REMOTE_TARGET)
    const conn = filesConn()
    injectConn(mgr, conn)
    const out = await mgr.prepareOutbound(`${FILES}\n- ${local}\n\nwhat does it show?`)
    expect(fsWrites(conn)).toEqual([])
    expect(conn.send.mock.calls.filter((c) => c[0] === 'upload.part')).toHaveLength(2)
    expect(out).toBe(`${FILES}\n- /home/admin/.local/state/open-walnut/uploads/up-abcdefgh-png1/chart.png\n\nwhat does it show?`)
  })

  it('two sends naming the same file at once ship it once', async () => {
    const local = uploaded('up-abcdefgh-dup1', 'big.bin', Buffer.alloc(3 * 1024 * 1024, 1))
    const mgr = new RemoteSessionManager('sid-dup', 'remotehost', REMOTE_TARGET)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const conn = filesConn(() => gate)
    injectConn(mgr, conn)
    const text = `${FILES}\n- ${local}\n\nfirst`
    const a = mgr.prepareOutbound(text)
    const b = mgr.prepareOutbound(text.replace('first', 'second'))
    await new Promise((r) => setTimeout(r, 20))
    release()
    const [outA, outB] = await Promise.all([a, b])
    const host = '/home/admin/.local/state/open-walnut/uploads/up-abcdefgh-dup1/big.bin'
    expect(outA).toBe(`${FILES}\n- ${host}\n\nfirst`)
    expect(outB).toBe(`${FILES}\n- ${host}\n\nsecond`)
    // Three 1 MB parts for one ship; a second ship would have sent six.
    expect(conn.send.mock.calls.filter((c) => c[0] === 'upload.part').map((c) => (c[1] as { offset: number }).offset)).toEqual([0, 1024 * 1024, 2 * 1024 * 1024])
  })

  it('a host whose daemon cannot take files gets the local path with a note saying so', async () => {
    const local = uploaded('up-abcdefgh-5678', 'a.pdf', '%PDF')
    const mgr = new RemoteSessionManager('sid-files-old', 'remotehost', REMOTE_TARGET)
    const conn = { ...makeConn(), hasCapability: () => false }
    injectConn(mgr, conn)
    const out = await mgr.prepareOutbound(`${FILES}\n- ${local}\n\nread it`)
    expect(out).toBe(`${FILES}\n- ${local} (could not be copied to this host: this host's Walnut daemon cannot take files yet)\n\nread it`)
    expect(conn.send.mock.calls.some((c) => c[0] === 'upload.part')).toBe(false)
  })

  it('a refused or failed ship keeps the local path with the reason', async () => {
    const refused = uploaded('up-abcdefgh-9999', 'full.zip', 'z')
    const broken = uploaded('up-abcdefgh-8888', 'cut.zip', 'c')
    const mgr = new RemoteSessionManager('sid-files-bad', 'remotehost', REMOTE_TARGET)
    const conn = {
      ...makeConn(async (_cmd, payload) => {
        if (payload.uploadId === 'up-abcdefgh-8888') throw new Error('daemon command timeout: upload.part')
        return { ok: false, error: 'upload.part failed: this host has 10 bytes free', code: 'no_space' }
      }),
      hasCapability: (cap: string) => cap === 'upload-part-v1',
    }
    injectConn(mgr, conn)
    const out = await mgr.prepareOutbound(`${FILES}\n- ${refused}\n- ${broken}\n\nunzip`)
    expect(out).toBe([
      FILES,
      `- ${refused} (could not be copied to this host: this host has 10 bytes free)`,
      `- ${broken} (could not be copied to this host: daemon command timeout: upload.part)`,
      '', 'unzip',
    ].join('\n'))
  })

  it('a path shaped like an upload outside the upload folders is never read or sent', async () => {
    const dir = path.join(tmpBase, 'projects', 'x', 'uploads', 'up-abcdefgh-0000')
    fs.mkdirSync(dir, { recursive: true })
    const local = path.join(dir, 'secrets.env.txt')
    fs.writeFileSync(local, 'TOKEN=1')
    const mgr = new RemoteSessionManager('sid-outside', 'remotehost', REMOTE_TARGET)
    const conn = filesConn()
    injectConn(mgr, conn)
    const text = `${FILES}\n- ${local}\n\nhi`
    expect(await mgr.prepareOutbound(text)).toBe(text)
    expect(conn.send).not.toHaveBeenCalled()
  })
})
