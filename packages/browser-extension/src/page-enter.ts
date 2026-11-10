/**
 * Enter as page events: the page path of `press Enter` and `type --submit` (page-ops.ts runs it;
 * real input presses the debugger's own Enter, agent-trusted.ts). 2026-11-10: in a covered agent
 * window a site's search box (no form, a script that tests `keyCode === 13`) took the text and
 * ignored the Enter, and the step said "the page content changed".
 *
 *   1. The field has the focus, and the typing has settled (a framework renders the typed value
 *      before it reads it in its key handler).
 *   2. The watch is marked (page-probe.ts), so the step's answer tells what the Enter changed apart
 *      from what the typing did.
 *   3. keydown, keypress (only when keydown was not taken, as a browser does) and keyup, each with
 *      key, code, keyCode, which (page-agent.ts key), bubbling and composed.
 *   4. In a form whose page did not take the key: the browser's implicit submission (its default
 *      button clicked; nothing when that button is disabled, or with no submit button and more than
 *      one field).
 *   5. No form, and nothing on the page answered within ENTER_LOOK_MS (no new address, nothing
 *      changed outside the field): the search button beside the field is clicked, only for a text
 *      field that says it is a search by its own words or sits in a search area (never the page's
 *      text, never the page as the area), a button named for searching, and only when the page's
 *      judge lets it (page-ops.ts held). Else the answer says Enter changed nothing (agent-change.ts).
 *   On anything but a text field (the page itself after a click on plain text): the keys alone.
 */
import * as pa from './page-agent'
import { deepActive, fieldBox, markWatches, textField } from './page-probe'

/** Between the typing and its Enter. */
export const ENTER_PAUSE_MS = 60
/** How long an Enter with no form is given to show an answer before the search button is tried. */
export const ENTER_LOOK_MS = 700

export interface Entered { submit?: string; enter_quiet?: true }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** From now on: did the page answer (a new address, a page going away, a change outside the field)? */
function answerLook(field: Element): { seen: () => boolean; stop: () => void } {
  const href = location.href
  let seen = false
  const box = fieldBox(field)
  const own = (n: Node | null) => {
    const el = n instanceof Element ? n : n?.parentElement
    return !!el && (box.contains(el) || !!el.closest('walnut-ext'))
  }
  const obs = typeof MutationObserver === 'function' ? new MutationObserver((recs) => { if (recs.some((r) => !own(r.target))) seen = true }) : null
  obs?.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  const gone = () => { seen = true }
  addEventListener('pagehide', gone)
  addEventListener('beforeunload', gone)
  return {
    seen: () => seen || location.href !== href,
    stop: () => { obs?.disconnect(); removeEventListener('pagehide', gone); removeEventListener('beforeunload', gone) },
  }
}

/** A field's own words: its type, role, label, placeholder, aria-label, name and id (never the page's text). */
function ownWords(field: Element): string {
  const labels = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? Array.from(field.labels ?? []).map((l) => l.textContent ?? '') : []
  return [field.getAttribute('type'), field.getAttribute('role'), field.getAttribute('aria-label'), field.getAttribute('placeholder'),
    field.getAttribute('name'), field.id, ...labels].filter(Boolean).join(' ')
}

const SEARCH_WORDS = /search|query|look ?up|\bfind\b|^q$|\bq\b/i
/** A search button by its name: "Search", "Find", "Search the docs" (short); never "Submit request" or "Go Premium". */
const BUTTON_WORDS = /^(search|find)\b/i
/** Inside a search area only, a type=submit button named so. */
const AREA_WORDS = /^(search|find|go|submit)$/i
const NOT_IT = /clear|reset|cancel|close|advanced|filter|voice|camera|image|prefix/i
const SEARCH_AREA = '[role=search], search, form[role=search]'
const isPage = (el: Element | null) => !el || el === document.body || el === document.documentElement

/**
 * The search area around a search field: an enclosing [role=search] or <search>, else (the field's
 * own words say search: type=search, role searchbox, its label, placeholder or name) the nearest box
 * around it, up to four, that holds a button; never the page itself.
 */
function searchContext(field: Element): { area: Element; marked: boolean } | null {
  const area = field.closest(SEARCH_AREA)
  if (area && !isPage(area)) return { area, marked: true }
  const own = ownWords(field)
  if (!/\bsearch(box)?\b/i.test(field.getAttribute('type') ?? '') && !/searchbox/i.test(field.getAttribute('role') ?? '') && !SEARCH_WORDS.test(own)) return null
  let p: Element | null = field.parentElement
  for (let i = 0; p && !isPage(p) && i < 4; i++, p = p.parentElement) if (p.querySelector('button, input[type=submit], [role=button]')) return { area: p, marked: false }
  return null
}

/** The search area's own button: named for searching (short), or a submit button of a marked search area; never a clear or filter button. */
export function searchButton(field: Element): Element | null {
  if (!textField(field)) return null
  const ctx = searchContext(field)
  if (!ctx) return null
  for (const b of pa.all(ctx.area, 'button, input[type=submit], input[type=image], [role=button]')) {
    if (b === field || b.contains(field) || !pa.visible(b) || (b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true') continue
    const name = pa.nameOf(b).replace(/\s+/g, ' ').trim()
    if (!name || name.length > 30 || NOT_IT.test(name)) continue
    if (BUTTON_WORDS.test(name)) return b
    if (ctx.marked && AREA_WORDS.test(name) && (b.getAttribute('type') ?? '').toLowerCase() === 'submit') return b
  }
  return null
}

/** The fields whose Enter submits a form by itself (a browser's implicit submission). */
const BLOCKING = /^(text|search|url|tel|email|password|date|month|week|time|datetime-local|number)$/

/**
 * A browser's own Enter in a form field: a click on the form's default button (its first submit
 * button), nothing when that button is disabled; with no submit button, the form is sent only when it
 * has one such field.
 */
function implicitSubmit(field: HTMLInputElement, form: HTMLFormElement): string | undefined {
  if (!BLOCKING.test(field.type || 'text')) return undefined
  const button = Array.from(form.querySelectorAll('button, input[type=submit], input[type=image]'))
    .find((b) => b instanceof HTMLInputElement ? true : ((b.getAttribute('type') ?? 'submit').toLowerCase() === 'submit'))
  if (button) {
    if ((button as HTMLButtonElement).disabled) return undefined
    ;(button as HTMLElement).click()
    return 'form'
  }
  const fields = Array.from(form.querySelectorAll('input')).filter((i) => BLOCKING.test((i as HTMLInputElement).type || 'text'))
  if (fields.length !== 1) return undefined
  form.requestSubmit()
  return 'form'
}

export interface EnterOpts {
  /** A short pause first: the typing settles. */
  settle?: boolean
  /** Judges the Enter again on the field right before the key; throws to refuse it (page-ops.ts). */
  recheck?: (field: Element) => void
  /** The page's judge for the search button (page-ops.ts held); without it no button is clicked. */
  mayClick?: (button: Element) => boolean
}

/**
 * Enter in `field` (the steps above). Only a text field gets a form sent or a search button
 * clicked; on any other element (the page itself after a click on plain text) the keys alone, as a
 * person's Enter there.
 */
export async function submitFrom(field: Element, opts: EnterOpts = {}): Promise<Entered> {
  if (opts.settle) await sleep(ENTER_PAUSE_MS)
  // Nothing awaited from here to the keys: what is judged is what gets them.
  opts.recheck?.(field)
  if (field instanceof HTMLElement && deepActive() !== field && !isPage(field)) field.focus()
  markWatches()
  const text = textField(field)
  const look = answerLook(field)
  try {
    const go = pa.key(field, 'Enter', 'keydown')
    const kept = go && pa.key(field, 'Enter', 'keypress')
    pa.key(field, 'Enter', 'keyup')
    if (!text) return {}
    const form = field instanceof HTMLInputElement ? field.form : null
    if (form) return kept && implicitSubmit(field as HTMLInputElement, form) ? { submit: 'form' } : {}
    for (let t = 0; t < ENTER_LOOK_MS && !look.seen(); t += 50) await sleep(50)
    if (look.seen()) return {}
    const b = searchButton(field)
    if (!b || !opts.mayClick?.(b)) return { enter_quiet: true }
    const name = `${pa.roleOf(b)} "${pa.clip(pa.nameOf(b), 40)}"`
    try { pa.click({ ref: pa.refFor(b) }) } catch { return { enter_quiet: true } }
    return { submit: name }
  } finally { look.stop() }
}
