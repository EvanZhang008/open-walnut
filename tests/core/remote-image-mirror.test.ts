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
  sessionMirrorPath,
  resolveSessionMirrorPath,
  clearFailedFetches,
  startMirrorDownload,
  awaitPendingMirror,
  mirrorLaneState,
  noteFetchMissing,
  fetchRecentlyMissing,
  MIRROR_READS_PER_HOST,
  MIRROR_SLOT_CAP_MS,
} from '../../src/core/remote-image-mirror.js'

const HOST = 'remotehost'

const mirrorPath = () => path.join(REMOTE_IMAGES_DIR, 'sess-1', `chart-${Math.random().toString(36).slice(2)}.png`)

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(REMOTE_IMAGES_DIR, { recursive: true })
  sendMock.mockReset()
  // The not-found cache is module state shared by every case in this file: a path
  // one test deliberately misses would otherwise be skipped by the next.
  clearFailedFetches()
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

describe('sessionMirrorPath / resolveSessionMirrorPath (basename-collision fix)', () => {
  it('gives two same-named files from different dirs distinct slots', () => {
    const a = sessionMirrorPath('sess-1', '/tmp/a/chart.png')
    const b = sessionMirrorPath('sess-1', '/workspace/b/chart.png')
    expect(a).not.toBe(b)
    expect(path.basename(a)).toMatch(/chart\.png$/)
  })

  it('prefers an existing hash slot', () => {
    const hashed = sessionMirrorPath('sess-r', '/tmp/x/img.png')
    fs.mkdirSync(path.dirname(hashed), { recursive: true })
    fs.writeFileSync(hashed, 'hashed-bytes')
    expect(resolveSessionMirrorPath('sess-r', '/tmp/x/img.png')).toBe(hashed)
  })

  it('reuses a legacy bare-basename mirror whose sidecar proves the same origin', () => {
    const legacy = path.join(REMOTE_IMAGES_DIR, 'sess-l', 'img.png')
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, 'legacy-bytes')
    writeMirrorSidecar(legacy, {
      host: 'remotehost', remotePath: '/tmp/x/img.png', remoteMtimeMs: 1, remoteSize: 12,
    })
    expect(resolveSessionMirrorPath('sess-l', '/tmp/x/img.png')).toBe(legacy)
  })

  it('does NOT reuse a legacy mirror claimed by a DIFFERENT origin (the collision)', () => {
    const legacy = path.join(REMOTE_IMAGES_DIR, 'sess-c', 'chart.png')
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, 'first-dirs-bytes')
    writeMirrorSidecar(legacy, {
      host: 'remotehost', remotePath: '/tmp/a/chart.png', remoteMtimeMs: 1, remoteSize: 16,
    })
    const resolved = resolveSessionMirrorPath('sess-c', '/workspace/b/chart.png')
    expect(resolved).toBe(sessionMirrorPath('sess-c', '/workspace/b/chart.png'))
    expect(resolved).not.toBe(legacy)
  })

  it('reuses a sidecar-less legacy mirror (pre-sidecar era; backfill self-heals it)', () => {
    const legacy = path.join(REMOTE_IMAGES_DIR, 'sess-p', 'old.png')
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, 'pre-sidecar-bytes')
    expect(resolveSessionMirrorPath('sess-p', '/tmp/old.png')).toBe(legacy)
  })

  it('accepts any origin from acceptOrigins (relative-name candidate race)', () => {
    const legacy = path.join(REMOTE_IMAGES_DIR, 'sess-o', 'shot.png')
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, 'won-by-tmp-candidate')
    writeMirrorSidecar(legacy, {
      host: 'remotehost', remotePath: '/tmp/shot.png', remoteMtimeMs: 1, remoteSize: 20,
    })
    const resolved = resolveSessionMirrorPath('sess-o', '/workspace/shot.png', [
      '/workspace/shot.png', '/tmp/shot.png',
    ])
    expect(resolved).toBe(legacy)
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

describe('startMirrorDownload / awaitPendingMirror (the <img> that beats its bytes)', () => {
  it('runs one download per slot while it is in flight', async () => {
    const p = mirrorPath()
    let finish!: (ok: boolean) => void
    const download = vi.fn(() => new Promise<boolean>((r) => { finish = r }))

    const first = startMirrorDownload(HOST, p, download)
    const second = startMirrorDownload(HOST, p, download)
    expect(second).toBe(first)
    expect(download).toHaveBeenCalledTimes(1)
    finish(true)
    expect(await first).toBe(true)
  })

  it('forgets a slot once its download settles, so a failed one can be retried', async () => {
    const p = mirrorPath()
    expect(await startMirrorDownload(HOST, p, async () => { throw new Error('tunnel dropped') })).toBe(false)
    expect(await awaitPendingMirror(p)).toBeNull()

    const retry = vi.fn(async () => true)
    await startMirrorDownload(HOST, p, retry)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('hands a waiter the bytes once the download lands', async () => {
    const p = mirrorPath()
    let finish!: () => void
    startMirrorDownload(HOST, p, () => new Promise<boolean>((r) => {
      finish = () => {
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, 'landed')
        r(true)
      }
    }))
    const waiting = awaitPendingMirror(p)
    finish()
    expect((await waiting)?.toString()).toBe('landed')
  })

  it('answers null at once for a slot nothing is downloading', async () => {
    expect(await awaitPendingMirror(mirrorPath())).toBeNull()
  })

  it('stops waiting on a download that hangs', async () => {
    vi.useFakeTimers()
    try {
      const p = mirrorPath()
      startMirrorDownload(HOST, p, () => new Promise<boolean>(() => { /* never settles */ }))
      const waiting = awaitPendingMirror(p)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await waiting).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('mirror reads per host (2026-11-12: a replay flood buried the host link)', () => {
  /** A download that settles only when the test says so. */
  function gate() {
    const calls: Array<{ path: string; finish: (ok: boolean) => void }> = []
    const start = (p: string) => () => new Promise<boolean>((r) => { calls.push({ path: p, finish: r }) })
    return { calls, start }
  }

  it('runs at most a few per host and the rest in turn, every one of them', async () => {
    const g = gate()
    const paths = Array.from({ length: 50 }, () => mirrorPath())
    const all = paths.map((p) => startMirrorDownload('flooded', p, g.start(p)))
    expect(g.calls.length).toBe(MIRROR_READS_PER_HOST)
    expect(mirrorLaneState('flooded')).toEqual({ running: MIRROR_READS_PER_HOST, queued: 50 - MIRROR_READS_PER_HOST })
    let settled = 0
    while (settled < g.calls.length) {
      g.calls[settled++].finish(settled % 2 === 0)
      await new Promise((r) => setImmediate(r))
      expect(mirrorLaneState('flooded').running).toBeLessThanOrEqual(MIRROR_READS_PER_HOST)
    }
    expect(g.calls.map((c) => c.path)).toEqual(paths) // first come, first served
    expect((await Promise.all(all)).length).toBe(50)
    expect(mirrorLaneState('flooded')).toEqual({ running: 0, queued: 0 })
  })

  it('never makes one host wait behind another', () => {
    const g = gate()
    for (let i = 0; i < 20; i++) { const p = mirrorPath(); startMirrorDownload('busy-host', p, g.start(p)) }
    const other = mirrorPath()
    const quiet = vi.fn(() => new Promise<boolean>(() => {}))
    startMirrorDownload('quiet-host', other, quiet)
    expect(quiet).toHaveBeenCalledTimes(1)
    for (const c of g.calls) c.finish(false)
  })

  it('gives a failed or throwing download\'s slot to the next one', async () => {
    const throws = Array.from({ length: MIRROR_READS_PER_HOST }, () => mirrorPath())
    const all = throws.map((p) => startMirrorDownload('failing', p, () => { throw new Error('tunnel dropped') }))
    const next = vi.fn(async () => true)
    const last = startMirrorDownload('failing', mirrorPath(), next)
    expect(await Promise.all(all)).toEqual(throws.map(() => false))
    expect(await last).toBe(true)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('starts a queued slot at once when an <img> waits for it', async () => {
    const g = gate()
    const ahead = Array.from({ length: MIRROR_READS_PER_HOST + 10 }, () => mirrorPath())
    for (const p of ahead) startMirrorDownload('promo', p, g.start(p))
    const wanted = mirrorPath()
    const wantedRun = vi.fn(() => new Promise<boolean>((r) => {
      fs.mkdirSync(path.dirname(wanted), { recursive: true })
      fs.writeFileSync(wanted, 'seen')
      r(true)
    }))
    startMirrorDownload('promo', wanted, wantedRun)
    expect(wantedRun).not.toHaveBeenCalled()
    // Every slot is still busy: the one the user looks at does not wait for them.
    expect((await awaitPendingMirror(wanted))?.toString()).toBe('seen')
    expect(g.calls.length).toBe(MIRROR_READS_PER_HOST)
    expect(mirrorLaneState('promo')).toEqual({ running: MIRROR_READS_PER_HOST, queued: 10 })
    for (let i = 0; i < g.calls.length; i++) { g.calls[i].finish(false); await new Promise((r) => setImmediate(r)) }
    expect(mirrorLaneState('promo')).toEqual({ running: 0, queued: 0 })
  })

  it('gives back the slot of a download that hangs', async () => {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < MIRROR_READS_PER_HOST; i++) startMirrorDownload('hung', mirrorPath(), () => new Promise<boolean>(() => {}))
      const next = vi.fn(async () => true)
      const hungPath = mirrorPath()
      const hung = startMirrorDownload('hung', hungPath, () => new Promise<boolean>(() => {}))
      startMirrorDownload('hung', mirrorPath(), next)
      expect(next).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(MIRROR_SLOT_CAP_MS)
      expect(next).toHaveBeenCalledTimes(1)
      // The capped slot counts as failed, so the path can be tried again.
      await vi.advanceTimersByTimeAsync(MIRROR_SLOT_CAP_MS)
      expect(await hung).toBe(false)
      const retry = vi.fn(async () => true)
      await startMirrorDownload('hung', hungPath, retry)
      expect(retry).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('remembers every missing path of a busy host, not only the last 500', () => {
    const paths = Array.from({ length: 1_000 }, (_, i) => `/tmp/gone-${i}.png`)
    for (const p of paths) noteFetchMissing(HOST, p)
    expect(paths.every((p) => fetchRecentlyMissing(HOST, p))).toBe(true)
  })
})

describe('every fire-and-forget remote image read goes through the per-host lane (guard)', () => {
  // The class: code that starts a remote image read and does not wait for it. Each
  // such read must queue behind startMirrorDownload, or a replay that names
  // thousands of pictures floods the host link again. Enumerated from the source:
  // a new caller of a raw image download that skips the lane fails here.
  it('calls the raw downloaders only from inside startMirrorDownload', async () => {
    const { execFileSync } = await import('node:child_process')
    const root = path.resolve(__dirname, '../..')
    const out = execFileSync('git', ['grep', '-n', '-E', 'downloadImageViaDaemon\\(|downloadRemoteFile\\(|downloadToMirror\\(|fetchRemoteBytes\\(', '--', 'src'], { cwd: root, encoding: 'utf-8' })
    const offenders = out.split('\n').filter(Boolean)
      .filter((line) => !/async function (downloadImageViaDaemon|downloadToMirror|fetchRemoteBytes)\(|private async downloadRemoteFile\(/.test(line))
      // A read whose caller waits for it (a request path) is bounded by that caller.
      .filter((line) => !/await (downloadToMirror|fetchRemoteBytes)\(/.test(line))
      .filter((line) => !/startMirrorDownload\(/.test(line))
      // The pass-2 candidate loop runs inside its startMirrorDownload callback.
      .filter((line) => !/if \(await downloadImageViaDaemon\(host, candidate, lp\)\)/.test(line))
    expect(offenders).toEqual([])
  })
})
