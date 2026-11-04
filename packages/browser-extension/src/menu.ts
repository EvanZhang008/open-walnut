/**
 * The menu under a field (an extension page in an iframe, so the page cannot read it): the
 * logins saved for this site, one-time codes with their countdown, a strong password made to
 * fit a new-password field, cards, identities, or the one step that comes first (connect,
 * unlock). It asks the background what to show; the background answers from the tab and frame
 * that opened it.
 *
 * Keys: a listbox with aria-activedescendant. The page script moves the keyboard here on
 * ArrowDown (through the background: menu-focus); ArrowUp / ArrowDown / Home / End pick a row,
 * Enter fills it, Escape and Tab close the menu and give the field its focus back.
 */
import { ask as askBackground, ext } from './ext'
import { avatar, h, icon, totpView } from './dom'
import { frameGuard } from './frame-guard'
import { currentNonce, onNonce, onUnlockChange } from './nonce'

/** The nonce the content script hands this frame (nonce.ts): every message carries it. */
const ask = <T = Record<string, unknown>>(msg: { type: string; [k: string]: unknown }) => askBackground<T>({ ...msg, nonce: currentNonce() })
const guard = frameGuard()

interface Totp { code: string; period: number; remaining: number }
interface Item { id: string; title: string; username?: string; site?: string; hasTotp: boolean; sub?: string; totp?: Totp | null }
interface Data { state: 'not-connected' | 'locked' | 'unlocked'; role: string; kind: string; site?: string; items?: Item[]; suggestion?: string; insecure?: number }

const root = document.getElementById('root')!
/** The rows the keys move through, and the one picked. */
let rows: HTMLElement[] = []
let current = -1
let list: HTMLElement | null = null
/** The background said the person's keys came here (menu-focus): only then does Enter fill. */
let armed = false
let wantFocus: 'first' | 'last' | null = null
let codeTimer = 0

function size(): void {
  void ask({ type: 'menu-size', height: Math.ceil(document.body.getBoundingClientRect().height) + 2 })
}

function stateRow(ic: 'lock' | 'key', title: string, sub: string, button: string, type: string): HTMLElement {
  return h('div', { class: 'menu-state' },
    h('span', { class: 'logo' }, icon(ic)),
    h('div', { class: 'row-text' }, h('span', { class: 'row-title' }, title), h('span', { class: 'row-sub' }, sub)),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: guard.wrap(() => void ask({ type })) }, button))
}

function setCurrent(i: number): void {
  if (!rows.length || !list) return
  current = (i + rows.length) % rows.length
  rows.forEach((r, n) => r.setAttribute('aria-selected', String(n === current)))
  list.setAttribute('aria-activedescendant', rows[current].id)
  rows[current].scrollIntoView({ block: 'nearest' })
}

function option(id: string, onPick: () => void, ...children: Array<Node | null>): HTMLElement {
  const el = h('div', { class: 'row option', role: 'option', id: `opt-${id}`, 'aria-selected': 'false', 'data-testid': 'menu-item', onclick: guard.wrap(onPick) }, ...children)
  ;(el as HTMLElement & { pick?: () => void }).pick = onPick
  el.addEventListener('mousemove', () => { const i = rows.indexOf(el); if (i >= 0 && i !== current) setCurrent(i) })
  return el
}

function emptyRow(title: string, sub: string): HTMLElement {
  return h('div', { class: 'menu-state' }, h('span', { class: 'logo' }, icon('key')),
    h('div', { class: 'row-text' }, h('span', { class: 'row-title' }, title), h('span', { class: 'row-sub' }, sub)))
}

async function render(): Promise<void> {
  const d = await ask<Data>({ type: 'menu-data' })
  root.replaceChildren()
  rows = []
  current = -1
  clearTimeout(codeTimer)
  if (!d.ok) { void ask({ type: 'menu-close' }); return }
  if (d.state === 'not-connected') {
    root.append(stateRow('key', 'Connect Walnut', 'Fill passwords from your Walnut vault.', 'Connect', 'menu-connect'))
  } else if (d.state === 'locked') {
    root.append(stateRow('lock', 'Walnut is locked', 'Unlock to fill this login.', 'Unlock', 'menu-unlock'))
  } else {
    const items = d.items ?? []
    const what = d.role === 'card' ? 'cards' : d.role === 'identity' ? 'identities' : d.role === 'totp' ? 'one-time codes' : 'logins'
    list = h('div', { class: 'menu-list', role: 'listbox', tabindex: '0', 'aria-label': `Walnut ${what}` })
    if (d.role === 'new-password') list.append(suggestionRow(d.suggestion ?? ''))
    for (const it of items) list.append(itemRow(d, it))
    rows = [...list.querySelectorAll<HTMLElement>('[role=option]')]
    if (!items.length && d.role !== 'new-password') list.append(emptyFor(d))
    const head = d.role === 'card' ? 'Walnut · Cards' : d.role === 'identity' ? 'Walnut · Identities' : `Walnut · ${d.site ?? ''}`
    root.append(h('div', { class: 'menu-head' }, icon('key'), head), list)
    scheduleCodes(d, items)
  }
  requestAnimationFrame(() => { size(); if (wantFocus) focusList(wantFocus) })
}

function emptyFor(d: Data): HTMLElement {
  if (d.role === 'totp') return emptyRow('No one-time code saved', `for ${d.site}`)
  if (d.role === 'card') return emptyRow('No card saved', 'Add one in Walnut, Passwords.')
  if (d.role === 'identity') return emptyRow('No identity saved', 'Add one in Walnut, Passwords.')
  // A plain http page and a login saved for https: say so, rather than "nothing saved".
  if (d.insecure) return emptyRow('Not offered on this page', `${d.site} is not secure (http). Your login is saved for its https address, so Walnut does not fill it here.`)
  return emptyRow('No saved login', `for ${d.site}. Walnut offers to save it when you sign in.`)
}

function suggestionRow(value: string): HTMLElement {
  const shown = h('span', { class: 'row-sub mono suggestion', 'data-testid': 'menu-suggestion' }, value)
  const again = h('button', { class: 'icon-btn', type: 'button', tabindex: '-1', title: 'Make another', 'aria-label': 'Make another password', 'data-testid': 'menu-regenerate' }, icon('dice'))
  again.addEventListener('click', guard.wrap((e: Event) => {
    e.stopPropagation()
    void ask<{ suggestion: string }>({ type: 'menu-regenerate' }).then((r) => { if (r.ok) shown.textContent = r.suggestion })
  }))
  const row = option('generate', () => void ask({ type: 'menu-generate' }),
    h('span', { class: 'logo' }, icon('dice')),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Use a strong password'), shown),
    again)
  row.dataset.testid = 'menu-generate'
  return row
}

function itemRow(d: Data, it: Item): HTMLElement {
  const sub = d.role === 'card' ? (it.sub ?? 'Card') : d.role === 'identity' ? 'Fill your details' : d.role === 'totp' ? (it.username ?? 'Fill the one-time code') : it.username
  const code = d.role === 'totp' && it.totp ? totpView(it.totp) : null
  return option(it.id, () => void fill(it.id),
    avatar(it.site ?? it.title),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, it.title), sub ? h('span', { class: 'row-sub' }, sub) : null),
    code)
}

/** The codes are good until their countdown ends: then the next ones. */
function scheduleCodes(d: Data, items: Item[]): void {
  if (d.role !== 'totp') return
  const next = Math.min(...items.map((i) => i.totp?.remaining ?? Infinity))
  if (!Number.isFinite(next)) return
  codeTimer = window.setTimeout(() => void render(), next * 1000 + 300)
}

async function fill(id: string): Promise<void> {
  const r = await ask<{ code?: string }>({ type: 'menu-fill', id })
  if (r.ok && r.code) {
    // The background has no clipboard here: this frame copies the code, with the person's click.
    const copied = await navigator.clipboard.writeText(r.code).then(() => true, () => false)
    void ask({ type: copied ? 'menu-copied' : 'menu-close', ...(copied ? { value: r.code } : {}) })
    return
  }
  if (!r.ok && r.error) {
    root.replaceChildren(h('div', { class: 'menu-state' }, h('span', { class: 'err', role: 'alert' }, r.error)))
    size()
  }
}

function focusList(where: 'first' | 'last'): void {
  wantFocus = null
  if (!list || !rows.length) { list?.focus(); return }
  list.focus()
  setCurrent(where === 'last' ? rows.length - 1 : 0)
}

/** Enter on the picked row: only once the frame may act (frame-guard.ts), waiting the moment out. */
function pickCurrent(): void {
  const row = rows[current] as (HTMLElement & { pick?: () => void }) | undefined
  if (!row?.pick || !armed) return
  const go = (tries: number) => {
    if (guard.allowed()) row.pick!()
    else if (tries > 0) setTimeout(() => go(tries - 1), 100)
  }
  go(8)
}

document.addEventListener('keydown', (e) => {
  if (!e.isTrusted) return
  // Closed when the key comes up, so the whole key press stays in this frame.
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closing = e.key; return }
  if (!rows.length) return
  if (e.key === 'ArrowDown') { e.preventDefault(); setCurrent(current + 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setCurrent(current - 1) }
  else if (e.key === 'Home') { e.preventDefault(); setCurrent(0) }
  else if (e.key === 'End') { e.preventDefault(); setCurrent(rows.length - 1) }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickCurrent() }
})
let closing = ''
document.addEventListener('keyup', (e) => {
  if (!e.isTrusted || e.key !== closing) return
  closing = ''
  void ask({ type: 'menu-close', refocus: true })
})
// A click in the menu is the person's own: keys may act from then on.
document.addEventListener('pointerdown', (e) => { if (e.isTrusted) armed = true })
addEventListener('blur', () => { armed = false })

// The page script moved the person's keys here (through the background, so a page cannot).
const pendingFocus: Array<{ nonce: string; where: 'first' | 'last' }> = []
function applyFocus(m: { nonce: string; where: 'first' | 'last' }): void {
  if (m.nonce !== currentNonce()) return
  armed = true
  if (rows.length || list) focusList(m.where)
  else wantFocus = m.where
}
ext.runtime.onMessage.addListener((m: { type?: string; nonce?: string; where?: string }) => {
  if (m?.type !== 'menu-focus' || typeof m.nonce !== 'string') return
  const req = { nonce: m.nonce, where: m.where === 'last' ? 'last' as const : 'first' as const }
  if (!currentNonce()) pendingFocus.push(req)
  else applyFocus(req)
})

// Drawn once the nonce arrives, and again when the vault is unlocked or locked meanwhile.
onNonce(() => { for (const m of pendingFocus.splice(0)) applyFocus(m); void render() })
onUnlockChange(() => void render())
