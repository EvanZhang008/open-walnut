/**
 * The open link: one URL that opens a place in Walnut's console, for a launcher (Alfred,
 * Raycast, Spotlight) or any app that can open a URL.
 *
 *   open-walnut://open?to=/tasks/<id>
 *
 * Clicked on a Mac with the app, the app comes forward and hands the link to its page
 * (desktop/AppLink.swift), which goes there the way a notification's link does
 * (web/src/utils/open-session.ts navigateToTarget): a task opens on Home with its session.
 * Only a path inside the console is accepted, never another origin.
 *
 * Pure (no fs, no node imports): the web console imports it too.
 */

const OPEN_LINK_ACTION = 'open'
const MAX_TARGET = 500

/**
 * The only query a target may carry: a session's (`/sessions?id=…`, its inbox tab and letter).
 * Any other query is a switch on the page itself (`?walnut-test-run=` turns the window into a
 * test window), which a link from outside must never set.
 */
const SESSION_QUERY_KEYS = new Set(['id', 'tab', 'letter'])

/** A path inside the console: one leading slash, no scheme, no backslash, nothing odd. */
function cleanTarget(value: string | null): string | null {
  const to = value?.trim()
  if (!to || to.length > MAX_TARGET) return null
  if (!to.startsWith('/') || to.startsWith('//')) return null
  if (/[\\\s<>"'`#]/.test(to) || /^\/[a-z][a-z0-9+.-]*:/i.test(to)) return null
  const cut = to.indexOf('?')
  if (cut < 0) return to
  if (to.slice(0, cut) !== '/sessions') return null
  const params = new URLSearchParams(to.slice(cut + 1))
  for (const key of params.keys()) if (!SESSION_QUERY_KEYS.has(key)) return null
  return params.get('id') ? to : null
}

/** Where an open link goes, or null for anything else (another action, an outside target). */
export function parseOpenTargetLink(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed.toLowerCase().startsWith('open-walnut:')) return null
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { return null }
  const action = (parsed.host || parsed.pathname.replace(/^\/+/, '')).toLowerCase()
  if (action !== OPEN_LINK_ACTION) return null
  return cleanTarget(parsed.searchParams.get('to'))
}

export function buildOpenTargetLink(to: string): string {
  return `open-walnut://${OPEN_LINK_ACTION}?to=${encodeURIComponent(to)}`
}
