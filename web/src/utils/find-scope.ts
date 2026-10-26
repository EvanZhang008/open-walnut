/**
 * Which surface a Cmd/Ctrl+F belongs to.
 *
 * Three surfaces answer the chord: a file view (FileContentView), a Changed tab
 * (SessionDiffView) and the page find (PageFind: a session's chat, or the page).
 * Focus alone cannot decide it, because reading a chat focuses nothing: the
 * reader clicked into a message, and `document.activeElement` is still <body>.
 * So the last pointerdown is the second signal, recorded here once for all.
 */

let lastPointer: Element | null = null;
let installed = false;

export function installFindPointerTracking(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerdown', (e) => {
    lastPointer = e.target instanceof Element ? e.target : null;
  }, { capture: true, passive: true });
}

export function lastPointerTarget(): Element | null {
  return lastPointer?.isConnected ? lastPointer : null;
}

/** True on the Find chord: Cmd+F on Apple platforms, Ctrl+F elsewhere. */
export function isFindChord(e: KeyboardEvent): boolean {
  if (e.altKey || e.shiftKey || (e.key !== 'f' && e.key !== 'F')) return false;
  const apple = /Mac|iP/.test(navigator.platform);
  return apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * A file view or Changed tab that the key did NOT land in may still claim the
 * chord when it is the only thing to search. It must not when the reader was
 * last working in a session's chat, or in another session column: then the
 * chord is theirs to search, not a Files tab open somewhere else.
 */
export function pointerOwnedElsewhere(el: Element): boolean {
  installFindPointerTracking();
  const p = lastPointerTarget();
  if (!p || el.contains(p)) return false;
  if (p.closest('.session-history')) return true;
  const panel = p.closest('.session-panel');
  return !!panel && panel !== el.closest('.session-panel');
}
