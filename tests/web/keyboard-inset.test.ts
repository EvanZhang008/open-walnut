/**
 * The on-screen keyboard as a number (web/src/hooks/useVisualViewportInset.ts,
 * spec 4.4, C29): the part of the layout viewport the keyboard covers.
 */
import { describe, it, expect } from 'vitest'
import { keyboardInset } from '../../web/src/hooks/useVisualViewportInset'

describe('keyboardInset', () => {
  it('is 0 with no keyboard', () => {
    expect(keyboardInset(844, 844, 0)).toBe(0)
  })

  it('is the keyboard height when it opens (390 x 844, 336 px keyboard)', () => {
    expect(keyboardInset(844, 508, 0)).toBe(336)
  })

  it('subtracts the visual viewport offset Safari scrolls by', () => {
    expect(keyboardInset(844, 508, 120)).toBe(216)
  })

  it('never goes negative (a pinch zoom or an offset past the keyboard)', () => {
    expect(keyboardInset(844, 900, 0)).toBe(0)
    expect(keyboardInset(844, 508, 400)).toBe(0)
  })

  it('rounds sub-pixel viewports and rejects NaN', () => {
    expect(keyboardInset(844, 507.6, 0)).toBe(336)
    expect(keyboardInset(844, Number.NaN, 0)).toBe(0)
  })
})
