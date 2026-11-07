/**
 * The words that say where an agent is in the person's browser and which of their own tabs
 * already hold the site (src/core/browser-control/where-words.ts), and the same words in the
 * `browser` op's outcome and in `walnut browser`.
 */
import { describe, expect, it } from 'vitest'
import {
  HAND_OVER_STEP, personTabsNote, sameSiteTabs, signInRefusal, tabWords, whereLine, windowWords,
} from '../../../src/core/browser-control/where-words'

describe('which window and tab', () => {
  it('names the agent window as behind theirs and not minimized, or the person\'s own', () => {
    expect(windowWords('agent')).toBe('Walnut\'s agent window (behind theirs, not minimized)')
    expect(windowWords('agent', 'minimized')).toBe('Walnut\'s agent window (the person minimized it)')
    expect(windowWords('person')).toMatch(/^the person's own window/)
    // An older extension says nothing: the action tells.
    expect(windowWords(undefined, undefined, 'open')).toMatch(/agent window/)
    expect(windowWords(undefined, undefined, 'take')).toMatch(/person's own window/)
  })

  it('one line with the window, the tab id, its title and its address', () => {
    expect(whereLine('open', { tab: 812, title: 'Online Banking', url: 'https://bank.example.com/home', window: 'agent', windowState: 'normal' }))
      .toBe('In Walnut\'s agent window (behind theirs, not minimized), tab 812 "Online Banking" (https://bank.example.com/home).')
    expect(tabWords({ tab: 3 })).toBe('tab 3')
    expect(tabWords({ tab: 3, title: 'x'.repeat(200) }).length).toBeLessThan(100)
  })
})

describe('the person\'s own tabs on the site', () => {
  const tabs = [
    { id: 1, url: 'https://www.bank.example.com/accounts', title: 'Accounts', active: true },
    { id: 2, url: 'https://secure.bank.example.com/login', title: 'Sign in' },
    { id: 3, url: 'https://bank.example.com/x', title: 'Mine', owner: 'task:t1' },
    { id: 4, url: 'https://other.example.org/', title: 'Elsewhere' },
    { id: 5, url: 'https://evil-bank.example.com.attacker.test/', title: 'Not the bank' },
    { id: 6, title: 'No address' },
  ]
  it('same registrable domain, not an agent\'s tab', () => {
    expect(sameSiteTabs(tabs, 'https://bank.example.com/login')).toEqual([
      { id: 1, title: 'Accounts', active: true },
      { id: 2, title: 'Sign in' },
    ])
    expect(sameSiteTabs(tabs, 'https://nowhere.example.net/')).toEqual([])
    expect(sameSiteTabs(undefined, 'https://bank.example.com/')).toEqual([])
    expect(sameSiteTabs(tabs, 'not a url')).toEqual([])
  })

  it('the note names each tab and the step instead of a second sign-in', () => {
    const note = personTabsNote('example.com', sameSiteTabs(tabs, 'https://bank.example.com/'))
    expect(note).toBe(`They already have example.com open in tab 1 ("Accounts", the tab they are on) and tab 2 ("Sign in"). ${HAND_OVER_STEP}`)
    expect(note).toMatch(/hand that tab over \("Act in tab" in Walnut's side panel/)
    expect(note).toMatch(/Do not sign in again\.$/)
    const many = personTabsNote('example.com', [1, 2, 3, 4, 5].map((id) => ({ id })))
    expect(many).toMatch(/tab 1, tab 2 and tab 3 and 2 more/)
  })

  it('the fill_login refusal says the same, and how a fresh sign-in the person asked for goes', () => {
    const r = signInRefusal('example.com', [{ id: 9, title: 'Online Banking', active: true }])
    expect(r).toMatch(/already has example\.com open in tab 9 \("Online Banking", the tab they are on\)/)
    expect(r).toContain(HAND_OVER_STEP)
    expect(r).toMatch(/fresh_sign_in: true/)
  })
})
