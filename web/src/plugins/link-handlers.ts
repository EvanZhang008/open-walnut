/**
 * Links a plugin opens (`walnut.ui.link`). A plugin names the URLs it handles with
 * patterns; a plain click on such a link anywhere in the console opens it in the
 * plugin instead of the browser (LinkCaptureHost.tsx installs the listeners), and a
 * right-click offers the plugin, the default browser and Copy link.
 *
 * Pattern syntax is the browser-extension match pattern, so authors already know it:
 * `<scheme>://<host><path>`.
 *   scheme  `http`, `https`, or `*` for either. Nothing else ever matches.
 *   host    `*` (any), `*.example.com` (example.com and every subdomain), or an exact
 *           host. Compared to the URL's hostname, case-insensitively; the port is ignored.
 *   path    starts with `/`; `*` stands for any run of characters, `/` included. It is
 *           matched against the path plus the query (`/archives/*` takes
 *           `/archives/C1/p2?thread_ts=3`), never the fragment.
 *
 * No plugin is named here: which links exist is entirely what plugins register.
 */
import { log } from '@/utils/log'
import { disposable } from './disposable'
import type { Disposable, LinkHandlerContribution, LinkOpenContext } from './types'

export type { LinkHandlerContribution, LinkOpenContext }

export interface RegisteredLinkHandler {
  key: string
  pluginId: string
  pluginName: string
  title: string
  value: LinkHandlerContribution
  matchers: CompiledLinkPattern[]
}

export interface CompiledLinkPattern {
  source: string
  schemes: ReadonlySet<string>
  /** Null = any host. */
  host: { exact: string } | { suffix: string } | null
  path: RegExp
}

const SCHEMES: Record<string, string[]> = { http: ['http:'], https: ['https:'], '*': ['http:', 'https:'] }
const MAX_PATTERNS = 32
const MAX_PATTERN_LENGTH = 512
const HOST_PATTERN = /^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*)$/

/** Pure: a pattern as matcher parts, or an Error naming what is wrong with it. */
export function compileLinkPattern(source: string): CompiledLinkPattern | Error {
  if (typeof source !== 'string' || !source || source.length > MAX_PATTERN_LENGTH) {
    return new Error(`Link pattern must be a string of 1 to ${MAX_PATTERN_LENGTH} characters`)
  }
  const m = /^([^:/]+):\/\/([^/]+)(\/.*)$/.exec(source)
  if (!m) return new Error(`Link pattern must look like https://host/path: ${JSON.stringify(source)}`)
  const [, scheme, rawHost, path] = m as unknown as [string, string, string, string]
  const schemes = SCHEMES[scheme]
  if (!schemes) return new Error(`Link pattern scheme must be http, https or *: ${JSON.stringify(source)}`)
  const hostName = rawHost.toLowerCase()
  if (!HOST_PATTERN.test(hostName)) {
    return new Error(`Link pattern host must be *, *.example.com or example.com: ${JSON.stringify(source)}`)
  }
  const host = hostName === '*'
    ? null
    : hostName.startsWith('*.') ? { suffix: hostName.slice(2) } : { exact: hostName }
  const body = path.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return { source, schemes: new Set(schemes), host, path: new RegExp(`^${body}$`) }
}

/** Pure: does one compiled pattern take this URL? */
export function linkPatternMatches(pattern: CompiledLinkPattern, url: URL): boolean {
  if (!pattern.schemes.has(url.protocol)) return false
  const hostname = url.hostname.toLowerCase()
  if (pattern.host) {
    if ('exact' in pattern.host) {
      if (hostname !== pattern.host.exact) return false
    } else if (hostname !== pattern.host.suffix && !hostname.endsWith(`.${pattern.host.suffix}`)) {
      return false
    }
  }
  return pattern.path.test(`${url.pathname}${url.search}`)
}

/** Pure: an absolute http(s) URL, or null (relative, another scheme, unparsable). */
export function parseCapturableUrl(href: string | null | undefined): URL | null {
  if (!href || !/^https?:\/\//i.test(href.trim())) return null
  try { return new URL(href.trim()) } catch { return null }
}

const handlers: RegisteredLinkHandler[] = []

export function registerLinkHandler(
  pluginId: string,
  pluginName: string,
  contribution: LinkHandlerContribution,
): Disposable {
  if (!Array.isArray(contribution.patterns) || contribution.patterns.length === 0) {
    throw new Error('Plugin link handler needs at least one pattern')
  }
  if (contribution.patterns.length > MAX_PATTERNS) {
    throw new Error(`Plugin link handler may declare at most ${MAX_PATTERNS} patterns`)
  }
  const matchers = contribution.patterns.map((source) => {
    const compiled = compileLinkPattern(source)
    if (compiled instanceof Error) throw compiled
    return compiled
  })
  if (typeof contribution.open !== 'function') throw new Error('Plugin link handler needs an open function')
  if (contribution.accepts !== undefined && typeof contribution.accepts !== 'function') {
    throw new Error('Plugin link handler accepts must be a function')
  }
  const key = `${pluginId}~${contribution.id}`
  const title = contribution.title?.trim() || pluginName
  const entry: RegisteredLinkHandler = { key, pluginId, pluginName, title, value: contribution, matchers }
  // A reloaded generation registers before the old one is disposed: the newer takes
  // the older's place in the match order, and the older's disposer finds nothing.
  const previous = handlers.findIndex((existing) => existing.key === key)
  if (previous >= 0) handlers.splice(previous, 1, entry)
  else handlers.push(entry)
  return disposable(() => {
    const at = handlers.indexOf(entry)
    if (at >= 0) handlers.splice(at, 1)
  })
}

/** The handler that takes this link, first registered first, or null. */
export function findLinkHandler(href: string | null | undefined): { handler: RegisteredLinkHandler; url: URL } | null {
  const url = parseCapturableUrl(href)
  if (!url) return null
  // The console's own pages and files are never a plugin's, whatever its pattern says.
  if (typeof window !== 'undefined' && window.location && url.origin === window.location.origin) return null
  for (const handler of handlers) {
    if (!handler.matchers.some((pattern) => linkPatternMatches(pattern, url))) continue
    if (handler.value.accepts) {
      let accepted = false
      try { accepted = handler.value.accepts(new URL(url.href)) === true } catch (error) {
        log.warn('link-handlers', 'accepts threw; the link stays with the browser', { handler: handler.key, error: String(error) })
      }
      if (!accepted) continue
    }
    return { handler, url }
  }
  return null
}

/** Open a URL in the default browser (the Mac app routes a new window there, desktop/LinkPolicy.swift). */
export function openInDefaultBrowser(href: string): void {
  const opened = window.open(href, '_blank', 'noopener,noreferrer')
  // `noopener` makes window.open return null even when it worked, so this is not
  // a failure signal; the log is for tracing which way a link went.
  log.info('link-handlers', 'link opened in the default browser', { href: href.slice(0, 300), returned: opened !== null })
}

let navigateImpl: ((path: string) => void) | null = null

/** The console's navigate, set by LinkCaptureHost while it is mounted. */
export function setLinkNavigate(navigate: ((path: string) => void) | null): void {
  navigateImpl = navigate
}

/** Hand the link to its plugin; the browser takes it when the plugin declines or fails. */
export function openWithHandler(handler: RegisteredLinkHandler, url: URL, via: LinkOpenContext['via']): void {
  const fallback = (reason: string, error?: unknown) => {
    log.warn('link-handlers', 'plugin did not open the link; using the default browser', {
      handler: handler.key, reason, error: error === undefined ? undefined : String(error),
    })
    openInDefaultBrowser(url.href)
  }
  const navigate = (path: string) => {
    if (navigateImpl) navigateImpl(path)
    else window.location.assign(path)
  }
  log.info('link-handlers', 'link opened in plugin', { handler: handler.key, via, href: url.href.slice(0, 300) })
  let result: ReturnType<LinkHandlerContribution['open']>
  try {
    result = handler.value.open(new URL(url.href), { navigate, via })
  } catch (error) {
    fallback('threw', error)
    return
  }
  if (result === false) { fallback('declined'); return }
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    ;(result as Promise<boolean | void>).then(
      (value) => { if (value === false) fallback('declined') },
      (error) => fallback('rejected', error),
    )
  }
}

/**
 * Open any external link the way a plain click would: in the plugin that handles
 * it, else in the default browser. For surfaces that open links themselves (the
 * notes editor, the Board frame, the HTML preview).
 */
export function openExternalLink(href: string): void {
  const found = findLinkHandler(href)
  if (found) openWithHandler(found.handler, found.url, 'click')
  else openInDefaultBrowser(href)
}

/** Drop every handler a plugin left behind (generation.ts, when its owner goes). */
export function removeLinkHandlersOf(pluginId: string): void {
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i]!.pluginId === pluginId) handlers.splice(i, 1)
  }
}

/** Test seam: every registered handler, in match order. */
export function listLinkHandlers(): readonly RegisteredLinkHandler[] {
  return handlers
}
