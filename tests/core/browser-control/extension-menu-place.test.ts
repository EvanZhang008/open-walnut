/**
 * The in-page menu's pure parts: where it is drawn for a field (content-place.ts), and the plain
 * note a card or address fill gives when the item lacks a value the form asks for (wallet-detect.ts).
 */
import { describe, expect, it } from 'vitest'
import { menuSpot, type Rect, type Spot } from '../../../packages/browser-extension/src/content-place'
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

  it('a frame too short for a few rows on either side: over the field, inside the frame (L7)', () => {
    // 120 px frame, the field in its middle: 36 px under it, 42 over it.
    const s = menuSpot(rect(10, 46, 260, 30), 300, 280, { w: 300, h: 120 })
    expect(s.top).toBeGreaterThanOrEqual(4)
    expect(s.top + s.height).toBeLessThanOrEqual(116)
  })
})

describe('under the field whenever it fits there, a send button under it or not (R4-6)', () => {
  // The placement takes the field and the view alone: what else is on the page (the form's send
  // button, the page's own words) never moves it. Round 3 passed the form's send buttons for its
  // last field and put the menu above it, over the page's instruction and the fields just typed.
  const place = menuSpot as unknown as (...a: unknown[]) => Spot

  it('a sign-up: the button right under the password field, the menu still under the field', () => {
    const field = rect(280, 400, 360, 40)
    const button = rect(280, 460, 360, 44)
    expect(place(field, 170, W, VIEW, [button])).toEqual({ top: 444, left: 280, height: 170 })
  })

  it('the code page: Verify right under the code field, room above too, 512 px free under it: the menu under the field', () => {
    const field = rect(280, 300, 360, 40)
    expect(place(field, 230, W, VIEW, [rect(280, 350, 90, 40)])).toEqual({ top: 344, left: 280, height: 230 })
  })

  it('above the field only when it does not fit under it, whatever room there is above', () => {
    const field = rect(280, 700, 360, 40)
    // 860 - 740 - 8 = 112 px under it: a 170 px menu goes above.
    expect(menuSpot(field, 170, W, VIEW)).toEqual({ top: 700 - 4 - 170, left: 280, height: 170 })
    // A 110 px menu fits under it: under.
    expect(menuSpot(field, 110, W, VIEW)).toEqual({ top: 744, left: 280, height: 110 })
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
