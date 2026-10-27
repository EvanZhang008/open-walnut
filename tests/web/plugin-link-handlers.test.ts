import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `walnut.ui.link`: a plugin names the links it opens with browser-extension match
// patterns; a click on one opens it in the plugin, and whenever the plugin declines or
// fails the link still opens in the default browser. These pin the pattern grammar,
// the match order and every fallback, without a DOM (window.open is stubbed).

vi.mock('@/utils/log', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  compileLinkPattern,
  findLinkHandler,
  linkPatternMatches,
  listLinkHandlers,
  openExternalLink,
  parseCapturableUrl,
  registerLinkHandler,
  removeLinkHandlersOf,
  setLinkNavigate,
  type LinkHandlerContribution,
} from '../../web/src/plugins/link-handlers.js'

const PERMALINK = 'https://acme.chat.example.com/archives/C0123ABCDEF/p1700000000123456'

function matches(pattern: string, href: string): boolean {
  const compiled = compileLinkPattern(pattern)
  if (compiled instanceof Error) throw compiled
  return linkPatternMatches(compiled, new URL(href))
}

let opened: string[]
const disposers: Array<{ dispose(): unknown }> = []

function handler(over: Partial<LinkHandlerContribution> = {}): LinkHandlerContribution {
  return { id: 'chat', patterns: ['https://*.chat.example.com/archives/*'], open: () => true, ...over }
}

function register(pluginId: string, contribution: LinkHandlerContribution, name = 'Chat') {
  const d = registerLinkHandler(pluginId, name, contribution)
  disposers.push(d)
  return d
}

beforeEach(() => {
  opened = []
  vi.stubGlobal('window', {
    open: vi.fn((href: string) => { opened.push(href); return null }),
    location: { assign: vi.fn(), pathname: '/', origin: 'http://127.0.0.1:3456' },
  })
})

afterEach(async () => {
  for (const d of disposers.splice(0)) await d.dispose()
  setLinkNavigate(null)
  vi.unstubAllGlobals()
})

describe('link patterns', () => {
  it('match by scheme, host wildcard and path glob, with the query and never the fragment', () => {
    expect(matches('https://*.chat.example.com/archives/*', PERMALINK)).toBe(true)
    expect(matches('https://*.chat.example.com/archives/*', `${PERMALINK}?thread_ts=1700000000.000100&cid=C0123ABCDEF`)).toBe(true)
    // `*.host` takes the bare host too.
    expect(matches('https://*.chat.example.com/archives/*', 'https://chat.example.com/archives/C1/p2')).toBe(true)
    expect(matches('https://*.chat.example.com/archives/*', 'https://evilchat.example.com/archives/C1/p2')).toBe(false)
    expect(matches('https://*.chat.example.com/archives/*', 'https://chat.example.com.evil.test/archives/C1/p2')).toBe(false)
    expect(matches('https://*.chat.example.com/archives/*', 'https://acme.chat.example.com/messages/C1')).toBe(false)
    expect(matches('https://chat.example.com/a/*', 'http://chat.example.com/a/b')).toBe(false)
    expect(matches('*://chat.example.com/a/*', 'http://chat.example.com/a/b')).toBe(true)
    expect(matches('*://*/*', 'https://anything.test/')).toBe(true)
    // Hosts compare case-insensitively, the port is ignored, paths are exact.
    expect(matches('https://Chat.Example.com/a/*', 'https://CHAT.example.com:8443/a/b')).toBe(true)
    expect(matches('https://chat.example.com/A/*', 'https://chat.example.com/a/b')).toBe(false)
    // The fragment is not part of the match, and regex characters in a path are literal.
    expect(matches('https://chat.example.com/a', 'https://chat.example.com/a#frag')).toBe(true)
    expect(matches('https://chat.example.com/a.b', 'https://chat.example.com/aXb')).toBe(false)
    expect(matches('https://chat.example.com/a?x=*', 'https://chat.example.com/a?x=1')).toBe(true)
  })

  it('refuse a pattern that does not parse, naming it', () => {
    for (const bad of ['', 'chat.example.com/*', 'ftp://x.test/*', 'javascript://x/*', 'https://*x.test/*', 'https://x.test', 'https://a b/*', 'https://*.*/x', 'x'.repeat(600)]) {
      expect(compileLinkPattern(bad), bad).toBeInstanceOf(Error)
    }
  })

  it('take only absolute http(s) links', () => {
    expect(parseCapturableUrl(PERMALINK)?.href).toBe(PERMALINK)
    expect(parseCapturableUrl('/tasks/abc')).toBeNull()
    expect(parseCapturableUrl('mailto:a@b.test')).toBeNull()
    expect(parseCapturableUrl('javascript:alert(1)')).toBeNull()
    expect(parseCapturableUrl('https://')).toBeNull()
    expect(parseCapturableUrl(undefined)).toBeNull()
  })
})

describe('the handler registry', () => {
  it('finds the first registered handler whose pattern and accepts take the link', () => {
    register('first', handler({ accepts: (url) => url.hostname.startsWith('signed.') }), 'First')
    register('second', handler(), 'Second')
    expect(findLinkHandler(PERMALINK)?.handler.pluginId).toBe('second')
    expect(findLinkHandler('https://signed.chat.example.com/archives/C1/p2')?.handler.pluginId).toBe('first')
    expect(findLinkHandler('https://elsewhere.test/archives/C1/p2')).toBeNull()
  })

  it('never takes the console\'s own pages, whatever the pattern says', () => {
    register('greedy', handler({ patterns: ['*://*/*'] }))
    expect(findLinkHandler('http://127.0.0.1:3456/tasks/abc')).toBeNull()
    expect(findLinkHandler('http://127.0.0.1:3456/api/files/raw?path=a.html')).toBeNull()
    // Another port on the same host is another site.
    expect(findLinkHandler('http://127.0.0.1:5173/')?.handler.pluginId).toBe('greedy')
  })

  it('an accepts that throws leaves the link to the next handler or the browser', () => {
    register('broken', handler({ accepts: () => { throw new Error('boom') } }))
    expect(findLinkHandler(PERMALINK)).toBeNull()
  })

  it('titles the menu row with the given title, else the plugin name', () => {
    register('named', handler({ title: '  Team chat ' }), 'Chat plugin')
    expect(findLinkHandler(PERMALINK)?.handler.title).toBe('Team chat')
    removeLinkHandlersOf('named')
    register('unnamed', handler(), 'Chat plugin')
    expect(findLinkHandler(PERMALINK)?.handler.title).toBe('Chat plugin')
  })

  it('refuses a handler with no pattern, a bad pattern, too many patterns or no open', () => {
    expect(() => registerLinkHandler('p', 'P', handler({ patterns: [] }))).toThrow(/at least one pattern/)
    expect(() => registerLinkHandler('p', 'P', handler({ patterns: ['nope'] }))).toThrow(/https:\/\/host\/path/)
    expect(() => registerLinkHandler('p', 'P', handler({ patterns: Array(33).fill('https://x.test/*') }))).toThrow(/at most 32/)
    expect(() => registerLinkHandler('p', 'P', { id: 'x', patterns: ['https://x.test/*'] } as unknown as LinkHandlerContribution)).toThrow(/open function/)
    expect(listLinkHandlers()).toHaveLength(0)
  })

  it('a reloaded generation takes the old one\'s place, and the old disposer then removes nothing', async () => {
    const old = register('chat', handler({ title: 'Old' }))
    register('other', handler(), 'Other')
    register('chat', handler({ title: 'New' }))
    expect(listLinkHandlers().map((h) => h.title)).toEqual(['New', 'Other'])
    await old.dispose()
    expect(listLinkHandlers().map((h) => h.title)).toEqual(['New', 'Other'])
  })

  it('dispose and an owner sweep both take handlers away', async () => {
    const d = register('chat', handler())
    await d.dispose()
    expect(findLinkHandler(PERMALINK)).toBeNull()
    register('chat', handler({ id: 'a' }))
    register('chat', handler({ id: 'b' }))
    removeLinkHandlersOf('chat')
    expect(listLinkHandlers()).toHaveLength(0)
  })
})

describe('opening a link', () => {
  it('a handled link goes to the plugin with the console navigate, never to the browser', () => {
    const navigate = vi.fn()
    setLinkNavigate(navigate)
    const open = vi.fn((url: URL, ctx: { navigate(path: string): void; via: string }) => {
      ctx.navigate(`/apps/chat~main?link=${encodeURIComponent(url.href)}`)
      return true
    })
    register('chat', handler({ open }))
    openExternalLink(PERMALINK)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]![1].via).toBe('click')
    expect(navigate).toHaveBeenCalledWith(`/apps/chat~main?link=${encodeURIComponent(PERMALINK)}`)
    expect(opened).toEqual([])
  })

  it('an unhandled link, a declined one and a throwing one open in the default browser', () => {
    openExternalLink('https://elsewhere.test/page')
    register('declines', handler({ open: () => false }))
    openExternalLink(PERMALINK)
    removeLinkHandlersOf('declines')
    register('throws', handler({ open: () => { throw new Error('boom') } }))
    openExternalLink(PERMALINK)
    expect(opened).toEqual(['https://elsewhere.test/page', PERMALINK, PERMALINK])
  })

  it('an asynchronous false or rejection falls back once; an asynchronous true does not', async () => {
    register('async', handler({ open: async (url) => url.pathname.endsWith('p1') ? true : false }))
    openExternalLink('https://acme.chat.example.com/archives/C1/p1')
    openExternalLink('https://acme.chat.example.com/archives/C1/p2')
    removeLinkHandlersOf('async')
    register('rejects', handler({ open: () => Promise.reject(new Error('gone')) }))
    openExternalLink('https://acme.chat.example.com/archives/C1/p3')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opened).toEqual([
      'https://acme.chat.example.com/archives/C1/p2',
      'https://acme.chat.example.com/archives/C1/p3',
    ])
  })

  it('the plugin gets its own copy of the URL, so a change it makes cannot reach the next handler', () => {
    register('mutates', handler({ open: (url) => { url.hostname = 'mutated.test'; return true } }))
    openExternalLink(PERMALINK)
    expect(findLinkHandler(PERMALINK)?.url.href).toBe(PERMALINK)
  })
})
