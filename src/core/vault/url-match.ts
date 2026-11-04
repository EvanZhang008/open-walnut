/**
 * Which saved logins belong to a page. Pure; shared by the server, the web app and
 * the browser extension.
 *
 * Logins match in two tiers, as Chrome's password manager does. Tier 1 (`matchSite`,
 * `matchItem`): the saved host is the page's host, or one is a parent of the other
 * (`example.com` and `www.example.com`, `shop.example.com` and `login.shop.example.com`), or the
 * saved site's own rule says so. Only tier 1 is offered, counted or filled by itself. Tier 2
 * (`siblingHost`): another host of the same registrable domain (`blog.example.com` for a login of
 * `shop.example.com`); it is only listed apart, with its saved host, for the person to pick. A
 * different registrable domain (the public suffix list, private suffixes included, so two
 * github.io sites never match) gets nothing, and an https:// login never matches an http:// page.
 * Saved sites are normalized at save time (a bare `github.com` becomes `https://github.com`):
 * iOS AutoFill offers nothing for a site saved without a scheme.
 *
 * A saved site may carry its own match rule, as Bitwarden's per-URI match does, written as a
 * `#walnut-match=<rule>` suffix on the stored URL (`withRule`). A URL with no suffix (every
 * site saved before rules existed) matches by the tiers above, and a client that does not know
 * the suffix still finds the host in it.
 */
import { parse } from 'tldts'

/**
 * How a saved site matches a page: its host with its parent and child hosts (the default,
 * `domain`), every host of its registrable domain (`base`, chosen for a site whose sign in moves
 * between subdomains), the exact host and port, a page whose address starts with the saved one,
 * or never (kept only for the record).
 */
export type UrlMatchRule = 'domain' | 'base' | 'host' | 'starts' | 'never'
export const URL_MATCH_RULES: readonly UrlMatchRule[] = ['domain', 'base', 'host', 'starts', 'never']
const RULE_MARK = '#walnut-match='

/** A saved URL and its rule (`domain` when it names none). */
export function splitRule(saved: string): { url: string; rule: UrlMatchRule } {
  const s = saved ?? ''
  const i = s.lastIndexOf(RULE_MARK)
  if (i < 0) return { url: s, rule: 'domain' }
  const r = s.slice(i + RULE_MARK.length) as UrlMatchRule
  return { url: s.slice(0, i), rule: URL_MATCH_RULES.includes(r) ? r : 'domain' }
}

/** The URL to store for a site and its rule: the default rule adds nothing. */
export function withRule(url: string, rule: UrlMatchRule): string {
  const base = splitRule(url).url
  return rule === 'domain' || !URL_MATCH_RULES.includes(rule) ? base : `${base}${RULE_MARK}${rule}`
}

/** `example.com/login` -> `https://example.com/login`; '' for something that is no site. A match rule is kept. */
export function normalizeUrl(raw: string): string {
  const { url, rule } = splitRule((raw ?? '').trim())
  const n = normalizePlain(url)
  return n && rule !== 'domain' ? withRule(n, rule) : n
}

function normalizePlain(raw: string): string {
  const t = (raw ?? '').trim()
  if (!t) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return t.slice(0, 2000)
    if (!u.hostname) return ''
    u.hostname = u.hostname.toLowerCase()
    u.hash = ''
    const s = u.toString()
    return (u.pathname === '/' && !u.search ? s.replace(/\/$/, '') : s).slice(0, 2000)
  } catch {
    return ''
  }
}

export interface SiteKey {
  scheme: string
  host: string
  /** Registrable domain (eTLD+1), or the host itself for an IP or a name with no suffix. */
  domain: string
}

export function siteKey(raw: string): SiteKey | null {
  const n = normalizePlain(splitRule(raw).url)
  if (!n) return null
  let u: URL
  try { u = new URL(n) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname
  const p = parse(host, { allowPrivateDomains: true })
  const domain = p.isIp || !p.domain ? host : p.domain
  return { scheme: u.protocol.replace(':', ''), host, domain }
}

/** Tier 1 only: the same host, or a parent or child host (or a `base` rule's other host). */
export type MatchStrength = 'exact_host' | 'domain' | null

/** `a` is `b` or one of its subdomains. */
const within = (a: string, b: string) => a === b || a.endsWith(`.${b}`)

/** How well a saved site fits a page (tier 1): the same host, a parent or child host, or not at all. */
export function matchSite(saved: string, page: string): MatchStrength {
  const { url, rule } = splitRule(saved)
  if (rule === 'never') return null
  const s = siteKey(url)
  const p = siteKey(page)
  if (!s || !p) return null
  if (s.domain !== p.domain) return null
  // A login saved on https never fills a plain http page.
  if (s.scheme === 'https' && p.scheme === 'http') return null
  if (rule === 'host') return s.host === p.host && portOf(url) === portOf(page) ? 'exact_host' : null
  if (rule === 'starts') {
    const a = normalizePlain(url)
    const b = normalizePlain(splitRule(page).url)
    return a && b && b.startsWith(a) ? 'exact_host' : null
  }
  if (s.host === p.host) return 'exact_host'
  return rule === 'base' || within(s.host, p.host) || within(p.host, s.host) ? 'domain' : null
}

/**
 * Tier 2: the saved host when a saved site is another host of the page's registrable domain
 * that tier 1 does not take (a sibling subdomain), else null. Listed apart, never offered first.
 */
export function siblingSite(saved: string, page: string): string | null {
  const { url, rule } = splitRule(saved)
  if (rule !== 'domain') return null
  const s = siteKey(url)
  const p = siteKey(page)
  if (!s || !p || s.domain !== p.domain) return null
  if (s.scheme === 'https' && p.scheme === 'http') return null
  return matchSite(saved, page) ? null : s.host
}

/** The saved host of an item's first tier-2 site, when none of its sites is tier 1. */
export function siblingHost(urls: readonly string[] | undefined, page: string): string | null {
  if (matchItem(urls, page)) return null
  for (const u of urls ?? []) {
    const h = siblingSite(u, page)
    if (h) return h
  }
  return null
}

function portOf(raw: string): string {
  try {
    const u = new URL(normalizePlain(splitRule(raw).url))
    return u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch { return '' }
}

/**
 * Logins the page would get if it were https: an item saved for https on a plain http page.
 * Said to the person ("this page is not secure"), never filled.
 */
export function insecureOnly(urls: readonly string[] | undefined, page: string): boolean {
  if (!/^http:/i.test(page) || matchItem(urls, page)) return false
  return !!matchItem(urls, page.replace(/^http:/i, 'https:'))
}

/** The best match of any of an item's sites to a page. */
export function matchItem(urls: readonly string[] | undefined, page: string): MatchStrength {
  let best: MatchStrength = null
  for (const u of urls ?? []) {
    const m = matchSite(u, page)
    if (m === 'exact_host') return m
    if (m) best = m
  }
  return best
}

/** The host to show for a site (`github.com`), or the text itself. */
export function displayHost(raw: string): string {
  return siteKey(raw)?.host ?? splitRule(raw).url
}
