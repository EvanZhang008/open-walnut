/**
 * The plugin install link: one URL that names a plugin source, for a README, a
 * chat message or a wiki page.
 *
 *   open-walnut://install-plugin?url=<git url>[&ref=<branch or tag>]
 *   open-walnut://install-plugin?spec=<npm package spec>
 *
 * Clicked anywhere on a Mac with the app, it opens the app on Settings > Plugin
 * Store with the source filled in (desktop/AppLink.swift); pasted into the store,
 * into Ask Walnut, or given to `walnut plugin add`, the server reads it like a
 * share snippet. Either way it only NAMES the source: the user still turns on
 * the trust switch and presses Add, because a plugin is full-trust code.
 *
 * Inside the console the link travels as a fragment (`#open-link=<link>`),
 * which is how the app hands it to a page that is already open without
 * reloading it.
 *
 * Pure (no fs, no node imports): the web console imports it too.
 */

export const INSTALL_LINK_SCHEME = 'open-walnut:'
const INSTALL_LINK_ACTION = 'install-plugin'

export type InstallLinkTarget =
  | { kind: 'git'; url: string; ref?: string }
  | { kind: 'npm'; spec: string }

const MAX_FIELD = 2_000

function clean(value: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length <= MAX_FIELD ? trimmed : undefined
}

function fromParams(params: URLSearchParams): InstallLinkTarget | null {
  const url = clean(params.get('url'))
  const spec = clean(params.get('spec'))
  if (url && !spec) {
    const ref = clean(params.get('ref'))
    return ref ? { kind: 'git', url, ref } : { kind: 'git', url }
  }
  if (spec && !url) return { kind: 'npm', spec }
  return null
}

/**
 * Read an install link. Null for anything else, including another
 * `open-walnut://` action and a link that names both a git URL and a package.
 */
export function parseInstallLink(input: string): InstallLinkTarget | null {
  const trimmed = input.trim()
  if (!trimmed.toLowerCase().startsWith(INSTALL_LINK_SCHEME)) return null
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { return null }
  // `open-walnut://install-plugin?…` parses with the action as the host; a
  // `open-walnut:install-plugin?…` (no slashes) puts it in the path.
  const action = (parsed.host || parsed.pathname.replace(/^\/+/, '')).toLowerCase()
  if (action !== INSTALL_LINK_ACTION) return null
  return fromParams(parsed.searchParams)
}

function query(target: InstallLinkTarget): string {
  const params = new URLSearchParams()
  if (target.kind === 'git') {
    params.set('url', target.url)
    if (target.ref) params.set('ref', target.ref)
  } else {
    params.set('spec', target.spec)
  }
  return params.toString()
}

/** The link the store's "Copy install link" puts on the clipboard. */
export function buildInstallLink(target: InstallLinkTarget): string {
  return `${INSTALL_LINK_SCHEME}//${INSTALL_LINK_ACTION}?${query(target)}`
}

/**
 * The console fragment that carries an `open-walnut://` link into a page
 * (`#open-link=<the link, encoded>`). The Mac app sets it on the page it shows,
 * which reads it on load and on every hash change and takes it out of the
 * address bar (web/src/utils/open-link.ts).
 */
export const OPEN_LINK_FRAGMENT = 'open-link'

export function openLinkFragment(link: string): string {
  return `#${OPEN_LINK_FRAGMENT}=${encodeURIComponent(link)}`
}

/** The link a fragment carries, or null when the hash is not one. */
export function parseOpenLinkFragment(hash: string): string | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  const prefix = `${OPEN_LINK_FRAGMENT}=`
  if (!body.startsWith(prefix)) return null
  try {
    const link = decodeURIComponent(body.slice(prefix.length))
    return link.toLowerCase().startsWith(INSTALL_LINK_SCHEME) ? link : null
  } catch {
    return null
  }
}
