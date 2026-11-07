/**
 * The side bar of the side panel and the toolbar popup (design C, 2026-11-07; the user: "please
 * have a side bar that has different functions like chat, password, browser control (some setting
 * for browser control but mainly want to show we can do this), setting"): a narrow column of four
 * entries on the left, each an icon with a short name under it, the one on show marked.
 *
 * - Chat: Walnut's first page in the frame (the task list, New task, a task's conversation, Ask).
 * - Passwords: the extension's own Passwords view (popup.html, embedded).
 * - Browser control: what agents do in this browser, in the frame (web/src/popout/ExtControl.tsx).
 * - Settings: the extension's Settings view (popup.html, embedded).
 *
 * It is drawn by this page, at once (no frame to wait for), and the entry last used is kept per
 * surface in storage.local (`panelRail`), so the panel opens on it again.
 */
import { ext } from './ext'
import { h, svg } from './dom'

export const RAIL_ENTRIES = ['chat', 'passwords', 'control', 'settings'] as const
export type RailEntry = typeof RAIL_ENTRIES[number]
export const isRailEntry = (v: unknown): v is RailEntry => typeof v === 'string' && (RAIL_ENTRIES as readonly string[]).includes(v)

const KEPT = 'panelRail'

const sv = (body: string) => `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS: Record<RailEntry, string> = {
  chat: sv(`<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z"/>`),
  passwords: sv(`<circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/>`),
  control: sv(`<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 8h18"/><path d="m11 11 4.5 9 1.2-3.6 3.6-1.2z"/>`),
  settings: sv(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
}
const NAMES: Record<RailEntry, { short: string; full: string }> = {
  chat: { short: 'Chat', full: 'Chat: your tasks, New task, and Ask' },
  passwords: { short: 'Passwords', full: 'Passwords' },
  control: { short: 'Browser', full: 'Browser control: what agents do in this browser' },
  settings: { short: 'Settings', full: 'Settings' },
}

/** The entry the panel (or the popup) was left on, Chat before any. */
export async function railOf(surface: 'panel' | 'popup'): Promise<RailEntry> {
  const kept = (await ext.storage.local.get(KEPT).catch(() => ({} as Record<string, unknown>)))[KEPT] as Record<string, unknown> | undefined
  const v = kept?.[surface]
  return isRailEntry(v) ? v : 'chat'
}

export async function keepRail(surface: 'panel' | 'popup', entry: RailEntry): Promise<void> {
  const kept = ((await ext.storage.local.get(KEPT).catch(() => ({} as Record<string, unknown>)))[KEPT] ?? {}) as Record<string, unknown>
  await ext.storage.local.set({ [KEPT]: { ...kept, [surface]: entry } }).catch(() => undefined)
}

/** The bar: its element, and `select` to mark the entry on show (no `onPick` call). */
export function drawRail(surface: 'panel' | 'popup', onPick: (entry: RailEntry) => void): { el: HTMLElement; select: (entry: RailEntry) => void } {
  const buttons = new Map<RailEntry, HTMLElement>()
  const el = h('nav', { class: `panel-rail is-${surface}`, 'data-testid': 'panel-rail', 'aria-label': 'Walnut' },
    ...RAIL_ENTRIES.map((entry) => {
      const b = h('button', {
        class: 'panel-rail-btn', type: 'button', 'data-testid': `panel-rail-${entry}`, 'data-entry': entry,
        'aria-label': NAMES[entry].full, title: NAMES[entry].full,
        onclick: () => onPick(entry),
      }, h('span', { class: 'panel-rail-icon', 'aria-hidden': 'true' }, svg(ICONS[entry])), h('span', { class: 'panel-rail-name' }, NAMES[entry].short))
      buttons.set(entry, b)
      return b
    }))
  const select = (entry: RailEntry) => {
    for (const [k, b] of buttons) {
      b.classList.toggle('is-on', k === entry)
      if (k === entry) b.setAttribute('aria-current', 'page')
      else b.removeAttribute('aria-current')
    }
    el.dataset.entry = entry
  }
  return { el, select }
}
