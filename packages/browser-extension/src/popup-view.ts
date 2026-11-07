/**
 * Which view the popup shows, so an answer that comes late never draws over a newer view (the
 * security review of the shared unlock: an item opened just before a Lock all drew its details over
 * the lock screen, and they stayed there). Every view change (a render, a lock, a disconnect, an
 * item, Settings, the generator) takes a new generation; async work started under an older one
 * writes nothing. `root.dataset.shows` says what the view on show holds, which the popup's watch
 * on the vault compares with Walnut's answer (popup.ts followVault).
 */
import { ext } from './ext'

let gen = 0

/** `unlocked`: it shows vault data; `locked`: the lock screen; `neutral`: neither (connect, Settings, the generator, an error). */
export type Shows = 'locked' | 'unlocked' | 'neutral'

/** A new view is on its way: whatever older work is still out writes nothing now. */
export function nextView(): number {
  return ++gen
}

export function currentView(): number {
  return gen
}

export function isCurrent(g: number): boolean {
  return g === gen
}

/**
 * `home`: the view the page opened on (the list, its lock screen, the connect screen, or Settings
 * when the page was opened on it); `sub`: one the person went into from there (an item, the
 * generator, Settings from the list's gear). A sub-view is the person's until they leave it: what
 * follows the page in the window (another tab, another address) redraws only a home view
 * (review R2-14: Settings turned into the Passwords list on a tab switch).
 */
export type ViewKind = 'home' | 'sub'

/**
 * The fields a redraw must not empty: the master password and Secret Key (popup and key popover),
 * the server address, the save bar's password. tests/core/browser-control/extension-popup-keep-typed.test.ts
 * fails on a password field of the extension whose id is missing here.
 */
export const KEEP_TYPED = ['pw', 'sk', 'server', 'key-pw', 'key-sk', 'password'] as const

/**
 * A redraw (the vault watch, a page follow, a state answer) builds a new view from scratch: what
 * the person typed into a field of the same name moves into it, with the focus, so a password typed
 * just before a redraw is still there when they press Unlock.
 */
export function carryTyped(root: HTMLElement, el: HTMLElement): void {
  for (const id of KEEP_TYPED) {
    const was = root.querySelector<HTMLInputElement>(`#${id}`)
    const now = el.querySelector<HTMLInputElement>(`#${id}`)
    if (!was || !now || !was.value || now.value) continue
    now.value = was.value
    if (document.activeElement === was) queueMicrotask(() => now.focus())
  }
}

/** Draws `el` as the view of generation `g`; false (nothing drawn) when a newer view took over. */
export function paint(root: HTMLElement, el: HTMLElement, g: number, shows: Shows, kind: ViewKind = 'sub'): boolean {
  if (g !== gen) return false
  carryTyped(root, el)
  root.replaceChildren(el)
  root.dataset.shows = shows
  root.dataset.view = kind
  return true
}

/**
 * A view that shows something kept in the extension's storage follows it while it is on show
 * (review R3-5: Settings listed no site after the save bar's "Never for this site" until the panel
 * was opened again). `onChange` runs when one of `keys` changes in `area` while the view of
 * generation `g` is the current one; the listener goes with the next change after another view
 * took over. tests/core/browser-control/extension-view-storage-guard.test.ts fails on a view that
 * reads storage without following it.
 */
export function followStorage(keys: readonly string[], g: number, onChange: (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) => void, area: 'local' | 'session' = 'local'): void {
  const on = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, a: string) => {
    if (a !== area) return
    if (!isCurrent(g)) { ext.storage.onChanged.removeListener(on); return }
    if (keys.some((k) => k in changes)) onChange(changes)
  }
  ext.storage.onChanged.addListener(on)
}
