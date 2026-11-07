/**
 * The key popover: Passwords for the page the person is on, drawn by the side panel's (or the
 * toolbar popup's) own page over Walnut's Ask frame, under that frame's key button (panel-ask.ts).
 * The vault never enters a Walnut page: the frame only says where its key is.
 *
 * Locked, it is one row: the master password and Unlock, the unlock this extension already has
 * (Walnut's setting decides how long it lasts, 48 hours after the last use by default), then this
 * site's logins once unlocked, each with Fill. Locked, the row shows on every page, a Walnut page
 * or one with no logins too (R1-9). Its foot opens the full Passwords view, the extension's
 * Settings (where agents in this browser are turned on, R1-7) and Walnut's vault. It follows the
 * vault as the popup does: a Lock all elsewhere brings the row back.
 */
import { ask, ext } from './ext'
import { pageHost } from './unlock-words'
import { avatar, h, icon } from './dom'
import { errLine, hintLine } from './popup-ui'
import { fillTab, type Item, type PopupCtx } from './popup-fill'
import { carryTyped, currentView, isCurrent, nextView } from './popup-view'
import { sendUnlock, unlockRefusal } from './unlock-send'

export interface KeyPop {
  /** Open under `rect` (this page's coordinates), or close when it is open. */
  toggle: (rect: { top: number; right: number; bottom: number; left: number }) => void
  close: () => void
  isOpen: () => boolean
  /** Draw again (the vault locked or unlocked, the person moved to another page). */
  refresh: () => void
}

const LOCKED = new Set(['vault_session_needed', 'vault_locked'])
const DISCONNECTED = new Set(['not_connected', 'not_paired', 'token_refused'])
const WIDTH = 320

/** How long an unlock made here lasts, in one line (popup-settings.ts says it in full). */
export function unlockLine(r: { autoLock?: string; unlockFor?: string }): string {
  if (r.autoLock && r.autoLock !== 'walnut') {
    const m = Number(r.autoLock)
    if (m) return `Locks after ${m === 60 ? '1 hour' : `${m} minute${m === 1 ? '' : 's'}`} unused.`
    return 'Stays unlocked until the browser closes.'
  }
  switch (r.unlockFor) {
    case '48h': return 'Stays unlocked 48 hours, renewed on use.'
    case '12h': return 'Stays unlocked 12 hours.'
    case '1h': return 'Stays unlocked 1 hour.'
    case 'restart': return 'Stays unlocked until Walnut restarts.'
    case 'always': return 'Stays unlocked.'
    case 'idle': return 'Locks when unused for a while.'
    default: return ''
  }
}

/** The page this window shows, by its tab (locked, the vault cannot say which site it is). */
async function tabHost(windowId?: number): Promise<string> {
  try {
    const [t] = await ext.tabs.query(windowId !== undefined ? { active: true, windowId } : { active: true, lastFocusedWindow: true })
    return t?.url ? pageHost(t.url) : ''
  } catch { return '' }
}

export function keyPopover(o: {
  /** Where it is drawn: the panel's body, over the frame. */
  host: HTMLElement
  windowId?: number
  /** The side panel stays open after a fill; the toolbar popup closes (`inTab`: a test's tab, which stays). */
  surface: 'panel' | 'popup'
  inTab: boolean
  onSearchAll: () => void
  onSettings: () => void
  onOpenVault: () => void
  /** Opened or closed: the frame's key shows it pressed. */
  onChange: (open: boolean) => void
  /** The vault locked or unlocked here (an unlock in the popover): the panel tells the frame. */
  onVault: () => void
  /** Closed with the keys: focus goes back to the frame. */
  onEscape: () => void
}): KeyPop {
  let el: HTMLElement | null = null
  let anchor = { top: 0, right: 0, bottom: 0, left: 0 }

  const place = () => {
    if (!el) return
    const vw = o.host.clientWidth
    const w = Math.min(WIDTH, vw - 16)
    el.style.width = `${w}px`
    el.style.top = `${Math.round(anchor.bottom + 6)}px`
    el.style.left = `${Math.round(Math.max(8, Math.min(anchor.right - w, vw - w - 8)))}px`
  }

  const close = () => {
    if (!el) return
    el.remove()
    el = null
    nextView()
    o.onChange(false)
  }

  /** A fill's word: the filled page says it worked; an error stays in the popover (no toast over Ask's composer, R1-10). */
  let said: HTMLElement | null = null
  const ctx = (): PopupCtx => ({
    root: o.host, embedded: o.surface === 'panel', inWindow: o.inTab, panelWindow: o.windowId, back: () => void render(),
    say: (text) => { if (said) said.textContent = text },
  })

  const row = (it: Item) => {
    const fill = h('button', { class: 'btn btn-sm key-pop-fill', type: 'button', 'data-testid': 'key-pop-fill', 'aria-label': `Fill ${it.title}` }, 'Fill') as HTMLButtonElement
    fill.onclick = async () => {
      fill.disabled = true
      if (said) said.textContent = ''
      const ok = await fillTab(it, ctx())
      fill.disabled = false
      // Filled: the popover closes, as Fill does everywhere else, so the page under it shows its
      // filled form (review R3-9: in the popup's own window it stayed open with no word).
      if (ok) { close(); o.onEscape() }
    }
    return h('div', { class: 'key-pop-row', 'data-testid': 'key-pop-row' },
      avatar(it.site ?? it.title),
      h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, it.title), h('span', { class: 'row-sub' }, it.username || it.site || '')),
      fill)
  }

  async function lockedBody(host: string, err?: string): Promise<HTMLElement[]> {
    const g = currentView()
    const [status, length] = await Promise.all([
      ask<{ status: { setUp: boolean; hasSecretKey: boolean; hint?: string } }>({ type: 'vault-status' }),
      ask<{ autoLock?: string; unlockFor?: string }>({ type: 'unlock-for' }),
    ])
    if (!isCurrent(g)) return []
    if (status.ok && !status.status.setUp) {
      return [h('p', { class: 'key-pop-empty' }, 'Passwords is not set up yet. Make your vault in Walnut first.')]
    }
    const pw = h('input', { class: 'input', type: 'password', id: 'key-pw', autocomplete: 'current-password', 'aria-label': 'Master password', placeholder: 'Master password' }) as HTMLInputElement
    const sk = h('input', { class: 'input mono', id: 'key-sk', 'aria-label': 'Secret Key', placeholder: 'W1-XXXXXX-…', spellcheck: 'false' }) as HTMLInputElement
    const skWrap = h('div', { class: 'key-pop-sk', hidden: true }, h('label', { class: 'field-label', for: 'key-sk' }, 'The computer Walnut runs on does not hold your Secret Key: type it from your recovery kit.'), sk)
    const go = h('button', { class: 'btn btn-primary', type: 'submit', 'data-testid': 'key-pop-unlock' }, 'Unlock') as HTMLButtonElement
    const line = errLine(err ?? (!status.ok ? status.error : undefined))
    // The master password hint, as the full unlock has it (review R2-11): behind "Show hint", at once after a wrong password.
    const hint = hintLine(status.ok ? status.status.hint : undefined, 'key-pop')
    const form = h('form', { class: 'key-pop-unlock', 'data-testid': 'key-pop-unlock-row' },
      h('span', { class: 'key-pop-locked' }, icon('lock'), h('span', {}, 'Locked')), pw, go)
    form.onsubmit = async (e) => {
      e.preventDefault()
      if (!pw.value) { pw.focus(); return }
      go.disabled = true
      go.textContent = 'Unlocking…'
      line.textContent = ''
      // Walnut checking another unlock: this one waits its turn, never an error meanwhile.
      const r = await sendUnlock(pw.value, sk.value.trim(), { onWait: () => { go.textContent = 'Checking…' } })
      go.disabled = false
      go.textContent = 'Unlock'
      if (r.ok) { o.onVault(); void render(); return }
      if (r.code && DISCONNECTED.has(r.code)) { line.textContent = 'This browser is no longer connected to Walnut.'; return }
      if (r.code === 'secret_key_needed') { skWrap.hidden = false; sk.focus() } else pw.select()
      if (r.code === 'wrong_password') hint.show()
      line.textContent = unlockRefusal(r)
    }
    setTimeout(() => pw.focus(), 20)
    const note = unlockLine(length.ok ? length : {})
    return [form, hint.el, skWrap, line, note ? h('p', { class: 'key-pop-note' }, note) : null,
      h('p', { class: 'key-pop-empty', 'data-testid': 'key-pop-locked-empty' }, host ? "Unlock to see this site's logins." : 'Open a site to see its logins here.')].filter((x): x is HTMLElement => !!x)
  }

  async function render(): Promise<void> {
    if (!el) return
    const g = nextView()
    const site = await ask<{ site: string; items: Item[]; insecure?: number }>({ type: 'site-items', ...(o.windowId !== undefined ? { windowId: o.windowId } : {}) })
    if (!isCurrent(g) || !el) return
    // No site here (a Walnut page, a new tab): the vault was not asked, so its state is asked now.
    const locked = (!site.ok && !!site.code && LOCKED.has(site.code))
      || (site.ok && !site.site && await ask<{ unlocked: boolean }>({ type: 'vault-watch' }).then((v) => v.ok && !v.unlocked))
    const host = site.ok ? site.site : await tabHost(o.windowId)
    if (!isCurrent(g) || !el) return
    let body: HTMLElement[]
    if (locked) body = await lockedBody(host)
    else if (!site.ok) body = [errLine(site.error ?? 'Walnut did not answer.')]
    else if (!site.site) body = [h('p', { class: 'key-pop-empty' }, 'Open a site to see its logins here.')]
    else if (!site.items.length) {
      body = [h('p', { class: 'key-pop-empty' }, site.insecure
        ? `This page is not secure (http). Its logins are saved for the https address, so Walnut does not fill them here.`
        : 'No saved login for this site.')]
    } else body = site.items.map(row)
    if (!isCurrent(g) || !el) return
    const head = h('div', { class: 'key-pop-head' }, host ? `Passwords for ${host}` : 'Passwords')
    const foot = h('div', { class: 'key-pop-foot' },
      h('button', { class: 'link-btn key-pop-all', type: 'button', 'data-testid': 'key-pop-search-all', onclick: () => { close(); o.onSearchAll() } }, 'Search all logins'),
      h('span', { class: 'key-pop-foot-end' },
        h('button', { class: 'link-btn key-pop-settings', type: 'button', 'data-testid': 'key-pop-settings', title: 'Passwords and agents in this browser', onclick: () => { close(); o.onSettings() } }, 'Settings'),
        h('button', { class: 'link-btn key-pop-vault', type: 'button', 'data-testid': 'key-pop-open-vault', onclick: () => { close(); o.onOpenVault() } }, 'Open vault')))
    said = h('p', { class: 'err key-pop-said', role: 'alert', 'data-testid': 'key-pop-said' })
    const bodyEl = h('div', { class: 'key-pop-body' }, ...body, said)
    // A redraw (the vault watch, a refresh) keeps the password typed into the old form.
    carryTyped(el, bodyEl)
    el.replaceChildren(head, bodyEl, foot)
    el.dataset.shows = locked ? 'locked' : 'unlocked'
    el.setAttribute('aria-label', host ? `Passwords for ${host}` : 'Passwords')
    // The focus stays on the popover itself (Tab reaches the first Fill, Escape closes): a Fill
    // focused from here would wear the keyboard ring though the person clicked.
    if (!locked && !el.contains(document.activeElement)) el.focus()
  }

  const open = () => {
    el = h('div', { class: 'key-pop', role: 'dialog', 'aria-label': 'Passwords', 'data-testid': 'key-pop', tabindex: '-1' })
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      close()
      o.onEscape()
    })
    el.append(h('div', { class: 'key-pop-head' }, 'Passwords'), h('p', { class: 'key-pop-empty' }, 'Loading…'))
    o.host.append(el)
    place()
    el.focus()
    o.onChange(true)
    void render()
  }

  window.addEventListener('resize', place)
  // Escape on this page outside the popover (its focus left it) closes it too.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el && !e.defaultPrevented) { close(); o.onEscape() } })
  // A press on this page outside it (the full views' bar, an edge): closed.
  document.addEventListener('pointerdown', (e) => { if (el && e.target instanceof Node && !el.contains(e.target)) close() }, true)

  return {
    toggle: (rect) => { if (el) { close(); return } anchor = rect; open() },
    close,
    isOpen: () => !!el,
    refresh: () => { if (el && el.dataset.shows) void render() },
  }
}
