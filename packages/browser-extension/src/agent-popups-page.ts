/**
 * What runs in an agent's page for its new windows (agent-popups.ts injects both before each step,
 * in every frame; agent-opened.ts pageOpen answers them). Each function is self-contained: it is
 * sent to the page as its source, so nothing outside it is reached.
 *
 * Every way a page opens a new tab or window, while an agent's tab is the agent's (`live`, turned
 * off as the agent lets the tab go: agent-leave.ts letGo, or the person takes it over), asks the
 * extension, which opens a background tab of the agent window (a page's own new window or tab
 * would show the agent window: agent-popups.ts). The ways (WAYS, each with a Chromium spec case in
 * tests/e2e/browser/extension-agent-outward.spec.ts):
 *   - `open`: window.open, of this window and of every same-site frame it reaches (a frame added
 *     later or loaded again is wrapped at once: frames[i], a frame's name, contentWindow,
 *     contentDocument all reach a wrapped one), and document.open with three arguments;
 *   - `link`: a link or an image-map area whose click opens a new tab or window (target=_blank, a
 *     name no frame or window of the page has, a <base target>, a modifier key or the middle button);
 *   - `form`: a form sent to a new tab or window (its target, formtarget, a <base target>),
 *     whether by its submit button, requestSubmit or submit(), also from a shadow root made since:
 *     a GET form opens its address, a POST form (or a GET one in another encoding than UTF-8) is
 *     sent again from a page of the same site in the new tab.
 * In Chrome the clicks and submits come first, before the page's own listeners, and a frame not
 * wrapped yet hands them to its parent (page-open-early.ts, the only part on every page: it
 * replaces nothing).
 * A click or form the page cancels itself (preventDefault, returnValue, an on-handler's `return
 * false` anywhere on the event's way) opens nothing, as before. One with no user activation is
 * refused, as the browser's popup blocker would. When the extension answers that it is not the
 * agent's to open (the tab was let go meanwhile, the person's own click long after a step, a
 * sandboxed page), or no relay hears the ask (the extension reloaded since), the page's own way
 * runs after all (`native`): never a click swallowed.
 * Left to the browser (its window shows): a form with a file chosen or over 500 fields, a blob: or
 * data: link, a form in a shadow root made before the patch; method=dialog and a sandboxed frame
 * without allow-popups open nothing anyway.
 */

/** Every way a page opens a new tab or window, each wrapped in inPage (the guard test reads this list). */
export const WAYS = ['open', 'link', 'form'] as const

/**
 * Runs in the page's world. Proxies over the page's own functions, so the page still sees native
 * functions (a site's bot check compares their source).
 */
export function inPage(until: number): boolean {
  const mark = Symbol.for('walnut.popups-as-tabs')
  const count = Symbol.for('walnut.popups-opened')
  const live = Symbol.for('walnut.popups-live')
  const top = window as unknown as Window & Record<symbol, unknown>
  // Until when this tab is an agent's own (a release or a take-over sets 0): the page's own open again after.
  if (top[mark]) { top[live] = until; return true }
  Object.defineProperty(top, count, { value: 0, writable: true })
  Object.defineProperty(top, live, { value: until, writable: true })
  const isLive = () => Date.now() <= Number(top[live] ?? 0)
  const doc = document
  type Kid = { closed: boolean; href: string; cross: boolean; name: string; heard?: boolean; stub?: unknown; real?: Window; replay?: () => void }
  const kids = new Map<string, Kid>()
  const byName = new Map<string, string>()
  // The page's own way running now (`native`): every wrapper lets it through.
  let passing = false
  const native = (f: () => void) => { passing = true; try { f() } finally { passing = false } }
  const send = (op: string, id: string, url?: string, form?: unknown) => doc.dispatchEvent(new CustomEvent('walnut-page-open', { detail: JSON.stringify({ op, id, url, ...(form ? { form } : {}) }) }))
  doc.addEventListener('walnut-page-open-state', (e) => {
    let st: { id?: string; url?: string; cross?: boolean; closed?: boolean; native?: boolean; heard?: boolean } = {}
    try { st = JSON.parse(String((e as CustomEvent).detail)) } catch { return }
    const k = typeof st.id === 'string' ? kids.get(st.id) : undefined
    if (!k) return
    if (st.heard) { k.heard = true; return }
    if (st.native) {
      // Not the extension's to open: the page's own way, while the click's activation lasts.
      const r = k.replay
      k.replay = undefined
      if (r && activated()) r(); else k.closed = true
      return
    }
    if (typeof st.url === 'string' && st.url) { k.href = st.url; k.cross = false }
    if (st.cross) k.cross = true
    if (st.closed) { k.closed = true; k.replay = undefined }
  })
  const abs = (v: unknown, base = location.href): string | undefined => {
    if (v === undefined || v === null || String(v) === '') return ''
    try { return new URL(String(v), base).href } catch { return undefined }
  }
  const sameSite = (h: string) => { try { return new URL(h).origin === location.origin } catch { return false } }
  const activated = () => { const a = (navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation; return !a || a.isActive }
  const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
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
    // Once the page's own window opened after all (`native`), the stand-in is that window's.
    const r = k as { real?: Window & Record<string, unknown> }
    const s: Record<string, unknown> = {
      get closed() { return r.real ? r.real.closed : k.closed },
      close() { if (r.real) r.real.close(); else if (!k.closed) { k.closed = true; send('close', id) } },
      focus() { r.real?.focus() }, blur() { r.real?.blur() },
      postMessage(...a: unknown[]) { (r.real?.postMessage as ((...x: unknown[]) => void) | undefined)?.apply(r.real, a) },
      get location() { return r.real ? r.real.location : loc },
      set location(v: unknown) { if (r.real) r.real.location = v as string; else go(v) },
      get document() { if (r.real) return r.real.document; if (k.cross) throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError'); return page },
      get name() { return k.name },
      opener: top, length: 0,
    }
    s.self = s; s.window = s; s.frames = s; s.top = s; s.parent = s
    return s
  }
  /** Whether a window or frame of this page answers to the name: this one, an ancestor, or a frame of one (another site's too). */
  const known = (from: Window, n: string): boolean => {
    let x: Window = from
    for (let i = 0; i < 32; i++) {
      try { if (x.name === n) return true } catch { /* another site's window: its name is not readable */ }
      // A frame of x by that name (window[name] also reaches a global holding a window, e.g. opener: not a frame).
      try { const c = (x as unknown as Record<string, unknown>)[n]; if (c && c !== x) for (let i = 0; i < x.length; i++) if (x[i] === c) return true } catch { /* not this window's to say */ }
      let up: Window
      try { up = x.parent } catch { return false }
      if (!up || up === x) return false
      x = up
    }
    return false
  }
  /** A target that opens a new tab or window (a page, its parent, the top, a named frame or window open none). */
  const opensNew = (t: string, from: Window) => !!t && !/^_(self|top|parent)$/i.test(t) && (/^_blank$/i.test(t) || !known(from, t))
  /** A new window for the page, asked of the extension: the stand-in, or null (noopener; no user activation). */
  const ask = (url: unknown, name: unknown, features: unknown, o: { form?: unknown; replay?: (url?: string) => unknown; base?: string } = {}) => {
    // No user activation: the browser's popup blocker would refuse it too; nothing opens.
    if (!activated()) return null
    ;(top as unknown as Record<symbol, number>)[count]++
    const n = name === undefined || name === null ? '' : String(name)
    const href = abs(url, o.base)
    if (href === undefined) return null
    const blank = !n || /^_blank$/i.test(n)
    const again = blank ? undefined : byName.get(n)
    const old = again !== undefined ? kids.get(again) : undefined
    if (again !== undefined && old && !old.closed && !old.real && !o.form) { if (href) { old.href = href; old.cross = !sameSite(href); send('nav', again, href) } return old.stub }
    const id = newId()
    const k: Kid = { closed: false, href: href || 'about:blank', cross: !!href && !sameSite(href), name: blank ? '' : n }
    k.stub = stub(id, k)
    const replay = o.replay
    const first = k.href
    // The page's own way with what the page did since (an address it gave the blank window); never one it closed.
    if (replay) k.replay = () => { if (!k.closed) native(() => { const w = replay(k.href !== first ? k.href : undefined); if (w && typeof w === 'object') k.real = w as Window }) }
    kids.set(id, k)
    if (!blank) byName.set(n, id)
    if (o.form) send('form', id, href, o.form)
    else send('open', id, href)
    // No relay heard it (the extension reloaded since the patch, or went): the page's own way, now.
    // A relay hears an ask as it is sent (the event runs its listener at once), or never.
    if (!k.heard) {
      kids.delete(id)
      if (!blank && byName.get(n) === id) byName.delete(n)
      let own: unknown = null
      if (replay) native(() => { own = replay() })
      return own
    }
    // noopener (or noreferrer): the page gets no window back, as the browser gives none.
    return /(^|[,\s])(noopener|noreferrer)([,\s=]|$)/i.test(String(features ?? '')) ? null : k.stub
  }
  /**
   * A click or a form the page may still cancel: the browser's own action is held (it would open a
   * window), and once the event is over, unless the page cancelled it, `then` runs. The page reads
   * the event as it would (defaultPrevented false until it cancels it itself).
   */
  const unlessCancelled = (e: Event, handler: 'onclick' | 'onsubmit', then: () => void) => {
    let cancelled = false
    const pd = e.preventDefault
    const ev = e as unknown as Record<string, unknown>
    ev.preventDefault = function (this: Event) { cancelled = true; return pd.call(this) }
    Object.defineProperty(e, 'defaultPrevented', { get: () => cancelled, configurable: true })
    Object.defineProperty(e, 'returnValue', { get: () => !cancelled, set: (v: unknown) => { if (v === false) cancelled = true }, configurable: true })
    // An on-handler's `return false` cancels without calling preventDefault: each one on the event's way.
    const wrapped: Array<[Record<string, unknown>, unknown, unknown]> = []
    for (const node of e.composedPath() as unknown as Array<Record<string, unknown>>) {
      const own = node?.[handler]
      if (typeof own !== 'function') continue
      const wrap = function (this: unknown, x: Event) { const r = (own as (x: Event) => unknown).call(this, x); if (r === false) cancelled = true; return r }
      node[handler] = wrap
      wrapped.push([node, own, wrap])
    }
    pd.call(e)
    setTimeout(() => {
      // Back as the page left it (a handler it set meanwhile stays).
      for (const [node, own, wrap] of wrapped) if (node[handler] === wrap) node[handler] = own
      if (!cancelled) then()
    }, 0)
  }
  const baseTarget = (d: Document) => d.querySelector('base[target]')?.getAttribute('target') ?? ''
  const attr = (el: Element | null, a: string) => el?.hasAttribute(a) ? el.getAttribute(a) ?? '' : undefined
  const viewOf = (n: Node) => (n.ownerDocument?.defaultView ?? top) as Window
  /** A sandboxed frame without that permission: the browser opens nothing for it, so neither does the extension. */
  const sandboxed = (v: Window, allow: string) => { try { const f = v.frameElement as HTMLIFrameElement | null; return !!f?.hasAttribute('sandbox') && !f.sandbox.contains(allow) } catch { return false } }
  // An empty target is a missing one, as Chrome reads it (its GetEffectiveTarget): the <base target> then.
  const formTarget = (f: HTMLFormElement, s: Element | null) => attr(s, 'formtarget') || attr(f, 'target') || baseTarget(f.ownerDocument)
  const methodOf = (f: HTMLFormElement, s: Element | null) => String(attr(s, 'formmethod') ?? f.getAttribute('method') ?? 'get').toLowerCase()
  /** The form's fields as the browser would send them. */
  const fieldsOf = (f: HTMLFormElement, s: Element | null) => {
    let data: FormData
    try { data = new FormData(f, s as HTMLElement | null ?? undefined) } catch { data = new FormData(f) }
    return [...data.entries()].filter(([, v]) => typeof v === 'string') as Array<[string, string]>
  }
  /** A form the extension can send again as it is: no dialog, no file chosen (only the page holds it), at most 500 fields. */
  const resendable = (f: HTMLFormElement, s: Element | null) => methodOf(f, s) !== 'dialog'
    && ![...f.elements].some((el) => (el as HTMLInputElement).type === 'file' && !!(el as HTMLInputElement).files?.length)
    && fieldsOf(f, s).length <= 500
  /** The browser's own sending of the form, with what its button adds (its name and value, its form* attributes). */
  const submitOwn = (f: HTMLFormElement, s: Element | null) => {
    const was: Array<[string, string | null]> = []
    for (const [from, to] of [['formaction', 'action'], ['formmethod', 'method'], ['formenctype', 'enctype'], ['formtarget', 'target']] as const) {
      const v = attr(s, from)
      if (v !== undefined) { was.push([to, f.getAttribute(to)]); f.setAttribute(to, v) }
    }
    const b = s as HTMLButtonElement | null
    const extra = b?.name ? Object.assign(f.ownerDocument.createElement('input'), { type: 'hidden', name: b.name, value: b.value }) : undefined
    if (extra) f.append(extra)
    try { (viewOf(f) as unknown as { HTMLFormElement: { prototype: HTMLFormElement } }).HTMLFormElement.prototype.submit.call(f) } finally {
      extra?.remove()
      for (const [a, v] of was.reverse()) if (v === null) f.removeAttribute(a); else f.setAttribute(a, v)
    }
  }
  const sendForm = (f: HTMLFormElement, s: Element | null, target: string, replay: () => unknown) => {
    const d = f.ownerDocument
    const action = abs(attr(s, 'formaction') ?? f.getAttribute('action') ?? '', d.baseURI) || d.URL
    const fields = fieldsOf(f, s)
    const name = /^_blank$/i.test(target) ? '_blank' : target
    // Sent in the page's own encoding, as the browser would (a page of the site the tab loads first may have none).
    const charset = (f.getAttribute('accept-charset') ?? '').trim().split(/[\s,]+/)[0] || d.characterSet
    const post = methodOf(f, s) === 'post'
    // A POST, or a GET in another encoding than UTF-8 (only a form encodes its query that way): sent as a form there.
    if (post || !/^utf-?8$/i.test(charset)) ask(action, name, 'noopener', { form: { method: post ? 'post' : 'get', enctype: String(attr(s, 'formenctype') ?? f.getAttribute('enctype') ?? 'application/x-www-form-urlencoded'), fields, charset }, replay })
    else {
      const u = new URL(action)
      u.search = new URLSearchParams(fields).toString()
      ask(u.href, name, 'noopener', { replay })
    }
  }
  /** A link's address (an SVG link's href is an object). */
  const hrefOf = (a: Element) => {
    const h = (a as HTMLAnchorElement).href as unknown
    return typeof h === 'string' ? h : abs((h as { baseVal?: string } | undefined)?.baseVal ?? a.getAttribute('href'), a.ownerDocument.baseURI)
  }
  // `link`: a click that would open a new tab or window.
  const onClick = (e: MouseEvent) => {
    const a = (e.composedPath() as Element[]).find((n) => n && (n.tagName === 'A' || n.tagName === 'AREA' || n.tagName === 'a') && n.hasAttribute?.('href'))
    if (!a || a.hasAttribute('download')) return
    const href = hrefOf(a)
    if (!href || !/^https?:/i.test(href)) return
    const t = attr(a, 'target') || baseTarget(a.ownerDocument)
    const modifier = e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1
    const view = viewOf(a)
    if ((!modifier && !opensNew(t, view)) || sandboxed(view, 'allow-popups')) return
    const name = modifier || /^_blank$/i.test(t) ? '_blank' : t
    const rel = a.getAttribute('rel') ?? ''
    const features = /(^|\s)noreferrer(\s|$)/i.test(rel) ? 'noopener,noreferrer' : !modifier && /(^|\s)opener(\s|$)/i.test(rel) ? '' : 'noopener'
    unlessCancelled(e, 'onclick', () => ask(href, name, 'noopener', { replay: () => view.open(href, name, features) }))
  }
  // `form`: sent to a new tab or window, by its button or requestSubmit (both fire submit), or submit() (below).
  const onSubmit = (e: Event) => {
    const f = e.target as HTMLFormElement
    const s = (e as SubmitEvent).submitter ?? null
    const t = formTarget(f, s)
    if (!opensNew(t, viewOf(f)) || !resendable(f, s) || sandboxed(viewOf(f), 'allow-popups') || sandboxed(viewOf(f), 'allow-forms')) return
    unlessCancelled(e, 'onsubmit', () => sendForm(f, s, t, () => submitOwn(f, s)))
  }
  const handled = new WeakSet<Event>()
  /** Every click and submit of a wrapped window (and, in Chrome, of a frame not yet wrapped: page-open-early.ts). */
  const onEvent = (e: Event) => {
    if (handled.has(e)) return
    handled.add(e)
    if (passing || !isLive() || e.defaultPrevented) return
    if (e.type === 'submit') onSubmit(e)
    else if (e.type === 'click' || (e.type === 'auxclick' && (e as MouseEvent).button === 1)) onClick(e as MouseEvent)
  }
  // Frames this page already looked at (another site's throws each time it is read).
  const tried = new WeakSet<object>()
  const patch = (w: Window & Record<symbol, unknown>) => {
    if (w !== top && w[mark]) return
    if (w !== top) Object.defineProperty(w, mark, { value: true })
    const d = w.document
    // `open`: the window's own (a frame's is wrapped as the frame enters the page), and document.open with three arguments.
    const opening = (target: unknown, args: unknown[], from: Window = w) => {
      const n = args[1] === undefined || args[1] === null ? '' : String(args[1])
      const own = (url?: string) => Reflect.apply(target as (...a: unknown[]) => unknown, from, url === undefined ? args : [url, ...args.slice(1)])
      if (passing || !isLive() || (n && !opensNew(n, from)) || sandboxed(from, 'allow-popups')) return own()
      let base: string | undefined
      try { base = from.document.baseURI } catch { /* the base of this page */ }
      return ask(args[0], args[1], args[2], { replay: own, base })
    }
    Object.defineProperty(w, Symbol.for('walnut.page-events'), { value: onEvent, writable: true, configurable: true })
    w.open = new Proxy(w.open, { apply: (target, _self, args: unknown[]) => opening(target, args, w) })
    const g = w as unknown as { HTMLIFrameElement?: { prototype: object }; Document?: { prototype: Document }; Node?: { prototype: Record<string, unknown> }; Element?: { prototype: Record<string, unknown> }; HTMLFormElement?: { prototype: HTMLFormElement } }
    if (g.Document) {
      g.Document.prototype.open = new Proxy(g.Document.prototype.open, {
        apply: (t, self: Document, args: unknown[]) => args.length >= 3 && self.defaultView ? (self.defaultView as Window).open(...(args as [string, string, string])) : Reflect.apply(t, self, args),
      })
    }
    // Frames: one reached by contentWindow or contentDocument, one added to the page (frames[i], a
    // frame's name), and one that loaded again, wrapped before the page can use it.
    for (const prop of ['contentWindow', 'contentDocument'] as const) {
      const pd = g.HTMLIFrameElement ? Object.getOwnPropertyDescriptor(g.HTMLIFrameElement.prototype, prop) : undefined
      if (!pd?.get) continue
      Object.defineProperty(g.HTMLIFrameElement!.prototype, prop, { ...pd, get: new Proxy(pd.get, { apply: (t, self, a) => { const r = Reflect.apply(t, self, a) as Window | Document | null; into(r && 'defaultView' in r ? r.defaultView : r as Window | null); return r } }) })
    }
    // Only frames not looked at yet: one that loads again is wrapped by the load below.
    const frames = () => { if (isLive()) for (let i = 0; i < w.length; i++) { const f = w[i] as Window; if (f && !tried.has(f)) { tried.add(f); into(f) } } }
    const after = (proto: Record<string, unknown> | undefined, names: string[]) => {
      for (const name of names) {
        // By its descriptor: reading an accessor (innerHTML) off the prototype itself throws.
        const pd = proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined
        const then = <F extends (...a: never[]) => unknown>(f: F) => new Proxy(f, { apply: (t, self, a) => { const r = Reflect.apply(t, self, a); frames(); return r } })
        if (typeof pd?.value === 'function') Object.defineProperty(proto, name, { ...pd, value: then(pd.value) })
        else if (pd?.set) Object.defineProperty(proto, name, { ...pd, set: then(pd.set) })
      }
    }
    // Every way a frame enters a document (a frame is wrapped as it does, before the page can reach it).
    const gg = w as unknown as Record<string, { prototype: Record<string, unknown> } | undefined>
    after(g.Node?.prototype, ['appendChild', 'insertBefore', 'replaceChild'])
    after(g.Element?.prototype, ['append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren', 'moveBefore', 'insertAdjacentElement', 'insertAdjacentHTML', 'innerHTML', 'outerHTML', 'setHTMLUnsafe'])
    after(gg.CharacterData?.prototype, ['before', 'after', 'replaceWith'])
    after(gg.DocumentFragment?.prototype, ['append', 'prepend', 'replaceChildren', 'moveBefore'])
    after(gg.ShadowRoot?.prototype, ['innerHTML', 'setHTMLUnsafe'])
    after(gg.Range?.prototype, ['insertNode', 'surroundContents'])
    after(g.Document?.prototype as unknown as Record<string, unknown>, ['write', 'writeln', 'append', 'prepend', 'replaceChildren', 'moveBefore'])
    d.addEventListener('load', (e) => { const t = e.target as { tagName?: string; contentWindow?: Window | null }; if (t && /^I?FRAME$/.test(String(t.tagName))) into(t.contentWindow ?? null) }, true)
    // `link` and `form`: every click and submit, also a form's in a shadow root (its submit stays there).
    for (const type of ['click', 'auxclick', 'submit']) w.addEventListener(type, onEvent, true)
    const es = g.Element?.prototype as unknown as { attachShadow?: (o: ShadowRootInit) => ShadowRoot } | undefined
    if (es?.attachShadow) es.attachShadow = new Proxy(es.attachShadow, { apply: (t, self, a) => { const root = Reflect.apply(t, self, a) as ShadowRoot; root.addEventListener('submit', onEvent, true); return root } })
    if (g.HTMLFormElement) {
      const proto = g.HTMLFormElement.prototype
      proto.submit = new Proxy(proto.submit, {
        apply: (t, self: HTMLFormElement, a) => {
          const target = formTarget(self, null)
          if (passing || !isLive() || !opensNew(target, viewOf(self)) || !resendable(self, null) || sandboxed(viewOf(self), 'allow-popups')) return Reflect.apply(t, self, a)
          sendForm(self, null, target, () => native(() => Reflect.apply(t, self, a)))
        },
      })
    }
    frames()
  }
  // A frame this page can reach (its document readable: the same site, a new blank frame included).
  const into = (w: Window | null) => { try { if (w && w !== top && w.document && !sandboxed(w, 'allow-popups')) patch(w as Window & Record<symbol, unknown>) } catch { /* another site's frame: its own page, patched there */ } }
  // Marked first: a part a page's own changes make throw never gets the rest wrapped twice.
  Object.defineProperty(top, mark, { value: true })
  try { patch(top) } catch { /* what was wrapped stays wrapped */ }
  return true
}

/**
 * Runs in the extension's own world of the page: carries the page's asks (above) to the
 * background (agent-opened.ts pageOpen), and what became of each new tab back to the page.
 */
export function inBridge(): boolean {
  const g = globalThis as unknown as Record<string, unknown>
  if (g.__walnutPageOpen) return true
  g.__walnutPageOpen = true
  const rt = (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown>; onMessage: { addListener(f: (m: unknown) => void): void } } } }).chrome.runtime
  const tell = (st: unknown) => document.dispatchEvent(new CustomEvent('walnut-page-open-state', { detail: JSON.stringify(st) }))
  const onAsk = (e: Event) => {
    let d: { op?: unknown; id?: unknown; url?: unknown; form?: unknown } = {}
    try { d = JSON.parse(String((e as CustomEvent).detail)) } catch { return }
    if (typeof d.id !== 'string' || typeof d.op !== 'string') return
    const id = d.id
    // A new window needs the page's user activation, as the browser's own open does (a page cannot fake it).
    const act = (navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation
    if ((d.op === 'open' || d.op === 'form') && act && !act.isActive) { tell({ id, heard: true }); tell({ id, closed: true }); return }
    let asked: Promise<unknown>
    // The extension reloaded or went (this relay's link is dead): silent from now on. A relay of
    // the extension now (injected at its next step) hears the page instead, or the page, hearing
    // none, uses its own way.
    try { asked = rt.sendMessage({ type: 'agent-page-open', op: d.op, id, url: typeof d.url === 'string' ? d.url : '', ...(d.op === 'form' ? { form: d.form } : {}) }) } catch { document.removeEventListener('walnut-page-open', onAsk); g.__walnutPageOpen = false; return }
    tell({ id, heard: true })
    asked.then((r) => {
      const a = r as { ok?: boolean; closed?: boolean; native?: boolean } | undefined
      // Not the agent's to open (the background says): the page's own way. Refused, or not heard: closed.
      if (a?.native) tell({ id, native: true })
      else if (!a || a.closed || (a.ok === false && !('closed' in a))) tell({ id, closed: true })
      // Lost on the way (the background restarted mid-answer): the tab may be made, so never the page's own too.
    }, () => tell({ id, closed: true }))
  }
  document.addEventListener('walnut-page-open', onAsk)
  rt.onMessage.addListener((m) => {
    const x = m as { type?: string; id?: string; url?: string; cross?: boolean; closed?: boolean }
    if (x?.type === 'agent-page-open-state' && typeof x.id === 'string') tell({ id: x.id, url: x.url, cross: x.cross, closed: x.closed })
  })
  return true
}
