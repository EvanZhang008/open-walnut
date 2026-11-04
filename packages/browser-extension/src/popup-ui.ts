/** Small pieces the popup's views share: the toast, an error line, copying with the 30 s clear, icon buttons, the top bar. */
import { ask } from './ext'
import { h, svg } from './dom'
import { CLEAR_MS } from './bg-clipboard'

const S = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
/** The popup's own icons (the shared ones are in dom.ts). */
const POPUP_ICONS = {
  back: `<svg ${S}><path d="m15 18-6-6 6-6"/></svg>`,
  next: `<svg ${S}><path d="m9 18 6-6-6-6"/></svg>`,
  eyeOff: `<svg ${S}><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2"/><path d="M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`,
  hash: `<svg ${S}><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/></svg>`,
  check: `<svg ${S}><path d="M20 6 9 17l-5-5"/></svg>`,
  gear: `<svg ${S}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  edit: `<svg ${S}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
}

export function popupIcon(name: keyof typeof POPUP_ICONS): HTMLElement {
  return h('span', { 'aria-hidden': 'true', style: 'display:inline-grid' }, svg(POPUP_ICONS[name]))
}

/**
 * A button that shows only an icon: its name is said to screen readers and shown in a tooltip
 * on hover and keyboard focus at once (a browser's own `title` waits a second and shows nothing
 * on focus).
 */
export function iconButton(content: Node, label: string, onClick: (e: Event) => void, attrs: Record<string, unknown> = {}): HTMLButtonElement {
  return h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, 'data-tip': label, ...attrs, onclick: (e: Event) => { e.stopPropagation(); onClick(e) } }, content) as HTMLButtonElement
}

export function toast(text: string): void {
  let t = document.querySelector<HTMLElement>('.toast')
  if (!t) { t = h('div', { class: 'toast', role: 'status' }); document.body.append(t) }
  t.textContent = text
  t.classList.add('on')
  setTimeout(() => t!.classList.remove('on'), 1600)
}

export function errLine(text?: string): HTMLElement {
  return h('p', { class: 'err', role: 'alert' }, text ?? '')
}

/**
 * Put a secret on the clipboard (this page has the person's click), and have it cleared in 30 s
 * if it is still there: by the background (it outlives this popup), and by this page too while
 * it stays open (the side panel), where the background has no clipboard of its own.
 */
export async function copySecret(value: string, what: string): Promise<void> {
  try { await navigator.clipboard.writeText(value) } catch { toast('Could not copy.'); return }
  toast(`${what} copied`)
  void ask({ type: 'copied', value })
  setTimeout(() => {
    void navigator.clipboard.readText().then((now) => { if (now === value) return navigator.clipboard.writeText('') }).catch(() => undefined)
  }, CLEAR_MS)
}

export function switchRow(id: string, title: string, sub: string, checked: boolean, onChange: (on: boolean) => void, testid?: string): HTMLElement {
  const box = h('input', { type: 'checkbox', id, role: 'switch', ...(testid ? { 'data-testid': testid } : {}) }) as HTMLInputElement
  box.checked = checked
  box.onchange = () => onChange(box.checked)
  return h('label', { class: 'row switch-row', for: id },
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, title), h('span', { class: 'row-sub' }, sub)), box)
}

/** A view's head: a Back button (its icon and the word), the title, and any buttons on the right. */
export function topBar(title: string, back: () => void, ...end: Array<Node | null>): HTMLElement {
  return h('div', { class: 'top top-sub' },
    h('button', { class: 'back-btn', type: 'button', 'data-testid': 'popup-back', onclick: back }, popupIcon('back'), h('span', {}, 'Back')),
    h('h1', {}, title), ...end)
}

/** Copy a value that is no secret (a username, an address): no clearing later. */
export async function copyPlain(value: string, what: string): Promise<void> {
  try { await navigator.clipboard.writeText(value) } catch { toast('Could not copy.'); return }
  toast(`${what} copied`)
}
