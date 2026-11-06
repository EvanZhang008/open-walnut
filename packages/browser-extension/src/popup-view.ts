/**
 * Which view the popup shows, so an answer that comes late never draws over a newer view (the
 * security review of the shared unlock: an item opened just before a Lock all drew its details over
 * the lock screen, and they stayed there). Every view change (a render, a lock, a disconnect, an
 * item, Settings, the generator) takes a new generation; async work started under an older one
 * writes nothing. `root.dataset.shows` says what the view on show holds, which the popup's watch
 * on the vault compares with Walnut's answer (popup.ts followVault).
 */
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

/** Draws `el` as the view of generation `g`; false (nothing drawn) when a newer view took over. */
export function paint(root: HTMLElement, el: HTMLElement, g: number, shows: Shows, kind: ViewKind = 'sub'): boolean {
  if (g !== gen) return false
  root.replaceChildren(el)
  root.dataset.shows = shows
  root.dataset.view = kind
  return true
}
