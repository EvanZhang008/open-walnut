/**
 * The popup's pure parts (packages/browser-extension/src/popup-connect.ts, popup-item-data.ts):
 * where it looks for Walnut before asking for an address (only places the person or Walnut
 * chose, most likely first), which answer it offers, and what an item's detail view shows,
 * with every secret only named, never carried.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { VaultItem } from '../../../src/core/vault/types'

const state = { local: {} as Record<string, unknown>, tabUrl: '' as string, folder: null as unknown }
;(globalThis as any).fetch = async (url: string) => {
  if (String(url).endsWith('walnut-folder.json')) return state.folder ? { ok: true, json: async () => state.folder } : { ok: false, json: async () => null }
  throw new Error('no network in this test')
}
;(globalThis as any).chrome = {
  runtime: { getURL: (p: string) => `chrome-extension://self/${p}` },
  tabs: { query: async () => [{ url: state.tabUrl }] },
  storage: { local: { get: async (k: string) => ({ [k]: state.local[k] }), set: async (o: Record<string, unknown>) => { Object.assign(state.local, o) } } },
}

const { walnutCandidates, findWalnut, rememberServer } = await import('../../../packages/browser-extension/src/popup-connect')
const { itemDetail, secretField, webUrl } = await import('../../../packages/browser-extension/src/popup-item-data')

beforeEach(() => { state.local = {}; state.tabUrl = ''; state.folder = null })

describe('where the popup looks for Walnut', () => {
  it('this computer\'s default address, under both loopback names, when nothing else is known', () => {
    expect(walnutCandidates({})).toEqual(['http://localhost:3456', 'http://127.0.0.1:3456'])
  })

  it('the open connect page first, then the Walnut that set up the folder, then the last one connected', () => {
    expect(walnutCandidates({
      tabUrl: 'https://walnut.example.org/connect-extension',
      folderServer: 'http://localhost:4000',
      last: 'https://walnut.example.org',
    })).toEqual(['https://walnut.example.org', 'http://localhost:4000', 'http://localhost:3456', 'http://127.0.0.1:3456'])
  })

  it('a tab counts only on Walnut\'s connect page: any other page the person is on never suggests itself', () => {
    expect(walnutCandidates({ tabUrl: 'https://shop.example.com/login' })).toEqual(['http://localhost:3456', 'http://127.0.0.1:3456'])
    expect(walnutCandidates({ tabUrl: 'chrome-extension://self/popup.html' })).toEqual(['http://localhost:3456', 'http://127.0.0.1:3456'])
    expect(walnutCandidates({ tabUrl: 'javascript:alert(1)//connect-extension' })[0]).toBe('http://localhost:3456')
  })

  it('a connect page of an unknown site is never a candidate: any site can serve /connect-extension and answer as Walnut', () => {
    const defaults = ['http://localhost:3456', 'http://127.0.0.1:3456']
    expect(walnutCandidates({ tabUrl: 'https://evil.example/connect-extension' })).toEqual(defaults)
    expect(walnutCandidates({ tabUrl: 'https://evil.example/connect-extension', last: 'https://walnut.example.org', folderServer: 'http://localhost:4000' }))
      .toEqual(['http://localhost:4000', 'https://walnut.example.org', ...defaults])
    // A look-alike host or another port of a known Walnut is another site.
    expect(walnutCandidates({ tabUrl: 'https://walnut.example.org.evil.example/connect-extension', last: 'https://walnut.example.org' })[0]).toBe('https://walnut.example.org')
    expect(walnutCandidates({ tabUrl: 'https://walnut.example.org:8443/connect-extension', last: 'https://walnut.example.org' })).not.toContain('https://walnut.example.org:8443')
  })

  it('a connect page counts when it is this computer, the folder\'s Walnut or the last one connected', () => {
    expect(walnutCandidates({ tabUrl: 'http://localhost:3640/connect-extension' })[0]).toBe('http://localhost:3640')
    expect(walnutCandidates({ tabUrl: 'http://127.0.0.1:3640/connect-extension/' })[0]).toBe('http://127.0.0.1:3640')
    expect(walnutCandidates({ tabUrl: 'http://[::1]:3640/connect-extension' })[0]).toBe('http://[::1]:3640')
    expect(walnutCandidates({ tabUrl: 'https://walnut.example.org/connect-extension', folderServer: 'https://walnut.example.org' })[0]).toBe('https://walnut.example.org')
    expect(walnutCandidates({ tabUrl: 'https://walnut.example.org/connect-extension', last: 'https://walnut.example.org' })[0]).toBe('https://walnut.example.org')
  })

  it('offers the first candidate in order that answers, not the fastest', async () => {
    state.local.lastServer = 'http://localhost:4100'
    state.folder = { folder: 'abc', serverUrl: 'http://localhost:4200' }
    const asked: string[] = []
    const at = await findWalnut(async (o) => { asked.push(o); return o !== 'http://localhost:4200' })
    expect(asked).toEqual(['http://localhost:4200', 'http://localhost:4100', 'http://localhost:3456', 'http://127.0.0.1:3456'])
    expect(at).toBe('http://localhost:4100')
  })

  it('none answering is null, so the popup asks for the address', async () => {
    expect(await findWalnut(async () => false)).toBeNull()
  })

  it('remembers the address the person connected to, as an origin', async () => {
    rememberServer('walnut.example.org:8443/passwords')
    await new Promise((r) => setTimeout(r, 0))
    expect(state.local.lastServer).toBe('http://walnut.example.org:8443')
  })
})

const base: Omit<VaultItem, 'type' | 'title'> = { id: 'it1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }

describe('an item\'s detail view', () => {
  it('a login: its username, its password and code only named, each site, its notes and fields; no secret carried', () => {
    const item: VaultItem = { ...base, type: 'login', title: 'Shop', username: 'lena@example.test', password: 'S3cret_pw', totp: 'JBSWY3DPEHPK3PXP',
      urls: ['https://shop.example.test/login#walnut-match=host'], notes: 'PIN in the drawer', fields: [{ name: 'Member no', value: '42' }, { name: 'PIN', value: '9911', hidden: true }] }
    const d = itemDetail(item)
    expect(d.site).toBe('shop.example.test')
    expect(d.fields.map((f) => f.label)).toEqual(['Username', 'Password', 'One-time code', 'Website', 'Member no', 'PIN', 'Notes'])
    const website = d.fields.find((f) => f.label === 'Website')!
    expect(website.url).toBe('https://shop.example.test/login')
    expect(d.fields.find((f) => f.label === 'Password')).toMatchObject({ secret: 'password', value: '••••••••' })
    expect(d.fields.find((f) => f.label === 'PIN')).toMatchObject({ secret: 'field:1' })
    const text = JSON.stringify(d)
    for (const secret of ['S3cret_pw', 'JBSWY3DPEHPK3PXP', '9911']) expect(text).not.toContain(secret)
    expect(secretField(item, 'field:1')).toBe('9911')
    expect(secretField(item, 'password')).toBe('S3cret_pw')
    expect(secretField(item, 'field:7')).toBeUndefined()
  })

  it('only a web address opens: another scheme is shown, never given as a link', () => {
    const d = itemDetail({ ...base, type: 'login', title: 'Odd', urls: ['javascript:alert(1)', 'file:///etc/passwd', 'https://ok.example.test/a#walnut-match=host', 'myapp://open'] })
    const sites = d.fields.filter((f) => f.label === 'Website')
    expect(sites).toHaveLength(4)
    expect(sites.map((f) => f.url)).toEqual([undefined, undefined, 'https://ok.example.test/a', undefined])
    expect(webUrl('JavaScript:alert(1)')).toBeUndefined()
    expect(webUrl('data:text/html,hi')).toBeUndefined()
    expect(webUrl('http://x.test/p?q=1#frag')).toBe('http://x.test/p?q=1')
  })

  it('a card: holder, its last four, expiry as MM/YY, the number and code only named', () => {
    const d = itemDetail({ ...base, type: 'card', title: 'Visa', card: { holder: 'Lena Look', number: '4111 1111 1111 1234', expMonth: '7', expYear: '2030', code: '321' } })
    expect(d.fields.map((f) => [f.label, f.value])).toEqual([['Cardholder', 'Lena Look'], ['Number', '•••• 1234'], ['Expires', '07/30'], ['Security code', '•••']])
    expect(JSON.stringify(d)).not.toContain('321')
    expect(JSON.stringify(d)).not.toContain('4111')
  })

  it('an identity: its parts by name, its address on one line, and no field twice', () => {
    const d = itemDetail({ ...base, type: 'identity', title: 'Home', fields: [{ name: 'First name', value: 'Lena' }, { name: 'Last name', value: 'Look' }, { name: 'Email', value: 'lena@example.test' }, { name: 'Address 1', value: '1 Main St' }, { name: 'City', value: 'Springfield' }, { name: 'Loyalty', value: 'Gold' }] })
    expect(d.fields.map((f) => [f.label, f.value])).toEqual([['Name', 'Lena Look'], ['Email', 'lena@example.test'], ['Address', '1 Main St'], ['City', 'Springfield'], ['Loyalty', 'Gold']])
  })
})
