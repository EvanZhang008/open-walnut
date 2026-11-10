/**
 * An agent reading a page (page-ops.ts sends `snapshot` and `text` here), small by default
 * (2026-11-10: a read-only task took 16 calls; `text` dumped every menu, sidebar and footer, and
 * nothing read one part):
 *
 *   - `text`: the page's main content (an open modal dialog, main, [role=main], or its one article;
 *     else the page with its navigation, page header and footer, sidebars and cookie banners left
 *     out; never a hidden element), at most
 *     `max` characters (4000), with how much more there is. `ref` or `selector` reads one element;
 *     `all` the whole page as before.
 *   - `snapshot`: the elements on screen now, one line each with its ref, and how many are
 *     elsewhere on the page; `all` lists the whole page (and its text) as before.
 *
 * Words innerText misses are read too: an open shadow root's (a component that draws its text
 * there), and a date element's full date (its title, else its datetime) beside the words it shows
 * ("37 minutes ago (Nov 10, 2026, 4:11 AM PST)"). 2026-11-10:
 * a release page's date sat in a `relative-time` element and `text` had none.
 */
import { INTERACTIVE, PageError, all, byRef, clip, nameOf, refFor, roleOf, stateOf, visible } from './page-agent'

/** What `text` gives by default, and at most. */
export const TEXT_MAX = 4000
export const TEXT_MAX_ALL = 100_000
/** What a default snapshot lists at most (the whole page: 300). */
export const SNAPSHOT_MAX = 80

/** Page furniture: never the content an agent came to read. */
const CHROME = 'nav, aside, [role=navigation], [role=complementary], [role=search], [role=banner], [role=contentinfo], script, style, noscript, template'
/** A header or footer of the page itself (one inside an article or main is that content's own). */
const PAGE_EDGE = 'header, footer'
const COOKIE = /(^|[\s_-])(cookie|consent|gdpr|onetrust|cmp-|truste)/i

const innerOf = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '')

/** Date elements a site fills by script (or in a shadow root): their words may be only in an attribute. */
const DATES = 'relative-time, time, local-time, time-ago'

/** A date's words from its attributes: its title (the full date a person reads on hover), else its datetime. */
function dateWords(el: Element): string {
  const title = el.getAttribute('title')?.trim()
  if (title) return title
  const dt = el.getAttribute('datetime')?.trim()
  if (!dt) return ''
  const d = new Date(dt)
  return Number.isNaN(d.getTime()) ? dt : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

/** How many shadow roots deep a read goes; past it an element reads as its own innerText (never nothing). */
const SHADOW_DEPTH = 8

/**
 * The words of `root` (an element or a shadow root) in order, a line per block: an element is read
 * whole (innerText) unless something in it needs a closer look (a shadow root, a date, a slot, an
 * element in `skip`), and then its children one by one. A slot reads the host's children it shows.
 */
function wordsOf(root: Element | ShadowRoot, depth: number, skip: Set<Element> = new Set()): string[] {
  const deep = new Set<Element>()
  const holds = new Set<Node>()
  const hold = (f: Element) => { for (let p: Node | null = f.parentNode; p && p !== root && !holds.has(p); p = p.parentNode) holds.add(p) }
  for (const f of skip) hold(f)
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.shadowRoot || el.matches(DATES) || el.tagName === 'SLOT') { deep.add(el); hold(el) }
  }
  const parts: string[] = []
  const push = (t: string) => { const x = t.trim(); if (x) parts.push(x) }
  const walk = (node: Node) => {
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) { push(n.textContent ?? ''); continue }
      if (n.nodeType !== 1) continue
      const c = n as Element
      if (skip.has(c) || /^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT)$/.test(c.tagName) || !shown(c)) continue
      if (c.tagName === 'SLOT') {
        const got = (c as HTMLSlotElement).assignedNodes?.({ flatten: true }) ?? []
        for (const x of got.length ? got : Array.from(c.childNodes)) push(x.nodeType === 1 ? deepOf(x as Element, depth) : x.nodeType === 3 ? x.textContent ?? '' : '')
      } else if (deep.has(c)) push(deepOf(c, depth))
      else if (holds.has(c)) walk(c)
      else push(innerOf(c))
    }
  }
  walk(root)
  return parts
}

/** An element's words, its shadow root's and its dates' included. */
function deepOf(el: Element, depth = 0): string {
  // Past the depth cap the element reads as innerText reads it, never as nothing.
  const drawn = el.shadowRoot && depth < SHADOW_DEPTH ? wordsOf(el.shadowRoot, depth + 1).join('\n').trim() : ''
  if (el.matches(DATES)) {
    // "37 minutes ago" says little a day later: the full date with it, when the element has one.
    const words = drawn || innerOf(el).trim()
    const full = dateWords(el)
    return words && full && !words.includes(full) ? `${words} (${full})` : words || full
  }
  if (el.shadowRoot) return drawn || innerOf(el).trim() || el.getAttribute('title')?.trim() || ''
  return wordsOf(el, depth).join('\n')
}

/** A box laid over the page (a banner or a dialog), as a cookie notice is. */
function overlay(el: Element): boolean {
  if (el.matches('dialog, [role=dialog], [role=alertdialog], [role=region], [aria-modal=true]')) return true
  const pos = getComputedStyle(el).position
  return pos === 'fixed' || pos === 'sticky'
}

/** A cookie or consent notice: named so, laid over the page, and short (a page about cookies is not one). */
function cookieNotice(el: Element): boolean {
  const tag = `${el.id} ${typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : ''}`
  return COOKIE.test(tag) && overlay(el) && innerOf(el).length < 4000
}

function furniture(el: Element, inContent: boolean): boolean {
  if (el.matches(CHROME)) return true
  // The page's own header or footer; a header holding the page's title (its h1) is content.
  if (!inContent && el.matches(PAGE_EDGE) && !el.closest('article, main, [role=main]') && !(el.tagName === 'HEADER' && el.querySelector('h1'))) return true
  return cookieNotice(el)
}

/** Drawn on the page (a hidden menu or tab panel is not read). An element with display: contents draws only its children. */
function shown(el: Element): boolean {
  const cs = getComputedStyle(el)
  if (cs.display === 'contents') return true
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility
  if (typeof check === 'function') return check.call(el)
  return cs.display !== 'none' && cs.visibility !== 'hidden'
}

/** The page's main content: an open modal dialog first (it is what the page shows now), else main, [role=main], or its only article. */
function mainOf(): { el: Element; scope: string } | null {
  const modal = all(document, 'dialog[open], [aria-modal=true], [role=dialog], [role=alertdialog]').find((d) => visible(d) && !cookieNotice(d) && innerOf(d).trim())
  if (modal) return { el: modal, scope: 'the open dialog (text --all reads the page behind it)' }
  const m = all(document, 'main, [role=main]').find(visible)
  if (m) return { el: m, scope: 'main content' }
  const arts = all(document, 'article').filter(visible)
  if (arts.length === 1) return { el: arts[0], scope: 'the article' }
  return null
}

/** Elements that may be furniture, found in one query (each is then judged by `furniture`). */
const CANDIDATES = `${CHROME}, ${PAGE_EDGE}, walnut-ext, [id*=cookie], [class*=cookie], [id*=Cookie], [class*=Cookie], [id*=consent], [class*=consent], [id*=gdpr], [class*=gdpr]`

/**
 * The text of `root` without its furniture: the furniture is found once, then the walk reads an
 * element whole unless furniture sits inside it (then its children, one by one).
 */
function readable(root: Element, inContent: boolean, keepFurniture = false): string {
  const skip = new Set<Element>()
  for (const el of Array.from(root.querySelectorAll(keepFurniture ? 'walnut-ext' : CANDIDATES))) {
    if (el.tagName === 'WALNUT-EXT' || furniture(el, inContent)) skip.add(el)
  }
  if (root.shadowRoot || root.matches(DATES)) return deepOf(root)
  return wordsOf(root, 0, skip).join('\n')
}

const tidy = (s: string) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

export interface TextArgs { max?: unknown; all?: unknown; ref?: unknown; selector?: unknown }

export function text(args: TextArgs = {}): { text: string; url: string; title: string; scope: string; chars: number; cut?: true } {
  const max = typeof args.max === 'number' && args.max > 0 ? Math.min(TEXT_MAX_ALL, Math.floor(args.max)) : args.all === true ? 20_000 : TEXT_MAX
  let t: string
  let scope: string
  let part = false
  if (args.ref !== undefined) {
    const el = byRef(args.ref)
    t = readable(el, true, true); scope = `${roleOf(el)} ${String(args.ref)}`; part = true
  } else if (typeof args.selector === 'string' && args.selector) {
    let el: Element | null
    try { el = document.querySelector(args.selector) } catch { throw new PageError(`Not a CSS selector: ${clip(args.selector, 80)}.`, 'bad_request') }
    if (!el) throw new PageError(`Nothing matches ${clip(args.selector, 80)} on the page: snapshot or find to see what is there.`, 'not_found')
    t = readable(el, true, true); scope = clip(args.selector, 80); part = true
  } else if (args.all === true || !document.body) {
    t = document.body ? readable(document.body, false, true) : ''; scope = 'the whole page'
  } else {
    const m = mainOf()
    t = m ? readable(m.el, true) : readable(document.body, false)
    scope = m ? m.scope : 'the page without its menus, header and footer'
    // A page whose content is all furniture (a link list, a menu page): the whole of it.
    if (!t.trim()) { t = readable(document.body, false, true); scope = 'the whole page' }
  }
  t = tidy(t)
  const chars = t.length
  if (chars <= max) return { text: t, url: location.href, title: document.title, scope, chars }
  const more = chars - max
  const how = part ? '--max N (max) reads more' : '--max N (max) reads more, --ref e12 or --selector css (ref, selector) reads one part'
  return { text: `${t.slice(0, max)}\n… (${more} more characters: ${how})`, url: location.href, title: document.title, scope, chars, cut: true }
}

/** On screen now, or nearly (a quarter of a screen around it). */
function nearView(el: Element): boolean {
  const r = el.getBoundingClientRect()
  const pad = innerHeight / 4
  return r.bottom >= -pad && r.top <= innerHeight + pad && r.right >= 0 && r.left <= innerWidth
}

export interface SnapshotArgs { max?: unknown; all?: unknown }

export function snapshot(args: SnapshotArgs = {}): { snapshot: string; url: string; title: string; count: number; more?: number } {
  const whole = args.all === true
  const max = typeof args.max === 'number' && args.max > 0 ? Math.floor(args.max) : whole ? 300 : SNAPSHOT_MAX
  const seen = new Set<Element>()
  const lines: string[] = [`Page: ${clip(document.title, 120)}`, `URL: ${location.href}`, '']
  const heads = all(document, 'h1, h2, h3').filter((h) => visible(h) && (whole || nearView(h))).slice(0, whole ? 30 : 12)
  if (heads.length) {
    lines.push('Headings:')
    for (const h of heads) lines.push(`  ${h.tagName.toLowerCase()} ${clip(h.textContent ?? '', 120)}`)
    lines.push('')
  }
  const dialog = all(document, 'dialog[open], [role=dialog], [aria-modal=true]').find(visible)
  if (dialog) lines.push(`A dialog is open: ${clip(nameOf(dialog), 80)}`, '')
  lines.push(whole ? 'Elements:' : 'Elements on screen:')
  // Near the screen but not on it (a quarter of a screen around it): under their own heading, so
  // "on screen" means on screen (2026-11-10: a page footer listed there, each line "offscreen").
  const near: string[] = []
  let count = 0
  let elsewhere = 0
  let full = false
  for (const el of all(document, INTERACTIVE)) {
    if (seen.has(el) || !visible(el)) continue
    seen.add(el)
    const name = clip(nameOf(el), 100)
    const role = roleOf(el)
    if (role === 'generic' && !name) continue
    if (!whole && !nearView(el)) { elsewhere++; continue }
    if (count >= max) { full = true; elsewhere++; continue }
    const state = stateOf(el)
    const off = !whole && / ?\boffscreen$/.test(state)
    const words = off ? state.replace(/ ?\boffscreen$/, '') : state
    const line = `  [${refFor(el)}] ${role}${name ? ` "${name}"` : ''}${words ? ` ${words}` : ''}`
    if (off) near.push(line); else lines.push(line)
    count++
  }
  if (!whole && count === near.length) lines.push('  (none)')
  if (near.length) lines.push('Just off screen (scroll to them, or act by ref):', ...near)
  if (whole) {
    if (full) lines.push('  ... more elements (scroll and snapshot again)')
    const t = clip(document.body?.innerText ?? '', 2500)
    if (t) lines.push('', 'Text:', t)
    return { snapshot: lines.join('\n'), url: location.href, title: document.title, count }
  }
  if (elsewhere) lines.push(`  … ${elsewhere} more element(s) off screen${full ? ' or past the first ' + max : ''}: find <words> finds one, snapshot --all (all) lists the page, scroll then snapshot`)
  lines.push('', 'Read the page: text (its main content).')
  return { snapshot: lines.join('\n'), url: location.href, title: document.title, count, ...(elsewhere ? { more: elsewhere } : {}) }
}
