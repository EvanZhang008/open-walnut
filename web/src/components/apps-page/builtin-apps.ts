/**
 * The Apps page's "Built in" section: one card per built-in APP, each with its PARTS.
 *
 * An app can have several parts, and each part answers "is it on my sidebar?" on its own
 * (Evan, 2026-11-21: "one app can have multiple part each part can add to the side bar or
 * not"). Calendar is its page plus the Agenda side bar; Notes is its page plus the
 * Scratchpad side bar (the scratchpad is a note of the vault); Home is its page plus its
 * two panels. A part is either a registry app (Notes, Calendar, ...) or a fixed rail item
 * (the Home panels, the side bars, Org), and both read the same app preferences: off means
 * `unpinned`, which takes it off the rail and nothing else (the route, links and the
 * Command Palette keep working). A key the user hid from the rail's right-click menu
 * (`hidden`) reads off too, and switching it on clears both. A registry app the experiment
 * quiet_rail keeps off the rail by default (Tasks, Routines, Passwords, Calendar) reads off
 * until the user switches it on. The keys are the ones the rail always used, so folding
 * parts into one card changes no stored choice.
 *
 * An app whose data and settings live in a plugin (Calendar, Mail) names it (`plugin`): the
 * page shows the two as ONE card, the plugin's own card leaves the plugin list, and its
 * page holds the parts beside the plugin's switch and settings.
 *
 * Three can never go: Home (every link and every fallback lands there), Apps (the one
 * place a hidden app comes back from) and Settings (everything else). Voice and the bell
 * are system controls, not apps, so they are not listed at all.
 */
import { appOnSidebar, type AppPreferences, type SidebarDefault } from '@/apps/preferences'
import type { RegisteredApp } from '@/apps/registry'
import { railItemKey, type RailItemId } from '@/apps/rail-items'

export type AppPartKind = 'page' | 'side-bar' | 'home-panel'

/** One thing of an app the sidebar can show: its page, a side bar, a Home panel. */
export interface AppPart {
  /** App preferences key: `core:<id>` or `rail:<id>`. */
  key: string
  id: string
  title: string
  kind: AppPartKind
  /** Set for a registry app's page; rail items draw their own glyph. */
  app?: RegisteredApp
  rail?: RailItemId
  /** Why it can never leave the rail; unset = the user may take it off. */
  lock?: string
  shown: boolean
  /** Where Open goes for this part. */
  path: string
  /** What it is, in one line (a page's line is its card's). */
  line?: string
}

/** One card: an app and its parts. */
export interface BuiltinEntry {
  /** The app's key: its page's (`core:<id>`), or its one rail item's (`rail:org`). */
  key: string
  id: string
  title: string
  /** One line under the name. */
  line: string
  /** Tile colour behind the white glyph. */
  tint: string
  /** The app's page (a registry app), when it has one. */
  app?: RegisteredApp
  /** The rail item of an app that is only one (Org). */
  rail?: RailItemId
  /** The plugin that carries this app's data and settings: one card for both. */
  plugin?: string
  /** Its parts, the page first. Never empty. */
  parts: AppPart[]
  /** Set when its page can never leave the rail (Home, Apps, Settings). */
  lock?: string
  /** Some part is on the sidebar. */
  shown: boolean
  /** Its page needs a plugin that is off now (Mail): the card stays, with nothing to open. */
  pluginOff?: boolean
  /** Where the card's Open goes: the page, or the app's one rail item. */
  openPath: string
}

interface Copy { line: string; tint: string; lock?: string; plugin?: string }

const CORE_COPY: Readonly<Record<string, Copy>> = {
  home: { line: 'Tasks, sessions and chat side by side', tint: '#007AFF', lock: 'Every link lands here' },
  notes: { line: 'Your notes vault', tint: '#E8A800' },
  calendar: { line: 'Every calendar on this Mac', tint: '#FF3B30', plugin: 'calendar' },
  mail: { line: 'Inbox, rules and digests', tint: '#0A84FF', plugin: 'mail' },
  tasks: { line: 'Every project as a full table', tint: '#34C759' },
  routines: { line: 'Scheduled jobs and triggers', tint: '#AF52DE' },
  passwords: { line: 'Saved logins and passkeys', tint: '#8E8E93' },
  apps: { line: 'This page', tint: '#FF2D55', lock: 'Brings hidden apps back' },
  settings: { line: 'Engines, hosts, voice and more', tint: '#8E8E93', lock: 'Holds everything else' },
}

/**
 * Every rail item belongs to one app (`owner`, a core app id) or is an app of its own
 * (no owner: Org). A new rail item must say which, or this does not type-check.
 */
const RAIL_PARTS: Readonly<Record<RailItemId, { title: string; kind: AppPartKind; owner?: string; path: string; line?: string; tint?: string }>> = {
  org: { title: 'Org', kind: 'page', path: '/org', line: 'The CEO and the VPs', tint: '#30B0C7' },
  'home-todo': { title: 'Task panel', kind: 'home-panel', owner: 'home', path: '/', line: 'The task list on Home' },
  'home-chat': { title: 'Quick question', kind: 'home-panel', owner: 'home', path: '/', line: 'Ask your Personal AI anything' },
  'home-agenda': { title: 'Agenda', kind: 'side-bar', owner: 'calendar', path: '/', line: "Today's calendar, on Home or beside any page" },
  'home-scratchpad': { title: 'Scratchpad', kind: 'side-bar', owner: 'notes', path: '/', line: 'A quick note pad, on Home or beside any page' },
}

export const RAIL_ITEM_OWNER: Readonly<Record<RailItemId, string | undefined>> = Object.fromEntries(
  Object.entries(RAIL_PARTS).map(([id, part]) => [id, part.owner]),
) as Record<RailItemId, string | undefined>

/** The plugin a core app's data and settings live in, if any. */
export function corePluginOf(app: Pick<RegisteredApp, 'id' | 'requiresPlugin'>): string | undefined {
  return app.requiresPlugin ?? CORE_COPY[app.id]?.plugin
}

export const PART_KIND_LABEL: Readonly<Record<AppPartKind, string>> = {
  page: 'Page',
  'side-bar': 'Side bar',
  'home-panel': 'Home panel',
}

function offRail(preferences: AppPreferences, key: string): boolean {
  return preferences.unpinned.includes(key) || preferences.hidden.includes(key)
}

/**
 * `coreApps` is every registered core app in rail order (the catalog's `all`, which keeps
 * hidden ones), already gated by plugin (Mail only while the mail plugin is on).
 * Cards come in rail order: Org, Home, then the registry apps as the rail draws them.
 */
export function builtinEntries(
  coreApps: readonly RegisteredApp[],
  preferences: AppPreferences,
  opts: {
    phone?: boolean; sidebarDefault?: SidebarDefault; quietRail?: boolean
    /** The plugins running now; absent = all. A core app that needs one not in it reads `pluginOff`. */
    activePlugins?: ReadonlySet<string>
  } = {},
): BuiltinEntry[] {
  const railPart = (id: RailItemId): AppPart => {
    const spec = RAIL_PARTS[id]
    const key = railItemKey(id)
    return { key, id, title: spec.title, kind: spec.kind, rail: id, shown: !offRail(preferences, key), path: spec.path, ...(spec.line ? { line: spec.line } : {}) }
  }
  const pagePart = (app: RegisteredApp, lock?: string): AppPart => ({
    key: app.key, id: app.id, title: app.title, kind: 'page', app, path: app.path,
    ...(lock ? { lock } : {}),
    shown: lock ? true : appOnSidebar(app, preferences, opts.sidebarDefault ?? 'declared', opts.quietRail),
  })
  const railParts = (owner: string): AppPart[] => (Object.keys(RAIL_PARTS) as RailItemId[])
    .filter((id) => RAIL_PARTS[id].owner === owner)
    // A phone mounts neither the agenda nor the scratchpad, so the rail never shows them there.
    .filter((id) => !opts.phone || RAIL_PARTS[id].kind !== 'side-bar')
    .map(railPart)
  const finish = (entry: Omit<BuiltinEntry, 'shown'>): BuiltinEntry => ({ ...entry, shown: entry.parts.some((part) => part.shown) })

  const out: BuiltinEntry[] = []
  const present = new Set(coreApps.map((app) => app.id))
  for (const id of Object.keys(RAIL_PARTS) as RailItemId[]) {
    const spec = RAIL_PARTS[id]
    // An app of its own (Org); a part whose app is not registered here is never lost either.
    if (spec.owner && present.has(spec.owner)) continue
    if (opts.phone && spec.kind === 'side-bar') continue
    out.push(finish({ key: railItemKey(id), id, title: spec.title, line: spec.line ?? '', tint: spec.tint ?? '#8E8E93', rail: id, parts: [railPart(id)], openPath: spec.path }))
  }
  const home = coreApps.find((app) => app.id === 'home')
  const ordered = home ? [home, ...coreApps.filter((app) => app !== home)] : [...coreApps]
  for (const app of ordered) {
    const copy = CORE_COPY[app.id] ?? { line: '', tint: '#8E8E93' }
    const lock = app.lockVisibility ? copy.lock ?? 'Always on the rail' : undefined
    const plugin = corePluginOf(app)
    const pluginOff = !!app.requiresPlugin && !!opts.activePlugins && !opts.activePlugins.has(app.requiresPlugin)
    out.push(finish({
      key: app.key, id: app.id, title: app.title, line: copy.line, tint: copy.tint, app,
      ...(plugin ? { plugin } : {}), ...(lock ? { lock } : {}), ...(pluginOff ? { pluginOff } : {}),
      parts: [pagePart(app, lock), ...railParts(app.id)],
      openPath: app.path,
    }))
  }
  return out
}

/** Every part of every card, the number the section's "N of M on the sidebar" counts. */
export function builtinParts(entries: readonly BuiltinEntry[]): AppPart[] {
  return entries.flatMap((entry) => entry.parts)
}

/** The card's one status line, from its parts. */
export function partsStatus(entry: Pick<BuiltinEntry, 'parts'>): { text: string; tone: 'fixed' | 'on' | 'off' } {
  // Fixed only when nothing on it can change: Home's page is locked, its panels are not.
  if (entry.parts.every((part) => part.lock)) return { text: 'Always on the sidebar', tone: 'fixed' }
  const on = entry.parts.filter((part) => part.shown).length
  if (on === entry.parts.length) return { text: 'On the sidebar', tone: 'on' }
  if (on === 0) return { text: 'Only in Apps', tone: 'off' }
  return { text: `${on} of ${entry.parts.length} on the sidebar`, tone: 'on' }
}

/**
 * Case-insensitive match on the name, its line, its parts' names and lines, and `extra` (the plugin's
 * name, description and plugin parts, for a card that holds a plugin).
 */
export function builtinMatches(entry: Pick<BuiltinEntry, 'title' | 'line' | 'parts'>, query: string, extra: readonly string[] = []): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [entry.title, entry.line, ...entry.parts.flatMap((part) => [part.title, part.line ?? '']), ...extra].some((text) => text.toLowerCase().includes(q))
}

/** What the page knows of the plugin a card holds: its category chip and what a search finds it by. */
export interface HeldPlugin { category: string; text: readonly string[] }

/**
 * The cards the page draws: every entry, less one whose page needs a plugin that is off and
 * that no installed plugin row holds (nothing could turn it on from its card).
 */
export function builtinsShown(entries: readonly BuiltinEntry[], held: ReadonlyMap<string, HeldPlugin>): BuiltinEntry[] {
  return entries.filter((entry) => !entry.pluginOff || held.has(entry.key))
}

/** The cards a search and a category chip leave: one answer for the grid, the count and "Nothing matches". */
export function builtinsMatching(
  entries: readonly BuiltinEntry[],
  held: ReadonlyMap<string, HeldPlugin>,
  query: string,
  category?: string,
): BuiltinEntry[] {
  return entries
    .filter((entry) => !category || held.get(entry.key)?.category === category)
    .filter((entry) => builtinMatches(entry, query, held.get(entry.key)?.text ?? []))
}
