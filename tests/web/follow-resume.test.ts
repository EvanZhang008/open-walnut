/**
 * Follow-bottom comes back only when the reader brings the view back down
 * (web/src/components/sessions/follow-resume.ts). A flick's momentum moving up
 * inside the bottom band, and the late echo of the app's own follow write after
 * the touch that left, used to turn it back on, and the echo guard then snapped
 * the reader's flick back to the bottom (2026-11-03, WebKit, half the runs of
 * phone-touch-scroll-while-streaming.spec.ts).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { downInputResumesAtEnd, followResumes } from '../../web/src/components/sessions/follow-resume'

// The reader left at the end of the transcript: scrollTop 3399, gap 0.
const LEFT = 3399

describe('followResumes', () => {
  it('follows when nobody turned following off', () => {
    expect(followResumes(null, 3000, 40)).toBe(true)
  })

  it('a scroll that did not bring the view down never resumes', () => {
    // The echo of the app's own write, delivered after the touch: no movement, still at the end.
    expect(followResumes({ leftAt: LEFT, highestSinceLeft: LEFT }, LEFT, 0)).toBe(false)
    // Content grew under it: the same echo, now inside the band.
    expect(followResumes({ leftAt: LEFT, highestSinceLeft: LEFT }, LEFT, 46)).toBe(false)
    // A flick's momentum moving up, every frame inside the band.
    for (const up of [0.5, 1, 2, 6, 11, 21, 41, 76]) {
      expect(followResumes({ leftAt: LEFT, highestSinceLeft: LEFT - up }, LEFT - up, up), `up ${up}`).toBe(false)
    }
  })

  it('the reader coming back down resumes it', () => {
    // Below where they left (the transcript grew while they read above).
    expect(followResumes({ leftAt: LEFT, highestSinceLeft: 2000 }, LEFT + 30, 50)).toBe(true)
    // Back at the very end after going up, with nothing new below.
    expect(followResumes({ leftAt: LEFT, highestSinceLeft: 2000 }, LEFT, 0)).toBe(true)
    expect(followResumes({ leftAt: LEFT, highestSinceLeft: 2000 }, LEFT, 2)).toBe(true)
    // A short trip up and back, just past the momentum's first frames.
    expect(followResumes({ leftAt: LEFT, highestSinceLeft: LEFT - 9 }, LEFT, 0)).toBe(true)
  })

  it('the reader\'s own downward input back to the end resumes it, however short the trip up', () => {
    // A wheel 1px up and a wheel down back to the end (composer-in-flow's load
    // window exit, a trackpad nudge): under the 8px rule, yet the reader's return.
    for (const up of [0, 0.5, 1, 2, 6]) {
      expect(followResumes({ leftAt: LEFT, highestSinceLeft: LEFT - up }, LEFT, 0, true), `up ${up}`).toBe(true)
      expect(followResumes({ leftAt: LEFT, highestSinceLeft: LEFT - up }, LEFT - 1, 1, true), `up ${up}, 1px short`).toBe(true)
    }
    // The same scrolls with no downward input stay the momentum / echo case.
    expect(followResumes({ leftAt: LEFT, highestSinceLeft: LEFT - 1 }, LEFT, 0, false)).toBe(false)
    // A downward input that stops short of the end does not resume it.
    expect(followResumes({ leftAt: LEFT, highestSinceLeft: 2000 }, LEFT - 40, 40, true)).toBe(false)
  })

  it('a downward input with the view already at the end resumes it there, and only there', () => {
    // The wheel 1px up moved the view; the push back down lands at the end.
    expect(downInputResumesAtEnd({ leftAt: LEFT, highestSinceLeft: LEFT - 1 }, LEFT, 0)).toBe(true)
    // The wheel up moved nothing (still at the end): the push down is the return.
    expect(downInputResumesAtEnd({ leftAt: LEFT, highestSinceLeft: LEFT }, LEFT, 0)).toBe(true)
    // Mid-history, reading on below where they left: never a return.
    expect(downInputResumesAtEnd({ leftAt: 1000, highestSinceLeft: 800 }, 1050, 3950)).toBe(false)
    expect(downInputResumesAtEnd({ leftAt: 1000, highestSinceLeft: 1000 }, 1050, 3)).toBe(false)
    // Following already on: nothing to resume.
    expect(downInputResumesAtEnd(null, LEFT, 0)).toBe(false)
  })

  it('inside the band but short of the end and of where they left, it waits', () => {
    expect(followResumes({ leftAt: LEFT, highestSinceLeft: 2000 }, LEFT - 40, 40)).toBe(false)
  })
})

describe('the timeline scroll handler', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'web/src/components/sessions/SessionChatHistory.tsx'), 'utf8')
  it('turns following back on only through followResumes, never from the geometry alone', () => {
    expect(src).not.toMatch(/isAtBottom\.current\s*=\s*nearBottom/)
    const handler = src.slice(src.indexOf('const onScroll = () => {'), src.indexOf("el.addEventListener('scroll', onScroll"))
    expect(handler.length).toBeGreaterThan(0)
    // Every place the handler turns following on is guarded by followResumes.
    const ons = handler.split('\n').filter((l) => /isAtBottom\.current\s*=\s*true/.test(l))
    expect(ons.length).toBeGreaterThan(0)
    for (const l of ons) expect(l, l.trim()).toContain('followResumes(')
  })

  // The class behind 2026-11-04 (composer-in-flow.webkit.spec.ts, every run):
  // a return to the end made by the reader's own input must be read as theirs.
  // Every downward input path records it, and the scroll handler hands it on.
  it('passes the reader\'s downward input into every followResumes call', () => {
    const effect = src.slice(src.indexOf('const readerMovesDown = () => {'), src.indexOf("el.addEventListener('scroll', onScroll"))
    expect(effect.length).toBeGreaterThan(0)
    const calls = effect.match(/followResumes\([^\n]*/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(1)
    for (const c of calls) expect(c, c).toMatch(/,\s*readerDownNow\(\)\)/)
    // The input itself, at the end, decides through the end-only rule.
    expect(effect).toContain('downInputResumesAtEnd(leave,')
  })

  it('records a downward wheel, a finger moving up the screen, and End / Page Down as the reader moving down', () => {
    const wheel = src.slice(src.indexOf('const onWheel = (e: WheelEvent) => {'), src.indexOf('const onTouchStart'))
    expect(wheel).toMatch(/e\.deltaY > 0\)\s*\{\s*readerMovesDown\(\)/)
    const touch = src.slice(src.indexOf('const onTouchMove = (e: TouchEvent) => {'), src.indexOf('const onReaderScroll'))
    expect(touch).toMatch(/touchY - y > 4\)\s*\{\s*readerMovesDown\(\)/)
    const key = src.slice(src.indexOf('const onKeyDown = (e: KeyboardEvent) => {'), src.indexOf("el.addEventListener('keydown', onKeyDown"))
    expect(key).toContain("'End'")
    expect(key).toContain("'PageDown'")
    expect(key).toContain('readerMovesDown()')
  })
})
