/**
 * Settings controls keep their press (press-keeps-target.ts; 2026-11-05, Remote Hosts in WebKit:
 * Revoke sent nothing because the row above lost a line between the press and the release, so the
 * release landed beside the button and the browser clicked nothing). The browser half (a press held
 * while the row shrinks) is pinned in remote-hosts-every-button-host.ts; this pins the rule.
 */
import { describe, expect, it } from 'vitest'
import { SLOP_PX, releaseIsPress } from '../../web/src/components/settings/inputs/press-keeps-target'
import { readStillCurrent } from '../../web/src/components/settings/sections/host-settings-data'

describe('releaseIsPress: a press released where it went down is the control\'s click', () => {
  it('the control moved away under a still pointer: its click', () => {
    expect(releaseIsPress({ x: 100, y: 200 }, { x: 100, y: 200, onControl: false })).toBe(true)
    expect(releaseIsPress({ x: 100, y: 200 }, { x: 100 + SLOP_PX, y: 200 - SLOP_PX, onControl: false })).toBe(true)
  })
  it('released on the control itself: the browser clicks it, never a second time here', () => {
    expect(releaseIsPress({ x: 100, y: 200 }, { x: 100, y: 200, onControl: true })).toBe(false)
  })
  it('a pointer that moved away cancels, as it always has', () => {
    expect(releaseIsPress({ x: 100, y: 200 }, { x: 100 + SLOP_PX + 1, y: 200, onControl: false })).toBe(false)
    expect(releaseIsPress({ x: 100, y: 200 }, { x: 100, y: 240, onControl: false })).toBe(false)
  })
})

// The same day: a read of the exec grants sent while a switch's write ran, answered after it, put
// Off back on screen for a moment (the old check looked only when the answer came).
describe('readStillCurrent: a read sent while a write ran never paints', () => {
  it('sent while a write ran, answered after it settled: refused', () => {
    expect(readStillCurrent({ seq: 2, inFlight: 1 }, { seq: 2, inFlight: 0 })).toBe(false)
  })
  it('a write began after it was sent: refused', () => {
    expect(readStillCurrent({ seq: 2, inFlight: 0 }, { seq: 3, inFlight: 0 })).toBe(false)
    expect(readStillCurrent({ seq: 2, inFlight: 0 }, { seq: 3, inFlight: 1 })).toBe(false)
  })
  it('no write around it: it paints', () => {
    expect(readStillCurrent({ seq: 2, inFlight: 0 }, { seq: 2, inFlight: 0 })).toBe(true)
  })
})
