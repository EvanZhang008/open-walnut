/**
 * A plugin's App or page draws only inside its own box. Walnut's sidebar, header and its own
 * popups stay visible and usable whatever the plugin does: 2026-10-28, a pause screen in an App
 * covered the whole window, sidebar included, and the person had to click it away to get Walnut
 * back.
 *
 * A page offers two ways out of a box, and both are closed here:
 * - CSS (`position: fixed`, `z-index`): the box is clipped and isolated
 *   (styles/plugin-bounds.css), so z-index stacks inside it and nothing paints or takes a click
 *   outside it.
 * - The browser's top layer (a popover, a modal `<dialog>`, fullscreen), drawn above the whole
 *   page whatever any CSS says. A popover or modal dialog the plugin opens inside its box is moved
 *   and sized to stay in the box, and shows no backdrop over the rest of Walnut; fullscreen is
 *   refused, except for a video or audio player.
 *
 * What stays the plugin's own business: a modal dialog still makes the rest of the page inert
 * while it is open (the browser's rule, not ours to bend), so a screen meant to stay up, such as a
 * pause screen, belongs in the plugin's own tree as an overlay. And a plugin that renders into
 * `document.body` itself (`walnut.unsafe.dom`) has left its box on purpose.
 */
import { log } from '@/utils/log'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * How far to move `rect`, measured unmoved and no larger than `box`, so that it lies inside
 * `box`: the least move, so a menu by the box's edge only slides in as far as it must.
 */
export function shiftInto(rect: Box, box: Box): { x: number; y: number } {
  const left = Math.min(Math.max(rect.left, box.left), box.left + box.width - Math.min(rect.width, box.width))
  const top = Math.min(Math.max(rect.top, box.top), box.top + box.height - Math.min(rect.height, box.height))
  return { x: Math.round(left - rect.left), y: Math.round(top - rect.top) }
}

/** The plugin's own limit kept, ours on top: `min()` of both, or ours when it set none. */
export function capped(own: string, limit: number): string {
  return own && own !== 'none' ? `min(${own}, ${limit}px)` : `${limit}px`
}

/** The part of `a` inside `b`. */
export function overlap(a: Box, b: Box): Box {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  return { left, top, width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left), height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top) }
}

/**
 * The plugin's own `translate` (a computed value: `none`, or one to three lengths) moved by
 * `x, y` px on top, so a dialog it centres with `translate: -50% -50%` keeps that.
 */
export function movedBy(translate: string, x: number, y: number): string {
  const parts: string[] = []
  let depth = 0
  let part = ''
  for (const ch of translate.trim() === 'none' ? '' : translate.trim()) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (/\s/.test(ch) && depth === 0) {
      if (part) parts.push(part)
      part = ''
    } else part += ch
  }
  if (part) parts.push(part)
  const [ownX = '0px', ownY = '0px', ownZ] = parts
  const add = (own: string, by: number) => (/^0(px)?$/.test(own) ? `${by}px` : `calc(${own} + ${by}px)`)
  return [add(ownX, x), add(ownY, y), ...(ownZ ? [ownZ] : [])].join(' ')
}

interface Placed {
  /** The plugin's own inline values, given back when it closes. */
  inline: { maxWidth: string; maxHeight: string; translate: string }
  /** Its computed values before ours. */
  own: { maxWidth: string; maxHeight: string; translate: string }
  /** How far ours moves it now. */
  shift: { x: number; y: number }
  resize: ResizeObserver
}

const PROPS = ['max-width', 'max-height', 'translate'] as const

/** Keep what `box` opens in the top layer inside `box`, until the returned function is called. */
export function keepInBox(box: HTMLElement): () => void {
  const placed = new Map<HTMLElement, Placed>()
  const frames = new Set<number>()
  let stopped = false

  const frame = (fn: () => void) => {
    const id = requestAnimationFrame(() => {
      frames.delete(id)
      if (!stopped) fn()
    })
    frames.add(id)
  }

  // Where the box shows: its own rect, cut by every ancestor that clips (a page scrolls inside the
  // content area) and by the window.
  const area = (): Box => {
    const b = box.getBoundingClientRect()
    let shown: Box = { left: b.left, top: b.top, width: b.width, height: b.height }
    for (let el = box.parentElement; el && el !== document.body; el = el.parentElement) {
      const style = getComputedStyle(el)
      if (style.overflowX === 'visible' && style.overflowY === 'visible' && style.clipPath === 'none') continue
      const r = el.getBoundingClientRect()
      shown = overlap(shown, { left: r.left, top: r.top, width: r.width, height: r.height })
    }
    return overlap(shown, { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight })
  }

  const place = (el: HTMLElement) => {
    if (stopped) return
    let entry = placed.get(el)
    if (!entry) {
      const computed = getComputedStyle(el)
      entry = {
        inline: { maxWidth: el.style.maxWidth, maxHeight: el.style.maxHeight, translate: el.style.translate },
        own: { maxWidth: computed.maxWidth, maxHeight: computed.maxHeight, translate: computed.translate || 'none' },
        shift: { x: 0, y: 0 },
        resize: new ResizeObserver(() => now(el)),
      }
      placed.set(el, entry)
      entry.resize.observe(el)
    }
    const shown = area()
    const maxWidth = capped(entry.own.maxWidth, shown.width)
    const maxHeight = capped(entry.own.maxHeight, shown.height)
    if (el.style.getPropertyValue('max-width') !== maxWidth) el.style.setProperty('max-width', maxWidth, 'important')
    if (el.style.getPropertyValue('max-height') !== maxHeight) el.style.setProperty('max-height', maxHeight, 'important')
    // Where the plugin put it is where it is now, less our own move; nothing is written unless
    // the move changes, so a plugin's own translate (centring, an animation) stays its own.
    const r = el.getBoundingClientRect()
    const shift = shiftInto({ left: r.left - entry.shift.x, top: r.top - entry.shift.y, width: r.width, height: r.height }, shown)
    if (shift.x === entry.shift.x && shift.y === entry.shift.y) return
    entry.shift = shift
    if (shift.x || shift.y) el.style.setProperty('translate', movedBy(entry.own.translate, shift.x, shift.y), 'important')
    else {
      el.style.removeProperty('translate')
      el.style.translate = entry.inline.translate
    }
  }

  const release = (el: HTMLElement) => {
    const entry = placed.get(el)
    if (!entry) return
    entry.resize.disconnect()
    placed.delete(el)
    for (const prop of PROPS) el.style.removeProperty(prop)
    el.style.maxWidth = entry.inline.maxWidth
    el.style.maxHeight = entry.inline.maxHeight
    el.style.translate = entry.inline.translate
  }

  const inTopLayer = (el: Element): el is HTMLElement =>
    el instanceof HTMLElement && el.isConnected && box.contains(el) && (matches(el, ':popover-open') || matches(el, ':modal'))

  const now = (el: HTMLElement) => {
    if (stopped) return
    if (inTopLayer(el)) place(el)
    else release(el)
  }
  // Before the next frame, so it never shows outside the box, and once more after the plugin's own
  // code has put it where it wants.
  const update = (el: HTMLElement) => {
    queueMicrotask(() => now(el))
    frame(() => now(el))
  }
  // A popover opening or closing. `beforetoggle` comes inside showPopover(), before it is open:
  // the microtask then runs once the plugin's handler is done, still before the frame. `toggle`
  // comes later, and closes. Neither bubbles: both are caught on their way down.
  const onToggle = (event: Event) => {
    if (event.target instanceof HTMLElement) update(event.target)
  }
  // A modal dialog opening or closing.
  const dialogs = new MutationObserver((changes) => {
    for (const change of changes) if (change.target instanceof HTMLDialogElement) update(change.target)
  })
  // The whole screen is never an App's; a video or audio player's own full screen is the person's.
  const onFullscreen = () => {
    const el = document.fullscreenElement
    if (!el || !box.contains(el)) return
    if (el instanceof HTMLMediaElement || el.querySelector('video, audio')) return
    log.warn('plugins', 'a plugin asked for the whole screen; its box is all it gets', { plugin: box.dataset.pluginId ?? box.dataset.appKey })
    void document.exitFullscreen().catch(() => undefined)
  }
  const placeAll = () => {
    for (const el of [...placed.keys()]) now(el)
  }
  // A scroll anywhere can move a menu the plugin pinned to a button: once a frame at most.
  let scrollQueued = false
  const onScroll = () => {
    if (!placed.size || scrollQueued) return
    scrollQueued = true
    frame(() => {
      scrollQueued = false
      placeAll()
    })
  }

  box.addEventListener('beforetoggle', onToggle, true)
  box.addEventListener('toggle', onToggle, true)
  dialogs.observe(box, { subtree: true, attributes: true, attributeFilter: ['open'] })
  document.addEventListener('fullscreenchange', onFullscreen)
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  const boxResize = new ResizeObserver(placeAll)
  boxResize.observe(box)
  window.addEventListener('resize', placeAll)
  // Already open when the box mounts (a plugin that opens one on its first render).
  for (const el of box.querySelectorAll('dialog[open], [popover]')) if (inTopLayer(el)) place(el)
  onFullscreen()

  return () => {
    box.removeEventListener('beforetoggle', onToggle, true)
    box.removeEventListener('toggle', onToggle, true)
    dialogs.disconnect()
    document.removeEventListener('fullscreenchange', onFullscreen)
    document.removeEventListener('scroll', onScroll, true)
    boxResize.disconnect()
    window.removeEventListener('resize', placeAll)
    for (const id of frames) cancelAnimationFrame(id)
    frames.clear()
    for (const el of [...placed.keys()]) release(el)
    stopped = true
  }
}

/** `el.matches`, false for a selector this engine does not know (an older WebKit without `:modal`). */
function matches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector)
  } catch {
    return false
  }
}
