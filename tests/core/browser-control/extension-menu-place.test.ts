/**
 * The in-page menu's pure parts: where it is drawn for a field (content-place.ts), and the plain
 * note a card or address fill gives when the item lacks a value the form asks for (wallet-detect.ts).
 */
import { describe, expect, it } from 'vitest'
import { menuSpot, type Rect } from '../../../packages/browser-extension/src/content-place'
import { fillNote } from '../../../packages/browser-extension/src/wallet-detect'
import { distinctName } from '../../../packages/browser-extension/src/savebar-name'

const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height })
const VIEW = { w: 1280, h: 860 }
const W = 320

describe('where the menu goes: under the field, above it only without room, never past the frame', () => {
  it('under the field, on every page alike, with no send button in the way', () => {
    const field = rect(280, 175, 360, 40)
    expect(menuSpot(field, 170, W, VIEW)).toEqual({ top: 219, left: 280, height: 170 })
  })

  it('above the field when there is no room under it', () => {
    const field = rect(280, 760, 360, 40)
    expect(menuSpot(field, 170, W, VIEW)).toEqual({ top: 760 - 4 - 170, left: 280, height: 170 })
  })

  it('kept inside the window on the right', () => {
    expect(menuSpot(rect(1100, 100, 160, 30), 120, W, VIEW).left).toBe(1280 - W - 4)
  })

  it('inside a short frame: never past its edges', () => {
    // The review lab's framed sign in: a 340 px frame, the email field near its middle.
    const field = rect(20, 175, 360, 40)
    const s = menuSpot(field, 230, W, { w: 720, h: 340 })
    expect(s.top).toBeGreaterThanOrEqual(4)
    expect(s.top + s.height).toBeLessThanOrEqual(336)
  })

  it('a frame too small for all of it: the taller side, the menu cut to fit', () => {
    const s = menuSpot(rect(10, 60, 260, 30), 300, 280, { w: 300, h: 200 })
    expect(s.top).toBe(94)
    expect(s.height).toBe(200 - 90 - 8)
  })
})

describe("never over the form's send button when there is room above the field (R3-11)", () => {
  const covers = (s: { top: number; left: number; height: number }, r: Rect) =>
    s.left < r.right && s.left + W > r.left && s.top < r.bottom && s.top + s.height > r.top

  it('a sign-up: the button under the password field, the menu goes above the field', () => {
    const field = rect(280, 400, 360, 40)
    const button = rect(280, 460, 360, 44)
    const s = menuSpot(field, 170, W, VIEW, [button])
    expect(s).toEqual({ top: 400 - 4 - 170, left: 280, height: 170 })
    expect(covers(s, button)).toBe(false)
  })

  it('no room above: under the field as before, never beside it (one predictable spot)', () => {
    const field = rect(200, 120, 360, 40)
    const button = rect(200, 180, 360, 44)
    expect(menuSpot(field, 300, W, { w: 1280, h: 480 }, [button])).toEqual({ top: 164, left: 200, height: 300 })
  })

  it('a button above the field as well: under it', () => {
    const field = rect(280, 400, 360, 40)
    expect(menuSpot(field, 170, W, VIEW, [rect(280, 460, 360, 44), rect(280, 300, 120, 30)])).toEqual({ top: 444, left: 280, height: 170 })
  })

  it('a button that is not in the way changes nothing', () => {
    const field = rect(280, 175, 360, 40)
    expect(menuSpot(field, 170, W, VIEW, [rect(280, 600, 360, 44)])).toEqual({ top: 219, left: 280, height: 170 })
  })

  it('no room anywhere but over it: under the field as before, never past the frame', () => {
    const v = { w: 380, h: 340 }
    const field = rect(10, 60, 360, 30)
    const s = menuSpot(field, 230, W, v, [rect(10, 100, 360, 40)])
    expect(s.top).toBe(94)
    expect(s.top + s.height).toBeLessThanOrEqual(336)
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

describe('the name the save bar suggests for a new login', () => {
  it('the site\'s name when it has no login of that name', () => {
    expect(distinctName('Lab Shop', 'newuser@lab.test', ['Lab Accounts'])).toBe('Lab Shop')
  })

  it('tells it apart from the site\'s login of the same name, by its username', () => {
    expect(distinctName('Lab Shop', 'newuser@lab.test', ['Lab Shop', 'Lab Shop (work)'])).toBe('Lab Shop (newuser@lab.test)')
    expect(distinctName('Lab Shop', 'newuser@lab.test', ['lab shop'])).toBe('Lab Shop (newuser@lab.test)')
  })

  it('a number when there is no username, or that name is taken too', () => {
    expect(distinctName('Lab Shop', '', ['Lab Shop'])).toBe('Lab Shop 2')
    expect(distinctName('Lab Shop', 'a@b.c', ['Lab Shop', 'Lab Shop (a@b.c)', 'Lab Shop 2'])).toBe('Lab Shop 3')
  })
})
