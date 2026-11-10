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
 *     agent asks for that tab instead of opening the site again and signing in a second time. Said
 *     in full once per task and site, then in one line (2026-11-10: about 300 characters on every
 *     open of a public site an agent only read); in full again when those tabs change, after a
 *     sign-in step, or hours later.
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

/** The short line of a later open on the same site, once the full note was given. */
export function shortPersonTabsNote(site: string, tabs: PersonTab[]): string {
  const ids = tabs.slice(0, 3).map((t) => t.id)
  const more = tabs.length > 3 ? ` and ${tabs.length - 3} more` : ''
  const which = ids.length > 1 ? `tabs ${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}${more}` : `tab ${ids[0]}${more}`
  return `The person already has ${site} open in ${which}: do not sign in here (ask for their tab if you need their sign-in).`
}

/** Who was told the full note, for which site and tabs (in memory: a restart tells once more). */
const told = new Map<string, { tabs: string; at: number }>()
/** The full note again after this long, and at most this many remembered. */
export const TOLD_MS = 6 * 3600_000
const TOLD_MAX = 500

const toldKey = (owner: string, device: string, site: string) => `${owner}\n${device}\n${site}`

/**
 * The note for an open or navigate: in full the first time this task meets the person's tabs on
 * this site (or when those tabs changed, or after TOLD_MS), else one short line.
 */
export function personTabsNoteFor(who: { owner: string; device: string }, site: string, tabs: PersonTab[], now = Date.now()): string {
  const k = toldKey(who.owner, who.device, site)
  const ids = tabs.map((t) => t.id).sort((a, b) => a - b).join(',')
  const prev = told.get(k)
  if (prev && prev.tabs === ids && now - prev.at < TOLD_MS) return shortPersonTabsNote(site, tabs)
  told.delete(k)
  told.set(k, { tabs: ids, at: now })
  while (told.size > TOLD_MAX) told.delete(told.keys().next().value as string)
  return personTabsNote(site, tabs)
}

/** A sign-in step on the site (fill_login, fill_code): the next open tells the whole note again. */
export function forgetPersonTabsNote(who: { owner: string; device: string }, site: string): void {
  told.delete(toldKey(who.owner, who.device, site))
}

/** fill_login refused: the person has the site open in a tab of their own. */
export function signInRefusal(site: string, tabs: PersonTab[]): string {
  return `The person already has ${site} open in ${listTabs(tabs)}, so Walnut does not sign in there again behind them. `
    + `${HAND_OVER_STEP} Only when they asked you for a fresh sign-in here, call fill_login again with fresh_sign_in: true: that asks them to approve it (on their Mac and phone), and only their yes fills.`
}

export const siteOf = (url: string): string => siteKey(url)?.domain ?? ''
