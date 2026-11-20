/**
 * A window an agent's page opens (packages/browser-extension/src/agent-popups.ts, agent-page.ts
 * watchOpened). 2026-11-19, the user's Chrome: an agent's `evaluate` clicked a site's "Sign in with
 * GitHub"; the popup window came in front of him, listed as his, and the agent could not close it.
 * Guards:
 *   - the page's window.open never opens a window itself (Chrome would show the agent window for
 *     it): it asks the extension and gets a stand-in, except for names that open no window;
 *   - every command reaches the page only after beforeStep (acting, and the patch), so no step kind
 *     (evaluate, a dialog's answer, a new one) opens a window Walnut does not attribute;
 *   - the browser's new tabs reach the extension through one listener (watchOpened), which adopts
 *     an agent tab's popup and minimizes a popup window it came in; a second listener fails here.
 * The browser side (a click, an evaluate, a page's own early copy of window.open) is the Chromium
 * spec tests/e2e/browser/extension-agent-outward.spec.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { _inBridgeForTesting, _inPageForTesting } from '../../../packages/browser-extension/src/agent-popups'

const DIR = path.resolve(__dirname, '../../../packages/browser-extension/src')
const src = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')

/** A page's world: its window (with the browser's own open) and document, the asks it sends out. */
function fakePage(frames: string[] = []) {
  const native: unknown[][] = []
  const asks: Array<{ op: string; id: string; url?: string }> = []
  const doc = new EventTarget() as EventTarget & { getElementsByName(n: string): Array<{ tagName: string }> }
  doc.getElementsByName = (n: string) => frames.includes(n) ? [{ tagName: 'IFRAME' }] : []
  doc.addEventListener('walnut-page-open', (e) => asks.push(JSON.parse(String((e as CustomEvent).detail))))
  const w = { open: (...a: unknown[]) => { native.push(a); return 'native' } } as Record<string | symbol, unknown>
  const state = (st: Record<string, unknown>) => doc.dispatchEvent(new CustomEvent('walnut-page-open-state', { detail: JSON.stringify(st) }))
  return { w, doc, native, asks, state }
}

function inPage<T>(p: ReturnType<typeof fakePage>, run: () => T): T {
  const g = globalThis as Record<string, unknown>
  const had = { window: g.window, document: g.document, location: g.location }
  g.window = p.w; g.document = p.doc
  Object.defineProperty(g, 'location', { value: { href: 'https://site.example.test/login', origin: 'https://site.example.test' }, configurable: true, writable: true })
  try { return run() } finally {
    g.window = had.window; g.document = had.document
    Object.defineProperty(g, 'location', { value: had.location, configurable: true, writable: true })
  }
}

describe('the page\'s window.open asks the extension, and never opens a window itself', () => {
  it('any open becomes an ask with its full address; the page gets a stand-in, never the browser\'s window', () => {
    const p = fakePage()
    inPage(p, () => {
      expect(_inPageForTesting(Date.now() + 60_000)).toBe(true)
      const open = p.w.open as (...a: unknown[]) => Record<string, unknown> | null
      const a = open('/oauth?x=1', 'signin', 'width=500,height=600')!
      const b = open(new URL('https://login.example.test/u'))!
      const c = open('https://login.example.test/n', '_blank', 'noopener,width=400')
      expect(p.native).toEqual([])
      expect(p.asks.map((x) => [x.op, x.url])).toEqual([
        ['open', 'https://site.example.test/oauth?x=1'],
        ['open', 'https://login.example.test/u'],
        ['open', 'https://login.example.test/n'],
      ])
      // noopener: no window back, as the browser gives none.
      expect(c).toBeNull()
      expect(a.closed).toBe(false)
      expect((a.location as { pathname: string }).pathname).toBe('/oauth')
      expect(b === a).toBe(false)
      // What became of the tab: its address on the page's own site, then its close.
      p.state({ id: p.asks[0]!.id, url: 'https://site.example.test/oauth/done' })
      expect((a.location as { pathname: string }).pathname).toBe('/oauth/done')
      p.state({ id: p.asks[0]!.id, closed: true })
      expect(a.closed).toBe(true)
      // Another site's address is the browser's secret, as with a real window; its own site's is not.
      expect(() => (b.location as { href: string }).href).toThrow(/cross-origin/)
      expect(() => b.document).toThrow(/cross-origin/)
      p.state({ id: p.asks[1]!.id, url: 'https://site.example.test/cb?code=1' })
      expect((b.location as { search: string }).search).toBe('?code=1')
      p.state({ id: p.asks[1]!.id, cross: true })
      expect(() => (b.location as { search: string }).search).toThrow(/cross-origin/)
      // The page closes its window: one ask, and nothing more once closed.
      b.close(); b.close()
      b.location = '/after'
      expect(p.asks.filter((x) => x.op === 'close')).toEqual([{ op: 'close', id: p.asks[1]!.id }])
      expect(b.closed).toBe(true)
    })
  })

  it('the same name loads the same window; a blank one gets its address later; names that open no window stay the page\'s', () => {
    const p = fakePage(['inner'])
    inPage(p, () => {
      _inPageForTesting(Date.now() + 60_000)
      const open = p.w.open as (...a: unknown[]) => Record<string, unknown> | null
      const one = open('', 'helper')!
      expect(p.asks).toEqual([{ op: 'open', id: p.asks[0]!.id, url: '' }])
      // A blank window written into, then given its address (the common "Loading" pattern).
      ;(one.document as { write(s: string): void }).write('Loading')
      ;(one.location as { href: string }).href = '/help'
      const two = open('/help?2', 'helper')
      expect(two).toBe(one)
      ;(one.location as { replace(u: string): void }).replace('/help?3')
      expect(p.asks.slice(1).map((x) => [x.op, x.url])).toEqual([['nav', 'https://site.example.test/help'], ['nav', 'https://site.example.test/help?2'], ['nav', 'https://site.example.test/help?3']])
      expect(open('/x', '_blank', 'noreferrer')).toBeNull()
      for (const n of ['_self', '_top', '_parent', 'inner']) expect(open('/x', n)).toBe('native')
      expect(p.native.map((a) => a[1])).toEqual(['_self', '_top', '_parent', 'inner'])
      // A second step does not wrap it again.
      const once = p.w.open
      expect(_inPageForTesting(Date.now() + 60_000)).toBe(true)
      expect(p.w.open).toBe(once)
      expect(typeof p.w.open).toBe('function')
      // No agent's step now (the person took the tab over, it was given back): the page's own open.
      expect(_inPageForTesting(0)).toBe(true)
      p.native.length = 0
      const asked = p.asks.length
      expect(open('/mine', 'their-window', 'width=400')).toBe('native')
      expect(p.native).toEqual([['/mine', 'their-window', 'width=400']])
      expect(p.asks).toHaveLength(asked)
    })
  })

  it('the page\'s own open is reached only for names that open no window (one call site)', () => {
    const body = src('agent-popups.ts')
    expect([...body.matchAll(/Reflect\.apply\(target/g)]).toHaveLength(1)
    expect(body).toMatch(/if \(\/\^_\(self\|top\|parent\)\$\/i\.test\(n\) \|\| .*\) return Reflect\.apply\(target, self, args\)/)
    // Every way to it in the page is wrapped: the window's, a later same-site frame's, document.open with three arguments.
    expect(body).toMatch(/patch\(top\)/)
    expect(body).toMatch(/for \(const prop of \['contentWindow', 'contentDocument'\] as const\)/)
    expect(body).toMatch(/g\.Document\.prototype\.open = new Proxy/)
  })

  it('the relay carries an ask to the background and what became of it back, once per page; a new window needs user activation', async () => {
    const p = fakePage()
    const sent: unknown[] = []
    const listeners: Array<(m: unknown) => void> = []
    const g = globalThis as Record<string, unknown>
    const had = { chrome: g.chrome, document: g.document, flag: g.__walnutPageOpen }
    g.chrome = { runtime: { sendMessage: async (m: unknown) => { sent.push(m); return (m as { id: string }).id === 'k2' ? { ok: false, closed: true } : { ok: true, tab: 9 } }, onMessage: { addListener: (f: (m: unknown) => void) => listeners.push(f) } } }
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const activation = { isActive: true }
    Object.defineProperty(globalThis, 'navigator', { value: { userActivation: activation }, configurable: true })
    g.document = p.doc
    delete g.__walnutPageOpen
    const states: unknown[] = []
    p.doc.addEventListener('walnut-page-open-state', (e) => states.push(JSON.parse(String((e as CustomEvent).detail))))
    try {
      expect(_inBridgeForTesting()).toBe(true)
      expect(_inBridgeForTesting()).toBe(true)
      expect(listeners).toHaveLength(1)
      p.doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op: 'open', id: 'k1', url: 'https://login.example.test/a' }) }))
      await new Promise((r) => setTimeout(r, 0))
      expect(sent).toEqual([{ type: 'agent-page-open', op: 'open', id: 'k1', url: 'https://login.example.test/a' }])
      // An open the background made says nothing back (its address comes as the tab loads).
      expect(states).toEqual([])
      listeners[0]!({ type: 'agent-page-open-state', id: 'k1', cross: true })
      listeners[0]!({ type: 'agent-page-open-state', id: 'k1', closed: true })
      expect(states).toEqual([{ id: 'k1', cross: true }, { id: 'k1', closed: true }])
      // A refused one is closed at once.
      p.doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op: 'open', id: 'k2', url: 'https://x.example.test/' }) }))
      await new Promise((r) => setTimeout(r, 0))
      expect(states.at(-1)).toEqual({ id: 'k2', closed: true })
      // No user activation (a timer, an ad's script): no window, nothing asked.
      activation.isActive = false
      p.doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op: 'open', id: 'k3', url: 'https://x.example.test/' }) }))
      expect(states.at(-1)).toEqual({ id: 'k3', closed: true })
      expect(sent).toHaveLength(2)
    } finally {
      g.chrome = had.chrome; g.document = had.document; g.__walnutPageOpen = had.flag
      if (nav) Object.defineProperty(globalThis, 'navigator', nav)
    }
  })
})

describe('every step goes through beforeStep before it reaches the page', () => {
  it('run calls beforeStep for a command with a tab before act, and nothing else calls act', () => {
    const agent = src('agent.ts')
    const runAt = agent.indexOf('async function run(c: WireCommand)')
    const body = agent.slice(runAt, agent.indexOf('\n}\n', runAt))
    expect(body.indexOf('beforeStep(c.action, c.args.tab, c.allow)')).toBeGreaterThan(0)
    expect(body.indexOf('beforeStep(c.action, c.args.tab, c.allow)')).toBeLessThan(body.indexOf('act(c)'))
    const callers = [...agent.matchAll(/[^\w.]act\(c\)/g)].map((m) => agent.lastIndexOf('async function run', m.index!) === runAt)
    expect(callers.length).toBeGreaterThan(0)
    expect(callers.every(Boolean)).toBe(true)
    // beforeStep: weighed as the opener for the whole step (never `acting`, which names downloads),
    // then the patch only in an agent's own tab of the agent window.
    const step = agent.slice(agent.indexOf('async function beforeStep'), agent.indexOf('async function run('))
    expect(step).toMatch(/opening\.set\(tabId, Date\.now\(\) \+ STEP_MS \+ ACTING_MS\)/)
    expect(step).toMatch(/stepAllow\.set\(tabId, allow\)/)
    expect(step).not.toMatch(/\bacting\b/)
    expect(step).toMatch(/if \(await agentsOwnHere\(tabId\) && await popupsAsTabs\(tabId, Date\.now\(\) \+ STEP_MS \+ ACTING_MS\)\)/)
    // The same test of an agent's own tab of the agent window gates the page's asks (agent-opened.ts pageOpen).
    expect(src('agent-opened.ts')).toMatch(/const here = await agentsOwnHere\(k\.opener\)[\s\S]{0,200}if \(!here \|\| here\.rec\.driving !== undefined \|\| !allow \|\| \(opening\.get\(k\.opener\) \?\? 0\) < Date\.now\(\)\)/)
    // The step's end, a take-over and a release each tell the page when its own open is back.
    expect(agent).toMatch(/opening\.set\(c\.args\.tab, Date\.now\(\) \+ ACTING_MS\); void popupsLive\(c\.args\.tab, Date\.now\(\) \+ ACTING_MS\)/)
    expect(agent).toMatch(/opening\.delete\(tabId\)\n  void popupsLive\(tabId, 0\)/)
    expect(src('agent-takeover.ts')).toMatch(/opening\.delete\(tabId\)\n  await popupsLive\(tabId, 0\)/)
  })

  it('the browser\'s new tabs reach the extension through watchOpened alone, which minimizes an agent\'s popup window', () => {
    const listeners = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts')).flatMap((f) =>
      [...src(f).matchAll(/\btabs\.onCreated\.addListener|\bwindows\.onCreated\.addListener/g)].map(() => f))
    expect(listeners).toEqual(['agent-opened.ts'])
    const page = src('agent-opened.ts')
    const adopt = page.slice(page.indexOf('async function adoptOpened'), page.indexOf('\n}\n', page.indexOf('async function adoptOpened')))
    expect(adopt).toMatch(/if \(!nearPerson\(rec\) && openerId !== undefined && .*agentWindowId\(\)\) await minimizeAgentPopup\(tabId\)/)
  })
})
