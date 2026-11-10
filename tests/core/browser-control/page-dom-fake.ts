/**
 * A small page for the extension's page-side modules (page-input.ts, page-ops.ts,
 * page-annotate.ts), on linkedom's DOM with the little layout they read added: each element a test
 * places gets a box (page coordinates), the page and any box may scroll, `elementFromPoint` hits
 * the last placed element under the point (an overlay placed after wins), focus and the active
 * element, a form's fields and submit, and the events a page sees (pointer, mouse, keys).
 * Not a test: imported by the tests that drive those modules. Install it before importing them.
 */
import { parseHTML } from 'linkedom'

export interface Box { x: number; y: number; w: number; h: number }

const g = globalThis as any

export interface FakePage {
  /** A new body, nothing placed, the page scrolled to the top. */
  load(html: string, opts?: { pageHeight?: number }): void
  /** Where an element is, in page coordinates (it scrolls with the page and with `scrollable` boxes around it; `fixed`: on screen, it never scrolls). */
  place(sel: string | Element, box: Box, opts?: { fixed?: boolean }): Element
  /** A box that scrolls on its own: its content height and its own height. */
  scrollable(sel: string | Element, size: { content: number; height: number }): Element
  $(sel: string): Element
  scroll: { x: number; y: number }
  /** How many times something was scrolled into view. */
  intoView: number
  submits: number
  view: { width: number; height: number; pageHeight: number }
}

export function installFakePage(url = 'https://shop.example.test/cart'): FakePage {
  const w = parseHTML('<!doctype html><html><head></head><body></body></html>') as any
  const document = w.document
  const view = { width: 1000, height: 800, pageHeight: 800 }
  const boxes = new Map<Element, Box>()
  const fixed = new Set<Element>()
  const boxScroll = new Map<Element, { top: number; left: number; content: number; height: number }>()
  let active: Element | null = null

  for (const k of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLSelectElement',
    'HTMLFormElement', 'HTMLLabelElement', 'HTMLIFrameElement', 'Element', 'Node', 'Event', 'CustomEvent', 'InputEvent']) g[k] = w[k]
  // The page's own observer (a page that answers a step is seen by it: page-probe.ts, page-enter.ts).
  g.MutationObserver = w.MutationObserver
  const Base = w.Event
  class UIEvent extends Base { constructor(type: string, init: Record<string, unknown> = {}) { super(type, init); Object.assign(this, init) } }
  g.MouseEvent = UIEvent
  g.PointerEvent = UIEvent
  g.KeyboardEvent = UIEvent
  g.document = document
  g.window = g
  g.location = new URL(url)
  const page = { x: 0, y: 0 }
  const fake: FakePage = {
    load(html, opts = {}) {
      document.body.innerHTML = html
      boxes.clear(); boxScroll.clear(); fixed.clear(); active = null
      page.x = 0; page.y = 0
      view.pageHeight = opts.pageHeight ?? view.height
      fake.intoView = 0
      fake.submits = 0
    },
    place(sel, box, opts = {}) { const el = typeof sel === 'string' ? fake.$(sel) : sel; boxes.set(el, box); if (opts.fixed) fixed.add(el); return el },
    scrollable(sel, size) { const el = typeof sel === 'string' ? fake.$(sel) : sel; boxScroll.set(el, { top: 0, left: 0, ...size }); return el },
    $(sel) { const el = document.querySelector(sel); if (!el) throw new Error(`no ${sel} in the fake page`); return el },
    scroll: page,
    intoView: 0,
    submits: 0,
    view,
  }
  for (const [k, get] of [['innerWidth', () => view.width], ['innerHeight', () => view.height], ['scrollX', () => page.x], ['scrollY', () => page.y]] as const) {
    Object.defineProperty(g, k, { configurable: true, get })
  }
  const maxY = () => Math.max(0, view.pageHeight - view.height)
  const clampY = (y: number) => Math.min(Math.max(0, y), maxY())

  /** The element's box on screen now: its page box, less the page's scroll and every scrolling box around it. */
  function rectOf(el: Element) {
    const b = boxes.get(el)
    if (!b) return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
    if (fixed.has(el)) return { x: b.x, y: b.y, left: b.x, top: b.y, width: b.w, height: b.h, right: b.x + b.w, bottom: b.y + b.h }
    let dx = page.x
    let dy = page.y
    for (let p = el.parentElement; p; p = p.parentElement) { const s = boxScroll.get(p); if (s) { dx += s.left; dy += s.top } }
    const left = b.x - dx
    const top = b.y - dy
    return { x: left, y: top, left, top, width: b.w, height: b.h, right: left + b.w, bottom: top + b.h }
  }
  const E = w.Element.prototype
  E.getBoundingClientRect = function (this: Element) { return rectOf(this) }
  E.scrollIntoView = function (this: Element, o: { block?: string } = {}) {
    fake.intoView++
    const b = boxes.get(this)
    if (!b) return
    const r = rectOf(this)
    if (o.block === 'nearest') {
      if (r.top < 0) page.y = clampY(page.y + r.top)
      else if (r.bottom > view.height) page.y = clampY(page.y + r.bottom - view.height)
    } else page.y = clampY(page.y + r.top + r.height / 2 - view.height / 2)
  }
  const isPage = (el: Element) => el === document.documentElement
  const scrollState = (el: Element) => boxScroll.get(el)
  Object.defineProperty(E, 'scrollTop', {
    configurable: true,
    get(this: Element) { return isPage(this) ? page.y : scrollState(this)?.top ?? 0 },
    set(this: Element, v: number) { if (isPage(this)) page.y = clampY(v); else { const s = scrollState(this); if (s) s.top = Math.min(Math.max(0, v), Math.max(0, s.content - s.height)) } },
  })
  Object.defineProperty(E, 'scrollLeft', { configurable: true, get(this: Element) { return isPage(this) ? page.x : scrollState(this)?.left ?? 0 }, set() {} })
  Object.defineProperty(E, 'scrollHeight', { configurable: true, get(this: Element) { return isPage(this) ? view.pageHeight : scrollState(this)?.content ?? boxes.get(this)?.h ?? 0 } })
  Object.defineProperty(E, 'clientHeight', { configurable: true, get(this: Element) { return isPage(this) ? view.height : scrollState(this)?.height ?? boxes.get(this)?.h ?? 0 } })
  Object.defineProperty(E, 'scrollWidth', { configurable: true, get(this: Element) { return isPage(this) ? view.width : boxes.get(this)?.w ?? 0 } })
  Object.defineProperty(E, 'clientWidth', { configurable: true, get(this: Element) { return isPage(this) ? view.width : boxes.get(this)?.w ?? 0 } })
  E.scrollBy = function (this: Element, o: { top?: number }) { (this as any).scrollTop = (this as any).scrollTop + (o.top ?? 0) }
  E.scrollTo = function (this: Element, o: { top?: number }) { if (typeof o.top === 'number') (this as any).scrollTop = o.top }

  Object.defineProperty(document, 'scrollingElement', { configurable: true, get: () => document.documentElement })
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => (active && active.isConnected ? active : document.body) })
  document.elementFromPoint = (x: number, y: number) => {
    let hit: Element | null = null
    for (const el of document.querySelectorAll('*')) {
      const r = rectOf(el)
      if (r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom) hit = el
    }
    return hit
  }
  document.execCommand = (cmd: string, _ui?: boolean, value?: string) => {
    const el = document.activeElement as Element
    if (cmd === 'insertText' && el) el.textContent = `${el.textContent ?? ''}${value ?? ''}`
    if (cmd === 'delete' && el) el.textContent = ''
    return true
  }
  g.getComputedStyle = (el: Element) => {
    const css: Record<string, string> = {}
    for (const part of (el.getAttribute('style') ?? '').split(';')) {
      const [k, v] = part.split(':').map((s) => s?.trim())
      if (k && v) css[k] = v
    }
    const overflow = css.overflow ?? 'visible'
    return { overflowY: css['overflow-y'] ?? overflow, overflowX: css['overflow-x'] ?? overflow, position: css.position ?? 'static', visibility: css.visibility ?? 'visible', display: css.display ?? 'block', opacity: css.opacity ?? '1' }
  }

  const H = w.HTMLElement.prototype
  H.focus = function (this: Element) { active = this }
  H.blur = function (this: Element) { if (active === this) active = null }
  // A browser's defaults linkedom leaves out: an input is text, a button submits, fields know their form.
  Object.defineProperty(w.HTMLInputElement.prototype, 'type', { configurable: true, get(this: Element) { return this.getAttribute('type') ?? 'text' }, set(this: Element, v: string) { this.setAttribute('type', v) } })
  Object.defineProperty(w.HTMLButtonElement.prototype, 'type', { configurable: true, get(this: Element) { return this.getAttribute('type') ?? 'submit' }, set(this: Element, v: string) { this.setAttribute('type', v) } })
  for (const C of [w.HTMLInputElement, w.HTMLButtonElement, w.HTMLTextAreaElement, w.HTMLSelectElement]) {
    Object.defineProperty(C.prototype, 'form', { configurable: true, get(this: Element) { return this.closest('form') } })
  }
  Object.defineProperty(w.HTMLFormElement.prototype, 'elements', { configurable: true, get(this: Element) { return [...this.querySelectorAll('input, button, select, textarea')] } })
  w.HTMLFormElement.prototype.requestSubmit = function () { fake.submits++ }
  return fake
}

/** Every event of these types any element of the page sees, in order: `type key` for keys. */
export function recordEvents(types: string[]): string[] {
  const seen: string[] = []
  for (const t of types) {
    g.document.addEventListener(t, (e: any) => { seen.push(e.key !== undefined ? `${t} ${e.key}` : t) })
  }
  return seen
}
