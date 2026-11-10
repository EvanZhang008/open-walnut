/**
 * The agent's cursor, drawn in the page (2026-11-09, the user: "it doesn't show the cursor, can we
 * ideally show the cursor icon to let people know where is it clicking?"). An agent never moves the
 * person's own mouse: this is a picture (one of Walnut's own looks, cursor-looks.ts, never shaped
 * like the person's pointer) in a closed shadow root at the highest z-index,
 * which takes no pointer events, changes no layout, scroll or focus, and is drawn only where an
 * agent is about to act (page-ops.ts places it before each click, type, hover, select, drag or
 * scroll at a point; the background places it before real input, agent-trusted.ts, agent-drag.ts).
 *
 *   - It glides to each target (an eased move, MOVE_MIN_MS to MOVE_MAX_MS, leaning into a longer
 *     one), plays its look's click animation on a click, and stays on the last spot while the
 *     agent works. The look is the person's pick in the popup's Settings (`settings.cursorStyle`).
 *   - With prefers-reduced-motion it jumps there, with no animation, and is still shown.
 *   - In a frame, the point goes to the background, which adds the frame's offset in the page and
 *     draws it in the top document (agent-cursor.ts); when that cannot be worked out (an old
 *     browser, a frame that does not answer), it is drawn in the frame's own document.
 *   - Hidden while an agent's own screenshot is taken (cursorMask, with the secrets mask), never
 *     in the live view's pictures, so the person sees where it acts.
 *   - Gone when the agent lets the tab go (every release deletes the tab's holding, and that
 *     sends `agent-cursor {off}` to every frame: agent-shared.ts letGo), and when the person takes
 *     the tab over.
 */
import { dropHost, hostStyle, makeHost, type Host } from './content-host'
import { CLICK_MS, DEFAULT_CURSOR_STYLE, cursorCss, cursorParts, isCursorStyle, type CursorStyle } from './cursor-looks'
import { ask, ext } from './ext'

export type CursorKind = 'move' | 'click' | 'drag'
/** Above everything Walnut draws in a page (the agent frame is 2147483645). */
export const CURSOR_Z = 2147483647
export const MOVE_MIN_MS = 160
export const MOVE_MAX_MS = 300
/** A first appearance is shown this long before the step acts, so the person sees where. */
export const FIRST_MS = 120
/** A click's animation (each look's own, cursor-looks.ts). */
export const RIPPLE_MS = CLICK_MS
/** How long a frame waits for the background to draw its point in the top document (agent-cursor.ts SEARCH_MS and DRAW_MS fit inside). */
const UP_MS = 6000
/** How long a first drawing waits for the person's chosen look (storage.local), at most. */
const LOOK_READ_MS = 250
/** A move longer than this leans the cursor into it while it glides. */
const TILT_MIN_PX = 24

interface Drawn { host: Host; box: HTMLElement; x: number; y: number; look: CursorStyle }
let cur: Drawn | null = null
let masked = false
let rippleTimer: ReturnType<typeof setTimeout> | undefined
let tiltTimer: ReturnType<typeof setTimeout> | undefined
let moves = 0
/** The look drawn: the person's pick in Settings (`settings.cursorStyle`), else the shipped one. */
let look: CursorStyle = DEFAULT_CURSOR_STYLE
let lookRead: Promise<void> | null = null
/** A change came from storage's change event: a first read still on its way is older, and loses. */
let lookChanged = false
/** Counts cursorOff calls: a first drawing still waiting for the look is dropped when the cursor went off meanwhile. */
let offs = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/**
 * No animation: the person asked for less motion (or the page cannot say, as in a test's DOM), or
 * nobody sees the page now (a covered agent window), where the browser slows timers to a second
 * and a move would only hold the step up.
 */
const still = () => typeof matchMedia !== 'function' || document.visibilityState === 'hidden' || matchMedia('(prefers-reduced-motion: reduce)').matches
const isTop = () => { try { return window.top == null || window.top === window } catch { return false } }

const lookOf = (settings: unknown): CursorStyle => {
  const v = (settings as { cursorStyle?: unknown } | undefined)?.cursorStyle
  return isCursorStyle(v) ? v : DEFAULT_CURSOR_STYLE
}

/**
 * The chosen look, read once per document. A storage slower than LOOK_READ_MS lets the first
 * drawing go in the default look, and its answer, when it comes, redraws it in place.
 */
function readLook(): Promise<void> {
  lookRead ??= (async () => {
    let asked: Promise<unknown>
    try { asked = ext?.storage?.local?.get('settings') ?? Promise.resolve(null) } catch { return }
    const answer = Promise.resolve(asked).then((got) => (got ? lookOf((got as { settings?: unknown }).settings) : null), () => null)
    const first = await Promise.race([answer, sleep(LOOK_READ_MS).then(() => undefined)])
    if (first === undefined) { void answer.then((late) => { if (late && !lookChanged) applyLook(late) }); return }
    if (first && !lookChanged) look = first
  })()
  return lookRead
}

/** Draw a cursor on show again in `next`, where it is. */
function applyLook(next: CursorStyle): void {
  if (next === look) return
  look = next
  if (cur && cur.host.el.isConnected) ensure()
}

function ensure(): Drawn {
  if (cur && cur.host.el.isConnected && cur.look === look) return cur
  // Drawn again in another look (Settings changed it): it stays where it was. One the page took away starts afresh.
  const at = cur && cur.host.el.isConnected ? { x: cur.x, y: cur.y } : null
  if (cur) dropHost(cur.host)
  // Marked as it is made (content.ts closes Walnut's menus on a later change to a host's attributes).
  const { host, root } = makeHost(CURSOR_Z, 'walnutCursor')
  // A point on the page, nothing of its own size: no layout, and every click goes through.
  hostStyle(host, `z-index: ${CURSOR_Z} !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; pointer-events: none !important;`)
  const style = document.createElement('style')
  style.textContent = cursorCss(look)
  const { box } = cursorParts(document, look)
  if (masked) box.classList.add('hid')
  root.append(style, box)
  cur = { host, box, x: NaN, y: NaN, look }
  if (at && Number.isFinite(at.x)) place(cur, at.x, at.y, 0)
  return cur
}

function place(c: Drawn, x: number, y: number, ms: number): void {
  c.box.style.setProperty('--ms', `${ms}ms`)
  c.box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  c.x = x
  c.y = y
}

/**
 * The cursor goes to (x, y), viewport coordinates of this document, and the promise ends once it is
 * there; a click shows its animation on arrival. `ms` sets the move's length (a drag's own length).
 */
export async function cursorAt(x: number, y: number, kind: CursorKind = 'move', ms?: number): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  if (!cur) {
    const off = offs
    await readLook()
    // Let go (or taken over) while the look was read: nothing is drawn.
    if (off !== offs) return
  }
  const c = ensure()
  const first = !Number.isFinite(c.x)
  const dx = first ? 0 : x - c.x
  const dy = first ? 0 : y - c.y
  const dist = Math.hypot(dx, dy)
  const dur = still() || first ? 0 : Math.round(ms ?? Math.min(MOVE_MAX_MS, Math.max(MOVE_MIN_MS, MOVE_MIN_MS + dist * 0.2)))
  // It leans into a longer glide (the body trails the tip) and settles back with a small bounce on arrival.
  clearTimeout(tiltTimer)
  if (dur && dist >= TILT_MIN_PX) {
    c.box.style.setProperty('--tilt', `${Math.round(((dx - dy) / dist) * 9)}deg`)
    c.box.classList.add('go')
    tiltTimer = setTimeout(() => c.box.classList.remove('go'), Math.max(0, dur - 60))
  } else c.box.classList.remove('go')
  place(c, x, y, dur)
  moves++
  const wait = still() ? 0 : first ? FIRST_MS : dur
  if (wait) await sleep(wait)
  if (kind === 'click') ripple()
}

function ripple(): void {
  if (!cur) return
  const box = cur.box
  box.classList.remove('on')
  // A new click's animation starts over (the class comes back after a reflow).
  void box.offsetWidth
  box.classList.add('on')
  clearTimeout(rippleTimer)
  rippleTimer = setTimeout(() => box.classList.remove('on'), RIPPLE_MS)
}

/** The agent let the tab go (or the person took it over): no cursor. */
export function cursorOff(): void {
  offs++
  clearTimeout(rippleTimer)
  clearTimeout(tiltTimer)
  if (cur) dropHost(cur.host)
  cur = null
}

/** Hidden while an agent's own screenshot is taken, back after. */
export function cursorMask(on: boolean): void {
  masked = on
  if (cur) cur.box.classList.toggle('hid', on)
}

/** The person picked another look in Settings: a cursor on show now is drawn again in it, in place. */
export function setCursorLook(next: unknown): void {
  lookChanged = true
  lookRead ??= Promise.resolve()
  applyLook(isCursorStyle(next) ? next : DEFAULT_CURSOR_STYLE)
}

/**
 * The point of an agent's step in this frame: drawn here in the top document; from a frame, drawn
 * in the top document at the frame's offset when the background can work it out, else here.
 */
export async function pointAt(x: number, y: number, kind: CursorKind = 'move'): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  if (isTop()) return cursorAt(x, y, kind)
  const up = await Promise.race([ask<{ placed?: boolean }>({ type: 'agent-cursor-up', x, y, kind }), sleep(UP_MS).then(() => null)])
  if (up?.ok && up.placed) { cursorOff(); return }
  return cursorAt(x, y, kind)
}

/** An element's middle when it is on screen now (nothing is scrolled to find out), else null. */
export function onScreenMiddle(el: Element | null | undefined): { x: number; y: number } | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 && r.height <= 0) return null
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  return x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight ? { x, y } : null
}

/**
 * Where the frame `frameId` (the browser's id for it) starts in this document's viewport: one of
 * this document's frames, or one inside a same-origin frame of it. Null when it is not here, or the
 * browser cannot name a frame's id (runtime.getFrameId, Chrome 106).
 */
export function frameBox(frameId: number): { x: number; y: number } | null {
  const rt = ext?.runtime as unknown as { getFrameId?: (el: Element) => number } | undefined
  if (typeof rt?.getFrameId !== 'function' || !Number.isInteger(frameId) || frameId <= 0) return null
  const walk = (doc: Document, ox: number, oy: number, depth: number): { x: number; y: number } | null => {
    for (const el of Array.from(doc.querySelectorAll('iframe, frame'))) {
      const { x, y } = innerStart(el, doc, ox, oy)
      let id = -1
      try { id = rt!.getFrameId!(el) } catch { /* not a frame the browser names */ }
      if (id === frameId) return { x, y }
      if (depth >= 3) continue
      let inner: Document | null = null
      try { inner = (el as HTMLIFrameElement).contentDocument } catch { /* another site's frame */ }
      const hit = inner ? walk(inner, x, y, depth + 1) : null
      if (hit) return hit
    }
    return null
  }
  return walk(document, 0, 0, 0)
}

/** Where a frame element's page starts in its document's viewport: inside its border and padding. */
function innerStart(el: Element, doc: Document = document, ox = 0, oy = 0): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  let cs: CSSStyleDeclaration | undefined
  try { cs = doc.defaultView?.getComputedStyle(el) } catch { /* no style to read */ }
  return {
    x: ox + r.left + ((el as HTMLElement).clientLeft || 0) + (parseFloat(cs?.paddingLeft ?? '') || 0),
    y: oy + r.top + ((el as HTMLElement).clientTop || 0) + (parseFloat(cs?.paddingTop ?? '') || 0),
  }
}

/**
 * The frame's hello to the document that holds it (agent-cursor.ts helloOrigin): Chrome gives a
 * content script no runtime.getFrameId (2026-11-09: undefined in Chrome 145, so the cursor of every
 * step in a frame was drawn inside the frame), so the frame posts a token to its parent window, and
 * the parent's script finds which of its frame elements that window is (`source`) and tells the
 * background where it starts. Only the place goes back; a page that copies the token can at worst
 * move Walnut's cursor picture.
 */
export const FRAME_HELLO = 'walnutFrameHello'
const TOKEN = /^[0-9a-f-]{16,64}$/

function listenHello(): void {
  addEventListener('message', (e) => {
    const token = (e.data as Record<string, unknown> | null)?.[FRAME_HELLO]
    if (typeof token !== 'string' || !TOKEN.test(token) || !e.source) return
    const el = Array.from(document.querySelectorAll('iframe, frame')).find((f) => (f as HTMLIFrameElement).contentWindow === e.source)
    if (!el) return
    void ask({ type: 'agent-frame-hello-box', token, box: innerStart(el) }).catch(() => undefined)
  })
}

/** The background's messages about the cursor (content.ts calls this once per frame). */
export function listenCursor(): void {
  listenHello()
  ext.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && 'settings' in changes) setCursorLook(lookOf(changes.settings.newValue))
  })
  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'agent-cursor') {
      if (msg.off === true) { cursorOff(); sendResponse({ ok: true }); return }
      const kind: CursorKind = msg.kind === 'click' || msg.kind === 'drag' ? msg.kind : 'move'
      void cursorAt(Number(msg.x), Number(msg.y), kind, typeof msg.ms === 'number' ? msg.ms : undefined).then(() => sendResponse({ ok: true, placed: true }))
      return true
    }
    if (msg?.type === 'agent-frame-box') { sendResponse({ ok: true, box: frameBox(Number(msg.frameId)) }); return }
    if (msg?.type === 'agent-frame-hello') {
      const token = String(msg.token ?? '')
      if (isTop() || !TOKEN.test(token)) { sendResponse({ ok: false }); return }
      try { window.parent.postMessage({ [FRAME_HELLO]: token }, '*') } catch { sendResponse({ ok: false }); return }
      sendResponse({ ok: true }); return
    }
  })
}

/** For tests: what is drawn (the shadow root is closed). */
export function _cursorForTesting(): { host: HTMLElement; box: HTMLElement; x: number; y: number; hidden: boolean; rippling: boolean; moves: number; look: CursorStyle } | null {
  return cur && cur.host.el.isConnected ? { host: cur.host.el, box: cur.box, x: cur.x, y: cur.y, hidden: cur.box.classList.contains('hid'), rippling: cur.box.classList.contains('on'), moves, look: cur.look } : null
}
export function _resetCursorForTesting(): void { cursorOff(); masked = false; moves = 0; look = DEFAULT_CURSOR_STYLE; lookRead = null; lookChanged = false }
