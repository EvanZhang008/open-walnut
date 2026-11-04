/**
 * The page side of an agent's command (content.ts hands every `agent` message here): the actions
 * agents call (page-agent.ts, page-agent-forms.ts), and the background's own steps for a full
 * page screenshot and for real input (where to point, what to focus).
 */
import * as pa from './page-agent'
import * as forms from './page-agent-forms'

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
    return {}
  }
  const { el, x, y } = pa.target(args)
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

export async function runPageOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  pa.setFrame(args.frame)
  switch (op) {
    case 'snapshot': return pa.snapshot(typeof args.max === 'number' ? args.max : undefined)
    case 'text': return pa.text(typeof args.max === 'number' ? args.max : undefined)
    case 'click': return pa.click(args)
    case 'hover': return pa.hover(args)
    case 'type': return pa.type(args)
    case 'select': return pa.select(args)
    case 'press': return pa.press(args)
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
