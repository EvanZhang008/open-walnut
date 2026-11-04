/**
 * The Walnut icon in the field the person is in, the menu under it (an extension page in an
 * iframe: the page cannot read it), the keys that work it, and a short toast.
 *
 * Keys, as in Bitwarden and 1Password: ArrowDown in the field opens the menu, or moves into it
 * when it is open (ArrowUp moves to its last row); inside it ArrowUp / ArrowDown pick a row and
 * Enter fills; Escape and Tab close it and give the field its focus back. The move into the menu
 * goes through the background (menu-focus), so a page cannot send the person's keys there.
 */
import { ask } from './ext'
import { groupOfField } from './form-detect'
import { readRules } from './field-rules'
import { walletGroupOf } from './wallet-detect'
import { cs } from './content-state'
import { dropHost, extFrame, hostStyle, makeHost, type Host } from './content-host'

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8a5a2b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/></svg>'
const MENU_WIDTH = 320

let icon: { host: Host; button: HTMLButtonElement; shown: boolean } | null = null
export let menu: { host: Host; frame: HTMLIFrameElement; height: number; loaded: boolean; focus?: 'first' | 'last' } | null = null

const px = (n: number) => `${Math.round(n)}px`

function place(h: Host, field: HTMLInputElement, where: 'icon' | 'menu', height = 0): void {
  const r = field.getBoundingClientRect()
  let top: number
  let left: number
  if (where === 'icon') {
    top = r.top + (r.height - 22) / 2
    left = r.right - 26
  } else {
    const below = r.bottom + 4
    top = below + height > innerHeight && r.top - height - 4 > 0 ? r.top - height - 4 : below
    left = Math.max(4, Math.min(r.left, innerWidth - MENU_WIDTH - 4))
  }
  hostStyle(h, `z-index: ${where === 'icon' ? 2147483646 : 2147483647} !important; top: ${px(top)} !important; left: ${px(left)} !important;`)
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
      if (e.isTrusted && cs.active) void openMenu(cs.active.field)
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
let opening: { field: HTMLInputElement; focus?: 'first' | 'last' } | null = null

/** An open of this field is on its way (the focus handler leaves the menu to it). */
export const openingFor = (field: HTMLInputElement) => opening?.field === field

export async function openMenu(field: HTMLInputElement, focus?: 'first' | 'last'): Promise<void> {
  const what = roleOf(field)
  if (!what || cs.off) return
  if (opening?.field === field) { if (focus) opening.focus = focus; return }
  const mine: { field: HTMLInputElement; focus?: 'first' | 'last' } = { field, ...(focus ? { focus } : {}) }
  opening = mine
  const hit = groupOfField(cs.groups, field)
  cs.active = { ...(hit ? { group: hit.group } : { wallet: walletGroupOf(cs.wallets, field) ?? undefined }), role: what.role, field }
  // A new-password field says what it accepts: the strong password Walnut makes fits it.
  const rules = what.role === 'new-password' ? readRules(hit?.group.newPasswords[0] ?? field) : undefined
  let r: { ok: boolean; nonce?: string }
  try {
    r = await ask<{ nonce: string }>({ type: 'open-menu', role: what.role, kind: what.kind, ...(rules ? { rules } : {}) })
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
    if (menu.focus) focusMenu(menu.focus)
  })
  frame.style.cssText = `all: initial; display: block; width: ${MENU_WIDTH}px; height: 120px; border: 0; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.18); background: transparent; color-scheme: normal;`
  frame.setAttribute('allowtransparency', 'true')
  // A code copied after a fill is written by the menu itself where the background cannot.
  frame.allow = 'clipboard-write'
  frame.title = 'Walnut'
  root.appendChild(frame)
  menu = { host, frame, height: 120, loaded: false, ...(keys ? { focus: keys } : {}) }
  place(host, field, 'menu', menu.height)
}

/** Move the keyboard into the open menu, on its first or last row. */
function focusMenu(where: 'first' | 'last'): void {
  if (!menu) return
  if (!menu.loaded) { menu.focus = where; return }
  menu.focus = undefined
  menu.frame.focus()
  void ask({ type: 'menu-focus', where })
}

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

export function setMenuHeight(height: number): void {
  if (!menu) return
  menu.height = Math.min(420, Math.max(60, height || 120))
  menu.frame.style.height = `${menu.height}px`
  reposition()
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
  if (!(t instanceof HTMLInputElement)) return false
  if (e.key === 'Tab' || e.key === 'Escape') { if (menu) closeMenu(); return false }
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.shiftKey || !roleOf(t)) return false
  if (menu && cs.active?.field === t) focusMenu(e.key === 'ArrowUp' ? 'last' : 'first')
  else if (e.key === 'ArrowDown') void openMenu(t, 'first')
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
export function toast(text: string): void {
  if (toastHost) dropHost(toastHost)
  const { host, root } = makeHost(2147483646)
  hostStyle(host, 'z-index: 2147483646 !important; bottom: 24px !important; left: 50% !important; top: auto !important; transform: translateX(-50%) !important; pointer-events: none !important;')
  const el = document.createElement('div')
  el.setAttribute('role', 'status')
  el.textContent = text
  el.style.cssText = 'all: initial; display: block; padding: 8px 14px; border-radius: 10px; background: #2b2118; color: #fff; font: 600 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.25);'
  root.appendChild(el)
  toastHost = host
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { if (toastHost === host) { dropHost(host); toastHost = null } }, 2400)
}
