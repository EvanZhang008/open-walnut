/**
 * The toolbar popup: connect to Walnut, unlock, then the logins for the page you are on, a
 * search over the whole vault, copy, fill, and the password generator. Everything goes through
 * the background; a copied secret comes back only to be put on the clipboard by this page,
 * which has the person's click.
 */
import { ask, ext } from './ext'
import { avatar, h, icon } from './dom'

interface Item { id: string; title: string; username?: string; site?: string; hasTotp: boolean; exact?: boolean; type?: string }
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

/** This popup's window, known before any click: opening the side panel must not wait on anything. */
let windowId: number | undefined
void ext.windows.getCurrent().then((w) => { windowId = w.id }).catch(() => undefined)

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

function toast(text: string): void {
  let t = document.querySelector<HTMLElement>('.toast')
  if (!t) { t = h('div', { class: 'toast', role: 'status' }); document.body.append(t) }
  t.textContent = text
  t.classList.add('on')
  setTimeout(() => t!.classList.remove('on'), 1600)
}

function errLine(text?: string): HTMLElement {
  return h('p', { class: 'err', role: 'alert' }, text ?? '')
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

async function copy(id: string, field: 'username' | 'password' | 'totp', what: string): Promise<void> {
  const r = await ask<{ value: string }>({ type: 'copy-secret', id, field })
  if (!r.ok) { toast(r.error ?? 'Could not copy.'); return }
  await navigator.clipboard.writeText(r.value)
  toast(`${what} copied`)
}

async function fillTab(it: Item): Promise<void> {
  const r = await ask({ type: 'fill-tab', id: it.id, ...(panelWindow ? { windowId: panelWindow } : {}) })
  if (r.ok) { if (embedded) toast('Filled'); else if (!inWindow) window.close(); return }
  toast(r.error ?? 'Could not fill.')
}

function itemRow(it: Item, fillable: boolean): HTMLElement {
  const actions = h('div', { class: 'item-actions' },
    it.username ? h('button', { class: 'icon-btn', type: 'button', title: 'Copy username', 'aria-label': 'Copy username', onclick: (e: Event) => { e.stopPropagation(); void copy(it.id, 'username', 'Username') } }, icon('user')) : null,
    (!it.type || it.type === 'login') ? h('button', { class: 'icon-btn', type: 'button', title: 'Copy password', 'aria-label': 'Copy password', 'data-testid': 'copy-password', onclick: (e: Event) => { e.stopPropagation(); void copy(it.id, 'password', 'Password') } }, icon('copy')) : null,
    it.hasTotp ? h('button', { class: 'icon-btn', type: 'button', title: 'Copy one-time code', 'aria-label': 'Copy one-time code', onclick: (e: Event) => { e.stopPropagation(); void copy(it.id, 'totp', 'Code') } }, icon('clock')) : null)
  const sub = h('span', { class: 'row-sub' }, it.username || it.site || '')
  // In the side panel there is room to show a password; it hides again on the next click.
  if (embedded && (!it.type || it.type === 'login')) {
    let shown = false
    const eye = h('button', { class: 'icon-btn', type: 'button', title: 'Show password', 'aria-label': 'Show password', 'data-testid': 'reveal-password' }, icon('eye')) as HTMLButtonElement
    eye.onclick = async (e: Event) => {
      e.stopPropagation()
      if (shown) { shown = false; sub.textContent = it.username || it.site || ''; sub.classList.remove('mono'); eye.title = 'Show password'; return }
      const r = await ask<{ value: string }>({ type: 'copy-secret', id: it.id, field: 'password' })
      if (!r.ok) { toast(r.error ?? 'Could not show it.'); return }
      shown = true
      sub.textContent = r.value
      sub.classList.add('mono')
      eye.title = 'Hide password'
    }
    actions.prepend(eye)
  }
  const row = h('div', { class: 'row item', tabindex: '0', role: 'button', 'data-testid': 'popup-item', title: fillable ? 'Fill on this page' : '' },
    avatar(it.site ?? it.title),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, it.title), sub),
    actions,
    fillable ? h('span', { class: 'icon-btn', 'aria-hidden': 'true', style: 'color:var(--accent)' }, icon('fill')) : null)
  const act = () => { if (fillable) void fillTab(it); else void copy(it.id, 'password', 'Password') }
  row.onclick = act
  row.onkeydown = (e) => { if (e.key === 'Enter') act() }
  return row
}

async function vaultView(st: State): Promise<HTMLElement> {
  const site = await ask<{ site: string; items: Item[] }>({ type: 'site-items', ...(panelWindow ? { windowId: panelWindow } : {}) })
  if (!site.ok && (site.code === 'vault_session_needed' || site.code === 'vault_locked')) return unlockView({ ...st, unlocked: false })
  if (!site.ok && site.code && DISCONNECTED.has(site.code)) return connectView({ connected: false, unlocked: false, serverUrl: st.serverUrl })
  const q = h('input', { class: 'input', type: 'search', id: 'q', placeholder: 'Search Walnut', 'aria-label': 'Search Walnut', autocomplete: 'off' })
  const list = h('div', { class: 'pane', style: 'padding-top:4px' })
  const siteItems = site.ok ? site.items : []

  const showSite = () => {
    list.replaceChildren()
    if (site.site) {
      list.append(h('div', { class: 'section-label' }, `For ${site.site}`))
      if (siteItems.length) for (const it of siteItems) list.append(itemRow(it, true))
      else list.append(h('div', { class: 'empty' }, 'No saved login for this site. Sign in and Walnut offers to save it.'))
    } else {
      list.append(h('div', { class: 'empty' }, 'Search your vault, or open a site to see its logins here.'))
    }
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
      h('button', { class: 'btn', type: 'button', onclick: () => void showGenerator(st) }, 'Generator'),
      h('button', { class: 'btn', type: 'button', onclick: () => void ask({ type: 'open-walnut' }) }, 'Open Walnut'),
      h('button', { class: 'btn', type: 'button', onclick: () => void showSettings(st) }, 'Settings')))
}

// ── the generator ──

function showGenerator(st: State): void {
  let words = false
  let length = 20
  let symbols = true
  const out = h('div', { class: 'gen-out mono', 'data-testid': 'gen-out', 'aria-live': 'polite' })
  const make = async () => {
    const options = words
      ? { kind: 'words', words: Math.max(3, Math.min(12, Math.round(length / 4))), separator: '-', capitalize: true, number: true }
      : { kind: 'random', length, upper: true, lower: true, digits: true, symbols, avoidAmbiguous: true }
    const r = await ask<{ value: string }>({ type: 'generate', options })
    out.textContent = r.ok ? r.value : r.error ?? ''
  }
  const lenLabel = h('span', { class: 'muted' }, '')
  const slider = h('input', { type: 'range', min: '8', max: '64', value: String(length), style: 'width:100%', 'aria-label': 'Length' })
  const syncLabel = () => { lenLabel.textContent = words ? `${Math.max(3, Math.min(12, Math.round(length / 4)))} words` : `${length} characters` }
  slider.oninput = () => { length = Number(slider.value); syncLabel(); void make() }
  const sym = h('input', { type: 'checkbox', id: 'sym', checked: true })
  sym.onchange = () => { symbols = sym.checked; void make() }
  const kind = h('input', { type: 'checkbox', id: 'kind' })
  kind.onchange = () => { words = kind.checked; syncLabel(); void make() }
  syncLabel()
  void make()
  root.replaceChildren(h('div', {},
    h('div', { class: 'top' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => void render() }, '‹'),
      h('h1', {}, 'Password generator')),
    h('div', { class: 'pane' }, out,
      h('div', { style: 'display:flex;gap:6px;margin-top:10px' },
        h('button', { class: 'btn btn-primary', type: 'button', style: 'flex:1', onclick: async () => { await navigator.clipboard.writeText(out.textContent ?? ''); toast('Password copied') } }, 'Copy'),
        h('button', { class: 'btn', type: 'button', onclick: () => void make() }, icon('dice'))),
      h('div', { style: 'display:flex;justify-content:space-between;margin-top:16px' }, h('span', {}, 'Length'), lenLabel), slider,
      h('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:10px' }, sym, 'Symbols'),
      h('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:6px' }, kind, 'Words instead of characters'),
      h('p', { class: 'muted', style: 'font-size:12px;margin-top:14px' }, 'On a sign-up page, Walnut offers a strong password in the field itself and saves it when you send the form.'))))
  void st
}

// ── settings ──

/** Agents in this browser: off until the person turns it on here. */
async function agentSection(): Promise<HTMLElement> {
  const st = await ask<{ on: boolean; tabs: number; screenshots: boolean }>({ type: 'agent-get' })
  const box = h('input', { type: 'checkbox', id: 'agents', 'data-testid': 'popup-agents', role: 'switch' }) as HTMLInputElement
  box.checked = !!st.on
  const note = h('p', { class: 'muted', style: 'margin:6px 4px 0;font-size:12px' },
    st.on
      ? `On. Agents open their own tabs in a separate Walnut window${st.tabs ? ` (${st.tabs} open now)` : ''}, never yours. They ask you before sending, buying, posting or deleting anything in your name. Which sites they may use: Walnut, Settings, Browser extension.`
      : 'Turning this on lets your Walnut agents open web pages in this browser (signed in as you), read them, click and type, with no ask per site. They use only tabs they open, in their own window, and ask you before sending, buying, posting or deleting in your name.')
  const err = errLine()
  box.onchange = async () => {
    err.textContent = ''
    if (box.checked) {
      const r = await ask({ type: 'agent-on' })
      if (!r.ok) { box.checked = false; err.textContent = r.error ?? 'Could not turn it on.'; return }
    } else {
      await ask({ type: 'agent-off' })
    }
    const fresh = await agentSection()
    wrap.replaceWith(fresh)
  }
  const wrap = h('div', {},
    h('div', { class: 'section-label' }, 'Agents'),
    h('label', { class: 'row switch-row', for: 'agents' },
      h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Let Walnut agents use this browser'), h('span', { class: 'row-sub' }, st.on ? 'On' : 'Off')),
      box),
    note, err)
  return wrap
}

async function showSettings(st: State): Promise<void> {
  const off = h('button', { class: 'btn', type: 'button', 'data-testid': 'popup-disconnect' }, 'Disconnect this browser')
  off.onclick = async () => { await ask({ type: 'disconnect' }); void render() }
  const agents = await agentSection()
  root.replaceChildren(h('div', {},
    h('div', { class: 'top' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => void render() }, '‹'),
      h('h1', {}, 'Settings')),
    h('div', { class: 'pane' },
      h('div', { class: 'section-label' }, 'Connected to'),
      h('div', { class: 'row' }, h('span', { class: 'logo' }, icon('key')),
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, st.serverUrl ?? ''), h('span', { class: 'row-sub' }, st.device ?? ''))),
      agents,
      h('div', { class: 'section-label' }, 'Fill shortcut'),
      h('p', { class: 'muted', style: 'margin:0 4px' }, 'Ctrl+Shift+L (⌘⇧L on a Mac) fills the login for the page, or opens the menu when there are several.'),
      h('div', { style: 'height:16px' }), off)))
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

void render()
