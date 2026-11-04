/**
 * Which tabs agents may use with the browser-wide switch off (packages/browser-extension/src/agent-tab-kind.ts):
 * a tab the person handed over from the side panel, and the popups it opens (also a popup's popup).
 * A popup from a tab an agent took, or from an agent's own tab, is not one: the person handed neither.
 */
import { describe, expect, it } from 'vitest'
import { inHandedReach, popupRecord } from '../../../packages/browser-extension/src/agent-tab-kind'

const owner = 'task:t1'

describe('the reach of a tab the person handed over', () => {
  it('a handed tab and the popups it opens, through any depth', () => {
    const handed = { owner, history: [], handed: 'shop.example.test' }
    const popup = popupRecord(handed, 'http://shop.example.test/help')
    expect(popup).toMatchObject({ owner, popup: true, fromPerson: true, viaHanded: true, history: ['http://shop.example.test/help'] })
    expect(inHandedReach(handed)).toBe(true)
    expect(inHandedReach(popup)).toBe(true)
    expect(inHandedReach(popupRecord(popup))).toBe(true)
  })

  it('not a popup of a tab an agent took (it is the person\'s, but they did not hand it over)', () => {
    const taken = { owner, history: [], taken: true }
    const popup = popupRecord(taken)
    expect(popup.fromPerson).toBe(true)
    expect(inHandedReach(taken)).toBe(false)
    expect(inHandedReach(popup)).toBe(false)
    expect(inHandedReach(popupRecord(popup))).toBe(false)
  })

  it('not an agent\'s own tab or its popups, and not an unknown tab', () => {
    const own = { owner, history: [] }
    expect(inHandedReach(own)).toBe(false)
    expect(popupRecord(own).fromPerson).toBeUndefined()
    expect(inHandedReach(popupRecord(own))).toBe(false)
    expect(inHandedReach(undefined)).toBe(false)
  })
})
