/**
 * Which saved logins belong to a page. Pure; shared by the server, the web app and
 * the browser extension.
 *
 * A login matches a page when both sit on the same registrable domain (the public
 * suffix list, private suffixes included, so two github.io or herokuapp.com sites never
 * match each other), and an https:// login never matches an http:// page. Saved sites
 * are normalized at save time (a bare `github.com` becomes `https://github.com`):
 * iOS AutoFill offers nothing for a site saved without a scheme.
 */
import { parse } from 'tldts'

/** `example.com/login` -> `https://example.com/login`; '' for something that is no site. */
export function normalizeUrl(raw: string): string {
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
  const n = normalizeUrl(raw)
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
  const s = siteKey(saved)
  const p = siteKey(page)
  if (!s || !p) return null
  if (s.domain !== p.domain) return null
  // A login saved on https never fills a plain http page.
  if (s.scheme === 'https' && p.scheme === 'http') return null
  return s.host === p.host ? 'exact_host' : 'domain'
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
  return siteKey(raw)?.host ?? raw
}
