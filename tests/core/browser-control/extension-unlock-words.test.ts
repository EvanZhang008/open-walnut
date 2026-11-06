/**
 * What the extension's lock screen says it unlocks (packages/browser-extension/src/unlock-words.ts):
 * passwords for the site the person is on, by its name, never the Walnut server's address (review
 * R2-13), and plain words when there is no site.
 */
import { describe, expect, it } from 'vitest'

;(globalThis as any).chrome = { tabs: { query: async () => [{ url: 'https://shop.lab.test/signin' }] } }
const { pageHost, siteForUnlock, siteOfPage, unlockWords } = await import('../../../packages/browser-extension/src/unlock-words')
const { displayHost } = await import('../../../src/core/vault/url-match')

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
  it("a page's host is Walnut's own name for its site, without the public suffix list (R3-7)", () => {
    for (const url of ['https://Shop.Lab.Test/signin?x=1#a', 'http://localhost:3670/', 'https://user:pw@login.example.co.uk:8443/a', 'https://192.168.1.4/x', 'https://xn--bcher-kva.example/', 'https://b\u00fccher.example/']) {
      expect(pageHost(url)).toBe(displayHost(url))
    }
    expect(pageHost('chrome://newtab/')).toBe('')
    expect(pageHost('not a url')).toBe('')
  })
  it('reads the active tab of the window it is for', async () => {
    expect(await siteForUnlock(7, SERVER)).toBe('shop.lab.test')
  })
})

describe('the extension says its passwords lock, never Walnut (R3-10: Ask keeps working while they are locked)', () => {
  it('no string in its source says Walnut is locked, or to lock or unlock Walnut', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = path.join(process.cwd(), 'packages/browser-extension/src')
    const offenders: string[] = []
    for (const f of fs.readdirSync(dir).filter((n) => /\.(ts|css|html)$/.test(n))) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
      lines.forEach((l, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
        if (/['"`][^'"`]*\b(Walnut is locked|(Lock|Unlock) Walnut)\b/.test(l)) offenders.push(`${f}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
