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
import { followResumes } from '../../web/src/components/sessions/follow-resume'

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
})
