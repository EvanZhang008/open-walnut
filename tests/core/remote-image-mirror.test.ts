/**
 * Mirror revalidation: the fix for "updated remote image still shows the old
 * one". A mirror file with a .src.json sidecar must be re-downloaded when the
 * remote mtime/size changed, and left alone when unchanged / unreachable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

// The mirror module reaches the daemon via dynamic imports — mock both.
const sendMock = vi.fn()
vi.mock('../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => ({ send: sendMock }),
}))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { remotehost: { hostname: 'remote.example.com', user: 'admin' } } }),
}))

import { WALNUT_HOME, REMOTE_IMAGES_DIR } from '../../src/constants.js'
import {
  writeMirrorSidecar,
  readMirrorSidecar,
  backfillMirrorSidecar,
  revalidateMirror,
  downloadToMirror,
  isMirrorPath,
} from '../../src/core/remote-image-mirror.js'

const mirrorPath = () => path.join(REMOTE_IMAGES_DIR, 'sess-1', `chart-${Math.random().toString(36).slice(2)}.png`)

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(REMOTE_IMAGES_DIR, { recursive: true })
  sendMock.mockReset()
})

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

function seedMirror(p: string, bytes: string, sidecar: { mtimeMs: number; size: number }): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, bytes)
  writeMirrorSidecar(p, {
    host: 'remotehost',
    remotePath: '/tmp/chart.png',
    remoteMtimeMs: sidecar.mtimeMs,
    remoteSize: sidecar.size,
  })
}

describe('isMirrorPath', () => {
  it('recognizes paths under REMOTE_IMAGES_DIR only', () => {
    expect(isMirrorPath(path.join(REMOTE_IMAGES_DIR, 'sid', 'a.png'))).toBe(true)
    expect(isMirrorPath('/tmp/somewhere-else/a.png')).toBe(false)
  })
})

describe('revalidateMirror', () => {
  it('re-downloads when the remote size changed', async () => {
    const p = mirrorPath()
    seedMirror(p, 'old-bytes', { mtimeMs: 100, size: 9 })
    sendMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs.stat') return { ok: true, exists: true, mtimeMs: 200, size: 11 }
      if (cmd === 'fs.read') return { ok: true, data: Buffer.from('fresh-bytes').toString('base64') }
      return { ok: false }
    })

    const buf = await revalidateMirror(p)
    expect(buf?.toString()).toBe('fresh-bytes')
    expect(fs.readFileSync(p, 'utf-8')).toBe('fresh-bytes')
    // Sidecar advanced to the new remote fingerprint.
    expect(await readMirrorSidecar(p)).toMatchObject({ remoteMtimeMs: 200, remoteSize: 11 })
  })

  it('returns null (serve cached) when remote is unchanged', async () => {
    const p = mirrorPath()
    seedMirror(p, 'same-bytes', { mtimeMs: 100, size: 10 })
    sendMock.mockResolvedValue({ ok: true, exists: true, mtimeMs: 100, size: 10 })

    expect(await revalidateMirror(p)).toBeNull()
    expect(fs.readFileSync(p, 'utf-8')).toBe('same-bytes')
  })

  it('returns null when the daemon stat fails (old daemon / host down)', async () => {
    const p = mirrorPath()
    seedMirror(p, 'cached', { mtimeMs: 100, size: 6 })
    sendMock.mockResolvedValue({ ok: false, error: 'unknown command' })

    expect(await revalidateMirror(p)).toBeNull()
  })

  it('returns null when the file has no sidecar', async () => {
    const p = mirrorPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'orphan')

    expect(await revalidateMirror(p)).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('backfilled sidecar (size -1) forces one re-download to establish the baseline', async () => {
    const p = mirrorPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'legacy-bytes')
    backfillMirrorSidecar(p, 'remotehost', '/tmp/chart.png')
    sendMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs.stat') return { ok: true, exists: true, mtimeMs: 300, size: 5 }
      if (cmd === 'fs.read') return { ok: true, data: Buffer.from('fresh').toString('base64') }
      return { ok: false }
    })

    const buf = await revalidateMirror(p)
    expect(buf?.toString()).toBe('fresh')
    expect(await readMirrorSidecar(p)).toMatchObject({ remoteMtimeMs: 300, remoteSize: 5 })
  })

  it('throttles repeat revalidations of the same path', async () => {
    const p = mirrorPath()
    seedMirror(p, 'x', { mtimeMs: 1, size: 1 })
    sendMock.mockResolvedValue({ ok: true, exists: true, mtimeMs: 1, size: 1 })

    await revalidateMirror(p)
    const statCalls = sendMock.mock.calls.length
    await revalidateMirror(p) // within the throttle window — no new stat
    expect(sendMock.mock.calls.length).toBe(statCalls)
  })
})

describe('backfillMirrorSidecar', () => {
  it('does not overwrite an existing sidecar', async () => {
    const p = mirrorPath()
    seedMirror(p, 'x', { mtimeMs: 42, size: 1 })
    backfillMirrorSidecar(p, 'otherhost', '/other/path.png')
    expect(await readMirrorSidecar(p)).toMatchObject({ host: 'remotehost', remoteMtimeMs: 42 })
  })
})

describe('downloadToMirror', () => {
  it('writes bytes + sidecar pinned to the remote stat', async () => {
    const p = mirrorPath()
    sendMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs.read') return { ok: true, data: Buffer.from('dl-bytes').toString('base64') }
      if (cmd === 'fs.stat') return { ok: true, exists: true, mtimeMs: 777, size: 8 }
      return { ok: false }
    })

    const buf = await downloadToMirror('remotehost', '/tmp/new.png', p)
    expect(buf?.toString()).toBe('dl-bytes')
    expect(fs.readFileSync(p, 'utf-8')).toBe('dl-bytes')
    expect(await readMirrorSidecar(p)).toMatchObject({
      host: 'remotehost', remotePath: '/tmp/new.png', remoteMtimeMs: 777, remoteSize: 8,
    })
  })

  it('returns null when the read fails', async () => {
    const p = mirrorPath()
    sendMock.mockResolvedValue({ ok: false, error: 'ENOENT' })
    expect(await downloadToMirror('remotehost', '/tmp/missing.png', p)).toBeNull()
    expect(fs.existsSync(p)).toBe(false)
  })
})
