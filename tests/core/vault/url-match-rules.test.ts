/**
 * Per-site match rules on saved URLs (url-match.ts): base domain by default, the exact host and
 * port, starts with, never. Old URLs (no rule) keep matching by registrable domain.
 */
import { describe, it, expect } from 'vitest'
import { insecureOnly, matchItem, matchSite, normalizeUrl, splitRule, withRule, displayHost } from '../../../src/core/vault/url-match.js'

describe('url match rules', () => {
  it('reads an old URL as base domain and keeps a rule through normalizing', () => {
    expect(splitRule('https://example.com')).toEqual({ url: 'https://example.com', rule: 'domain' })
    expect(normalizeUrl('Accounts.Example.com#walnut-match=host')).toBe('https://accounts.example.com#walnut-match=host')
    // Any other fragment still goes.
    expect(normalizeUrl('https://example.com/a#top')).toBe('https://example.com/a')
    expect(withRule('https://a.test#walnut-match=never', 'domain')).toBe('https://a.test')
    expect(splitRule('https://a.test#walnut-match=bogus').rule).toBe('domain')
    expect(displayHost('https://accounts.example.com#walnut-match=host')).toBe('accounts.example.com')
  })

  it('domain (default): any host of the registrable domain', () => {
    expect(matchSite('https://example.com', 'https://login.example.com/x')).toBe('domain')
  })

  it('host: the same host and port only', () => {
    const saved = withRule('https://accounts.example.com', 'host')
    expect(matchSite(saved, 'https://accounts.example.com/login')).toBe('exact_host')
    expect(matchSite(saved, 'https://www.example.com/')).toBeNull()
    expect(matchSite(saved, 'https://accounts.example.com:8443/')).toBeNull()
    expect(matchSite(withRule('http://localhost:3000', 'host'), 'http://localhost:8080/')).toBeNull()
    expect(matchSite(withRule('http://localhost:3000', 'host'), 'http://localhost:3000/a')).toBe('exact_host')
  })

  it('starts: a page whose address starts with the saved one', () => {
    const saved = withRule('https://example.com/app', 'starts')
    expect(matchSite(saved, 'https://example.com/app/login?x=1')).toBe('exact_host')
    expect(matchSite(saved, 'https://example.com/other')).toBeNull()
    expect(matchSite(saved, 'http://example.com/app')).toBeNull()
  })

  it('never: the URL is kept but nothing matches it', () => {
    expect(matchItem([withRule('https://example.com', 'never')], 'https://example.com/')).toBeNull()
    expect(matchItem([withRule('https://example.com', 'never'), 'https://example.com'], 'https://example.com/')).toBe('exact_host')
  })

  it('an https login on an http page is told apart from no login at all', () => {
    expect(insecureOnly(['https://example.com'], 'http://example.com/login')).toBe(true)
    expect(insecureOnly(['http://example.com'], 'http://example.com/login')).toBe(false)
    expect(insecureOnly(['https://other.test'], 'http://example.com/login')).toBe(false)
  })
})
