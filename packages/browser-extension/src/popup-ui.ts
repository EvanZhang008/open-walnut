/** Small pieces the popup's views share: the toast, an error line, copying with the 30 s clear. */
import { ask } from './ext'
import { h } from './dom'
import { CLEAR_MS } from './bg-clipboard'

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

export function topBar(title: string, back: () => void): HTMLElement {
  return h('div', { class: 'top' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: back }, '‹'),
    h('h1', {}, title))
}
