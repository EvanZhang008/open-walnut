/**
 * The toolbar popup: connect to Walnut, unlock, then the logins for the page you are on, a
 * search over the whole vault, copy, fill, and the password generator. Everything goes through
 * the background; a copied secret comes back only to be put on the clipboard by this page,
 * which has the person's click.
 */
import { ask, ext } from './ext'
import { avatar, h, icon, totpView } from './dom'
import { copySecret, errLine, toast } from './popup-ui'
import { generatorView } from './popup-generator'
import { settingsView } from './popup-settings'
import { startClipboardPage } from './clipboard-page'

interface Item { id: string; title: string; username?: string; site?: string; hasTotp: boolean; exact?: boolean; type?: string; sub?: string }
interface State { connected: boolean; unlocked: boolean; serverUrl?: string; device?: string }

const root = document.getElementById('root')!
/** Walnut no longer knows this extension (removed in Settings): it forgot the connection, so connect again. */
const DISCONNECTED = new Set(['not_connected', 'not_paired', 'token_refused'])
const params = new URLSearchParams(location.search)
/** This view inside the side panel's Passwords tab (sidepanel.ts), for the page of one window. */
const embedded = params.get('embed') === 'panel'
/** A window of its own (the unlock window), which closes when its work is done. */
const inWindow = params.has('window') && !embedded
const panelWindow = embedded ? Number(params.get('window')) || undefined : undefined
/** How long a password shown in the side panel stays on show. */
const REVEAL_MS = 20_000

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
  const server = h('input', { class: 'input', id: 'server', value: st.serverUrl ?? 'http://localhost:3456', 'aria-label': 'Walnut address', spellcheck: 'false' })
  const err = errLine()
  const go = h('button', { class: 'btn btn-primary btn-block', type: 'button', 'data-testid': 'popup-connect' }, 'Connect')
  go.onclick = async () => {
    busy(go, true)
    const r = await ask({ type: 'start-connect', serverUrl: server.value })
    busy(go, false)
    if (!r.ok) { err.textContent = r.error ?? ''; return }
    if (!inWindow) window.close()
  }
  const code = h('input', { class: 'input mono', id: 'code', placeholder: 'ABCD-EFGH', 'aria-label': 'Pairing code', autocomplete: 'off', spellcheck: 'false' })
  const useCode = h('button', { class: 'btn', type: 'button', style: 'margin-top:8px;width:100%' }, 'Connect with this code')
  useCode.onclick = async () => {
    busy(useCode, true)
    const r = await ask({ type: 'pair-code', serverUrl: server.value, code: code.value })
    busy(useCode, false)
    if (!r.ok) { err.textContent = r.error ?? ''; return }
    void render()
  }
  return h('div', { class: 'center' },
    h('span', { class: 'big-icon' }, icon('plug')),
    h('h2', {}, 'Connect to Walnut'),
    h('p', {}, 'Fill and save passwords from your Walnut vault. Walnut opens a page that connects this browser.'),
    h('label', { class: 'field-label', for: 'server', style: 'text-align:left' }, 'Walnut address'), server,
    h('div', { style: 'height:10px' }), go, err,
    h('details', { style: 'text-align:left' },
      h('summary', {}, 'Have a pairing code instead?'),
      h('p', { class: 'muted', style: 'font-size:12px;margin:8px 0' }, 'In Walnut: Settings, Devices, Connect a browser.'),
      code, useCode))
}

// ── locked ──

async function unlockView(st: State): Promise<HTMLElement> {
  const status = await ask<{ status: { setUp: boolean; waitMs: number; hasSecretKey: boolean } }>({ type: 'vault-status' })
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
    h('label', { class: 'field-label', for: 'sk' }, 'This Mac does not hold your Secret Key: type it from your recovery kit.'), sk)
  const err = errLine(!status.ok ? status.error : undefined)
  const go = h('button', { class: 'btn btn-primary btn-block', type: 'submit', 'data-testid': 'popup-unlock', style: 'margin-top:10px' }, 'Unlock')
  const form = h('form', { style: 'text-align:left' }, pw, skWrap, go, err)
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

// ── unlocked ──

async function copy(id: string, field: 'username' | 'password' | 'totp' | 'number' | 'code', what: string): Promise<void> {
  const r = await ask<{ value: string }>({ type: 'copy-secret', id, field })
  if (!r.ok) { toast(r.error ?? 'Could not copy.'); return }
  await copySecret(r.value, what)
}

async function fillTab(it: Item): Promise<void> {
  const r = await ask<{ code?: string }>({ type: 'fill-tab', id: it.id, ...(panelWindow ? { windowId: panelWindow } : {}) })
  if (!r.ok) { toast(r.error ?? 'Could not fill.'); return }
  // Its one-time code goes on the clipboard (the background had no clipboard of its own here).
  if (r.code) await copySecret(r.code, 'Code')
  if (embedded) { if (!r.code) toast('Filled') } else if (!inWindow) setTimeout(() => window.close(), r.code ? 700 : 0)
}

/** A login's current one-time code with its countdown; a click copies it. */
function codeChip(it: Item): HTMLElement {
  const chip = h('button', { class: 'totp-chip', type: 'button', title: 'Copy one-time code', 'aria-label': 'Copy one-time code', 'data-testid': 'popup-totp' }) as HTMLButtonElement
  const load = async () => {
    const t = await ask<{ code: string; period: number; remaining: number }>({ type: 'totp-code', id: it.id })
    if (!t.ok) { chip.remove(); return }
    chip.replaceChildren(totpView(t, () => { if (chip.isConnected) void load() }))
    chip.onclick = (e: Event) => { e.stopPropagation(); void copySecret(t.code, 'Code') }
  }
  void load()
  return chip
}

const isLogin = (it: Item) => !it.type || it.type === 'login'

function itemRow(it: Item, fillable: boolean): HTMLElement {
  const card = it.type === 'card'
  const actions = h('div', { class: 'item-actions' },
    it.username ? h('button', { class: 'icon-btn', type: 'button', title: 'Copy username', 'aria-label': 'Copy username', onclick: (e: Event) => { e.stopPropagation(); void copy(it.id, 'username', 'Username') } }, icon('user')) : null,
    isLogin(it) || it.type === 'api_key' ? h('button', { class: 'icon-btn', type: 'button', title: 'Copy password', 'aria-label': 'Copy password', 'data-testid': 'copy-password', onclick: (e: Event) => { e.stopPropagation(); void copy(it.id, 'password', 'Password') } }, icon('copy')) : null,
    card ? h('button', { class: 'icon-btn', type: 'button', title: 'Copy card number', 'aria-label': 'Copy card number', 'data-testid': 'copy-number', onclick: (e: Event) => { e.stopPropagation(); void copy(it.id, 'number', 'Card number') } }, icon('copy')) : null,
    card ? h('button', { class: 'icon-btn', type: 'button', title: 'Copy security code', 'aria-label': 'Copy security code', onclick: (e: Event) => { e.stopPropagation(); void copy(it.id, 'code', 'Security code') } }, icon('lock')) : null)
  const subText = it.sub || it.username || it.site || (it.type === 'identity' ? 'Identity' : '')
  const sub = h('span', { class: 'row-sub' }, subText)
  // In the side panel there is room to show a password; it hides again on the next click.
  if (embedded && isLogin(it)) {
    let shown = false
    const eye = h('button', { class: 'icon-btn', type: 'button', title: 'Show password', 'aria-label': 'Show password', 'data-testid': 'reveal-password' }, icon('eye')) as HTMLButtonElement
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    const hide = () => {
      clearTimeout(hideTimer)
      shown = false; sub.textContent = subText; sub.classList.remove('mono'); eye.title = 'Show password'
      document.removeEventListener('visibilitychange', hide)
    }
    eye.onclick = async (e: Event) => {
      e.stopPropagation()
      if (shown) { hide(); return }
      const r = await ask<{ value: string }>({ type: 'copy-secret', id: it.id, field: 'password' })
      if (!r.ok) { toast(r.error ?? 'Could not show it.'); return }
      shown = true
      sub.textContent = r.value
      sub.classList.add('mono')
      eye.title = 'Hide password'
      // Never left on show: hidden again after a while, or once the person leaves this tab.
      hideTimer = setTimeout(hide, REVEAL_MS)
      document.addEventListener('visibilitychange', hide)
    }
    actions.prepend(eye)
  }
  // A card or an identity fills the page's form; a login fills only on its own site.
  const fills = fillable || it.type === 'card' || it.type === 'identity'
  const row = h('div', { class: 'row item', tabindex: '0', role: 'button', 'data-testid': 'popup-item', title: fills ? 'Fill on this page' : '' },
    it.type === 'card' ? h('span', { class: 'avatar', style: 'background:#5b4fa8' }, icon('card')) : it.type === 'identity' ? h('span', { class: 'avatar', style: 'background:#2f7f7a' }, icon('person')) : avatar(it.site ?? it.title),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, it.title), sub),
    actions,
    it.hasTotp && isLogin(it) ? codeChip(it) : null,
    fills ? h('span', { class: 'icon-btn', 'aria-hidden': 'true', style: 'color:var(--accent)' }, icon('fill')) : null)
  const act = () => {
    if (fills) void fillTab(it)
    else if (isLogin(it) || it.type === 'api_key') void copy(it.id, 'password', 'Password')
    else void ask({ type: 'open-walnut' })
  }
  row.onclick = act
  row.onkeydown = (e) => { if (e.key === 'Enter') act() }
  return row
}

async function vaultView(st: State): Promise<HTMLElement> {
  const site = await ask<{ site: string; items: Item[]; insecure?: number }>({ type: 'site-items', ...(panelWindow ? { windowId: panelWindow } : {}) })
  if (!site.ok && (site.code === 'vault_session_needed' || site.code === 'vault_locked')) return unlockView({ ...st, unlocked: false })
  if (!site.ok && site.code && DISCONNECTED.has(site.code)) return connectView({ connected: false, unlocked: false, serverUrl: st.serverUrl })
  const wallet = await ask<{ cards: Item[]; identities: Item[] }>({ type: 'wallet-items' })
  const q = h('input', { class: 'input', type: 'search', id: 'q', placeholder: 'Search Walnut', 'aria-label': 'Search Walnut', autocomplete: 'off' })
  const list = h('div', { class: 'pane', style: 'padding-top:4px' })
  const siteItems = site.ok ? site.items : []

  const showSite = () => {
    list.replaceChildren()
    if (site.site) {
      list.append(h('div', { class: 'section-label' }, `For ${site.site}`))
      if (siteItems.length) for (const it of siteItems) list.append(itemRow(it, true))
      else if (site.insecure) {
        // Saved for the https address: this plain http page does not get it, and the person is told why.
        list.append(h('div', { class: 'notice', 'data-testid': 'popup-insecure' }, icon('warn'),
          h('span', {}, `This page is not secure (http). Your ${site.insecure === 1 ? 'login is' : `${site.insecure} logins are`} saved for the https address of ${site.site}, so Walnut does not fill ${site.insecure === 1 ? 'it' : 'them'} here.`)))
      } else list.append(h('div', { class: 'empty' }, 'No saved login for this site. Sign in and Walnut offers to save it.'))
    } else {
      list.append(h('div', { class: 'empty' }, 'Search your vault, or open a site to see its logins here.'))
    }
    // Cards and identities fill the page's payment or address form.
    const cards = wallet.ok ? wallet.cards.slice(0, 3) : []
    const people = wallet.ok ? wallet.identities.slice(0, 3) : []
    if (cards.length) { list.append(h('div', { class: 'section-label' }, 'Cards')); for (const it of cards) list.append(itemRow(it, false)) }
    if (people.length) { list.append(h('div', { class: 'section-label' }, 'Identities')); for (const it of people) list.append(itemRow(it, false)) }
  }
  let seq = 0
  q.oninput = async () => {
    const text = q.value.trim()
    if (!text) { showSite(); return }
    const mine = ++seq
    const r = await ask<{ items: Item[] }>({ type: 'search', q: text })
    if (mine !== seq) return
    list.replaceChildren(h('div', { class: 'section-label' }, 'Results'))
    if (!r.ok) { list.append(errLine(r.error)); return }
    if (!r.items.length) { list.append(h('div', { class: 'empty' }, `Nothing matches "${text}".`)); return }
    const here = new Set(siteItems.map((i) => i.id))
    for (const it of r.items) list.append(itemRow(it, here.has(it.id)))
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

  const lock = h('button', { class: 'icon-btn', type: 'button', title: 'Lock Walnut', 'aria-label': 'Lock Walnut', 'data-testid': 'popup-lock' }, icon('lock'))
  lock.onclick = async () => { await ask({ type: 'lock' }); void render() }
  return h('div', {},
    h('div', { class: 'top' }, h('span', { class: 'logo' }, icon('key')), h('h1', {}, 'Walnut'), lock),
    h('div', { class: 'pane', style: 'padding-bottom:0' }, h('div', { class: 'search' }, icon('search'), q)),
    list,
    h('div', { class: 'foot' },
      askButton(),
      h('button', { class: 'btn', type: 'button', 'data-testid': 'popup-generator', onclick: () => void generatorView(root, () => void render()) }, 'Generator'),
      h('button', { class: 'btn', type: 'button', onclick: () => void ask({ type: 'open-walnut' }) }, 'Open Walnut'),
      h('button', { class: 'btn', type: 'button', 'data-testid': 'popup-settings', onclick: () => void showSettings(st) }, 'Settings')))
}

function showSettings(st: State): Promise<void> {
  return settingsView(root, st, () => void render())
}

// ── start ──

async function render(): Promise<void> {
  const st = await ask<State>({ type: 'state' })
  let view: HTMLElement
  if (!st.ok) view = h('div', { class: 'center' }, errLine(st.error))
  else if (!st.connected) view = connectView(st)
  else if (!st.unlocked) view = await unlockView(st)
  else view = await vaultView(st)
  root.replaceChildren(view)
}

// popup.html?clipboard=1 is Chrome's offscreen document for the clipboard (bg-clipboard.ts), not a view.
if (params.has('clipboard')) startClipboardPage()
else void render()

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
