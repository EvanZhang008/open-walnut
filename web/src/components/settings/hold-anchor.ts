/**
 * Settings' anchor hold: scroll one row (or a section) into place inside the pane and keep it
 * there while the pane settles. Used by a deep link to a folded section and by a Find a setting
 * hit (SettingsPage).
 *
 * The row is held by its id, never by the node first found: a section that draws its rows in
 * another branch once its data lands (Phones & Cloud > Cloud companion moves its extras into the
 * fold group when the companion reads configured) replaces the row with a new node of the same id.
 * A detached node measures at the pane's top, so holding it scrolled the pane to 0 and left the
 * real row out of view (2026-11-26, devices-ways-and-qr "Find a setting reaches a row on a tab",
 * red under load).
 */
import { announceSettingsAnchor } from './settings-anchor-event'

/** Any of these means the person took the wheel: hash anchoring lets go. */
const USER_TAKEOVER_EVENTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const

/** Under the 44px compact header, matching `scroll-margin-top: 52px`. */
const ANCHOR_MARGIN = 52

/**
 * Anchor hold: it ends once the content above the target has been still for
 * HOLD_QUIET_MS (and at least HOLD_MIN_MS in), never later than HOLD_MAX_MS.
 * Quiet-based rather than a flat 2s: under load a slow list above the target
 * can land after 2s and would otherwise push it out of view.
 */
const HOLD_MIN_MS = 2000
const HOLD_QUIET_MS = 1000
const HOLD_MAX_MS = 5000
/**
 * How long a hold looks for a target that is not drawn yet. A row inside a section that
 * waits on a server answer (the Cloud companion's rows wait on the device list) can come
 * seconds late on a busy machine: giving up after 2s left a Find a setting hit unscrolled.
 */
const HOLD_FIND_MS = 10_000

/** Which element the pane should hold in view. */
export interface AnchorRequest {
  id: string
  /** `start`: under the compact header; `third`: a Find a setting row hit, a third down. */
  mode: 'start' | 'third'
  /** `strong`: a deep link from another page, where the person has not seen the
   *  pane yet, so the row pulses longer than a Find a setting hit flashes. */
  flash: boolean | 'strong'
}

/**
 * Scroll `id` into place inside `scroller` and keep it there while the content
 * above it is still growing: look every 100ms (for HOLD_FIND_MS) until the element exists,
 * re-scroll whenever it drifts > 2px (checked every frame), follow the id when
 * a re-render replaces its node, stop once the content above it has been still
 * for a second (see HOLD_*), and let go at once when the person scrolls or types.
 * Returns the stop.
 */
export function holdAnchor(scroller: HTMLElement, req: AnchorRequest): () => void {
  // A section that folds this row away opens it now; the retries below then find it.
  announceSettingsAnchor(req.id)
  let stopped = false
  let el: HTMLElement | null = null
  const startedAt = performance.now()
  let foundAt = 0
  let lastMoveAt = 0
  let stable = 0
  let lastPos: number | null = null
  let raf = 0
  const find = (): HTMLElement | null => {
    const found = document.getElementById(req.id)
    return found && scroller.contains(found) ? found : null
  }
  /** The row now: the node held while it is in the pane, else the node that took its id (null while none has). */
  const current = (): HTMLElement | null => {
    if (el?.isConnected) return el
    el = find()
    if (el) {
      // Its place starts over: the hold waits out the new node's settling as it did the first's.
      lastPos = null
      lastMoveAt = performance.now()
      // The flash went with the old node; the row the person sees gets it.
      if (req.flash) flashRow(el, req.flash === 'strong')
    }
    return el
  }
  const offset = () => (req.mode === 'start' ? ANCHOR_MARGIN : Math.round(scroller.clientHeight / 3))
  const viewTop = (row: HTMLElement) => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const correct = () => {
    const row = current()
    if (!row) return
    const d = viewTop(row) - offset()
    if (Math.abs(d) > 2) scroller.scrollTop += d
  }
  const frame = () => {
    if (stopped) return
    correct()
    raf = requestAnimationFrame(frame)
  }
  const stop = () => {
    stopped = true
    clearInterval(timer)
    cancelAnimationFrame(raf)
    for (const ev of USER_TAKEOVER_EVENTS) window.removeEventListener(ev, stop, true)
  }
  const check = () => {
    if (stopped) return
    const now = performance.now()
    if (!foundAt) {
      el = find()
      if (!el) {
        if (now - startedAt >= HOLD_FIND_MS) stop()
        return
      }
      foundAt = now
      lastMoveAt = now
      correct()
      if (req.flash) flashRow(el, req.flash === 'strong')
      raf = requestAnimationFrame(frame)
      return
    }
    const row = current()
    // Replaced and not drawn again yet: nothing to measure; HOLD_MAX_MS still bounds the wait.
    if (!row) {
      if (now - foundAt >= HOLD_MAX_MS) stop()
      return
    }
    // Position in the content (not the viewport): it moves only when content
    // above the target grows or shrinks, which is what the hold waits out.
    const pos = viewTop(row) + scroller.scrollTop
    if (lastPos !== null && Math.abs(pos - lastPos) > 1) {
      stable = 0
      lastMoveAt = now
    } else {
      stable += 1
    }
    lastPos = pos
    const quiet = now - lastMoveAt
    if ((stable >= 3 && quiet >= HOLD_QUIET_MS && now - foundAt >= HOLD_MIN_MS) || now - foundAt >= HOLD_MAX_MS) stop()
  }
  const timer = setInterval(check, 100)
  for (const ev of USER_TAKEOVER_EVENTS) window.addEventListener(ev, stop, { capture: true, passive: true })
  check()
  return stop
}

function flashRow(el: HTMLElement, strong = false) {
  const row = el.closest<HTMLElement>('.settings-row') ?? el
  const cls = strong ? 'settings-anchor-flash-strong' : 'settings-anchor-flash'
  row.classList.remove('settings-anchor-flash', 'settings-anchor-flash-strong')
  void row.offsetWidth
  row.classList.add(cls)
  window.setTimeout(() => row.classList.remove(cls), strong ? 3100 : 1300)
}
