/**
 * The menu under a login field (an extension page in an iframe, so the page cannot read it):
 * the logins saved for this site, a strong password for a new-password field, or the one step
 * that comes first (connect, unlock). It asks the background what to show; the background
 * answers from the tab and frame that opened it.
 */
import { ask as askBackground } from './ext'
import { avatar, h, icon } from './dom'
import { frameGuard } from './frame-guard'
import { currentNonce, onNonce, onUnlockChange } from './nonce'

/** The nonce the content script hands this frame (nonce.ts): every message carries it. */
const ask = <T = Record<string, unknown>>(msg: { type: string; [k: string]: unknown }) => askBackground<T>({ ...msg, nonce: currentNonce() })
const guard = frameGuard()

interface Item { id: string; title: string; username?: string; site?: string; hasTotp: boolean }
interface Data { state: 'not-connected' | 'locked' | 'unlocked'; role: string; kind: string; site?: string; items?: Item[] }

const root = document.getElementById('root')!

function size(): void {
  void ask({ type: 'menu-size', height: Math.ceil(document.body.getBoundingClientRect().height) + 2 })
}

function stateRow(ic: 'lock' | 'key', title: string, sub: string, button: string, type: string): HTMLElement {
  return h('div', { class: 'menu-state' },
    h('span', { class: 'logo' }, icon(ic)),
    h('div', { class: 'row-text' }, h('span', { class: 'row-title' }, title), h('span', { class: 'row-sub' }, sub)),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: guard.wrap(() => void ask({ type })) }, button))
}

async function render(): Promise<void> {
  const d = await ask<Data>({ type: 'menu-data' })
  root.replaceChildren()
  if (!d.ok) { void ask({ type: 'menu-close' }); return }
  if (d.state === 'not-connected') {
    root.append(stateRow('key', 'Connect Walnut', 'Fill passwords from your Walnut vault.', 'Connect', 'menu-connect'))
  } else if (d.state === 'locked') {
    root.append(stateRow('lock', 'Walnut is locked', 'Unlock to fill this login.', 'Unlock', 'menu-unlock'))
  } else {
    const items = d.items ?? []
    const list = h('div', { class: 'menu-list', role: 'listbox', 'aria-label': 'Walnut logins' })
    if (d.role === 'new-password') {
      list.append(h('button', { class: 'row', type: 'button', 'data-testid': 'menu-generate', onclick: guard.wrap(() => void ask({ type: 'menu-generate' })) },
        h('span', { class: 'logo' }, icon('dice')),
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Use a strong password'), h('span', { class: 'row-sub' }, 'Walnut makes one and offers to save it when you sign up.'))))
    }
    for (const it of items) {
      list.append(h('button', { class: 'row', type: 'button', role: 'option', 'data-testid': 'menu-item', onclick: guard.wrap(() => void fill(it.id)) },
        avatar(it.site ?? it.title),
        h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, it.title), h('span', { class: 'row-sub' }, d.role === 'totp' ? 'Fill the one-time code' : it.username || 'No username'))))
    }
    if (!items.length && d.role !== 'new-password') {
      list.append(h('div', { class: 'menu-state' },
        h('span', { class: 'logo' }, icon('key')),
        h('div', { class: 'row-text' },
          h('span', { class: 'row-title' }, d.role === 'totp' ? 'No one-time code saved' : 'No saved login'),
          h('span', { class: 'row-sub' }, d.role === 'totp' ? `for ${d.site}` : `for ${d.site}. Walnut offers to save it when you sign in.`))))
    }
    root.append(h('div', { class: 'menu-head' }, icon('key'), `Walnut · ${d.site ?? ''}`), list)
  }
  requestAnimationFrame(size)
}

async function fill(id: string): Promise<void> {
  const r = await ask({ type: 'menu-fill', id })
  if (!r.ok && r.error) {
    root.replaceChildren(h('div', { class: 'menu-state' }, h('span', { class: 'err' }, r.error)))
    size()
  }
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') void ask({ type: 'menu-close' }) })
// Drawn once the nonce arrives, and again when the vault is unlocked or locked meanwhile.
onNonce(() => void render())
onUnlockChange(() => void render())
