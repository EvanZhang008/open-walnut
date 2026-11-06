/**
 * The side panel's and the toolbar popup's Ask, drawn by the extension page itself the moment it
 * opens, while Walnut's own view starts in its frame (about a second): the same header (≡, the
 * ask's title over "Ask Walnut ⌄", the key with its padlock while locked, New chat or the side
 * panel button), the same body (this page's conversation of last time, or the Continue list) and
 * the same composer (its placeholder, +, the page chip, Act in tab, mic, send), in the same places,
 * so nothing moves when the view takes over (review R1-4). It goes once the view says `shown`.
 *
 * Words only (panel-snap.ts keeps them), set with textContent; it takes no input
 * (pointer-events: none), and the frame under it gets every press.
 */
import { h, svg } from './dom'
import type { AskSnap, AskShell, ContRow } from './panel-snap'

export interface AskLook {
  surface: 'panel' | 'popup'
  /** This page's conversation of last time (panel only). */
  snap: AskSnap | null
  /** The Continue list and suggestions of last time. */
  shell: AskShell | null
  /** The page in this window: the composer's chip names it; null on no web page. */
  page: { title: string; host: string } | null
  locked: boolean
}

// One width, height and stroke-width each: the markup is parsed as XML, where a repeated
// attribute is a parse error and the icon becomes the parser's error page.
const sv = (size: number, body: string, stroke = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
export const LOOK_ICONS = {
  menu: sv(18, `<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>`),
  key: sv(16, `<circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/>`),
  lock: sv(9, `<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`, 2.6),
  compose: sv(16, `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`),
  side: sv(16, `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>`),
  caret: sv(11, `<path d="m6 9 6 6 6-6"/>`),
  pointer: sv(13, `<path d="m4 4 7 17 2.5-7.5L21 11z"/>`),
  plus: sv(18, `<path d="M12 5v14"/><path d="M5 12h14"/>`),
  mic: sv(18, `<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>`),
  send: sv(18, `<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>`),
}
/** The suggestion chips' and the bubble's icons, as the view draws them (web/src/components/common/Icons.tsx). */
const LINE = (box: number, stroke: number, body: string) =>
  `<svg width="12" height="12" viewBox="0 0 ${box} ${box}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const CHIP_ICONS: Record<string, string> = {
  search: LINE(16, 1.5, `<circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/>`),
  calendar: LINE(16, 1.4, `<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>`),
  clock: LINE(24, 2.2, `<circle cx="12" cy="12" r="9"/><path d="M12 7v5.4l3.6 2.4"/>`),
}
const FILE_ICON = LINE(16, 1.4, `<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/>`)

/** A suggestion chip as the view draws it: its icon, its label, and a blank for a stem ("Which task is …"). */
function suggChip(label: string, icon: string): HTMLElement {
  const stem = label.endsWith(' …')
  return h('span', { class: 'look-sugg-chip' },
    CHIP_ICONS[icon] ? h('span', { class: 'look-sugg-ic' }, svg(CHIP_ICONS[icon])) : null,
    h('span', {}, stem ? label.slice(0, -2) : label),
    stem ? h('span', { class: 'look-sugg-blank' }) : null)
}

/** A message of the conversation; a person's carries what it took from the page, as the view's bubble does. */
function lookMsg(m: AskSnap['messages'][number]): HTMLElement {
  return h('div', { class: `panel-snap-msg is-${m.role}` }, m.text,
    m.role === 'user' && m.page ? h('div', { class: 'look-msg-page' }, h('span', { class: 'look-msg-page-ic' }, svg(FILE_ICON)), h('span', { class: 'look-msg-page-text' }, m.page)) : null,
    m.role === 'user' && m.quote ? h('div', { class: 'look-msg-quote' }, h('div', { class: 'look-msg-quote-cap' }, 'From the page'), h('div', { class: 'look-msg-quote-text' }, m.quote)) : null)
}
const ico = (k: keyof typeof LOOK_ICONS, cls = '') => h('span', { class: `look-ico ${cls}`.trim(), 'aria-hidden': 'true' }, svg(LOOK_ICONS[k]))

export const NEW_CHAT_PLACEHOLDER = 'Ask Walnut, or ask it to do something here…'
export const FOLLOW_UP_PLACEHOLDER = 'Ask a follow-up…'

function contList(rows: ContRow[], surface: 'panel' | 'popup'): HTMLElement {
  return h('div', { class: `look-cont is-${surface}` },
    h('div', { class: 'look-cont-label' }, 'Continue'),
    ...rows.map((r) => h('div', { class: 'look-cont-row' },
      h('span', { class: `look-dot${r.needs ? ' is-needs' : ''}` }),
      h('span', { class: 'look-cont-text' },
        h('span', { class: 'look-cont-top' }, h('span', { class: 'look-cont-title' }, r.title), r.time ? h('span', { class: 'look-cont-time' }, r.time) : null),
        r.line ? h('span', { class: 'look-cont-line' }, r.line) : null))))
}

/** Draws `o` into `el` (made the first time), replacing what it showed. */
export function drawAskLook(o: AskLook, el?: HTMLElement): HTMLElement {
  const box = el ?? h('div', { class: `panel-snap panel-snap-ask is-look is-${o.surface}`, 'data-testid': 'panel-snap', 'aria-hidden': 'true' })
  const s = o.snap
  const talking = o.surface === 'panel' && !!s && s.messages.length > 0
  const agent = s?.agent || o.shell?.agent || 'Ask Walnut'
  const title = s?.askTitle || 'New chat'
  // A conversation whose ask has no title yet: the view's header names the agent once, as its title line.
  const agentOnly = o.surface === 'popup' || (talking && !s?.askTitle)
  const head = h('div', { class: `look-head is-${o.surface}` },
    h('span', { class: 'look-btn look-menu', 'data-testid': 'panel-snap-menu' }, ico('menu')),
    !agentOnly
      ? h('span', { class: 'look-titles' }, h('span', { class: 'look-title', 'data-testid': 'panel-snap-title' }, title), h('span', { class: 'look-agent' }, agent, ico('caret')))
      : h('span', { class: 'look-titles is-popup' }, h('span', { class: 'look-agent', 'data-testid': 'panel-snap-agent-title' }, agent, ico('caret'))),
    h('span', { class: 'look-btn look-key', 'data-testid': 'panel-snap-key' }, h('span', { class: 'look-key-glyph' }, ico('key'), o.locked ? h('span', { class: 'look-key-badge', 'data-testid': 'panel-snap-locked' }, ico('lock')) : null)),
    h('span', { class: 'look-btn' }, ico(o.surface === 'panel' ? 'compose' : 'side')))
  const cont = o.surface === 'popup' || !talking ? (s?.cont ?? o.shell?.cont ?? []) : []
  const body = talking
    ? h('div', { class: 'look-chat' }, ...s!.messages.map(lookMsg))
    : h('div', { class: `look-body is-${o.surface}` }, cont.length ? contList(cont, o.surface) : null)
  const fromSnap = !!s?.suggestions
  const sugg = o.surface === 'panel' && !talking ? (s?.suggestions ?? o.shell?.suggestions ?? []) : []
  const suggIcons = (fromSnap ? s?.suggestionIcons : o.shell?.suggestionIcons) ?? []
  const pageOn = s?.pageOn ?? !talking
  const site = o.page?.host ?? ''
  const letter = (site.replace(/^www\./, '').match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()
  const chips = h('span', { class: 'look-chips' },
    o.page ? h('span', { class: `look-chip look-chip-page${pageOn ? ' is-on' : ''}`, 'data-testid': 'panel-snap-page' },
      h('span', { class: 'look-fav' }, letter),
      h('span', { class: 'look-chip-label' }, o.page.title ? `${o.page.title} · ${site}` : site),
      pageOn ? h('span', { class: 'look-chip-x' }, '×') : null) : null,
    o.page ? h('span', { class: 'look-chip look-chip-act' }, ico('pointer'), h('span', {}, 'Act in tab')) : null)
  const composer = h('div', { class: 'look-composer' },
    h('div', { class: 'look-placeholder', 'data-testid': 'panel-snap-placeholder' }, s?.placeholder || (talking ? FOLLOW_UP_PLACEHOLDER : NEW_CHAT_PLACEHOLDER)),
    h('div', { class: 'look-bar' }, ico('plus', 'look-plus'), chips, h('span', { class: 'look-end' }, ico('mic', 'look-mic'), h('span', { class: 'look-send' }, ico('send')))))
  box.replaceChildren(head, body,
    ...(sugg.length ? [h('div', { class: 'look-sugg' }, ...sugg.map((t, i) => suggChip(t, suggIcons[i] ?? '')))] : []),
    h('div', { class: 'look-foot' }, composer))
  box.dataset.talking = talking ? '1' : '0'
  return box
}
