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

/** Draws `el` as the view of generation `g`; false (nothing drawn) when a newer view took over. */
export function paint(root: HTMLElement, el: HTMLElement, g: number, shows: Shows): boolean {
  if (g !== gen) return false
  root.replaceChildren(el)
  root.dataset.shows = shows
  return true
}
