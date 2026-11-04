/**
 * The in-page menu's pure parts: where it is drawn for a field (content-place.ts), and the plain
 * note a card or address fill gives when the item lacks a value the form asks for (wallet-detect.ts).
 */
import { describe, expect, it } from 'vitest'
import { menuSpot, type Rect } from '../../../packages/browser-extension/src/content-place'
import { fillNote } from '../../../packages/browser-extension/src/wallet-detect'

const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height })
const VIEW = { w: 1280, h: 860 }
const W = 320

describe('where the menu goes', () => {
  it('under the field when that covers no send button', () => {
    const field = rect(280, 175, 360, 40)
    expect(menuSpot(field, 170, W, VIEW, [rect(280, 700, 360, 40)])).toEqual({ top: 219, left: 280, height: 170 })
  })

  it('beside the field when under it would cover the form\'s Next or Verify button', () => {
    const field = rect(280, 175, 360, 40)
    const next = rect(280, 225, 360, 40)
    const s = menuSpot(field, 170, W, VIEW, [next])
    expect(s.left).toBe(648)
    expect(s.top).toBe(175)
  })

  it('above the field when there is no room beside it (a narrow window)', () => {
    const field = rect(20, 400, 360, 40)
    const s = menuSpot(field, 170, W, { w: 400, h: 860 }, [rect(20, 450, 360, 40)])
    expect(s.top).toBe(400 - 170 - 4)
  })

  it('under the field anyway when no place is clear of the button', () => {
    const field = rect(20, 100, 360, 40)
    const s = menuSpot(field, 170, W, { w: 400, h: 860 }, [rect(20, 150, 360, 40)])
    expect(s.top).toBe(144)
  })

  it('inside a short frame: never past its edges, beside the field when that fits', () => {
    // The review lab's framed sign in: a 340 px frame, the email field near its middle.
    const field = rect(20, 175, 360, 40)
    const view = { w: 720, h: 340 }
    const s = menuSpot(field, 230, W, view, [])
    expect(s.top).toBeGreaterThanOrEqual(4)
    expect(s.top + s.height).toBeLessThanOrEqual(336)
    expect(s.left + W).toBeLessThanOrEqual(716)
  })

  it('a frame too small for all of it: the taller side, the menu cut to fit', () => {
    const field = rect(10, 60, 260, 30)
    const view = { w: 300, h: 200 }
    const s = menuSpot(field, 300, 280, view, [])
    expect(s.top).toBe(94)
    expect(s.height).toBe(200 - 90 - 8)
  })
})

describe('the note after a card or address fill', () => {
  it('names what the card lacks, in words', () => {
    expect(fillNote('card', { filled: 3, missing: ['cc-csc'] })).toBe('Filled 3 fields. This card has no security code saved in Walnut.')
  })

  it('says nothing was filled, and why', () => {
    expect(fillNote('card', { filled: 0, missing: ['cc-number', 'cc-exp', 'cc-csc'] })).toBe('Nothing filled: this card has no card number, expiry date or security code saved in Walnut.')
  })

  it('stays quiet when every field got its value, or only optional ones are empty', () => {
    expect(fillNote('identity', { filled: 6, missing: [] })).toBe('')
    expect(fillNote('identity', { filled: 6, missing: ['address-line2', 'organization'] })).toBe('')
    expect(fillNote('identity', { filled: 5, missing: ['tel'] })).toBe('Filled 5 fields. This identity has no phone saved in Walnut.')
  })
})
