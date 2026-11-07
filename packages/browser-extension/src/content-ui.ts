/**
 * The Walnut icon in the field the person is in, the menu under it (an extension page in an
 * iframe: the page cannot read it), the keys that work it, and a short toast.
 *
 * Keys, as in Bitwarden and 1Password: ArrowDown in the field opens the menu, or moves into it
 * when it is open (ArrowUp moves to its last row); inside it ArrowUp / ArrowDown pick a row and
 * Enter fills; Escape and Tab close it and give the field its focus back. The move into the menu
 * goes through the background (menu-focus), so a page cannot send the person's keys there. An
 * Enter typed right after that ArrowDown, before the menu loaded, is the menu's (`pick`), never
 * the page form's.
 *
 * Where it is drawn: under the field whenever it fits there (over the form's send button too, until
 * the person picks), above it only when it does not; always inside this frame's own viewport, so a
 * frame never cuts it (content-place.ts).
 */
import { ask } from './ext'
import { groupOfField } from './form-detect'
import { readRules } from './field-rules'
import { walletGroupOf } from './wallet-detect'
import { cs } from './content-state'
import { dropHost, extFrame, hostStyle, makeHost, type Host } from './content-host'
import { menuSpot } from './content-place'

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8a5a2b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/></svg>'
const MENU_WIDTH = 320

let icon: { host: Host; button: HTMLButtonElement; shown: boolean } | null = null
export let menu: {
  host: Host; frame: HTMLIFrameElement; height: number; loaded: boolean; focus?: 'first' | 'last'
  /** Enter came with the arrow key, before the menu loaded: it picks the first row once there. */
  pick?: boolean
  /** Arrow keys typed in the field after the one that asked for the menu, before the keys were handed to it. */
  steps?: number
  /** When the keys were handed to the menu: keys typed in the field just after are still the menu's. */
  handedAt?: number
  /** The hand-over and the keys after it go to the menu one after another, in the order typed. */
  chain?: Promise<unknown>
  /** Nothing in it fits what the person typed: drawn nowhere until something does. */
  hidden?: boolean
  /** What the person typed in the field: the menu shows only the logins that fit it. */
  filter?: string
} | null = null

const px = (n: number) => `${Math.round(n)}px`

/** The menu's width: its usual 320 px, or this frame's width when that is narrower (L7: even under 208 px). */
const menuWidth = () => Math.min(MENU_WIDTH, Math.max(100, innerWidth - 8))

function place(h: Host, field: HTMLInputElement, where: 'icon' | 'menu', height = 0): void {
  const r = field.getBoundingClientRect()
  if (where === 'icon') {
    // A code asked one digit per box, or any field too narrow to hold it: the icon goes after the
    // field (after the last box), never over what the person types in or clicks.
    const boxes = cs.active?.group?.totpBoxes
    const last = boxes?.includes(field) ? boxes[boxes.length - 1].getBoundingClientRect() : null
    const at = last ?? r
    const outside = !!last || r.width < 80
    hostStyle(h, `z-index: 2147483646 !important; top: ${px(at.top + (at.height - 22) / 2)} !important; left: ${px(outside ? at.right + 6 : at.right - 26)} !important;`)
    return
  }
  const width = menuWidth()
  const spot = menuSpot(r, height, width, { w: innerWidth, h: innerHeight })
  hostStyle(h, `z-index: 2147483647 !important; top: ${px(spot.top)} !important; left: ${px(spot.left)} !important;${menu?.hidden ? ' display: none !important;' : ''}`)
  if (menu && menu.host === h) {
    menu.frame.style.width = `${width}px`
    menu.frame.style.height = `${Math.round(spot.height)}px`
  }
}

export function showIcon(field: HTMLInputElement): void {
  if (!icon) {
    const { host, root } = makeHost(2147483646)
    const button = document.createElement('button')
    button.type = 'button'
    button.title = 'Walnut'
    button.setAttribute('aria-label', 'Fill with Walnut')
    button.append(document.importNode(new DOMParser().parseFromString(ICON_SVG, 'image/svg+xml').documentElement, true))
    button.style.cssText = 'all: initial; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; cursor: pointer; background: #fff8ef; box-shadow: 0 0 0 1px rgba(138,90,43,.35);'
    // Keep the field focused: the click opens the menu, it does not blur the login.
    button.addEventListener('mousedown', (e) => e.preventDefault())
    button.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      // The person asks for the menu: every login, whatever was typed in the field.
      if (e.isTrusted && cs.active) void openMenu(cs.active.field, undefined, true)
    })
    root.appendChild(button)
    icon = { host, button, shown: true }
  }
  icon.shown = true
  place(icon.host, field, 'icon')
}

export function hideIcon(remove = false): void {
  if (!icon) return
  if (remove) { dropHost(icon.host); icon = null; return }
  icon.shown = false
  hostStyle(icon.host, 'display: none !important;')
}

/** The role and kind the menu shows for a field: a login part, or a card or address form. */
export function roleOf(field: HTMLInputElement): { role: string; kind: string } | null {
  const hit = groupOfField(cs.groups, field)
  if (hit) return { role: hit.role, kind: hit.group.kind }
  const w = walletGroupOf(cs.wallets, field)
  return w ? { role: w.kind, kind: w.kind } : null
}

/**
 * The open on its way (the background answers it): one per field. A second open of the same
 * field meanwhile (the focus offering the menu while an arrow key asks for it, 2026-11-04: the
 * two answers raced and the later menu, drawn without the keyboard, replaced the one with it)
 * joins it, and an arrow key's wish to move into the menu rides along.
 */
let opening: { field: HTMLInputElement; focus?: 'first' | 'last'; pick?: boolean; steps?: number } | null = null

/** An open of this field is on its way (the focus handler leaves the menu to it). */
export const openingFor = (field: HTMLInputElement) => opening?.field === field

export async function openMenu(field: HTMLInputElement, focus?: 'first' | 'last', all = false): Promise<void> {
  const what = roleOf(field)
  if (!what || cs.off) return
  if (opening?.field === field) {
    // A second ArrowDown while the menu is on its way is one row further, never lost (round 4).
    if (focus && opening.focus) opening.steps = (opening.steps ?? 0) + 1
    else if (focus) opening.focus = focus
    return
  }
  const mine: { field: HTMLInputElement; focus?: 'first' | 'last'; pick?: boolean; steps?: number } = { field, ...(focus ? { focus } : {}) }
  opening = mine
  const hit = groupOfField(cs.groups, field)
  cs.active = { ...(hit ? { group: hit.group } : { wallet: walletGroupOf(cs.wallets, field) ?? undefined }), role: what.role, field }
  // A new-password field says what it accepts: the strong password Walnut makes fits it.
  const rules = what.role === 'new-password' ? readRules(hit?.group.newPasswords[0] ?? field) : undefined
  // The account the page names for this form (a change form's hidden username, a username it
  // filled in): the menu lists that login first. One the person typed in this field filters the menu instead.
  const g = hit?.group
  const named = g && !(g.username === field && cs.typed.has(field)) ? (g.username?.value.trim() || g.hiddenUsername?.value.trim() || '') : ''
  let r: { ok: boolean; nonce?: string }
  try {
    r = await ask<{ nonce: string }>({ type: 'open-menu', role: what.role, kind: what.kind, ...(rules ? { rules } : {}), ...(named ? { account: named } : {}) })
  } finally {
    if (opening === mine) opening = null
  }
  // Another field's open started meanwhile: that menu is the one to show.
  if (opening) return
  if (!r.ok || !r.nonce) return
  const keys = mine.focus
  closeMenu()
  const { host, root } = makeHost(2147483647, 'walnutMenu')
  // The nonce ties this frame to the open menu: a page that frames menu.html itself has none.
  const frame = extFrame('menu.html', r.nonce, closeMenu, () => {
    if (!menu || menu.frame !== frame) return
    menu.loaded = true
    if (menu.filter !== undefined) sendFilter(menu.filter)
    if (menu.focus) focusMenu(menu.focus)
  })
  frame.style.cssText = `all: initial; display: block; width: ${menuWidth()}px; height: 120px; border: 0; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.18); background: transparent; color-scheme: light dark;`
  frame.setAttribute('allowtransparency', 'true')
  // A code copied after a fill is written by the menu itself where the background cannot.
  frame.allow = 'clipboard-write'
  frame.title = 'Walnut'
  root.appendChild(frame)
  // Typed before the menu came (it reopened as the person typed): it shows what fits.
  const typed = !all && what.role === 'username' && field.value && cs.typed.has(field) ? field.value : undefined
  menu = { host, frame, height: 120, loaded: false, ...(keys ? { focus: keys } : {}), ...(mine.pick ? { pick: true } : {}), ...(mine.steps ? { steps: mine.steps } : {}), ...(typed !== undefined ? { filter: typed } : {}) }
  place(host, field, 'menu', menu.height)
}

/**
 * How long after the keys were handed to the menu a key typed in the field is still the menu's: the
 * browser moves the keyboard into the menu's frame a moment after it is focused, and a second
 * ArrowDown (or the Enter) typed at once still lands in the field (round 4: under load, "ArrowDown
 * twice and Enter" filled the first login, the second arrow having handed the keys over again).
 */
const KEYS_ON_THE_WAY_MS = 1000

/** To the menu, after what was sent to it before (through the background, so a page cannot). */
function toMenu(m: { type: string; [k: string]: unknown }): void {
  if (!menu) return
  menu.chain = (menu.chain ?? Promise.resolve()).then(() => ask(m)).catch(() => undefined)
}

/** Move the keyboard into the open menu, on its first or last row (and the rows typed past it). */
function focusMenu(where: 'first' | 'last'): void {
  if (!menu || menu.hidden) return
  if (!menu.loaded) { menu.focus = where; return }
  const pick = menu.pick === true
  const steps = menu.steps ?? 0
  menu.focus = undefined
  menu.pick = undefined
  menu.steps = undefined
  menu.frame.focus()
  menu.handedAt = performance.now()
  toMenu({ type: 'menu-focus', where, ...(pick ? { pick: true } : {}), ...(steps ? { step: steps } : {}) })
}

/**
 * The keys were handed to the menu a moment ago: a key typed now in the field, or one the page got
 * for the menu's frame before the browser moved the keyboard into it (its target is the menu's
 * host), is still the menu's.
 */
const keysOnTheWay = (t: EventTarget | null) => !!menu && !menu.hidden && menu.loaded && !!cs.active
  && (t === cs.active.field || t === menu.host.el)
  && menu.handedAt !== undefined && performance.now() - menu.handedAt < KEYS_ON_THE_WAY_MS

export function closeMenu(refocus = false): void {
  if (!menu) return
  const hadFocus = document.activeElement === menu.host.el
  const host = menu.host
  menu = null
  // Escape or Tab in the menu: back to the field (before its frame goes, so this page keeps the
  // keyboard), which does not open the menu again by itself.
  if ((refocus || hadFocus) && cs.active?.field.isConnected) cs.active.field.focus({ preventScroll: true })
  dropHost(host)
}

/** The height the menu needs; 0 when nothing in it fits what was typed (it is drawn nowhere then). */
export function setMenuHeight(height: number): void {
  if (!menu) return
  const hide = Number.isFinite(height) && height <= 0
  if (hide !== !!menu.hidden) {
    menu.hidden = hide
    // A hidden menu holds no keys: they go back to the field.
    if (hide && document.activeElement === menu.host.el) cs.active?.field.focus({ preventScroll: true })
  }
  if (!hide) menu.height = Math.min(420, Math.max(60, height || 120))
  reposition()
}

/** What the person typed in the field, for the menu to show only the logins that fit it. */
function sendFilter(text: string): void {
  if (!menu?.loaded) return
  // The extension's own origin only; the most a page could do with a filter of its own is hide rows.
  menu.frame.contentWindow?.postMessage({ walnutFilter: text.slice(0, 200) }, new URL(menu.frame.src).origin)
}

/**
 * The person typed in the field the menu is for: a username narrows the menu to the logins that
 * fit; anything else (a password, a code, a card number) means they are not picking one, and the
 * menu goes. Returns whether the menu is still there.
 */
export function typedInField(field: HTMLInputElement): boolean {
  if (!menu || cs.active?.field !== field) return false
  if (cs.active.role !== 'username') { closeMenu(); return false }
  menu.filter = field.value
  sendFilter(field.value)
  return true
}

export function reposition(): void {
  const a = cs.active
  if (!a) return
  if (!a.field.isConnected) { hideIcon(); closeMenu(); cs.active = null; return }
  if (icon?.shown) place(icon.host, a.field, 'icon')
  if (menu) place(menu.host, a.field, 'menu', menu.height)
}

/** A trusted key in a page field: true when Walnut used it (the page never sees it then). */
export function onFieldKey(e: KeyboardEvent): boolean {
  if (!e.isTrusted || cs.off || e.altKey || e.ctrlKey || e.metaKey) return false
  const t = e.target
  if (!(t instanceof HTMLInputElement)) {
    // A key for the menu's frame that reached the page while the keyboard was on its way there.
    if (!keysOnTheWay(t) || !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key) || e.shiftKey) return false
    toMenu(e.key === 'Enter' ? { type: 'menu-focus', more: true, pick: true } : { type: 'menu-focus', more: true, step: e.key === 'ArrowUp' ? -1 : 1 })
    e.preventDefault()
    e.stopPropagation()
    return true
  }
  if (e.key === 'Tab' || e.key === 'Escape') { if (menu) closeMenu(); return false }
  if (e.key === 'Enter' && !e.shiftKey) {
    // ArrowDown, then Enter before the menu could take the keys: the Enter is for the menu (it
    // picks the first login once it is there), not for the page's form, which would go out empty.
    if (opening?.field === t && opening.focus) opening.pick = true
    else if (menu && !menu.loaded && menu.focus && cs.active?.field === t) menu.pick = true
    else if (keysOnTheWay(t)) toMenu({ type: 'menu-focus', more: true, pick: true })
    else return false
    e.preventDefault()
    e.stopPropagation()
    return true
  }
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.shiftKey || !roleOf(t)) return false
  const step = e.key === 'ArrowUp' ? -1 : 1
  // Typed after the arrow that asked for the menu, before its keys were handed over: a row further.
  if (menu && !menu.hidden && !menu.loaded && menu.focus && cs.active?.field === t) menu.steps = (menu.steps ?? 0) + step
  else if (keysOnTheWay(t)) toMenu({ type: 'menu-focus', more: true, step })
  else if (menu && !menu.hidden && cs.active?.field === t) focusMenu(step < 0 ? 'last' : 'first')
  else if (e.key === 'ArrowDown' && !menu?.hidden && cs.pageFill) void openMenu(t, 'first')
  else return false
  e.preventDefault()
  e.stopPropagation()
  return true
}

/** Focus moved somewhere else on the page (not into the menu): the menu of the old field goes. */
export function focusMoved(target: EventTarget | null): void {
  if (menu && target !== menu.host.el && target !== cs.active?.field) closeMenu()
}

// ── a short note at the bottom of the page ("Code copied") ──

let toastHost: Host | null = null
let toastTimer = 0
export function toast(text: string, ms = 2400): void {
  if (toastHost) dropHost(toastHost)
  const { host, root } = makeHost(2147483646)
  hostStyle(host, 'z-index: 2147483646 !important; bottom: 24px !important; left: 50% !important; top: auto !important; transform: translateX(-50%) !important; pointer-events: none !important;')
  const el = document.createElement('div')
  el.setAttribute('role', 'status')
  el.textContent = text
  el.style.cssText = 'all: initial; display: block; box-sizing: border-box; max-width: min(460px, calc(100vw - 32px)); padding: 8px 14px; border-radius: 10px; background: #2b2118; color: #fff; text-align: center; font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.25);'
  root.appendChild(el)
  toastHost = host
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { if (toastHost === host) { dropHost(host); toastHost = null } }, ms)
}
