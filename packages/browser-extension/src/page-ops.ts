/**
 * The page side of an agent's command (content.ts hands every `agent` message here): the actions
 * agents call (page-agent.ts, page-agent-forms.ts), and the background's own steps for a full
 * page screenshot and for real input (where to point, what to focus). Each step that acts at a
 * point or on an element moves the agent's cursor there first (page-cursor.ts, cursor-acts.ts).
 */
import * as pa from './page-agent'
import * as forms from './page-agent-forms'
import { clickFacts, clickTarget, enterFacts, judgeOutward, messageOf, orderTotal, outwardHold, pressFacts } from './page-agent-outward'
import { cancelTyping, dragPoints, scrollIn, typeField, typeSlowly } from './page-input'
import { annotate, refOfLabel } from './page-annotate'
import { onScreenMiddle, pointAt, type CursorKind } from './page-cursor'

/** position:fixed and sticky elements hidden after the first slice of a full screenshot, so they are drawn once. */
let hiddenFixed: Array<{ el: HTMLElement; v: string }> = []

function hideFixed(): void {
  if (hiddenFixed.length) return
  for (const el of pa.all(document, 'body *')) {
    if (!(el instanceof HTMLElement) || el.tagName === 'WALNUT-EXT') continue
    const pos = getComputedStyle(el).position
    if (pos !== 'fixed' && pos !== 'sticky') continue
    hiddenFixed.push({ el, v: el.style.getPropertyValue('visibility') })
    el.style.setProperty('visibility', 'hidden', 'important')
  }
}

function showFixed(): void {
  for (const h of hiddenFixed) { if (h.v) h.el.style.setProperty('visibility', h.v); else h.el.style.removeProperty('visibility') }
  hiddenFixed = []
}

const flat = { behavior: 'instant' as ScrollBehavior }

function capture(args: Record<string, unknown>): Record<string, unknown> {
  const doc = document.scrollingElement ?? document.documentElement
  switch (args.step) {
    case 'start':
      return { x: scrollX, y: scrollY, w: innerWidth, h: innerHeight, total: Math.max(doc.scrollHeight, innerHeight) }
    case 'at':
      if (args.hideFixed === true) hideFixed()
      scrollTo({ left: 0, top: typeof args.y === 'number' ? args.y : 0, ...flat })
      return { y: scrollY }
    default:
      showFixed()
      scrollTo({ left: typeof args.x === 'number' ? args.x : 0, top: typeof args.y === 'number' ? args.y : 0, ...flat })
      return { y: scrollY }
  }
}

const FRAMES = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED'])
const intoFrame = (el: Element | null) => !!el && FRAMES.has(el.tagName)

/**
 * Where real input should go (the debugger's own mouse and keys, agent-trusted.ts): the point on
 * the element, refused when something covers it, the same as a click here, or when it is a frame.
 * `focus` puts the caret in it first (and `clear` empties it); `mark` tags a file input so the
 * debugger can find it; `active` only checks that the focus is not inside a frame.
 */

async function locate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  // The middle of the page (a wheel with no element named).
  if (args.middle === true) args = { ...args, x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }
  // Keys with no element go where the focus is: never into a frame (its site is not checked here).
  if (args.active === true) {
    if (intoFrame(document.activeElement)) throw new pa.PageError('The focus is inside a frame: real input works in the top frame only.', 'trusted_frame')
    return held(args, trustedHow(args).map((how): Part => [how, document.activeElement])) ?? {}
  }
  // A file field a page hides (upload {selector}): the debugger needs only its mark, no point.
  if (typeof args.selector === 'string' && args.ref === undefined && typeof args.mark === 'string' && /^[a-z0-9]{6,40}$/.test(args.mark)) {
    const input = forms.fileInputOf(forms.bySelector(args.selector))
    if (!input) throw new pa.PageError(`${pa.clip(args.selector, 120)} is not a file field (input type=file).`, 'not_a_file_field')
    input.setAttribute('data-walnut-upload', args.mark)
    return { x: 0, y: 0, what: `the file field ${pa.clip(args.selector, 80)}` }
  }
  const { el, x, y } = pa.target(args)
  // Checked before the focus moves: a held step leaves the page as it was.
  const h = held(args, trustedHow(args).map((how): Part => [how, el]))
  if (h) return h
  if (intoFrame(el)) throw new pa.PageError('That point is inside a frame: real input works in the top frame only (use the frame\'s ref without trusted).', 'trusted_frame')
  if (args.focus === true && el instanceof HTMLElement) {
    el.focus()
    if (args.clear === true && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      pa.setNative(el, '')
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }))
    }
  }
  if (typeof args.mark === 'string' && /^[a-z0-9]{6,40}$/.test(args.mark)) {
    const input = el instanceof HTMLInputElement && el.type === 'file' ? el : el.querySelector('input[type=file]')
    if (!input) throw new pa.PageError(`${String(args.ref)} is not a file field (input type=file).`, 'not_a_file_field')
    input.setAttribute('data-walnut-upload', args.mark)
  }
  // The point the debugger is about to use (agent-trusted.ts names the kind: a click shows its ripple).
  if ((args.cursor === 'click' || args.cursor === 'move') && el.getBoundingClientRect().width > 0) await pointAt(x, y, args.cursor)
  return { x, y, what: `${pa.roleOf(el)} "${pa.clip(pa.nameOf(el), 60)}"` }
}

/**
 * A step that buys, sends or deletes waits for the person (page-agent-outward.ts): the op answers
 * `hold` and does nothing, unless the approval the server got for exactly this step comes with it
 * (`outward_ok`, the step's signature; the server never takes it from an agent).
 * `how`: a click on `el`; Enter in `el` (also typed text that submits or holds a newline, with the
 * text about to be typed); or a key combo pressed with the focus on `el`.
 */
type How = { click: true } | { enter: true; typing?: string } | { key: string }
type Part = [How, Element | null]
type Hold = ReturnType<typeof outwardHold>

/** What one part of a step would be held for (null: it neither buys, sends nor deletes). */
function holdOf(how: How, el: Element | null): Hold | null {
  if (!el) return null
  const facts = 'click' in how ? clickFacts(el) : 'enter' in how ? enterFacts(el, how.typing) : pressFacts(el, how.key)
  const o = facts ? judgeOutward(facts) : null
  if (!o) return null
  const shown = 'click' in how || el.matches('button, a[href], [role=button], [role=link]') ? clickTarget(el) : el
  const verb = 'click' in how ? 'click' : `press ${'key' in how ? how.key : 'Enter'} in`
  // For the person: the message a send carries, the total an order comes to (when the page shows it).
  const message = o.kind === 'send' ? messageOf('click' in how ? clickTarget(el) : el, 'enter' in how ? how.typing : undefined) : undefined
  const total = o.kind === 'buy' ? orderTotal(document.body?.innerText ?? '') : undefined
  return outwardHold(o, `${verb} ${pa.roleOf(shown)} "${pa.clip(pa.nameOf(shown), 60)}"`, { message, total })
}

/** Several parts of one step, asked about once: the gravest kind leads, the yes names every part. */
function joinHolds(hs: Hold[]): Hold {
  const lead = hs.find((h) => h.kind === 'buy') ?? hs.find((h) => h.kind === 'delete') ?? hs[0]
  const message = hs.find((h) => h.message)?.message
  const total = hs.find((h) => h.total)?.total
  return {
    ...lead, what: hs.map((h) => h.what).join(', then ').slice(0, 200), why: hs.map((h) => h.why).join('; ').slice(0, 200),
    ...(message ? { message } : {}), ...(total ? { total } : {}), sig: hs.map((h) => h.sig).join('&').slice(0, 400),
  }
}

/**
 * The step's hold, or null when it may go ahead. A step of several parts (a click at a point and
 * then Enter in the field it focused; a drag's press, release and the click the release makes) is
 * one ask: one hold names them all, and the one yes covers them all.
 */
function held(args: Record<string, unknown>, parts: Part[]): Record<string, unknown> | null {
  const holds: Hold[] = []
  for (const [how, el] of parts) {
    const h = holdOf(how, el)
    if (h && !holds.some((x) => x.sig === h.sig)) holds.push(h)
  }
  if (!holds.length) return null
  const hold = holds.length === 1 ? holds[0] : joinHolds(holds)
  return args.outward_ok === hold.sig ? null : { hold }
}

/**
 * Typed text that sends: `submit`, and with `slowly` a newline too (it is the Enter key there, as in
 * real typing, which agent-trusted.ts counts the same way). A newline typed at once is only text in
 * the field: page events press no key for it.
 */
const typedEnter = (args: Record<string, unknown>): How | null => {
  const text = String(args.text ?? '')
  return args.submit === true || (args.slowly === true && text.includes('\n')) ? { enter: true, typing: text } : null
}

/**
 * What a trusted step (locate) asks to be judged: `outward` click, enter (with `typing`), or key
 * (with `key`); `then_enter` adds Enter (with `typing`) after a click, for typing at a point.
 */
function trustedHow(args: Record<string, unknown>): How[] {
  const typing = typeof args.typing === 'string' ? { typing: args.typing } : {}
  if (args.outward === 'click') return [{ click: true }, ...(args.then_enter === true ? [{ enter: true as const, ...typing }] : [])]
  if (args.outward === 'enter') return [{ enter: true, ...typing }]
  if (args.outward === 'key' && typeof args.key === 'string') return [{ key: args.key }]
  return []
}

const atPoint = (args: Record<string, unknown>) => args.ref === undefined && typeof args.x === 'number' && typeof args.y === 'number'

/** The cursor to an element's middle when it is on screen (nothing is scrolled for it); a bad ref stays the step's own error. */
async function toElement(get: () => Element | null, kind: CursorKind = 'move'): Promise<void> {
  let el: Element | null = null
  try { el = get() } catch { return }
  const m = el && el !== document.body ? onScreenMiddle(el) : null
  if (m) await pointAt(m.x, m.y, kind)
}

/** The element a typed text goes to (as pa.type picks it; at a point, the element there). */
const typeTarget = (args: Record<string, unknown>): Element | null => (args.ref !== undefined ? pa.byRef(args.ref) : atPoint(args) ? pa.target(args).el : document.activeElement)

/** `scroll` that names an element or a point and how far: that box scrolls (page-input.ts); a ref alone brings the element into view. */
const scrollsInside = (args: Record<string, unknown>) => (args.ref !== undefined || atPoint(args))
  && (args.direction !== undefined || args.to !== undefined || args.by !== undefined || args.amount !== undefined)

/** `type {x, y}`: a click at the point (judged as a click), then the text into the field it focused; one ask for both. */
async function typeOp(args: Record<string, unknown>): Promise<unknown> {
  const field = typeTarget(args)
  const how = typedEnter(args)
  const parts: Part[] = [...(atPoint(args) ? [[{ click: true }, field] as Part] : []), ...(how ? [[how, field] as Part] : [])]
  const h = held(args, parts)
  if (h) return h
  // The cursor to where the text goes: a click at the point, else the field (scrolled into view as the typing does).
  if (atPoint(args)) await pointAt(Number(args.x), Number(args.y), 'click')
  else await toElement(() => { if (field instanceof HTMLElement && args.ref !== undefined) pa.centerOf(field); return field })
  if (atPoint(args)) {
    const el = typeField(args)
    if (!el) throw new pa.PageError(`Nothing to type in at ${String(args.x)},${String(args.y)}.`, 'no_field')
    return args.slowly === true ? typeSlowly(el, args) : pa.type({ ...args, ref: pa.refFor(el) })
  }
  if (args.slowly === true) {
    const el = typeField(args)
    if (!el || el === document.body) throw new pa.PageError('No field is focused: give the ref of the field to type in.', 'no_field')
    return typeSlowly(el, args)
  }
  return pa.type(args)
}

export async function runPageOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  pa.setFrame(args.frame)
  // A number from an annotated screenshot names its element (page-annotate.ts).
  if (typeof args.label === 'number' && args.ref === undefined && (op === 'click' || op === 'hover' || op === 'locate')) args = { ...args, ref: refOfLabel(args.label) }
  switch (op) {
    case 'snapshot': return pa.snapshot(typeof args.max === 'number' ? args.max : undefined)
    case 'text': return pa.text(typeof args.max === 'number' ? args.max : undefined)
    case 'click': {
      const t = pa.target(args)
      const h = held(args, [[{ click: true }, t.el]])
      // A held click points at what it waits on; one that goes ahead shows its ripple there.
      await pointAt(t.x, t.y, h ? 'move' : 'click')
      return h ?? pa.click(args)
    }
    case 'hover': { const t = pa.target(args); await pointAt(t.x, t.y); return pa.hover(args) }
    case 'type': return typeOp(args)
    case 'select': await toElement(() => pa.byRef(args.ref)); return pa.select(args)
    case 'press': return held(args, [[{ key: String(args.key ?? '') }, document.activeElement]]) ?? pa.press(args)
    case 'scroll': {
      // At a point or over an element: the cursor is there (a scroll of the whole page has no point).
      if (atPoint(args)) await pointAt(Number(args.x), Number(args.y))
      else if (scrollsInside(args)) await toElement(() => pa.byRef(args.ref))
      if (scrollsInside(args)) return scrollIn(args)
      const r = pa.scroll(args)
      if (args.ref !== undefined) await toElement(() => pa.byRef(args.ref))
      return r
    }
    case 'annotate': return annotate()
    case 'drag_points': {
      // A drag presses and releases: judged as the clicks it may make (where it starts, where it
      // ends, and the control both are in, which the release clicks), one ask for all.
      const d = dragPoints(args)
      // Where it starts; the background moves it on to the end while the debugger drags (agent-drag.ts).
      await pointAt(d.from.x, d.from.y, 'drag')
      return held(args, [d.common, d.fromEl, d.toEl].map((el): Part => [{ click: true }, el])) ?? { from: d.from, to: d.to }
    }
    case 'cancel_input': return { cancelled: cancelTyping() }
    case 'wait': return pa.wait(args)
    case 'has_text': return pa.hasText(args)
    case 'find': return forms.find(args)
    case 'form_values': return forms.formValues(args)
    case 'fill_form': return forms.fillForm(args)
    case 'upload': await toElement(() => (typeof args.selector === 'string' && args.ref === undefined ? forms.bySelector(args.selector) : pa.byRef(args.ref))); return forms.upload(args)
    case 'capture': return capture(args)
    case 'locate': return locate(args)
  }
  throw new pa.PageError(`Unknown page action ${op}.`, 'bad_action')
}
