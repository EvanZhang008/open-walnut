/**
 * The page side of the input agents use beyond a plain click or type (page-ops.ts sends them
 * here): scrolling a box inside the page, typing at a point, typing one key at a time, and the two
 * ends of a real-input drag (agent-drag.ts). Page events, as in page-agent.ts: never the person's.
 */
import * as pa from './page-agent'
import { SLOW_KEY_MS, SLOW_MAX } from './input-math'

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

/**
 * `type {slowly}`: each character as its own keydown, keypress, input and keyup, a key every
 * SLOW_KEY_MS, for fields that check each key (a code split over boxes, a search that suggests).
 */
export async function typeSlowly(el: Element, args: Record<string, unknown>): Promise<{ typed: string }> {
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
  if (args.submit === true) { pa.key(last, 'Enter', 'keydown'); pa.key(last, 'Enter', 'keyup'); if (last instanceof HTMLInputElement && last.form) last.form.requestSubmit() }
  return { typed: `${chars.length} characters, one key at a time, into ${pa.roleOf(el)} "${pa.clip(pa.nameOf(el), 60)}"` }
}

type End = { x: number; y: number; what: string }

function endOf(el: Element, x: number, y: number): End {
  if (FRAMES.has(el.tagName)) throw new pa.PageError('That end of the drag is inside a frame: real input works in the top frame only.', 'trusted_frame')
  return { x, y, what: `${pa.roleOf(el)} "${pa.clip(pa.nameOf(el), 60)}"` }
}

const onScreen = (x: number, y: number) => x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight

/**
 * Both ends of a drag, on screen together: the start is scrolled into view (and refused when
 * covered, as a click is), the end is brought into view only when it is not, and then the start is
 * read again; a drag whose ends do not fit on one screen is refused.
 */
export function dragPoints(args: Record<string, unknown>): { from: End; to: End } {
  const start = pa.target({ ref: args.ref, x: args.x, y: args.y })
  const fromEl = start.el
  let to: { el: Element; x: number; y: number }
  if (typeof args.to_x === 'number' && typeof args.to_y === 'number') {
    const el = document.elementFromPoint(args.to_x, args.to_y)
    if (!el) throw new pa.PageError(`Nothing at ${args.to_x},${args.to_y}.`, 'nothing_there')
    to = { el, x: args.to_x, y: args.to_y }
  } else {
    const el = pa.byRef(args.to_ref)
    let r = el.getBoundingClientRect()
    if (!onScreen(r.left + r.width / 2, r.top + r.height / 2)) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
      r = el.getBoundingClientRect()
    }
    to = { el, x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  let from = { x: start.x, y: start.y }
  if (args.ref !== undefined) {
    const r = fromEl.getBoundingClientRect()
    from = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  if (!onScreen(from.x, from.y) || !onScreen(to.x, to.y)) {
    throw new pa.PageError('Both ends of the drag must be on screen together: scroll so they are (or make the window larger with resize), then drag again.', 'drag_offscreen')
  }
  return { from: endOf(fromEl, from.x, from.y), to: endOf(to.el, to.x, to.y) }
}
