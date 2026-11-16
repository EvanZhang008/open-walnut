/**
 * A box that changes size follows its end only while nothing else took it off the
 * end since its last read (line-anchor.ts followsAtResize).
 *
 * The class: every timeline box that keeps a reading place (the panel's timeline,
 * each Tree Mode page, the reading split). Such a box mounts following its end, a
 * kept place is restored in it before useLineAnchor's first read, and the box's
 * size settles a frame later; in WebKit that resize came first and the stale follow
 * sent the box to its end (2026-11-16: Main moving into the left page, and a reload,
 * both landed at the bottom in session-reading-place.spec.ts on WebKit only, which
 * CI does not run). The rule is pinned here for every engine, and the hook is held
 * to it by source.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { followsAtResize } from '@/components/sessions/line-anchor'

const base = { following: false, atBottom: false, clamped: false, top: 0, topAtRead: 0, offEnd: true }

describe('followsAtResize', () => {
  it('a kept place restored before the first read stands: the stale follow does not send the box to its end', () => {
    // Mounted following at scrollTop 0, then the place put it at 294 of 6034.
    expect(followsAtResize({ ...base, following: true, atBottom: false, top: 294, topAtRead: 0, offEnd: true })).toBe(false)
  })

  it('a box that followed and still sits at its end keeps following (a rewrap goes to the new end)', () => {
    expect(followsAtResize({ ...base, following: true, atBottom: true, top: 5000, topAtRead: 5000, offEnd: false })).toBe(true)
  })

  it('a follow path that moved the box to its new end keeps it following', () => {
    expect(followsAtResize({ ...base, following: true, atBottom: true, top: 5400, topAtRead: 5000, offEnd: false })).toBe(true)
  })

  it('a following box the resize only clamped stays following (WebKit dispatches the clamp first)', () => {
    expect(followsAtResize({ ...base, following: true, atBottom: false, clamped: true, top: 4800, topAtRead: 5000, offEnd: false })).toBe(true)
  })

  it('a box that did not follow is not made to follow by the clamp\'s echo', () => {
    expect(followsAtResize({ ...base, following: false, atBottom: true, clamped: true, top: 4800, topAtRead: 5000, offEnd: false })).toBe(false)
  })

  it('a box set to follow since its read with no scroll (End at the end) follows', () => {
    expect(followsAtResize({ ...base, following: false, atBottom: true, top: 5000, topAtRead: 5000, offEnd: false })).toBe(true)
  })

  it('a box mid-history that nobody moved does not follow', () => {
    expect(followsAtResize({ ...base, top: 1200, topAtRead: 1200 })).toBe(false)
  })
})

describe('useLineAnchor decides the follow with followsAtResize', () => {
  it('no inline follow rule in the hook', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/sessions/useLineAnchor.ts'), 'utf8')
    expect(src).toMatch(/const follows = followsAtResize\(/)
    expect(src).not.toMatch(/const follows = following \|\|/)
  })
})
