/**
 * The rewrite that eats its own output, and the download storm it feeds.
 *
 * Reported shape (2026-09-08, a client viewing a remote session's transcript):
 * bursts of nine failing daemon `fs.read` calls for three images, repeating every
 * few minutes for as long as the transcript stayed open. Nine = three references
 * times the three candidates the relative-name pass tries.
 *
 * Three defects add up to that:
 *
 * 1. The absolute-path matcher had no left guard, so a RELATIVE path in tool output
 *    was read as an absolute one starting at its first slash. Covered next door in
 *    tests/providers/session-io-download.test.ts, because that is where the matcher
 *    lives. It is what CREATED the corrupted paths this file is about.
 * 2. A path that CONTAINS a mirror slot instead of starting with one was treated as
 *    a brand-new remote path, so every later rewrite minted it ANOTHER slot whose
 *    basename then carried two hash prefixes. Verified against the real transcript
 *    by recomputing both hashes: the outer one is sha256 of the corrupted path.
 * 3. Nothing remembered that a path was not there, and the rewrite paths rebuild
 *    their candidate list from scratch on every open, refocus and reconnect, so a
 *    reference that can never resolve retried forever.
 *
 * Fixture names here are deliberately neutral; the real transcript's paths are not
 * reproduced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

const sendMock = vi.fn()
vi.mock('../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => ({ send: sendMock }),
}))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({
    hosts: {
      remotehost: { hostname: 'remote.example.com', user: 'admin' },
      // A SECOND configured host, so "the cache keys on host too" is actually
      // exercised: an unconfigured host never reaches the daemon at all, which
      // would make that test pass for the wrong reason.
      otherhost: { hostname: 'other.example.com', user: 'admin' },
    },
  }),
}))

import { WALNUT_HOME, REMOTE_IMAGES_DIR } from '../../src/constants.js'
import {
  looksAlreadyMirrored,
  isMirrorPath,
  isNotFoundReply,
  downloadToMirror,
  clearFailedFetches,
  sessionMirrorPath,
} from '../../src/core/remote-image-mirror.js'
import { rewriteHistoryRemoteImages } from '../../src/core/session-history.js'
import type { SessionHistoryMessage } from '../../src/core/session-history.js'

const SID = '11111111-2222-3333-4444-555555555555'
const CWD = '/workspace/marina/docs'

/** The corrupted shape: a source-tree prefix glued onto a hash-keyed mirror slot. */
const GLUED = `${CWD}/images/tmp/open-walnut/images/remote/${SID}/aabbccdd11223344-diagram.png`
/** The same corruption over a LEGACY bare-basename slot, so it shares a real
 *  reference's basename — that is what makes it reachable as a filename hint. */
const GLUED_LEGACY = `${CWD}/images/tmp/open-walnut/images/remote/${SID}/diagram.png`

/** What the daemon sends when the host genuinely has no such file. */
const enoent = { ok: false, error: 'fs.read failed: ENOENT: no such file (ENOENT)' }
/** What it sends (or fails as) when we could not ask. */
const unreachable = { ok: false, error: 'daemon command timeout: fs.read' }
const bytes = (s = 'png') => ({ ok: true, data: Buffer.from(s).toString('base64') })

/** Paths the daemon was asked to read, in call order. */
const readPaths = () =>
  sendMock.mock.calls.filter((c) => c[0] === 'fs.read').map((c) => (c[1] as { path: string }).path)

/**
 * The rewrite returns synchronously and downloads in the background on purpose
 * (downstream events must never carry a remote path), so the reads only exist a
 * few ticks after the call returns.
 */
const settle = () => new Promise((r) => setTimeout(r, 50))

/** Run body with Date.now shifted forward, then restore it. */
async function atTimeOffset(ms: number, body: () => Promise<void>): Promise<void> {
  const realNow = Date.now
  Date.now = () => realNow() + ms
  try { await body() } finally { Date.now = realNow }
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(REMOTE_IMAGES_DIR, { recursive: true })
  sendMock.mockReset()
  clearFailedFetches()
})

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('looksAlreadyMirrored', () => {
  it('accepts a real mirror slot, the same as isMirrorPath', () => {
    const slot = sessionMirrorPath(SID, `${CWD}/diagram.png`)
    expect(isMirrorPath(slot)).toBe(true)
    expect(looksAlreadyMirrored(slot)).toBe(true)
  })

  it('catches a mirror slot with a prefix glued in front of it', () => {
    // This is what isMirrorPath cannot see: the string does not START in the
    // mirror, it ENDS there. Matched on the tail rather than against the mirror
    // root because that root follows WALNUT_DAEMON_DIR — this fixture's
    // /tmp/open-walnut prefix is a real slot under the default dir, and stays one
    // even though this test's own REMOTE_IMAGES_DIR points into a temp dir.
    expect(isMirrorPath(GLUED)).toBe(false)
    expect(looksAlreadyMirrored(GLUED)).toBe(true)
  })

  it('catches every bucket name Walnut actually mints a slot under', () => {
    // Not just session uuids: /api/local-image keys its cache by HOST alias, and a
    // session with no claude id yet writes under the literal `unknown`. The glued
    // form of those is the case that mints a doubly-hashed doomed slot per replay,
    // so pinning it to a uuid would leave the real bug reachable.
    for (const p of [
      GLUED_LEGACY,
      'prefix/tmp/open-walnut/images/remote/clouddev/aabbccdd11223344-x.png',
      'prefix/tmp/open-walnut/images/remote/unknown/aabbccdd11223344-x.png',
    ]) {
      expect(looksAlreadyMirrored(p), p).toBe(true)
    }
  })

  it('catches the same shape as a RELATIVE name', () => {
    // The relative-name regex matches multi-segment names, so the corrupted path
    // minus its leading slash is a candidate too — and joining it onto cwd
    // invents a path no host has ever had.
    expect(looksAlreadyMirrored(`images/tmp/open-walnut/images/remote/${SID}/aabbccdd11223344-diagram.png`))
      .toBe(true)
  })

  it('leaves ordinary source paths alone', () => {
    for (const p of [
      '/workspace/marina/docs/diagram.png',
      'docs/images/diagram.png',
      'diagram.png',
      // `images/remote/` alone is not enough: a real repo may have that directory.
      '/workspace/marina/images/remote/diagram.png',
      // A session-id-shaped directory without the mirror tail is not enough either.
      `/workspace/marina/${SID}/diagram.png`,
    ]) {
      expect(looksAlreadyMirrored(p), p).toBe(false)
    }
  })

  it('does not fire on the mirror session directory itself (no file segment)', () => {
    expect(looksAlreadyMirrored(`/srv/images/remote/${SID}`)).toBe(false)
  })
})

describe('isNotFoundReply', () => {
  it('separates "the host has no such file" from "we could not ask"', () => {
    expect(isNotFoundReply(enoent)).toBe(true)
    expect(isNotFoundReply({ ok: false, exists: false })).toBe(true)
    expect(isNotFoundReply(unreachable)).toBe(false)
    expect(isNotFoundReply({ ok: false, error: 'fs.read failed: EACCES (EACCES)' })).toBe(false)
    expect(isNotFoundReply({ ok: false })).toBe(false)
    expect(isNotFoundReply({ ok: true })).toBe(false)
  })

  it('treats an untagged reply as unknown, so an old daemon never mutes an image', () => {
    // Degrading toward "ask again" is deliberate: a broken picture is worse than a
    // repeated read.
    expect(isNotFoundReply({ ok: false, error: 'fs.read failed: no such file' })).toBe(false)
  })
})

describe('downloadToMirror: a path the host does not have is not asked for again', () => {
  it('asks once, then short-circuits', async () => {
    sendMock.mockResolvedValue(enoent)
    const slot = sessionMirrorPath(SID, '/workspace/marina/gone.png')

    expect(await downloadToMirror('remotehost', '/workspace/marina/gone.png', slot)).toBeNull()
    expect(readPaths()).toEqual(['/workspace/marina/gone.png'])

    // Nine more attempts, which is exactly what a reopened transcript did.
    for (let i = 0; i < 9; i++) {
      expect(await downloadToMirror('remotehost', '/workspace/marina/gone.png', slot)).toBeNull()
    }
    expect(readPaths()).toEqual(['/workspace/marina/gone.png'])
  })

  it('keys on host AND path, so one dead file does not mute the others', async () => {
    sendMock.mockResolvedValue(enoent)
    await downloadToMirror('remotehost', '/workspace/marina/a.png', sessionMirrorPath(SID, '/a'))
    await downloadToMirror('remotehost', '/workspace/marina/b.png', sessionMirrorPath(SID, '/b'))
    await downloadToMirror('otherhost', '/workspace/marina/a.png', sessionMirrorPath(SID, '/c'))
    expect(readPaths()).toHaveLength(3)
  })

  it('does NOT mute a path it merely failed to reach', async () => {
    // The whole reason the cache asks for a definitive answer. A cold daemon connect
    // is measured at ~40s against a 10s cap, so the FIRST load after a restart is
    // the likeliest one to fail — muting there would black out exactly the images a
    // user is waiting for.
    sendMock.mockResolvedValue(unreachable)
    const slot = sessionMirrorPath(SID, '/workspace/marina/flaky.png')
    await downloadToMirror('remotehost', '/workspace/marina/flaky.png', slot)
    await downloadToMirror('remotehost', '/workspace/marina/flaky.png', slot)
    expect(readPaths()).toHaveLength(2)

    // And when the host comes back, the bytes land with no waiting period.
    sendMock.mockResolvedValue(bytes())
    expect((await downloadToMirror('remotehost', '/workspace/marina/flaky.png', slot))?.toString()).toBe('png')
  })

  it('retries a first miss quickly, because a model names an image before writing it', async () => {
    // Announce-then-create: the narrative text mentions /tmp/chart.png a moment
    // before the tool writes it. The first miss must be cheap to retry.
    sendMock.mockResolvedValue(enoent)
    const slot = sessionMirrorPath(SID, '/tmp/chart.png')
    await downloadToMirror('remotehost', '/tmp/chart.png', slot)
    expect(readPaths()).toHaveLength(1)

    await atTimeOffset(31_000, async () => {
      sendMock.mockResolvedValue(bytes('chart'))
      expect((await downloadToMirror('remotehost', '/tmp/chart.png', slot))?.toString()).toBe('chart')
    })
    expect(readPaths()).toHaveLength(2)
  })

  it('backs off further each time, so a path that never appears goes quiet', async () => {
    sendMock.mockResolvedValue(enoent)
    const slot = sessionMirrorPath(SID, '/workspace/marina/never.png')
    const attempt = () => downloadToMirror('remotehost', '/workspace/marina/never.png', slot)

    await attempt()                                       // miss 1 → muted 30s
    await atTimeOffset(31_000, attempt)                   // miss 2 → muted 60s
    expect(readPaths()).toHaveLength(2)

    // 31s after miss 2 is still inside its 60s window.
    await atTimeOffset(62_000, attempt)
    expect(readPaths()).toHaveLength(2)

    await atTimeOffset(95_000, attempt)                   // miss 3
    expect(readPaths()).toHaveLength(3)
  })

  it('a success clears the backoff, so a regenerated file is not held back', async () => {
    const p = '/workspace/marina/regen.png'
    const slot = sessionMirrorPath(SID, p)
    sendMock.mockResolvedValue(enoent)
    await downloadToMirror('remotehost', p, slot)

    await atTimeOffset(31_000, async () => {
      sendMock.mockResolvedValue(bytes())
      await downloadToMirror('remotehost', p, slot)
    })
    // If the miss count had survived the success, this next miss would be muted for
    // 60s instead of 30s.
    fs.rmSync(slot)
    sendMock.mockResolvedValue(enoent)
    await atTimeOffset(62_000, async () => { await downloadToMirror('remotehost', p, slot) })
    await atTimeOffset(94_000, async () => { await downloadToMirror('remotehost', p, slot) })
    expect(readPaths()).toHaveLength(4)
  })

  it('does not cache a SUCCESS as a miss', async () => {
    sendMock.mockResolvedValue(bytes())
    const slot = sessionMirrorPath(SID, '/workspace/marina/ok.png')
    expect(await downloadToMirror('remotehost', '/workspace/marina/ok.png', slot)).not.toBeNull()
    fs.rmSync(slot)
    expect(await downloadToMirror('remotehost', '/workspace/marina/ok.png', slot)).not.toBeNull()
  })
})

const msg = (text: string): SessionHistoryMessage =>
  ({ role: 'assistant', text, timestamp: '' } as SessionHistoryMessage)

describe('rewriteHistoryRemoteImages: already-rewritten text is left alone', () => {
  it('does not re-mirror a glued path, and asks the daemon for nothing', async () => {
    sendMock.mockResolvedValue(enoent)
    const out = await rewriteHistoryRemoteImages([msg(`See ${GLUED} for the layout.`)], 'remotehost', SID, CWD)
    await settle()

    // Unchanged: the reference is already broken, and a second slot would only
    // add a second thing that can never be downloaded.
    expect(out[0].text).toBe(`See ${GLUED} for the layout.`)
    expect(readPaths()).toEqual([])
  })

  it('does not re-mirror the glued path as a RELATIVE name either', async () => {
    // Second pass, second guard: the same corruption minus its leading slash is a
    // valid multi-segment relative name, and joining it onto cwd invents a path no
    // host has ever had. Without the pass-2 guard this text is rewritten.
    sendMock.mockResolvedValue(enoent)
    const rel = `images/tmp/open-walnut/images/remote/${SID}/aabbccdd11223344-diagram.png`
    const out = await rewriteHistoryRemoteImages([msg(`See ${rel} here.`)], 'remotehost', SID, CWD)
    await settle()

    expect(out[0].text).toBe(`See ${rel} here.`)
    expect(readPaths()).toEqual([])
  })

  it('still rewrites a healthy absolute remote path (the guard is not a blanket)', async () => {
    sendMock.mockResolvedValue(bytes())
    const remote = `${CWD}/diagram.png`
    const out = await rewriteHistoryRemoteImages([msg(`See ${remote} here.`)], 'remotehost', SID, CWD)
    await settle()

    expect(out[0].text).toBe(`See ${sessionMirrorPath(SID, remote)} here.`)
    expect(readPaths()).toEqual([remote])
  })

  it('does not accept a glued path as a filename hint', async () => {
    // A corrupted path sitting in an old tool result must not become a download
    // candidate for a reference that shares its basename — that is how one bad
    // record poisons a name for the whole transcript. The legacy bare-basename slot
    // is the shape where this is reachable: `diagram.png` is both the hint's
    // basename and the reference's.
    sendMock.mockResolvedValue(enoent)
    const messages = [
      { role: 'assistant', timestamp: '', text: 'earlier',
        tools: [{ name: 'Bash', input: `cat ${GLUED_LEGACY}`, result: '' }] },
      msg('now see diagram.png'),
    ] as unknown as SessionHistoryMessage[]

    await rewriteHistoryRemoteImages(messages, 'remotehost', SID, CWD)
    await settle()
    expect(readPaths()).not.toContain(GLUED_LEGACY)
    // The ordinary candidates are still tried.
    expect(readPaths()).toContain(`${CWD}/diagram.png`)
  })

  it('the whole replay of one broken reference costs a BOUNDED number of reads', async () => {
    sendMock.mockResolvedValue(enoent)
    const messages = [msg('see diagram.png'), msg('and diagram.png again')]

    await rewriteHistoryRemoteImages(messages, 'remotehost', SID, CWD)
    await settle()
    const first = readPaths().length
    expect(first).toBeGreaterThan(0)

    // Reopening the transcript is a fresh call with a fresh per-call cache; the
    // miss cache is what has to hold the line across calls.
    await rewriteHistoryRemoteImages(messages, 'remotehost', SID, CWD)
    await settle()
    expect(readPaths()).toHaveLength(first)
  })
})

describe('the guard does not create a new way to lose an image', () => {
  it('a glued path whose slot EXISTS on disk still points at those bytes', async () => {
    // Skipping the path must leave it pointing where it already pointed, not blank
    // it or redirect it.
    const slot = path.join(REMOTE_IMAGES_DIR, SID, 'aabbccdd11223344-diagram.png')
    fs.mkdirSync(path.dirname(slot), { recursive: true })
    fs.writeFileSync(slot, 'png')
    sendMock.mockResolvedValue(enoent)

    const glued = `${CWD}/images${slot}`
    expect(looksAlreadyMirrored(glued)).toBe(true)
    const out = await rewriteHistoryRemoteImages([msg(`See ${glued}`)], 'remotehost', SID, CWD)
    await settle()
    expect(out[0].text).toBe(`See ${glued}`)
    expect(readPaths()).toEqual([])
    expect(fs.readFileSync(slot, 'utf-8')).toBe('png')
  })
})
