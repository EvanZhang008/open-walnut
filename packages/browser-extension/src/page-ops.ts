/**
 * The page side of an agent's command (content.ts hands every `agent` message here): the actions
 * agents call (page-agent.ts, page-agent-forms.ts), and the background's own steps for a full
 * page screenshot and for real input (where to point, what to focus).
 */
import * as pa from './page-agent'
import * as forms from './page-agent-forms'
import { clickFacts, clickTarget, enterFacts, judgeOutward, outwardHold, pressFacts } from './page-agent-outward'

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

function locate(args: Record<string, unknown>): Record<string, unknown> {
  // Keys with no element go where the focus is: never into a frame (its site is not checked here).
  if (args.active === true) {
    if (intoFrame(document.activeElement)) throw new pa.PageError('The focus is inside a frame: real input works in the top frame only.', 'trusted_frame')
    const how = trustedHow(args)
    const h = how ? held(args, how, document.activeElement) : null
    return h ?? {}
  }
  const { el, x, y } = pa.target(args)
  // Checked before the focus moves: a held step leaves the page as it was.
  const how = trustedHow(args)
  const h = how ? held(args, how, el) : null
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
function held(args: Record<string, unknown>, how: How, el: Element | null): Record<string, unknown> | null {
  if (!el) return null
  const facts = 'click' in how ? clickFacts(el) : 'enter' in how ? enterFacts(el, how.typing) : pressFacts(el, how.key)
  const o = facts ? judgeOutward(facts) : null
  if (!o) return null
  const shown = 'click' in how || el.matches('button, a[href], [role=button], [role=link]') ? clickTarget(el) : el
  const verb = 'click' in how ? 'click' : `press ${'key' in how ? how.key : 'Enter'} in`
  const hold = outwardHold(o, `${verb} ${pa.roleOf(shown)} "${pa.clip(pa.nameOf(shown), 60)}"`)
  return args.outward_ok === hold.sig ? null : { hold }
}

/**
 * Typed text that sends: `submit`. (A newline typed here is only text in the field: page events
 * press no key for it. Real typing presses Enter for each, so agent-trusted.ts counts it as submit.)
 */
const typedEnter = (args: Record<string, unknown>): How | null => (args.submit === true ? { enter: true, typing: String(args.text ?? '') } : null)

/** What a trusted step (locate) asks to be judged: `outward` click, enter (with `typing`), or key (with `key`). */
function trustedHow(args: Record<string, unknown>): How | null {
  if (args.outward === 'click') return { click: true }
  if (args.outward === 'enter') return { enter: true, ...(typeof args.typing === 'string' ? { typing: args.typing } : {}) }
  if (args.outward === 'key' && typeof args.key === 'string') return { key: args.key }
  return null
}

/** The element a typed text goes to (as pa.type picks it). */
const typeTarget = (args: Record<string, unknown>): Element | null => (args.ref !== undefined ? pa.byRef(args.ref) : document.activeElement)

export async function runPageOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  pa.setFrame(args.frame)
  switch (op) {
    case 'snapshot': return pa.snapshot(typeof args.max === 'number' ? args.max : undefined)
    case 'text': return pa.text(typeof args.max === 'number' ? args.max : undefined)
    case 'click': return held(args, { click: true }, pa.target(args).el) ?? pa.click(args)
    case 'hover': return pa.hover(args)
    case 'type': { const how = typedEnter(args); return (how ? held(args, how, typeTarget(args)) : null) ?? pa.type(args) }
    case 'select': return pa.select(args)
    case 'press': return held(args, { key: String(args.key ?? '') }, document.activeElement) ?? pa.press(args)
    case 'scroll': return pa.scroll(args)
    case 'wait': return pa.wait(args)
    case 'find': return forms.find(args)
    case 'form_values': return forms.formValues(args)
    case 'fill_form': return forms.fillForm(args)
    case 'upload': return forms.upload(args)
    case 'capture': return capture(args)
    case 'locate': return locate(args)
  }
  throw new pa.PageError(`Unknown page action ${op}.`, 'bad_action')
}
