/**
 * Runs in every page and frame. It finds login fields (form-detect.ts), puts the Walnut icon
 * in the one the person is in, opens the menu (an extension page in an iframe: the page cannot
 * read it) under it, fills what the menu or the popup picked, notices a login being sent and
 * shows the save bar. It holds no token and no item: the background sends a username and
 * password only for a fill, and they go straight into the fields.
 *
 * What a page cannot make it do:
 * - fill in a frame on another origin than the top page (a login embedded by another site is
 *   how a page would phish one), or a sandboxed frame;
 * - open the menu by focusing a field from script: it opens by itself only right after the
 *   person clicked or tabbed into the field;
 * - offer to save a password it put in a field itself: only what the person typed (or the one
 *   Walnut made) counts, and only a send the person did (a trusted submit, click or Enter);
 * - restyle the menu and save bar unseen: their hosts carry !important styles (their shadow
 *   roots turn off the host's ::before and ::after), and a change to them, or an element put
 *   after them, closes both. Before a fill or a save the page is checked once more: not faded,
 *   nothing in the top layer over them. The pages inside also refuse clicks while covered
 *   (frame-guard.ts);
 * - read the nonce that ties the menu and save bar to the background: it goes to their frame by
 *   postMessage to the extension's origin, never in a URL the page can see, and a frame the page
 *   navigates (a second load) is closed.
 * On Walnut's own pages (they carry `<meta name="walnut-app">`, a mark that can only turn the
 * extension off) it does nothing but the connect handshake.
 */
import { ext, ask } from './ext'
import { findLoginGroups, groupOfField, readGroup, setValue, type LoginGroup } from './form-detect'

const SELF = (() => {
  try {
    if (window === window.top) return 'top'
    return window.top!.location.origin === location.origin ? 'same-origin-frame' : 'other'
  } catch { return 'other' }
})()
const MAY_FILL = SELF !== 'other' && location.origin !== 'null' && /^https?:$/.test(location.protocol)

/** Off until the background answers, and for good on Walnut's own pages. */
let off = true
const isWalnutApp = () => !!document.querySelector('meta[name="walnut-app"]')
let groups: LoginGroup[] = []
let active: { group: LoginGroup; role: string; field: HTMLInputElement } | null = null

let reported: boolean | null = null
function rescan(): void {
  groups = findLoginGroups(document)
  const hasLogin = groups.length > 0
  if (!off && MAY_FILL && hasLogin !== reported) {
    reported = hasLogin
    void ask({ type: 'frame-ready', hasLogin })
  }
}

// ── hosts with a closed shadow root and !important styles; a change to them closes what they hold ──

interface Host { el: HTMLElement; expected: string }
const hosts = new Set<Host>()

function hostStyle(host: Host, extra: string): void {
  host.el.style.cssText = `all: initial !important; position: fixed !important; display: block !important; opacity: 1 !important; visibility: visible !important; filter: none !important; transform: none !important; clip-path: none !important; mix-blend-mode: normal !important; pointer-events: auto !important; ${extra}`
  host.expected = host.el.style.cssText
}

const closeAll = () => { closeMenu(); hideBar(); hideIcon(true) }
const watcher = new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === 'childList') {
      // Something put after a host paints over it (same z-index, later in the tree).
      const after = [...r.addedNodes].some((n) => n instanceof Element && !(n as HTMLElement).dataset?.walnutHost && [...hosts].some((h) => h.el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING))
      if (after) closeAll()
      continue
    }
    const h = [...hosts].find((x) => x.el === r.target)
    if (h && (r.attributeName !== 'style' || h.el.style.cssText !== h.expected)) closeAll()
  }
})

/** The host's own pseudo-elements, which a page rule could draw over the frame: !important in a shadow root wins. */
const SHADOW_STYLE = ':host::before, :host::after { content: none !important; display: none !important; }'

/**
 * Checked right before a fill or a save: is the page faded or hidden around the host, or
 * does something in the top layer (a popover, a modal dialog, full screen) lie over it?
 */
function tampered(h: Host): boolean {
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue
    const cs = getComputedStyle(el)
    if (Number(cs.opacity) < 1 || cs.visibility !== 'visible' || /opacity|blur|brightness\(0|contrast\(0/.test(cs.filter)) return true
  }
  const r = h.el.getBoundingClientRect()
  for (const sel of [':popover-open', 'dialog:modal', ':fullscreen']) {
    let found: Element[] = []
    try { found = [...document.querySelectorAll(sel)] } catch { continue }
    for (const el of found) {
      const o = el.getBoundingClientRect()
      if (o.right > r.left && o.left < r.right && o.bottom > r.top && o.top < r.bottom) return true
    }
  }
  return false
}

function makeHost(z: number, mark?: 'walnutMenu' | 'walnutSavebar'): { host: Host; root: ShadowRoot } {
  const el = document.createElement('walnut-ext')
  el.dataset.walnutHost = '1'
  if (mark) el.dataset[mark] = '1' // set before the watch starts: a later attribute change is the page's
  const host: Host = { el, expected: '' }
  hostStyle(host, `z-index: ${z} !important; top: 0 !important; left: 0 !important;`)
  const root = el.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = SHADOW_STYLE
  root.appendChild(style)
  document.documentElement.appendChild(el)
  hosts.add(host)
  watcher.observe(el, { attributes: true })
  watcher.observe(document.documentElement, { childList: true })
  return { host, root }
}

function dropHost(h: Host): void {
  hosts.delete(h)
  h.el.remove()
}

/**
 * An extension page in a frame, given its nonce once it has loaded, by postMessage to the
 * extension's own origin. A second load means the page navigated the frame: `onAgain` closes it.
 */
function extFrame(page: string, nonce: string, onAgain: () => void): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  const url = ext.runtime.getURL(page)
  let loads = 0
  frame.addEventListener('load', () => {
    if (++loads > 1) { onAgain(); return }
    frame.contentWindow?.postMessage({ walnutNonce: nonce }, new URL(url).origin)
  })
  frame.src = url
  return frame
}

const ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8a5a2b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/></svg>'

let icon: { host: Host; button: HTMLButtonElement; shown: boolean } | null = null
let menu: { host: Host; frame: HTMLIFrameElement; height: number } | null = null

const px = (n: number) => `${Math.round(n)}px`

function place(h: Host, field: HTMLInputElement, where: 'icon' | 'menu', height = 0): void {
  const r = field.getBoundingClientRect()
  let top: number
  let left: number
  if (where === 'icon') {
    top = r.top + (r.height - 22) / 2
    left = r.right - 26
  } else {
    const w = 320
    const below = r.bottom + 4
    top = below + height > innerHeight && r.top - height - 4 > 0 ? r.top - height - 4 : below
    left = Math.max(4, Math.min(r.left, innerWidth - w - 4))
  }
  hostStyle(h, `z-index: ${where === 'icon' ? 2147483646 : 2147483647} !important; top: ${px(top)} !important; left: ${px(left)} !important;`)
}

function showIcon(field: HTMLInputElement): void {
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
      if (e.isTrusted && active) void openMenu(active.field)
    })
    root.appendChild(button)
    icon = { host, button, shown: true }
  }
  icon.shown = true
  place(icon.host, field, 'icon')
}

function hideIcon(remove = false): void {
  if (!icon) return
  if (remove) { dropHost(icon.host); icon = null; return }
  icon.shown = false
  hostStyle(icon.host, 'display: none !important;')
}

async function openMenu(field: HTMLInputElement): Promise<void> {
  const hit = groupOfField(groups, field)
  if (!hit || off) return
  active = { group: hit.group, role: hit.role, field }
  const r = await ask<{ nonce: string }>({ type: 'open-menu', role: hit.role, kind: hit.group.kind })
  if (!r.ok || !r.nonce) return
  closeMenu()
  const { host, root } = makeHost(2147483647, 'walnutMenu')
  // The nonce ties this frame to the open menu: a page that frames menu.html itself has none.
  const frame = extFrame('menu.html', r.nonce, closeMenu)
  frame.style.cssText = 'all: initial; display: block; width: 320px; height: 120px; border: 0; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.18); background: transparent; color-scheme: normal;'
  frame.setAttribute('allowtransparency', 'true')
  root.appendChild(frame)
  menu = { host, frame, height: 120 }
  place(host, field, 'menu', menu.height)
}

function closeMenu(): void {
  if (menu) { dropHost(menu.host); menu = null }
}

function reposition(): void {
  if (!active) return
  if (!active.field.isConnected) { hideIcon(); closeMenu(); active = null; return }
  if (icon?.shown) place(icon.host, active.field, 'icon')
  if (menu) place(menu.host, active.field, 'menu', menu.height)
}

// ── what the person did: a click or a Tab into a field, typing in a password field ──

let lastPointer: { el: EventTarget | null; at: number } = { el: null, at: 0 }
let lastTab = 0
const typed = new WeakSet<HTMLInputElement>()

document.addEventListener('pointerdown', (e) => {
  if (e.isTrusted) lastPointer = { el: e.target, at: Date.now() }
  const path = e.composedPath()
  if (menu && !path.includes(menu.host.el) && !(active && path.includes(active.field))) closeMenu()
}, true)
document.addEventListener('input', (e) => {
  const t = e.target
  if (!e.isTrusted || !(t instanceof HTMLInputElement)) return
  // Whatever its type now: a "show password" switch makes the field text while the person types.
  typed.add(t)
  // Typing your own value means you are not picking one: the menu goes, and stops covering the form.
  if (menu && active && t === active.field) closeMenu()
}, true)

// ── focus: show the icon, and the menu when there is something to pick ──

/** Set while Walnut fills: the focus moves a fill makes never open the menu again. */
let filling = false
function asFill<T>(work: () => T): T {
  filling = true
  try { return work() } finally { setTimeout(() => { filling = false }, 0) }
}

async function onFocus(e: { target: EventTarget | null }): Promise<void> {
  const t = e.target
  if (off || !MAY_FILL || !(t instanceof HTMLInputElement)) return
  rescan()
  const hit = groupOfField(groups, t)
  if (!hit) return
  active = { group: hit.group, role: hit.role, field: t }
  showIcon(t)
  // Read now, before the await: a fill's focus moves, and whether the person brought focus here.
  const fromFill = filling
  const byPerson = (lastPointer.el === t && Date.now() - lastPointer.at < 1500) || Date.now() - lastTab < 600
  const st = await ask<{ connected: boolean; unlocked: boolean; count: number }>({ type: 'page-init' })
  if (!st.ok || document.activeElement !== t) return
  if (fromFill || !byPerson || t.value) return
  const offerNew = hit.role === 'new-password' && st.connected && st.unlocked
  if (offerNew || (st.unlocked && st.count > 0)) void openMenu(t)
}

// ── fills: only into this frame's own login, and only when this is the origin the fill is for ──

function fill(username: string | undefined, password: string | undefined): boolean {
  rescan()
  const g = active && active.group.root.isConnected ? (groups.find((x) => x.root === active!.group.root) ?? active.group) : groups.find((x) => x.kind === 'login') ?? groups.find((x) => x.kind === 'username-step')
  if (!g) return false
  let did = false
  if (username && g.username) { setValue(g.username, username); did = true }
  if (password && g.password) { setValue(g.password, password); typed.delete(g.password); did = true }
  if (did) (g.password ?? g.username)?.focus()
  return did
}

function fillTotp(code: string): boolean {
  rescan()
  const field = active?.role === 'totp' ? active.field : groups.find((g) => g.totp)?.totp
  if (!field) return false
  setValue(field, code)
  return true
}

function fillNew(password: string): void {
  if (!active) return
  for (const f of active.group.newPasswords) setValue(f, password)
}

const fillsHere = (origin: unknown) => !off && MAY_FILL && origin === location.origin

// ── a login being sent: offer to save or update it ──

const sentAt = new WeakMap<Element, number>()
function sending(g: LoginGroup): void {
  if (off || !MAY_FILL) return
  const last = sentAt.get(g.root) ?? 0
  if (Date.now() - last < 1500) return
  sentAt.set(g.root, Date.now())
  const { username, password } = readGroup(g)
  if (g.kind === 'username-step') { if (username) void ask({ type: 'seen-username', username }); return }
  const fields = g.kind === 'login' ? [g.password] : g.newPasswords
  if (password) void ask({ type: 'seen-login', username, password, typed: fields.some((f) => !!f && typed.has(f)) })
}

function groupFor(el: Element | null): LoginGroup | undefined {
  if (!el) return undefined
  rescan()
  return groups.find((g) => g.kind !== 'totp' && (g.root === el || g.root.contains(el)))
    // A page that hides its form as it sends: the group the person was typing in.
    ?? (active && active.group.kind !== 'totp' && active.group.root.contains(el) ? active.group : undefined)
}

const SEND_WORDS = /log.?in|sign.?in|sign.?up|log on|continue|next|submit|create|register|join|save|change|update|verify/i

/** A button that sends its login: a form's submit button, or (no form) one that says it does. */
function sendsLogin(b: Element): boolean {
  if (b instanceof HTMLInputElement) return b.type === 'submit' || (b.type === 'button' && SEND_WORDS.test(b.value))
  if (b instanceof HTMLButtonElement && b.form && b.type === 'submit') return true
  return SEND_WORDS.test(`${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`)
}

document.addEventListener('submit', (e) => { if (!e.isTrusted) return; const g = groupFor(e.target as Element); if (g) sending(g) }, true)
document.addEventListener('click', (e) => {
  if (!e.isTrusted) return
  const b = (e.target as Element | null)?.closest?.('button, input[type=submit], input[type=button], [role=button]')
  if (!b || !sendsLogin(b)) return
  const g = groupFor(b)
  // Read after the page's own handlers ran, before it navigates.
  if (g) setTimeout(() => sending(g), 0)
}, true)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); return }
  if (!e.isTrusted) return
  if (e.key === 'Tab') { lastTab = Date.now(); return }
  if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return
  const g = groupFor(e.target)
  if (g) sending(g)
}, true)
document.addEventListener('focusin', (e) => { void onFocus(e) }, true)
addEventListener('scroll', reposition, true)
addEventListener('resize', reposition)

// ── the save bar (top frame only) ──

let bar: { host: Host; frame: HTMLIFrameElement; nonce: string } | null = null
function showBar(nonce: string): void {
  if (off || SELF !== 'top' || !nonce) return
  // Asked twice for the same login (the send, then the page it led to): keep the one shown.
  if (bar?.nonce === nonce && bar.host.el.isConnected) return
  hideBar()
  const { host, root } = makeHost(2147483647, 'walnutSavebar')
  hostStyle(host, 'z-index: 2147483647 !important; top: 12px !important; right: 12px !important; left: auto !important;')
  const frame = extFrame('savebar.html', nonce, hideBar)
  frame.style.cssText = 'all: initial; display: block; width: 360px; height: 150px; border: 0; border-radius: 14px; box-shadow: 0 12px 34px rgba(0,0,0,.2); color-scheme: normal;'
  root.appendChild(frame)
  bar = { host, frame, nonce }
}
function hideBar(): void {
  if (bar) { dropHost(bar.host); bar = null }
}

// ── messages from the background ──

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'fill':
      if (!fillsHere(msg.origin)) { sendResponse({ filled: false }); return }
      sendResponse({ filled: asFill(() => msg.mode === 'totp' ? fillTotp(String(msg.totp ?? '')) : fill(msg.username, msg.password)) }); return
    case 'fill-new-password':
      if (fillsHere(msg.origin)) asFill(() => fillNew(String(msg.password ?? '')))
      sendResponse({ ok: true }); return
    case 'close-menu': closeMenu(); sendResponse({ ok: true }); return
    case 'check-shown': {
      const h = msg.which === 'bar' ? bar?.host : menu?.host
      const ok = !!h && h.el.isConnected && !tampered(h)
      if (!ok) closeAll()
      sendResponse({ ok }); return
    }
    case 'menu-size':
      if (menu) { menu.height = Math.min(420, Math.max(60, Number(msg.height) || 120)); menu.frame.style.height = `${menu.height}px`; reposition() }
      sendResponse({ ok: true }); return
    case 'show-savebar': showBar(String(msg.nonce ?? '')); sendResponse({ ok: true }); return
    case 'hide-savebar': hideBar(); sendResponse({ ok: true }); return
    case 'savebar-size':
      if (bar) bar.frame.style.height = `${Math.min(300, Math.max(80, Number(msg.height) || 150))}px`
      sendResponse({ ok: true }); return
    case 'open-menu-here': {
      if (off || SELF !== 'top' || !MAY_FILL) { sendResponse({ ok: false }); return }
      rescan()
      const focused = document.activeElement instanceof HTMLInputElement && groupOfField(groups, document.activeElement) ? document.activeElement : undefined
      const g = groups.find((x) => x.kind === 'login' || x.kind === 'username-step')
      const field = focused ?? g?.username ?? g?.password
      if (field) { field.focus(); void openMenu(field) }
      sendResponse({ ok: !!field }); return
    }
  }
})

// ── connecting: the Walnut page asks the extension to take its code ──

if (SELF === 'top') {
  addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return
    const d = e.data as { source?: string; type?: string; code?: string } | null
    if (!d || d.source !== 'walnut-connect-page') return
    void (async () => {
      if (d.type === 'hello') {
        const r = await ask<{ connected?: boolean; version?: string }>({ type: 'connect-hello' })
        if (r.ok) postMessage({ source: 'walnut-extension', type: 'present', connected: !!r.connected, version: r.version }, location.origin)
      } else if (d.type === 'code' && typeof d.code === 'string') {
        const r = await ask<{ device?: string; silent?: boolean }>({ type: 'connect-code', code: d.code })
        if (r.silent) return
        postMessage({ source: 'walnut-extension', type: r.ok ? 'connected' : 'error', ...(r.ok ? { device: r.device } : { message: r.error }) }, location.origin)
      }
    })()
  })
}

// ── start ──

function start(): void {
  if (isWalnutApp()) return
  void ask<{ off?: boolean; barNonce?: string }>({ type: 'page-init', top: SELF === 'top' }).then((r) => {
    if (!r.ok || r.off) return
    off = false
    reported = null
    rescan()
    if (r.barNonce) showBar(r.barNonce)
    // The person clicked into a field while this was still starting: act on that focus now.
    if (document.activeElement instanceof HTMLInputElement) void onFocus({ target: document.activeElement })
  })
}
start()
// Back from the back/forward cache: no script runs again, so this page registers its frame anew.
addEventListener('pageshow', (e) => { if (e.persisted) start() })
let pending = 0
new MutationObserver(() => {
  if (pending || off) return
  pending = window.setTimeout(() => { pending = 0; rescan(); reposition() }, 400)
}).observe(document.documentElement, { childList: true, subtree: true })
