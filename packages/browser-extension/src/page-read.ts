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
function readable(root: Element, inContent: boolean): string {
  const skip = new Set<Element>()
  for (const el of Array.from(root.querySelectorAll(CANDIDATES))) if (el.tagName === 'WALNUT-EXT' || furniture(el, inContent)) skip.add(el)
  const holds = new Set<Element>()
  for (const f of skip) for (let p = f.parentElement; p && p !== root && !holds.has(p); p = p.parentElement) holds.add(p)
  const parts: string[] = []
  const walk = (el: Element) => {
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) { const t = (n.textContent ?? '').trim(); if (t) parts.push(t); continue }
      if (n.nodeType !== 1) continue
      const c = n as Element
      if (skip.has(c) || !shown(c)) continue
      if (holds.has(c)) walk(c)
      else { const t = innerOf(c).trim(); if (t) parts.push(t) }
    }
  }
  walk(root)
  return parts.join('\n')
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
    t = innerOf(el); scope = `${roleOf(el)} ${String(args.ref)}`; part = true
  } else if (typeof args.selector === 'string' && args.selector) {
    let el: Element | null
    try { el = document.querySelector(args.selector) } catch { throw new PageError(`Not a CSS selector: ${clip(args.selector, 80)}.`, 'bad_request') }
    if (!el) throw new PageError(`Nothing matches ${clip(args.selector, 80)} on the page: snapshot or find to see what is there.`, 'not_found')
    t = innerOf(el); scope = clip(args.selector, 80); part = true
  } else if (args.all === true || !document.body) {
    t = document.body ? innerOf(document.body) : ''; scope = 'the whole page'
  } else {
    const m = mainOf()
    t = m ? readable(m.el, true) : readable(document.body, false)
    scope = m ? m.scope : 'the page without its menus, header and footer'
    // A page whose content is all furniture (a link list, a menu page): the whole of it.
    if (!t.trim()) { t = innerOf(document.body); scope = 'the whole page' }
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
    lines.push(`  [${refFor(el)}] ${role}${name ? ` "${name}"` : ''}${state ? ` ${state}` : ''}`)
    count++
  }
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
