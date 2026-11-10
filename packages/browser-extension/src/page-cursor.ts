/**
 * The agent's cursor, drawn in the page (2026-11-09, the user: "it doesn't show the cursor, can we
 * ideally show the cursor icon to let people know where is it clicking?"). An agent never moves the
 * person's own mouse: this is a picture of an arrow in a closed shadow root at the highest z-index,
 * which takes no pointer events, changes no layout, scroll or focus, and is drawn only where an
 * agent is about to act (page-ops.ts places it before each click, type, hover, select, drag or
 * scroll at a point; the background places it before real input, agent-trusted.ts, agent-drag.ts).
 *
 *   - It moves to each target (an animated move, MOVE_MIN_MS to MOVE_MAX_MS), shows a short ripple
 *     on a click, and stays on the last spot while the agent works.
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
import { ask, ext } from './ext'

export type CursorKind = 'move' | 'click' | 'drag'
/** Above everything Walnut draws in a page (the agent frame is 2147483645). */
export const CURSOR_Z = 2147483647
export const MOVE_MIN_MS = 160
export const MOVE_MAX_MS = 300
/** A first appearance is shown this long before the step acts, so the person sees where. */
export const FIRST_MS = 120
export const RIPPLE_MS = 450
/** How long a frame waits for the background to draw its point in the top document (agent-cursor.ts SEARCH_MS and DRAW_MS fit inside). */
const UP_MS = 6000

const ARROW_PATH = 'M3 2 L3 18 L7.2 14.2 L10.2 20.6 L12.9 19.4 L9.9 13 L15.6 13 Z'
const SVG_NS = 'http://www.w3.org/2000/svg'
const STYLE = `.c{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;transition:transform var(--ms,0ms) cubic-bezier(.2,.7,.2,1);will-change:transform}
.c.hid{visibility:hidden}
.c svg{position:absolute;left:-3px;top:-2px;width:22px;height:22px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));pointer-events:none}
.c .tag{position:absolute;left:14px;top:18px;padding:2px 6px;border-radius:999px;background:#2b2118;color:#fff;font:600 10.5px/1.2 -apple-system,system-ui,"Segoe UI",sans-serif;white-space:nowrap;pointer-events:none}
.c .r{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #e8b46a;box-sizing:border-box;opacity:0;pointer-events:none}
.c .r.on{animation:walnut-ripple ${RIPPLE_MS}ms ease-out}
@keyframes walnut-ripple{from{transform:scale(.3);opacity:.95}to{transform:scale(1.6);opacity:0}}
@media (prefers-reduced-motion: reduce){.c{transition:none}.c .r.on{animation:none;opacity:.85}}`

interface Drawn { host: Host; box: HTMLElement; ring: HTMLElement; x: number; y: number }
let cur: Drawn | null = null
let masked = false
let rippleTimer: ReturnType<typeof setTimeout> | undefined
let moves = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/**
 * No animation: the person asked for less motion (or the page cannot say, as in a test's DOM), or
 * nobody sees the page now (a covered agent window), where the browser slows timers to a second
 * and a move would only hold the step up.
 */
const still = () => typeof matchMedia !== 'function' || document.visibilityState === 'hidden' || matchMedia('(prefers-reduced-motion: reduce)').matches
const isTop = () => { try { return window.top == null || window.top === window } catch { return false } }

function ensure(): Drawn {
  if (cur && cur.host.el.isConnected) return cur
  if (cur) dropHost(cur.host)
  // Marked as it is made (content.ts closes Walnut's menus on a later change to a host's attributes).
  const { host, root } = makeHost(CURSOR_Z, 'walnutCursor')
  // A point on the page, nothing of its own size: no layout, and every click goes through.
  hostStyle(host, `z-index: ${CURSOR_Z} !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; pointer-events: none !important;`)
  const style = document.createElement('style')
  style.textContent = STYLE
  const box = document.createElement('div')
  box.className = masked ? 'c hid' : 'c'
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 22 22')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  for (const [k, v] of [['d', ARROW_PATH], ['fill', '#8a5a2b'], ['stroke', '#fff'], ['stroke-width', '1.6'], ['stroke-linejoin', 'round']]) path.setAttribute(k, v)
  svg.append(path)
  box.append(svg)
  const ring = document.createElement('div')
  ring.className = 'r'
  const tag = document.createElement('div')
  tag.className = 'tag'
  tag.textContent = 'Walnut'
  box.append(ring, tag)
  root.append(style, box)
  cur = { host, box, ring, x: NaN, y: NaN }
  return cur
}

/**
 * The cursor goes to (x, y), viewport coordinates of this document, and the promise ends once it is
 * there; a click shows its ripple on arrival. `ms` sets the move's length (a drag's own length).
 */
export async function cursorAt(x: number, y: number, kind: CursorKind = 'move', ms?: number): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const c = ensure()
  const first = !Number.isFinite(c.x)
  const dist = first ? 0 : Math.hypot(x - c.x, y - c.y)
  const dur = still() || first ? 0 : Math.round(ms ?? Math.min(MOVE_MAX_MS, Math.max(MOVE_MIN_MS, MOVE_MIN_MS + dist * 0.2)))
  c.box.style.setProperty('--ms', `${dur}ms`)
  c.box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  c.x = x
  c.y = y
  moves++
  const wait = still() ? 0 : first ? FIRST_MS : dur
  if (wait) await sleep(wait)
  if (kind === 'click') ripple()
}

function ripple(): void {
  if (!cur) return
  const ring = cur.ring
  ring.classList.remove('on')
  // A new ripple starts over (the class comes back on the next frame).
  void ring.offsetWidth
  ring.classList.add('on')
  clearTimeout(rippleTimer)
  rippleTimer = setTimeout(() => ring.classList.remove('on'), RIPPLE_MS)
}

/** The agent let the tab go (or the person took it over): no cursor. */
export function cursorOff(): void {
  clearTimeout(rippleTimer)
  if (cur) dropHost(cur.host)
  cur = null
}

/** Hidden while an agent's own screenshot is taken, back after. */
export function cursorMask(on: boolean): void {
  masked = on
  if (cur) cur.box.classList.toggle('hid', on)
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
export function _cursorForTesting(): { host: HTMLElement; x: number; y: number; hidden: boolean; rippling: boolean; moves: number } | null {
  return cur && cur.host.el.isConnected ? { host: cur.host.el, x: cur.x, y: cur.y, hidden: cur.box.classList.contains('hid'), rippling: cur.ring.classList.contains('on'), moves } : null
}
export function _resetCursorForTesting(): void { cursorOff(); masked = false; moves = 0 }
