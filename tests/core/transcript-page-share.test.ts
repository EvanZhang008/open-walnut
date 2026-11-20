/**
 * One build per older transcript page, kept for its retry (src/core/transcript-page-share.ts).
 * 2026-11-19 20:10Z: an agent read 110 tasks' history 8 at a time; every older page of a
 * whale JSONL on one dev host missed the route's 5 s deadline (36 x 503), and each retry
 * started the same tunnel reads again because the late build's answer was thrown away.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sharedPageBuild, pageKey, pageIsSettled, pageDeadlineMs, PAGE_WAIT_MAX_MS, PAGE_KEEP_MS, PAGE_KEEP_MAX_CHARS, _resetPageShareForTests } from '../../src/core/transcript-page-share.js'

const ROOT = join(import.meta.dirname, '..', '..')

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('sharedPageBuild', () => {
  beforeEach(() => _resetPageShareForTests())

  it('a read of a page being built joins that build', async () => {
    const d = deferred<string>()
    let builds = 0
    const build = () => { builds++; return d.promise }
    const a = sharedPageBuild('k', build)
    const b = sharedPageBuild('k', build)
    d.resolve('page')
    expect(await a).toBe('page')
    expect(await b).toBe('page')
    expect(builds).toBe(1)
  })

  it('a finished page answers the retry while kept, and is built again after', async () => {
    let t = 1_000
    const now = () => t
    let builds = 0
    const build = async () => `page-${++builds}`
    expect(await sharedPageBuild('k', build, undefined, now)).toBe('page-1')
    await Promise.resolve()
    t += PAGE_KEEP_MS - 1
    expect(await sharedPageBuild('k', build, undefined, now)).toBe('page-1')
    t += 2
    expect(await sharedPageBuild('k', build, undefined, now)).toBe('page-2')
    expect(builds).toBe(2)
  })

  it('a failed build is not kept: the next read builds again', async () => {
    let builds = 0
    const failing = async () => { builds++; throw new Error('tunnel dropped') }
    await expect(sharedPageBuild('k', failing)).rejects.toThrow('tunnel dropped')
    await new Promise((r) => setTimeout(r, 0))
    await expect(sharedPageBuild('k', failing)).rejects.toThrow('tunnel dropped')
    expect(builds).toBe(2)
  })

  it('another page or another session is its own build', async () => {
    let builds = 0
    const build = async () => ++builds
    await sharedPageBuild(pageKey('s-1', { before: 'a', live: true }), build)
    await sharedPageBuild(pageKey('s-1', { before: 'b', live: true }), build)
    await sharedPageBuild(pageKey('s-2', { before: 'a', live: true }), build)
    await sharedPageBuild(pageKey('s-1', { live: true, before: 'a' }), build)
    expect(builds).toBe(3)
  })

  it('the route waits out its deadline, then the retry gets the late page at once', async () => {
    const d = deferred<string>()
    let builds = 0
    const build = () => { builds++; return d.promise }
    const deadline = <T>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))])
    expect(await deadline(sharedPageBuild('k', build), 5)).toBe('timeout')
    d.resolve('late page')
    await Promise.resolve()
    expect(await deadline(sharedPageBuild('k', build), 5)).toBe('late page')
    expect(builds).toBe(1)
  })
})

describe('every older page is built through the shared build (class guard)', () => {
  it('buildSessionTranscript sends every `before` read through sharedPageBuild', () => {
    const src = readFileSync(join(ROOT, 'src/core/session-projection.ts'), 'utf8')
    const head = src.slice(src.indexOf('export async function buildSessionTranscript('))
    const body = head.slice(0, head.indexOf('\n}\n'))
    expect(body).toMatch(/opts\?\.before === undefined\) return buildSessionTranscriptNow/)
    expect(body).toMatch(/sharedPageBuild\(/)
  })

  it('a deadline-bound transcript build in a route builds with buildSessionTranscript, never a lower reader', () => {
    // A new route that races a page build against a deadline with its own reader would
    // lose the late answer again; buildSessionTranscript is where pages are shared.
    for (const file of ['src/web/routes/api-v1.ts']) {
      const src = readFileSync(join(ROOT, file), 'utf8')
      const sites = [...src.matchAll(/buildTranscriptWithin\(\s*([^,]+),/g)].map((m) => m[1].trim())
      expect(sites.length).toBeGreaterThan(0)
      for (const site of sites) {
        expect(site).toMatch(/^\(\) => buildSessionTranscript\(/)
      }
    }
  })
})

describe('what is kept stays bounded', () => {
  beforeEach(() => _resetPageShareForTests())

  it('a page over the text budget is shared while it builds but not kept', async () => {
    let builds = 0
    const big = async () => { builds++; return 'x' }
    await Promise.all([sharedPageBuild('k', big, () => PAGE_KEEP_MAX_CHARS + 1), sharedPageBuild('k', big, () => PAGE_KEEP_MAX_CHARS + 1)])
    await Promise.resolve()
    await sharedPageBuild('k', big, () => PAGE_KEEP_MAX_CHARS + 1)
    expect(builds).toBe(2)
  })

  it('pages that together pass the budget push the oldest out', async () => {
    const half = Math.floor(PAGE_KEEP_MAX_CHARS / 2) + 1
    let builds = 0
    const build = async () => ++builds
    await sharedPageBuild('a', build, () => half)
    await Promise.resolve()
    await sharedPageBuild('b', build, () => half)
    await Promise.resolve()
    await sharedPageBuild('b', build, () => half)
    expect(builds).toBe(2)
    await sharedPageBuild('a', build, () => half)
    expect(builds).toBe(3)
  })

  it('pages past their time leave even when nobody asks for them again', async () => {
    let t = 0
    const now = () => t
    let builds = 0
    const build = async () => ++builds
    for (let i = 0; i < 40; i++) { await sharedPageBuild(`p${i}`, build, () => 1, now); await Promise.resolve() }
    t += PAGE_KEEP_MS
    await sharedPageBuild('fresh', build, () => 1, now)
    // Every old page was forgotten: asking for one builds it again.
    await sharedPageBuild('p39', build, () => 1, now)
    expect(builds).toBe(42)
  })

  it('only a page cut a minute or more ago is settled', () => {
    const now = Date.parse('2026-11-19T20:10:00Z')
    expect(pageIsSettled('2026-11-19T16:00:00Z', now)).toBe(true)
    expect(pageIsSettled('2026-11-19T20:09:30Z', now)).toBe(false)
    expect(pageIsSettled('2026-11-19T21:00:00Z', now)).toBe(false)
    expect(pageIsSettled('not a time', now)).toBe(false)
  })
})

describe('wait: an older page read that can hold longer', () => {
  it('only lengthens the default, up to the cap', () => {
    expect(pageDeadlineMs(undefined, 5_000)).toBe(5_000)
    expect(pageDeadlineMs('15000', 5_000)).toBe(15_000)
    expect(pageDeadlineMs('999999', 5_000)).toBe(PAGE_WAIT_MAX_MS)
    expect(pageDeadlineMs('100', 5_000)).toBe(5_000)
    for (const bad of ['', '-1', '1e9', '15000ms', ['15000'], 15000]) expect(pageDeadlineMs(bad, 5_000)).toBe(5_000)
  })

  it('the transcript route reads wait for its older page', () => {
    const src = readFileSync(join(ROOT, 'src/web/routes/api-v1.ts'), 'utf8')
    expect(src).toMatch(/pageDeadlineMs\(req\.query\.wait, FRESH_READ_DEADLINE_MS\)/)
  })
})
