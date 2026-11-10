/**
 * Two small looks the background takes at a page around an agent's step (content script side):
 *
 *   - The delivery probe (agent-trusted.ts): armed right before the debugger sends its real mouse
 *     or keys, it counts the trusted events of that kind the page then receives. Chrome drops real
 *     input on a page it does not draw (the agent window covered or minimized) and still answers
 *     the debugger "ok" (2026-11-10, a click on a link returned ok and the page saw no event at
 *     all), so a step is done only when its page saw it.
 *   - The change watch (agent-change.ts): from right before a step to its answer, whether the page
 *     changed (a mutation outside Walnut's own elements, a scroll anywhere in it) and a hash of its
 *     fields' values, so an acting step can say what it changed. Never the page's words. A change of
 *     the field being typed in (its value attribute, a clear button its box shows) is the field's
 *     own, never "the page content changed" (2026-11-10: a typed search read so while nothing was
 *     searched). A mark (page-enter.ts, right before Enter) splits what the typing changed from what
 *     the Enter did.
 */

/** The trusted events that show a step's input reached the page, by the step's kind. */
export const PROBE_EVENTS: Record<string, string[]> = {
  click: ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'],
  hover: ['pointermove', 'mousemove', 'pointerover', 'mouseover'],
  drag: ['pointerdown', 'mousedown', 'dragstart'],
  scroll: ['wheel'],
  press: ['keydown', 'keyup', 'keypress'],
  type: ['keydown', 'keypress', 'beforeinput', 'input'],
}
/**
 * A hover counts only moves near its point: the person moving their own mouse over the window is
 * not it. A press of the button, a wheel or a key the person makes at that very moment is too
 * unlikely to judge by place (and a page zoom could move the point a little).
 */
const NEAR_PX = 12
/** An armed probe or watch nobody reads is dropped after this. */
const LOOK_MS = 60_000
const ID = /^[a-z0-9]{6,40}$/

interface Probe { kind: string; seen: number; off: () => void; timer: ReturnType<typeof setTimeout> }
const probes = new Map<string, Probe>()

/** Starts counting the step's trusted events (`x`, `y`: where a hover goes). */
export function armProbe(id: string, kind: string, x?: number, y?: number): void {
  const types = PROBE_EVENTS[kind]
  if (!types || !ID.test(id)) return
  disarm(id)
  const at = kind === 'hover' && typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
  const p: Probe = { kind, seen: 0, off: () => undefined, timer: setTimeout(() => disarm(id), LOOK_MS) }
  const on = (e: Event) => {
    if (!e.isTrusted) return
    const m = e as MouseEvent
    if (at && typeof m.clientX === 'number' && (Math.abs(m.clientX - at.x) > NEAR_PX || Math.abs(m.clientY - at.y) > NEAR_PX)) return
    p.seen++
  }
  for (const t of types) addEventListener(t, on, { capture: true, passive: true })
  p.off = () => { for (const t of types) removeEventListener(t, on, { capture: true }) }
  probes.set(id, p)
}

function disarm(id: string): void {
  const p = probes.get(id)
  if (!p) return
  p.off()
  clearTimeout(p.timer)
  probes.delete(id)
}

const FRAMES = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED'])

/**
 * What the probe saw: `armed: false` when it cannot tell, which never counts as dropped: this
 * document never armed it (the step loaded another page), or a key step's focus is in a frame
 * now (an editor that moves its caret into a frame of its own takes the keys there). `done`
 * disarms it.
 */
export function readProbe(id: unknown, done: boolean): { armed: boolean; seen: number } {
  const p = typeof id === 'string' ? probes.get(id) : undefined
  if (!p) return { armed: false, seen: 0 }
  const keys = p.kind === 'press' || p.kind === 'type'
  const out = keys && p.seen === 0 && FRAMES.has(document.activeElement?.tagName ?? '') ? { armed: false, seen: 0 } : { armed: true, seen: p.seen }
  if (done) disarm(id as string)
  return out
}

/** A 32-bit FNV-1a of a string. */
function hash(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

/** The fields' values, hashed (a typed value changes no DOM): never read out. */
function valuesHash(): number {
  let h = 0x811c9dc5
  for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
    const f = el as HTMLInputElement
    h = hash(f.type === 'checkbox' || f.type === 'radio' ? String(f.checked) : String(f.value ?? ''), h)
  }
  return h
}

const scrollOf = () => Math.round((document.scrollingElement?.scrollTop ?? 0) + (document.scrollingElement?.scrollLeft ?? 0) * 7)

/** Walnut's own element (its cursor, its frame), or a node in one. */
function walnutOwn(n: Node | null): boolean {
  const el = n instanceof Element ? n : n?.parentElement
  return !!el?.closest('walnut-ext')
}

/** The element that has the focus, inside open shadow roots too. */
export function deepActive(): Element | null {
  let a: Element | null = document.activeElement
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement
  return a
}

const TEXT_FIELDS = 'input, textarea, [contenteditable=""], [contenteditable=true]'

/** A field a person types in (not a checkbox or a button). */
export function textField(el: Element | null): el is Element {
  if (!el || el === document.body) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color'].includes(el.type)
  return (el as HTMLElement).isContentEditable === true || /^(textbox|searchbox|combobox)$/.test(el.getAttribute('role') ?? '')
}

/**
 * The field's own box: the field, and the boxes around it (up to three) that hold no words and no
 * other field (a styled wrapper with its icon and clear button). Not a form or a search area that
 * has a label or a button with words.
 */
export function fieldBox(field: Element): Element {
  let box = field
  for (let i = 0; i < 3; i++) {
    const p = box.parentElement
    if (!p || p === document.body || p === document.documentElement) break
    if ((p.textContent ?? '').replace(field.textContent ?? '', '').trim()) break
    if (p.querySelectorAll(TEXT_FIELDS).length > 1) break
    box = p
  }
  return box
}

/** A mutation of the focused text field or its own box: the field's change, not the page's. */
function ownOfField(target: Node | null): boolean {
  const f = deepActive()
  if (!textField(f) || !target) return false
  if (f === target || f.contains(target)) return true
  const box = fieldBox(f)
  return box !== f && box.contains(target)
}

interface Mark { mutations: number; scrolls: number; values: number; scroll: number }
interface Watch { mutations: number; fields: number; scrolls: number; mark?: Mark; stop: () => void; timer: ReturnType<typeof setTimeout> }
const watches = new Map<string, Watch>()

/** Starts watching the page for a step's change. */
export function watchChanges(id: string): void {
  if (!ID.test(id)) return
  stopWatch(id)
  const w: Watch = { mutations: 0, fields: 0, scrolls: 0, stop: () => undefined, timer: setTimeout(() => stopWatch(id), LOOK_MS) }
  const obs = typeof MutationObserver === 'function' ? new MutationObserver((recs) => {
    for (const r of recs) {
      if (walnutOwn(r.target)) continue
      // Walnut's cursor or frame put into (or taken out of) the document is not the page's change.
      if (r.type === 'childList' && [...Array.from(r.addedNodes ?? []), ...Array.from(r.removedNodes ?? [])].every((x) => walnutOwn(x))) continue
      if (ownOfField(r.target)) { w.fields++; continue }
      w.mutations++
    }
  }) : null
  obs?.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  // A scroll of the page or of any box in it (scroll does not bubble: a capture listener sees it).
  const onScroll = () => { w.scrolls++ }
  addEventListener('scroll', onScroll, { capture: true, passive: true })
  w.stop = () => { obs?.disconnect(); removeEventListener('scroll', onScroll, { capture: true }) }
  watches.set(id, w)
}

function stopWatch(id: string): void {
  const w = watches.get(id)
  if (!w) return
  w.stop()
  clearTimeout(w.timer)
  watches.delete(id)
}

/** Right before an Enter (page-enter.ts, agent-trusted.ts): what the watch sees from here on is the Enter's. */
export function markWatches(): void {
  if (!watches.size) return
  const values = valuesHash()
  const scroll = scrollOf()
  for (const w of watches.values()) w.mark = { mutations: w.mutations, scrolls: w.scrolls, values, scroll }
}

/**
 * The page now (the 'agent-digest' message, content.ts): its fields' values and scroll, and with
 * `watch` it starts watching; with `read` what that watch saw (`watching: false` when this
 * document never started it), `done` ending it.
 */
export function pageDigest(args: { watch?: unknown; read?: unknown; done?: unknown } = {}): Record<string, unknown> {
  if (typeof args.watch === 'string') watchChanges(args.watch)
  const out: Record<string, unknown> = { values: valuesHash(), scroll: scrollOf() }
  if (typeof args.read === 'string') {
    const w = watches.get(args.read)
    Object.assign(out, w ? { watching: true, mutations: w.mutations, fields: w.fields, scrolls: w.scrolls } : { watching: false })
    // What changed after the mark: the Enter's part of a typed text that submits.
    if (w?.mark) {
      out.enter = { mutations: w.mutations - w.mark.mutations, scrolls: w.scrolls - w.mark.scrolls, values: out.values !== w.mark.values, scroll: out.scroll !== w.mark.scroll }
    }
    if (args.done === true) stopWatch(args.read)
  }
  return out
}
