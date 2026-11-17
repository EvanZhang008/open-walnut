/**
 * Which saved logins the extension offers (packages/browser-extension/src/login-pick.ts): the
 * two tiers of a page's logins, step two of a two-step sign in, the login a changed password
 * updates, a new login's default name, what a "Never for this site" entry covers, which frames of
 * a tab Walnut fills, and one row per login when the same login is saved twice.
 */
import { describe, expect, it } from 'vitest'
import type { VaultItemSummary } from '../../../src/core/vault/types'
import {
  cleanAccount, defaultLoginName, frameOnSite, namedFirst, neverCovers, neverEntry, oneRowPerLogin, pickUpdate, siteNameFromTitle, stepOneFirst, tiersFor, view, type MenuItem,
} from '../../../packages/browser-extension/src/login-pick'

const at = '2026-11-01T00:00:00.000Z'
function login(id: string, url: string, extra: Partial<VaultItemSummary> = {}): VaultItemSummary {
  return { id, type: 'login', title: id, urls: [url], hasPassword: true, hasTotp: false, agentAccess: 'ask', createdAt: at, updatedAt: at, ...extra } as VaultItemSummary
}

// The lab's vault: two logins of the shop, one of the accounts site.
const VAULT = [
  login('shop', 'http://shop.lab.test:3650/', { username: 'alex@lab.test', usedAt: '2026-11-03T00:00:00Z' }),
  login('work', 'http://shop.lab.test:3650/', { username: 'alex.work@lab.test', usedAt: '2026-11-02T00:00:00Z' }),
  login('accounts', 'http://accounts.lab.test:3650/', { username: 'sam@lab.test', hasTotp: true }),
  login('parent', 'http://lab.test:3650/', { username: 'root@lab.test' }),
  { ...login('card', ''), type: 'card', urls: [], cardLast4: '4242' } as VaultItemSummary,
]
const ids = (xs: MenuItem[]) => xs.map((x) => x.id)

describe('tiers of a page', () => {
  it('the shop page: its own logins first, the parent domain\'s next; the accounts login only apart, with its host', () => {
    const t = tiersFor(VAULT, 'http://shop.lab.test:3650/signin')
    expect(ids(t.first)).toEqual(['shop', 'work', 'parent'])
    expect(t.first.every((x) => x.tier === 1)).toBe(true)
    expect(t.first.map((x) => x.exact)).toEqual([true, true, false])
    expect(t.others).toEqual([expect.objectContaining({ id: 'accounts', tier: 2, site: 'accounts.lab.test', exact: false })])
  })

  it('a lookalike subdomain gets only the parent\'s login as an offer; the rest are tier 2', () => {
    const t = tiersFor(VAULT, 'http://evil.lab.test:3650/')
    expect(ids(t.first)).toEqual(['parent'])
    expect(ids(t.others).sort()).toEqual(['accounts', 'shop', 'work'])
    expect(t.others.find((x) => x.id === 'shop')?.site).toBe('shop.lab.test')
  })

  it('another registrable domain gets nothing in either tier', () => {
    const t = tiersFor(VAULT, 'http://lab-shop.test:3650/')
    expect(t.first).toEqual([])
    expect(t.others).toEqual([])
  })

  it('a card row shows its last four digits', () => {
    expect(view(VAULT[4]).sub).toBe('•••• 4242')
  })
})

describe('step two of a two-step sign in', () => {
  const items = tiersFor(VAULT, 'http://shop.lab.test:3650/password').first
  it('the login picked on step one comes alone, the rest under Other logins', () => {
    const r = stepOneFirst(items, { itemId: 'work' })
    expect(ids(r.items)).toEqual(['work'])
    expect(ids(r.more)).toEqual(['shop', 'parent'])
  })
  it('the username typed on step one, in any case', () => {
    const r = stepOneFirst(items, { username: 'ALEX@lab.test' })
    expect(ids(r.items)).toEqual(['shop'])
    expect(r.more).toHaveLength(2)
  })
  it('no hint, or one that names none of them: the list as it is', () => {
    expect(stepOneFirst(items).items).toEqual(items)
    expect(stepOneFirst(items, { username: 'nobody@lab.test' })).toEqual({ items, more: [] })
  })
})

describe('the account the page names (a change form, a username it filled in)', () => {
  // The shop's own logins, the most recently used first: alex@ ('shop') then the work account.
  const items = tiersFor(VAULT, 'http://shop.lab.test:3650/account/password').first
  it('that login first and alone, the others under Other logins, however recently they were used (R2-12)', () => {
    const r = namedFirst(items, 'alex.work@lab.test')!
    expect(ids(r.items)).toEqual(['work'])
    expect(ids(r.more)).toEqual(['shop', 'parent'])
    expect(ids(namedFirst(items, '  ALEX@LAB.TEST ')!.items)).toEqual(['shop'])
  })
  it('no account, or one that names none of the logins: null, the menu as it was', () => {
    expect(namedFirst(items, undefined)).toBeNull()
    expect(namedFirst(items, '   ')).toBeNull()
    expect(namedFirst(items, 'nobody@lab.test')).toBeNull()
    expect(namedFirst(items.slice(0, 1), 'alex@lab.test')).toBeNull()
  })
  it('a page sends one short line, nothing else', () => {
    expect(cleanAccount(' alex@lab.test ')).toBe('alex@lab.test')
    expect(cleanAccount(42)).toBeUndefined()
    expect(cleanAccount('')).toBeUndefined()
    expect(cleanAccount('a\nb')).toBeUndefined()
    expect(cleanAccount('x'.repeat(321))).toBeUndefined()
  })
})

describe('the login a changed password updates', () => {
  const cands = [
    { id: 'accounts', username: 'sam@lab.test', password: 'Accounts-Pass', exact: false, usedAt: '2026-11-04T00:00:00Z' },
    { id: 'work', username: 'alex.work@lab.test', password: 'Work-Pass', exact: true, usedAt: '2026-11-02T00:00:00Z' },
    { id: 'shop', username: 'alex@lab.test', password: 'Shop-Pass', exact: true, usedAt: '2026-11-01T00:00:00Z' },
  ]
  it('the one whose saved password is the form\'s current one', () => {
    expect(pickUpdate(cands, 'Shop-Pass')).toBe('shop')
    expect(pickUpdate(cands, 'Shop-Pass', 'work')).toBe('shop')
  })
  it('else the login just filled or sent on this tab', () => {
    expect(pickUpdate(cands, undefined, 'shop')).toBe('shop')
    expect(pickUpdate(cands, 'not-saved', 'shop')).toBe('shop')
  })
  it('else this host\'s own login before another host\'s, however recent that one is', () => {
    expect(pickUpdate(cands)).toBe('work')
    expect(pickUpdate([])).toBeUndefined()
  })
})

describe('a new login\'s default name', () => {
  it.each([
    ['Sign in to Lab Shop', 'shop.lab.test', 'Lab Shop'],
    ['Create your Lab Shop account', 'shop.lab.test', 'Lab Shop'],
    ['Sign in · GitHub', 'github.com', 'GitHub'],
    ['Login | Netflix', 'www.netflix.com', 'Netflix'],
    ['Netflix Sign In', 'www.netflix.com', 'Netflix'],
    ['Welcome to Example Mail', 'mail.example.com', 'Example Mail'],
    ['Lab Shop', 'shop.lab.test', 'Lab Shop'],
  ])('%s -> %s', (title, host, name) => {
    expect(siteNameFromTitle(title, host)).toBe(name)
  })

  it.each([['Sign in: step 1 of 3'], ['Checkout'], ['Change your password'], ['Welcome back'], ['']])('%s names no site', (title) => {
    expect(siteNameFromTitle(title, 'accounts.lab.test')).toBeNull()
  })

  it('the name the site gives itself wins; else the title; else the host without www', () => {
    expect(defaultLoginName({ url: 'https://shop.lab.test/signup', metaName: 'Lab Shop', title: 'Create an account' })).toBe('Lab Shop')
    expect(defaultLoginName({ url: 'http://shop.lab.test:3650/signup', title: 'Create your Lab Shop account' })).toBe('Lab Shop')
    expect(defaultLoginName({ url: 'https://www.example.com/join', title: 'Sign up' })).toBe('example.com')
    expect(defaultLoginName({ url: 'http://accounts.lab.test:3650/password' })).toBe('accounts.lab.test')
  })
})

describe('Never for this site', () => {
  it('stores the exact host and covers it and the hosts under it, never a sibling', () => {
    expect(neverEntry('http://evil.lab.test:3650/signin')).toBe('evil.lab.test')
    const list = [neverEntry('http://evil.lab.test:3650/signin')]
    expect(neverCovers(list, 'http://evil.lab.test:3650/other')).toBe(true)
    expect(neverCovers(list, 'http://login.evil.lab.test/')).toBe(true)
    expect(neverCovers(list, 'http://shop.lab.test:3650/signup')).toBe(false)
    expect(neverCovers(list, 'http://lab.test/')).toBe(false)
  })

  it('an entry saved before (a registrable domain) still covers its whole site', () => {
    expect(neverCovers(['lab.test'], 'http://shop.lab.test:3650/signup')).toBe(true)
    expect(neverCovers(['lab.test'], 'http://lab.test/')).toBe(true)
    expect(neverCovers(['lab.test'], 'http://lab-shop.test/')).toBe(false)
    expect(neverCovers([], 'http://lab.test/')).toBe(false)
  })
})

describe('frameOnSite: the frames of a tab a fill may go to', () => {
  it('the top page and frames of its origin', () => {
    expect(frameOnSite('https://shop.example.com/a', 'https://shop.example.com/b')).toBe(true)
  })
  it('a frame of another origin on the same site: the site\'s own sign-in host (2026-11-17, idmsa.apple.com)', () => {
    expect(frameOnSite('https://idmsa.apple.com/appleauth/auth/signin', 'https://appstoreconnect.apple.com/login')).toBe(true)
    expect(frameOnSite('https://idmsa.apple.com/x', 'https://developer.apple.com/account')).toBe(true)
    expect(frameOnSite('https://login.example.co.uk/', 'https://www.example.co.uk/')).toBe(true)
  })
  it('never another site, another scheme, a sandboxed or a non-web frame', () => {
    expect(frameOnSite('https://accounts.google.com/', 'https://evil.example/')).toBe(false)
    // A public suffix is no site of its own: two sites under it are two sites.
    expect(frameOnSite('https://a.github.io/', 'https://b.github.io/')).toBe(false)
    expect(frameOnSite('https://a.example.co.uk/', 'https://b.other.co.uk/')).toBe(false)
    expect(frameOnSite('http://login.example.com/', 'https://www.example.com/')).toBe(false)
    expect(frameOnSite('data:text/html,<form>', 'https://www.example.com/')).toBe(false)
    expect(frameOnSite('about:blank', 'https://www.example.com/')).toBe(false)
    expect(frameOnSite('not a url', 'https://www.example.com/')).toBe(false)
    expect(frameOnSite('https://www.example.com/', '')).toBe(false)
  })
})

describe('oneRowPerLogin: the same login saved twice is one row', () => {
  const secrets: Record<string, string> = { a1: 'p1', a2: 'p1', a3: 'p2', b1: 'p1', c1: 'p1', c2: 'p1', o1: 'p1', r1: 'p1', r2: 'p1' }
  const asked: string[] = []
  const digestOf = async (x: string) => { asked.push(x); return secrets[x] }
  const row = (id: string, username?: string) => ({ id, ...(username ? { username } : {}) })

  it('keeps the first of each username and password, across lists; another password, another user or no user stay', async () => {
    asked.length = 0
    const [first, others] = await oneRowPerLogin([
      [row('a1', 'zc@example.com'), row('a2', ' ZC@example.com '), row('a3', 'zc@example.com'), row('b1', 'evan@example.com'), row('c1'), row('c2')],
      [row('o1', 'zc@example.com')],
    ], digestOf)
    expect(first.map((r) => r.id)).toEqual(['a1', 'a3', 'b1', 'c1', 'c2'])
    expect(others.map((r) => r.id)).toEqual([])
    // Only rows that share a username are read.
    expect(asked.sort()).toEqual(['a1', 'a2', 'a3', 'o1'])
  })
  it('a username that is not an email keeps its case: Admin and admin are two accounts', async () => {
    const [rows] = await oneRowPerLogin([[row('r1', 'Admin'), row('r2', 'admin')]], digestOf)
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2'])
  })
  it('nothing alike: every row stays, in order, and nothing is read', async () => {
    asked.length = 0
    const lists = [[row('a1', 'x@e.com'), row('b1', 'y@e.com')]]
    expect((await oneRowPerLogin(lists, digestOf))[0].map((r) => r.id)).toEqual(['a1', 'b1'])
    expect(asked).toEqual([])
  })
})
