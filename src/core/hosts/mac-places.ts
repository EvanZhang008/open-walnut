/**
 * The places macOS guards (TCC): reading or writing in them shows a permission dialog on that
 * Mac's screen. A leaf module (only node:path), so a caller's own process (an op run in a session's
 * CLI or MCP) can ask without loading the host-exec stack. host_copy uses it via host-copy-paths.ts.
 */
import path from 'node:path'

/**
 * Under a home directory: touching what is in them shows a permission dialog on that Mac's
 * screen. The same list as host_exec's (PROTECTED_IN_HOME in src/providers/host-exec-guards.ts,
 * not exported; tests/core/hosts/host-copy.test.ts fails when the two differ).
 */
export const MAC_PROTECTED_IN_HOME = [
  'Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music',
  'Library/Mail', 'Library/Messages', 'Library/Safari', 'Library/Containers', 'Library/Group Containers',
  'Library/Calendars', 'Library/Application Support/AddressBook', 'Library/Mobile Documents', 'Library/CloudStorage',
]

/** What host_copy knows of a Mac: its home when Walnut has seen it (null: only `~/...` and /Users/<name>/... are read). */
export interface MacSide { home: string | null }

const inside = (rel: string, root: string) => rel === root || rel.startsWith(`${root}/`)

/**
 * The guarded place `p` is in on a Mac (e.g. "~/Downloads", "/Volumes"), or null. `foldCase` compares
 * as macOS's own disk does (~/desktop is ~/Desktop), for a caller about to touch `p` itself.
 */
export function macPlace(p: string, mac: MacSide, opts: { foldCase?: boolean } = {}): string | null {
  const fold = (x: string) => (opts.foldCase ? x.toLowerCase() : x)
  const norm = fold(path.posix.normalize(p).replace(/\/+$/, '') || '/')
  const home = mac.home ? fold(mac.home) : null
  if (norm === fold('/Volumes') || norm.startsWith(fold('/Volumes/'))) return '/Volumes'
  if (norm.split('/').some((s) => s.endsWith('.photoslibrary'))) return 'a Photos library'
  // The part under a home: ~/..., the Mac's own home, or any /Users/<name>/... (another person's home too).
  let rel: string | null = null
  if (norm === '~' || norm.startsWith('~/')) rel = norm.slice(2)
  else if (home && inside(norm, home)) rel = norm.slice(home.length + 1)
  else {
    const m = (opts.foldCase ? /^\/users\/[^/]+(?:\/(.*))?$/ : /^\/Users\/[^/]+(?:\/(.*))?$/).exec(norm)
    if (m) rel = m[1] ?? ''
  }
  if (rel === null) return null
  const root = MAC_PROTECTED_IN_HOME.find((r) => inside(rel!, fold(r)))
  return root ? `~/${root}` : null
}
