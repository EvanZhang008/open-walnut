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
import { WAYS, inBridge as _inBridgeForTesting, inPage as _inPageForTesting } from '../../../packages/browser-extension/src/agent-popups-page'

const DIR = path.resolve(__dirname, '../../../packages/browser-extension/src')
const src = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')

/** A page's world: its window (with the browser's own open) and document, the asks it sends out. */
function fakePage(frames: string[] = [], o: { relay?: boolean } = {}) {
  const native: unknown[][] = []
  const asks: Array<{ op: string; id: string; url?: string }> = []
  const doc = new EventTarget()
  // The extension's relay (inBridge) hears each ask as it is sent, unless there is none (relay false).
  doc.addEventListener('walnut-page-open', (e) => {
    const ask = JSON.parse(String((e as CustomEvent).detail))
    asks.push(ask)
    if (o.relay !== false) doc.dispatchEvent(new CustomEvent('walnut-page-open-state', { detail: JSON.stringify({ id: ask.id, heard: true }) }))
  })
  const w = { open: (...a: unknown[]) => { native.push(a); return 'native' }, addEventListener() {}, document: doc, length: 0, name: '' } as Record<string | symbol, unknown>
  w.parent = w
  // A frame of the page answers to its name (window[name]), as the browser's does.
  frames.forEach((n, i) => { const f: Record<string, unknown> = {}; f.window = f; w[n] = f; w[i] = f })
  w.length = frames.length
  // A global holding a window (opener) is no frame of the page.
  const other: Record<string, unknown> = {}; other.window = other; w.opener = other
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
      // A name a global answers to (opener) is not a frame's: a new window, asked of the extension.
      expect(open('/x', 'opener')).not.toBe('native')
      // No user activation while the tab is an agent's: nothing at all (the browser's own window would show the agent window).
      const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      Object.defineProperty(globalThis, 'navigator', { value: { userActivation: { isActive: false } }, configurable: true })
      try {
        const asked = p.asks.length
        expect(open('/timer', '_blank', 'width=300')).toBeNull()
        expect(p.asks).toHaveLength(asked)
      } finally { if (nav) Object.defineProperty(globalThis, 'navigator', nav) }
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

  it('the page\'s own open is reached only for names that open no window, or as the extension says (one call site)', () => {
    const body = src('agent-popups-page.ts')
    expect([...body.matchAll(/Reflect\.apply\(target as \(\.\.\.a: unknown\[\]\) => unknown, from, /g)]).toHaveLength(1)
    expect(body).toMatch(/if \(passing \|\| !isLive\(\) \|\| \(n && !opensNew\(n, from\)\) \|\| sandboxed\(from, 'allow-popups'\)\) return own\(\)/)
    expect(body).toMatch(/return ask\(args\[0\], args\[1\], args\[2\], \{ replay: own, base \}\)/)
    // Clicks and submits first of all, and from a frame not wrapped yet: the early script hands them to the hook.
    expect(body).toMatch(/Object\.defineProperty\(w, Symbol\.for\('walnut\.page-events'\), \{ value: onEvent/)
    const early = src('page-open-early.ts')
    expect(early).toMatch(/for \(const type of \['click', 'auxclick', 'submit'\]\) w\.addEventListener\(type, \(e\) => \{ hookOf\(EVENTS\)\?\.\(e\) \}, true\)/)
    // Review 2026-11-20: the early script is on every page of the person's: it replaces no function
    // there (a wrapped one reads as changed to a site's bot check from another frame).
    const code = early.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/new Proxy|\.prototype\.|\bw\.\w+ = |window\.\w+ = |defineProperty/)
    // Each page an agent's tab loads takes the patch as it starts.
    expect(src('agent-opened.ts')).toMatch(/if \(change\.status === 'loading'\) void agentsOwnHere\(tabId\)\.then\(\(here\) => here \? popupsAsTabs\(tabId, AGENTS_TAB\)/)
    // Every way a frame enters a document is wrapped (a frame not wrapped would open its own window).
    for (const proto of ['Node', 'Element', 'CharacterData', 'DocumentFragment', 'ShadowRoot', 'Range', 'Document']) expect(body, proto).toMatch(new RegExp(`after\\(g{1,2}\\.${proto}\\?\\.prototype`))
    expect(fs.readFileSync(path.resolve(DIR, '../../../scripts/build-extension.mjs'), 'utf8')).toMatch(/js: \['page-open-early\.js'\], all_frames: true, match_origin_as_fallback: true, run_at: 'document_start', world: 'MAIN'/)
    // Each way a page opens a new tab or window has its part in inPage (and its button in the Chromium spec's /ways page).
    expect([...WAYS]).toEqual(['open', 'link', 'form'])
    for (const way of WAYS) expect(body, way).toContain(`// \`${way}\`:`)
    expect(body).toMatch(/for \(const prop of \['contentWindow', 'contentDocument'\] as const\)/)
    expect(body).toMatch(/g\.Document\.prototype\.open = new Proxy/)
    expect(body).toMatch(/after\(g\.Node\?\.prototype, \['appendChild', 'insertBefore', 'replaceChild'\]\)/)
    expect(body).toMatch(/for \(const type of \['click', 'auxclick', 'submit'\]\) w\.addEventListener\(type, onEvent, true\)/)
    expect(body).toMatch(/es\.attachShadow = new Proxy\(es\.attachShadow, \{ apply: .*root\.addEventListener\('submit', onEvent, true\)/)
    expect(body).toMatch(/proto\.submit = new Proxy/)
  })

  // Review 2026-11-20: a page asking after its tab was let go got a closed stand-in and its click
  // opened nothing. The extension's \`native\` answer runs the page's own way while the activation lasts.
  it('an ask the extension says is not its own runs the page\'s own way, and the stand-in is that window from then on', () => {
    const p = fakePage()
    const real = { closed: false, close() { real.closed = true } }
    p.w.open = (...a: unknown[]) => { p.native.push(a); return real }
    inPage(p, () => {
      _inPageForTesting(Date.now() + 60_000)
      const open = p.w.open as (...a: unknown[]) => Record<string, unknown> | null
      const s = open('/own', 'theirs', 'width=300')!
      expect(p.native).toEqual([])
      p.state({ id: p.asks.at(-1)!.id, native: true })
      expect(p.native).toEqual([['/own', 'theirs', 'width=300']])
      expect(s.closed).toBe(false)
      ;(s.close as () => void)()
      expect(real.closed).toBe(true)
      expect(s.closed).toBe(true)
      // A blank window the page gave its address meanwhile opens at that address; one it closed meanwhile never opens.
      const blank = open('', 'later')!
      ;(blank.location as { href: string }).href = '/given'
      p.state({ id: p.asks.find((x) => x.op === 'open' && x.url === '')!.id, native: true })
      expect(p.native.at(-1)).toEqual(['https://site.example.test/given', 'later'])
      const shut = open('/shut', 'shut')!
      ;(shut.close as () => void)()
      const n = p.native.length
      p.state({ id: p.asks.find((x) => x.op === 'open' && x.url === 'https://site.example.test/shut')!.id, native: true })
      expect(p.native).toHaveLength(n)
      // The page's activation is over by the answer's time: nothing opens, the stand-in is closed.
      const t = open('/late', '_blank')!
      const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      Object.defineProperty(globalThis, 'navigator', { value: { userActivation: { isActive: false } }, configurable: true })
      try {
        const n2 = p.native.length
        p.state({ id: p.asks.at(-1)!.id, native: true })
        expect(p.native).toHaveLength(n2)
        expect(t.closed).toBe(true)
      } finally { if (nav) Object.defineProperty(globalThis, 'navigator', nav) }
    })
  })

  it('an ask no relay hears (the extension reloaded since the patch) is the page\'s own window at once', () => {
    const p = fakePage([], { relay: false })
    const real = { closed: false }
    p.w.open = (...a: unknown[]) => { p.native.push(a); return real }
    inPage(p, () => {
      _inPageForTesting(Date.now() + 60_000)
      const open = p.w.open as (...a: unknown[]) => unknown
      expect(open('/own', 'theirs', 'width=300')).toBe(real)
      expect(p.native).toEqual([['/own', 'theirs', 'width=300']])
      expect(p.asks).toHaveLength(1)
    })
  })

  it('every holding that ends (agentTabs.delete, deleteIf: agent-shared.ts letGo) turns its page\'s windows back to the browser\'s (live 0)', () => {
    const shared = src('agent-shared.ts')
    const at = shared.indexOf('async function letGo(')
    expect(shared.slice(at, shared.indexOf('\n}\n', at))).toMatch(/opening\.delete\(tabId\)\n\s+await popupsLive\(tabId, 0\)/)
    // Every writer of the holdings goes through it (extension-agent-release.test.ts enumerates them).
    expect(shared).toMatch(/delete: async \(tabId: number\) => \{ await rawAgentTabs\.delete\(tabId\); await letGo\(tabId\) \}/)
  })

  it('the relay carries an ask to the background and what became of it back, once per page; a new window needs user activation', async () => {
    const p = fakePage([], { relay: false })
    const sent: unknown[] = []
    const listeners: Array<(m: unknown) => void> = []
    const g = globalThis as Record<string, unknown>
    const had = { chrome: g.chrome, document: g.document, flag: g.__walnutPageOpen }
    let reply: unknown
    g.chrome = { runtime: {
      sendMessage: (m: unknown) => {
        if (reply === 'throw') throw new Error('Extension context invalidated.')
        sent.push(m)
        if (reply === 'reject') return Promise.reject(new Error('Could not establish connection.'))
        return Promise.resolve(reply ?? ((m as { id: string }).id === 'k2' ? { ok: false, closed: true } : { ok: true, tab: 9 }))
      },
      onMessage: { addListener: (f: (m: unknown) => void) => listeners.push(f) },
    } }
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
      // Heard at once; an open the background made says nothing more (its address comes as the tab loads).
      expect(states).toEqual([{ id: 'k1', heard: true }])
      listeners[0]!({ type: 'agent-page-open-state', id: 'k1', cross: true })
      listeners[0]!({ type: 'agent-page-open-state', id: 'k1', closed: true })
      expect(states.slice(1)).toEqual([{ id: 'k1', cross: true }, { id: 'k1', closed: true }])
      // A refused one is closed at once.
      p.doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op: 'open', id: 'k2', url: 'https://x.example.test/' }) }))
      await new Promise((r) => setTimeout(r, 0))
      expect(states.at(-1)).toEqual({ id: 'k2', closed: true })
      // Not the extension's (the background says so, it cannot be reached, the extension reloaded): the page's own way.
      reply = { ok: false, native: true }
      p.doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op: 'open', id: 'k4', url: 'https://x.example.test/' }) }))
      await new Promise((r) => setTimeout(r, 0))
      expect(states.at(-1)).toEqual({ id: 'k4', native: true })
      reply = 'reject'
      p.doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op: 'open', id: 'k5', url: 'https://x.example.test/' }) }))
      await new Promise((r) => setTimeout(r, 0))
      // Lost on the way (the background may have made the tab): closed, never the page's own too.
      expect(states.at(-1)).toEqual({ id: 'k5', closed: true })
      // No user activation (a timer, an ad's script): no window, nothing asked.
      activation.isActive = false
      p.doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op: 'open', id: 'k3', url: 'https://x.example.test/' }) }))
      expect(states.slice(-2)).toEqual([{ id: 'k3', heard: true }, { id: 'k3', closed: true }])
      expect(sent).toHaveLength(4)
      activation.isActive = true
      // A dead relay (the extension reloaded) says nothing, now or later: the page, hearing no one, uses its own way.
      reply = 'throw'
      const told = states.length
      p.doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op: 'open', id: 'k6', url: 'https://x.example.test/' }) }))
      reply = undefined
      p.doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op: 'open', id: 'k7', url: 'https://x.example.test/' }) }))
      await new Promise((r) => setTimeout(r, 0))
      expect(states.slice(told)).toEqual([])
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
    expect(step).toMatch(/if \(await agentsOwnHere\(tabId\) && await popupsAsTabs\(tabId, AGENTS_TAB\)\)/)
    // The same test of an agent's own tab of the agent window gates the page's asks (agent-opened.ts pageOpen).
    expect(src('agent-opened.ts')).toMatch(/const here = await agentsOwnHere\(k\.opener\)[\s\S]{0,400}if \(!here \|\| here\.rec\.driving !== undefined \|\| !allow \|\| \(opening\.get\(k\.opener\) \?\? 0\) < Date\.now\(\)\)/)
    // A take-over and a release (agent-letgo.ts, the test above) each give the page its own open back.
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
