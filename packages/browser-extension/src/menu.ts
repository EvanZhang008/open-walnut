/**
 * The menu under a field (an extension page in an iframe, so the page cannot read it): the
 * logins saved for this site, one-time codes with their countdown, a strong password made to
 * fit a new-password field, cards, identities, or the one step that comes first (connect,
 * unlock). It asks the background what to show; the background answers from the tab and frame
 * that opened it.
 *
 * Logins in three parts: this site's (tier 1, first), "Other logins" of this site when step one
 * of a two-step sign in already named the account, and "Saved for other parts of <domain>"
 * (tier 2: each row says the host it is saved for; never picked unless the person picks it).
 * What the person types in the field narrows the rows (content-ui.ts sends it).
 *
 * Keys: a listbox with aria-activedescendant. The page script moves the keyboard here on
 * ArrowDown (through the background: menu-focus); ArrowUp / ArrowDown / Home / End pick a row,
 * Enter fills it, Escape and Tab close the menu and give the field its focus back. An Enter that
 * comes before the keys were handed over (typed fast after the ArrowDown) waits a moment for
 * them, and then fills the first login of this site, never one of another part of it.
 */
import { ask as askBackground, ext } from './ext'
import { avatar, h, icon, totpView } from './dom'
import { frameGuard } from './frame-guard'
import { currentNonce, onNonce, onUnlockChange } from './nonce'

/** The nonce the content script hands this frame (nonce.ts): every message carries it. */
const ask = <T = Record<string, unknown>>(msg: { type: string; [k: string]: unknown }) => askBackground<T>({ ...msg, nonce: currentNonce() })
const guard = frameGuard()

interface Totp { code: string; period: number; remaining: number }
interface Item { id: string; title: string; username?: string; site?: string; hasTotp: boolean; sub?: string; totp?: Totp | null; tier?: number }
interface Data {
  state: 'not-connected' | 'locked' | 'unlocked'; role: string; kind: string; site?: string; items?: Item[]; suggestion?: string; insecure?: number
  /** This site's other logins, when `items` is the account step one named. */
  more?: Item[]
  /** Logins saved for other parts of this site (tier 2), and the site's domain for their heading. */
  others?: Item[]; othersDomain?: string
}

const root = document.getElementById('root')!
/** The rows the keys move through, and the one picked. */
let rows: HTMLElement[] = []
let current = -1
let list: HTMLElement | null = null
/** The background said the person's keys came here (menu-focus): only then does Enter fill. */
let armed = false
let wantFocus: 'first' | 'last' | null = null
let codeTimer = 0
/** An Enter that came before the keys were handed over: when, so it still counts a moment later. */
let pendingPick = 0
/** Arrow keys pressed in the menu before the keys were handed over (menu-focus): the rows to move once they are. */
let early = 0
/** What the person typed in the field (content-ui.ts): only the rows that fit it show. */
let filterText = ''

/**
 * The height the menu needs, told to the page script, which may give it less (a short frame):
 * then the list scrolls inside what it got. 0 when every row is filtered out.
 */
function size(): void {
  if (list) list.style.maxHeight = ''
  // Every login filtered out by what was typed: the menu steps out of the way (height 0).
  const shown = !list || rows.length > 0 || !list.querySelector('[role=option]')
  const height = shown ? Math.ceil(document.body.getBoundingClientRect().height) + 2 : 0
  void ask({ type: 'menu-size', height })
  fit()
}

/** The frame is shorter than the menu: the list gives up what does not fit, and scrolls. */
function fit(): void {
  if (!list) return
  list.style.maxHeight = ''
  const over = Math.ceil(document.body.getBoundingClientRect().height) + 2 - innerHeight
  if (over > 0) list.style.maxHeight = `${Math.max(48, list.clientHeight - over)}px`
}
addEventListener('resize', fit)

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

/** Nothing to offer: one short, complete sentence, wrapped (never cut with an ellipsis). */
function emptyRow(text: string): HTMLElement {
  return h('div', { class: 'menu-state', 'data-testid': 'menu-empty' }, h('span', { class: 'logo' }, icon('key')), h('p', { class: 'menu-empty' }, text))
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
    const more = d.more ?? []
    const others = (d.others ?? []).map((it) => ({ ...it, tier: 2 }))
    const what = d.role === 'card' ? 'cards' : d.role === 'identity' ? 'identities' : d.role === 'totp' ? 'one-time codes' : 'logins'
    list = h('div', { class: 'menu-list', role: 'listbox', tabindex: '0', 'aria-label': `Walnut ${what}` })
    if (d.role === 'new-password') list.append(suggestionRow(d.suggestion ?? ''))
    // An older background sends every login in `items`, tier 2 ones marked: they go under their heading too.
    const near = items.filter((it) => it.tier !== 2)
    const far = [...items.filter((it) => it.tier === 2), ...others]
    for (const it of near) list.append(itemRow(d, it))
    if (more.length) section(list, 'Other logins', more.map((it) => itemRow(d, it)))
    if (far.length) section(list, `Saved for other parts of ${d.othersDomain || domainOf(d.site)}`, far.map((it) => itemRow(d, it)))
    rows = [...list.querySelectorAll<HTMLElement>('[role=option]')]
    // Only logins of other parts of the site: their heading says it all, no empty line above it.
    if (!near.length && !more.length && !far.length && d.role !== 'new-password') list.prepend(emptyFor(d))
    const head = d.role === 'card' ? 'Walnut · Cards' : d.role === 'identity' ? 'Walnut · Identities' : `Walnut · ${d.site ?? ''}`
    root.append(h('div', { class: 'menu-head' }, icon('key'), head), list)
    scheduleCodes(d, items)
    if (filterText) applyFilter(filterText, false)
  }
  requestAnimationFrame(() => { size(); if (wantFocus) focusList(wantFocus); tryPendingPick() })
}

/** A heading in the list, and its rows under it (the heading is no row: the keys skip it). */
function section(into: HTMLElement, title: string, items: HTMLElement[]): void {
  into.append(h('div', { class: 'menu-sub', role: 'presentation' }, title), ...items)
}

/** "lab.test" for "shop.lab.test": the heading's name for the site when the background gives none. */
function domainOf(host = ''): string {
  const parts = host.replace(/:\d+$/, '').split('.')
  return parts.length > 2 ? parts.slice(-2).join('.') : host
}

/** Only the rows that fit what the person typed (title, username or site); none: the menu steps away. */
function applyFilter(text: string, resize = true): void {
  filterText = text
  if (!list) return
  const q = text.trim().toLowerCase()
  const all = [...list.querySelectorAll<HTMLElement>('[role=option]')]
  for (const r of all) r.hidden = !!q && r.dataset.generate !== '1' && !(r.dataset.match ?? '').includes(q)
  for (const sub of list.querySelectorAll<HTMLElement>('.menu-sub')) {
    let n = sub.nextElementSibling
    let any = false
    while (n && !n.classList.contains('menu-sub')) { if (n.getAttribute('role') === 'option' && !(n as HTMLElement).hidden) any = true; n = n.nextElementSibling }
    sub.hidden = !any
  }
  rows = all.filter((r) => !r.hidden)
  if (!rows.includes(all[current])) current = -1
  if (current < 0 && rows.length && list.getAttribute('aria-activedescendant')) setCurrent(0)
  if (resize) size()
}

function emptyFor(d: Data): HTMLElement {
  if (d.role === 'totp') return emptyRow(`No one-time code saved for ${d.site}.`)
  if (d.role === 'card') return emptyRow('No card saved yet. Add one in Walnut, under Passwords.')
  if (d.role === 'identity') return emptyRow('No identity saved yet. Add one in Walnut, under Passwords.')
  // A plain http page and a login saved for https: say so, rather than "nothing saved".
  if (d.insecure) return emptyRow(`Not offered on this page: ${d.site} is not secure (http), and your login is saved for its https address.`)
  return emptyRow(`No login saved for ${d.site} yet. Walnut offers to save one when you sign in.`)
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
  row.dataset.generate = '1'
  return row
}

function itemRow(d: Data, it: Item): HTMLElement {
  const base = d.role === 'card' ? (it.sub ?? 'Card') : d.role === 'identity' ? 'Fill your details' : d.role === 'totp' ? (it.username ?? 'Fill the one-time code') : it.username
  // A login of another part of the site says which part, so the person knows what they pick.
  const sub = it.tier === 2 && it.site ? [base, it.site].filter(Boolean).join(' · ') : base
  const code = d.role === 'totp' && it.totp ? totpView(it.totp) : null
  const row = option(it.id, () => void fill(it.id),
    avatar(it.site ?? it.title),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, it.title), sub ? h('span', { class: 'row-sub' }, sub) : null),
    code)
  row.dataset.match = [it.title, it.username, it.site].filter(Boolean).join(' ').toLowerCase()
  if (it.tier === 2) row.dataset.tier = '2'
  return row
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
    // The menu stays with the reason; Escape or a click outside closes it.
    root.replaceChildren(h('div', { class: 'menu-state' }, h('span', { class: 'logo' }, icon('warn')),
      h('div', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Walnut did not fill this'), h('span', { class: 'err wrap', role: 'alert' }, r.error))))
    list = null
    rows = []
    size()
  }
}

function focusList(where: 'first' | 'last'): void {
  wantFocus = null
  if (!list || !rows.length) { list?.focus(); return }
  list.focus()
  // Arrow keys that came before the keys were handed over count from the row the hand-over picks.
  setCurrent((where === 'last' ? rows.length - 1 : 0) + early)
  early = 0
}

/**
 * An Enter that came before the keys were handed over (or one the page script held for us, `pick`):
 * once they are, and the rows are drawn, it fills the first login of this site. A login saved for
 * another part of the site is filled only when the person picks it themself.
 */
function tryPendingPick(): void {
  if (!pendingPick) return
  if (Date.now() - pendingPick > 2500) { pendingPick = 0; return }
  if (!armed || !rows.length || current < 0) return
  pendingPick = 0
  if (rows[current]?.dataset.tier !== '2') pickCurrent()
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
  // The keyboard came here (the field's ArrowDown) before the background said so (menu-focus): a
  // second ArrowDown typed at once is kept and counted from the first row, never lost to it.
  if (!armed && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); early += e.key === 'ArrowDown' ? 1 : -1; return }
  if (e.key === 'Enter' && !rows.length) { e.preventDefault(); pendingPick = Date.now(); return }
  if (!rows.length) return
  if (e.key === 'ArrowDown') { e.preventDefault(); setCurrent(current + 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setCurrent(current - 1) }
  else if (e.key === 'Home') { e.preventDefault(); setCurrent(0) }
  else if (e.key === 'End') { e.preventDefault(); setCurrent(rows.length - 1) }
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    if (armed && current >= 0) pickCurrent()
    else if (e.key === 'Enter') { pendingPick = Date.now(); tryPendingPick() }
  }
})
let closing = ''
document.addEventListener('keyup', (e) => {
  if (!e.isTrusted || e.key !== closing) return
  closing = ''
  void ask({ type: 'menu-close', refocus: true })
})
// A click in the menu is the person's own: keys may act from then on.
document.addEventListener('pointerdown', (e) => { if (e.isTrusted) { armed = true; early = 0 } })
addEventListener('blur', () => { armed = false })

// The page script moved the person's keys here (through the background, so a page cannot).
const pendingFocus: Array<{ nonce: string; where: 'first' | 'last'; pick: boolean }> = []
function applyFocus(m: { nonce: string; where: 'first' | 'last'; pick: boolean }): void {
  if (m.nonce !== currentNonce()) return
  armed = true
  if (m.pick) pendingPick = Date.now()
  if (rows.length || list) { focusList(m.where); tryPendingPick() }
  else wantFocus = m.where
}
ext.runtime.onMessage.addListener((m: { type?: string; nonce?: string; where?: string; pick?: boolean }) => {
  if (m?.type !== 'menu-focus' || typeof m.nonce !== 'string') return
  const req = { nonce: m.nonce, where: m.where === 'last' ? 'last' as const : 'first' as const, pick: m.pick === true }
  if (!currentNonce()) pendingFocus.push(req)
  else applyFocus(req)
})

// What the person types in the field, from the page script that framed this menu.
addEventListener('message', (e) => {
  if (e.source !== window.parent) return
  const t = (e.data as { walnutFilter?: unknown } | null)?.walnutFilter
  if (typeof t === 'string') applyFilter(t)
})

// Drawn once the nonce arrives, and again when the vault is unlocked or locked meanwhile.
onNonce(() => { for (const m of pendingFocus.splice(0)) applyFocus(m); void render() })
onUnlockChange(() => void render())
