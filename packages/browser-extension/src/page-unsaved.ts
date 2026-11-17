/**
 * Work in this page that leaving it would lose (agent-leave.ts asks before an agent's navigate,
 * back or close): a text box or an editor (contenteditable) typed into since the page loaded that
 * still holds a draft (MIN_CHARS), and a file field whose files were chosen (an upload). Only input
 * events count, so a value a script set never does; a search box never does; a form sent
 * (submit), or the fields near a Save, Send or Post button that was clicked (a page that saves with
 * a fetch sends no submit), are no longer unsaved. Passwords are not listed (fill_login's), and no
 * value is ever named, only the field.
 */
import { all, clip, nameOf } from './page-agent'

const typed = new Set<Element>()
let watching = false

/** Listens from the page's start (content.ts): what got input, and what a sent form took. */
export function watchUnsaved(): void {
  if (watching) return
  watching = true
  const note = (e: Event) => { const t = e.composedPath()[0]; if (t instanceof Element) typed.add(t) }
  document.addEventListener('input', note, true)
  document.addEventListener('change', note, true)
  document.addEventListener('submit', (e) => {
    const form = e.target
    if (form instanceof HTMLFormElement) sent(form)
  }, true)
  document.addEventListener('click', (e) => {
    const t = e.composedPath()[0]
    const b = t instanceof Element ? t.closest('button, [role="button"], input[type="submit"]') : null
    if (!b || !(isSubmit(b) || SENDS.test(nameOf(b)))) return
    // Its form, else the nearest box holding a typed field, else the whole page.
    const form = b.closest('form')
    let box: Element | null = form ?? b.parentElement
    while (box && ![...typed].some((el) => box!.contains(el))) box = box.parentElement
    sent(box ?? document.documentElement)
  }, true)
}

/** The words of a button that saves or sends what is typed. */
const SENDS = /\b(save|send|post|submit|publish|reply|comment|upload|update|apply|create|done|confirm|share|tweet)\b/i
const isSubmit = (b: Element) => (b instanceof HTMLButtonElement && b.type === 'submit' && !!b.form) || (b instanceof HTMLInputElement && b.type === 'submit')
function sent(root: Element): void {
  for (const el of [...typed]) if (root.contains(el)) typed.delete(el)
}

const SEARCH = /search|query|filter|^q$/i
function isSearch(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === 'search') return true
  if (el.getAttribute('role') === 'searchbox' || el.closest('[role="search"], search')) return true
  return [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].some((v) => !!v && SEARCH.test(v))
}

/**
 * Text counts as work only in a text box or an editor, from this many characters: a draft, a
 * reply, a message. A one-line field (a name, an email, a filter) and a short note are cheap to
 * type again, and counting them would stop every agent that fills a form and moves on.
 */
export const MIN_CHARS = 20

export interface Unsaved { what: string; kind: 'text' | 'file'; chars?: number; files?: string[] }

function editorOf(el: Element): HTMLElement | null {
  let host = el instanceof HTMLElement && el.isContentEditable ? el : el.parentElement?.closest('[contenteditable]') as HTMLElement | null
  while (host?.parentElement?.isContentEditable) host = host.parentElement
  return host && host.isContentEditable ? host : null
}

export function unsaved(): { unsaved: Unsaved[]; count: number } {
  const out: Unsaved[] = []
  const seen = new Set<Element>()
  // Every file field holding files that were chosen and not sent yet (the page's own picker or an agent's upload).
  for (const el of all(document, 'input[type="file"]')) {
    const files = (el as HTMLInputElement).files
    if (!files?.length || !typed.has(el)) continue
    seen.add(el)
    out.push({ what: clip(nameOf(el) || 'a file field', 80), kind: 'file', files: [...files].slice(0, 5).map((f) => clip(f.name, 80)) })
  }
  for (const el of [...typed]) {
    if (!el.isConnected) { typed.delete(el); continue }
    if (el instanceof HTMLInputElement) continue
    if (el instanceof HTMLTextAreaElement) {
      if (seen.has(el) || isSearch(el)) continue
      const v = el.value.trim()
      if (v.length < MIN_CHARS) continue
      seen.add(el)
      out.push({ what: clip(nameOf(el) || el.getAttribute('placeholder') || 'a text box', 80), kind: 'text', chars: v.length })
      continue
    }
    const ed = editorOf(el)
    if (!ed || seen.has(ed) || isSearch(ed)) continue
    seen.add(ed)
    const t = (ed.innerText ?? ed.textContent ?? '').trim()
    if (t.length >= MIN_CHARS) out.push({ what: clip(nameOf(ed) || 'an editor', 80), kind: 'text', chars: t.length })
  }
  return { unsaved: out.slice(0, 20), count: out.length }
}
