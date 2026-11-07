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
 * extension off) it does nothing but the connect handshake and handing the page its browser key
 * while the extension is unlocked (page-browser-key.ts).
 */
import { ext, ask } from './ext'
import { findLoginGroups, groupOfField, readGroup, type LoginGroup } from './form-detect'
import { findWalletGroups, walletGroupOf } from './wallet-detect'
import { MAY_FILL, SELF, asFill, cs } from './content-state'
import { dropHost, extFrame, hostHooks, hostStyle, hosts, makeHost, tampered, type Host } from './content-host'
import { closeMenu, focusMoved, hideIcon, menu, onFieldKey, openingFor, openMenu, reposition, roleOf, setMenuHeight, showIcon, toast, typedInField } from './content-ui'
import { fillCode, fillLogin, fillNewPassword, fillWalletForm } from './content-fill'
import * as pageAgent from './page-agent'
import { runPageOp } from './page-ops'
import { walnutAddress } from './walnut-address'
import { siteKey } from '../../../src/core/vault/url-match'
import { initPageBrowserKey } from './page-browser-key'

/**
 * This copy still talks to a running extension. One left behind by an update or a reload keeps
 * running in the page with no extension behind it: it hides what it drew, and the build's
 * wrapper lets a new copy start beside it (scripts/build-extension.mjs).
 */
const live = (): boolean => { try { return !!ext.runtime?.id } catch { return false } }
;(globalThis as { __walnutContentLive?: () => boolean }).__walnutContentLive = live
// What a copy left behind drew (its icon, menu, save bar, the agent frame) goes: this copy draws its own.
for (const el of document.querySelectorAll('walnut-ext')) el.remove()

const isWalnutApp = () => !!document.querySelector('meta[name="walnut-app"]')
/** This document's id, made once in the extension's own world (the page can neither read nor change it): a new load is a new id. */
const DOC_ID = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')

let reported: boolean | null = null
function rescan(): void {
  pageAgent.notePasswords()
  cs.groups = findLoginGroups(document)
  cs.wallets = findWalletGroups(document)
  const hasLogin = cs.groups.length > 0
  if (!cs.off && MAY_FILL && hasLogin !== reported) {
    reported = hasLogin
    void ask({ type: 'frame-ready', hasLogin })
  }
}

// ── hosts with a closed shadow root and !important styles; a change to them closes what they hold ──

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
    // The agent frame is put back as it was (it must stay in sight while the tab is an agent's).
    if (h && h === agentMark) { if (h.el.style.cssText !== h.expected) h.el.style.cssText = h.expected; for (const a of [...h.el.attributes]) if (a.name !== 'style' && a.name !== 'data-walnut-host') h.el.removeAttribute(a.name); continue }
    if (h && (r.attributeName !== 'style' || h.el.style.cssText !== h.expected)) closeAll()
  }
})

// Each host Walnut draws is watched: a change to it, or something put after it, closes them all.
hostHooks.made = (h) => {
  watcher.observe(h.el, { attributes: true })
  watcher.observe(document.documentElement, { childList: true })
}

// ── what the person did: a click or a Tab into a field, typing in a password field ──

let lastPointer: { el: EventTarget | null; at: number } = { el: null, at: 0 }
let lastTab = 0

/** The last press landed on the field that already had the focus (so no focus event follows). */
let clickOnFocused = false
document.addEventListener('pointerdown', (e) => {
  if (e.isTrusted) lastPointer = { el: e.target, at: Date.now() }
  clickOnFocused = e.target === document.activeElement
  const path = e.composedPath()
  if (menu && !path.includes(menu.host.el) && !(cs.active && path.includes(cs.active.field))) closeMenu()
}, true)
document.addEventListener('input', (e) => {
  const t = e.target
  if (!e.isTrusted || !(t instanceof HTMLInputElement)) return
  // Whatever its type now: a "show password" switch makes the field text while the person types.
  cs.typed.add(t)
  // A username narrows the menu to the logins that fit; typing anything else closes it (the
  // person is not picking one). Closed before (Escape), typing a username opens it again.
  if (!typedInField(t) && !menu && cs.active?.field === t && cs.active.role === 'username') void reopenTyping(t)
}, true)

/** The menu again for a username the person is typing, when this site has logins to offer. */
async function reopenTyping(t: HTMLInputElement): Promise<void> {
  if (cs.off || !cs.pageFill || !MAY_FILL || openingFor(t) || !t.value) return
  const st = await ask<PageState>({ type: 'page-init' })
  if (!st.ok || !st.connected || !st.unlocked || (st.count ?? 0) === 0) return
  if (menu || document.activeElement !== t || openingFor(t)) return
  await openMenu(t)
}

// ── focus: show the icon, and the menu when there is something to pick ──

/** What the background says of this page: counts of what may be offered here. */
interface PageState { connected: boolean; unlocked: boolean; count: number; codes?: number; cards?: number; identities?: number; offerCode?: boolean }

// A click into the field that already had the focus (after Escape, say) opens the menu again.
document.addEventListener('click', (e) => {
  const t = e.target
  if (e.isTrusted && !menu && t instanceof HTMLInputElement && t === document.activeElement && clickOnFocused) void onFocus({ target: t })
}, true)

async function onFocus(e: { target: EventTarget | null }): Promise<void> {
  const t = e.target
  // The focus moves a fill makes are Walnut's own: the menu that asked for the fill stays until it is done.
  if (!cs.filling) focusMoved(t)
  if (cs.off || !MAY_FILL || !(t instanceof HTMLInputElement)) return
  if (!live()) { cs.off = true; closeAll(); return }
  rescan()
  const what = roleOf(t)
  if (!what) return
  const hit = groupOfField(cs.groups, t)
  cs.active = hit ? { group: hit.group, role: hit.role, field: t } : { wallet: walletGroupOf(cs.wallets, t) ?? undefined, role: what.role, field: t }
  // Filling on pages is off (another password manager fills here): the field the person is in
  // is kept for a fill they ask for, and Walnut draws nothing in the page.
  if (!cs.pageFill) return
  showIcon(t)
  // Read now, before the await: a fill's focus moves, and whether the person brought focus here.
  const fromFill = cs.filling
  const byPerson = (lastPointer.el === t && Date.now() - lastPointer.at < 1500) || Date.now() - lastTab < 600
  const st = await ask<PageState>({ type: 'page-init' })
  if (!st.ok || document.activeElement !== t) return
  if (fromFill || !byPerson || t.value) return
  if (!st.connected || !st.unlocked) return
  // Already open for this field, or on its way (an arrow key opened it meanwhile).
  if ((menu && cs.active?.field === t) || openingFor(t)) return
  // Something to pick for this field: a login, a code, a card, an address, or a new password to make.
  const offer = what.role === 'new-password' ? true
    : what.role === 'totp' ? (st.codes ?? 0) > 0
      : what.role === 'card' ? (st.cards ?? 0) > 0
        : what.role === 'identity' ? (st.identities ?? 0) > 0
          : st.count > 0
  if (offer) void openMenu(t)
}

/**
 * The code page right after a sign in Walnut knows (a login with a one-time code, filled or sent
 * here minutes ago): the code field shows the Walnut icon, and the menu opens once the person is
 * in the field (or the page put the focus there), never by itself over the page's Verify button.
 */
let codeOffered = false
let offerCode = false
function maybeOfferCode(): void {
  if (!offerCode || codeOffered || cs.off || !cs.pageFill || !MAY_FILL) return
  const g = cs.groups.find((x) => x.kind === 'totp' && x.totp)
  if (!g?.totp || g.totp.value) return
  if (document.activeElement === g.totp || g.totpBoxes?.includes(document.activeElement as HTMLInputElement)) {
    codeOffered = true
    // Already open for it (the person's click opened it): once is enough.
    const f = document.activeElement as HTMLInputElement
    if (!(menu && cs.active?.field === f) && !openingFor(f)) void openMenu(f)
    return
  }
  if (!cs.active) { cs.active = { group: g, role: 'totp', field: g.totp }; showIcon(g.totp) }
}

// ── fills: only into this frame's own login, and only when this is the origin the fill is for ──

const fillsHere = (origin: unknown) => !cs.off && MAY_FILL && origin === location.origin

// ── a login being sent: offer to save or update it ──

const sentAt = new WeakMap<Element, number>()
function sending(g: LoginGroup): void {
  // Off, a sent login is not even noted: no save or update bar can come of it.
  if (cs.off || !cs.pageFill || !MAY_FILL) return
  const last = sentAt.get(g.root) ?? 0
  if (Date.now() - last < 1500) return
  sentAt.set(g.root, Date.now())
  const { username, password, current } = readGroup(g)
  if (g.kind === 'username-step') { if (username) void ask({ type: 'seen-username', username }); return }
  const fields = g.kind === 'login' ? [g.password] : g.newPasswords
  const siteName = siteNameOf()
  if (password) void ask({ type: 'seen-login', username, password, typed: fields.some((f) => !!f && cs.typed.has(f)), ...(current ? { current } : {}), ...(siteName ? { siteName } : {}) })
}

/** The name the site gives itself, for a new login's default name. */
function siteNameOf(): string {
  const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content?.trim() ?? ''
  return (meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]')).slice(0, 200)
}

function groupFor(el: Element | null): LoginGroup | undefined {
  if (!el) return undefined
  rescan()
  const a = cs.active?.group
  return cs.groups.find((g) => g.kind !== 'totp' && (g.root === el || g.root.contains(el)))
    // A page that hides its form as it sends: the group the person was typing in.
    ?? (a && a.kind !== 'totp' && a.root.contains(el) ? a : undefined)
}

const SEND_WORDS = /log.?in|sign.?in|sign.?up|log on|continue|next|submit|create|register|join|save|change|update|verify/i

/** A button that sends its login: a form's submit button, or (no form) one that says it does. */
function sendsLogin(b: Element): boolean {
  if (b instanceof HTMLInputElement) return b.type === 'submit' || (b.type === 'button' && SEND_WORDS.test(b.value))
  if (b instanceof HTMLButtonElement && b.form && b.type === 'submit') return true
  return SEND_WORDS.test(`${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`)
}

// When the last trusted submit and the last `invalid` (a field the browser's own checks refused) came,
// on performance.now()'s clock: a send attempt reads them to tell a send the browser stopped (R1-14).
let submitAt = -1
let lastInvalid: { at: number; field: Element } | null = null
document.addEventListener('submit', (e) => {
  // The form is going: the menu over it goes too.
  closeMenu()
  if (!e.isTrusted) return
  submitAt = performance.now()
  const g = groupFor(e.target as Element)
  if (g) sending(g)
}, true)
// A send the page's own checks stopped (an email without @): the browser's message shows there, not under the menu.
document.addEventListener('invalid', (e) => {
  if (e.target instanceof Element) lastInvalid = { at: performance.now(), field: e.target }
  closeMenu()
}, true)

/** The page asked for something (fetch, XHR, a beacon) since `t0`: a login sent by script. */
function requestedSince(t0: number): boolean {
  try {
    return performance.getEntriesByType('resource').some((r) => r.startTime >= t0 && /^(fetch|xmlhttprequest|beacon|other)$/.test((r as PerformanceResourceTiming).initiatorType))
  } catch { return true } // unknown: offer the save
}

/** How long a send the browser held back waits for the page to send the login some other way. */
const HELD_SEND_WAIT_MS = 700

/**
 * A click or Enter that may send `g`, read once the page's handlers ran. The one case that offers no
 * save is a send the browser itself stopped: an `invalid` fired for this form since, no submit went,
 * and the page then neither left nor asked the network for anything (review R1-14). Anything less
 * sure offers the save, since a missed save loses a real login and a stray bar is only closed.
 */
function sendAttempt(g: LoginGroup, el: Element): void {
  const t0 = performance.now()
  setTimeout(() => {
    const inv = lastInvalid && lastInvalid.at >= t0 ? lastInvalid.field : null
    const form = (el as HTMLInputElement).form ?? el.closest('form')
    const stopped = !!inv && submitAt < t0 && (g.root.contains(inv) || (!!form && (inv as HTMLInputElement).form === form))
    if (!stopped) { sending(g); return }
    let settled = false
    const left = () => { if (!settled) { settled = true; sending(g) } }
    addEventListener('pagehide', left, { once: true })
    setTimeout(() => {
      removeEventListener('pagehide', left)
      if (settled) return
      settled = true
      if (submitAt >= t0 || requestedSince(t0)) sending(g)
    }, HELD_SEND_WAIT_MS)
  }, 0)
}
// The field lost the focus to nothing Walnut drew (a page script blurred it, the person clicked
// away): the menu goes, so it never stays over the page's own buttons.
document.addEventListener('focusout', (e) => {
  if (!menu || e.target !== cs.active?.field || cs.filling) return
  setTimeout(() => {
    const now = document.activeElement
    if (menu && !cs.filling && document.hasFocus() && now !== menu.host.el && now !== cs.active?.field) closeMenu()
  }, 0)
}, true)
document.addEventListener('click', (e) => {
  if (!e.isTrusted) return
  const b = (e.target as Element | null)?.closest?.('button, input[type=submit], input[type=button], [role=button]')
  if (!b || !sendsLogin(b)) return
  const g = groupFor(b)
  // Read after the page's own handlers ran (and the browser's checks), before it navigates.
  if (g) sendAttempt(g, b)
}, true)
document.addEventListener('keydown', (e) => {
  if (onFieldKey(e)) return
  if (e.key === 'Escape') { closeMenu(); return }
  if (!e.isTrusted) return
  if (e.key === 'Tab') { lastTab = Date.now(); return }
  if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return
  const g = groupFor(e.target)
  // A form that goes natively is read by its submit, before it leaves; a script's send right after.
  if (g) sendAttempt(g, e.target)
}, true)
document.addEventListener('focusin', (e) => { void onFocus(e) }, true)
addEventListener('scroll', reposition, true)
addEventListener('resize', reposition)

// ── the save bar (top frame only) ──

let bar: { host: Host; frame: HTMLIFrameElement; nonce: string } | null = null
function showBar(nonce: string): void {
  if (cs.off || !cs.pageFill || SELF !== 'top' || !nonce) return
  // Asked twice for the same login (the send, then the page it led to): keep the one shown.
  if (bar?.nonce === nonce && bar.host.el.isConnected) return
  hideBar()
  const { host, root } = makeHost(2147483647, 'walnutSavebar')
  hostStyle(host, 'z-index: 2147483647 !important; top: 0 !important; right: 0 !important; left: auto !important;')
  const frame = extFrame('savebar.html', nonce, hideBar)
  // The bar (360 px) draws its own corners and shadow inside the frame's margin, so the frame
  // itself is see-through: a moment when it is taller than the bar shows nothing around it.
  frame.style.cssText = 'all: initial; display: block; width: 392px; height: 190px; border: 0; background: transparent; color-scheme: light dark;'
  frame.setAttribute('allowtransparency', 'true')
  root.appendChild(frame)
  bar = { host, frame, nonce }
}
function hideBar(): void {
  if (bar) { dropHost(bar.host); bar = null }
}

// ── an agent's tab: the frame around it says so, and Stop gives it back to the person ──

let agentMark: Host | null = null
function showAgentMark(on: boolean, who?: string): void {
  if (SELF !== 'top') return
  if (!on) { if (agentMark) { dropHost(agentMark); agentMark = null }; return }
  if (agentMark) return
  const { host, root } = makeHost(2147483645)
  // The frame lets every click through; only its Stop button takes one.
  hostStyle(host, 'z-index: 2147483645 !important; inset: 0 !important; pointer-events: none !important;')
  const style = document.createElement('style')
  style.textContent = `.edge{position:fixed;inset:0;border:3px solid #8a5a2b;border-radius:2px;pointer-events:none;box-sizing:border-box}
.pill{position:fixed;right:14px;bottom:14px;display:flex;gap:10px;align-items:center;padding:7px 8px 7px 12px;background:#2b2118;color:#fff;font:600 12.5px/1.2 -apple-system,system-ui,"Segoe UI",sans-serif;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:auto}
.stop{all:unset;cursor:pointer;background:#fff;color:#2b2118;border-radius:999px;padding:4px 10px;font:700 12px/1.2 -apple-system,system-ui,sans-serif}
.stop:focus-visible{outline:2px solid #e8b46a}`
  const pill = document.createElement('div')
  pill.className = 'pill'
  pill.append(document.createTextNode(who ? `Walnut agent is using this tab · ${who.slice(0, 60)}` : 'Walnut agent is using this tab'))
  const stop = document.createElement('button')
  stop.className = 'stop'
  stop.textContent = 'Stop'
  stop.title = 'Take this tab back: the agent can no longer use it'
  // Only the person's own click: an agent's synthetic one is not trusted.
  stop.addEventListener('click', (e) => { if (e.isTrusted) void ask({ type: 'agent-stop' }).then(() => showAgentMark(false)) })
  pill.append(stop)
  const edge = document.createElement('div')
  edge.className = 'edge'
  root.append(style, edge, pill)
  agentMark = host
  // The page may take the frame away: it comes back while the tab is an agent's.
  markWatch.observe(document.documentElement, { childList: true })
}

const markWatch = new MutationObserver(() => {
  if (agentMark && !agentMark.el.isConnected) document.documentElement.appendChild(agentMark.el)
})

// ── messages from the background ──

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'fill':
      if (!fillsHere(msg.origin)) { sendResponse({ filled: false }); return }
      rescan()
      sendResponse({ filled: asFill(() => msg.mode === 'totp' ? fillCode(String(msg.totp ?? '')) : fillLogin(msg.username, msg.password)) }); return
    case 'fill-wallet':
      if (!fillsHere(msg.origin)) { sendResponse({ filled: false }); return }
      rescan()
      {
        const r = asFill(() => fillWalletForm((msg.values ?? {}) as Record<string, string>, String(msg.kind ?? '')))
        // A field the item has nothing for stays empty: the person reads why, here on the page.
        if (r.note) toast(r.note, 6000)
        sendResponse({ filled: r.filled }); return
      }
    case 'fill-new-password':
      if (fillsHere(msg.origin)) asFill(() => fillNewPassword(String(msg.password ?? '')))
      sendResponse({ ok: true }); return
    case 'toast':
      if (!cs.off && typeof msg.text === 'string') toast(msg.text.slice(0, 120))
      sendResponse({ ok: true }); return
    case 'close-menu': closeMenu(msg.refocus === true); sendResponse({ ok: true }); return
    case 'check-shown': {
      const h = msg.which === 'bar' ? bar?.host : menu?.host
      const ok = !!h && h.el.isConnected && !tampered(h)
      if (!ok) closeAll()
      sendResponse({ ok }); return
    }
    case 'menu-size':
      setMenuHeight(Number(msg.height))
      sendResponse({ ok: true }); return
    case 'show-savebar': showBar(String(msg.nonce ?? '')); sendResponse({ ok: true }); return
    case 'agent-mark': showAgentMark(msg.on === true, typeof msg.who === 'string' ? msg.who : undefined); sendResponse({ ok: true }); return
    case 'agent-check': sendResponse({ ok: true, walnut: isWalnutApp(), href: location.href, doc: DOC_ID }); return
    case 'page-context':
      // The side panel asks about the page the person is on: the top frame answers.
      if (SELF !== 'top') { sendResponse({ ok: false }); return }
      sendResponse({ ok: true, walnut: isWalnutApp(), ...pageAgent.pageContext(msg.withText === true) }); return
    case 'agent-mask':
      // Each frame of the tab is asked (a password in an embedded sign-in is drawn as dots too).
      if (msg.on === true) sendResponse({ ok: true, masked: pageAgent.maskSecrets() })
      else { pageAgent.unmask(); sendResponse({ ok: true }) }
      return
    case 'agent': {
      // The background sends these only to the frames of an agent's tab (agent.ts); each frame checks its own site.
      // Checked again here, against this document: the page may have moved on since the background looked.
      const allow = msg.allow as { any?: boolean; sites?: string[]; walnut?: string[] } | undefined
      if (isWalnutApp() || walnutAddress(allow?.walnut, location.href)) { sendResponse({ ok: false, error: { message: 'Agents never use Walnut\'s own pages in the browser.', code: 'walnut_page' } }); return }
      const here = siteKey(location.href)?.domain
      if (!allow || !here || !(allow.any === true || (Array.isArray(allow.sites) && allow.sites.includes(here)))) {
        sendResponse({ ok: false, error: { message: 'That site is not allowed for agents yet.', code: 'site_not_allowed', extra: { url: location.href, site: here } } })
        return
      }
      runPageOp(String(msg.op), (msg.args ?? {}) as Record<string, unknown>).then(
        (result) => sendResponse({ ok: true, result }),
        (err) => sendResponse({ ok: false, error: { message: err instanceof Error ? err.message : String(err), code: err instanceof pageAgent.PageError ? err.code : 'page_error' } }))
      return true
    }
    case 'hide-savebar': hideBar(); sendResponse({ ok: true }); return
    case 'savebar-size':
      if (bar) bar.frame.style.height = `${Math.min(520, Math.max(80, Number(msg.height) || 184))}px`
      sendResponse({ ok: true }); return
    case 'open-menu-here': {
      // The shortcut asks the top page; the context menu asks the frame the person right-clicked in.
      if (cs.off || !MAY_FILL || (SELF !== 'top' && msg.here !== true)) { sendResponse({ ok: false }); return }
      rescan()
      const focused = document.activeElement instanceof HTMLInputElement && groupOfField(cs.groups, document.activeElement) ? document.activeElement : undefined
      const g = cs.groups.find((x) => x.kind === 'login' || x.kind === 'username-step')
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
    const d = e.data as { source?: string; type?: string; code?: string; agents?: unknown } | null
    if (!d || d.source !== 'walnut-connect-page') return
    void (async () => {
      if (d.type === 'hello') {
        const r = await ask<{ connected?: boolean; version?: string }>({ type: 'connect-hello' })
        if (r.ok) postMessage({ source: 'walnut-extension', type: 'present', connected: !!r.connected, version: r.version }, location.origin)
      } else if (d.type === 'code' && typeof d.code === 'string') {
        const r = await ask<{ device?: string; silent?: boolean }>({ type: 'connect-code', code: d.code, ...(typeof d.agents === 'boolean' ? { agents: d.agents } : {}) })
        if (r.silent) return
        postMessage({ source: 'walnut-extension', type: r.ok ? 'connected' : 'error', ...(r.ok ? { device: r.device } : { message: r.error }) }, location.origin)
      }
    })()
  })
}

// ── start ──

function start(): void {
  if (isWalnutApp()) return
  void ask<{ off?: boolean; barNonce?: string; agent?: { who?: string }; offerCode?: boolean; pageFill?: boolean }>({ type: 'page-init', top: SELF === 'top' }).then((r) => {
    if (!r.ok || r.off) return
    cs.off = false
    cs.pageFill = r.pageFill !== false
    offerCode = r.offerCode === true
    if (r.agent) showAgentMark(true, r.agent.who)
    reported = null
    rescan()
    if (r.barNonce) showBar(r.barNonce)
    maybeOfferCode()
    // The person clicked into a field while this was still starting: act on that focus now.
    if (document.activeElement instanceof HTMLInputElement) void onFocus({ target: document.activeElement })
  })
}
// A selection the person makes on the page, and its end: an open side panel follows it at once
// (top frame only; what was selected is read by the panel when it asks, never sent here). A
// selection cleared on the page is told too, so its quote leaves the panel's composer and never
// rides into a later message (review 2026-11-06 round 4, #4); a click on nothing, with no selection
// before it, tells nothing.
if (SELF === 'top') {
  let selTimer = 0
  // A selection already on the page when this script came in counts: its clearing is told too (L3).
  let hadSelection = (getSelection()?.toString() ?? '').trim() !== ''
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer)
    selTimer = window.setTimeout(() => {
      if (isWalnutApp()) return
      const has = (getSelection()?.toString() ?? '').trim() !== ''
      if (!has && !hadSelection) return
      hadSelection = has
      void ask({ type: 'page-selection' })
    }, 400)
  })
}

// "Fill and save on web pages" changed in Settings: open tabs follow at once, no reload. Off,
// what Walnut drew in the page goes; on again, the next field the person is in shows the icon.
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('settings' in changes) || !live()) return
  const on = (changes.settings.newValue as { pageFill?: unknown } | undefined)?.pageFill !== false
  if (on === cs.pageFill) return
  cs.pageFill = on
  if (!on) closeAll()
})

// Password fields as the page first draws them, and any focused later: one shown as text stays a secret.
pageAgent.notePasswords()
addEventListener('focusin', (e) => pageAgent.notePassword(e.target), true)
start()
initPageBrowserKey(isWalnutApp, live)
// Back from the back/forward cache: no script runs again, so this page registers its frame anew.
addEventListener('pageshow', (e) => { if (e.persisted) start() })
let pending = 0
new MutationObserver(() => {
  if (pending || cs.off) return
  pending = window.setTimeout(() => { pending = 0; rescan(); reposition(); maybeOfferCode() }, 400)
}).observe(document.documentElement, { childList: true, subtree: true })
