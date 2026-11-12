/**
 * Where a host can download this server's walnut file itself
 * (HostFileSource.published, host-file-download.ts createPublishedLookup): only a
 * published release build, from the release's SHA256SUMS, never a build of a
 * checkout (the maintainer's dev builds keep the upload). The release answers
 * through a stand-in fetch; nothing is downloaded here, only the sums are read.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-file-published'))

import { createHostFileSource, type BuildOrigin } from '../../src/core/host-server/host-file.js'
import { PUBLISHED_RECHECK_MS } from '../../src/core/host-server/host-file-download.js'
import type { BuildInfo } from '../../src/lib/build-info.js'

const GZ = 'a'.repeat(64)
const PLAIN = 'b'.repeat(64)
const BASE = 'https://github.example.test/o/r/releases/download'
const info = (over: Partial<BuildInfo> = {}): BuildInfo => ({ version: '0.6.31', commit: '1fe30f31a', branch: 'main', builtAt: '2026-11-11T10:00:00.000Z', dirty: false, ...over })
const released = (over: Partial<BuildInfo> = {}): BuildOrigin => ({ kind: 'release', info: info(over), id: '0.6.31-1fe30f31a', what: 'this compiled walnut file' })
const sums = `${GZ}  walnut-0.6.31-linux-x64.gz\n${PLAIN}  walnut-0.6.31-linux-x64\n${'c'.repeat(64)}  walnut-0.6.31-linux-arm64.gz\n`

/** A stand-in for the release host: answers by URL, counts every ask. */
function release(answers: Record<string, string | number | Error>) {
  const seen: string[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    seen.push(u)
    const a = answers[u]
    if (a instanceof Error) throw a
    if (typeof a === 'number') return new Response('', { status: a })
    if (a === undefined) return new Response('Not Found', { status: 404 })
    return new Response(a, { status: 200 })
  })
  return { seen, fetchImpl: fetchImpl as unknown as typeof fetch }
}

function source(origin: BuildOrigin, fetchImpl: typeof fetch, over: { releaseBase?: string; now?: () => number } = {}) {
  return createHostFileSource({ cacheDir: '/nonexistent/cache', origin: async () => origin, fetch: fetchImpl, releaseBase: over.releaseBase ?? BASE, ...(over.now ? { now: over.now } : {}) })
}

describe('where a host downloads the file itself', () => {
  it('a release build: the asset and both sha256s from SHA256SUMS, read once', async () => {
    const r = release({ [`${BASE}/v0.6.31/SHA256SUMS`]: sums })
    const src = source(released(), r.fetchImpl)
    expect(await src.published('linux-x64')).toEqual({ url: `${BASE}/v0.6.31/walnut-0.6.31-linux-x64.gz`, gzSha256: GZ, sha256: PLAIN })
    expect(await src.published('linux-x64')).toEqual({ url: `${BASE}/v0.6.31/walnut-0.6.31-linux-x64.gz`, gzSha256: GZ, sha256: PLAIN })
    expect(r.seen).toEqual([`${BASE}/v0.6.31/SHA256SUMS`])
  })

  it('a build of a checkout (the maintainer\'s dev build): none, and the release is never asked', async () => {
    const r = release({ [`${BASE}/v0.6.31/SHA256SUMS`]: sums })
    const src = source({ kind: 'checkout', checkout: '/work/walnut', distDir: '/work/walnut/dist', info: info({ commit: 'decf6e2b7' }), id: '0.6.31-decf6e2b7' }, r.fetchImpl)
    expect(await src.published('linux-x64')).toEqual({ none: expect.stringMatching(/its own checkout/) })
    expect(r.seen).toEqual([])
  })

  it('a release build with uncommitted changes, a version no release has, no commit: none, nothing asked', async () => {
    const r = release({})
    for (const over of [{ dirty: true }, { version: '0.6.31-dev' }, { commit: null }] as Partial<BuildInfo>[]) {
      // A nightly's prerelease version is a release version: only a version that is none is refused before asking.
      const got = await source(released(over), r.fetchImpl).published('linux-x64')
      if (over.version === '0.6.31-dev') expect(got).toEqual({ none: 'there is no GitHub release of Walnut 0.6.31-dev' })
      else expect(got).toEqual({ none: expect.stringMatching(/is not a published release build/) })
    }
    expect(r.seen).toEqual([`${BASE}/v0.6.31-dev/SHA256SUMS`])
  })

  it('a release base that is a local mirror (file://): none, a host cannot read it', async () => {
    const r = release({})
    expect(await source(released(), r.fetchImpl, { releaseBase: 'file:///Users/me/mirror' }).published('linux-x64'))
      .toEqual({ none: expect.stringMatching(/not a web address/) })
    expect(r.seen).toEqual([])
  })

  it('a release without this target, or without the plain file\'s line: none', async () => {
    const r = release({ [`${BASE}/v0.6.31/SHA256SUMS`]: sums })
    const src = source(released(), r.fetchImpl)
    expect(await src.published('linux-x64-musl')).toEqual({ none: expect.stringMatching(/does not list walnut-0.6.31-linux-x64-musl.gz/) })
    // linux-arm64 has its gz line only.
    expect(await src.published('linux-arm64')).toEqual({ none: expect.stringMatching(/does not list walnut-0.6.31-linux-arm64.gz/) })
  })

  it('no release yet, or one that cannot be read: none, asked again only after a while', async () => {
    let t = 1_000_000
    const answers: Record<string, string | number | Error> = {}
    const r = release(answers)
    const src = source(released(), r.fetchImpl, { now: () => t })
    expect(await src.published('linux-x64')).toEqual({ none: 'there is no GitHub release of Walnut 0.6.31' })
    expect(await src.published('linux-x64')).toEqual({ none: 'there is no GitHub release of Walnut 0.6.31' })
    expect(r.seen).toHaveLength(1)
    answers[`${BASE}/v0.6.31/SHA256SUMS`] = new Error('getaddrinfo ENOTFOUND github.example.test')
    t += PUBLISHED_RECHECK_MS
    expect(await src.published('linux-x64')).toEqual({ none: expect.stringMatching(/could not be read \(getaddrinfo ENOTFOUND/) })
    answers[`${BASE}/v0.6.31/SHA256SUMS`] = 503
    t += PUBLISHED_RECHECK_MS
    expect(await src.published('linux-x64')).toEqual({ none: expect.stringMatching(/could not be read .*HTTP 503/) })
    answers[`${BASE}/v0.6.31/SHA256SUMS`] = sums
    t += PUBLISHED_RECHECK_MS
    expect(await src.published('linux-x64')).toMatchObject({ sha256: PLAIN })
    expect(r.seen).toHaveLength(4)
  })
})
