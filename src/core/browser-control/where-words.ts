/**
 * Where an agent is in the person's browser, in the words every answer carries (2026-11-07: a
 * session drove the person's browser in a window he never saw and signed in to his bank again in
 * a new tab, while he was signed in in his own front tab; he asked "why this session keeps using
 * my browser but I didn't see it"). Pure: the server's act route, the `browser` op's outcome and
 * `walnut browser` all read these.
 *
 *   - which window and tab: Walnut's agent window (behind theirs, not minimized) or the person's
 *     own window, and the tab's id, title and address;
 *   - the person's own tabs on the same site (the vault's site key: the registrable domain), so an
 *     agent asks for that tab instead of opening the site again and signing in a second time.
 */
import { siteKey } from '../vault/url-match.js'

export type WindowKind = 'agent' | 'person'

export interface PersonTab {
  id: number
  title?: string
  /** The tab they are on now, in their front window. */
  active?: boolean
}

/** The window a tab is in, as a person reads it. With no word from the extension, the action tells (open: the agent window; take: theirs). */
export function windowWords(kind: WindowKind | undefined, state?: string, action?: string): string {
  const k = kind ?? (action === 'open' ? 'agent' : action === 'take' ? 'person' : undefined)
  if (k === 'agent') {
    return state === 'minimized'
      ? 'Walnut\'s agent window (the person minimized it)'
      : 'Walnut\'s agent window (behind theirs, not minimized)'
  }
  if (k === 'person') return 'the person\'s own window (their tab, handed over or taken)'
  return 'their browser'
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** `tab 812 "Online Banking" (https://bank.example.com/home)`. */
export function tabWords(b: { tab?: unknown; title?: unknown; url?: unknown }): string {
  const parts: string[] = []
  if (typeof b.tab === 'number') parts.push(`tab ${b.tab}`)
  if (typeof b.title === 'string' && b.title) parts.push(`"${clip(b.title, 80)}"`)
  if (typeof b.url === 'string' && b.url) parts.push(`(${clip(b.url, 200)})`)
  return parts.join(' ')
}

/** The one line an open, take, navigate or back answers with: which window and which tab. */
export function whereLine(action: string, b: { tab?: unknown; title?: unknown; url?: unknown; window?: unknown; windowState?: unknown }): string {
  const kind = b.window === 'agent' || b.window === 'person' ? b.window : undefined
  return `In ${windowWords(kind, typeof b.windowState === 'string' ? b.windowState : undefined, action)}, ${tabWords(b) || 'the tab'}.`
}

/** The person's own tabs (no agent holds them) on the same site as `url`. */
export function sameSiteTabs(tabs: Array<{ id?: unknown; url?: unknown; title?: unknown; active?: unknown; owner?: unknown }> | undefined, url: string): PersonTab[] {
  const site = siteKey(url)?.domain
  if (!site || !Array.isArray(tabs)) return []
  const out: PersonTab[] = []
  for (const t of tabs) {
    if (typeof t?.id !== 'number' || t.owner || typeof t.url !== 'string') continue
    if (siteKey(t.url)?.domain !== site) continue
    out.push({ id: t.id, ...(typeof t.title === 'string' ? { title: t.title.slice(0, 200) } : {}), ...(t.active === true ? { active: true } : {}) })
  }
  return out.slice(0, 20)
}

function listTabs(tabs: PersonTab[]): string {
  const one = (t: PersonTab) => `tab ${t.id}${t.title ? ` ("${clip(t.title, 80)}"${t.active ? ', the tab they are on' : ''})` : t.active ? ' (the tab they are on)' : ''}`
  const shown = tabs.slice(0, 3).map(one)
  const more = tabs.length > 3 ? ` and ${tabs.length - 3} more` : ''
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}${more}` : `${shown[0]}${more}`
}

/** The step instead of a second sign-in, the same in every answer and in the skill. */
export const HAND_OVER_STEP = 'If they are signed in there, ask them to hand that tab over ("Act in tab" in Walnut\'s side panel, on that tab), '
  + 'or take it (take {tab}) when they are not on it. Do not sign in again.'

/** An open or navigate to a site the person already has open in their own tabs. */
export function personTabsNote(site: string, tabs: PersonTab[]): string {
  return `They already have ${site} open in ${listTabs(tabs)}. ${HAND_OVER_STEP}`
}

/** fill_login refused: the person has the site open in a tab of their own. */
export function signInRefusal(site: string, tabs: PersonTab[]): string {
  return `The person already has ${site} open in ${listTabs(tabs)}, so Walnut does not sign in there again behind them. `
    + `${HAND_OVER_STEP} Only when they asked you for a fresh sign-in here, call fill_login again with fresh_sign_in: true.`
}

export const siteOf = (url: string): string => siteKey(url)?.domain ?? ''
