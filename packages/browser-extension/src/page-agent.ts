/**
 * What an agent does inside a page it opened (content.ts runs it in each frame of an agent tab;
 * the background sends nothing else here). A snapshot lists what a person could act on, each
 * with a ref (e12) that holds as long as the element does, and the page's headings and text;
 * the actions find an element by its ref and act on it as a person would. A frame's refs carry
 * its frame id (f3:e12), set by the background for each op (setFrame).
 *
 * Input here is the page's own DOM events (isTrusted false), so it never counts as the person:
 * the password menu and save bar ignore it, and nothing an agent types is offered for saving.
 */

import { walnutFilled } from './form-detect'

const refs = new Map<string, WeakRef<Element>>()
const refOf = new WeakMap<Element, string>()
let next = 1
/** This frame's prefix on its refs ("f3:"; none in the top frame), for the op running now. */
let framePrefix = ''

export function setFrame(frame: unknown): void {
  framePrefix = typeof frame === 'string' && /^f\d+$/.test(frame) ? `${frame}:` : ''
}

function give(el: Element): string {
  const r = `e${next++}`
  refOf.set(el, r)
  refs.set(r, new WeakRef(el))
  return r
}

/**
 * An element's ref. Refs are handed out in the page's own order, never in the order an action
 * happens to read it: the first element without one numbers every control of the page that has
 * none yet, top to bottom. So snapshot, form_values, find and fill_form name the same field the
 * same way, whichever ran first, and an unchanged page loaded again gets the same refs.
 */
export function refFor(el: Element): string {
  let r = refOf.get(el)
  if (!r) {
    for (const x of all(document, INTERACTIVE)) if (!refOf.has(x)) give(x)
    r = refOf.get(el) ?? give(el)
  }
  return framePrefix + r
}

export class PageError extends Error {
  constructor(message: string, readonly code: string) { super(message) }
}

export function byRef(ref: unknown): Element {
  const el = typeof ref === 'string' ? refs.get(ref.replace(/^f\d+:/, ''))?.deref() : undefined
  if (!el || !el.isConnected) throw new PageError(`No element ${String(ref)} on the page now: snapshot again.`, 'stale_ref')
  return el
}

// ── reading the page ──

export const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=""], [contenteditable=true], '
  + '[role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=textbox], [role=searchbox], [tabindex]:not([tabindex="-1"])'

export function visible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return false
  const cs = getComputedStyle(el)
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
}

/** Every element, open shadow roots included. */
export function all(root: Document | ShadowRoot | Element, sel: string, out: Element[] = []): Element[] {
  for (const el of root.querySelectorAll(sel)) out.push(el)
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) all(el.shadowRoot, sel, out)
  return out
}

export const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

export function roleOf(el: Element): string {
  const r = el.getAttribute('role')
  if (r) return r
  const t = el.tagName.toLowerCase()
  if (t === 'a') return 'link'
  if (t === 'button' || t === 'summary') return 'button'
  if (t === 'select') return 'combobox'
  if (t === 'textarea') return 'textbox'
  if (t === 'input') {
    const ty = (el as HTMLInputElement).type
    if (ty === 'checkbox' || ty === 'radio') return ty
    if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button'
    if (ty === 'search') return 'searchbox'
    if (ty === 'range') return 'slider'
    return 'textbox'
  }
  if ((el as HTMLElement).isContentEditable) return 'textbox'
  return 'generic'
}

/** A label's own words: a control inside it (a select's options, a field's value) is not its name. */
function labelText(label: HTMLLabelElement | undefined): string {
  if (!label) return ''
  const copy = label.cloneNode(true) as HTMLElement
  for (const c of copy.querySelectorAll('select, input, textarea, button, datalist')) c.remove()
  return copy.textContent ?? ''
}

export function nameOf(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria) return aria
  const by = el.getAttribute('aria-labelledby')
  if (by) {
    const t = by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ')
    if (t.trim()) return t
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const lab = labelText(el.labels?.[0])
    if (lab.trim()) return lab
    if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type) && el.value) return el.value
    const ph = el.getAttribute('placeholder')
    if (ph) return ph
  }
  const own = (el as HTMLElement).innerText ?? el.textContent ?? ''
  if (own.trim()) return own
  return el.getAttribute('title') || el.getAttribute('alt') || el.querySelector('img')?.getAttribute('alt') || el.getAttribute('name') || ''
}

/** Every field seen as a password: one the page's "show" button turned to text stays a secret. */
const wasPassword = new WeakSet<HTMLInputElement>()

/** Notes the password fields on the page now (the content script calls it at load, on changes and on focus). */
export function notePasswords(root: Document | Element = document): void {
  for (const el of all(root as Document, 'input[type=password]')) wasPassword.add(el as HTMLInputElement)
}

export function notePassword(el: EventTarget | null): void {
  if (el instanceof HTMLInputElement && el.type === 'password') wasPassword.add(el)
}

/**
 * A value no agent reads: a password (also one the page's "show" button turned to text), a
 * one-time code, and anything Walnut filled from the vault.
 */
export function secret(el: HTMLInputElement): boolean {
  if (el.type === 'password' || walnutFilled.has(el) || wasPassword.has(el)) return true
  const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase()
  if (/\b(current-password|new-password|one-time-code|cc-number|cc-csc)\b/.test(ac)) return true
  return /pass(word|wd)|(^|[\W_])(otp|totp|2fa|mfa|cvc|cvv|csc)($|[\W_])/i.test(` ${el.name} ${el.id} `)
}

let masked: Array<{ el: HTMLInputElement; type: string }> = []

/** Before a screenshot: a secret the page shows as text is drawn as dots, until unmask(). */
export function maskSecrets(): number {
  unmask()
  for (const el of all(document, 'input')) {
    if (el instanceof HTMLInputElement && el.type !== 'password' && el.value && secret(el)) {
      masked.push({ el, type: el.type })
      el.type = 'password'
    }
  }
  return masked.length
}

export function unmask(): void {
  for (const m of masked) if (m.el.isConnected && m.el.type === 'password') m.el.type = m.type
  masked = []
}

/** A link's address as a snapshot shows it: the path alone on the page's own site. */
function shortHref(href: string): string {
  try {
    const u = new URL(href)
    return u.origin === location.origin ? `${u.pathname}${u.search}${u.hash}` : href
  } catch { return href }
}

export function stateOf(el: Element): string {
  const parts: string[] = []
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') parts.push(el.checked ? 'checked' : 'unchecked')
    else if (secret(el)) { if (el.value) parts.push('value=(hidden)') }
    else if (!['submit', 'button', 'reset', 'image'].includes(el.type) && el.value) parts.push(`value="${clip(el.value, 80)}"`)
    if (el.type && !['text', 'checkbox', 'radio', 'submit', 'button'].includes(el.type)) parts.push(`type=${el.type}`)
  } else if (el instanceof HTMLTextAreaElement && el.value) parts.push(`value="${clip(el.value, 80)}"`)
  else if (el instanceof HTMLSelectElement) parts.push(`selected="${clip(el.selectedOptions[0]?.textContent ?? '', 60)}"`)
  const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? el.getAttribute('aria-pressed')
  if (checked) parts.push(`${checked === 'true' ? 'on' : 'off'}`)
  if (el.getAttribute('aria-expanded')) parts.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed')
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled')
  if (el instanceof HTMLAnchorElement && el.href && !el.href.startsWith('javascript:')) parts.push(`-> ${clip(shortHref(el.href), 100)}`)
  const r = el.getBoundingClientRect()
  if (r.bottom < 0 || r.top > innerHeight) parts.push('offscreen')
  return parts.join(' ')
}

// snapshot and text: page-read.ts.

/**
 * What the side panel is told about the page: its address, title, the person's selection (in a
 * text box too, never in a secret field) and, when a question is asked with it, its visible text
 * (no field values).
 */
export function pageContext(withText: boolean, maxText = 200_000): { url: string; title: string; selection: string; text?: string } {
  const el = document.activeElement
  const inField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
  let selection = ''
  if (inField) {
    // A box's own selection (Chrome also reports it through getSelection()): never a secret one.
    if (!(el instanceof HTMLInputElement && (secret(el) || !['text', 'search', 'url', 'email', ''].includes(el.type)))) {
      const a = el.selectionStart ?? 0
      const b = el.selectionEnd ?? 0
      if (b > a) selection = el.value.slice(a, b)
    }
  } else {
    selection = getSelection()?.toString() ?? ''
  }
  const out: { url: string; title: string; selection: string; text?: string } = { url: location.href, title: document.title, selection: selection.trim().slice(0, 4000) }
  if (withText) out.text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxText)
  return out
}

// ── acting ──

export function centerOf(el: Element): { x: number; y: number } {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

export function mouse(el: Element, type: string, x: number, y: number): void {
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith('down') ? 1 : 0, view: window }
  el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(type, init))
}

/** The element a ref or a point names, and the point a pointer would use on it (refused when something covers it). */
export function target(args: { ref?: unknown; x?: unknown; y?: unknown }): { el: Element; x: number; y: number } {
  if (typeof args.x === 'number' && typeof args.y === 'number') {
    const el = document.elementFromPoint(args.x, args.y)
    if (!el) throw new PageError(`Nothing at ${args.x},${args.y}.`, 'nothing_there')
    return { el, x: args.x, y: args.y }
  }
  const el = byRef(args.ref)
  const { x, y } = centerOf(el)
  // What is really under the point (a cookie banner, an overlay) is what a click would hit.
  const top = document.elementFromPoint(x, y)
  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
    throw new PageError(`${String(args.ref)} is covered by ${roleOf(top)} "${clip(nameOf(top), 60)}" (${top.tagName.toLowerCase()}): close or scroll it first.`, 'covered')
  }
  return { el, x, y }
}

export function click(args: { ref?: unknown; x?: unknown; y?: unknown }): { clicked: string; newTab?: string } {
  const { el, x, y } = target(args)
  for (const t of ['pointerover', 'pointerenter', 'mouseover', 'pointerdown', 'mousedown']) mouse(el, t, x, y)
  if (el instanceof HTMLElement) el.focus({ preventScroll: true })
  for (const t of ['pointerup', 'mouseup']) mouse(el, t, x, y)
  const clicked = `${roleOf(el)} "${clip(nameOf(el), 60)}"`
  // A link to a new tab: the browser blocks a new tab from a click that is not the person's, so
  // the background opens it (as the same agent's tab) instead.
  const a = el.closest('a[href]')
  if (a instanceof HTMLAnchorElement && /^_blank$/i.test(a.target) && /^https?:/i.test(a.href) && !a.hasAttribute('download')) return { clicked, newTab: a.href }
  // click() runs the element's default action (a link follows, a checkbox toggles, a form sends).
  if (el instanceof HTMLElement) el.click()
  else mouse(el, 'click', x, y)
  return { clicked }
}

/** The pointer comes over the element (or point), as a person's mouse would: hover menus open on it. */
export function hover(args: { ref?: unknown; x?: unknown; y?: unknown }): { hovered: string } {
  const { el, x, y } = target(args)
  for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
    const init = { bubbles: !t.endsWith('enter'), cancelable: true, composed: true, clientX: x, clientY: y, view: window }
    el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, { ...init, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(t, init))
  }
  return { hovered: `${roleOf(el)} "${clip(nameOf(el), 60)}"` }
}

/** The value set the way a person's typing sets it, so frameworks (React and the like) see it. */
export function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value); else el.value = value
}

export function key(el: Element, k: string, type: 'keydown' | 'keyup' | 'keypress'): boolean {
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k
  return el.dispatchEvent(new KeyboardEvent(type, { key: k, code, bubbles: true, cancelable: true, composed: true }))
}

function submitFrom(el: Element): void {
  const go = key(el, 'Enter', 'keydown')
  key(el, 'Enter', 'keypress')
  key(el, 'Enter', 'keyup')
  // A form sends on Enter by default; the page may have taken the key itself (then it did not).
  if (go && (el instanceof HTMLInputElement) && el.form) el.form.requestSubmit()
}

export function type(args: { ref?: unknown; text?: unknown; clear?: unknown; submit?: unknown }): { typed: string } {
  const el = args.ref !== undefined ? byRef(args.ref) : document.activeElement
  if (!el || el === document.body) throw new PageError('No field is focused: give the ref of the field to type in.', 'no_field')
  const value = String(args.text ?? '')
  if (el instanceof HTMLElement) { centerOf(el); el.focus() }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) throw new PageError('That field cannot be typed in (disabled or read-only).', 'read_only')
    const next = args.clear === true ? value : el.value + value
    setNative(el, next)
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else if ((el as HTMLElement).isContentEditable) {
    if (args.clear === true) { document.execCommand('selectAll'); document.execCommand('delete') }
    document.execCommand('insertText', false, value)
  } else throw new PageError(`${roleOf(el)} "${clip(nameOf(el), 40)}" is not a text field.`, 'not_a_field')
  if (args.submit === true) submitFrom(el)
  return { typed: `${value.length} characters into ${roleOf(el)} "${clip(nameOf(el), 60)}"` }
}

export function select(args: { ref?: unknown; value?: unknown }): { selected: string } {
  const el = byRef(args.ref)
  const want = String(args.value ?? '')
  if (!(el instanceof HTMLSelectElement)) throw new PageError('That is not a list to pick from: click it, then click the option.', 'not_a_select')
  const opt = [...el.options].find((o) => o.value === want) ?? [...el.options].find((o) => (o.textContent ?? '').trim().toLowerCase() === want.trim().toLowerCase())
  if (!opt) throw new PageError(`No option "${want}". Options: ${[...el.options].map((o) => clip(o.textContent ?? '', 30)).slice(0, 20).join(', ')}.`, 'no_option')
  el.value = opt.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { selected: clip(opt.textContent ?? opt.value, 60) }
}

export function press(args: { key?: unknown }): { pressed: string } {
  const k = String(args.key ?? '')
  if (!k) throw new PageError('Say which key.', 'no_key')
  const el = document.activeElement ?? document.body
  if (k === 'Enter') { submitFrom(el); return { pressed: k } }
  const go = key(el, k, 'keydown')
  key(el, k, 'keyup')
  // Tab moves the focus as a browser would, when the page did not take the key.
  if (go && k === 'Tab') {
    const list = all(document, INTERACTIVE).filter((e) => visible(e) && !(e as HTMLButtonElement).disabled) as HTMLElement[]
    const i = list.indexOf(el as HTMLElement)
    list[(i + 1) % list.length]?.focus()
  }
  if (go && k === 'Escape' && el instanceof HTMLElement) el.blur()
  return { pressed: k }
}

/** What scrolls: the page, or (an app whose page does not) its largest scrolling box. */
function scroller(): Element {
  const doc = document.scrollingElement ?? document.documentElement
  if (doc.scrollHeight > innerHeight + 2 || doc.scrollWidth > innerWidth + 2) return doc
  let best: Element = doc
  let area = 0
  for (const el of all(document, 'div, main, section, article, ul, [role=main], [role=list], [role=feed]')) {
    if (el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2) continue
    const o = getComputedStyle(el).overflowY + getComputedStyle(el).overflowX
    if (!/auto|scroll/.test(o) || !visible(el)) continue
    const a = el.clientWidth * el.clientHeight
    if (a > area) { area = a; best = el }
  }
  return best
}

export function scroll(args: { ref?: unknown; direction?: unknown; amount?: unknown; to?: unknown; by?: unknown }): Record<string, unknown> {
  if (args.ref !== undefined) { centerOf(byRef(args.ref)); return { scrolled: `to ${String(args.ref)}`, ...scrollWhere(scroller()) } }
  return scrollBox(scroller(), args)
}

/** One box scrolled as `scroll` asks (a direction and screens or px, or to its top or bottom); the page, or a box inside it (page-input.ts). */
export function scrollBox(box: Element, args: { direction?: unknown; amount?: unknown; to?: unknown; by?: unknown }): Record<string, unknown> {
  const flat = { behavior: 'instant' as ScrollBehavior }
  const sideways = args.direction === 'left' || args.direction === 'right'
  const page = box === document.scrollingElement
  let said: string
  if (args.to === 'top' || args.to === 'bottom') {
    box.scrollTo({ top: args.to === 'top' ? 0 : box.scrollHeight, ...flat })
    said = `to the ${args.to}`
  } else {
    const sign = args.direction === 'up' || args.direction === 'left' ? -1 : 1
    const screen = sideways ? (page ? innerWidth : box.clientWidth) : (page ? innerHeight : box.clientHeight)
    const n = typeof args.amount === 'number' && args.amount > 0 ? Math.min(args.amount, 20) : 1
    const px = typeof args.by === 'number' && args.by > 0 ? Math.min(args.by, 100_000) : n * screen * 0.85
    box.scrollBy({ [sideways ? 'left' : 'top']: sign * px, ...flat })
    said = `${sideways ? (sign < 0 ? 'left' : 'right') : (sign < 0 ? 'up' : 'down')} ${typeof args.by === 'number' && args.by > 0 ? `${Math.round(px)} px` : `${n} screen(s)`}`
  }
  const w = scrollWhere(box)
  return { scrolled: `${said}; at ${w.scrollTop} of ${w.maxTop}`, ...w }
}

export function scrollWhere(box: Element): { scrollTop: number; scrollLeft: number; maxTop: number; atTop: boolean; atBottom: boolean } {
  const maxTop = Math.max(0, Math.round(box.scrollHeight - box.clientHeight))
  const top = Math.round(box.scrollTop)
  return { scrollTop: top, scrollLeft: Math.round(box.scrollLeft), maxTop, atTop: top <= 1, atBottom: top >= maxTop - 1 }
}

const bodyText = () => (document.body?.innerText ?? '').toLowerCase()

/** Whether this frame's page shows the text now (the background's wait asks every frame, agent-page.ts waitText). */
export function hasText(args: { text?: unknown }): { has: boolean } {
  const t = typeof args.text === 'string' ? args.text.toLowerCase() : ''
  return { has: !!t && bodyText().includes(t) }
}

export async function wait(args: { text?: unknown; textGone?: unknown; ms?: unknown }): Promise<{ waited: string }> {
  const gone = typeof args.textGone === 'string' && args.textGone ? args.textGone : undefined
  const want = typeof args.text === 'string' && args.text ? args.text : undefined
  if (want || gone) {
    const until = Date.now() + 30_000
    while (Date.now() < until) {
      if (want && bodyText().includes(want.toLowerCase())) return { waited: `"${want}" is on the page` }
      if (gone && !bodyText().includes(gone.toLowerCase())) return { waited: `"${gone}" is gone from the page` }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new PageError(want ? `"${want}" did not show within 30 s.` : `"${gone}" was still on the page after 30 s.`, 'wait_timeout')
  }
  const ms = typeof args.ms === 'number' ? Math.max(0, Math.min(30_000, args.ms)) : 1000
  await new Promise((r) => setTimeout(r, ms))
  return { waited: `${ms} ms` }
}
