/**
 * The places of the web app a visit is counted for, in ONE module the browser and the server share
 * (alias `@open-walnut/page-places`): Settings › Page use counts them (core/page-visits.ts), and real
 * use judges a `page:` watch target by them (core/usage-watch/page-uses.ts).
 *
 * 2026-11-25: every `page:` watch read 0 uses (page:home among them, opened 29 times that day), and
 * passed: real use counted only a page's errors as its uses, never the visits Page use already kept.
 * Browser-safe: no imports.
 */

/** `page:org`, `settings:sessions`, `app:walnut-notes~main`, `part:session-panel`. */
export const VISIT_KEY_RE = /^(page|settings|app|part):[A-Za-z0-9._~-]{1,72}$/

/**
 * Parts of a page counted on their own: each one opened is a visit. Each is counted where it opens
 * (`recordVisit('part:<name>')`, web/src); tests/core/usage-watch/page-uses.test.ts holds every one
 * to a counting call and every counting call to this list.
 */
export const PAGE_PARTS: ReadonlyArray<{ key: string; label: string; page: string }> = [
  { key: 'part:session-panel', label: 'Session panel on Home (each session shown in a column)', page: 'page:home' },
  { key: 'part:task-detail', label: 'Task detail (a task opened)', page: 'page:home' },
]

/** Every Settings pane at once (`page:settings`): the panes' visits summed. Settings counts by pane. */
export const ALL_SETTINGS = 'settings:'

/**
 * Names agents gave page targets before only counted places were taken (2026-11-25), each a part of
 * exactly one counted place: the target is that place's use. A name that could be on several (a menu,
 * the sidebar, a notice) is none of them.
 */
export const PAGE_ALIASES: Readonly<Record<string, string>> = {
  'task-panel': 'page:home', 'home-task-panel': 'page:home', 'home-search': 'page:home', 'home-empty-pane': 'page:home',
  session: 'part:session-panel', 'session-chat': 'part:session-panel', 'session-composer': 'part:session-panel',
  composer: 'part:session-panel', 'session-kebab': 'part:session-panel', 'scroll-to-bottom-btn': 'part:session-panel',
  'session-working-indicator': 'part:session-panel', 'session-reading-place': 'part:session-panel', 'session changes tab': 'part:session-panel',
  'org-threads': 'page:org', 'org threads': 'page:org', 'org-chart': 'page:org', 'org-list': 'page:org',
  'org-directors': 'page:org', 'org threads popped card': 'page:org',
  drawing: 'app:walnut-drawing~main',
  settings: ALL_SETTINGS,
}

/**
 * The pages of the app's own routes and apps (web/src/App.tsx, web/src/apps/core-app-list.ts), held to
 * them by tests/core/usage-watch/page-uses.test.ts. A plugin's page is counted by its path the same way.
 */
export const CORE_PAGE_KEYS: readonly string[] = [
  'page:home', 'page:task', 'page:tasks', 'page:notes', 'page:calendar', 'page:mail', 'page:routines',
  'page:passwords', 'page:apps', 'page:org', 'page:agents', 'page:commands', 'page:memory',
  'page:connect-extension', 'page:plugins', 'page:popout',
]

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

function safeKey(key: string): string | null {
  return VISIT_KEY_RE.test(key) ? key : null
}

/**
 * The page key of a route, or null for a route that records itself (Settings records its pane
 * instead) or names no page. `/tasks/<id>` is one page, `/apps/<id>/…` the app.
 */
export function pageKeyForPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 0) return 'page:home'
  const [first, second] = parts
  if (first === 'settings') return null
  if (first === 'apps' && second) return safeKey(`app:${decodeSafe(second)}`)
  if (first === 'tasks' && second) return 'page:task'
  return safeKey(`page:${first}`)
}

/** The visit key of a Settings pane: `settings:sessions`, `settings:mail~rules` for a plugin's `mail:rules`. */
export function settingsVisitKey(paneId: string): string | null {
  return safeKey(`settings:${paneId.replace(/:/g, '~')}`)
}

/**
 * The visit key a `page:` watch target names: `page:home` → page:home, `page:settings:voice` →
 * settings:voice, `page:app:<id>` → app:<id>, `page:session-panel` → part:session-panel. null when it
 * names no countable place in that form.
 */
export function visitKeyOfTarget(target: string): string | null {
  if (!target.startsWith('page:')) return null
  const word = target.slice(5)
  const kind = /^(settings|app|part):/.exec(word)
  if (kind) return safeKey(word)
  if (Object.prototype.hasOwnProperty.call(PAGE_ALIASES, word)) return PAGE_ALIASES[word]!
  // `page:settings-sessions`, `page:settings/voice-accuracy`: one pane.
  const pane = /^settings[-/ ]([a-z0-9-]{1,60})$/.exec(word)
  if (pane) return safeKey(`settings:${pane[1]}`)
  const part = PAGE_PARTS.find((p) => p.key === `part:${word}`)
  return part ? part.key : safeKey(`page:${word}`)
}

/** The page a part shows on (PAGE_PARTS), or null: before the part was counted, its page's visits stood for it. */
export function pageOfPart(key: string): string | null {
  return PAGE_PARTS.find((p) => p.key === key)?.page ?? null
}

/** The watch target that names a visit key (visitKeyOfTarget's inverse). */
export function targetOfVisitKey(key: string): string {
  if (key === ALL_SETTINGS) return 'page:settings'
  if (key.startsWith('page:')) return key
  if (key.startsWith('part:')) return `page:${key.slice(5)}`
  return `page:${key}`
}
