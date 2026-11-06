/**
 * What the extension's lock screen says it unlocks (packages/browser-extension/src/unlock-words.ts):
 * passwords for the site the person is on, by its name, never the Walnut server's address (review
 * R2-13), and plain words when there is no site.
 */
import { describe, expect, it } from 'vitest'

;(globalThis as any).chrome = { tabs: { query: async () => [{ url: 'https://shop.lab.test/signin' }] } }
const { siteForUnlock, siteOfPage, unlockWords } = await import('../../../packages/browser-extension/src/unlock-words')

const SERVER = 'http://localhost:3640'

describe('the lock screen names the site', () => {
  it('a web page: its site; the words never name the Walnut server', () => {
    expect(siteOfPage('https://shop.lab.test/signin?x=1', SERVER)).toBe('shop.lab.test')
    const words = unlockWords(siteOfPage('https://shop.lab.test/signin', SERVER))
    expect(words).toBe('Unlock to fill passwords on shop.lab.test.')
    expect(words).not.toContain('localhost')
  })
  it('a Walnut page, a new tab or no tab: no site, and words that name none', () => {
    expect(siteOfPage('http://localhost:3640/passwords', SERVER)).toBe('')
    expect(siteOfPage('chrome://newtab/', SERVER)).toBe('')
    expect(siteOfPage(undefined, SERVER)).toBe('')
    expect(unlockWords('')).toBe('Unlock to use your passwords.')
  })
  it('reads the active tab of the window it is for', async () => {
    expect(await siteForUnlock(7, SERVER)).toBe('shop.lab.test')
  })
})
