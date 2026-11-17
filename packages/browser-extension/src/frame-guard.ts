/**
 * The in-page menu and save bar sit inside a site's page, so a page could try to make the
 * person click them unseen (covered by something see-through, faded, or slid under the
 * pointer). Their buttons act only when the frame has been on screen for a moment and, where
 * the browser can say (IntersectionObserver v2, Chrome), nothing covers or fades it.
 */
const SETTLE_MS = 500

export interface FrameGuard {
  /** True when a click on this frame may act now. */
  allowed(): boolean
  /** Wrap a click handler: refused clicks do nothing, and one refused because something covers the frame calls `onCovered`. */
  wrap<E extends Event>(f: (e: E) => void): (e: E) => void
}

/**
 * `onCovered`: the person's click was refused because something is drawn over the frame (or it
 * is faded): the frame says so, since a click that does nothing reads as broken (2026-11-17).
 */
export function frameGuard(onCovered?: () => void): FrameGuard {
  let since = Date.now()
  let visible = true
  try {
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1] as IntersectionObserverEntry & { isVisible?: boolean }
      if (typeof e.isVisible !== 'boolean') return
      // Coming into view (again) starts the wait again.
      if (e.isVisible && !visible) since = Date.now()
      visible = e.isVisible
    }, { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit)
    io.observe(document.documentElement)
    // trackVisibility unsupported (Firefox): the entries carry no isVisible, and the wait alone holds.
  } catch { /* the wait alone holds */ }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') since = Date.now() })
  const allowed = () => visible && document.visibilityState === 'visible' && Date.now() - since >= SETTLE_MS
  return {
    allowed,
    wrap: (f) => (e) => {
      if (!e.isTrusted) return
      if (allowed()) { f(e); return }
      if (!visible && document.visibilityState === 'visible') onCovered?.()
    },
  }
}
