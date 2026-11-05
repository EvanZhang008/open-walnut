/**
 * The toolbar popup: connect to Walnut, unlock, then the logins for the page you are on, a
 * search over the whole vault, copy, fill, and the password generator. Everything goes through
 * the background; a copied secret comes back only to be put on the clipboard by this page,
 * which has the person's click.
 */
import { ask, ext } from './ext'
import { h, icon } from './dom'
import { errLine, iconButton, popupIcon } from './popup-ui'
import { generatorView } from './popup-generator'
import { settingsView } from './popup-settings'
import { itemRow, type Item, type PopupCtx } from './popup-item'
import { findWalnut, rememberServer } from './popup-connect'
import { startClipboardPage } from './clipboard-page'
import { pageFillOn } from './settings'
import { currentView, isCurrent, nextView, paint } from './popup-view'

interface State { connected: boolean; unlocked: boolean; serverUrl?: string; device?: string }

const root = document.getElementById('root')!
/** Walnut no longer knows this extension (removed in Settings): it forgot the connection, so connect again. */
const DISCONNECTED = new Set(['not_connected', 'not_paired', 'token_refused'])
/** Walnut ended this browser's unlock: the lock screen, with its password field. */
const LOCKED = new Set(['vault_session_needed', 'vault_locked'])
const params = new URLSearchParams(location.search)
/** This view inside the side panel's Passwords tab (sidepanel.ts), for the page of one window. */
const embedded = params.get('embed') === 'panel'
/** A window of its own (the unlock window), which closes when its work is done. */
const inWindow = params.has('window') && !embedded
const panelWindow = embedded ? Number(params.get('window')) || undefined : undefined
// The side panel and a window of its own give the view their width; the toolbar popup is 360 px.
if (embedded || inWindow) document.documentElement.classList.add('wide')
// In the side panel the panel's own tab bar is the header: no second Walnut brand bar (ui.css).
if (embedded) document.documentElement.classList.add('in-panel')
const ctx: PopupCtx = { root, embedded, inWindow, panelWindow, back: () => void render() }

/** This popup's window, known before any click: opening the side panel must not wait on anything. */
let windowId: number | undefined
// (The offscreen clipboard document, popup.html?clipboard=1, has no windows API.)
if (!params.has('clipboard')) void ext.windows.getCurrent().then((w) => { windowId = w.id }).catch(() => undefined)

/** Walnut in the side panel, about the page this window shows. */
function askButton(): HTMLElement | null {
  // Already in the side panel: its Ask tab is right there.
  if (embedded) return null
  const b = h('button', { class: 'btn', type: 'button', 'data-testid': 'popup-ask', title: 'Ask Walnut about this page in the side panel' }, 'Ask Walnut')
  b.onclick = () => {
    if (ext.sidePanel && windowId !== undefined) void ext.sidePanel.open({ windowId }).catch(() => undefined)
    else if (ext.sidebarAction) void ext.sidebarAction.open().catch(() => undefined)
    // No side panel in this browser: the same page in a window of its own, beside this one.
    else if (windowId !== undefined) void ext.windows.create({ url: ext.runtime.getURL(`sidepanel.html?window=${windowId}`), type: 'popup', width: 420, height: 760 })
    if (!inWindow) window.close()
  }
  return b as HTMLElement
}

function busy(b: HTMLButtonElement, on: boolean, label?: string): void {
  b.disabled = on
  if (label) b.textContent = label
}

// ── not connected ──

function connectView(st: State): HTMLElement {
  const server = h('input', { class: 'input', id: 'server', value: st.serverUrl ?? 'http://localhost:3456', 'aria-label': 'Walnut address', spellcheck: 'false', autocomplete: 'url' }) as HTMLInputElement
  // Walnut is looked for at once; what the person types is never replaced.
  let typed = false
  server.addEventListener('input', () => { typed = true })
  const found = h('p', { class: 'found', 'data-testid': 'popup-found', role: 'status' }, 'Looking for Walnut on this computer…')
  void findWalnut().then((at) => {
    if (!found.isConnected) return
    if (at) {
      if (!typed) server.value = at
      found.className = 'found ok'
      found.replaceChildren(popupIcon('check'), h('span', {}, `Found Walnut at ${new URL(at).host}`))
    } else {
      found.className = 'found miss'
      found.textContent = 'No Walnut answered on this computer. Type the address you open Walnut at, such as https://walnut.example.com.'
      if (!typed && (document.activeElement === document.body || !document.activeElement)) { server.focus(); server.select() }
    }
  })
  const err = errLine()
  const go = h('button', { class: 'btn btn-primary btn-block', type: 'button', 'data-testid': 'popup-connect' }, 'Connect')
  go.onclick = async () => {
    busy(go, true)
    const r = await ask({ type: 'start-connect', serverUrl: server.value })
    busy(go, false)
    if (!r.ok) { err.textContent = r.error ?? ''; return }
    rememberServer(server.value)
    if (!inWindow) window.close()
  }
  const code = h('input', { class: 'input mono', id: 'code', placeholder: 'ABCD-EFGH', 'aria-label': 'Pairing code', autocomplete: 'off', spellcheck: 'false' })
  const useCode = h('button', { class: 'btn', type: 'button', style: 'margin-top:8px;width:100%' }, 'Connect with this code')
  useCode.onclick = async () => {
    busy(useCode, true)
    const r = await ask({ type: 'pair-code', serverUrl: server.value, code: code.value })
    busy(useCode, false)
    if (!r.ok) { err.textContent = r.error ?? ''; return }
    rememberServer(server.value)
    void render()
  }
  return h('div', { class: 'center' },
    h('span', { class: 'big-icon' }, icon('keyBig')),
    h('h2', {}, 'Connect to Walnut'),
    h('p', {}, 'Fill and save passwords from your Walnut vault. Walnut opens a page that connects this browser.'),
    h('label', { class: 'field-label', for: 'server', style: 'text-align:left' }, 'Walnut address'), server, found,
    h('div', { style: 'height:12px' }), go, err,
    h('details', { style: 'text-align:left' },
      h('summary', {}, 'Have a pairing code instead?'),
      h('p', { class: 'muted', style: 'font-size:12px;margin:8px 0' }, 'In Walnut: Settings, Devices, Connect a browser.'),
      code, useCode))
}

// ── locked ──

async function unlockView(st: State): Promise<HTMLElement> {
  const status = await ask<{ status: { setUp: boolean; waitMs: number; hasSecretKey: boolean; hint?: string } }>({ type: 'vault-status' })
  if (!status.ok && status.code && DISCONNECTED.has(status.code)) return connectView({ connected: false, unlocked: false, serverUrl: st.serverUrl })
  if (status.ok && !status.status.setUp) {
    return h('div', { class: 'center' },
      h('span', { class: 'big-icon' }, icon('keyBig')),
      h('h2', {}, 'Set up Passwords first'),
      h('p', {}, 'Your Walnut has no password vault yet. Make one in Walnut, then come back.'),
      h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => void ask({ type: 'open-walnut' }) }, 'Open Walnut Passwords'),
      // Agents in this browser need no vault: their switch is in Settings.
      h('button', { class: 'btn btn-quiet', type: 'button', style: 'margin-top:10px;width:100%', onclick: () => void showSettings(st) }, 'Settings'),
      h('div', { style: 'margin-top:10px' }, askButton()))
  }
  const pw = h('input', { class: 'input', type: 'password', id: 'pw', autocomplete: 'current-password', 'aria-label': 'Master password', placeholder: 'Master password' })
  const sk = h('input', { class: 'input mono', id: 'sk', 'aria-label': 'Secret Key', placeholder: 'W1-XXXXXX-…', spellcheck: 'false', style: 'margin-top:8px' })
  const skWrap = h('div', { style: 'display:none;text-align:left' },
    h('label', { class: 'field-label', for: 'sk' }, 'The computer Walnut runs on does not hold your Secret Key: type it from your recovery kit.'), sk)
  const err = errLine(!status.ok ? status.error : undefined)
  const hint = hintLine(status.ok ? status.status.hint : undefined)
  const go = h('button', { class: 'btn btn-primary btn-block', type: 'submit', 'data-testid': 'popup-unlock', style: 'margin-top:10px' }, 'Unlock')
  const form = h('form', { style: 'text-align:left' }, pw, hint.el, skWrap, go, err)
  form.onsubmit = async (e) => {
    e.preventDefault()
    if (!pw.value) { pw.focus(); return }
    busy(go, true, 'Unlocking…')
    err.textContent = ''
    const r = await ask({ type: 'unlock', password: pw.value, secretKey: sk.value.trim() })
    busy(go, false, 'Unlock')
    if (r.ok) { if (inWindow) window.close(); else void render(); return }
    if (r.code && DISCONNECTED.has(r.code)) { void render(); return }
    if (r.code === 'secret_key_needed') { skWrap.style.display = ''; sk.focus() }
    else { pw.select() }
    if (r.code === 'wrong_password') hint.show()
    err.textContent = r.code === 'too_many_attempts' && typeof r.waitMs === 'number'
      ? `Too many tries. Wait ${Math.ceil(Number(r.waitMs) / 1000)} s.`
      : r.error ?? 'That did not unlock.'
  }
  setTimeout(() => pw.focus(), 30)
  return h('div', {},
    h('div', { class: 'center', style: 'padding-bottom:6px' },
      h('span', { class: 'big-icon' }, icon('lockBig')),
      h('h2', {}, 'Walnut is locked'),
      h('p', {}, `Unlock to fill passwords${st.serverUrl ? ` from ${new URL(st.serverUrl).host}` : ''}.`)),
    h('div', { class: 'pane', style: 'padding-top:0' }, form,
      h('button', { class: 'btn btn-quiet', type: 'button', style: 'margin-top:10px;width:100%', onclick: () => void showSettings(st) }, 'Settings'),
      h('div', { style: 'margin-top:6px;text-align:center' }, askButton())))
}

/** "Show hint" under the password field once the vault has a hint; a wrong password shows it at once. */
function hintLine(text: string | undefined): { el: HTMLElement; show: () => void } {
  const el = h('div', { class: 'hint-line' }) as HTMLElement
  if (!text) return { el, show: () => undefined }
  const show = () => el.replaceChildren(h('p', { class: 'hint-shown', 'data-testid': 'popup-hint-shown' }, h('span', { class: 'muted' }, 'Hint: '), text))
  el.append(h('button', { class: 'link-btn', type: 'button', 'data-testid': 'popup-show-hint', onclick: show }, 'Show hint'))
  return { el, show }
}

// ── unlocked ──

async function vaultView(st: State): Promise<HTMLElement> {
  const site = await ask<{ site: string; items: Item[]; insecure?: number }>({ type: 'site-items', ...(panelWindow ? { windowId: panelWindow } : {}) })
  if (!site.ok && (site.code === 'vault_session_needed' || site.code === 'vault_locked')) return unlockView({ ...st, unlocked: false })
  if (!site.ok && site.code && DISCONNECTED.has(site.code)) return connectView({ connected: false, unlocked: false, serverUrl: st.serverUrl })
  const wallet = await ask<{ cards: Item[]; identities: Item[] }>({ type: 'wallet-items' })
  const pageFill = await pageFillOn()
  const q = h('input', { class: 'input', type: 'search', id: 'q', placeholder: 'Search Walnut', 'aria-label': 'Search Walnut', autocomplete: 'off' })
  const list = h('div', { class: 'pane', style: 'padding-top:4px' })
  const siteItems = site.ok ? site.items : []

  const showSite = () => {
    list.replaceChildren()
    if (site.site) {
      list.append(h('div', { class: 'section-label' }, `For ${site.site}`))
      if (siteItems.length) for (const it of siteItems) list.append(itemRow(it, true, ctx))
      else if (site.insecure) {
        // Saved for the https address: this plain http page does not get it, and the person is told why.
        list.append(h('div', { class: 'notice', 'data-testid': 'popup-insecure' }, icon('warn'),
          h('span', {}, `This page is not secure (http). Your ${site.insecure === 1 ? 'login is' : `${site.insecure} logins are`} saved for the https address of ${site.site}, so Walnut does not fill ${site.insecure === 1 ? 'it' : 'them'} here.`)))
      } else list.append(h('div', { class: 'empty' }, pageFill ? 'No saved login for this site. Sign in and Walnut offers to save it.' : 'No saved login for this site.'))
    } else {
      list.append(h('div', { class: 'empty' }, 'Search your vault, or open a site to see its logins here.'))
    }
    // Cards and identities fill the page's payment or address form.
    const cards = wallet.ok ? wallet.cards.slice(0, 3) : []
    const people = wallet.ok ? wallet.identities.slice(0, 3) : []
    if (cards.length) { list.append(h('div', { class: 'section-label' }, 'Cards')); for (const it of cards) list.append(itemRow(it, false, ctx)) }
    if (people.length) { list.append(h('div', { class: 'section-label' }, 'Identities')); for (const it of people) list.append(itemRow(it, false, ctx)) }
  }
  let seq = 0
  q.oninput = async () => {
    const text = q.value.trim()
    if (!text) { showSite(); return }
    const mine = ++seq
    const g = currentView()
    const r = await ask<{ items: Item[] }>({ type: 'search', q: text })
    if (mine !== seq || !isCurrent(g)) return
    if (!r.ok && r.code && LOCKED.has(r.code)) { void render(); return }
    list.replaceChildren(h('div', { class: 'section-label' }, 'Results'))
    if (!r.ok) { list.append(errLine(r.error)); return }
    if (!r.items.length) { list.append(h('div', { class: 'empty' }, `Nothing matches "${text}".`)); return }
    const here = new Set(siteItems.map((i) => i.id))
    for (const it of r.items) list.append(itemRow(it, here.has(it.id), ctx))
  }
  q.onkeydown = (e) => {
    if (e.key === 'Enter') (list.querySelector<HTMLElement>('.item'))?.click()
    if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector<HTMLElement>('.item')?.focus() }
  }
  list.onkeydown = (e) => {
    const rows = [...list.querySelectorAll<HTMLElement>('.item')]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' && i >= 0) { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)].focus() }
    if (e.key === 'ArrowUp' && i >= 0) { e.preventDefault(); (i === 0 ? q : rows[i - 1]).focus() }
  }
  showSite()
  setTimeout(() => q.focus(), 30)

  const lock = iconButton(icon('lock'), 'Lock Walnut', async () => { nextView(); await ask({ type: 'lock' }); void render() }, { 'data-testid': 'popup-lock' })
  return h('div', {},
    h('div', { class: 'top' }, h('span', { class: 'logo' }, icon('key')), h('h1', {}, 'Walnut'),
      h('div', { class: 'top-tools' },
        iconButton(icon('dice'), 'Password generator', () => void generatorView(root, () => void render()), { 'data-testid': 'popup-generator' }),
        iconButton(popupIcon('gear'), 'Settings', () => void showSettings(st), { 'data-testid': 'popup-settings' }),
        lock)),
    h('div', { class: 'pane', style: 'padding-bottom:0' }, h('div', { class: 'search' }, icon('search'), q)),
    // Off in Settings (another password manager fills this browser): one quiet line says so.
    pageFill ? null : h('p', { class: 'quiet-line', 'data-testid': 'popup-pagefill-off' }, 'Filling on pages is off. ',
      h('button', { class: 'link-btn', type: 'button', 'data-testid': 'popup-pagefill-settings', onclick: () => void showSettings(st) }, 'Turn on in Settings.')),
    list,
    h('div', { class: 'foot' },
      askButton(),
      h('button', { class: 'btn', type: 'button', 'data-testid': 'popup-open-walnut', onclick: () => void ask({ type: 'open-walnut' }) }, icon('out'), h('span', {}, 'Open Walnut'))))
}

function showSettings(st: State): Promise<void> {
  return settingsView(root, st, () => void render())
}

// ── start ──

async function render(): Promise<void> {
  const g = nextView()
  const st = await ask<State>({ type: 'state' })
  let view: HTMLElement
  if (!st.ok) view = h('div', { class: 'center' }, errLine(st.error))
  else if (!st.connected) view = connectView(st)
  else if (!st.unlocked) view = await unlockView(st)
  else view = await vaultView(st)
  // What it holds, read from the view itself (an unlocked render may have drawn the lock screen).
  const shows = view.querySelector('#pw') ? 'locked' : st.ok && st.connected && st.unlocked && !view.querySelector('#server') ? 'unlocked' : 'neutral'
  if (paint(root, view, g, shows) && st.ok) root.dataset.connected = st.connected ? '1' : '0'
}

/**
 * An open popup or side panel follows the vault without a reload (R3-1, R3-2): a Lock all or a
 * Lock in another window replaces the list with the lock screen at once, and an unlock in a Walnut
 * window on this computer shows the list (the background shares it, bg-vault.ts liveState).
 */
function followVault(): void {
  let checking = false
  const check = async () => {
    if (checking || document.visibilityState !== 'visible' || !root.dataset.shows) return
    checking = true
    try {
      const st = await ask<State>({ type: 'vault-watch' })
      if (!st.ok) return
      // The view on show now, whichever path drew it (popup-view.ts), against Walnut's answer.
      const shows = root.dataset.shows
      const stale = st.connected !== (root.dataset.connected === '1')
        || (shows === 'unlocked' && !st.unlocked) || (shows === 'locked' && st.unlocked)
      if (!stale) return
      // Unlocked in another window while this one waits for the password: its work is done.
      if (inWindow && st.unlocked && shows === 'locked') { window.close(); return }
      await render()
    } finally { checking = false }
  }
  setInterval(() => void check(), 3000)
  document.addEventListener('visibilitychange', () => void check())
  window.addEventListener('focus', () => void check())
  // The background dropped or took an unlock (a refusal from Walnut on any request, an unlock, a
  // share): its mark in storage.session comes and goes with the token (walnut-api.ts).
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !('vaultSession' in changes)) return
    const c = changes.vaultSession
    if ((c.oldValue !== undefined) !== (c.newValue !== undefined)) void check()
  })
}

// popup.html?clipboard=1 is Chrome's offscreen document for the clipboard (bg-clipboard.ts), not a view.
if (params.has('clipboard')) startClipboardPage()
else { void render(); followVault() }

// In the side panel the view stays open while the person moves on: it follows the page in its
// window (another tab, another address), unless they are typing in it.
if (embedded && panelWindow && !params.has('clipboard')) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const follow = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.value !== ''
      if (!typing && document.visibilityState === 'visible') void render()
    }, 300)
  }
  ext.tabs.onActivated.addListener((info) => { if (info.windowId === panelWindow) follow() })
  ext.tabs.onUpdated.addListener((_id, change, tab) => { if (tab.windowId === panelWindow && tab.active && (change.url || change.status === 'complete')) follow() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') follow() })
}
