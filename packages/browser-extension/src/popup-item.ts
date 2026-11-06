/**
 * One item in the popup: its row in a list, and its detail view. A row fills the page when its
 * item fills there (a login on its own site, a card or an identity); any other row opens the
 * item. Every row has a details button, and copy buttons that copy in one click. The detail
 * view shows each field with its own copy (and reveal, for a secret), the one-time code, the
 * site to open, and Edit in Walnut. A shown secret hides again after a while or once the person
 * leaves the page.
 */
import { ask } from './ext'
import { avatar, h, icon, totpView } from './dom'
import { copyPlain, copySecret, errLine, iconButton, popupIcon, toast, topBar } from './popup-ui'
import { currentView, isCurrent, nextView, paint } from './popup-view'
import { webUrl, type DetailField, type ItemDetail } from './popup-item-data'

export { fillTab, type Item, type PopupCtx } from './popup-fill'
import { fillTab, lockedReply, type Item, type PopupCtx } from './popup-fill'

/** How long a shown secret stays on show. */
export const REVEAL_MS = 20_000

const isLogin = (it: Item) => !it.type || it.type === 'login'

async function copy(id: string, field: string, what: string): Promise<void> {
  const g = currentView()
  const r = await ask<{ value: string }>({ type: 'copy-secret', id, field })
  // The view changed meanwhile (a Lock, another view): the answer is not acted on.
  if (!isCurrent(g)) return
  if (!r.ok) { toast(r.error ?? 'Could not copy.'); return }
  await copySecret(r.value, what)
}

/** A login's current one-time code with its countdown; a click copies it. */
function codeChip(it: Item): HTMLElement {
  const chip = h('button', { class: 'totp-chip', type: 'button', 'aria-label': 'Copy one-time code', 'data-tip': 'Copy one-time code', 'data-testid': 'popup-totp' }) as HTMLButtonElement
  const load = async () => {
    const t = await ask<{ code: string; period: number; remaining: number }>({ type: 'totp-code', id: it.id })
    if (!t.ok) { chip.remove(); return }
    chip.replaceChildren(totpView(t, () => { if (chip.isConnected) void load() }))
    chip.onclick = (e: Event) => { e.stopPropagation(); void copySecret(t.code, 'Code') }
  }
  void load()
  return chip
}

/** Show a secret in `target` for a while; `restore` puts back what it showed before. */
function revealer(id: string, field: string, target: HTMLElement, button: HTMLButtonElement, restore: () => void, what = 'password'): () => Promise<void> {
  let shown = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const label = (on: boolean) => {
    const text = `${on ? 'Hide' : 'Show'} ${what}`
    button.setAttribute('aria-label', text)
    button.dataset.tip = text
    button.replaceChildren(on ? popupIcon('eyeOff') : icon('eye'))
  }
  const hide = () => {
    clearTimeout(timer)
    shown = false
    restore()
    target.classList.remove('revealed')
    label(false)
    document.removeEventListener('visibilitychange', hide)
  }
  return async () => {
    if (shown) { hide(); return }
    const g = currentView()
    const r = await ask<{ value: string }>({ type: 'copy-secret', id, field })
    if (!isCurrent(g)) return
    if (!r.ok) { toast(r.error ?? 'Could not show it.'); return }
    shown = true
    target.textContent = r.value
    target.classList.add('revealed')
    label(true)
    // Never left on show: hidden again after a while, or once the person leaves this page.
    timer = setTimeout(hide, REVEAL_MS)
    document.addEventListener('visibilitychange', hide)
  }
}

export function itemRow(it: Item, fillable: boolean, ctx: PopupCtx): HTMLElement {
  const card = it.type === 'card'
  const actions = h('div', { class: 'item-actions' },
    it.username ? iconButton(icon('user'), 'Copy username', () => void copy(it.id, 'username', 'Username'), { class: 'icon-btn act-user' }) : null,
    isLogin(it) || it.type === 'api_key' ? iconButton(icon('copy'), 'Copy password', () => void copy(it.id, 'password', 'Password'), { 'data-testid': 'copy-password' }) : null,
    card ? iconButton(icon('copy'), 'Copy card number', () => void copy(it.id, 'number', 'Card number'), { 'data-testid': 'copy-number' }) : null,
    card ? iconButton(popupIcon('hash'), 'Copy security code', () => void copy(it.id, 'code', 'Security code')) : null,
    // On hover the code's chip gives way to the buttons; its copy is one of them.
    it.hasTotp && isLogin(it) ? iconButton(icon('clock'), 'Copy one-time code', () => void copy(it.id, 'totp', 'Code'), { 'data-testid': 'copy-totp' }) : null)
  const subText = it.sub || it.username || it.site || (it.type === 'identity' ? 'Identity' : '')
  const sub = h('span', { class: 'row-sub' }, subText)
  // In the side panel there is room to show a password; it hides again on the next click.
  if (ctx.embedded && isLogin(it)) {
    const eye = iconButton(icon('eye'), 'Show password', () => void show(), { class: 'icon-btn act-reveal', 'data-testid': 'reveal-password' })
    const show = revealer(it.id, 'password', sub, eye, () => { sub.textContent = subText })
    actions.prepend(eye)
  }
  // A card or an identity fills the page's form; a login fills only on its own site.
  const fills = fillable || it.type === 'card' || it.type === 'identity'
  const open = () => void detailView(it, fills, ctx)
  const row = h('div', { class: 'row item', tabindex: '0', role: 'button', 'data-testid': 'popup-item', 'aria-label': `${it.title}: ${fills ? 'fill on this page' : 'show details'}` },
    card ? h('span', { class: 'avatar', style: 'background:#5b4fa8' }, icon('card')) : it.type === 'identity' ? h('span', { class: 'avatar', style: 'background:#2f7f7a' }, icon('person')) : avatar(it.site ?? it.title),
    // Whole on hover when the row has to cut it.
    h('span', { class: 'row-text', title: [it.title, subText].filter(Boolean).join('\n') }, h('span', { class: 'row-title' }, it.title), sub),
    actions,
    it.hasTotp && isLogin(it) ? codeChip(it) : null,
    fills ? h('button', { class: 'fill-pill', type: 'button', 'data-testid': 'popup-fill', onclick: (e: Event) => { e.stopPropagation(); void fillTab(it, ctx) } }, 'Fill') : null,
    iconButton(popupIcon('next'), 'Show details', open, { class: 'icon-btn row-open', 'data-testid': 'popup-open-item' }))
  const act = () => { if (fills) void fillTab(it, ctx); else open() }
  row.onclick = act
  row.onkeydown = (e) => { if (e.key === 'Enter' && e.target === row) act(); if (e.key === 'ArrowRight' && e.target === row) open() }
  return row
}

const TYPE_LABEL: Record<string, string> = { login: 'Login', card: 'Card', identity: 'Identity', api_key: 'API key', note: 'Secure note' }

function fieldRow(d: ItemDetail, f: DetailField): HTMLElement {
  const value = h('div', { class: `field-value${f.mono ? ' mono' : ''}${f.multiline ? ' multiline' : ''}`, 'data-testid': 'detail-value' }, f.value ?? '')
  const shown = f.value ?? ''
  const buttons = h('div', { class: 'field-actions' })
  const what = f.label.toLowerCase()
  let copyIt: () => void
  if (f.secret === 'totp') {
    const load = async () => {
      const t = await ask<{ code: string; period: number; remaining: number }>({ type: 'totp-code', id: d.id })
      if (!t.ok) { value.textContent = t.error ?? 'No code.'; return }
      value.replaceChildren(totpView(t, () => { if (value.isConnected) void load() }))
    }
    void load()
    copyIt = () => void copy(d.id, 'totp', 'Code')
  } else if (f.secret) {
    const eye = iconButton(icon('eye'), `Show ${what}`, () => void show(), { 'data-testid': 'detail-reveal' })
    const show = revealer(d.id, f.secret, value, eye, () => { value.textContent = shown }, what)
    buttons.append(eye)
    copyIt = () => void copy(d.id, f.secret!, f.label)
  } else {
    copyIt = () => void copyPlain(f.url ?? shown, f.label)
  }
  const open = f.url ? webUrl(f.url) : undefined
  if (open) buttons.append(iconButton(icon('out'), 'Open site', () => window.open(open, '_blank', 'noopener'), { 'data-testid': 'detail-open-site' }))
  buttons.append(iconButton(icon('copy'), `Copy ${what}`, copyIt, { 'data-testid': 'detail-copy' }))
  // As in a password manager's item view: a click anywhere on the field copies it.
  const row = h('div', { class: 'field', 'data-testid': 'detail-field', 'data-label': f.label, tabindex: '0' },
    h('div', { class: 'field-text' }, h('div', { class: 'field-name' }, f.label), value), buttons)
  row.onclick = () => copyIt()
  row.onkeydown = (e) => { if (e.key === 'Enter' && e.target === row) copyIt() }
  return row
}

/** One item opened in the popup: every field, each copied in one click. */
export async function detailView(it: Item, fills: boolean, ctx: PopupCtx): Promise<void> {
  const g = nextView()
  const r = await ask<{ item: ItemDetail }>({ type: 'item-detail', id: it.id })
  // A Lock (or any other view) came first: this late answer draws nothing.
  if (!isCurrent(g)) return
  if (lockedReply(r)) { ctx.back(); return }
  const back = topBar(TYPE_LABEL[it.type ?? 'login'] ?? 'Item', ctx.back)
  if (!r.ok) { paint(ctx.root, h('div', {}, back, h('div', { class: 'pane' }, errLine(r.error ?? 'Could not open it.'))), g, 'neutral'); return }
  const d = r.item
  const tile = d.type === 'card' ? h('span', { class: 'avatar avatar-lg', style: 'background:#5b4fa8' }, icon('card'))
    : d.type === 'identity' ? h('span', { class: 'avatar avatar-lg', style: 'background:#2f7f7a' }, icon('person'))
    : avatar(d.site ?? d.title)
  tile.classList.add('avatar-lg')
  const siteUrl = d.fields.map((f) => (f.url ? webUrl(f.url) : undefined)).find(Boolean)
  const head = h('div', { class: 'detail-head' }, tile,
    h('div', { class: 'detail-title' }, h('h2', { 'data-testid': 'detail-title' }, d.title), h('span', { class: 'row-sub' }, d.site ?? TYPE_LABEL[d.type] ?? '')),
    fills ? h('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'detail-fill', onclick: () => void fillTab(d, ctx) }, 'Fill') : null)
  const fields = d.fields.length
    ? h('div', { class: 'group' }, ...d.fields.map((f) => fieldRow(d, f)))
    : h('div', { class: 'empty' }, 'Nothing saved in this item yet.')
  paint(ctx.root, h('div', { class: 'view', 'data-testid': 'popup-detail' },
    back,
    h('div', { class: 'pane' }, head, fields),
    h('div', { class: 'foot' },
      siteUrl ? h('button', { class: 'btn', type: 'button', 'data-testid': 'detail-open-site-foot', onclick: () => window.open(siteUrl, '_blank', 'noopener') }, icon('out'), h('span', {}, 'Open site')) : null,
      h('button', { class: 'btn', type: 'button', 'data-testid': 'detail-edit', onclick: () => void ask({ type: 'open-walnut', item: d.id }) }, popupIcon('edit'), h('span', {}, 'Edit in Walnut')))), g, 'unlocked')
}
