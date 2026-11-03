/**
 * The bar that offers to save a login just sent, or to update a saved one's password. An
 * extension page in an iframe (the page cannot read or press it); the login itself stays in
 * the background, this page only shows the site and the username.
 */
import { ask as askBackground } from './ext'
import { avatar, h } from './dom'
import { frameGuard } from './frame-guard'
import { currentNonce, onNonce, onUnlockChange } from './nonce'

/** The nonce the content script hands this frame (nonce.ts): every message carries it. */
const ask = <T = Record<string, unknown>>(msg: { type: string; [k: string]: unknown }) => askBackground<T>({ ...msg, nonce: currentNonce() })
const guard = frameGuard()

interface Data { kind: 'save' | 'update' | 'locked'; site: string; username: string; title: string }
const root = document.getElementById('root')!

function size(): void {
  void ask({ type: 'savebar-size', height: Math.ceil(document.body.getBoundingClientRect().height) + 2 })
}

async function act(action: string, extra: Record<string, unknown> = {}): Promise<void> {
  const r = await ask({ type: 'savebar-action', action, ...extra })
  if (!r.ok) {
    root.querySelector('.err')?.remove()
    root.querySelector('.bar-in')?.append(h('p', { class: 'err', role: 'alert' }, r.error ?? 'That did not work.'))
    size()
    return
  }
  if (action === 'save' || action === 'update') {
    root.replaceChildren(h('div', { class: 'bar-in' }, h('div', { class: 'bar-head' },
      h('span', { class: 'logo' }, '✓'), h('span', { class: 'bar-title ok' }, action === 'save' ? 'Saved to Walnut' : 'Password updated in Walnut'))))
    size()
    setTimeout(() => void ask({ type: 'savebar-action', action: 'close' }), 1400)
  }
}

async function render(): Promise<void> {
  const d = await ask<Data>({ type: 'savebar-data' })
  if (!d.ok) { void ask({ type: 'savebar-action', action: 'close' }); return }
  const head = (title: string) => h('div', { class: 'bar-head' }, avatar(d.site),
    h('div', { class: 'row-text' }, h('span', { class: 'bar-title' }, title), h('span', { class: 'row-sub' }, d.username ? `${d.username} · ${d.site}` : d.site)))
  const later = h('button', { class: 'btn btn-quiet', type: 'button', onclick: guard.wrap(() => void act('later')) }, 'Not now')
  let body: HTMLElement
  if (d.kind === 'locked') {
    body = h('div', { class: 'bar-in' }, head('Save this login to Walnut?'),
      h('p', { class: 'muted', style: 'margin:0' }, 'Unlock Walnut first; the login waits here for a few minutes.'),
      h('div', { class: 'bar-actions' }, later, h('button', { class: 'btn btn-primary', type: 'button', onclick: guard.wrap(() => void act('unlock')) }, 'Unlock')))
  } else if (d.kind === 'update') {
    body = h('div', { class: 'bar-in' }, head(`Update the password for ${d.title}?`),
      h('p', { class: 'muted', style: 'margin:0' }, 'The old one stays in its password history.'),
      h('div', { class: 'bar-actions' }, later, h('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'savebar-update', onclick: guard.wrap(() => void act('update')) }, 'Update')))
  } else {
    const title = h('input', { class: 'input', id: 'title', value: d.title, 'aria-label': 'Name' })
    body = h('div', { class: 'bar-in' }, head('Save this login to Walnut?'),
      h('label', { class: 'field-label', for: 'title' }, 'Name'), title,
      h('div', { class: 'bar-actions' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: guard.wrap(() => void act('never')) }, 'Never for this site'),
        h('span', { class: 'spacer' }), later,
        h('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'savebar-save', onclick: guard.wrap(() => void act('save', { title: title.value.trim() })) }, 'Save')))
  }
  root.replaceChildren(body)
  requestAnimationFrame(size)
}

// Drawn once the nonce arrives, and again when the vault is unlocked or locked meanwhile.
onNonce(() => void render())
onUnlockChange(() => void render())
