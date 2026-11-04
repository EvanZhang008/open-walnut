/**
 * Which saved logins belong to a page. Pure; shared by the server, the web app and
 * the browser extension.
 *
 * A login matches a page when both sit on the same registrable domain (the public
 * suffix list, private suffixes included, so two github.io or herokuapp.com sites never
 * match each other), and an https:// login never matches an http:// page. Saved sites
 * are normalized at save time (a bare `github.com` becomes `https://github.com`):
 * iOS AutoFill offers nothing for a site saved without a scheme.
 *
 * A saved site may carry its own match rule, as Bitwarden's per-URI match does, written as a
 * `#walnut-match=<rule>` suffix on the stored URL (`withRule`). A URL with no suffix (every
 * site saved before rules existed) matches by registrable domain, so old items read as they
 * always did, and a client that does not know the suffix still finds the host in it.
 */
import { parse } from 'tldts'

/**
 * How a saved site matches a page: its registrable domain (the default), the exact host and
 * port, a page whose address starts with the saved one, or never (kept only for the record).
 */
export type UrlMatchRule = 'domain' | 'host' | 'starts' | 'never'
export const URL_MATCH_RULES: readonly UrlMatchRule[] = ['domain', 'host', 'starts', 'never']
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

export type MatchStrength = 'exact_host' | 'domain' | null

/** How well a saved site fits a page: the same host, the same registrable domain, or not at all. */
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
  return s.host === p.host ? 'exact_host' : 'domain'
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
