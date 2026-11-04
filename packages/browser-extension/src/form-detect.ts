/**
 * Which inputs on a page are a login: the password fields, the username beside them, a
 * username asked on its own first (a two-step sign in), a new password (sign up, change), and
 * a one-time code. Pure DOM reading, no page writes: content.ts decides what to do with it.
 * The heuristics follow what browsers and password managers look at, in this order: the
 * `autocomplete` token the page gave, the input type, then name / id / placeholder / label words.
 */

export type FormKind = 'login' | 'signup' | 'change' | 'username-step' | 'totp'

export interface LoginGroup {
  kind: FormKind
  /** The form, or the nearest container holding these inputs when the page has no <form>. */
  root: Element
  username?: HTMLInputElement
  /** The password a login fills (the current one on a change form). */
  password?: HTMLInputElement
  /** New password fields (sign up: the password and its confirmation; change: new and confirm). */
  newPasswords: HTMLInputElement[]
  totp?: HTMLInputElement
  /** A code asked one character per box (often six boxes): `totp` is the first. */
  totpBoxes?: HTMLInputElement[]
}

const USER_WORDS = /user|e-?mail|login|account|identifier|phone|mobile|handle|\bid\b/i
const TOTP_WORDS = /otp|totp|2fa|mfa|one.?time|verification.?code|security.?code|auth.?code|\bcode\b|token/i
const NOT_USER = /search|captcha|coupon|promo|zip|postal|city|address|query|first.?name|last.?name/i
const TEXTY = new Set(['text', 'email', 'tel', '', 'username'])
/** A password field that asks for a new one: "Create a password", "Choose", "Confirm", "Repeat". */
const NEW_WORDS = /\bnew\b|create|choose|\bset\b|confirm|repeat|re-?type|re-?enter|again/i
/** The old one on a change form. */
const OLD_WORDS = /current|\bold\b|existing|previous/i
/** What a form's own button says it does. */
const SIGNUP_BUTTON = /sign.?up|register|create.{0,12}account|join\b|get.?started/i
const LOGIN_BUTTON = /sign.?in|log.?in|log on/i
/** A form with one email box that is no sign in. */
const NOT_STEP = /subscribe|newsletter|notify|search|waitlist|wait list|mailing/i

function words(el: HTMLInputElement): string {
  const label = el.labels?.[0]?.textContent ?? ''
  return [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), label].filter(Boolean).join(' ')
}

function tokens(el: HTMLInputElement): string[] {
  return (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

/** On screen and usable: a hidden honeypot field or a disabled one is never filled. */
export function usable(el: HTMLInputElement): boolean {
  if (el.disabled || el.readOnly) return false
  if (el.type === 'hidden') return false
  const r = el.getBoundingClientRect()
  if (r.width < 8 || r.height < 8) return false
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el)
  if (cs && (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05)) return false
  return true
}

function isPassword(el: HTMLInputElement): boolean {
  return el.type === 'password'
}

function isTexty(el: HTMLInputElement): boolean {
  return TEXTY.has((el.getAttribute('type') ?? '').toLowerCase()) || el.type === 'text' || el.type === 'email' || el.type === 'tel'
}

function isTotp(el: HTMLInputElement): boolean {
  if (tokens(el).includes('one-time-code')) return true
  if (!isTexty(el) && el.type !== 'number') return false
  const max = el.maxLength
  return TOTP_WORDS.test(words(el)) && !USER_WORDS.test(el.name + ' ' + el.id) && (max <= 0 || (max >= 4 && max <= 10))
}

/**
 * A code split into one box per character: four to eight boxes of one character each, one
 * right after the other on the page, none a password field.
 */
function codeBoxes(all: HTMLInputElement[]): HTMLInputElement[] | null {
  const box = (x: HTMLInputElement) => x.maxLength === 1 && !isPassword(x) && (isTexty(x) || x.type === 'number')
  for (let i = 0; i < all.length; i++) {
    if (!box(all[i])) continue
    let j = i
    while (j + 1 < all.length && box(all[j + 1])) j++
    const run = all.slice(i, j + 1)
    if (run.length >= 4 && run.length <= 8) return run
    i = j
  }
  return null
}

function usernameScore(el: HTMLInputElement): number {
  const t = tokens(el)
  if (t.includes('username') || t.includes('email') || t.includes('webauthn')) return 3
  const w = words(el)
  if (NOT_USER.test(w)) return 0
  if (el.type === 'email') return 2
  return USER_WORDS.test(w) ? 2 : 1
}

/** Inputs in `root` that are not inside a nested form of their own. */
function inputsOf(root: Element | Document): HTMLInputElement[] {
  return Array.from(root.querySelectorAll('input')).filter(usable)
}

/** The container a password field's login lives in: its form, else the closest ancestor holding a text input too. */
function rootOf(el: HTMLInputElement): Element {
  if (el.form) return el.form
  let n: Element | null = el.parentElement
  for (let i = 0; n && i < 8; i++, n = n.parentElement) {
    if (inputsOf(n).some((x) => x !== el && isTexty(x))) return n
  }
  return el.ownerDocument.body
}

/** The text of a form's send buttons (a <button> in a form sends unless it says type="button"). */
function buttonText(root: Element): string {
  const els = Array.from(root.querySelectorAll('button, input[type=submit], input[type=button], [role=button]'))
  return els
    .filter((b) => !(b instanceof HTMLButtonElement && b.type === 'button' && root.querySelectorAll('button').length > 1))
    .map((b) => (b instanceof HTMLInputElement ? b.value : b.textContent ?? '') + ' ' + (b.getAttribute('aria-label') ?? ''))
    .join(' ')
}

function before(a: Element, b: Element): boolean {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
}

function pickUsername(candidates: HTMLInputElement[], firstPassword?: HTMLInputElement): HTMLInputElement | undefined {
  const pool = firstPassword ? candidates.filter((c) => before(c, firstPassword)) : candidates
  let best: HTMLInputElement | undefined
  let bestScore = 0
  for (const c of pool) {
    const s = usernameScore(c)
    // Ties go to the later field: the one right before the password.
    if (s > 0 && s >= bestScore) { best = c; bestScore = s }
  }
  return best
}

export function findLoginGroups(doc: Document): LoginGroup[] {
  const all = inputsOf(doc)
  const passwords = all.filter(isPassword)
  const groups = new Map<Element, HTMLInputElement[]>()
  for (const p of passwords) {
    const root = rootOf(p)
    groups.set(root, [...(groups.get(root) ?? []), p])
  }
  const out: LoginGroup[] = []
  for (const [root, pws] of groups) {
    const texts = inputsOf(root).filter((x) => isTexty(x) && !isPassword(x) && !isTotp(x))
    const username = pickUsername(texts, pws[0])
    const isNew = (p: HTMLInputElement) => tokens(p).includes('new-password')
    const current = pws.find((p) => tokens(p).includes('current-password'))
    let g: LoginGroup
    if (pws.length === 1) {
      const p = pws[0]
      const buttons = buttonText(root)
      // A page's own autocomplete wins; else the field's words, else what its button says.
      const fresh = !tokens(p).includes('current-password')
        && (isNew(p) || NEW_WORDS.test(words(p)) || (SIGNUP_BUTTON.test(buttons) && !LOGIN_BUTTON.test(buttons)))
      g = fresh
        ? { kind: 'signup', root, username, newPasswords: pws }
        : { kind: 'login', root, username, password: p, newPasswords: [] }
    } else if (current || pws.length >= 3 || (OLD_WORDS.test(words(pws[0])) && !isNew(pws[0]))) {
      const cur = current ?? pws[0]
      g = { kind: 'change', root, username, password: cur, newPasswords: pws.filter((p) => p !== cur) }
    } else {
      g = { kind: 'signup', root, username, newPasswords: pws }
    }
    out.push(g)
  }
  // A username asked on its own (step one of two), with no password field anywhere on the page.
  if (!passwords.length) {
    const step = all.find((x) => isTexty(x) && !isTotp(x) && x.maxLength !== 1 && (usernameScore(x) >= 3 || (usernameScore(x) >= 2 && !!x.form))
      && !(x.form && (x.form.getAttribute('role') === 'search' || NOT_STEP.test(buttonText(x.form) + ' ' + words(x)))))
    if (step) out.push({ kind: 'username-step', root: step.form ?? doc.body, username: step, newPasswords: [] })
  }
  // A one-time code field, or a code in boxes of one character.
  const found = all.find((x) => isTotp(x))
  const boxes = codeBoxes(all)
  // The page marked only the first box (autocomplete="one-time-code"): the code still goes in all of them.
  const code = found && !boxes?.includes(found) ? found : undefined
  if (code && !out.some((g) => g.root.contains(code) && g.kind !== 'totp' && g.password)) {
    out.push({ kind: 'totp', root: code.form ?? doc.body, totp: code, newPasswords: [] })
  } else if (boxes && !out.some((g) => g.password && g.root.contains(boxes[0]))) {
    out.push({ kind: 'totp', root: boxes[0].form ?? doc.body, totp: boxes[0], totpBoxes: boxes, newPasswords: [] })
  }
  return out
}

/** The group a field belongs to, and which part of it the field is. */
export function groupOfField(groups: LoginGroup[], el: Element): { group: LoginGroup; role: 'username' | 'password' | 'new-password' | 'totp' } | null {
  for (const g of groups) {
    if (g.username === el) return { group: g, role: 'username' }
    if (g.password === el) return { group: g, role: 'password' }
    if (g.newPasswords.includes(el as HTMLInputElement)) return { group: g, role: 'new-password' }
    if (g.totp === el || g.totpBoxes?.includes(el as HTMLInputElement)) return { group: g, role: 'totp' }
  }
  return null
}

/** Set a value the way typing would, so frameworks (React, Vue, Angular) see it. */
/** Fields Walnut filled from the vault: an agent's snapshot never shows their values. */
export const walnutFilled = new WeakSet<Element>()

export function setValue(el: HTMLInputElement, value: string): void {
  walnutFilled.add(el)
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
    ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

/** What the person typed into a group, read when it is sent. */
export function readGroup(g: LoginGroup): { username?: string; password?: string } {
  const username = g.username?.value.trim() || undefined
  const password = (g.kind === 'signup' || g.kind === 'change') ? (g.newPasswords[0]?.value || undefined) : (g.password?.value || undefined)
  return { username, password }
}
