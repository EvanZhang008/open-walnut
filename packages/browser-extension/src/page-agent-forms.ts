/**
 * Finding things and filling forms in an agent's page (page-agent.ts holds the refs and the
 * single actions): find by text, every field with its label and value, a whole form at once,
 * and files put into a file input. Secrets read as "(hidden)", as in a snapshot.
 */
import {
  INTERACTIVE, PageError, all, byRef, clip, nameOf, refFor, roleOf, secret, setNative, visible,
} from './page-agent'

/** Text nodes of the page and its open shadow roots. */
function textNodes(root: Node, out: Text[] = []): Text[] {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) out.push(n as Text)
    else if ((n as Element).shadowRoot) textNodes((n as Element).shadowRoot!, out)
  }
  return out
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'WALNUT-EXT'])

/** How many matches `find` gives unless `limit` says. */
export const FIND_LIMIT = 8
/** Past this many characters of text an element only focusable is a region of the page, not a control. */
const CONTAINER_CHARS = 200

/** Words an agent adds to say what kind of control it means ("search box", "login button"), with the roles they name. */
const ROLE_WORDS: Record<string, string[]> = {
  box: ['textbox', 'searchbox', 'combobox', 'checkbox'], field: ['textbox', 'searchbox', 'combobox'], input: ['textbox', 'searchbox', 'combobox'],
  textbox: ['textbox'], searchbox: ['searchbox', 'textbox', 'combobox'], bar: ['textbox', 'searchbox', 'combobox'], button: ['button'], btn: ['button'],
  link: ['link'], checkbox: ['checkbox'], tab: ['tab'], menu: ['menu', 'menuitem', 'button'], dropdown: ['combobox', 'listbox', 'button'],
}

/**
 * The whole phrase matched nothing: the controls whose name holds every other word, in any order,
 * of the kind its role words name when one is (2026-11-11: "search box" found nothing on GitHub's
 * search page, whose box is named "Search GitHub").
 */
function byWords(w: string, exact: boolean): { els: Element[]; words: string[] } | undefined {
  if (exact) return undefined
  const parts = w.split(' ').filter(Boolean)
  const kept = parts.filter((x) => !ROLE_WORDS[x])
  const roles = [...new Set(parts.flatMap((x) => ROLE_WORDS[x] ?? []))]
  if (!kept.length || (kept.length === parts.length && parts.length < 2)) return undefined
  // A whole page region focusable as one (its name is all its text) is no control the words name.
  const named = all(document, INTERACTIVE).filter((el) => {
    const n = nameOf(el)
    return visible(el) && (roleOf(el) !== 'generic' || n.length <= CONTAINER_CHARS) && kept.every((x) => n.toLowerCase().includes(x))
  })
  const ofRole = roles.length ? named.filter((el) => roles.includes(roleOf(el))) : named
  return { els: ofRole.length ? ofRole : named, words: kept }
}

export function find(args: { text?: unknown; exact?: unknown; role?: unknown; limit?: unknown }): { matches: Array<{ ref: string; role: string; name: string; text: string; offscreen?: boolean }>; count: number; by_words?: string } {
  const want = typeof args.text === 'string' ? args.text.trim() : ''
  if (!want) throw new PageError('Say what text to find.', 'no_text')
  const exact = args.exact === true
  const role = typeof args.role === 'string' && args.role ? args.role.toLowerCase() : undefined
  // The best few by default (`limit` for more): the answer says how many matched in all.
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(100, Math.floor(args.limit)) : FIND_LIMIT
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const w = norm(want)
  const hit = (s: string) => (exact ? norm(s) === w : norm(s).includes(w))
  const seen = new Set<Element>()
  const found: Element[] = []
  const add = (el: Element | null) => { if (el && !seen.has(el) && visible(el)) { seen.add(el); found.push(el) } }
  const words = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
  /** A box that is only focusable (a tabindex on a whole page region): a container, not the control the words are on. */
  const container = (el: Element) => roleOf(el) === 'generic' && words(el).length > CONTAINER_CHARS
  // Controls by their name (a label, aria-label, placeholder, a button's value); a region's whole text is not a name.
  for (const el of all(document, INTERACTIVE)) if (!container(el) && hit(nameOf(el))) add(el)
  // Text anywhere: the control it sits in, else its own element (never a container around it:
  // 2026-11-10, "stars" gave only the repository's whole header region, not "155k stars").
  for (const t of textNodes(document.body ?? document.documentElement)) {
    const p = t.parentElement
    if (!p || SKIP.has(p.tagName) || !t.data.trim()) continue
    // Words split over inline tags ("Hello <b>world</b>") are matched on the element that holds them.
    if (exact ? !hit(p.textContent ?? '') : !hit(t.data) && !hit(p.textContent ?? '')) continue
    const ctl = p.closest(INTERACTIVE)
    add(ctl && !container(ctl) ? ctl : p)
  }
  // Nothing has the phrase: the controls named with its words (role words read as the kind).
  let loose: string | undefined
  if (!found.length) {
    const b = byWords(w, exact)
    if (b?.els.length) { b.els.forEach(add); loose = b.words.join(' ') }
  }
  // Best first: the words as a control's whole name, then a control, then short text (a label, a
  // count, a link) before a long block, then what is on screen; then the shorter, then page order.
  const onScreen = (el: Element) => { const r = el.getBoundingClientRect(); return !(r.bottom < 0 || r.top > innerHeight) }
  const size = (el: Element) => words(el).length
  const score = (el: Element) => (norm(nameOf(el)) === w ? 4 : 0) + (roleOf(el) !== 'generic' ? 2 : 0) + (onScreen(el) ? 1 : 0)
    + (size(el) <= 60 ? 2 : size(el) <= CONTAINER_CHARS ? 1 : -2)
  const list = found.filter((el) => !role || roleOf(el) === role || el.tagName.toLowerCase() === role)
    .map((el, i) => ({ el, i, s: score(el), n: size(el) })).sort((a, b) => b.s - a.s || a.n - b.n || a.i - b.i).map((x) => x.el)
  const matches = list.slice(0, limit).map((el) => {
    const r = el.getBoundingClientRect()
    return {
      ref: refFor(el), role: roleOf(el), name: clip(nameOf(el), 100), text: clip((el as HTMLElement).innerText ?? el.textContent ?? '', 160),
      ...(r.bottom < 0 || r.top > innerHeight ? { offscreen: true } : {}),
    }
  })
  return { matches, count: list.length, ...(loose && matches.length ? { by_words: loose } : {}) }
}

const FIELDS = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea, [contenteditable=""], [contenteditable=true], [role=textbox], [role=combobox], [role=checkbox], [role=switch]'

export interface FieldValue {
  ref: string; label: string; name?: string; id?: string; type: string; value: string
  checked?: boolean; options?: string[]; required?: boolean; disabled?: boolean; hidden?: boolean
}

function valueOf(el: Element): Pick<FieldValue, 'type' | 'value' | 'checked' | 'options'> {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return { type: el.type, value: el.value, checked: el.checked }
    if (el.type === 'file') return { type: 'file', value: [...(el.files ?? [])].map((f) => f.name).join(', ') }
    return { type: el.type || 'text', value: secret(el) ? (el.value ? '(hidden)' : '') : clip(el.value, 500) }
  }
  if (el instanceof HTMLTextAreaElement) return { type: 'textarea', value: clip(el.value, 2000) }
  if (el instanceof HTMLSelectElement) {
    return { type: el.multiple ? 'select-multiple' : 'select', value: [...el.selectedOptions].map((o) => clip(o.textContent ?? o.value, 80)).join(', '), options: [...el.options].slice(0, 30).map((o) => clip(o.textContent ?? o.value, 60)) }
  }
  const aria = el.getAttribute('aria-checked')
  if (aria) return { type: el.getAttribute('role') ?? 'checkbox', value: '', checked: aria === 'true' }
  return { type: el.getAttribute('role') ?? 'textbox', value: clip((el as HTMLElement).innerText ?? '', 2000) }
}

export function formValues(args: { max?: unknown }): { fields: FieldValue[]; count: number } {
  const max = typeof args.max === 'number' && args.max > 0 ? Math.min(500, args.max) : 300
  const els = all(document, FIELDS)
  const fields = els.slice(0, max).map((el): FieldValue => {
    const name = el.getAttribute('name') ?? undefined
    const id = el.id || undefined
    return {
      ref: refFor(el), label: clip(nameOf(el), 100), ...(name ? { name } : {}), ...(id ? { id } : {}), ...valueOf(el),
      ...((el as HTMLInputElement).required ? { required: true } : {}),
      ...((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
      ...(!visible(el) ? { hidden: true } : {}),
    }
  })
  return { fields, count: els.length }
}

/** The field a label names: its label or name exactly, else the one whose label holds the words. */
function byLabel(label: string): Element | undefined {
  const w = label.replace(/\s+/g, ' ').trim().toLowerCase()
  const els = all(document, FIELDS).filter(visible)
  const names = (el: Element) => [nameOf(el), el.getAttribute('name') ?? '', el.id, el.getAttribute('placeholder') ?? ''].map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
  return els.find((el) => names(el).includes(w)) ?? els.find((el) => names(el)[0].includes(w))
}

const TRUE = /^(true|on|yes|1|checked)$/i

function fillOne(el: Element, value: unknown): string {
  const v = typeof value === 'boolean' ? String(value) : String(value ?? '')
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const want = el.type === 'radio' ? (TRUE.test(v) || v === el.value || v.toLowerCase() === nameOf(el).trim().toLowerCase()) : TRUE.test(v)
    // A click, so the page sees the change as it would a person's.
    if (el.checked !== want && !(el.type === 'radio' && !want)) el.click()
    return el.checked ? 'checked' : 'unchecked'
  }
  if (el instanceof HTMLSelectElement) {
    const opt = [...el.options].find((o) => o.value === v) ?? [...el.options].find((o) => (o.textContent ?? '').trim().toLowerCase() === v.trim().toLowerCase())
    if (!opt) throw new PageError(`No option "${v}" in ${clip(nameOf(el), 40)}. Options: ${[...el.options].map((o) => clip(o.textContent ?? '', 30)).slice(0, 20).join(', ')}.`, 'no_option')
    el.value = opt.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return clip(opt.textContent ?? opt.value, 60)
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) throw new PageError(`${clip(nameOf(el), 40)} cannot be filled (disabled or read-only).`, 'read_only')
    if (el instanceof HTMLInputElement && el.type === 'file') throw new PageError('A file field takes files: use upload.', 'not_a_field')
    el.focus()
    setNative(el, v)
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: v }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return `${v.length} characters`
  }
  if ((el as HTMLElement).isContentEditable) {
    ;(el as HTMLElement).focus()
    document.execCommand('selectAll'); document.execCommand('delete')
    document.execCommand('insertText', false, v)
    return `${v.length} characters`
  }
  throw new PageError(`${roleOf(el)} "${clip(nameOf(el), 40)}" is not a field to fill.`, 'not_a_field')
}

/** Every field is found first: one that is not there fills nothing. */
export function fillForm(args: { fields?: unknown }): { filled: Array<{ ref: string; field: string; set: string }> } {
  const list = Array.isArray(args.fields) ? args.fields as Array<{ ref?: unknown; label?: unknown; value?: unknown }> : []
  if (!list.length) throw new PageError('Give the fields: [{ref or label, value}].', 'no_field')
  const resolved = list.slice(0, 100).map((f) => {
    if (typeof f?.ref === 'string') return { f, el: byRef(f.ref) }
    const el = typeof f?.label === 'string' ? byLabel(f.label) : undefined
    return { f, el }
  })
  const missing = resolved.filter((r) => !r.el).map((r) => String(r.f?.label ?? r.f?.ref ?? '?'))
  if (missing.length) throw new PageError(`No field for ${missing.map((m) => `"${clip(m, 40)}"`).join(', ')}: nothing was filled. Use form_values to see the fields.`, 'no_field')
  const filled = resolved.map(({ f, el }) => ({ ref: refFor(el!), field: clip(nameOf(el!), 60), set: fillOne(el!, f.value) }))
  return { filled }
}

function bytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Files into a file input, as a person's pick would put them: the input's files, then input and change. */
/**
 * The element a CSS selector names in this frame: for a file field a page hides (styled with a
 * button of its own), which snapshot and find do not list.
 */
export function bySelector(selector: unknown): Element {
  if (typeof selector !== 'string' || !selector.trim()) throw new PageError('Give a CSS selector.', 'bad_request')
  let el: Element | null
  try { el = document.querySelector(selector) } catch { throw new PageError(`Not a CSS selector: ${clip(selector, 120)}.`, 'bad_selector') }
  if (!el) throw new PageError(`Nothing on the page matches ${clip(selector, 120)}.`, 'no_match')
  return el
}

/** The file input an element is, holds, or labels. */
export function fileInputOf(el: Element): HTMLInputElement | null {
  return el instanceof HTMLInputElement && el.type === 'file' ? el : (el.querySelector?.('input[type=file]') as HTMLInputElement | null) ?? (el instanceof HTMLLabelElement && el.control instanceof HTMLInputElement && el.control.type === 'file' ? el.control : null)
}

export function upload(args: { ref?: unknown; selector?: unknown; files?: unknown }): { uploaded: string[]; into: string } {
  const bySel = typeof args.selector === 'string' && args.ref === undefined
  const el = bySel ? bySelector(args.selector) : byRef(args.ref)
  const input = fileInputOf(el)
  if (!input) throw new PageError(`${bySel ? clip(String(args.selector), 120) : String(args.ref)} is not a file field (input type=file).`, 'not_a_file_field')
  if (input.disabled) throw new PageError('That file field is disabled.', 'read_only')
  const files = Array.isArray(args.files) ? args.files as Array<{ name?: unknown; type?: unknown; base64?: unknown }> : []
  if (!files.length) throw new PageError('No files to put in.', 'no_files')
  if (files.length > 1 && !input.multiple) throw new PageError('That field takes one file.', 'one_file')
  const dt = new DataTransfer()
  for (const f of files) {
    if (typeof f?.name !== 'string' || typeof f.base64 !== 'string') throw new PageError('Each file needs a name and its bytes (base64).', 'bad_file')
    dt.items.add(new File([bytes(f.base64) as BlobPart], f.name, { type: typeof f.type === 'string' ? f.type : '' }))
  }
  input.files = dt.files
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { uploaded: [...input.files].map((f) => `${f.name} (${f.size} bytes)`), into: bySel && !nameOf(input) ? `the file field ${clip(String(args.selector), 80)}` : `${roleOf(input)} "${clip(nameOf(input), 60)}"` }
}
