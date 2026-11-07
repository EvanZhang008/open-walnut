/**
 * The side panel's and the popup's first page (web/src/popout/ExtHome.tsx, design C), drawn by the
 * extension page itself the moment it opens, while Walnut's view starts in its frame: the header (≡,
 * Walnut, the relay pill, the key with its padlock while locked, the side panel button in the popup),
 * the task panel's tab strip, its search box and its first rows as the view showed them last time
 * (panel-snap.ts `home`), and New task docked at the bottom on one line ("This page" and send). A task
 * opened there draws its header (Back and its title) over an empty conversation; Browser control,
 * its title and its status. The side bar is real, drawn beside this (panel-rail.ts).
 *
 * Words only, set with textContent; it takes no input (pointer-events: none, ui.css), and goes once
 * the view says `shown` (panel-ask.ts).
 */
import { h, svg } from './dom'
import { FOLLOW_UP_PLACEHOLDER, LOOK_ICONS } from './panel-look'
import type { HomeSnap } from './panel-snap'

export type RelayLook = 'on' | 'off' | 'tab'
export interface HomeLook {
  surface: 'panel' | 'popup'
  /** The task panel as the view showed it last time; null before it ever did. */
  home: HomeSnap | null
  page: { title: string; host: string } | null
  locked: boolean
  relay: RelayLook
  /** The extension draws a Settings view (the header's gear). */
  settings: boolean
}

export const HOME_PLACEHOLDER = 'New task: what should Walnut do?'
const RELAY_LABEL: Record<RelayLook, string> = { on: 'Relay on', off: 'Relay off', tab: 'Agent in tab' }

const sv = (size: number, body: string) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS = {
  gear: sv(16, `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  search: sv(14, `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`),
  back: sv(15, `<path d="m15 18-6-6 6-6"/>`),
}
const ico = (markup: string, cls = '') => h('span', { class: `look-ico ${cls}`.trim(), 'aria-hidden': 'true' }, svg(markup))

function keyBtn(locked: boolean): HTMLElement {
  return h('span', { class: 'look-btn look-key', 'data-testid': 'panel-snap-key' },
    h('span', { class: 'look-key-glyph' }, ico(LOOK_ICONS.key), locked ? h('span', { class: 'look-key-badge', 'data-testid': 'panel-snap-locked' }, ico(LOOK_ICONS.lock)) : null))
}

/** Draws the first page into `box`, replacing what it showed. */
export function drawHomeLook(o: HomeLook, box: HTMLElement): HTMLElement {
  const head = h('div', { class: `look-head look-home-head is-${o.surface}` },
    h('span', { class: 'look-btn look-menu', 'data-testid': 'panel-snap-menu' }, ico(LOOK_ICONS.menu)),
    h('span', { class: 'look-home-brand' },
      h('img', { class: 'look-home-mark', src: 'icons/32.png', alt: '', 'aria-hidden': 'true' }),
      h('span', { class: 'look-home-name' }, 'Walnut'),
      h('span', { class: `look-relay is-${o.relay}`, 'data-testid': 'panel-snap-relay' }, h('span', { class: 'look-relay-dot' }), RELAY_LABEL[o.relay])),
    keyBtn(o.locked),
    o.surface === 'popup' ? h('span', { class: 'look-btn' }, ico(LOOK_ICONS.side)) : null,
    o.settings ? h('span', { class: 'look-btn' }, ico(ICONS.gear)) : null)
  const site = o.page?.host ?? ''
  const letter = (site.replace(/^www\./, '').match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()
  // Docked on one line, as the view draws it until the box is focused.
  const composer = h('div', { class: 'look-composer look-home-composer is-docked' },
    ico(LOOK_ICONS.plus, 'look-plus'),
    h('div', { class: 'look-placeholder', 'data-testid': 'panel-snap-placeholder' }, HOME_PLACEHOLDER),
    o.page ? h('span', { class: 'look-chip look-chip-page look-home-dock-chip is-on', 'data-testid': 'panel-snap-page', title: o.page.title ? `${o.page.title} · ${site}` : site },
      h('span', { class: 'look-fav' }, letter),
      h('span', { class: 'look-chip-label' }, 'This page')) : null,
    h('span', { class: 'look-send' }, ico(LOOK_ICONS.send)))
  const s = o.home
  const tabs = h('div', { class: 'look-home-tabs', 'data-testid': 'panel-snap-tabs' },
    ...(s?.tabs ?? []).map((t) => h('span', { class: `look-home-tab${t.on ? ' is-on' : ''}` }, t.label, t.count ? h('span', { class: 'look-home-tab-count' }, t.count) : null)))
  const search = h('div', { class: 'look-home-search' }, ico(ICONS.search), h('span', {}, 'Search tasks'))
  const rows = s
    ? h('div', { class: 'look-home-rows', 'data-testid': 'panel-snap-rows' },
      s.heading ? h('div', { class: 'look-home-heading' }, s.heading) : null,
      ...s.rows.map((r) => h('div', { class: 'look-home-row' },
        h('span', { class: `look-dot${r.needs ? ' is-needs' : ''}` }),
        h('span', { class: 'look-home-ring', 'aria-hidden': 'true' }),
        h('span', { class: 'look-home-row-text' },
          r.meta || r.time ? h('span', { class: 'look-home-row-meta' }, h('span', {}, r.meta), r.time ? h('span', {}, r.time) : null) : null,
          h('span', { class: 'look-home-row-title' }, r.title),
          r.line ? h('span', { class: 'look-home-row-line' }, r.line) : null))))
    : h('p', { class: 'look-home-loading' }, h('span', { class: 'panel-snap-spinner' }), 'Loading your tasks…')
  // Design C: the tab bar, the search box, the sections, then New task docked at the bottom.
  box.replaceChildren(head, tabs, search, rows, h('div', { class: 'look-home-dock' }, composer))
  box.dataset.look = 'home'
  return box
}

/** A task opened on the first page: Back and its title over its conversation, which loads in the frame. */
export function drawTaskLook(o: { title: string; locked: boolean }, box: HTMLElement): HTMLElement {
  const head = h('div', { class: 'look-head is-panel' },
    h('span', { class: 'look-home-back' }, ico(ICONS.back), 'Back'),
    h('span', { class: 'look-titles' }, h('span', { class: 'look-title', 'data-testid': 'panel-snap-title' }, o.title || 'Task')),
    keyBtn(o.locked))
  const composer = h('div', { class: 'look-composer' },
    h('div', { class: 'look-placeholder', 'data-testid': 'panel-snap-placeholder' }, FOLLOW_UP_PLACEHOLDER),
    h('div', { class: 'look-bar' }, ico(LOOK_ICONS.plus, 'look-plus'), h('span', { class: 'look-end' }, ico(LOOK_ICONS.mic, 'look-mic'), h('span', { class: 'look-send' }, ico(LOOK_ICONS.send)))))
  box.replaceChildren(head, h('div', { class: 'look-body is-panel' }), h('div', { class: 'look-foot' }, composer))
  box.dataset.look = 'task'
  return box
}

/** Browser control as the panel opens on it: its title and the status it leads with. */
export function drawControlLook(o: { relay: RelayLook; locked: boolean }, box: HTMLElement): HTMLElement {
  const head = h('div', { class: 'look-head is-panel' },
    h('span', { class: 'look-titles' }, h('span', { class: 'look-title', 'data-testid': 'panel-snap-title' }, 'Browser control')),
    keyBtn(o.locked))
  const title = o.relay === 'tab' ? 'An agent is using this tab' : o.relay === 'on' ? 'Agents are on' : 'Agents are off'
  const status = h('div', { class: `look-control-status is-${o.relay}`, 'data-testid': 'panel-snap-control' },
    h('span', { class: 'look-relay-dot' }), h('span', { class: 'look-control-title' }, title))
  box.replaceChildren(head, status)
  box.dataset.look = 'control'
  return box
}
