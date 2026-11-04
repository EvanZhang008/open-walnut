/**
 * Which saved logins the background offers, and in what order (pure, so it is unit tested):
 * the tiers of url-match.ts as the menu's lists, the account typed on step one of a two-step
 * sign in offered alone on step two, the login a changed password updates, the name a new login
 * gets, and which pages a "Never for this site" entry covers.
 */
import type { VaultItemSummary } from '../../../src/core/vault/types'
import { displayHost, matchItem, siblingHost, siteKey } from '../../../src/core/vault/url-match'

/**
 * A row of the in-page menu or the popup. `tier` 1: saved for this host or a parent or child
 * host, offered. `tier` 2: saved for another part of the same site (`site` is the host it is
 * saved for); listed apart, filled only when the person picks it.
 */
export interface MenuItem {
  id: string; title: string; username?: string; site?: string; hasTotp: boolean
  /** Saved for exactly this host. */
  exact: boolean
  tier: 1 | 2
  type?: string; sub?: string
}

export function view(i: VaultItemSummary, page?: string): MenuItem {
  const m = page ? matchItem(i.urls, page) : null
  const sibling = page && !m ? siblingHost(i.urls, page) : null
  const site = sibling ?? (i.urls?.[0] ? displayHost(i.urls[0]) : '')
  return {
    id: i.id, title: i.title, ...(i.username ? { username: i.username } : {}),
    ...(site ? { site } : {}), hasTotp: i.hasTotp,
    exact: m === 'exact_host', tier: sibling ? 2 : 1,
    ...(i.type === 'card' && i.cardLast4 ? { sub: `•••• ${i.cardLast4}` } : {}),
  }
}

export const recent = (a: VaultItemSummary, b: VaultItemSummary) =>
  Number(!!b.favorite) - Number(!!a.favorite) || (b.usedAt ?? '').localeCompare(a.usedAt ?? '') || a.title.localeCompare(b.title)

/** A page's logins in their tiers: this host's first, then favorites, then the most recently used. */
export function tiersFor(all: readonly VaultItemSummary[], page: string): { first: MenuItem[]; others: MenuItem[] } {
  const logins = all.filter((i) => i.type === 'login' && !i.trashedAt)
  const first = logins.filter((i) => matchItem(i.urls, page))
    .map((i) => ({ i, v: view(i, page) }))
    .sort((a, b) => Number(b.v.exact) - Number(a.v.exact) || recent(a.i, b.i))
    .map((x) => x.v)
  const others = logins.filter((i) => siblingHost(i.urls, page)).sort(recent).map((i) => view(i, page))
  return { first, others }
}

/** The registrable domain the tier-2 heading names ("Saved for other parts of lab.test"). */
export const domainOf = (page: string): string => siteKey(page)?.domain ?? ''

/**
 * Step two of a two-step sign in: the account picked or typed on step one comes first and
 * alone, the site's other logins under "Other logins" (`more`). No hint, or one that names
 * none of them: the list as it is.
 */
export function stepOneFirst(items: MenuItem[], hint?: { itemId?: string; username?: string }): { items: MenuItem[]; more: MenuItem[] } {
  if (!hint || items.length < 2) return { items, more: [] }
  const user = hint.username?.trim().toLowerCase()
  let hit = hint.itemId ? items.filter((i) => i.id === hint.itemId) : []
  if (!hit.length && user) hit = items.filter((i) => (i.username ?? '').toLowerCase() === user)
  if (!hit.length) return { items, more: [] }
  return { items: hit, more: items.filter((i) => !hit.includes(i)) }
}

export interface UpdateCandidate { id: string; username?: string; password?: string; exact: boolean; usedAt?: string }

/**
 * The saved login a changed password most likely belongs to: the one whose saved password is
 * the form's "current" one, else the login just filled or sent on this tab, else this host's
 * own login before a parent's or child's, then the most recently used.
 */
export function pickUpdate(cands: readonly UpdateCandidate[], current?: string, lastId?: string): string | undefined {
  if (!cands.length) return undefined
  const order = (list: readonly UpdateCandidate[]) => [...list].sort((a, b) => Number(b.exact) - Number(a.exact) || (b.usedAt ?? '').localeCompare(a.usedAt ?? ''))
  const byCurrent = current ? cands.filter((c) => c.password === current) : []
  if (byCurrent.length) return order(byCurrent)[0].id
  if (lastId && cands.some((c) => c.id === lastId)) return lastId
  return order(cands)[0].id
}

// ── the name a new login gets ──

const GENERIC = /\b(?:sign(?:ed)?[\s-]?(?:in|up|on|out)|log[\s-]?(?:in|on|out)|login|logon|password|passcode|account|register|registration|step|verify|verification|welcome|checkout|cart|home|settings|profile|error|forgot|reset|security|authenticat\w*|create|join|change|update|untitled|loading)\b/i
const ACTIONS: RegExp[] = [
  /^(?:sign|log)\s?(?:in|on|up)\s+(?:to|into|for|with|at|on)\s+(.+)$/i,
  /^(?:create|open|make)\s+(?:your|an|a|my)?\s*(.+?)\s+account$/i,
  /^(?:welcome\s+(?:back\s+)?to|join|register\s+(?:with|for|at|on))\s+(.+)$/i,
  /^(.+?)\s+(?:sign|log)\s?(?:in|on|up)$/i,
  /^(.+?)\s+login$/i,
]

function plausible(name: string): boolean {
  const t = name.trim()
  return t.length > 0 && t.length <= 40 && t.split(/\s+/).length <= 5 && /\p{L}/u.test(t) && !GENERIC.test(t)
}

/** The site's part of a page title: "Lab Shop" from "Sign in to Lab Shop" or "Sign in · Lab Shop". */
export function siteNameFromTitle(title: string | undefined, host = ''): string | null {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return null
  const parts = t.split(/\s+[|·•—–-]\s+|:\s+/).map((p) => p.trim()).filter(Boolean)
  const labels = host.toLowerCase().split('.').filter((l) => l.length >= 3)
  const found = parts.map((p) => {
    for (const re of ACTIONS) {
      const m = re.exec(p)
      if (m && plausible(m[1])) return { name: m[1].trim(), action: true }
    }
    return { name: p, action: false }
  }).filter((c) => plausible(c.name))
  if (!found.length) return null
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  return (found.find((c) => labels.includes(squash(c.name))) ?? found.find((c) => c.action) ?? found[found.length - 1]).name
}

/**
 * A new login's default name: the name the site gives itself (og:site_name or
 * application-name), else the site's part of the title, else the host without www.
 */
export function defaultLoginName(page: { url: string; metaName?: string; title?: string }): string {
  const host = siteKey(page.url)?.host ?? displayHost(page.url)
  const meta = page.metaName?.replace(/\s+/g, ' ').trim()
  if (meta && meta.length <= 60) return meta
  return siteNameFromTitle(page.title, host) ?? host.replace(/^www\./, '')
}

// ── "Never for this site" ──

/** The entry "Never for this site" stores: the page's exact host. */
export function neverEntry(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

/**
 * Whether a Never entry covers a page: its host and the hosts under it. An entry written before
 * entries named the host is a registrable domain, so it keeps covering that whole site.
 */
export function neverCovers(list: readonly string[], url: string): boolean {
  const host = neverEntry(url)
  if (!host) return false
  return list.some((e) => {
    const x = String(e ?? '').trim().toLowerCase()
    return !!x && (host === x || host.endsWith(`.${x}`))
  })
}
