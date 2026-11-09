/**
 * Steps that act in the person's name outside the browser: buying or paying, sending or posting,
 * deleting. An agent's click, Enter or other key (or typed text that submits) that would take one
 * waits for the person's yes through Walnut's approvals, also on a site agents may use freely
 * (routes/browser-v1.ts asks; page-ops.ts holds the step until the answer names it). Opening,
 * reading, typing, searching, filtering and signing in never ask. Only the agent's own steps are
 * judged: `evaluate`, the page's own scripts, its own requests and a link that acts on a plain GET
 * are not (docs/reference/browser-control.md says so to the person).
 *
 * Judged from the element and the form it sends, in a few plain rules:
 *  1. its name (text, aria-label, title, value) says buy, pay, place order, send, post, publish,
 *     delete, remove or close an account, cancel a subscription;
 *  2. it sends a form holding card details (a checkout's submit);
 *  3. it sends a form holding a message the agent or the page wrote (a textarea or an editable box
 *     with text, or a plain text box with no form), or it is Enter in such a box (chat boxes send on Enter);
 *  4. a key: any combo ending in Enter counts as Enter (Meta+Enter sends in many apps), and Enter or
 *     Space on a focused button or link works it as a click does (keyActs, pressFacts).
 * "Add to cart" is not outward: nothing leaves the person's hands until the order is placed.
 * A link that goes to another page is navigation (only "delete" counts there).
 */

export type OutwardKind = 'buy' | 'send' | 'delete'

export interface OutwardFacts {
  /** The element's words: text, aria-label, title, a submit button's value. */
  name: string
  /** A link that goes to another page (not "#" or a script). */
  navigates?: boolean
  /** Activating it sends a form (a submit button, Enter in a form's field). */
  submits?: boolean
  /** The form it sends. */
  form?: { payment?: boolean; message?: boolean; search?: boolean }
  /** Enter in a box holding a message. */
  enterInMessage?: boolean
}

export interface Outward { kind: OutwardKind; why: string }

const BUY = /\b(buy|purchase|pay|place (my |your |the )?order|order now|complete (my |your |the )?(purchase|order|checkout)|confirm (and pay|purchase|order|payment)|submit (order|payment)|donate)\b/i
const SEND = /\b(send|post|publish|tweet|submit (comment|review|feedback|message|post|application))\b/i
const DELETE = /\b(delete|erase|(remove|close|deactivate|terminate) (my |your |this |the )?account|deactivate|cancel (my |your |this |the )?(account|subscription|membership|order|plan))\b/i
/** Sign-in helpers that "send" to the person themself. */
const SIGN_IN = /\bsend (me )?(a |an |the )?(new )?(code|link|otp|pin|verification|one-time)/i

export function judgeOutward(f: OutwardFacts): Outward | null {
  const name = f.name.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (DELETE.test(name)) return { kind: 'delete', why: `"${name}" deletes something` }
  if (!f.navigates && !SIGN_IN.test(name)) {
    if (BUY.test(name)) return { kind: 'buy', why: `"${name}" buys or pays` }
    if (SEND.test(name)) return { kind: 'send', why: `"${name}" sends or posts` }
  }
  if (f.submits && f.form?.payment) return { kind: 'buy', why: 'it sends a form with card details' }
  if (f.submits && f.form?.message && !f.form.search) return { kind: 'send', why: 'it sends a form with a message' }
  if (f.enterInMessage) return { kind: 'send', why: 'Enter sends the message in that box' }
  return null
}

// ── the facts, read from the page ──

const CLICKABLE = 'button, input[type=submit], input[type=image], input[type=button], a[href], [role=button], [role=link], [role=menuitem]'
const PAYMENT = /\b(cc-number|cc-csc|cc-exp|cc-name)\b/
const PAYMENT_NAME = /(card.?num|cardnumber|ccnum|cvc|cvv|csc|security.?code)/i
const SEARCHY = /search|query|^q$/i

/** A text field's value: what the field shows, or `typing` when the agent is about to type it. */
function filled(el: Element, typing?: { el: Element; text: string }): boolean {
  if (typing?.el === el && typing.text.trim()) return true
  if (el instanceof HTMLTextAreaElement) return !!el.value.trim()
  return !!(el as HTMLElement).isContentEditable && !!(el.textContent ?? '').trim()
}

function searchBox(el: Element): boolean {
  return SEARCHY.test(`${el.getAttribute('name') ?? ''}`) || SEARCHY.test(el.getAttribute('aria-label') ?? '') || SEARCHY.test(el.getAttribute('placeholder') ?? '')
    || el.getAttribute('role') === 'searchbox' || el.getAttribute('role') === 'combobox'
}

function formFacts(form: HTMLFormElement | null, typing?: { el: Element; text: string }): OutwardFacts['form'] {
  if (!form) return undefined
  const fields = [...form.elements]
  const payment = fields.some((x) => PAYMENT.test((x.getAttribute('autocomplete') ?? '').toLowerCase()) || PAYMENT_NAME.test(`${x.getAttribute('name') ?? ''} ${x.id}`))
  const message = [...fields, ...form.querySelectorAll('[contenteditable=""], [contenteditable=true]')]
    .some((x) => (x instanceof HTMLTextAreaElement || (x as HTMLElement).isContentEditable) && !searchBox(x) && filled(x, typing))
  const search = form.getAttribute('role') === 'search' || /\/search\b/i.test(form.getAttribute('action') ?? '')
  return { payment, message, search }
}

function words(el: Element): string {
  const parts = [el.getAttribute('aria-label'), (el as HTMLElement).innerText ?? el.textContent, el.getAttribute('title')]
  if (el instanceof HTMLInputElement) parts.push(el.value, el.getAttribute('alt'))
  return parts.filter(Boolean).join(' ')
}

/** The control a click on `el` works (a button's icon or text is part of the button). */
export const clickTarget = (el: Element): Element => el.closest(CLICKABLE) ?? el

/** The button, link or menu item `el` is part of, if any (a drag that starts and ends on one is a click). */
export const controlOf = (el: Element): Element | null => el.closest(CLICKABLE)

/** What a click on `el` would do. */
export function clickFacts(el: Element): OutwardFacts {
  const target = clickTarget(el)
  const a = target.closest('a[href]')
  const href = a instanceof HTMLAnchorElement ? a.getAttribute('href') ?? '' : ''
  const navigates = !!a && !!href && href !== '#' && !/^javascript:/i.test(href)
  const submitter = target instanceof HTMLButtonElement ? (target.type === 'submit' ? target : null)
    : target instanceof HTMLInputElement && (target.type === 'submit' || target.type === 'image') ? target : null
  return { name: words(target), navigates, submits: !!submitter?.form, form: formFacts(submitter?.form ?? null) }
}

/** A chat box with no form: a plain text input whose Enter the page takes to send (never a sign-in or search box). */
function chatInput(el: Element, t?: { el: Element; text: string }): boolean {
  if (!(el instanceof HTMLInputElement) || el.form || el.type !== 'text' || searchBox(el)) return false
  if (/\b(username|email|one-time-code|tel|postal-code|address)/i.test(el.getAttribute('autocomplete') ?? '')) return false
  return t?.el === el ? !!t.text.trim() : !!el.value.trim()
}

/** What Enter in `el` would do (also `type ... --submit`, or text with a newline, with the text it is about to type). */
export function enterFacts(el: Element | null, typing?: string): OutwardFacts {
  if (!el) return { name: '' }
  // Enter on a focused button or link works it, as a click does.
  if (el.matches(CLICKABLE)) return clickFacts(el)
  const t = typing !== undefined ? { el, text: typing } : undefined
  const message = ((el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) && !searchBox(el) && filled(el, t)) || chatInput(el, t)
  const form = el instanceof HTMLInputElement ? el.form : null
  if (!form) return { name: '', enterInMessage: message }
  const button = form.querySelector('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]')
  return { name: button ? words(button) : '', submits: true, form: formFacts(form, t), enterInMessage: message }
}

/**
 * What a key does that can send: any combo that ends in Enter (Control+Enter and Meta+Enter send
 * in many apps), and Space, which works a focused button or link. Other keys: nothing to judge.
 */
export function keyActs(combo: string): 'enter' | 'activate' | null {
  const last = combo.split('+').pop()?.trim() ?? ''
  if (/^(enter|numpadenter|return)$/i.test(last)) return 'enter'
  if (combo === ' ' || /^(space|spacebar)$/i.test(last)) return 'activate'
  return null
}

/** What pressing `combo` with the focus on `el` would do (null: nothing that can send). */
export function pressFacts(el: Element | null, combo: string): OutwardFacts | null {
  const how = keyActs(combo)
  if (!how || !el) return null
  if (how === 'enter') return enterFacts(el)
  return el.matches(CLICKABLE) ? clickFacts(el) : null
}

/**
 * What real input (agent-trusted.ts) asks the page to judge before it acts: a click; a key, any
 * combo (pressFacts decides); typed text that submits or holds a newline, since real typing presses
 * Enter for each newline. The page answers with the step's hold (page-ops.ts locate).
 */
export function trustedOutward(action: string, args: Record<string, unknown>): Record<string, unknown> {
  if (action === 'click') return { outward: 'click' }
  if (action === 'press') return { outward: 'key', key: String(args.key ?? '') }
  if (action === 'type') {
    const text = String(args.text ?? '')
    return args.submit === true || text.includes('\n') ? { outward: 'enter', typing: text } : {}
  }
  return {}
}

const clip = (t: string, n: number) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x }
const boxText = (x: Element): string => (x instanceof HTMLTextAreaElement || x instanceof HTMLInputElement ? x.value : (x as HTMLElement).isContentEditable ? (x.textContent ?? '') : '')

/**
 * The message a send would carry, for the person to read before they say yes: the text the
 * agent is about to type, else the box's own text, else the message boxes of the form it sends.
 */
export function messageOf(el: Element, typing?: string): string | undefined {
  if (typing !== undefined && typing.trim()) return clip(typing, 300)
  const own = boxText(el)
  if (own.trim() && !searchBox(el)) return clip(own, 300)
  const form = (el as HTMLButtonElement).form ?? el.closest('form')
  if (!form) return undefined
  const parts = [...form.querySelectorAll('textarea, [contenteditable=""], [contenteditable=true]')].filter((x) => !searchBox(x)).map(boxText).filter((t) => t.trim())
  return parts.length ? clip(parts.join(' / '), 300) : undefined
}

const MONEY = '(?:[$€£¥]\\s?\\d[\\d,]*(?:\\.\\d{1,2})?|\\d[\\d,]*(?:\\.\\d{1,2})?\\s?(?:USD|EUR|GBP|CAD|AUD|JPY|[$€£¥]))'
const TOTAL = new RegExp(`\\b(order total|grand total|total due|amount due|total to pay|total)\\b[^\\n\\d$€£¥]{0,24}(${MONEY})`, 'gi')

/** The order total the page shows, if it shows one ("Order total: $42.10"; a grand total wins over a plain "Total"). */
export function orderTotal(text: string): string | undefined {
  let best: { rank: number; v: string } | undefined
  for (const m of text.matchAll(TOTAL)) {
    const rank = /^total$/i.test(m[1]) ? 1 : 2
    if (!best || rank >= best.rank) best = { rank, v: m[2].trim() }
  }
  return best?.v
}

/**
 * What the person is asked about and what the approval names: the step, the page, and for a send
 * the message, for an order the total the page shows. The signature covers them all, so an
 * approval of one message or one total does not send another.
 */
export function outwardHold(o: Outward, what: string, extra: { message?: string; total?: string } = {}): {
  kind: OutwardKind; why: string; what: string; url: string; sig: string; message?: string; total?: string
} {
  const url = location.href.split('#')[0]
  const message = o.kind === 'send' ? extra.message : undefined
  const total = o.kind === 'buy' ? extra.total : undefined
  return {
    kind: o.kind, why: o.why, what, url, ...(message ? { message } : {}), ...(total ? { total } : {}),
    sig: `${o.kind}|${what}|${location.origin}${location.pathname}|${message ?? ''}|${total ?? ''}`.slice(0, 400),
  }
}
