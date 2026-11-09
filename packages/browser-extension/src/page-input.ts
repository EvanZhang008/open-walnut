/**
 * The page side of the input agents use beyond a plain click or type (page-ops.ts sends them
 * here): scrolling a box inside the page, typing at a point, typing one key at a time, and the two
 * ends of a real-input drag (agent-drag.ts). Page events, as in page-agent.ts: never the person's.
 */
import * as pa from './page-agent'
import { controlOf } from './page-agent-outward'
import { DRAG_MIN_PX, SLOW_KEY_MS, SLOW_MAX } from './input-math'

const FRAMES = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED'])

/** Whether a box scrolls on its own (its content is larger and its style lets it scroll). */
function scrolls(el: Element): boolean {
  if (el === document.scrollingElement) return el.scrollHeight > innerHeight + 2 || el.scrollWidth > innerWidth + 2
  if (el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2) return false
  const cs = getComputedStyle(el)
  return /auto|scroll|overlay/.test(cs.overflowY + cs.overflowX)
}

/** The box that scrolls at an element: the element, else the nearest box around it that does, else the page. */
export function scrollableFrom(el: Element): Element {
  for (let x: Element | null = el; x; x = x.parentElement ?? ((x.getRootNode() as ShadowRoot).host ?? null)) {
    if (scrolls(x)) return x
  }
  return document.scrollingElement ?? document.documentElement
}

/** `scroll {ref | x, y, direction...}`: the box at that element or point scrolls, not the page (a list, a side panel). */
export function scrollIn(args: Record<string, unknown>): Record<string, unknown> {
  const el = typeof args.x === 'number' && typeof args.y === 'number' ? document.elementFromPoint(args.x, args.y) : pa.byRef(args.ref)
  if (!el) throw new pa.PageError(`Nothing at ${String(args.x)},${String(args.y)}.`, 'nothing_there')
  const box = scrollableFrom(el)
  const page = box === document.scrollingElement || box === document.documentElement
  const r = pa.scrollBox(box, args)
  return { ...r, box: page ? 'the page' : `${pa.roleOf(box)} "${pa.clip(pa.nameOf(box), 60)}" (${box.tagName.toLowerCase()})` }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The focused element, or nothing when the focus is on the page itself. */
function focused(): Element | null {
  const f = document.activeElement
  return f && f !== document.body ? f : null
}

/** The field a typed text goes to: the ref's, the one at a point (clicked first, as a person does), else the focused one. */
export function typeField(args: Record<string, unknown>): Element | null {
  if (args.ref !== undefined) return pa.byRef(args.ref)
  if (typeof args.x === 'number' && typeof args.y === 'number') {
    pa.click({ x: args.x, y: args.y })
    return focused() ?? pa.target({ x: args.x, y: args.y }).el
  }
  return document.activeElement
}

/** Slow typing under way stops at its next key when this moves (cancelTyping); how many run now. */
let typingRun = 0
let typing = 0

/**
 * The slow typing under way stops before its next key (the background asks when a page dialog cut
 * the step short: once the dialog is answered, the rest is not typed). Whether one was under way.
 */
export function cancelTyping(): boolean {
  const was = typing > 0
  typingRun++
  return was
}

/**
 * `type {slowly}`: each character as its own keydown, keypress, input and keyup, a key every
 * SLOW_KEY_MS, for fields that check each key (a code split over boxes, a search that suggests).
 */
export async function typeSlowly(el: Element, args: Record<string, unknown>): Promise<{ typed: string }> {
  typing++
  try { return await typeKeys(el, args, typingRun) } finally { typing-- }
}

async function typeKeys(el: Element, args: Record<string, unknown>, run: number): Promise<{ typed: string }> {
  const text = String(args.text ?? '')
  const chars = [...text]
  if (chars.length > SLOW_MAX) throw new pa.PageError(`slowly types at most ${SLOW_MAX} characters; type the rest without it.`, 'too_long')
  if (el instanceof HTMLElement) { pa.centerOf(el); el.focus() }
  const box = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null
  if (box && (box.disabled || box.readOnly)) throw new pa.PageError('That field cannot be typed in (disabled or read-only).', 'read_only')
  if (!box && !(el as HTMLElement).isContentEditable) throw new pa.PageError(`${pa.roleOf(el)} "${pa.clip(pa.nameOf(el), 40)}" is not a text field.`, 'not_a_field')
  if (args.clear === true) {
    if (box) { pa.setNative(box, ''); box.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' })) }
    else { document.execCommand('selectAll'); document.execCommand('delete') }
  }
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (i) await sleep(SLOW_KEY_MS)
    if (run !== typingRun) throw new pa.PageError(`Typing stopped after ${i} of ${chars.length} characters: a dialog opened.`, 'dialog_interrupted')
    // The page may move the focus between keys (a code split over boxes): each key goes where the focus is now.
    const at = focused() ?? el
    if (ch === '\n') { pa.key(at, 'Enter', 'keydown'); pa.key(at, 'Enter', 'keypress'); pa.key(at, 'Enter', 'keyup'); continue }
    const go = pa.key(at, ch, 'keydown')
    pa.key(at, ch, 'keypress')
    if (go) {
      if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement) {
        pa.setNative(at, at.value + ch)
        at.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }))
      } else if ((at as HTMLElement).isContentEditable) document.execCommand('insertText', false, ch)
    }
    pa.key(at, ch, 'keyup')
  }
  const last = document.activeElement ?? el
  last.dispatchEvent(new Event('change', { bubbles: true }))
  if (run !== typingRun) throw new pa.PageError('Typing stopped before it submitted: a dialog opened.', 'dialog_interrupted')
  if (args.submit === true) { pa.key(last, 'Enter', 'keydown'); pa.key(last, 'Enter', 'keyup'); if (last instanceof HTMLInputElement && last.form) last.form.requestSubmit() }
  return { typed: `${chars.length} characters, one key at a time, into ${pa.roleOf(el)} "${pa.clip(pa.nameOf(el), 60)}"` }
}

type End = { x: number; y: number; what: string }

function endOf(el: Element, x: number, y: number): End {
  if (FRAMES.has(el.tagName)) throw new pa.PageError('That end of the drag is inside a frame: real input works in the top frame only.', 'trusted_frame')
  return { x, y, what: `${pa.roleOf(el)} "${pa.clip(pa.nameOf(el), 60)}"` }
}

const onScreen = (x: number, y: number) => x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight
const middle = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }

/** What a press at a point would hit: the element itself (or inside it), else what covers it. */
function uncovered(el: Element, x: number, y: number, name: string): void {
  const top = document.elementFromPoint(x, y)
  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
    throw new pa.PageError(`${name} is covered by ${pa.roleOf(top)} "${pa.clip(pa.nameOf(top), 60)}" (${top.tagName.toLowerCase()}): close or scroll it first.`, 'covered')
  }
}

/** The nearest element holding both. */
function commonOf(a: Element, b: Element): Element {
  for (let x: Element | null = a; x; x = x.parentElement) if (x.contains(b)) return x
  return document.documentElement
}

export interface DragPoints { from: End; to: End; fromEl: Element; toEl: Element; common: Element | null }

/**
 * Both ends of a drag, on screen together: the start is scrolled into view (and refused when
 * covered, as a click is), the end is brought into view only when it is not; after any scroll both
 * are read again and checked for cover, and a start given as a point is refused (the page moved
 * under it). A drag whose ends do not fit on one screen is refused, and so is one too short to be
 * anything but a click, or one that starts and ends on the same button or link. `common` is the
 * control both ends are in, which the release would click (page-ops.ts judges it).
 */
export function dragPoints(args: Record<string, unknown>): DragPoints {
  const byPoint = !(args.ref !== undefined)
  const start = pa.target({ ref: args.ref, x: args.x, y: args.y })
  const fromEl = start.el
  // The start before the end is looked for: an end brought into view may move the page under it.
  const before = fromEl.getBoundingClientRect()
  let to: { el: Element; x: number; y: number }
  if (typeof args.to_x === 'number' && typeof args.to_y === 'number') {
    const el = document.elementFromPoint(args.to_x, args.to_y)
    if (!el) throw new pa.PageError(`Nothing at ${args.to_x},${args.to_y}.`, 'nothing_there')
    to = { el, x: args.to_x, y: args.to_y }
  } else {
    const el = pa.byRef(args.to_ref)
    let m = middle(el)
    if (!onScreen(m.x, m.y)) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
      m = middle(el)
    }
    uncovered(el, m.x, m.y, String(args.to_ref))
    to = { el, ...m }
  }
  const after = fromEl.getBoundingClientRect()
  const moved = Math.abs(after.left - before.left) > 0.5 || Math.abs(after.top - before.top) > 0.5
  let from = { x: start.x, y: start.y }
  if (moved && byPoint) {
    throw new pa.PageError('Bringing the end of the drag into view scrolled the page, so the start point is no longer where it was: scroll so both ends are on screen, look again (screenshot), then drag.', 'drag_offscreen')
  }
  if (!byPoint) {
    from = middle(fromEl)
    // The start moved with the page: what is over it now is checked again.
    if (moved) uncovered(fromEl, from.x, from.y, String(args.ref))
  }
  if (!onScreen(from.x, from.y) || !onScreen(to.x, to.y)) {
    throw new pa.PageError('Both ends of the drag must be on screen together: scroll so they are (or make the window larger with resize), then drag again.', 'drag_offscreen')
  }
  const same = controlOf(fromEl)
  if (Math.hypot(to.x - from.x, to.y - from.y) < DRAG_MIN_PX || (same && same === controlOf(to.el))) {
    throw new pa.PageError(`That drag starts and ends ${same && same === controlOf(to.el) ? `on the same ${pa.roleOf(same)} "${pa.clip(pa.nameOf(same), 40)}"` : `within ${DRAG_MIN_PX} px`}: it would only be a click. Use click for a click; a drag goes somewhere else.`, 'drag_too_short')
  }
  return { from: endOf(fromEl, from.x, from.y), to: endOf(to.el, to.x, to.y), fromEl, toEl: to.el, common: controlOf(commonOf(fromEl, to.el)) }
}
