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
 *   4. In a form whose page did not take the key: the form is sent (requestSubmit), as a browser's
 *      own Enter would.
 *   5. No form, and nothing on the page answered within ENTER_LOOK_MS (no new address, nothing
 *      changed outside the field): the search button beside the field is clicked, only in a search
 *      (a search field or area, a button named for it), and only when the page's judge lets it
 *      (page-ops.ts held). Else the answer says Enter changed nothing (agent-change.ts).
 */
import * as pa from './page-agent'
import { fieldBox, markWatches } from './page-probe'

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

const SEARCH_WORDS = /search|find|query|look ?up/i
const BUTTON_WORDS = /^\s*(search|go|find|submit)\b|\bsearch\s*$/i
const NOT_IT = /clear|reset|cancel|close|advanced|filter|voice|camera|image|prefix/i

/** A search field, or a field in a search area: the button fallback is only for these. */
function searchContext(field: Element): Element | null {
  const area = field.closest('[role=search], search')
  if (area) return area
  const words = `${field.getAttribute('type') ?? ''} ${field.getAttribute('role') ?? ''} ${pa.nameOf(field)} ${field.getAttribute('name') ?? ''} ${field.id}`
  if (!SEARCH_WORDS.test(words)) return null
  // The nearest box around the field (up to four) that holds a button.
  let p: Element | null = field.parentElement
  for (let i = 0; p && i < 4; i++, p = p.parentElement) if (p.querySelector('button, input[type=submit], [role=button]')) return p
  return null
}

/** The search area's own button, named for searching (or the submit button of a search area); never a clear or filter button. */
export function searchButton(field: Element): Element | null {
  const area = searchContext(field)
  if (!area) return null
  const inArea = area.matches('[role=search], search')
  for (const b of pa.all(area, 'button, input[type=submit], input[type=image], [role=button]')) {
    if (b === field || b.contains(field) || !pa.visible(b) || (b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true') continue
    const name = pa.nameOf(b).trim()
    if (NOT_IT.test(name)) continue
    if (BUTTON_WORDS.test(name) || (inArea && b.getAttribute('type') === 'submit')) return b
  }
  return null
}

/**
 * Enter in `field` (steps above). `mayClick`: the page's judge for the search button (page-ops.ts
 * held); without it no button is clicked.
 */
export async function submitFrom(field: Element, opts: { settle?: boolean; mayClick?: (button: Element) => boolean } = {}): Promise<Entered> {
  if (field instanceof HTMLElement && document.activeElement !== field) field.focus()
  if (opts.settle) await sleep(ENTER_PAUSE_MS)
  markWatches()
  const look = answerLook(field)
  try {
    const go = pa.key(field, 'Enter', 'keydown')
    const kept = go && pa.key(field, 'Enter', 'keypress')
    pa.key(field, 'Enter', 'keyup')
    const form = field instanceof HTMLInputElement ? field.form : null
    if (kept && form) { form.requestSubmit(); return { submit: 'form' } }
    if (form) return {}
    for (let t = 0; t < ENTER_LOOK_MS && !look.seen(); t += 50) await sleep(50)
    if (look.seen()) return {}
    const b = searchButton(field)
    if (!b || !opts.mayClick?.(b)) return { enter_quiet: true }
    const name = `${pa.roleOf(b)} "${pa.clip(pa.nameOf(b), 40)}"`
    try { pa.click({ ref: pa.refFor(b) }) } catch { return { enter_quiet: true } }
    return { submit: name }
  } finally { look.stop() }
}
