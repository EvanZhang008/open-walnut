/**
 * The rehearsals' GETs to outside services try again past a passing failure
 * (scripts/release-rehearsal/outside-fetch.mjs). 2026-11-05: GitHub answered 504 for a
 * release's SHA256SUMS and the field rehearsal's archive scenario failed after 15 seconds.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OUTSIDE_WAITS_MS, outsideFetch } from '../../scripts/release-rehearsal/outside-fetch.mjs'
import { publishedTags } from '../../scripts/release-rehearsal/field-packs.mjs'
import { publishedVersion } from '../../scripts/release-rehearsal/registry.mjs'
import { fetchStartPoints, releaseArchive } from '../../scripts/release-rehearsal/field.mjs'

const REPO = path.resolve(__dirname, '../..')
const DIR = path.join(REPO, 'scripts/release-rehearsal')
const quiet = { sleep: async () => {}, log: () => {} }

/** A fetch that answers `answers` in turn (a status, or an Error to throw), then 200 with `body`. */
function fakeFetch(answers: (number | Error)[], body: unknown = {}) {
  const calls: string[] = []
  const impl = async (url: string) => {
    calls.push(url)
    const a = answers.shift()
    if (a instanceof Error) throw a
    const status = a ?? 200
    return new Response(status === 200 ? JSON.stringify(body) : 'x', { status })
  }
  return { impl, calls }
}

describe('outsideFetch', () => {
  it('tries again past 5xx, 429 and a dropped connection, then returns the answer', async () => {
    const f = fakeFetch([504, new Error('socket hang up'), 429])
    const slept: number[] = []
    const res = await outsideFetch('https://x/a', {}, { fetchImpl: f.impl, sleep: async (ms: number) => { slept.push(ms) }, log: () => {} })
    expect(res.status).toBe(200)
    expect(f.calls).toHaveLength(4)
    expect(slept).toEqual(OUTSIDE_WAITS_MS.slice(0, 3))
  })

  it('returns 404 and other 4xx at once', async () => {
    for (const status of [404, 403, 400]) {
      const f = fakeFetch([status])
      const res = await outsideFetch('https://x/a', {}, { fetchImpl: f.impl, ...quiet })
      expect(res.status).toBe(status)
      expect(f.calls).toHaveLength(1)
    }
  })

  it('gives the last answer, or the last error, once the waits run out', async () => {
    const f = fakeFetch([503, 503, 503, 503, 502])
    expect((await outsideFetch('https://x/a', {}, { fetchImpl: f.impl, ...quiet })).status).toBe(502)
    expect(f.calls).toHaveLength(OUTSIDE_WAITS_MS.length + 1)
    const g = fakeFetch(Array.from({ length: 5 }, () => new Error('reset')))
    await expect(outsideFetch('https://x/a', {}, { fetchImpl: g.impl, ...quiet })).rejects.toThrow('reset')
  })

  it('with read, fetches again a download cut off partway, and returns what it read', async () => {
    let n = 0
    const impl = async () => (n++ === 0
      ? ({ ok: true, status: 200, text: async () => { throw new TypeError('terminated') } } as unknown as Response)
      : new Response('body'))
    const slept: number[] = []
    expect(await outsideFetch('https://x/a', {}, { fetchImpl: impl, read: (r: Response) => r.text(), sleep: async (ms: number) => { slept.push(ms) }, log: () => {} })).toBe('body')
    expect(slept).toEqual([OUTSIDE_WAITS_MS[0]])
  })

  it('waits about three and a half minutes in all, the longest last', () => {
    expect(OUTSIDE_WAITS_MS.reduce((a, b) => a + b, 0)).toBe(220_000)
    expect([...OUTSIDE_WAITS_MS].sort((a, b) => a - b)).toEqual(OUTSIDE_WAITS_MS)
  })
})

describe('every outside GET of the rehearsals goes through outsideFetch', () => {
  it('the registry reads try again past a 504', async () => {
    const tags = fakeFetch([504], { latest: '1.2.3' })
    expect(await publishedTags({ fetchImpl: tags.impl, waits: [0] } as never)).toEqual({ latest: '1.2.3' })
    expect(tags.calls).toHaveLength(2)
    const doc = fakeFetch([502], { version: '1.2.3', dist: { tarball: 't' } })
    expect((await publishedVersion('1.2.3', { fetchImpl: doc.impl, waits: [0] } as never)).version).toBe('1.2.3')
    expect(doc.calls).toHaveLength(2)
    const index = fakeFetch([500], { versions: { '1.2.3': {} }, 'dist-tags': { latest: '1.2.3' } })
    await fetchStartPoints({ fetchImpl: index.impl, waits: [0] } as never).catch(() => {})
    expect(index.calls).toHaveLength(2)
  })

  it('a release download that does not list this machine is no archive', async () => {
    const got = await releaseArchive('0.0.1', '/nonexistent', { base: 'https://x', get: async () => Buffer.from('abc  other-file.tar.gz\n') })
    expect(got).toBeNull()
  })

  it('no rehearsal or release download script calls fetch for an outside service directly', () => {
    // Allowed: the Walnut under test (`w.base`, `this.base`), and the local registry's
    // pass-through of npm's own request (npm tries again itself).
    const allowed = [/\$\{(w|this)\.base\}/, /fetch\(`\$\{upstream\}\$\{req\.url\}`/]
    const offenders: string[] = []
    // The release scripts that download read through it too: 2026-11-10, CI run 42831643140, the
    // Node archive build's own three tries spanned 16 s and failed the required Archive job.
    const files = [
      ...fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs') && f !== 'outside-fetch.mjs').map((f) => path.join(DIR, f)),
      ...fs.readdirSync(path.join(REPO, 'scripts/runtime-bundle')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(REPO, 'scripts/runtime-bundle', f)),
      path.join(REPO, 'scripts/components-release-ready.mjs'),
    ]
    for (const abs of files) {
      const file = path.relative(REPO, abs)
      fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line)) return
        if (!/\b(fetch|fetchImpl)\(/.test(line)) return
        if (!allowed.some((re) => re.test(line))) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
