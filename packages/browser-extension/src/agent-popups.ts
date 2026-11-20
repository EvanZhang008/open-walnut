/**
 * A window an agent's page opens stays out of the person's way (2026-11-19, the user's Chrome: an
 * agent clicked "Sign in with GitHub" on a site through `evaluate`; the site's window.open made a
 * popup window, Chrome put it in front of him and gave it the focus, and Walnut listed it as his,
 * so the agent could not close it).
 *
 * Chrome shows and activates the opener's window for EVERY new window or tab a page's window.open
 * makes (chrome/browser/ui/browser_web_contents_delegate: AddNewContents passes kShowWindow, then
 * browser_navigator's ScopedBrowserShower calls Show(); only Chrome's own background actor is let
 * off). A tab instead of a popup window (`popup=0`, the first fix) still brought the agent window
 * in front of him (2026-11-20, the same sign-in: the session file shows active_window on the agent
 * window at that second). So no page of an agent's opens a window itself:
 *
 *   - Before each step in an agent's own tab of the agent window, the page's window.open is
 *     replaced (MAIN world, a Proxy so it still reads as native): it asks the extension, through a
 *     relay in the extension's own world, to open the address as a background tab of the agent
 *     window (agent-opened.ts: chrome.tabs.create with active false never shows a window), the
 *     agent's like any it opened, and hands the page a stand-in for the new window: `closed`
 *     turns true when that tab closes, `location` is its address while it is on the page's own
 *     site (another site's throws, as a real window's does), `close()` closes it, and a later open
 *     with the same name or a `location` set loads the same tab. What a stand-in cannot do: be the
 *     new page's `window.opener` (a sign-in that reports back through it finishes in the tab, its
 *     cookies set; the agent reloads the page that opened it).
 *   - Only while an agent's step runs there, and ACTING_MS after (`live`): outside it (the person
 *     took the tab over, it was given back) and without user activation the page's own open runs,
 *     as before. `_self`, `_top`, `_parent` and a frame's own name stay the page's too.
 *   - The ways to the browser's open that are wrapped: each patched window's open, the window of a
 *     same-site frame reached through contentWindow or contentDocument (a clean copy taken from a
 *     new frame), and document.open with three arguments. Not reached, and still the browser's own
 *     (it then shows the agent window): a frame that loads after the step's patch and opens by
 *     itself, `frames[i].open`, a form or a trusted click on a link with `target=_blank` whose new
 *     page keeps its opener.
 *   - A popup window that still comes that way and is an agent's own (agent-opened.ts
 *     adoptOpened) is minimized at once.
 */
import { more } from './agent-api'
import { ext } from './ext'

/**
 * Runs in the page's world: self-contained, no closures. A Proxy over the page's own open, so the
 * page still sees a native function (a site's bot check compares window.open's source).
 */
function inPage(until: number): boolean {
  const mark = Symbol.for('walnut.popups-as-tabs')
  const count = Symbol.for('walnut.popups-opened')
  const live = Symbol.for('walnut.popups-live')
  const top = window as unknown as Window & Record<symbol, unknown>
  // Until when an agent's step runs here (and just after): the page's own open again after that.
  if (top[mark]) { top[live] = until; return true }
  Object.defineProperty(top, count, { value: 0, writable: true })
  Object.defineProperty(top, live, { value: until, writable: true })
  const doc = document
  type Kid = { closed: boolean; href: string; cross: boolean; name: string; stub?: unknown }
  const kids = new Map<string, Kid>()
  const byName = new Map<string, string>()
  const send = (op: string, id: string, url?: string) => doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op, id, url }) }))
  doc.addEventListener('walnut-page-open-state', (e) => {
    let st: { id?: string; url?: string; cross?: boolean; closed?: boolean } = {}
    try { st = JSON.parse(String((e as CustomEvent).detail)) } catch { return }
    const k = typeof st.id === 'string' ? kids.get(st.id) : undefined
    if (!k) return
    if (typeof st.url === 'string' && st.url) { k.href = st.url; k.cross = false }
    if (st.cross) k.cross = true
    if (st.closed) k.closed = true
  })
  const abs = (v: unknown): string | undefined => {
    if (v === undefined || v === null || String(v) === '') return ''
    try { return new URL(String(v), location.href).href } catch { return undefined }
  }
  const sameSite = (h: string) => { try { return new URL(h).origin === location.origin } catch { return false } }
  const stub = (id: string, k: Kid) => {
    const go = (v: unknown) => { const h = abs(v); if (h && !k.closed) { k.href = h; k.cross = !sameSite(h); send('nav', id, h) } }
    // Another site's address is the browser's secret, as with a real window.
    const at = (): URL => {
      if (k.cross) throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError')
      try { return new URL(k.href) } catch { return new URL('about:blank') }
    }
    const loc: Record<string, unknown> = { assign: go, replace: go, reload: () => undefined, toString: () => at().href }
    for (const f of ['origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'] as const) Object.defineProperty(loc, f, { get: () => at()[f], enumerable: true })
    Object.defineProperty(loc, 'href', { get: () => at().href, set: go, enumerable: true })
    // A page that writes into its new window before it has an address (a "Loading" line): written nowhere.
    const page: Record<string, unknown> = { write() {}, writeln() {}, close() {}, title: '', readyState: 'complete' }
    page.open = () => page
    const s: Record<string, unknown> = {
      get closed() { return k.closed },
      close() { if (!k.closed) { k.closed = true; send('close', id) } },
      focus() {}, blur() {}, postMessage() {},
      get location() { return loc },
      set location(v: unknown) { go(v) },
      get document() { if (k.cross) throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError'); return page },
      get name() { return k.name },
      opener: top, length: 0,
    }
    s.self = s; s.window = s; s.frames = s; s.top = s; s.parent = s
    return s
  }
  const ask = (target: (...a: unknown[]) => unknown, self: Window, args: unknown[]) => {
    const [url, name, features] = args
    const n = name === undefined || name === null ? '' : String(name)
    // The page's own open: a name that opens no window (this page, its parent, a frame of its own),
    // no agent's step now (the person took the tab over, it was given back: theirs as before), or
    // no user activation (the browser blocks that one itself, and shows nothing).
    const act = (navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation
    if (/^_(self|top|parent)$/i.test(n) || (n && [...doc.getElementsByName(n)].some((el) => /^I?FRAME$/.test(el.tagName))) || Date.now() > Number(top[live] ?? 0) || (act && !act.isActive)) return Reflect.apply(target, self, args)
    ;(top as unknown as Record<symbol, number>)[count]++
    const href = abs(url)
    if (href === undefined) return null
    const blank = !n || /^_blank$/i.test(n)
    const again = blank ? undefined : byName.get(n)
    const old = again !== undefined ? kids.get(again) : undefined
    if (again !== undefined && old && !old.closed) { if (href) { old.href = href; old.cross = !sameSite(href); send('nav', again, href) } return old.stub }
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    const k: Kid = { closed: false, href: href || 'about:blank', cross: !!href && !sameSite(href), name: blank ? '' : n }
    k.stub = stub(id, k)
    kids.set(id, k)
    if (!blank) byName.set(n, id)
    send('open', id, href)
    // noopener (or noreferrer): the page gets no window back, as the browser gives none.
    return /(^|[,\s])(noopener|noreferrer)([,\s=]|$)/i.test(String(features ?? '')) ? null : k.stub
  }
  // Every way to the browser's own open in this page and the same-site frames it reaches: each
  // window's open, the window of a frame made later (a clean copy taken from it: contentWindow,
  // contentDocument), and document.open with three arguments.
  const patch = (w: Window & Record<symbol, unknown>) => {
    if (w[mark] && w !== top) return
    w.open = new Proxy(w.open, { apply: (target, _self, args: unknown[]) => ask(target as (...a: unknown[]) => unknown, w, args) })
    if (w !== top) Object.defineProperty(w, mark, { value: true })
    const g = w as unknown as { HTMLIFrameElement?: { prototype: object }; Document?: { prototype: Document } }
    for (const prop of ['contentWindow', 'contentDocument'] as const) {
      const d = g.HTMLIFrameElement ? Object.getOwnPropertyDescriptor(g.HTMLIFrameElement.prototype, prop) : undefined
      if (!d?.get) continue
      Object.defineProperty(g.HTMLIFrameElement!.prototype, prop, { ...d, get: new Proxy(d.get, { apply: (t, self, a) => { const r = Reflect.apply(t, self, a) as Window | Document | null; into(r && 'defaultView' in r ? r.defaultView : r as Window | null); return r } }) })
    }
    if (g.Document) {
      g.Document.prototype.open = new Proxy(g.Document.prototype.open, {
        apply: (t, self: Document, args: unknown[]) => args.length >= 3 && self.defaultView ? (self.defaultView as Window).open(...(args as [string, string, string])) : Reflect.apply(t, self, args),
      })
    }
  }
  // A frame this page can reach (its document readable: the same site, a new blank frame included).
  const into = (w: Window | null) => { try { if (w && w !== top && w.document) patch(w as Window & Record<symbol, unknown>) } catch { /* another site's frame: its own page */ } }
  patch(top)
  Object.defineProperty(top, mark, { value: true })
  return true
}

/**
 * Runs in the extension's own world of the page: carries the page's asks (above) to the
 * background (agent-opened.ts pageOpen), and what became of each new tab back to the page.
 */
function inBridge(): boolean {
  const g = globalThis as unknown as Record<string, unknown>
  if (g.__walnutPageOpen) return true
  g.__walnutPageOpen = true
  const rt = (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown>; onMessage: { addListener(f: (m: unknown) => void): void } } } }).chrome.runtime
  const tell = (st: unknown) => document.dispatchEvent(new CustomEvent('walnut-page-open-state', { detail: JSON.stringify(st) }))
  document.addEventListener('walnut-page-open', (e) => {
    let d: { op?: unknown; id?: unknown; url?: unknown } = {}
    try { d = JSON.parse(String((e as CustomEvent).detail)) } catch { return }
    if (typeof d.id !== 'string' || typeof d.op !== 'string') return
    const id = d.id
    // A new window needs the page's user activation, as the browser's own open does (a page cannot fake it).
    const act = (navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation
    if (d.op === 'open' && act && !act.isActive) { tell({ id, closed: true }); return }
    rt.sendMessage({ type: 'agent-page-open', op: d.op, id, url: typeof d.url === 'string' ? d.url : '' }).then((r) => {
      // Refused, or not heard at all (a page the background takes no asks from): closed.
      const a = r as { ok?: boolean; closed?: boolean } | undefined
      if (!a || a.closed || (a.ok === false && !('closed' in a))) tell({ id, closed: true })
    }, () => tell({ id, closed: true }))
  })
  rt.onMessage.addListener((m) => {
    const x = m as { type?: string; id?: string; url?: string; cross?: boolean; closed?: boolean }
    if (x?.type === 'agent-page-open-state' && typeof x.id === 'string') tell({ id: x.id, url: x.url, cross: x.cross, closed: x.closed })
  })
  return true
}

/** How long the page gets: a page held by a dialog or a busy script never holds the step. */
const PATCH_MS = 1500

/** The tab's pages (every frame) ask the extension for their new windows from now until they load again. True when the top page took it. */
export async function popupsAsTabs(tabId: number, until: number): Promise<boolean> {
  const s = more.scripting
  if (!s) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const both = async () => {
      // The relay first: a page's window.open never asks before it can be heard.
      const relay = await s.executeScript({ target: { tabId, allFrames: true }, func: inBridge }).then((rs) => rs.some((r) => r.frameId === 0 && r.result === true), () => false)
      if (!relay) return false
      return s.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: inPage, args: [until] as [number] }).then((rs) => rs.some((r) => r.frameId === 0 && r.result === true), () => false)
    }
    return await Promise.race([
      both(),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PATCH_MS) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** How many times the tab's top page called window.open since it took the patch (undefined: no patch there). */
export async function openCalls(tabId: number): Promise<number | undefined> {
  const s = more.scripting
  if (!s) return undefined
  // Every frame's (a frame the step reached counts its own).
  const rs = await s.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: () => (window as unknown as Record<symbol, unknown>)[Symbol.for('walnut.popups-opened')] }).catch(() => [])
  const ns = rs.map((r) => r.result).filter((n): n is number => typeof n === 'number')
  return ns.length ? ns.reduce((a, b) => a + b, 0) : undefined
}

/**
 * Until when the tab's pages ask the extension for their windows (0: from now on their own open
 * again: the person took the tab over, it was given back). Pages not patched are left alone.
 */
export async function popupsLive(tabId: number, until: number): Promise<void> {
  await more.scripting?.executeScript({
    target: { tabId, allFrames: true }, world: 'MAIN', args: [until] as [number],
    func: (u: number) => { const w = window as unknown as Record<symbol, unknown>; if (w[Symbol.for('walnut.popups-as-tabs')]) w[Symbol.for('walnut.popups-live')] = u },
  }).catch(() => undefined)
}

/** Whether the tab sits in a popup window (its own window.open must stay a popup: a tab would go to the person's window). */
export async function inPopupWindow(tabId: number): Promise<boolean> {
  const t = await ext.tabs.get(tabId).catch(() => null)
  if (!t || t.windowId === undefined) return false
  const w = await ext.windows.get(t.windowId).catch(() => null)
  return w?.type === 'popup'
}

/** An agent's own tab that came in a popup window: the window is minimized, never shown again by Walnut. True when it was. */
export async function minimizeAgentPopup(tabId: number): Promise<boolean> {
  const t = await ext.tabs.get(tabId).catch(() => null)
  if (!t || t.windowId === undefined || !(await inPopupWindow(tabId))) return false
  return !!(await ext.windows.update?.(t.windowId, { state: 'minimized' }).catch(() => null))
}

export const _inPageForTesting = inPage
export const _inBridgeForTesting = inBridge
